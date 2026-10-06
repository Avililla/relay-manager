// Dependency-free streaming tar writer (POSIX ustar + pax extended headers) for "Descargar como .tar.gz": the HTTP
// layer gzips it with node:zlib on the fly. pax records carry names that are long (> 100 bytes) or not ASCII, and
// sizes beyond the 8 GiB of the ustar field. Nothing is buffered beyond one read chunk.
import { capped, type ArchiveEntry } from "./archive"

const BLOCK = 512
const USTAR_MAX_SIZE = 0o77777777777 // 8 GiB - 1
const ZEROS = Buffer.alloc(BLOCK)

function octal(buf: Buffer, offset: number, length: number, value: number): void {
  const s = Math.max(0, Math.floor(value)).toString(8)
  buf.write(s.padStart(length - 1, "0").slice(-(length - 1)), offset, length - 1, "ascii")
  buf[offset + length - 1] = 0
}

/** Printable ASCII fallback of a name for the 100-byte ustar field (the pax record has the real one). */
function asciiName(name: string, dir: boolean): string {
  let s = name.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\x20-\x7e]/g, "_")
  const tail = dir ? "/" : ""
  if (Buffer.byteLength(s + tail) > 100) s = s.slice(s.length - (100 - tail.length))
  return s + tail
}

function header(name: string, type: "0" | "5" | "x", size: number, mode: number, mtimeSec: number): Buffer {
  const b = Buffer.alloc(BLOCK)
  b.write(name, 0, 100, "utf8")
  octal(b, 100, 8, mode & 0o7777)
  octal(b, 108, 8, 0) // uid
  octal(b, 116, 8, 0) // gid
  octal(b, 124, 12, size > USTAR_MAX_SIZE ? 0 : size)
  octal(b, 136, 12, Math.min(USTAR_MAX_SIZE, Math.max(0, mtimeSec)))
  b.fill(0x20, 148, 156) // checksum placeholder
  b.write(type, 156, 1, "ascii")
  b.write("ustar\u000000", 257, 8, "binary")
  let sum = 0
  for (const byte of b) sum += byte
  b.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii")
  b[154] = 0
  b[155] = 0x20
  return b
}

/** One pax record "<len> key=value\n", where len counts itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  const bodyLen = Buffer.byteLength(body)
  let len = bodyLen + 1
  for (;;) {
    const n = String(len).length + bodyLen
    if (n === len) break
    len = n
  }
  return `${len}${body}`
}

const pad = (n: number) => (n % BLOCK === 0 ? null : ZEROS.subarray(0, BLOCK - (n % BLOCK)))

/**
 * The tar stream. `paxSizeThreshold` (tests) moves sizes to pax records from a smaller size than 8 GiB, so the
 * large-file layout can be checked with small files.
 */
export async function* tarStream(entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>, opts: { paxSizeThreshold?: number } = {}): AsyncGenerator<Buffer> {
  const bigSize = Math.min(opts.paxSizeThreshold ?? USTAR_MAX_SIZE + 1, USTAR_MAX_SIZE + 1)
  for await (const e of entries) {
    const dir = e.kind === "dir"
    const body = dir ? null : e.open ? await e.open() : null
    if (!dir && !body) continue
    try {
      const size = body?.size ?? 0
      const fullName = dir ? `${e.name}/` : e.name
      const mtime = Math.floor(e.mtime.getTime() / 1000)
      const records: string[] = []
      const needsPaxName = Buffer.byteLength(fullName) > 100 || /[^\x20-\x7e]/.test(fullName)
      if (needsPaxName) records.push(paxRecord("path", fullName))
      if (size >= bigSize) records.push(paxRecord("size", String(size)))
      if (records.length) {
        const pax = Buffer.from(records.join(""), "utf8")
        yield header(asciiName(`PaxHeaders/${e.name}`, false), "x", pax.length, 0o644, mtime)
        yield pax
        const p = pad(pax.length)
        if (p) yield p
      }
      const shown = needsPaxName ? asciiName(e.name, dir) : fullName
      yield header(shown, dir ? "5" : "0", size >= bigSize ? (size > USTAR_MAX_SIZE ? 0 : size) : size, e.mode, mtime)
      if (!body) continue
      let written = 0
      for await (const chunk of capped(body)) {
        written += chunk.length
        yield chunk
      }
      // The file shrank while it was read: fill up to the size announced in the header (keeps the archive valid).
      while (written < size) {
        const n = Math.min(64 * 1024, size - written)
        yield Buffer.alloc(n)
        written += n
      }
      const p = pad(size)
      if (p) yield p
    } finally {
      body?.close?.() // also when the client went away while the header was being sent
    }
  }
  yield Buffer.alloc(BLOCK * 2)
}
