// One upload queue per browser tab, outside React: uploads keep going while the user browses other folders or other
// pages of the app (the Archivos page shows the queue again when it comes back).
import { createUploadEngine, type UploadEngine, type UploadItem } from "./upload-engine"
import { browserUploadTransport } from "./upload-transport"

let engine: UploadEngine | null = null
const finishedListeners = new Set<(item: UploadItem) => void>()

export function uploadEngine(): UploadEngine {
  engine ??= createUploadEngine(browserUploadTransport(), {
    concurrency: 2,
    onFinished: (item) => { for (const l of [...finishedListeners]) l(item) },
  })
  return engine
}

/** Called for every committed upload (the listing refreshes). */
export function onUploadFinished(fn: (item: UploadItem) => void): () => void {
  finishedListeners.add(fn)
  return () => { finishedListeners.delete(fn) }
}
