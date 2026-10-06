// «Descargas» of this tab: the download script's jobs the signed-in user may see (their own; every job
// for administrators), kept by the server and mirrored here from GET /api/files/export and the `files.export` events.
// Each event carries the log lines appended since the previous one (its job has an empty `log`): they are added to
// the log kept here. Outside React, like the other job stores.
import { FILES_API, type ExportInfoDTO, type ExportJobDTO, type ExportStartInput } from "@/lib/contracts/files"

/** Lines kept per job in the browser (the server keeps its own bounded tail). */
export const EXPORT_LOG_MAX_LINES = 2000

const FINISHED = new Set<ExportJobDTO["state"]>(["done", "error", "canceled"])
export const isExportFinished = (j: Pick<ExportJobDTO, "state">) => FINISHED.has(j.state)

export type ExportStartResult = { ok: true; job: ExportJobDTO } | { ok: false; message: string; field: string | null }

export interface ExportStore {
  snapshot(): readonly ExportJobDTO[]
  info(): ExportInfoDTO | null
  subscribe(fn: () => void): () => void
  /** Reads the jobs (with their logs) and the availability from the server (on mount, after a reconnection). */
  sync(): Promise<void>
  /** An SSE event (`lines` appended to the log), or the answer of a start (its job carries its log). */
  apply(job: ExportJobDTO, lines?: readonly string[]): void
  start(input: ExportStartInput): Promise<ExportStartResult>
  cancel(id: string): Promise<string | null>
  /** Hides the finished jobs in this tab (the server keeps its short history). */
  clearFinished(): void
}

/** Appends lines keeping at most `max` (the dropped ones are counted). */
export function appendLog(log: readonly string[], dropped: number, lines: readonly string[], max = EXPORT_LOG_MAX_LINES): { log: string[]; dropped: number } {
  if (!lines.length) return { log: [...log], dropped }
  const all = [...log, ...lines]
  const extra = Math.max(0, all.length - max)
  return { log: extra ? all.slice(extra) : all, dropped: dropped + extra }
}

export function createExportStore(fetcher: typeof fetch = (...a) => fetch(...a)): ExportStore {
  let jobs = new Map<string, ExportJobDTO>()
  let info: ExportInfoDTO | null = null
  const hidden = new Set<string>()
  let snap: readonly ExportJobDTO[] = []
  const listeners = new Set<() => void>()
  const emit = () => {
    snap = [...jobs.values()].filter((j) => !hidden.has(j.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const l of [...listeners]) l()
  }
  const opts: RequestInit = { credentials: "same-origin", cache: "no-store" }

  function apply(job: ExportJobDTO, lines: readonly string[] = []): void {
    const cur = jobs.get(job.id)
    // Events can arrive out of order with the start answer: never go back from a finished state.
    if (cur && isExportFinished(cur) && !isExportFinished(job)) {
      if (lines.length) jobs.set(job.id, { ...cur, ...mergeLog(cur, lines) })
      emit()
      return
    }
    // A job with its own log (GET, start answer) replaces ours; an event (empty log) keeps ours and appends.
    const base = job.log.length || !cur ? { log: job.log, logDropped: job.logDropped } : { log: cur.log, logDropped: cur.logDropped }
    const merged = appendLog(base.log, base.logDropped, lines)
    jobs.set(job.id, { ...job, log: merged.log, logDropped: merged.dropped })
    emit()
  }
  function mergeLog(cur: ExportJobDTO, lines: readonly string[]): Pick<ExportJobDTO, "log" | "logDropped"> {
    const m = appendLog(cur.log, cur.logDropped, lines)
    return { log: m.log, logDropped: m.dropped }
  }

  return {
    snapshot: () => snap,
    info: () => info,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async sync() {
      try {
        const r = await fetcher(FILES_API.exports, opts)
        if (!r.ok) return
        const body = (await r.json()) as { jobs?: ExportJobDTO[]; info?: ExportInfoDTO }
        jobs = new Map((body.jobs ?? []).map((j) => [j.id, j]))
        info = body.info ?? info
        emit()
      } catch {
        // offline: keep what is shown; the next reconnection syncs again
      }
    },
    apply,
    async start(input) {
      try {
        const r = await fetcher(FILES_API.exports, { ...opts, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
        const body = (await r.json().catch(() => ({}))) as { job?: ExportJobDTO; message?: string; field?: string }
        if (!r.ok || !body.job) return { ok: false, message: body.message ?? "No se ha podido empezar la descarga.", field: typeof body.field === "string" ? body.field : null }
        hidden.delete(body.job.id)
        apply(body.job)
        return { ok: true, job: body.job }
      } catch {
        return { ok: false, message: "No se ha podido empezar la descarga: sin conexión con el servidor.", field: null }
      }
    },
    async cancel(id) {
      try {
        const r = await fetcher(`${FILES_API.exports}/${id}`, { ...opts, method: "DELETE" })
        if (r.ok || r.status === 404) return null
        const body = (await r.json().catch(() => ({}))) as { message?: string }
        return body.message ?? "No se ha podido cancelar."
      } catch {
        return "No se ha podido cancelar: sin conexión con el servidor."
      }
    },
    clearFinished() {
      for (const j of jobs.values()) if (isExportFinished(j)) hidden.add(j.id)
      emit()
    },
  }
}

let store: ExportStore | null = null
export function exportStore(): ExportStore {
  store ??= createExportStore()
  return store
}
