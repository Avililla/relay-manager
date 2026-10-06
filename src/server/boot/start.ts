// `start` (§2.1): config → umask/lock → migrate → Prisma → setup token → services → registry → Next → listen.
import fs from "node:fs"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { applyConfigEnv, ConfigError, loadConfig } from "@/server/config/load"
import type { AppConfig } from "@/server/config/schema"
import { createLogger, isUnderJournald, type Logger } from "@/server/log"
import { createPrismaClient, verifyDbPragmas } from "@/server/db/client"
import { ensureDbInvariants } from "@/server/db/invariants"
import { MigrationError, migrateDatabase } from "@/server/db/migrate"
import { seedDefaults } from "@/server/db/seed"
import { reloadProfileTemplates, syncReportLines } from "@/server/profile"
import { createEventBus } from "@/server/events/bus"
import { createAuditService } from "@/server/audit/service"
import { createSettingsService } from "@/server/settings/service"
import { createLoginThrottle } from "@/server/auth/throttle"
import { createSessionRegistry } from "@/server/auth/sessions"
import { deleteSetupToken, ensureSetupTokenFile, isSetupPending } from "@/server/auth/setup-token"
import { authenticateUpgrade } from "@/server/auth/ws-auth"
import { createReservationService } from "@/server/services/reservations"
import { createSerialServices } from "@/server/serial"
import { createRelayServices } from "@/server/relays"
import { createAccessServices } from "@/server/accesses"
import { createEquipnetServices, type EquipnetInternals } from "@/server/equipnet"
import { createOpsServices } from "@/server/ops"
import { createFilesServices } from "@/server/files"
import { setRuntime, tryGetRuntime } from "@/server/runtime/registry"
import type { Runtime } from "@/server/runtime/types"
import { createAppServer, createRequestListener, ListenError, listenServer } from "@/server/http/listen"
import { attachUpgradeRouter } from "@/server/http/upgrade"
import { acquireInstanceLock, InstanceLockedError } from "./instance-lock"
import { renderBanner, serverUrls } from "./banner"
import { installProcessHandlers } from "./process-handlers"
import { createShutdown } from "./shutdown"

/** A boot failure with the process exit code of §2.11. */
export class BootExit extends Error {
  readonly exitCode: number
  constructor(exitCode: number, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "BootExit"
    this.exitCode = exitCode
  }
}

export function migrationExitCode(err: MigrationError): number {
  return err.code === "UNKNOWN_MIGRATIONS" ? 4 : 3
}

export function loadConfigOrExit(opts: { ensureDirs: boolean; ensureSecret: boolean }): AppConfig {
  try {
    return loadConfig(opts)
  } catch (err) {
    if (err instanceof ConfigError) throw new BootExit(2, err.message, { cause: err })
    throw err
  }
}

export async function runMigrations(cfg: AppConfig, log: Logger, dryRun = false) {
  const mlog = log.child("migrate")
  try {
    return await migrateDatabase({
      dbFile: cfg.dbFile,
      migrationsDir: path.join(cfg.appDir, "prisma", "migrations"),
      backupDir: cfg.backupDir,
      dryRun,
      allowUnknown: cfg.allowUnknownMigrations,
      appVersion: cfg.build.version,
      log: (level, msg) => (level === "warn" ? mlog.warn(msg) : mlog.info(msg)),
    })
  } catch (err) {
    if (err instanceof MigrationError) {
      mlog.error(err.message)
      if (err.code === "FAILED") {
        mlog.error("La base de datos no se ha modificado. Revisa el registro y, si hace falta, restaura una copia con: relay-manager restore <copia>")
      }
      throw new BootExit(migrationExitCode(err), err.message, { cause: err })
    }
    throw err
  }
}

export async function start(): Promise<void> {
  // Every mode, before any file is created (§2.1 step 2).
  process.umask(0o027)

  // 1. Configuration (creates the data dirs and the secret).
  const cfg = loadConfigOrExit({ ensureDirs: true, ensureSecret: true })
  applyConfigEnv(cfg)

  // 2. Root check, logger, instance lock, directories.
  if (cfg.mode === "portable" && typeof process.getuid === "function" && process.getuid() === 0 && !cfg.allowRoot) {
    throw new BootExit(2, "No ejecutes el modo portátil como root: usa un usuario del grupo dialout o instala el servicio")
  }
  const log = createLogger({ level: cfg.logLevel, journald: isUnderJournald() })
  let lock: { release(): void }
  try {
    lock = acquireInstanceLock(cfg.dataDir)
  } catch (err) {
    if (err instanceof InstanceLockedError) throw new BootExit(5, `Otra instancia usa ${cfg.dataDir}`, { cause: err })
    throw err
  }
  for (const d of [cfg.dataDir, cfg.backupDir, cfg.captureDir]) fs.mkdirSync(d, { recursive: true, mode: 0o750 })

  try {
    // 3. Migrations (backup first; refuses unknown migrations).
    await runMigrations(cfg, log)

    // 4. Prisma, invariants, seed.
    const dblog = log.child("db")
    const prisma = createPrismaClient(cfg.dbFile)
    const pragmas = await verifyDbPragmas(prisma)
    if (pragmas.journalMode !== "wal" || !pragmas.foreignKeys) {
      dblog.warn("Ajustes de SQLite inesperados", { journal_mode: pragmas.journalMode, foreign_keys: pragmas.foreignKeys })
    }
    await ensureDbInvariants(prisma)
    await seedDefaults(prisma, { labName: cfg.defaults.labName })
    // Templates of the profile (plantillas/*.json): a bad file is reported and skipped, never fatal.
    const plog = log.child("perfil")
    if (cfg.profile.dir) plog.info(`Perfil: ${cfg.profile.dir}`)
    else plog.info(`Sin perfil (${cfg.profile.path} no existe): solo valores genéricos`)
    try {
      const sync = await reloadProfileTemplates(prisma, cfg)
      for (const line of syncReportLines({ ...sync, errors: [], warnings: [] })) plog.info(`Plantillas: ${line}`)
      for (const w of sync.warnings) plog.warn(w)
      for (const e of sync.errors) plog.error(`Plantilla no válida: ${e}`)
    } catch (err) {
      plog.error("No se pudieron cargar las plantillas del perfil", { err })
    }

    // 5. Setup token while setup is pending.
    const setupPending = await isSetupPending(prisma)
    let setupToken: string | null = null
    if (setupPending) setupToken = ensureSetupTokenFile(cfg.dataDir, cfg.setupTokenOverride)
    else deleteSetupToken(cfg.dataDir)

    // 6. Services.
    const bus = createEventBus({ log: log.child("sse") })
    let settingsRef: { get(): { auditRetentionDays: number } } | null = null
    const audit = createAuditService({ prisma, log, retentionDays: () => settingsRef?.get().auditRetentionDays ?? 365 })
    const settings = await createSettingsService({ prisma, bus, audit })
    settingsRef = settings
    const throttle = createLoginThrottle()
    const sessions = createSessionRegistry({ prisma, bus, log, config: cfg })
    const base = { config: cfg, log, prisma, bus, audit, settings }
    const reservations = createReservationService({ ...base })
    const serial = createSerialServices({ ...base, reservations, sessions, authenticate: authenticateUpgrade })
    const relays = createRelayServices({ ...base, reservations })
    const equipnetHooks: EquipnetInternals = {}
    const equipnet = createEquipnetServices({ ...base }, equipnetHooks)
    const accesses = createAccessServices({ ...base, reservations, serial, equipnet })
    // equipnet labels adapters itself ("Preparar switch"): refresh the accesses label cache and publish the real list
    equipnetHooks.onLabelsChanged = () => accesses.reloadLabels()
    const files = createFilesServices({ ...base, authenticate: authenticateUpgrade, reservations, equipnet })
    const ops = createOpsServices({ ...base, getRuntime: tryGetRuntime })
    const rt: Runtime = {
      config: cfg, log, prisma, bus, audit, settings, throttle, sessions, reservations, serial, relays, accesses, equipnet, files, ops,
      state: { setupPending, startedAt: new Date(), uncaughtErrors: 0 },
    }

    // 7. Registry.
    setRuntime(rt)

    // 8. Next (same process, its own module graph).
    if (!cfg.dev) {
      const rsf = JSON.parse(fs.readFileSync(path.join(cfg.appDir, ".next", "required-server-files.json"), "utf8")) as { config: unknown }
      process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(rsf.config)
      process.chdir(cfg.appDir)
    }
    const server = createAppServer(cfg)
    const { default: next } = await import("next")
    const app = next({ dev: cfg.dev, dir: cfg.appDir, hostname: "localhost", port: cfg.port, httpServer: server })
    const handle = app.getRequestHandler()
    server.on("error", (err) => log.child("http").error("Error del servidor HTTP", { err }))
    await app.prepare()
    installProcessHandlers(rt)

    // 9. Listeners.
    // /api/files/* (Archivos: streamed uploads and downloads) is served here, before Next.
    server.on("request", createRequestListener(cfg, (req, res) => (files.handleRequest(req, res) ? undefined : handle(req, res))))
    attachUpgradeRouter(server, rt)

    // 10. Listen, pid file, banner.
    try {
      await listenServer(server, cfg.host, cfg.port)
    } catch (err) {
      if (err instanceof ListenError) throw new BootExit(2, err.message, { cause: err })
      throw err
    }
    const port = (server.address() as AddressInfo | null)?.port ?? cfg.port
    cfg.port = port
    fs.writeFileSync(cfg.pidFile, `${process.pid}\n`, { mode: 0o640 })
    process.stdout.write(renderBanner({ labName: settings.get().labName, urls: serverUrls(cfg, port), setupToken, version: cfg.build.version, mode: cfg.mode }))
    log.child("http").info("Servidor escuchando", { host: cfg.host, puerto: port, modo: cfg.mode, tls: cfg.tls !== null })
    audit.record({ actor: { kind: "system", id: null, name: "sistema" }, action: "system.start", detail: { version: cfg.build.version, mode: cfg.mode } })

    // 11. Background work.
    audit.start()
    sessions.start()
    await reservations.start()
    await serial.start()
    await relays.start()
    await equipnet.start()
    await accesses.start()
    await files.start()
    await ops.start()
    const cleanup: Array<() => void> = []
    if (rt.state.setupPending) {
      // Notices an admin created from the CLI (another process) within 1 s.
      const timer = setInterval(() => {
        if (!rt.state.setupPending) {
          clearInterval(timer) // completed through /setup
          return
        }
        isSetupPending(prisma)
          .then((pending) => {
            if (pending || !rt.state.setupPending) return
            rt.state.setupPending = false
            deleteSetupToken(cfg.dataDir)
            clearInterval(timer)
            log.child("auth").info("Configuración inicial completada desde otro proceso (CLI)")
          })
          .catch((err: unknown) => log.child("auth").error("Error al comprobar la configuración inicial", { err }))
      }, 1000)
      timer.unref()
      cleanup.push(() => clearInterval(timer))
    }

    // 12. Signals.
    const shutdown = createShutdown({ rt, server, releaseLock: () => lock.release(), cleanup })
    process.on("SIGTERM", () => { void shutdown("SIGTERM") })
    process.on("SIGINT", () => { void shutdown("SIGINT") })
  } catch (err) {
    lock.release()
    throw err
  }
}
