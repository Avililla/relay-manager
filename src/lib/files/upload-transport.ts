// Browser transport of the upload engine: POST /api/files/upload (JSON) to start, XHR PUT per chunk (upload progress
// events, abortable), DELETE to cancel. Same origin: the browser sends Origin and the session cookie.
import { FILES_API, type ConflictMode, type FilesRootId } from "@/lib/contracts/files"
import type { BlobLike, TransportResult, UploadTransport } from "./upload-engine"

const NETWORK = "No se ha podido contactar con el servidor. Comprueba la conexión."

function parse(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function failure<T>(status: number, body: Record<string, unknown>): TransportResult<T> {
  const { error, message, ...extra } = body
  return {
    ok: false,
    status,
    error: typeof error === "string" ? error : status === 0 ? "NETWORK" : "INTERNAL",
    message: typeof message === "string" ? message : status === 0 ? NETWORK : `Error del servidor (${status}).`,
    extra,
  }
}

export function browserUploadTransport(): UploadTransport {
  return {
    async start(input: { root: FilesRootId; dir: string; name: string; size: number; conflict: ConflictMode }) {
      try {
        const res = await fetch(FILES_API.upload, {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
        })
        const body = parse(await res.text())
        if (!res.ok) return failure(res.status, body)
        return { ok: true, data: { id: String(body.id), chunkMaxBytes: Number(body.chunkMaxBytes) } }
      } catch {
        return failure(0, {})
      }
    },
    put(id: string, offset: number, blob: BlobLike, onProgress: (loaded: number) => void) {
      const xhr = new XMLHttpRequest()
      const promise = new Promise<TransportResult<{ received: number; done: boolean; name: string | null }>>((resolve) => {
        xhr.open("PUT", `${FILES_API.upload}/${id}?offset=${offset}`)
        xhr.setRequestHeader("content-type", "application/octet-stream")
        xhr.upload.onprogress = (e) => onProgress(e.loaded)
        xhr.onload = () => {
          const body = parse(xhr.responseText)
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ ok: true, data: { received: Number(body.received), done: body.done === true, name: typeof body.name === "string" ? body.name : null } })
          } else resolve(failure(xhr.status, body))
        }
        xhr.onerror = () => resolve(failure(0, {}))
        xhr.ontimeout = () => resolve(failure(0, {}))
        xhr.onabort = () => resolve(failure(0, { error: "ABORTED", message: "Cancelada." }))
        xhr.send(blob as Blob)
      })
      return { promise, abort: () => xhr.abort() }
    },
    async cancel(id: string) {
      await fetch(`${FILES_API.upload}/${id}`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => undefined)
    },
  }
}
