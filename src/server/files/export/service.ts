// «Descargas» (Graph A, part of rt.files): runs the download script of the profile (RM_EXPORT_DOWNLOADER, e.g.
// <perfil>/herramientas/<script>.sh; contract: `<script> <app> <version> -o <out.zip> [-x]`) on the server and puts the
// zip into a root of Archivos (RM_EXPORT_ROOT). One job runs at a time per server, the rest wait in a queue. The script
// runs with spawn() and an argument array (never a shell string), WITHOUT the service's capabilities (setpriv drops the
// ambient CAP_NET_ADMIN), in its own work dir <data>/descargas/<id> (a folder only the service can write, never inside
// a shared folder, whose owner could swap it for a link while the script runs), with a minimal environment (PATH,
// HOME = the work dir, the repository credentials and URL from the configuration when set, under the variable names
// the profile chooses), in its own process
// group: cancel, timeout and stop kill the whole group. The finished zip is copied into the destination folder through
// its open descriptor. The log (stdout and stderr) is cleaned, bounded, redacted and streamed on the SSE bus to the
// user who started it and to the admins.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  type ExportInfoDTO, type ExportJobDTO, type ExportStartInput, type ExportState,
} from "@/lib/contracts/files"
import type { JsonValue } from "@/lib/contracts/common"
import { validateNewName } from "@/lib/files/names"
import { DROP_CAPS_ARGS, findSetpriv, hasAmbientCaps } from "@/server/caps"
import type { AppConfig } from "@/server/config/schema"
import type { Logger } from "@/server/log"
import type { AuditService, AuthUser, EventBus } from "@/server/runtime/types"
import type { FilesCore } from "../core"
import { filesError } from "../paths"

export const EXPORT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
const LOG_MAX_LINES = 2000
const LINE_MAX_CHARS = 2000
/** At most this many characters of log per job (the oldest lines go first). */
const LOG_MAX_CHARS = 512 * 1024
/** The service's own work folder for the downloads, inside its data dir (only the service can write there). */
export const EXPORT_WORK_SUBDIR = "descargas"
const REDACTED = "********"

export interface ExportDeps {
  config: Pick<AppConfig, "exports" | "files" | "dataDir">
  log: Logger
  bus: EventBus
  audit: AuditService
  /** The core of the destination root (RM_EXPORT_ROOT; null: that folder is disabled). */
  core: FilesCore | null
  /** Its label in Archivos («tftp», or the second folder's name). */
  rootLabel: string
}

export type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess

export interface ExportInternals {
  spawn?: SpawnFn
  now?: () => number
  /** SIGTERM → SIGKILL of the process group. */
  killGraceMs?: number
  publishMs?: number
  timeoutMs?: number
  maxQueued?: number
  maxQueuedPerUser?: number
  keepFinished?: number
  /** setpriv to drop the service's capabilities for the script; null = none to drop (tests). */
  dropCaps?: () => { setpriv: string | null; needed: boolean }
}

export interface ExportService {
  info(): Promise<ExportInfoDTO>
  /** The caller's jobs (all of them for administrators), with their log. */
  jobs(user: AuthUser): ExportJobDTO[]
  start(user: AuthUser, ip: string | null, input: ExportStartInput): Promise<ExportJobDTO>
  /** Owner or administrator; false when the job does not exist for that user. */
  cancel(user: AuthUser, ip: string | null, id: string): boolean
  stats(): { running: number; queued: number }
  /** Removes the work dirs left by a previous run. */
  begin(): Promise<void>
  stop(): Promise<void>
}

// --- pure helpers (unit-tested) --------------------------------------------------------------------------------

/** "<app>-<version>_exports.zip". */
export function defaultZipName(app: string, version: string): string {
  return `${app}-${version}_exports.zip`
}

/** The zip name to use, or a Spanish reason. ".zip" is appended when missing. */
export function normalizeZipName(raw: string | null, app: string, version: string): { ok: true; name: string } | { ok: false; message: string } {
  let name = (raw ?? "").trim()
  if (!name) name = defaultZipName(app, version)
  if (!/\.zip$/i.test(name)) name = `${name}.zip`
  const why = validateNewName(name)
  if (why) return { ok: false, message: why }
  if (name.startsWith(".") || name.startsWith("-")) return { ok: false, message: "El nombre del zip no puede empezar por «.» ni por «-»." }
  return { ok: true, name }
}

/** The script's arguments (an array: no shell ever parses them). */
export function buildExportArgs(script: string, input: Pick<ExportStartInput, "app" | "version" | "extract">, outPath: string): string[] {
  return [script, input.app, input.version, "-o", outPath, ...(input.extract ? ["-x"] : [])]
}

export type ExportEnvConfig = Pick<AppConfig["exports"], "user" | "password" | "url" | "envUser" | "envPassword" | "envUrl" | "envExtra">

/** The whole environment of the script: nothing of the server's (no RM_*, no secrets) leaks in. */
export function buildExportEnv(cfg: ExportEnvConfig, workDir: string): Record<string, string> {
  const env: Record<string, string> = {
    ...cfg.envExtra,
    PATH: EXPORT_PATH,
    HOME: workDir,
    TMPDIR: workDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "true",
  }
  if (cfg.user) env[cfg.envUser] = cfg.user
  if (cfg.password) env[cfg.envPassword] = cfg.password
  if (cfg.url) env[cfg.envUrl] = cfg.url
  return env
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/** Hides secrets in one log line: the configured password, anything after --password= or -u user: and after
 *  <password variable>= (passwordVar: the name the script gets the password in, A-Z0-9_ only). */
export function redactLine(line: string, secrets: readonly string[], passwordVar: string | null = null): string {
  let out = line
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join(REDACTED)
  out = out.replace(/(--password[= ])\S+/gi, `$1${REDACTED}`)
  out = out.replace(/(-u\s+[^\s:]+:)\S+/g, `$1${REDACTED}`)
  if (passwordVar && /^[A-Z_][A-Z0-9_]*$/.test(passwordVar)) out = out.replace(new RegExp(`(\\b${passwordVar}=)\\S+`, "g"), `$1${REDACTED}`)
  out = out.replace(/(https?:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`)
  return out
}

/**
 * Literal passwords written in the script itself (`<passwordVar>=…`, passwordVar being the variable the script gets
 * the password in): a script that hardcodes its credentials, whose tools may echo them; they are redacted from the
 * log like the configured one.
 */
export function scriptSecrets(scriptText: string, passwordVar: string): string[] {
  const out: string[] = []
  if (!/^[A-Z_][A-Z0-9_]*$/.test(passwordVar)) return out
  const re = new RegExp(`^\\s*(?:export\\s+)?${passwordVar}=(?:"([^"$\`\\\\]*)"|'([^']*)'|([^\\s"'$\`;#]+))`, "gm")
  for (const m of scriptText.matchAll(re)) {
    const v = m[1] ?? m[2] ?? m[3] ?? ""
    if (v.length >= 3) out.push(v)
  }
  return out
}

/** One printable line: no ANSI escapes, no control characters (tab → space), bounded. */
export function cleanLine(raw: string): string {
  const s = raw.replace(ANSI, "").replace(/\t/g, " ").replace(CONTROL, "")
  return s.length > LINE_MAX_CHARS ? `${s.slice(0, LINE_MAX_CHARS)}…` : s
}

/**
 * Splits the script's output into lines. "\r" without "\n" (progress meters) rewrites the current line: only its last
 * state is kept, emitted when a "\n" (or the end) comes.
 */
export class LogSplitter {
  private buf = ""
  private pending: string | null = null
  constructor(private readonly emit: (line: string) => void) {}
  push(chunk: string): void {
    this.buf += chunk
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf)
      if (!m) break
      const seg = this.buf.slice(0, m.index)
      // A lone \r at the very end might be the first half of \r\n: wait for more.
      if (m[0] === "\r" && m.index === this.buf.length - 1) break
      this.buf = this.buf.slice(m.index + m[0].length)
      if (m[0] === "\r") {
        if (seg !== "") this.pending = seg
        continue
      }
      const line = seg === "" && this.pending !== null ? this.pending : seg
      this.pending = null
      this.emit(line)
    }
    if (this.buf.length > 64 * 1024) {
      this.emit(this.buf)
      this.buf = ""
    }
  }
  end(): void {
    const rest = this.buf.replace(/\r$/, "")
    if (rest !== "") this.emit(rest)
    else if (this.pending !== null) this.emit(this.pending)
    this.buf = ""
    this.pending = null
  }
}

function findBash(): string | null {
  for (const p of ["/bin/bash", "/usr/bin/bash"]) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      // next
    }
  }
  return null
}

// --- the service ------------------------------------------------------------------------------------------------

interface Job {
  dto: ExportJobDTO
  user: { id: string; username: string; ip: string | null }
  input: ExportStartInput
  child: ChildProcess | null
  cancelReason: "canceled" | "timeout" | "stopped" | null
  pendingLines: string[]
  logChars: number
  publishTimer: NodeJS.Timeout | null
  done: Promise<void> | null
}

const FINISHED: ReadonlySet<ExportState> = new Set(["done", "error", "canceled"])
const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ""

export function createExportService(deps: ExportDeps, internals: ExportInternals = {}): ExportService {
  const cfg = deps.config.exports
  const log = deps.log.child("exportaciones")
  const spawn: SpawnFn = internals.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts))
  const now = internals.now ?? (() => Date.now())
  const killGraceMs = internals.killGraceMs ?? 5000
  const publishMs = internals.publishMs ?? 300
  const timeoutMs = internals.timeoutMs ?? cfg.timeoutMs
  const maxQueued = internals.maxQueued ?? 10
  const maxQueuedPerUser = internals.maxQueuedPerUser ?? 3
  const keepFinished = internals.keepFinished ?? 20
  const secrets: string[] = [cfg.password ?? ""].filter(Boolean)
  try {
    if (cfg.script) secrets.push(...scriptSecrets(fs.readFileSync(cfg.script, "utf8"), cfg.envPassword))
  } catch {
    // no script (problem() says it)
  }
  const capsDrop = internals.dropCaps ?? (() => ({ setpriv: findSetpriv(), needed: hasAmbientCaps() }))
  const jobs = new Map<string, Job>()
  let stopped = false

  const iso = (t: number) => new Date(t).toISOString()

  function problem(): string | null {
    if (!cfg.enabled) return `${cfg.name} no está activado en este servidor (RM_EXPORT_ENABLED).`
    if (!deps.core) return `La carpeta ${deps.rootLabel} no está disponible en este servidor.`
    if (!cfg.script) return "No hay script de descarga configurado (RM_EXPORT_DOWNLOADER en el perfil o en config.env)."
    try {
      if (!fs.statSync(cfg.script).isFile()) return `El script de descarga no es un fichero: ${cfg.script}`
    } catch {
      return `Falta el script de descarga en el servidor: ${cfg.script}`
    }
    if (!findBash()) return "El servidor no tiene bash."
    return null
  }

  const queued = () => [...jobs.values()].filter((j) => j.dto.state === "queued")
  const running = () => [...jobs.values()].filter((j) => j.dto.state === "running")

  function view(j: Job, withLog: boolean): ExportJobDTO {
    const pos = j.dto.state === "queued" ? queued().indexOf(j) + 1 : null
    return { ...j.dto, queuePosition: pos || null, log: withLog ? [...j.dto.log] : [] }
  }

  function flush(j: Job): void {
    if (j.publishTimer) {
      clearTimeout(j.publishTimer)
      j.publishTimer = null
    }
    const lines = j.pendingLines
    j.pendingLines = []
    deps.bus.publish({ type: "files.export", job: view(j, false), lines }, { kind: "userAndAdmins", userId: j.user.id })
  }
  function addLine(j: Job, raw: string): void {
    const line = redactLine(cleanLine(raw), secrets, cfg.envPassword)
    j.dto.log.push(line)
    j.logChars += line.length
    while (j.dto.log.length > 1 && (j.dto.log.length > LOG_MAX_LINES || j.logChars > LOG_MAX_CHARS)) {
      j.logChars -= (j.dto.log.shift() ?? "").length
      j.dto.logDropped++
    }
    j.pendingLines.push(line)
    if (j.pendingLines.length > LOG_MAX_LINES) j.pendingLines.splice(0, j.pendingLines.length - LOG_MAX_LINES)
    if (!j.publishTimer) j.publishTimer = setTimeout(() => flush(j), publishMs)
  }
  function setState(j: Job, state: ExportState): void {
    j.dto.state = state
    if (state === "running") j.dto.startedAt = iso(now())
    if (FINISHED.has(state)) j.dto.finishedAt = iso(now())
    flush(j)
    // The queue positions of the others changed.
    if (state !== "queued") for (const q of queued()) flush(q)
  }

  function audit(j: Job, phase: "inicio" | "fin"): void {
    const d = j.dto
    const detail: Record<string, JsonValue> = { fase: phase, app: d.app, version: d.version, extract: d.extract, dir: d.dir || "/", zipName: d.zipName }
    let outcome: "ok" | "error" = "ok"
    if (phase === "fin") {
      detail.result = d.state === "done" ? "exportado" : d.state === "canceled" ? "cancelado" : "error"
      detail.exitCode = d.exitCode
      if (d.finalPath) detail.finalPath = d.finalPath
      if (d.sizeBytes !== null) detail.sizeBytes = d.sizeBytes
      if (d.startedAt) detail.durationSec = Math.round((now() - Date.parse(d.startedAt)) / 1000)
      if (d.error) detail.error = d.error
      if (d.state !== "done") outcome = "error"
    }
    deps.audit.record({
      actor: { kind: "user", id: j.user.id, name: j.user.username, ip: j.user.ip }, action: "files.export", outcome,
      target: { type: "file", id: null, name: d.finalPath ?? (d.dir ? `${d.dir}/${d.zipName}` : d.zipName) }, detail,
    })
  }

  function prune(): void {
    const done = [...jobs.values()].filter((j) => FINISHED.has(j.dto.state))
    for (const j of done.slice(0, Math.max(0, done.length - keepFinished))) jobs.delete(j.dto.id)
  }

  function killGroup(j: Job, signal: NodeJS.Signals): void {
    const pid = j.child?.pid
    if (!pid) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        j.child?.kill(signal)
      } catch {
        // gone
      }
    }
  }

  function abort(j: Job, reason: "canceled" | "timeout" | "stopped"): void {
    if (j.cancelReason) return
    j.cancelReason = reason
    killGroup(j, "SIGTERM")
    const t = setTimeout(() => killGroup(j, "SIGKILL"), killGraceMs)
    t.unref()
  }

  /**
   * <data>/descargas (0700, the service's): opened without following links and checked through its descriptor; the
   * removals below go through /proc/self/fd/<n>/<name>.
   */
  async function workBase(): Promise<{ at: string; real: string; close(): Promise<void> }> {
    const dataReal = await fs.promises.realpath(deps.config.dataDir)
    const real = path.join(dataReal, EXPORT_WORK_SUBDIR)
    try {
      await fs.promises.mkdir(real, { mode: 0o700 })
    } catch (e) {
      if (errno(e) !== "EEXIST") throw e
    }
    const h = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try {
      const where = await fs.promises.readlink(`/proc/self/fd/${h.fd}`)
      if (where !== real) throw new Error(`${real} ha cambiado`)
    } catch (e) {
      await h.close().catch(() => undefined)
      throw e
    }
    return { at: `/proc/self/fd/${h.fd}`, real, close: () => h.close().catch(() => undefined) }
  }

  async function run(j: Job): Promise<void> {
    const core = deps.core
    let workDir: string | null = null
    let base: Awaited<ReturnType<typeof workBase>> | null = null
    try {
      if (!core) throw new Error(`La carpeta ${deps.rootLabel} no está disponible.`)
      if (!cfg.script) throw new Error("No hay script de descarga configurado.")
      const bash = findBash()
      if (!bash) throw new Error("El servidor no tiene bash.")
      const caps = capsDrop()
      if (caps.needed && !caps.setpriv) throw new Error("Falta setpriv (util-linux): el script no se ejecuta con las capacidades del servicio.")
      base = await workBase()
      await fs.promises.mkdir(`${base.at}/${j.dto.id}`, { mode: 0o700 })
      workDir = path.join(base.real, j.dto.id)
      const out = path.join(workDir, j.dto.zipName)
      addLine(j, `$ ${path.basename(cfg.script)} ${j.input.app} ${j.input.version} -o ${j.dto.zipName}${j.input.extract ? " -x" : ""}`)
      const argv = buildExportArgs(cfg.script, j.input, out)
      const [cmd, args] = caps.needed && caps.setpriv ? [caps.setpriv, [...DROP_CAPS_ARGS, bash, ...argv]] : [bash, argv]
      const child = spawn(cmd, args, {
        cwd: workDir, env: buildExportEnv(cfg, workDir) as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"],
      })
      j.child = child
      const splitter = new LogSplitter((l) => addLine(j, l))
      child.stdout?.setEncoding("utf8")
      child.stderr?.setEncoding("utf8")
      child.stdout?.on("data", (c: string) => splitter.push(c))
      child.stderr?.on("data", (c: string) => splitter.push(c))
      const timer = setTimeout(() => abort(j, "timeout"), timeoutMs)
      timer.unref()
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>((resolve) => {
        let settled = false
        child.once("error", (e) => { if (!settled) { settled = true; resolve({ code: null, signal: null, error: e }) } })
        child.once("exit", (code, signal) => {
          // Wait a little for the pipes (a background child may still hold them), then go on.
          const t = setTimeout(() => { if (!settled) { settled = true; resolve({ code, signal, error: null }) } }, 2000)
          child.once("close", () => { clearTimeout(t); if (!settled) { settled = true; resolve({ code, signal, error: null }) } })
        })
      })
      clearTimeout(timer)
      splitter.end()
      // Nothing of the group may survive the job (background jf, curl…).
      killGroup(j, "SIGKILL")
      j.dto.exitCode = exit.code
      if (exit.error) throw new Error(`No se pudo ejecutar el script: ${exit.error.message}`)
      if (j.cancelReason === "canceled" || j.cancelReason === "stopped") {
        j.dto.error = j.cancelReason === "stopped" ? "El servidor se ha detenido: descarga cancelada." : "Descarga cancelada."
        setState(j, "canceled")
        return
      }
      if (j.cancelReason === "timeout") throw new Error(`Se ha superado el tiempo máximo de ${Math.round(timeoutMs / 60_000)} min (RM_EXPORT_TIMEOUT_MIN): descarga cancelada.`)
      if (exit.code !== 0) {
        const last = [...j.dto.log].reverse().find((l) => /\[ERROR\]/.test(l))
        throw new Error(last ? `${last.replace(/^.*\[ERROR\]\s*/, "")} (código ${exit.code ?? exit.signal})` : `El script ha terminado con error (código ${exit.code ?? exit.signal}).`)
      }
      // The zip, opened through the work folder's descriptor without following links (a link is never followed).
      const zh = await fs.promises.open(`${base.at}/${j.dto.id}/${j.dto.zipName}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK).catch(() => null)
      if (!zh) throw new Error("El script ha terminado sin crear el zip.")
      let placed: { name: string; path: string; size: number }
      try {
        if (!(await zh.stat()).isFile()) throw new Error("El script ha terminado sin crear el zip.")
        placed = await core.importFile(j.dto.dir, j.dto.zipName, zh, j.user.username)
      } finally {
        await zh.close()
      }
      j.dto.finalName = placed.name
      j.dto.finalPath = placed.path
      j.dto.sizeBytes = placed.size
      addLine(j, `Guardado en ${deps.rootLabel}/${placed.path}`)
      setState(j, "done")
    } catch (e) {
      j.dto.error = e instanceof Error ? e.message : String(e)
      if (j.dto.state === "running" || j.dto.state === "queued") setState(j, "error")
    } finally {
      if (j.publishTimer) flush(j)
      if (base) {
        await fs.promises.rm(`${base.at}/${j.dto.id}`, { recursive: true, force: true }).catch((e: unknown) => log.warn("No se pudo borrar la carpeta de trabajo", { carpeta: workDir, error: errno(e) || String(e) }))
        await base.close()
      }
      j.child = null
      audit(j, "fin")
      log.info(j.dto.state === "done" ? "Descarga terminada" : "Descarga sin terminar", {
        usuario: j.user.username, app: j.dto.app, version: j.dto.version, estado: j.dto.state, ...(j.dto.error ? { causa: j.dto.error } : {}),
      })
    }
  }

  function pump(): void {
    if (stopped || running().length > 0) return
    const next = queued()[0]
    if (!next) return
    setState(next, "running")
    next.done = run(next).catch((e: unknown) => log.error("Error inesperado en una descarga", { err: e })).finally(() => {
      prune()
      pump()
    })
  }

  return {
    async info() {
      const why = problem()
      return {
        available: why === null, problem: why, timeoutMin: Math.round(timeoutMs / 60_000),
        root: cfg.root, rootLabel: deps.rootLabel,
        labels: { name: cfg.name, title: cfg.title, description: cfg.description, app: cfg.appLabel, version: cfg.versionLabel, extract: cfg.extractLabel },
      }
    },

    jobs(user) {
      return [...jobs.values()].filter((j) => user.isAdmin || j.user.id === user.id).map((j) => view(j, true))
    },

    async start(user, ip, requested) {
      // The -x option exists only when the profile names it (RM_EXPORT_EXTRACT_LABEL).
      const input = cfg.extractLabel ? requested : { ...requested, extract: false }
      if (stopped) throw filesError("UNAVAILABLE", "El servidor se está deteniendo.")
      const why = problem()
      if (why) throw filesError(cfg.enabled && deps.core ? "UNAVAILABLE" : "NOT_FOUND", why)
      const zip = normalizeZipName(input.zipName, input.app, input.version)
      if (!zip.ok) throw filesError("INVALID", zip.message, { field: "zipName" })
      const dir = await (deps.core as FilesCore).checkFolder(input.dir)
      const q = queued()
      if (q.length >= maxQueued) throw filesError("BUSY", "Hay demasiadas descargas en cola: espera a que terminen.")
      if (q.filter((j) => j.user.id === user.id).length >= maxQueuedPerUser) throw filesError("BUSY", "Ya tienes descargas en cola: espera a que terminen.")
      const id = crypto.randomBytes(16).toString("hex")
      const j: Job = {
        dto: {
          id, app: input.app, version: input.version, extract: input.extract, dir, zipName: zip.name, finalName: null, finalPath: null,
          sizeBytes: null, state: "queued", queuePosition: null, exitCode: null, error: null, userId: user.id, userName: user.name || user.username,
          createdAt: iso(now()), startedAt: null, finishedAt: null, log: [], logDropped: 0,
        },
        user: { id: user.id, username: user.username, ip }, input: { ...input, dir, zipName: zip.name },
        child: null, cancelReason: null, pendingLines: [], logChars: 0, publishTimer: null, done: null,
      }
      jobs.set(id, j)
      audit(j, "inicio")
      flush(j)
      pump()
      return view(j, true)
    },

    cancel(user, _ip, id) {
      const j = jobs.get(id)
      if (!j || (!user.isAdmin && j.user.id !== user.id)) return false
      if (FINISHED.has(j.dto.state)) return true
      if (j.dto.state === "queued") {
        j.dto.error = "Descarga cancelada."
        setState(j, "canceled")
        audit(j, "fin")
        prune()
        return true
      }
      abort(j, "canceled")
      return true
    },

    stats: () => ({ running: running().length, queued: queued().length }),

    async begin() {
      if (!cfg.enabled || !deps.core) return
      try {
        const base = await workBase()
        try {
          for (const name of await fs.promises.readdir(base.at)) {
            await fs.promises.rm(`${base.at}/${name}`, { recursive: true, force: true }).catch(() => undefined)
          }
        } finally {
          await base.close()
        }
      } catch (e) {
        log.debug("Sin carpeta de trabajo de las descargas", { error: e instanceof Error ? e.message : String(e) })
      }
    },

    async stop() {
      stopped = true
      for (const j of queued()) {
        j.dto.error = "El servidor se ha detenido: descarga cancelada."
        setState(j, "canceled")
        audit(j, "fin")
      }
      const live = running()
      for (const j of live) abort(j, "stopped")
      await Promise.race([Promise.all(live.map((j) => j.done)), new Promise((r) => setTimeout(r, killGraceMs + 3000).unref())])
    },
  }
}
