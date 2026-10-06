// Upload queue of "Archivos" (browser). Framework-free: the transport (XHR + fetch in the browser, a fake in tests)
// is injected. Each file: start (name, size, conflict mode) → chunks of adaptive size (a few seconds each, so no
// request comes near the server's 60 s request timeout) → the last chunk commits it. Lost chunks resume from the
// offset the server reports; network errors are retried with a backoff; server errors stop with their message.
import { DEFAULT_FILES_ROOT, type ConflictMode, type FilesRootId } from "@/lib/contracts/files"
import { formatBytes } from "@/lib/i18n/format"
import { validateNewName } from "./names"

const MiB = 1024 * 1024
/** 256 KiB: even ~20 KB/s links finish a request well within the server's 60 s request timeout. */
export const MIN_CHUNK = 256 * 1024
const TARGET_MS = 4000

/** Next chunk size: ~4 s of data at the measured rate, within [256 KiB, max], growing at most 4× per step. */
export function nextChunkSize(current: number, bytes: number, ms: number, max: number): number {
  if (bytes <= 0 || ms <= 0) return current
  const want = (bytes / ms) * TARGET_MS
  return Math.round(Math.max(MIN_CHUNK, Math.min(max, want, current * 4)))
}

export interface SpeedSample { t: number; bytes: number }
/** Bytes per second over the samples (the caller keeps the last few seconds). */
export function speedOf(samples: readonly SpeedSample[]): number {
  if (samples.length < 2) return 0
  const a = samples[0]
  const b = samples[samples.length - 1]
  return b.t > a.t ? Math.round(((b.bytes - a.bytes) / (b.t - a.t)) * 1000) : 0
}

export interface BlobLike { size: number }
export interface FileLike { name: string; size: number; slice(start: number, end: number): BlobLike }
export type TransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; message: string; extra?: Record<string, unknown> }
export interface UploadTransport {
  start(input: { root: FilesRootId; dir: string; name: string; size: number; conflict: ConflictMode }): Promise<TransportResult<{ id: string; chunkMaxBytes: number }>>
  put(id: string, offset: number, blob: BlobLike, onProgress: (loaded: number) => void): {
    promise: Promise<TransportResult<{ received: number; done: boolean; name: string | null }>>
    abort(): void
  }
  cancel(id: string): Promise<void>
}

export type UploadStatus = "queued" | "uploading" | "done" | "error" | "canceled" | "conflict"
export interface UploadItem {
  key: string
  name: string
  /** The root of Archivos the file goes to and its label («tftp», or the second folder's name). */
  root: FilesRootId
  rootLabel: string
  dir: string
  total: number
  sent: number
  status: UploadStatus
  error: string | null
  finalName: string | null
  /** Bytes per second while uploading. */
  speed: number
  conflict: ConflictMode
}
export interface UploadRequest { file: FileLike; root?: FilesRootId; rootLabel?: string; dir: string; conflict: ConflictMode }

interface Job {
  item: UploadItem
  file: FileLike
  id: string | null
  chunkMax: number
  abort: (() => void) | null
  samples: SpeedSample[]
  generation: number
}

export interface UploadEngineOptions {
  concurrency?: number
  initialChunk?: number
  maxBytes?: number
  retryDelaysMs?: readonly number[]
  now?: () => number
  /** Called when a file is committed (the page refreshes its listing). */
  onFinished?: (item: UploadItem) => void
}

export interface UploadEngine {
  add(reqs: UploadRequest[]): void
  cancel(key: string): void
  retry(key: string): void
  resolveConflict(key: string, mode: ConflictMode): void
  clearFinished(): void
  snapshot(): readonly UploadItem[]
  subscribe(fn: () => void): () => void
  /** Queued or uploading. */
  active(): number
}

const RETRYABLE = new Set([0, 408, 429, 500, 502, 503, 504])
const FINISHED: ReadonlySet<UploadStatus> = new Set(["done", "error", "canceled"])

export function createUploadEngine(transport: UploadTransport, opts: UploadEngineOptions = {}): UploadEngine {
  const concurrency = opts.concurrency ?? 2
  const delays = opts.retryDelaysMs ?? [1000, 2000, 4000, 8000, 16000]
  const now = opts.now ?? (() => Date.now())
  const jobs: Job[] = []
  const listeners = new Set<() => void>()
  let snap: readonly UploadItem[] = []
  let seq = 0
  let running = 0

  const emit = () => {
    snap = jobs.map((j) => ({ ...j.item }))
    for (const l of [...listeners]) l()
  }
  const find = (key: string) => jobs.find((j) => j.item.key === key)
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  function finish(job: Job, status: UploadStatus, error: string | null = null): void {
    job.item.status = status
    job.item.error = error
    job.item.speed = 0
    job.abort = null
  }

  async function run(job: Job): Promise<void> {
    const gen = job.generation
    const alive = () => job.generation === gen && job.item.status === "uploading"
    const { item, file } = job
    let attempt = 0
    if (!job.id) {
      for (;;) {
        const r = await transport.start({ root: item.root, dir: item.dir, name: item.name, size: item.total, conflict: item.conflict })
        if (!alive()) {
          if (r.ok) void transport.cancel(r.data.id)
          return
        }
        if (r.ok) {
          job.id = r.data.id
          job.chunkMax = r.data.chunkMaxBytes
          item.sent = 0
          break
        }
        if (r.error === "EXISTS") return finish(job, "conflict", r.message)
        if (RETRYABLE.has(r.status) && attempt < delays.length) {
          await sleep(delays[attempt++])
          if (!alive()) return
          continue
        }
        return finish(job, "error", r.message || "No se ha podido empezar la subida.")
      }
    }
    const id = job.id
    let chunk = opts.initialChunk ?? 1 * MiB // grows ×4 per request on a fast link
    const chunkMax = job.chunkMax
    let offset = 0
    attempt = 0
    for (;;) {
      const end = Math.min(item.total, offset + Math.min(chunk, chunkMax))
      const blob = file.slice(offset, end)
      const t0 = now()
      const put = transport.put(id, offset, blob, (loaded) => {
        if (!alive()) return
        item.sent = offset + loaded
        const t = now()
        job.samples.push({ t, bytes: item.sent })
        while (job.samples.length > 2 && t - job.samples[0].t > 5000) job.samples.shift()
        item.speed = speedOf(job.samples)
        emit()
      })
      job.abort = put.abort
      const r = await put.promise
      if (!alive()) return
      job.abort = null
      if (r.ok) {
        attempt = 0
        chunk = nextChunkSize(chunk, blob.size, now() - t0, chunkMax)
        offset = r.data.received
        item.sent = offset
        if (r.data.done) {
          item.finalName = r.data.name
          finish(job, "done")
          opts.onFinished?.({ ...item })
          return
        }
        emit()
        continue
      }
      const received = r.extra?.received
      if (r.error === "OFFSET" && typeof received === "number") {
        offset = received
        item.sent = received
        continue
      }
      if (RETRYABLE.has(r.status) && attempt < delays.length) {
        // A lost chunk: the server keeps what it received (OFFSET tells where to go on).
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2))
        await sleep(delays[attempt++])
        if (!alive()) return
        continue
      }
      void transport.cancel(id).catch(() => undefined)
      job.id = null
      return finish(job, "error", r.message || "Se ha interrumpido la subida.")
    }
  }

  function pump(): void {
    while (running < concurrency) {
      const next = jobs.find((j) => j.item.status === "queued")
      if (!next) break
      next.item.status = "uploading"
      next.samples = []
      running++
      run(next)
        .catch((err: unknown) => finish(next, "error", err instanceof Error ? err.message : "Error inesperado en la subida."))
        .finally(() => {
          running--
          emit()
          pump()
        })
    }
    emit()
  }

  function requeue(job: Job): void {
    job.generation++
    job.id = null
    job.item.sent = 0
    job.item.error = null
    job.item.finalName = null
    job.item.status = "queued"
  }

  return {
    add(reqs) {
      for (const r of reqs) {
        const bad = validateNewName(r.file.name)
        const tooBig = opts.maxBytes !== undefined && r.file.size > opts.maxBytes
        const item: UploadItem = {
          key: `u${++seq}`, name: r.file.name, root: r.root ?? DEFAULT_FILES_ROOT, rootLabel: r.rootLabel ?? r.root ?? DEFAULT_FILES_ROOT, dir: r.dir, total: r.file.size, sent: 0, status: "queued", error: null,
          finalName: null, speed: 0, conflict: r.conflict,
        }
        if (bad) {
          item.status = "error"
          item.error = bad
        } else if (tooBig) {
          item.status = "error"
          item.error = `Ocupa ${formatBytes(r.file.size)} y el máximo es ${formatBytes(opts.maxBytes ?? 0)}.`
        }
        jobs.push({ item, file: r.file, id: null, chunkMax: 64 * MiB, abort: null, samples: [], generation: 0 })
      }
      pump()
    },
    cancel(key) {
      const job = find(key)
      if (!job || FINISHED.has(job.item.status)) return
      job.generation++
      job.abort?.()
      if (job.id) void transport.cancel(job.id).catch(() => undefined)
      job.id = null
      finish(job, "canceled")
      emit()
    },
    retry(key) {
      const job = find(key)
      if (!job || (job.item.status !== "error" && job.item.status !== "canceled")) return
      if (validateNewName(job.item.name) || (opts.maxBytes !== undefined && job.item.total > opts.maxBytes)) return
      requeue(job)
      pump()
    },
    resolveConflict(key, mode) {
      const job = find(key)
      if (!job || job.item.status !== "conflict") return
      requeue(job)
      job.item.conflict = mode
      pump()
    },
    clearFinished() {
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (FINISHED.has(jobs[i].item.status)) jobs.splice(i, 1)
      }
      emit()
    },
    snapshot: () => snap,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    active: () => jobs.filter((j) => j.item.status === "queued" || j.item.status === "uploading").length,
  }
}
