// Download helpers for the W1-C route handlers (§7.3 "Downloads"). Stateless.
import fs from "node:fs"

/** ASCII fallback: only [a-z0-9._-] (accents stripped, everything else → "-"). */
export function asciiFileName(name: string): string {
  const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return slug || "descarga"
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<pct-encoded>` */
export function attachmentDisposition(name: string): string {
  return `attachment; filename="${asciiFileName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** Streams a file in 64 KiB chunks; the handle is closed at the end, on error and on cancel. */
export function fileStream(file: string, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let handle: fs.promises.FileHandle | null = null
  const close = async () => {
    const h = handle
    handle = null
    await h?.close().catch(() => {})
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        handle ??= await fs.promises.open(file, "r")
        const buf = new Uint8Array(chunkSize)
        const { bytesRead } = await handle.read(buf, 0, chunkSize, null)
        if (bytesRead === 0) {
          await close()
          controller.close()
          return
        }
        controller.enqueue(buf.subarray(0, bytesRead))
      } catch (err) {
        await close()
        controller.error(err)
      }
    },
    async cancel() {
      await close()
    },
  })
}

/** "2026-09-23" (UTC) for export file names. */
export function isoDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}
