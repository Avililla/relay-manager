// GET /api/consoles/<consoleId>/logs/<file> → the capture file as a download (W1-A, §7.3). Audited.
import fs from "node:fs"
import { z } from "zod"
import { IdSchema } from "@/lib/contracts/common"
import { CaptureFileNameSchema } from "@/lib/contracts/serial"
import { captureDownloadName } from "@/lib/serial/format"
import { consoleForUser } from "@/server/access"
import { defineRoute } from "@/server/actions/define-route"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const CHUNK = 64 * 1024
const notFound = () => Response.json({ error: "NOT_FOUND" }, { status: 404 })
/** RFC 5987 ext-value: encodeURIComponent leaves ' ( ) * and ! unencoded, which attr-char does not allow. */
const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)

/**
 * Exactly `size` bytes of the file (today's file keeps growing while it is downloaded: anything past the measured
 * size would overflow Content-Length and break keep-alive framing). The file is opened on the first read, not
 * before, so a response whose body is never read (HEAD, a client gone before the body) holds no descriptor; a
 * cancelled read closes it.
 */
function fileBody(file: string, size: number): ReadableStream<Uint8Array> {
  let fh: fs.promises.FileHandle | null = null
  let pos = 0
  const close = async () => {
    const h = fh
    fh = null
    await h?.close().catch(() => undefined)
  }
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        fh ??= await fs.promises.open(file, "r")
        const want = Math.min(CHUNK, size - pos)
        const buf = Buffer.allocUnsafe(want)
        const { bytesRead } = await fh.read(buf, 0, want, pos)
        if (bytesRead === 0) throw new Error("capture file shrank during the download")
        pos += bytesRead
        ctrl.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead))
        if (pos >= size) {
          await close()
          ctrl.close()
        }
      } catch (err) {
        await close()
        ctrl.error(err)
      }
    },
    cancel: close,
  }, { highWaterMark: 0 })
}

export const GET = defineRoute(
  { auth: "user", params: z.object({ consoleId: IdSchema, file: CaptureFileNameSchema }), operation: "console.log.download" },
  async ({ req, rt, user, actor, params }) => {
    const c = await consoleForUser(rt.prisma, user, params.consoleId)
    if (!c) return notFound()
    // Typed text (passwords) lives in .input.log files: admins only, and a non-admin cannot even tell they exist.
    if (!user.isAdmin && /\.input\.log(\.gz)?$/.test(params.file)) return notFound()
    const file = rt.serial.consoles.captureFilePath(c.consoleId, params.file)
    if (!file) return notFound()
    let size: number
    try {
      const st = await fs.promises.stat(file)
      if (!st.isFile()) return notFound()
      size = st.size
    } catch {
      return notFound()
    }
    const names = captureDownloadName(c.name, c.key, params.file)
    // HEAD (Next answers it with this handler): the same headers, no body, not audited as a download.
    const head = req.method === "HEAD"
    if (!head) {
      rt.audit.record({
        actor, action: "console.log.download", equipment: { id: c.id, name: c.name },
        target: { type: "console", id: c.consoleId, name: c.key }, detail: { file: params.file, sizeBytes: size },
      })
    }
    const body = head || size === 0 ? null : fileBody(file, size)
    return new Response(body, {
      headers: {
        "content-type": params.file.endsWith(".gz") ? "application/gzip" : "text/plain; charset=utf-8",
        "content-length": String(size),
        "content-disposition": `attachment; filename="${names.ascii}"; filename*=UTF-8''${rfc5987(names.utf8)}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    })
  },
)
