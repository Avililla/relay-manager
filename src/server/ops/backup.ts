// Backups (§4.14): online WAL-safe copies with better-sqlite3's backup API, sidecars, retention and the daily scheduler.
import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { z } from "zod"
import { BackupNameSchema, type BackupDTO } from "@/lib/contracts/system"
import { backupTimestamp } from "@/server/db/migrate"
import { DomainError } from "@/server/errors"
import type { ActorRef, AuditInput, BackupService } from "@/server/runtime/types"

const FIXED_LABELS = ["manual", "daily", "pre-migrate", "pre-restore", "import", "portable"] as const
const PRE_UPGRADE_RE = /^pre-upgrade-[0-9A-Za-z.+-]+-to-[0-9A-Za-z.+-]+$/
const NAME_RE = /^relay-manager-(\d{8}T\d{6}Z)-([0-9A-Za-z.+-]+)\.db$/
/** Groups pruned automatically, and how many of each are kept (daily: Settings.backupRetentionCount). */
const KEEP_PER_GROUP = { "pre-migrate": 5, "pre-upgrade": 5, "pre-restore": 5 } as const
export type BackupGroup = "daily" | keyof typeof KEEP_PER_GROUP

export const BACKUP_FILE_MODE = 0o640

export function isValidBackupLabel(label: string): boolean {
  return (FIXED_LABELS as readonly string[]).includes(label) || (PRE_UPGRADE_RE.test(label) && label.length <= 100)
}

/** "20260923T101500Z" → ISO string, or null. */
export function timestampToIso(ts: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(ts)
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Parses a backup file name (never a path). The label keeps a "-2" collision suffix; see backupGroup(). */
export function parseBackupName(name: string): { name: string; label: string; createdAt: string } | null {
  if (!BackupNameSchema.safeParse(name).success) return null
  const m = NAME_RE.exec(name)
  const createdAt = m ? timestampToIso(m[1]) : null
  if (!m || !createdAt) return null
  return { name, label: m[2], createdAt }
}

/** Retention group of a label; null = never pruned automatically (manual, import, portable). */
export function backupGroup(label: string): BackupGroup | null {
  if (label.startsWith("pre-upgrade-")) return "pre-upgrade"
  const base = label.replace(/-\d+$/, "")
  if (base === "daily" || base === "pre-migrate" || base === "pre-restore") return base
  return null
}

const SidecarSchema = z.object({
  createdAt: z.string(),
  label: z.string(),
  appVersion: z.string().nullable().optional(),
  migrations: z.array(z.string()).optional(),
  sizeBytes: z.number().optional(),
})
type Sidecar = z.infer<typeof SidecarSchema>

function readSidecar(file: string): Sidecar | null {
  try {
    const parsed = SidecarSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const sidecarPath = (dbPath: string) => dbPath.replace(/\.db$/, ".json")

/** Applied migrations recorded in a DB file (finished, not rolled back). */
function appliedMigrations(db: Database.Database): string[] {
  const has = db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_prisma_migrations'`).get()
  if (!has) return []
  const rows = db.prepare(`SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

export interface BackupStoreDeps {
  dbFile: string
  backupDir: string
  appVersion: string
  audit: (input: AuditInput) => void | Promise<void>
  now?: () => Date
  /** Settings.backupRetentionCount for daily backups (default 14). */
  retention?: () => { daily: number }
}

/** Copies `dbFile` into `dest` online (another connection may be writing) and checks the copy. Returns its applied migrations. */
export async function copyDatabase(dbFile: string, dest: string): Promise<string[]> {
  const src = new Database(dbFile, { fileMustExist: true })
  try {
    src.pragma("busy_timeout = 5000")
    await src.backup(dest)
  } finally {
    src.close()
  }
  const copy = new Database(dest, { fileMustExist: true })
  try {
    // A self-contained file: the copy never needs -wal/-shm siblings.
    copy.pragma("journal_mode = DELETE")
    const check = copy.pragma("integrity_check", { simple: true })
    if (check !== "ok") throw new DomainError("INTERNAL", `La copia no supera la comprobación de integridad (${String(check)})`)
    return appliedMigrations(copy)
  } finally {
    copy.close()
  }
}

export function createBackupStore(deps: BackupStoreDeps): BackupService {
  const now = deps.now ?? (() => new Date())
  let chain: Promise<unknown> = Promise.resolve()
  /** Promise mutex: create/remove/prune never overlap inside one process. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  function resolvePath(name: string): string | null {
    if (!parseBackupName(name)) return null
    const file = path.join(deps.backupDir, name)
    try {
      return fs.statSync(file).isFile() ? file : null
    } catch {
      return null
    }
  }

  function toDTO(name: string): BackupDTO | null {
    const parsed = parseBackupName(name)
    if (!parsed) return null
    const file = path.join(deps.backupDir, name)
    let size: number
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) return null
      size = st.size
    } catch {
      return null
    }
    const side = readSidecar(sidecarPath(file))
    const createdAt = side && !Number.isNaN(Date.parse(side.createdAt)) ? new Date(side.createdAt).toISOString() : parsed.createdAt
    return { name, label: side?.label ?? parsed.label, createdAt, sizeBytes: size, appVersion: side?.appVersion ?? null }
  }

  async function list(): Promise<BackupDTO[]> {
    let names: string[]
    try {
      names = fs.readdirSync(deps.backupDir)
    } catch {
      return []
    }
    return names
      .map(toDTO)
      .filter((b): b is BackupDTO => b !== null)
      .sort((a, b) => (a.createdAt === b.createdAt ? b.name.localeCompare(a.name) : b.createdAt.localeCompare(a.createdAt)))
  }

  async function doCreate(label: string, actor: ActorRef): Promise<BackupDTO> {
    if (!isValidBackupLabel(label)) {
      throw new DomainError("VALIDATION", `Etiqueta de copia no válida: ${label}`, { label: ["Etiqueta no válida"] })
    }
    if (!fs.existsSync(deps.dbFile)) throw new DomainError("NOT_FOUND", `No hay base de datos que copiar en ${deps.dbFile}`)
    fs.mkdirSync(deps.backupDir, { recursive: true, mode: 0o750 })
    const ts = backupTimestamp(now())
    let fileLabel = label
    let name = `relay-manager-${ts}-${fileLabel}.db`
    for (let i = 2; fs.existsSync(path.join(deps.backupDir, name)) || fs.existsSync(path.join(deps.backupDir, sidecarPath(name))); i++) {
      fileLabel = `${label}-${i}`
      name = `relay-manager-${ts}-${fileLabel}.db`
    }
    const file = path.join(deps.backupDir, name)
    const tmp = path.join(deps.backupDir, `.${name}.tmp`)
    let migrations: string[]
    try {
      migrations = await copyDatabase(deps.dbFile, tmp)
      fs.chmodSync(tmp, BACKUP_FILE_MODE)
      fs.renameSync(tmp, file)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      fs.rmSync(`${tmp}-journal`, { force: true })
      if (err instanceof DomainError) throw err
      throw new DomainError("INTERNAL", `No se pudo crear la copia de seguridad: ${err instanceof Error ? err.message : String(err)}`)
    }
    const sizeBytes = fs.statSync(file).size
    const createdAt = now().toISOString()
    const sidecar = { createdAt, label, appVersion: deps.appVersion, migrations, sizeBytes }
    fs.writeFileSync(sidecarPath(file), JSON.stringify(sidecar, null, 2) + "\n", { mode: BACKUP_FILE_MODE })
    fs.chmodSync(sidecarPath(file), BACKUP_FILE_MODE)
    await deps.audit({ actor, action: "backup.create", target: { type: "backup", id: null, name }, detail: { label, sizeBytes } })
    return { name, label, createdAt, sizeBytes, appVersion: deps.appVersion }
  }

  async function doRemove(name: string, actor: ActorRef): Promise<void> {
    const file = resolvePath(name)
    if (!file) throw new DomainError("NOT_FOUND", `No existe la copia ${name}`)
    fs.rmSync(file, { force: true })
    fs.rmSync(sidecarPath(file), { force: true })
    await deps.audit({ actor, action: "backup.delete", target: { type: "backup", id: null, name } })
  }

  async function doPrune(): Promise<number> {
    const keep: Record<BackupGroup, number> = { daily: Math.max(1, deps.retention?.().daily ?? 14), ...KEEP_PER_GROUP }
    const groups = new Map<BackupGroup, BackupDTO[]>()
    for (const b of await list()) {
      const g = backupGroup(b.label)
      if (!g) continue
      const arr = groups.get(g) ?? []
      arr.push(b) // list() is newest first
      groups.set(g, arr)
    }
    let removed = 0
    for (const [g, items] of groups) {
      for (const b of items.slice(keep[g])) {
        const file = path.join(deps.backupDir, b.name)
        fs.rmSync(file, { force: true })
        fs.rmSync(sidecarPath(file), { force: true })
        removed++
      }
    }
    return removed
  }

  return {
    create: (label, actor) => serial(() => doCreate(label, actor)),
    list,
    remove: (name, actor) => serial(() => doRemove(name, actor)),
    resolvePath,
    prune: () => serial(doPrune),
  }
}

// ---------------------------------------------------------------------------
// Daily scheduler
// ---------------------------------------------------------------------------

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

/** Due when enabled, the local hour has reached backupDailyHour and no daily backup exists for today's local date. */
export function dailyBackupDue(opts: { now: Date; backupDailyEnabled: boolean; backupDailyHour: number; backups: BackupDTO[] }): boolean {
  if (!opts.backupDailyEnabled || opts.now.getHours() < opts.backupDailyHour) return false
  const today = localDate(opts.now)
  return !opts.backups.some((b) => backupGroup(b.label) === "daily" && localDate(new Date(b.createdAt)) === today)
}

export const LOW_SPACE_MARGIN_BYTES = 512 * 1024 * 1024
export type DailySkipReason = "capture-paused" | "low-space"
export interface DailySkip { at: Date; reason: DailySkipReason }

export interface DailySchedulerDeps {
  store: BackupService
  settings: () => { backupDailyEnabled: boolean; backupDailyHour: number }
  captureState: () => "on" | "off" | "paused-disk" | null
  freeBytes: () => number | null
  dbBytes: () => number
  now?: () => Date
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }
  intervalMs?: number
  firstRunDelayMs?: number
}
export interface DailyScheduler {
  tick(): Promise<"not-due" | "skipped" | "created" | "failed">
  lastSkip(): DailySkip | null
  start(): void
  stop(): void
}

const SYSTEM: ActorRef = { kind: "system", id: null, name: "sistema" }

export function createDailyBackupScheduler(deps: DailySchedulerDeps): DailyScheduler {
  const now = deps.now ?? (() => new Date())
  let skip: DailySkip | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  let running = false

  const api: DailyScheduler = {
    async tick() {
      if (running) return "not-due"
      running = true
      try {
        const s = deps.settings()
        const at = now()
        if (!dailyBackupDue({ now: at, ...s, backups: await deps.store.list() })) return "not-due"
        const free = deps.freeBytes()
        const reason: DailySkipReason | null = deps.captureState() === "paused-disk"
          ? "capture-paused"
          : free !== null && free < 2 * deps.dbBytes() + LOW_SPACE_MARGIN_BYTES ? "low-space" : null
        if (reason) {
          if (!skip || localDate(skip.at) !== localDate(at)) deps.log.warn(`Copia diaria omitida: poco espacio libre (${reason === "capture-paused" ? "captura en pausa por disco" : "espacio en el directorio de copias"})`)
          skip = { at, reason }
          return "skipped"
        }
        const b = await deps.store.create("daily", SYSTEM)
        skip = null
        const removed = await deps.store.prune()
        deps.log.info(`Copia diaria creada: ${b.name}${removed ? ` (${removed} copia(s) antiguas borradas)` : ""}`)
        return "created"
      } catch (err) {
        deps.log.error(`No se pudo crear la copia diaria: ${err instanceof Error ? err.message : String(err)}`)
        return "failed"
      } finally {
        running = false
      }
    },
    lastSkip: () => skip,
    start() {
      if (interval) return
      const run = () => { void api.tick() }
      first = setTimeout(run, deps.firstRunDelayMs ?? 60_000)
      first.unref?.()
      interval = setInterval(run, deps.intervalMs ?? 600_000)
      interval.unref?.()
    },
    stop() {
      if (first) clearTimeout(first)
      if (interval) clearInterval(interval)
      first = null
      interval = null
    },
  }
  return api
}
