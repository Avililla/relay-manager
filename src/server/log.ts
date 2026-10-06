import fs from "node:fs"

export type LogLevel = "debug" | "info" | "warn" | "error"
type Meta = Record<string, string | number | boolean | null>
/**
 * CONTRACT NOTE (W0): §2.6 declares `error(msg, meta?: Meta & { err?: unknown })`, which TypeScript rejects for
 * `{ err }` (an index signature must cover `err: unknown`), so even the spec's own upgrade router would not compile.
 * The error meta is therefore `Meta`, or any object that carries `err`.
 */
export type ErrorMeta = Meta | ({ err: unknown } & Record<string, unknown>)
export interface Logger {
  debug(msg: string, meta?: Meta): void
  info(msg: string, meta?: Meta): void
  warn(msg: string, meta?: Meta): void
  error(msg: string, meta?: ErrorMeta): void
  child(component: string): Logger
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const SYSLOG: Record<LogLevel, number> = { debug: 7, info: 6, warn: 4, error: 3 }
const LABEL: Record<LogLevel, string> = { debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR" }

/** True only when stderr really is the journald stream named by JOURNAL_STREAM (an inherited variable is not enough). */
export function isUnderJournald(env: Record<string, string | undefined> = process.env): boolean {
  const js = env.JOURNAL_STREAM
  if (!js) return false
  const [dev, ino] = js.split(":")
  try {
    // bigint: a plain fstat on a socket/FIFO leaves S_IFSOCK in Node's shared stat buffer and breaks realpathSync
    const st = fs.fstatSync(2, { bigint: true })
    return String(st.dev) === dev && String(st.ino) === ino
  } catch {
    return false
  }
}

function formatValue(v: string | number | boolean | null): string {
  if (v === null) return "null"
  const s = String(v)
  return /[\s"=]/.test(s) || s === "" ? JSON.stringify(s) : s
}

function errorSummary(err: unknown): { summary: string; stack: string | null } {
  if (err instanceof Error) return { summary: `${err.name}: ${err.message}`, stack: err.stack ?? null }
  if (typeof err === "string") return { summary: err, stack: null }
  try {
    return { summary: JSON.stringify(err), stack: null }
  } catch {
    return { summary: String(err), stack: null }
  }
}

export interface LogSink {
  out(line: string): void
  err(line: string): void
}
const processSink: LogSink = {
  out: (line) => { process.stdout.write(line + "\n") },
  err: (line) => { process.stderr.write(line + "\n") },
}

export function createLogger(opts: { level: LogLevel; journald: boolean; sink?: LogSink; now?: () => Date }): Logger {
  const sink = opts.sink ?? processSink
  const now = opts.now ?? (() => new Date())
  const min = ORDER[opts.level]

  function emit(level: LogLevel, component: string, msg: string, meta?: ErrorMeta): void {
    if (ORDER[level] < min) return
    let extra = ""
    let stack: string | null = null
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        if (k === "err" || v === undefined) continue
        extra += ` ${k}=${formatValue(typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null ? v : errorSummary(v).summary)}`
      }
      if ("err" in meta && meta.err !== undefined) {
        const e = errorSummary(meta.err)
        extra += ` error=${formatValue(e.summary)}`
        stack = e.stack
      }
    }
    const body = `[${component}] ${msg}${extra}`
    const line = opts.journald ? `<${SYSLOG[level]}>${body}` : `${now().toISOString()} ${LABEL[level]} ${body}`
    if (level === "warn" || level === "error") sink.err(line)
    else sink.out(line)
    // Each error stack is logged once, at debug level.
    if (stack && ORDER.debug >= min) {
      const sl = opts.journald ? `<7>[${component}] ${stack}` : `${now().toISOString()} ${LABEL.debug} [${component}] ${stack}`
      sink.out(sl)
    }
  }

  function make(component: string): Logger {
    return {
      debug: (m, meta) => emit("debug", component, m, meta),
      info: (m, meta) => emit("info", component, m, meta),
      warn: (m, meta) => emit("warn", component, m, meta),
      error: (m, meta) => emit("error", component, m, meta),
      child: (c) => make(c),
    }
  }
  return make("process")
}

/** A logger that discards everything (tests, stubs). */
export function createNullLogger(): Logger {
  const l: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l
}
