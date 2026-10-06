// Health checks (§4.14), shared by `relay-manager doctor` (no runtime, read-only) and "Sistema > Salud" (runtime).
import { execFile as nodeExecFile } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type Database from "better-sqlite3"
import type { BackupDTO, HealthCheckDTO, HealthGroup, HealthLevel } from "@/lib/contracts/system"
import { formatBytes, formatDateTime, plural } from "@/lib/i18n/format"
import type { AppConfig } from "@/server/config/schema"
import { MigrationError, migrateDatabase } from "@/server/db/migrate"
import type { Runtime } from "@/server/runtime/types"
import { AUTH_SECRET_FILE } from "@/server/auth/secret"
import { withReadOnlyDb, withReadOnlyDbFile } from "./db-readonly"
import type { DailySkip } from "./backup"
import { probeHealth } from "./health-probe"
import type { HwServerInfoDTO } from "@/lib/contracts/accesses"
import { findHwServer, nodeHwServerFs } from "@/server/accesses/hw-server"
import { scanJtagCables, type JtagCable } from "@/server/accesses/jtag-enumerate"
import type { CopyRootDTO } from "@/lib/contracts/files"
import { createHelperClient } from "@/server/files/copy/helper-client"
import { describeRootStatus } from "@/server/files/copy/root-status"
import { findSetpriv, hasAmbientCaps } from "@/server/caps"
import { readProfileTemplatesFor, templateErrorLines, type ProfileTemplates } from "@/server/profile"

// ---------------------------------------------------------------------------
// External commands: execFile, never a shell, 2 s timeout, minimal env.
// ---------------------------------------------------------------------------
export const EXEC_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" })
export const EXEC_TIMEOUT_MS = 2000

export interface ExecResult { ok: boolean; code: number | null; stdout: string; stderr: string; missing: boolean; timedOut: boolean }
export type ExecFn = (cmd: string, args: readonly string[]) => Promise<ExecResult>
export interface ExecFileOptions { timeout: number; env: Record<string, string>; encoding: "utf8"; maxBuffer: number; windowsHide: boolean; shell: false }
type ExecError = Error & { code?: unknown; killed?: boolean; signal?: unknown }
export type ExecFileImpl = (file: string, args: readonly string[], options: ExecFileOptions,
  callback: (error: ExecError | null, stdout: string, stderr: string) => void) => void

const defaultExecFile: ExecFileImpl = (file, args, options, callback) => {
  // Next's type augmentation makes NODE_ENV required in ProcessEnv; the minimal env deliberately has none.
  const env = options.env as NodeJS.ProcessEnv
  nodeExecFile(file, [...args], { ...options, env }, (err, stdout, stderr) => callback(err, String(stdout), String(stderr)))
}

export function createExec(impl: ExecFileImpl = defaultExecFile): ExecFn {
  return (cmd, args) => new Promise((resolve) => {
    const options: ExecFileOptions = { timeout: EXEC_TIMEOUT_MS, env: { ...EXEC_ENV }, encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true, shell: false }
    try {
      impl(cmd, args, options, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, code: 0, stdout, stderr, missing: false, timedOut: false })
        const missing = err.code === "ENOENT"
        const timedOut = !missing && err.killed === true
        resolve({ ok: false, code: typeof err.code === "number" ? err.code : null, stdout: stdout ?? "", stderr: stderr ?? "", missing, timedOut })
      })
    } catch {
      resolve({ ok: false, code: null, stdout: "", stderr: "", missing: true, timedOut: false })
    }
  })
}

// ---------------------------------------------------------------------------
// Injectable environment
// ---------------------------------------------------------------------------
export interface FileStat { uid: number; gid: number; mode: number; size: number; isDirectory: boolean; isFile: boolean; mtimeMs: number }
export interface HealthFs {
  stat(p: string): FileStat | null
  readdir(p: string): string[] | null
  readText(p: string): string | null
  /** null = allowed, otherwise the errno code ("EACCES", "ENOENT", "EROFS", "EPERM", …). */
  access(p: string, mode: "r" | "w" | "rw"): string | null
  statfs(p: string): { freeBytes: number; totalBytes: number } | null
  dirSize(p: string): number
  canWatch(p: string): boolean
}
export interface HealthProc { uid: number | null; gid: number | null; groups: number[]; username: string; nodeVersion: string; abi: string; execPath: string }
export interface HealthDbInfo {
  quickCheck: string; users: number; setupCompletedAt: string | null; backupDailyEnabled: boolean; captureMaxTotalMb?: number
}
export interface MigrationsInfo { pending: string[]; unknown: string[]; error: string | null; missingDb: boolean }
export interface HealthCtx {
  config: AppConfig
  /** Present in "Sistema > Salud": enables the runtime-only checks. */
  rt: Runtime | null
  /** Doctor: enables service.systemd and service.port. */
  doctor: boolean
  fs: HealthFs
  exec: ExecFn
  now: () => Date
  proc: HealthProc
  net: {
    interfaces(): Record<string, os.NetworkInterfaceInfo[] | undefined>
    portInUse(host: string, port: number): Promise<boolean | null>
    healthOk(): Promise<boolean>
  }
  native(): Promise<{ sqlite: string | null; serial: string | null }>
  /** null = the DB file does not exist. */
  readDb(dbFile: string): HealthDbInfo | { error: string } | null
  migrations(): Promise<MigrationsInfo>
  backups(): Promise<BackupDTO[]> | BackupDTO[]
  dailySkip(): DailySkip | null
  /** hw_server as the access service would find it (RM_HW_SERVER, XILINX_* env, PATH, install folders). */
  hwServer(): HwServerInfoDTO
  /** USB JTAG cables in sysfs (RM_JTAG_SYS_ROOT). */
  jtagCables(): Promise<JtagCable[]>
  /** «Copiar como administrador (sudo)»: the root helper's answer (or why there is none). */
  rootCopy(): Promise<CopyRootDTO>
  /** HEAD of the repository URL of the download script (RM_EXPORT_URL, 3 s): reachable (any HTTP answer) or why not. */
  repository(url: string): Promise<{ reachable: boolean; status: number | null; error: string | null }>
  /** The profile's template files, read and validated now. */
  profileTemplates(): ProfileTemplates
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
type Scope = "all" | "runtime" | "doctor" | "tls"
const CATALOGUE = [
  ["runtime.node", "runtime", "Node.js", "all"],
  ["runtime.native", "runtime", "Módulos nativos", "all"],
  ["runtime.errors", "runtime", "Errores no controlados", "runtime"],
  ["data.dir", "data", "Directorio de datos", "all"],
  ["data.ownership", "data", "Propietario de los datos", "all"],
  ["data.secret", "data", "Secreto de sesión", "all"],
  ["data.db", "data", "Base de datos", "all"],
  ["data.migrations", "data", "Migraciones", "all"],
  ["data.backups", "data", "Copias de seguridad", "all"],
  ["data.capture", "data", "Captura de consolas", "all"],
  ["data.files", "data", "Carpeta de archivos", "all"],
  ["data.copy-root", "data", "Copia como administrador (sudo)", "all"],
  ["data.extra", "data", "Segunda carpeta", "all"],
  ["data.exports", "data", "Descargas", "all"],
  ["config.profile", "data", "Perfil", "all"],
  ["serial.dialout", "serial", "Grupo dialout", "all"],
  ["serial.devices", "serial", "Puertos serie USB", "all"],
  ["serial.ftdi-latency", "serial", "Latencia FTDI", "all"],
  ["serial.watcher", "serial", "Detección de adaptadores", "all"],
  ["serial.modemmanager", "serial", "ModemManager", "all"],
  ["serial.brltty", "serial", "brltty", "all"],
  ["serial.consoles", "serial", "Consolas", "runtime"],
  ["relays.boards", "relays", "Placas de relés", "runtime"],
  ["relays.udp", "relays", "Escucha UDP 30303", "runtime"],
  ["accesses.hw-server", "accesses", "hw_server (JTAG)", "all"],
  ["accesses.cables", "accesses", "Cables JTAG", "all"],
  ["accesses.ports", "accesses", "Puertos de los accesos", "all"],
  ["accesses.status", "accesses", "Accesos de los equipos", "runtime"],
  ["net.interfaces", "network", "Interfaces de red", "all"],
  ["net.route", "network", "Ruta por defecto", "all"],
  ["net.arp", "network", "ARP con redes repetidas", "all"],
  ["net.tls", "network", "Certificado TLS", "tls"],
  ["clock.ntp", "clock", "Sincronización horaria", "all"],
  ["clock.sanity", "clock", "Hora del sistema", "all"],
  ["service.systemd", "service", "Servicio systemd", "doctor"],
  ["service.port", "service", "Puerto HTTP", "doctor"],
] as const satisfies ReadonlyArray<readonly [string, HealthGroup, string, Scope]>
export type HealthCheckId = (typeof CATALOGUE)[number][0]
const META = new Map<string, { group: HealthGroup; label: string; scope: Scope }>(CATALOGUE.map(([id, group, label, scope]) => [id, { group, label, scope }]))

function mk(id: HealthCheckId, level: HealthLevel, message: string, hint: string | null = null): HealthCheckDTO {
  const m = META.get(id)
  return { id, group: m?.group ?? "runtime", level, label: m?.label ?? id, message, hint }
}

export const CONTAINER_MESSAGE = "No comprobable desde el contenedor: revísalo en el anfitrión"
const CHOWN_HINT = "sudo chown -R relay-manager:relay-manager /var/lib/relay-manager"
const UDEV_RULE = "/etc/udev/rules.d/99-relay-manager.rules"
const VIRTUAL_IF = /^(lo|docker|br-|veth|virbr|tailscale|zt|wg|tun|tap)/
const USB_TTY = /^(ttyUSB\d+|ttyACM\d+|ttyXRUSB\d+|ttyCH\d+USB\d+)$/
const H48 = 48 * 3600_000

const firstLine = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ""
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---------------------------------------------------------------------------
// runtime.*
// ---------------------------------------------------------------------------
export async function checkNode(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const major = Number.parseInt(ctx.proc.nodeVersion, 10)
  const msg = `Node ${ctx.proc.nodeVersion} (ABI ${ctx.proc.abi}) en ${ctx.proc.execPath}`
  return major >= 22 ? mk("runtime.node", "ok", msg) : mk("runtime.node", "fail", msg, "Usa el Node 22 incluido en el paquete (node/bin/node)")
}

export async function checkNative(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const r = await ctx.native()
  if (!r.sqlite && !r.serial) return mk("runtime.native", "ok", "better-sqlite3 y serialport cargan correctamente")
  const parts = [r.sqlite ? `better-sqlite3: ${r.sqlite}` : null, r.serial ? `serialport: ${r.serial}` : null].filter(Boolean)
  return mk("runtime.native", "fail", `No se cargan los módulos nativos (${parts.join("; ")})`,
    "El paquete necesita Linux x86_64 con glibc 2.29 o superior; vuelve a extraerlo en un disco ext4")
}

export async function checkErrors(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const n = ctx.rt?.state.uncaughtErrors ?? 0
  return n > 0
    ? mk("runtime.errors", "warn", plural(n, { one: "# error no controlado desde el inicio", other: "# errores no controlados desde el inicio" }),
      ctx.config.mode === "native" ? "Revisa el registro: journalctl -u relay-manager" : "Revisa la salida del servidor")
    : mk("runtime.errors", "ok", "Ningún error no controlado desde el inicio")
}

// ---------------------------------------------------------------------------
// data.*
// ---------------------------------------------------------------------------
export async function checkDataDir(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const dir = ctx.config.dataDir
  const st = ctx.fs.stat(dir)
  if (!st) return mk("data.dir", "info", `${dir} no existe todavía: se creará al iniciar`)
  if (!st.isDirectory) return mk("data.dir", "fail", `${dir} no es un directorio`)
  const denied = ctx.fs.access(dir, "w")
  if (denied) return mk("data.dir", "fail", `No se puede escribir en ${dir} (${denied})`, CHOWN_HINT)
  const sf = ctx.fs.statfs(dir)
  if (!sf) return mk("data.dir", "ok", `${dir} con permiso de escritura`)
  const free = `${dir}: ${formatBytes(sf.freeBytes)} libres`
  if (sf.freeBytes < 200 * 1024 ** 2) return mk("data.dir", "fail", `Casi sin espacio: ${free}`, "Libera espacio o borra capturas y copias antiguas")
  if (sf.freeBytes < 1024 ** 3) return mk("data.dir", "warn", `Poco espacio: ${free}`, "Libera espacio o borra capturas y copias antiguas")
  return mk("data.dir", "ok", free)
}

export async function checkOwnership(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const c = ctx.config
  const top = ctx.fs.stat(c.dataDir)
  if (!top) return mk("data.ownership", "info", "Sin datos todavía")
  // As root (diagnosis without the launcher) the expected owner is the data dir's owner.
  const expected = ctx.proc.uid === 0 || ctx.proc.uid === null ? top.uid : ctx.proc.uid
  const problems: string[] = []
  const dirs = [c.dataDir, path.join(c.dataDir, "backups"), path.join(c.dataDir, "consoles")]
  for (const dir of dirs) {
    for (const name of ctx.fs.readdir(dir) ?? []) {
      const p = path.join(dir, name)
      const st = ctx.fs.stat(p)
      if (!st) continue
      if (st.uid !== expected) problems.push(`${p} (propietario uid ${st.uid})`)
      else {
        const denied = ctx.fs.access(p, "w")
        if (denied) problems.push(`${p} (${denied})`)
      }
    }
  }
  for (const dir of [c.backupDir, c.captureDir]) {
    if (!ctx.fs.stat(dir)) continue
    const denied = ctx.fs.access(dir, "w")
    if (denied) problems.push(`${dir} sin escritura (${denied})`)
  }
  if (problems.length) {
    const shown = problems.slice(0, 5).join(", ") + (problems.length > 5 ? ` y ${problems.length - 5} más` : "")
    return mk("data.ownership", "fail", `Ficheros con otro propietario o sin permiso de escritura: ${shown}`, CHOWN_HINT)
  }
  return mk("data.ownership", "ok", "Todos los ficheros pertenecen al usuario del servicio")
}

export async function checkSecret(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const file = path.join(ctx.config.dataDir, AUTH_SECRET_FILE)
  const text = ctx.fs.readText(file)
  const fromEnv = ctx.config.authSecret !== null && (text === null || text.trim() !== ctx.config.authSecret)
  if (fromEnv) return mk("data.secret", "ok", "Definido en RM_AUTH_SECRET")
  if (text === null) return mk("data.secret", "info", "Aún no existe: se generará al iniciar")
  const mode = (ctx.fs.stat(file)?.mode ?? 0o600) & 0o777
  if (mode !== 0o600) return mk("data.secret", "warn", `${file} tiene permisos ${mode.toString(8)} (deberían ser 600)`, `chmod 600 ${file}`)
  return mk("data.secret", "ok", `${file} (permisos 600)`)
}

export async function checkDb(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const info = ctx.readDb(ctx.config.dbFile)
  if (info === null) return mk("data.db", "info", "Sin base de datos: se creará al iniciar")
  if ("error" in info) return mk("data.db", "fail", `No se puede abrir ${ctx.config.dbFile}: ${info.error}`, CHOWN_HINT)
  if (info.quickCheck !== "ok") {
    return mk("data.db", "fail", `La base de datos está dañada (quick_check: ${info.quickCheck})`, "Restaura la última copia: relay-manager restore <copia>")
  }
  const size = ctx.fs.stat(ctx.config.dbFile)?.size ?? 0
  if (info.users === 0) return mk("data.db", "info", "Sin usuarios: completa la configuración inicial", "relay-manager setup-token muestra el código de configuración")
  return mk("data.db", "ok", `Correcta (${plural(info.users, { one: "# usuario", other: "# usuarios" })}, ${formatBytes(size)})`)
}

export async function checkMigrations(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const m = await ctx.migrations()
  if (m.missingDb) return mk("data.migrations", "info", "Sin base de datos: las migraciones se aplicarán al iniciar")
  if (m.error) return mk("data.migrations", "fail", m.error, "Restaura una copia: relay-manager restore <copia>")
  if (m.unknown.length) {
    return mk("data.migrations", "fail", `Migraciones desconocidas para esta versión: ${m.unknown.join(", ")}`,
      "Se instaló una versión más nueva: sudo relay-manager rollback, o restaura la copia pre-upgrade")
  }
  if (m.pending.length) return mk("data.migrations", "warn", `Migraciones pendientes: ${m.pending.join(", ")} (se aplican al iniciar, con copia previa)`)
  return mk("data.migrations", "ok", "La base de datos está al día")
}

function dbSettings(ctx: HealthCtx): { backupDailyEnabled: boolean; setupCompletedAt: string | null; captureMaxTotalMb: number | null } | null {
  if (ctx.rt) {
    const s = ctx.rt.settings.get()
    return { backupDailyEnabled: s.backupDailyEnabled, setupCompletedAt: s.setupCompletedAt, captureMaxTotalMb: s.captureMaxTotalMb }
  }
  const info = ctx.readDb(ctx.config.dbFile)
  if (!info || "error" in info) return null
  return { backupDailyEnabled: info.backupDailyEnabled, setupCompletedAt: info.setupCompletedAt, captureMaxTotalMb: info.captureMaxTotalMb ?? null }
}

export async function checkBackups(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const s = dbSettings(ctx)
  if (!s) return mk("data.backups", "info", "Sin base de datos todavía")
  if (!s.backupDailyEnabled) return mk("data.backups", "info", "Copias diarias desactivadas", "Actívalas en Sistema > Copias de seguridad")
  const skip = ctx.dailySkip()
  if (skip) {
    return mk("data.backups", "warn", `Copia diaria omitida: poco espacio libre (${formatDateTime(skip.at)})`,
      skip.reason === "capture-paused" ? "La captura está en pausa por falta de disco: libera espacio" : "Libera espacio en el directorio de copias")
  }
  const now = ctx.now().getTime()
  const latest = (await ctx.backups()).filter((b) => b.label === "daily" || /^daily-\d+$/.test(b.label))
    .map((b) => Date.parse(b.createdAt)).filter((t) => Number.isFinite(t)).sort((a, b) => b - a)[0]
  if (latest !== undefined && now - latest <= H48) return mk("data.backups", "ok", `Última copia diaria: ${formatDateTime(new Date(latest))}`)
  const setup = s.setupCompletedAt ? Date.parse(s.setupCompletedAt) : Number.NaN
  if (!Number.isFinite(setup) || now - setup < H48) return mk("data.backups", "info", "Aún no hay copia diaria (primeras 48 h)")
  return mk("data.backups", "warn", latest === undefined ? "No hay ninguna copia diaria" : `La última copia diaria tiene más de 48 h (${formatDateTime(new Date(latest))})`,
    "Comprueba el registro del servidor y el espacio libre; relay-manager backup crea una copia manual")
}

export async function checkCapture(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const cap = dbSettings(ctx)?.captureMaxTotalMb ?? null
  const limit = cap ? ` (límite ${formatBytes(cap * 1024 * 1024)})` : ""
  if (ctx.rt) {
    const c = ctx.rt.serial.stats().capture
    if (c.state === "paused-disk") return mk("data.capture", "warn", "Captura en pausa: poco espacio en disco", "Libera espacio; la captura se reanuda sola")
    if (c.state === "off") return mk("data.capture", "info", "Captura a disco desactivada")
    return mk("data.capture", "ok", `Ocupa ${formatBytes(c.totalBytes)}${limit}`)
  }
  if (!ctx.config.capture.enabled) return mk("data.capture", "info", "Captura a disco desactivada (RM_CAPTURE_ENABLED=0)")
  if (!ctx.fs.stat(ctx.config.captureDir)) return mk("data.capture", "info", "Sin capturas todavía")
  return mk("data.capture", "ok", `Ocupa ${formatBytes(ctx.fs.dirSize(ctx.config.captureDir))}${limit}`)
}

const HOME_LIKE = /^\/(home|root|run\/user)(\/|$)/
const MiB = 1024 * 1024

function filesSpace(dir: string, free: number | null, total: number | null): HealthCheckDTO {
  if (free === null) return mk("data.files", "ok", `${dir} con permiso de escritura`)
  const msg = `${dir}: ${formatBytes(free)} libres${total ? ` de ${formatBytes(total)}` : ""}`
  if (free < 200 * MiB) return mk("data.files", "fail", `Casi sin espacio: ${msg}`, "Borra archivos que ya no hagan falta desde Archivos")
  if (free < 1024 * MiB) return mk("data.files", "warn", `Poco espacio: ${msg}`, "Borra archivos que ya no hagan falta desde Archivos")
  return mk("data.files", "ok", msg)
}

function filesHint(ctx: HealthCtx): string {
  const dir = ctx.config.files.dir
  if (ctx.config.mode === "native") return `sudo /opt/relay-manager/current/install.sh --files-dir ${dir} --yes (crea la carpeta, sus permisos y el acceso del servicio)`
  if (ctx.config.mode === "docker") return "Monta la carpeta del anfitrión en /files con permiso de escritura para el grupo del contenedor (INSTALACION.md)"
  return `mkdir -p ${dir} (o define RM_FILES_DIR)`
}

/** "Archivos": the folder exists, is writable and has room. In native mode doctor runs outside the unit's sandbox. */
export async function checkFiles(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const f = ctx.config.files
  if (!f.enabled) return mk("data.files", "info", "Archivos desactivado (RM_FILES_ENABLED=0)")
  if (ctx.rt) {
    const st = await ctx.rt.files.status()
    if (st.problem) return mk("data.files", "fail", st.problem, filesHint(ctx))
    return filesSpace(f.dir, st.freeBytes, st.totalBytes)
  }
  const denied = ctx.fs.access(f.dir, "rw")
  if (denied === "ENOENT") {
    return ctx.config.mode === "native"
      ? mk("data.files", "warn", `${f.dir} no existe`, filesHint(ctx))
      : mk("data.files", "info", `${f.dir} no existe todavía: se creará al iniciar`)
  }
  if (denied && ctx.config.mode === "native" && HOME_LIKE.test(f.dir)) {
    // The unit reaches this folder through BindPaths= (ProtectHome=tmpfs); outside it the home is not traversable.
    return mk("data.files", "info", `${f.dir} solo es accesible desde el servicio: compruébala en Sistema › Salud`)
  }
  if (denied) return mk("data.files", "fail", `No se puede escribir en ${f.dir} (${denied})`, filesHint(ctx))
  const st = ctx.fs.stat(f.dir)
  if (st && !st.isDirectory) return mk("data.files", "fail", `${f.dir} no es una carpeta`, filesHint(ctx))
  const sf = ctx.fs.statfs(f.dir)
  return filesSpace(f.dir, sf?.freeBytes ?? null, sf?.totalBytes ?? null)
}

function extraSpace(label: string, dir: string, free: number | null, total: number | null): HealthCheckDTO {
  const L = (h: HealthCheckDTO) => ({ ...h, label: `Carpeta ${label}` })
  if (free === null) return L(mk("data.extra", "ok", `${dir} con permiso de escritura`))
  const msg = `${dir}: ${formatBytes(free)} libres${total ? ` de ${formatBytes(total)}` : ""}`
  if (free < 200 * MiB) return L(mk("data.extra", "fail", `Casi sin espacio: ${msg}`, `Borra archivos que ya no hagan falta desde Archivos › ${label}`))
  if (free < 2048 * MiB) return L(mk("data.extra", "warn", `Poco espacio: ${msg}`, `Borra archivos que ya no hagan falta desde Archivos › ${label}`))
  return L(mk("data.extra", "ok", msg))
}

function extraHint(ctx: HealthCtx): string {
  const dir = ctx.config.files.extraDir
  if (ctx.config.mode === "native") return "sudo /opt/relay-manager/current/install.sh --yes (crea la carpeta, sus permisos y el acceso del servicio)"
  if (ctx.config.mode === "docker") return "Monta la carpeta del anfitrión en /extra con permiso de escritura para el grupo del contenedor (INSTALACION.md)"
  return `mkdir -p ${dir} (o define RM_FILES_EXTRA_DIR)`
}

/** The second root of Archivos («extra», RM_FILES_EXTRA_*; named by the profile): like the tftp folder. */
export async function checkExtra(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const f = ctx.config.files
  const L = (h: HealthCheckDTO) => ({ ...h, label: f.extraEnabled ? `Carpeta ${f.extraName}` : h.label })
  if (!f.enabled) return L(mk("data.extra", "info", "Archivos desactivado (RM_FILES_ENABLED=0)"))
  if (!f.extraEnabled) return mk("data.extra", "info", "Sin segunda carpeta (el perfil no define RM_FILES_EXTRA_NAME)")
  if (ctx.rt) {
    const st = await ctx.rt.files.statusOf("extra")
    if (st.problem) return L(mk("data.extra", "fail", st.problem, extraHint(ctx)))
    return extraSpace(f.extraName, f.extraDir, st.freeBytes, st.totalBytes)
  }
  const denied = ctx.fs.access(f.extraDir, "rw")
  if (denied === "ENOENT") {
    return ctx.config.mode === "native"
      ? L(mk("data.extra", "warn", `${f.extraDir} no existe`, extraHint(ctx)))
      : L(mk("data.extra", "info", `${f.extraDir} no existe todavía: se creará al iniciar`))
  }
  if (denied && ctx.config.mode === "native" && HOME_LIKE.test(f.extraDir)) {
    return L(mk("data.extra", "info", `${f.extraDir} solo es accesible desde el servicio: compruébala en Sistema › Salud`))
  }
  if (denied) return L(mk("data.extra", "fail", `No se puede escribir en ${f.extraDir} (${denied})`, extraHint(ctx)))
  const st = ctx.fs.stat(f.extraDir)
  if (st && !st.isDirectory) return L(mk("data.extra", "fail", `${f.extraDir} no es una carpeta`, extraHint(ctx)))
  const sf = ctx.fs.statfs(f.extraDir)
  return extraSpace(f.extraName, f.extraDir, sf?.freeBytes ?? null, sf?.totalBytes ?? null)
}

/**
 * «Descargas» (the profile's download script, titled with RM_EXPORT_NAME): the script exists and can be read, bash and
 * setpriv are there, and the repository answers when RM_EXPORT_URL is set (info only: the lab network may be down).
 * Never a failure: warnings at most.
 */
export async function checkExports(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const c = ctx.config
  const L = (h: HealthCheckDTO) => ({ ...h, label: c.exports.name })
  if (!c.exports.enabled) return L(mk("data.exports", "info", "Desactivado (RM_EXPORT_ENABLED)"))
  const rootOn = c.files.enabled && (c.exports.root === "tftp" || c.files.extraEnabled)
  if (!rootOn) return L(mk("data.exports", "warn", `La carpeta de destino (RM_EXPORT_ROOT=${c.exports.root}) no está disponible`, "Define RM_FILES_EXTRA_NAME en el perfil o usa RM_EXPORT_ROOT=tftp"))
  if (!c.exports.script) return L(mk("data.exports", "warn", "No hay script de descarga configurado", "Define RM_EXPORT_DOWNLOADER en perfil.env (ruta relativa a la carpeta del perfil) o en config.env"))
  const script = ctx.fs.stat(c.exports.script)
  if (!script?.isFile) return L(mk("data.exports", "warn", `Falta el script ${c.exports.script}`, "Instala el perfil con install.sh --perfil <carpeta> o corrige RM_EXPORT_DOWNLOADER"))
  const denied = ctx.fs.access(c.exports.script, "r")
  if (denied) return L(mk("data.exports", "warn", `No se puede leer ${c.exports.script} (${denied})`, "El servicio necesita permiso de lectura (install.sh lo deja root:relay-manager 0750)"))
  if (!ctx.fs.stat("/bin/bash")?.isFile && !ctx.fs.stat("/usr/bin/bash")?.isFile) return L(mk("data.exports", "warn", "El servidor no tiene bash", "sudo apt install bash"))
  if (hasAmbientCaps() && !findSetpriv()) return L(mk("data.exports", "warn", "Falta setpriv (util-linux): el script no se ejecuta con las capacidades del servicio", "sudo apt install util-linux"))
  const url = c.exports.url
  if (!url) return L(mk("data.exports", "ok", `Script listo: ${c.exports.script}`))
  const a = await ctx.repository(url)
  if (!a.reachable) return L(mk("data.exports", "info", `Script listo; ${url} no responde: ${a.error ?? "sin respuesta"}`, "Comprueba la red hasta el repositorio (RM_EXPORT_URL)"))
  return L(mk("data.exports", "ok", `Script listo; ${url} responde (HTTP ${a.status ?? "?"})`))
}

/** The profile («perfil»): where it is, perfil.env and the template files (each error with its file and JSON path). */
export async function checkProfile(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const p = ctx.config.profile
  if (!p.dir) {
    return p.explicit
      ? mk("config.profile", "warn", `No existe la carpeta del perfil ${p.path} (RM_PROFILE_DIR)`, "Corrige RM_PROFILE_DIR o instala el perfil (install.sh --perfil <carpeta>)")
      : mk("config.profile", "info", `Sin perfil (${p.path}): solo valores genéricos y sin plantillas de fichero`, "Para un proyecto, instala su perfil: install.sh --perfil <carpeta> (ejemplo en examples/perfil-ejemplo)")
  }
  const t = ctx.profileTemplates()
  const errors = templateErrorLines(t)
  const what = `${p.dir}: ${t.templates.length} plantilla${t.templates.length === 1 ? "" : "s"}${p.envFile ? ", perfil.env" : ""}`
  if (errors.length) return mk("config.profile", "fail", `${what}; ${errors.length} error${errors.length === 1 ? "" : "es"}:\n${errors.slice(0, 20).join("\n")}`, "Corrige los ficheros y ejecuta relay-manager plantillas recargar (o «Recargar plantillas» en Plantillas)")
  if (p.warnings.length) return mk("config.profile", "warn", `${what}; ${p.warnings.join("; ")}`, "Mueve esas variables a config.env")
  return mk("config.profile", "ok", what)
}

/** «Copiar como administrador (sudo)»: the root helper answers and its sudo account can authenticate. */
export async function checkCopyRoot(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const c = ctx.config
  if (!c.copy.enabled) return mk("data.copy-root", "info", "Copiar a una carpeta del servidor desactivado (RM_COPY_ENABLED=0)")
  const r = ctx.rt ? await ctx.rt.files.copyRootStatus() : await ctx.rootCopy()
  if (r.available) {
    return mk("data.copy-root", "ok", `Ayudante listo: contraseña de ${r.user ?? "?"} (sudo); escribe en ${r.writePaths.join(", ")}`)
  }
  // Portable, development and Docker have no helper by design: information, not a fault.
  const level: HealthLevel = c.mode === "native" ? "warn" : "info"
  return mk("data.copy-root", level, r.problem ?? "No disponible", r.hint)
}

// ---------------------------------------------------------------------------
// serial.*
// ---------------------------------------------------------------------------
function dialoutHint(ctx: HealthCtx): string {
  switch (ctx.config.mode) {
    case "native": return "sudo usermod -aG dialout relay-manager && sudo systemctl restart relay-manager"
    case "docker": return "Define DIALOUT_GID con el gid de dialout del anfitrión (getent group dialout)"
    default: return `sudo usermod -aG dialout ${ctx.proc.username} y vuelve a iniciar sesión`
  }
}

export async function checkDialout(ctx: HealthCtx): Promise<HealthCheckDTO> {
  if (ctx.proc.uid === 0) return mk("serial.dialout", "ok", "El proceso se ejecuta como root")
  const line = (ctx.fs.readText("/etc/group") ?? "").split("\n").find((l) => l.startsWith("dialout:"))
  const gid = line ? Number.parseInt(line.split(":")[2] ?? "", 10) : Number.NaN
  if (!Number.isFinite(gid)) return mk("serial.dialout", "warn", "El grupo dialout no existe en este sistema", dialoutHint(ctx))
  if (ctx.proc.gid === gid || ctx.proc.groups.includes(gid)) return mk("serial.dialout", "ok", `El proceso pertenece al grupo dialout (gid ${gid})`)
  return mk("serial.dialout", "warn", `El usuario ${ctx.proc.username} no pertenece al grupo dialout: no podrá abrir los puertos serie`, dialoutHint(ctx))
}

export async function checkDevices(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const { sysRoot, devRoot } = ctx.config.serial
  const names = (ctx.fs.readdir(path.join(sysRoot, "class", "tty")) ?? []).filter((n) => USB_TTY.test(n))
    .sort((a, b) => a.localeCompare(b, "es", { numeric: true }))
  if (!names.length) {
    return mk("serial.devices", "info", "No hay adaptadores USB-serie conectados",
      ctx.config.mode === "docker" ? "Conecta los adaptadores; el contenedor necesita /dev:/hostdev:ro" : "Conecta los adaptadores; revisa dmesg y lsusb")
  }
  const bad: string[] = []
  const hints = new Set<string>()
  for (const n of names) {
    const code = ctx.fs.access(path.join(devRoot, n), "rw")
    if (!code) continue
    const major = firstLine(ctx.fs.readText(path.join(sysRoot, "class", "tty", n, "dev")) ?? "").split(":")[0]
    if (code === "EACCES") {
      bad.push(`${n} (sin permiso)`)
      hints.add(dialoutHint(ctx))
    } else if (code === "EPERM") {
      bad.push(`${n} (operación no permitida)`)
      hints.add(ctx.config.mode === "docker" ? `Docker: añade "c ${major || "<major>"}:* rw" a device_cgroup_rules` : "El sistema bloquea el acceso al dispositivo")
    } else if (code === "ENOENT") {
      bad.push(`${n} (no existe en ${devRoot})`)
      if (ctx.config.mode === "docker") hints.add("Monta /dev del anfitrión en /hostdev (volumes: /dev:/hostdev:ro)")
    } else {
      bad.push(`${n} (${code})`)
    }
  }
  const count = plural(names.length, { one: "# puerto USB-serie", other: "# puertos USB-serie" })
  if (!bad.length) return mk("serial.devices", "ok", `${count} accesibles: ${names.join(", ")}`)
  return mk("serial.devices", "warn", `${count}; sin acceso: ${bad.join(", ")}`, [...hints].join(" · ") || null)
}

export async function checkFtdiLatency(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const base = path.join(ctx.config.serial.sysRoot, "bus", "usb-serial", "devices")
  const values: Array<[string, string]> = []
  for (const n of ctx.fs.readdir(base) ?? []) {
    if (!/^ttyUSB\d+$/.test(n)) continue
    const v = ctx.fs.readText(path.join(base, n, "latency_timer"))
    if (v !== null) values.push([n, v.trim()])
  }
  if (!values.length) return mk("serial.ftdi-latency", "info", "Sin adaptadores FTDI conectados")
  const slow = values.filter(([, v]) => v !== "1")
  if (!slow.length) return mk("serial.ftdi-latency", "ok", `latency_timer = 1 ms en ${values.map(([n]) => n).join(", ")}`)
  return mk("serial.ftdi-latency", "warn", `latency_timer distinto de 1 ms en: ${slow.map(([n, v]) => `${n} (${v} ms)`).join(", ")}`,
    ctx.config.mode === "docker" ? "Instala la regla udev 99-relay-manager.rules en el anfitrión" : "Instala la regla udev (install.sh) y ejecuta: sudo udevadm trigger --action=change --subsystem-match=usb-serial")
}

export async function checkWatcher(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const poll = `sondeo cada ${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(ctx.config.serial.scanIntervalMs / 1000)} s`
  const inotify = ctx.rt ? ctx.rt.serial.stats().inotify : ctx.fs.canWatch(ctx.config.serial.devRoot)
  return inotify
    ? mk("serial.watcher", "ok", `Inmediata con inotify, más ${poll}`)
    : mk("serial.watcher", "info", `Sin inotify en ${ctx.config.serial.devRoot}: solo ${poll}`)
}

export async function checkModemManager(ctx: HealthCtx): Promise<HealthCheckDTO> {
  if (ctx.config.mode === "docker") return mk("serial.modemmanager", "info", CONTAINER_MESSAGE)
  const r = await ctx.exec("systemctl", ["is-active", "ModemManager"])
  if (r.missing || r.timedOut) return mk("serial.modemmanager", "info", "No se puede consultar systemd (systemctl no disponible)")
  if (!firstLine(r.stdout)) return mk("serial.modemmanager", "info", `No se puede consultar systemd: ${firstLine(r.stderr) || "sin respuesta"}`)
  if (firstLine(r.stdout) !== "active") return mk("serial.modemmanager", "ok", "ModemManager no está activo")
  if (ctx.fs.stat(UDEV_RULE)) return mk("serial.modemmanager", "ok", "ModemManager activo; la regla udev de Relay Manager lo aparta de los puertos")
  return mk("serial.modemmanager", "warn", "ModemManager está activo y envía comandos AT a los ttyACM: detiene el autoarranque de U-Boot",
    "Instala la regla udev (install.sh) o: sudo systemctl disable --now ModemManager")
}

export async function checkBrltty(ctx: HealthCtx): Promise<HealthCheckDTO> {
  if (ctx.config.mode === "docker") return mk("serial.brltty", "info", CONTAINER_MESSAGE)
  if (ctx.fs.stat("/usr/bin/brltty")) {
    return mk("serial.brltty", "warn", "brltty está instalado: en Ubuntu se apropia de los adaptadores CH340/CH341",
      "sudo apt remove brltty (sin conexión: sudo systemctl mask brltty-udev.service)")
  }
  return mk("serial.brltty", "ok", "brltty no está instalado")
}

export async function checkConsoles(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const s = ctx.rt?.serial.stats()
  if (!s) return mk("serial.consoles", "info", "Sin datos")
  const open = plural(s.openConsoles, { one: "# consola abierta", other: "# consolas abiertas" })
  if (s.problemConsoles > 0) {
    return mk("serial.consoles", "warn", `${open}; ${plural(s.problemConsoles, { one: "# con problemas", other: "# con problemas" })}`, "Revisa el estado de cada consola en el Banco")
  }
  return mk("serial.consoles", "ok", open)
}

// ---------------------------------------------------------------------------
// relays.*
// ---------------------------------------------------------------------------
export async function checkBoards(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const rt = ctx.rt
  if (!rt) return mk("relays.boards", "info", "Sin datos")
  const boards = await rt.prisma.relayBoard.findMany({ where: { enabled: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
  if (!boards.length) return mk("relays.boards", "info", "Sin placas de relés")
  const offline = boards.filter((b) => rt.relays.controller.boardRuntime(b.id)?.online !== true)
  const count = plural(boards.length, { one: "# placa activa", other: "# placas activas" })
  if (offline.length) return mk("relays.boards", "warn", `${count}; sin conexión: ${offline.map((b) => b.name).join(", ")}`, "Comprueba la alimentación, el cable de red y la IP de cada placa")
  return mk("relays.boards", "ok", `${count}, todas en línea`)
}

export async function checkUdp(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const rt = ctx.rt
  if (!rt) return mk("relays.udp", "info", "Sin datos")
  if (!ctx.config.relays.passiveDiscovery) return mk("relays.udp", "info", "Escucha pasiva desactivada (RM_RELAY_PASSIVE_DISCOVERY=0)")
  if (!rt.relays.discovery.listening()) return mk("relays.udp", "warn", `La escucha UDP ${ctx.config.relays.discoveryPort} no está activa`, "Otro programa puede estar usando el puerto; revisa el registro")
  if (rt.relays.discovery.trafficExceeded()) return mk("relays.udp", "warn", `Tráfico UDP ${ctx.config.relays.discoveryPort} excesivo: se descartan anuncios`)
  return mk("relays.udp", "ok", `Escuchando anuncios en UDP ${ctx.config.relays.discoveryPort}`)
}

// ---------------------------------------------------------------------------
// accesses.*
// ---------------------------------------------------------------------------
export async function checkHwServer(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const hw = ctx.rt ? ctx.rt.accesses.hwServer() : ctx.hwServer()
  if (!hw.path) return mk("accesses.hw-server", "warn", hw.problem ?? "No se encuentra hw_server", "Sin hw_server los accesos JTAG no se abren; las consolas y Ethernet funcionan igual")
  const how = hw.source === "config" ? "RM_HW_SERVER" : hw.source === "env" ? "variables de Xilinx" : hw.source === "path" ? "PATH" : "carpeta de instalación"
  const filter = ctx.config.accesses.hwServerFilter
  return mk("accesses.hw-server", "ok", `${hw.path}${hw.version ? ` (versión ${hw.version})` : ""}, por ${how}; filtro de cable «${filter}»`,
    `Para comprobar el filtro: reserva el equipo y, desde un PC, xsdb -eval "connect -host <servidor> -port <puerto>; jtag targets" debe listar solo el cable del acceso. Si no aparece ninguno, prueba RM_HW_SERVER_FILTER_FORMAT={vendor}/{serial}`)
}

export async function checkJtagCables(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const cables = ctx.rt ? ctx.rt.accesses.jtag().cables.map((c) => ({ serial: c.serial, label: c.labelName, location: c.location, busnum: 0, devnum: 0 }))
    : (await ctx.jtagCables()).map((c) => ({ serial: c.serial, label: null as string | null, location: c.location, busnum: c.busnum, devnum: c.devnum }))
  if (!cables.length) return mk("accesses.cables", "info", "No hay cables JTAG conectados")
  const names = cables.map((c) => (c.label ? `${c.label} (${c.serial ?? "sin serie"})` : c.serial ?? `sin serie en ${c.location}`)).join(", ")
  const noSerial = cables.filter((c) => !c.serial).length
  const msg = `${plural(cables.length, { one: "# cable JTAG", other: "# cables JTAG" })}: ${names}`
  if (noSerial) return mk("accesses.cables", "warn", msg, "Un cable sin número de serie no se puede asignar a un acceso")
  // hw_server opens the cable through /dev/bus/usb: the service user needs read and write access (udev rule).
  const denied = ctx.rt ? [] : cables.filter((c) => c.busnum && ctx.fs.access(`/dev/bus/usb/${String(c.busnum).padStart(3, "0")}/${String(c.devnum).padStart(3, "0")}`, "rw") === "EACCES")
  if (denied.length) {
    return mk("accesses.cables", "warn", `${msg}; sin permiso de escritura en /dev/bus/usb para ${denied.map((c) => c.serial ?? c.location).join(", ")}`,
      `Instala la regla udev (${UDEV_RULE}) y reconecta los cables`)
  }
  return mk("accesses.cables", "ok", msg)
}

export async function checkAccessPorts(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const { range, bind } = ctx.config.accesses
  const span = `${range.from}-${range.to}`
  const overlapsHttp = ctx.config.port >= range.from && ctx.config.port <= range.to
  if (ctx.rt) {
    const s = ctx.rt.accesses.stats()
    const free = range.to - range.from + 1 - s.total - (overlapsHttp ? 1 : 0)
    return mk("accesses.ports", free > 0 ? "ok" : "warn", `Rango ${span} en ${bind}: ${plural(s.total, { one: "# puerto asignado", other: "# puertos asignados" })}, ${plural(Math.max(0, free), { one: "# libre", other: "# libres" })}`,
      free > 0 ? null : "Amplía RM_ACCESS_PORTS o borra accesos que no uses")
  }
  const busy: number[] = []
  for (let p = range.from; p <= range.to; p++) {
    if (p === ctx.config.port) continue
    if (await ctx.net.portInUse(bind, p)) busy.push(p)
  }
  if (!busy.length) return mk("accesses.ports", "ok", `Rango ${span} libre en ${bind}`)
  const running = await ctx.net.healthOk()
  return mk("accesses.ports", running ? "info" : "warn",
    `${plural(busy.length, { one: "# puerto en uso", other: "# puertos en uso" })} del rango ${span}: ${busy.join(", ")}`,
    running ? "Relay Manager está en marcha: son sus accesos abiertos" : `Otro programa los usa: sudo ss -ltnp 'sport >= :${range.from} and sport <= :${range.to}'`)
}

export async function checkAccessStatus(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const rt = ctx.rt
  if (!rt) return mk("accesses.status", "info", "Sin datos")
  const s = rt.accesses.stats()
  if (!s.total) return mk("accesses.status", "info", "Ningún equipo tiene accesos")
  const open = `${plural(s.listening, { one: "# acceso abierto", other: "# accesos abiertos" })} de ${s.total}; ${plural(s.connections, { one: "# conexión", other: "# conexiones" })}`
  if (s.problems) return mk("accesses.status", "warn", `${open}; ${plural(s.problems, { one: "# con problemas", other: "# con problemas" })}`, "Revisa Sistema > Accesos")
  return mk("accesses.status", "ok", open)
}

// ---------------------------------------------------------------------------
// network.*
// ---------------------------------------------------------------------------
function lanAddresses(ctx: HealthCtx): Array<{ name: string; address: string; cidr: string; broadcast: string }> {
  const out: Array<{ name: string; address: string; cidr: string; broadcast: string }> = []
  for (const [name, list] of Object.entries(ctx.net.interfaces())) {
    if (VIRTUAL_IF.test(name)) continue
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue
      const ip = a.address.split(".").map(Number)
      const mask = a.netmask.split(".").map(Number)
      const broadcast = ip.map((o, i) => (o | (~(mask[i] ?? 0) & 255)) >>> 0).join(".")
      out.push({ name, address: a.address, cidr: a.cidr ?? `${a.address}/${a.netmask}`, broadcast })
    }
  }
  return out
}

export async function checkInterfaces(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const list = lanAddresses(ctx)
  if (!list.length) return mk("net.interfaces", "warn", "Sin interfaz IPv4 de red local: solo se puede abrir desde este equipo y no se descubrirán placas")
  const scheme = ctx.config.tls ? "https" : "http"
  return mk("net.interfaces", "ok", list.map((a) => `${a.name} ${a.cidr} (difusión ${a.broadcast}): ${scheme}://${a.address}:${ctx.config.port}`).join("; "))
}

export async function checkRoute(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const text = ctx.fs.readText("/proc/net/route")
  const def = (text ?? "").split("\n").slice(1).map((l) => l.trim().split(/\s+/)).find((f) => f[1] === "00000000" && f[7] === "00000000")
  if (def) return mk("net.route", "ok", `Ruta por defecto por ${def[0]}`)
  return mk("net.route", "info", "Sin ruta por defecto: el descubrimiento UDP solo llega a subredes directamente conectadas")
}

/**
 * "Red de equipos" next to another interface on the same network (the equipment's 192.168.1.0/24 on another NIC of
 * the server): it works (policy routing by source), but with Linux's default arp_ignore=0 the server answers ARP for
 * the VLAN addresses (rmv*) on that other interface too. install.sh --red-equipos-arp-estricto sets arp_ignore=1 and
 * arp_announce=2 (/etc/sysctl.d/60-relay-manager.conf).
 */
export async function checkArp(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const toNum = (ip: string) => ip.split(".").reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0)
  const nets: Array<{ name: string; address: string; net: number; mask: number }> = []
  for (const [name, list] of Object.entries(ctx.net.interfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue
      const mask = toNum(a.netmask)
      nets.push({ name, address: a.address, net: (toNum(a.address) & mask) >>> 0, mask })
    }
  }
  const vlans = nets.filter((n) => /^rmv\d+$/.test(n.name))
  if (!vlans.length) return mk("net.arp", "ok", "Sin interfaces de la red de equipos (rmv*) en este servidor")
  const shared = [...new Set(nets.filter((n) => !/^rmv\d+$/.test(n.name) && !VIRTUAL_IF.test(n.name))
    .filter((n) => vlans.some((v) => ((v.net & n.mask) >>> 0) === ((n.net & v.mask) >>> 0))).map((n) => n.name))]
  if (!shared.length) return mk("net.arp", "ok", "Ninguna otra interfaz está en la red de los equipos")
  const val = (k: string) => Number(firstLine(ctx.fs.readText(`/proc/sys/net/ipv4/conf/${k}`) ?? "0")) || 0
  const weak = shared.filter((i) => Math.max(val("all/arp_ignore"), val(`${i}/arp_ignore`)) < 1 || Math.max(val("all/arp_announce"), val(`${i}/arp_announce`)) < 2)
  if (!weak.length) return mk("net.arp", "ok", `${shared.join(", ")} también está en la red de los equipos; arp_ignore=1 y arp_announce=2: este servidor no contesta por ahí a las direcciones de las VLAN`)
  return mk("net.arp", "warn",
    `${weak.join(", ")} también está en la red de los equipos: con arp_ignore=0 este servidor puede contestar por ahí a las direcciones de las VLAN (rmv*) si otro aparato de esa red las pregunta. Los accesos funcionan igual.`,
    "Reinstala con «sudo ./install.sh --red-equipos-arp-estricto» (pone net.ipv4.conf.all.arp_ignore=1 y arp_announce=2 en /etc/sysctl.d/60-relay-manager.conf)")
}

/**
 * Node's `X509Certificate.subjectAltName` ("DNS:a, IP Address:10.0.0.12, …"; values with special characters are
 * JSON-quoted) → exact DNS names (lower case) and IP addresses. Other entry types are ignored.
 */
export function parseSubjectAltName(san: string): { dns: string[]; ips: string[] } {
  const dns: string[] = []
  const ips: string[] = []
  for (const m of san.matchAll(/\s*([A-Za-z][A-Za-z ]*):("(?:[^"\\]|\\.)*"|[^,]*)\s*(?:,|$)/g)) {
    let value = (m[2] ?? "").trim()
    if (value.startsWith("\"")) {
      try { value = String(JSON.parse(value)) } catch { continue }
    }
    if (m[1] === "DNS") dns.push(value.toLowerCase())
    else if (m[1] === "IP Address") ips.push(value.toLowerCase())
  }
  return { dns, ips }
}

export async function checkTls(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const tls = ctx.config.tls
  if (!tls) return mk("net.tls", "info", "TLS desactivado")
  const cert = ctx.fs.readText(tls.certFile)
  if (cert === null) return mk("net.tls", "fail", `No se puede leer el certificado ${tls.certFile}`, "Comprueba RM_TLS_CERT y sus permisos")
  if (ctx.fs.readText(tls.keyFile) === null) return mk("net.tls", "fail", `No se puede leer la clave ${tls.keyFile}`, "La clave debe ser legible por el grupo relay-manager (0640)")
  let x: crypto.X509Certificate
  try {
    x = new crypto.X509Certificate(cert)
  } catch (err) {
    return mk("net.tls", "fail", `El certificado no es válido: ${errText(err)}`)
  }
  const validTo = new Date(x.validTo)
  if (validTo.getTime() < ctx.now().getTime()) return mk("net.tls", "fail", `El certificado caducó el ${formatDateTime(validTo)}`, "sudo ./install.sh --tls-selfsigned genera uno nuevo")
  const { ips } = parseSubjectAltName(x.subjectAltName ?? "")
  const missing = lanAddresses(ctx).map((a) => a.address).filter((ip) => !ips.includes(ip))
  if (missing.length) return mk("net.tls", "warn", `El certificado no incluye estas direcciones: ${missing.join(", ")}`, "Regenera el certificado: sudo ./install.sh --tls-selfsigned")
  return mk("net.tls", "ok", `Certificado válido hasta ${formatDateTime(validTo)}`)
}

// ---------------------------------------------------------------------------
// clock.*
// ---------------------------------------------------------------------------
export async function checkNtp(ctx: HealthCtx): Promise<HealthCheckDTO> {
  if (ctx.config.mode === "docker") return mk("clock.ntp", "info", CONTAINER_MESSAGE)
  const servers = await ctx.exec("timedatectl", ["show-timesync", "-p", "SystemNTPServers", "-p", "FallbackNTPServers", "--value"])
  const synced = await ctx.exec("timedatectl", ["show", "-p", "NTPSynchronized", "--value"])
  if (synced.missing) return mk("clock.ntp", "info", "Sin fuente NTP configurada: ver OPERACION.md (chrony)")
  const hasServer = servers.ok && servers.stdout.split(/\s+/).some((s) => s.trim().length > 0)
  const isSynced = firstLine(synced.stdout) === "yes"
  if (isSynced) return mk("clock.ntp", "ok", "Reloj sincronizado por NTP")
  if (hasServer) return mk("clock.ntp", "warn", "Hay un servidor NTP configurado pero el reloj no está sincronizado", "Configura chrony contra la fuente de hora del laboratorio (OPERACION.md)")
  return mk("clock.ntp", "info", "Sin fuente NTP configurada: ver OPERACION.md (chrony)")
}

export async function checkClockSanity(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const built = ctx.config.build.builtAt ? new Date(ctx.config.build.builtAt) : null
  if (!built || Number.isNaN(built.getTime())) return mk("clock.sanity", "info", "Sin fecha de compilación (versión de desarrollo)")
  const now = ctx.now()
  if (now.getTime() < built.getTime()) {
    return mk("clock.sanity", "fail", `La hora del sistema (${now.toISOString()}) es anterior a la compilación (${built.toISOString()})`,
      "Ajusta la hora (sudo date -s …) y revisa la pila del reloj (RTC)")
  }
  return mk("clock.sanity", "ok", `Hora del sistema coherente (${now.toISOString()})`)
}

// ---------------------------------------------------------------------------
// service.* (doctor only)
// ---------------------------------------------------------------------------
export async function checkSystemd(ctx: HealthCtx): Promise<HealthCheckDTO> {
  if (ctx.config.mode === "docker") return mk("service.systemd", "info", CONTAINER_MESSAGE)
  const r = await ctx.exec("systemctl", ["is-active", "relay-manager"])
  if (r.missing || r.timedOut) return mk("service.systemd", "info", "systemctl no disponible")
  const state = firstLine(r.stdout)
  if (!state) return mk("service.systemd", "info", `No se puede consultar systemd: ${firstLine(r.stderr) || "sin respuesta"}`)
  if (state === "active") return mk("service.systemd", "ok", "Servicio relay-manager activo")
  if (state === "failed") return mk("service.systemd", "fail", "El servicio relay-manager ha fallado", "journalctl -u relay-manager -n 50")
  if (ctx.config.mode !== "native") return mk("service.systemd", "info", `No se ejecuta como servicio (modo ${ctx.config.mode === "dev" ? "desarrollo" : "portátil"})`)
  if (state === "activating" || state === "reloading" || state === "deactivating") return mk("service.systemd", "info", `Servicio relay-manager: ${state}`)
  if (state === "inactive") return mk("service.systemd", "warn", "El servicio relay-manager está detenido", "sudo systemctl start relay-manager")
  return mk("service.systemd", "info", `Estado de systemd: ${state || "desconocido"}`)
}

export async function checkPort(ctx: HealthCtx): Promise<HealthCheckDTO> {
  const { host, port } = ctx.config
  const inUse = await ctx.net.portInUse(host, port)
  if (inUse === null) return mk("service.port", "info", `No se puede comprobar el puerto ${port}`)
  if (!inUse) return mk("service.port", "info", `Puerto ${port} libre: el servidor no está en marcha`)
  if (await ctx.net.healthOk()) return mk("service.port", "ok", `Puerto ${port} atendido por Relay Manager`)
  return mk("service.port", "fail", `El puerto ${port} está en uso por otro programa`, `sudo ss -ltnp 'sport = :${port}'`)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const RUNNERS: Record<HealthCheckId, (ctx: HealthCtx) => Promise<HealthCheckDTO>> = {
  "runtime.node": checkNode,
  "runtime.native": checkNative,
  "runtime.errors": checkErrors,
  "data.dir": checkDataDir,
  "data.ownership": checkOwnership,
  "data.secret": checkSecret,
  "data.db": checkDb,
  "data.migrations": checkMigrations,
  "data.backups": checkBackups,
  "data.capture": checkCapture,
  "data.files": checkFiles,
  "data.copy-root": checkCopyRoot,
  "data.extra": checkExtra,
  "data.exports": checkExports,
  "config.profile": checkProfile,
  "serial.dialout": checkDialout,
  "serial.devices": checkDevices,
  "serial.ftdi-latency": checkFtdiLatency,
  "serial.watcher": checkWatcher,
  "serial.modemmanager": checkModemManager,
  "serial.brltty": checkBrltty,
  "serial.consoles": checkConsoles,
  "relays.boards": checkBoards,
  "relays.udp": checkUdp,
  "accesses.hw-server": checkHwServer,
  "accesses.cables": checkJtagCables,
  "accesses.ports": checkAccessPorts,
  "accesses.status": checkAccessStatus,
  "net.interfaces": checkInterfaces,
  "net.route": checkRoute,
  "net.arp": checkArp,
  "net.tls": checkTls,
  "clock.ntp": checkNtp,
  "clock.sanity": checkClockSanity,
  "service.systemd": checkSystemd,
  "service.port": checkPort,
}

export async function runHealthChecks(ctx: HealthCtx, opts: { runtimeChecks?: boolean; only?: readonly string[] } = {}): Promise<HealthCheckDTO[]> {
  const runtime = ctx.rt !== null && opts.runtimeChecks !== false
  const only = opts.only ? new Set(opts.only) : null
  const selected = CATALOGUE.filter(([id, , , scope]) => {
    if (only && !only.has(id)) return false
    if (scope === "runtime") return runtime
    if (scope === "doctor") return ctx.doctor
    if (scope === "tls") return ctx.config.tls !== null
    return true
  })
  const out = await Promise.all(selected.map(async ([id]) => {
    try {
      return await RUNNERS[id](ctx)
    } catch (err) {
      return mk(id, "fail", `Error al comprobar: ${errText(err)}`)
    }
  }))
  // "Red de equipos": adapter, server VLANs, CAP_NET_ADMIN, NetworkManager, switch (drift) and port links, from the
  // running service (runtime only; the checks depend on its state).
  if (runtime && ctx.rt && (!only || [...only].some((id) => id.startsWith("equipnet.")))) {
    try {
      out.push(...ctx.rt.equipnet.health().filter((h) => !only || only.has(h.id)))
    } catch (err) {
      out.push({ id: "equipnet.adapter", group: "network", level: "fail", label: "Red de equipos", message: `Error al comprobar: ${errText(err)}`, hint: null })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Real (node) context
// ---------------------------------------------------------------------------
export function nodeHealthFs(): HealthFs {
  const toStat = (s: fs.Stats): FileStat => ({ uid: s.uid, gid: s.gid, mode: s.mode, size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile(), mtimeMs: s.mtimeMs })
  const dirSize = (p: string): number => {
    let total = 0
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return 0 }
    for (const e of entries) {
      const full = path.join(p, e.name)
      if (e.isDirectory()) total += dirSize(full)
      else if (e.isFile()) { try { total += fs.statSync(full).size } catch { /* vanished */ } }
    }
    return total
  }
  return {
    stat(p) { try { return toStat(fs.statSync(p)) } catch { return null } },
    readdir(p) { try { return fs.readdirSync(p) } catch { return null } },
    readText(p) { try { return fs.readFileSync(p, "utf8") } catch { return null } },
    access(p, mode) {
      const flags = mode === "r" ? fs.constants.R_OK : mode === "w" ? fs.constants.W_OK : fs.constants.R_OK | fs.constants.W_OK
      try {
        fs.accessSync(p, flags)
        return null
      } catch (err) {
        return (err as NodeJS.ErrnoException).code ?? "ERROR"
      }
    },
    statfs(p) {
      try {
        const s = fs.statfsSync(p)
        return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }
      } catch { return null }
    },
    dirSize,
    canWatch(p) {
      try {
        const w = fs.watch(p)
        w.close()
        return true
      } catch { return false }
    },
  }
}

function readDbInfo(dbFile: string): HealthDbInfo | { error: string } | null {
  if (!fs.existsSync(dbFile)) return null
  try {
    // Never leaves -wal/-shm next to a stopped DB (db-readonly.ts).
    return withReadOnlyDb(dbFile, (db) => readDbInfoFrom(db))
  } catch (err) {
    return { error: errText(err) }
  }
}

function readDbInfoFrom(db: Database.Database): HealthDbInfo | { error: string } {
  try {
    const quickCheck = String(db.pragma("quick_check", { simple: true }))
    let users = 0
    let setupCompletedAt: string | null = null
    let backupDailyEnabled = true
    let captureMaxTotalMb: number | undefined
    try { users = Number((db.prepare(`SELECT count(*) AS n FROM "User"`).get() as { n: number }).n) } catch { users = 0 }
    try {
      const s = db.prepare(`SELECT "setupCompletedAt" AS s, "backupDailyEnabled" AS b, "captureMaxTotalMb" AS c FROM "Settings" WHERE "id" = 'global'`)
        .get() as { s: string | null; b: number; c: number } | undefined
      if (s) {
        setupCompletedAt = s.s ? new Date(s.s).toISOString() : null
        backupDailyEnabled = Number(s.b) === 1
        captureMaxTotalMb = Number(s.c)
      }
    } catch { /* no settings table yet */ }
    return { quickCheck, users, setupCompletedAt, backupDailyEnabled, captureMaxTotalMb }
  } catch (err) {
    return { error: errText(err) }
  }
}

function portInUse(host: string, port: number): Promise<boolean | null> {
  if (!port) return Promise.resolve(null)
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRINUSE" ? true : null))
    s.once("listening", () => s.close(() => resolve(false)))
    s.listen({ port, host, exclusive: true })
  })
}

export interface NodeHealthOptions {
  config: AppConfig
  doctor: boolean
  rt?: Runtime | null
  exec?: ExecFn
  portInUse?: (host: string, port: number) => Promise<boolean | null>
  backups?: () => Promise<BackupDTO[]> | BackupDTO[]
  dailySkip?: () => DailySkip | null
  now?: () => Date
}

export function nodeHealthContext(o: NodeHealthOptions): HealthCtx {
  const cfg = o.config
  let user = "desconocido"
  try { user = os.userInfo().username } catch { /* no passwd entry (containers) */ }
  return {
    config: cfg,
    rt: o.rt ?? null,
    doctor: o.doctor,
    fs: nodeHealthFs(),
    exec: o.exec ?? createExec(),
    now: o.now ?? (() => new Date()),
    proc: {
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      gid: typeof process.getgid === "function" ? process.getgid() : null,
      groups: typeof process.getgroups === "function" ? process.getgroups() : [],
      username: user,
      nodeVersion: process.versions.node,
      abi: process.versions.modules,
      execPath: process.execPath,
    },
    net: {
      interfaces: () => os.networkInterfaces(),
      portInUse: o.portInUse ?? portInUse,
      healthOk: async () => (await probeHealth(cfg, { timeoutMs: 2000 })).ok,
    },
    async native() {
      let sqlite: string | null = null
      let serial: string | null = null
      try {
        const mod = await import("better-sqlite3")
        new mod.default(":memory:").close()
      } catch (err) { sqlite = errText(err) }
      try {
        await import("serialport")
      } catch (err) { serial = errText(err) }
      return { sqlite, serial }
    },
    readDb: readDbInfo,
    async migrations() {
      if (!fs.existsSync(cfg.dbFile)) return { pending: [], unknown: [], error: null, missingDb: true }
      try {
        // The runner's dry run opens the file read-only itself: give it a copy on a stopped DB (db-readonly.ts).
        const r = await withReadOnlyDbFile(cfg.dbFile, (dbFile) => migrateDatabase({
          dbFile, migrationsDir: path.join(cfg.appDir, "prisma", "migrations"), backupDir: null,
          dryRun: true, appVersion: cfg.build.version, log: () => {},
        }))
        return { pending: r.pending, unknown: r.unknown, error: null, missingDb: false }
      } catch (err) {
        return { pending: [], unknown: [], error: err instanceof MigrationError ? err.message : errText(err), missingDb: false }
      }
    },
    backups: o.backups ?? (() => []),
    dailySkip: o.dailySkip ?? (() => null),
    hwServer: () => findHwServer({ explicit: cfg.accesses.hwServer, env: process.env, home: os.homedir() || null, fs: nodeHwServerFs() }),
    jtagCables: () => scanJtagCables(cfg.accesses.jtagSysRoot),
    async rootCopy() {
      const sock = cfg.copy.enabled && cfg.mode !== "docker" ? cfg.copy.helperSocket : null
      if (!sock) return describeRootStatus(cfg, null)
      const ping = await createHelperClient(sock, { connectMs: 3000 }).ping(15_000).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
      return describeRootStatus(cfg, ping)
    },
    repository: (url) => headUrl(url, 3000),
    profileTemplates: () => readProfileTemplatesFor(cfg),
  }
}

/** HEAD <url> with a timeout: any HTTP status means reachable. */
export async function headUrl(url: string, timeoutMs: number): Promise<{ reachable: boolean; status: number | null; error: string | null }> {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })
    return { reachable: true, status: r.status, error: null }
  } catch (e) {
    const cause = (e as { cause?: { code?: string } } | null)?.cause?.code
    const name = (e as { name?: string } | null)?.name
    return { reachable: false, status: null, error: name === "TimeoutError" ? `sin respuesta en ${Math.round(timeoutMs / 1000)} s` : cause ?? errText(e) }
  }
}
