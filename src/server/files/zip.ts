// Dependency-free streaming ZIP writer ("Descargar como .zip"). Entries are STORED (tftp payloads are usually already
// compressed images), written one after the other with data descriptors, so nothing is buffered beyond one read chunk
// and the archive starts flowing at once. ZIP64 records are used per entry when an entry or an offset needs them.
// UTF-8 names (flag bit 11). Files over 4 GiB and archives over 4 GiB use ZIP64. Pure: the caller supplies the
// entries and how to read each file.
import zlib from "node:zlib"
import { capped, type ArchiveEntry } from "./archive"

/** @deprecated name kept for the tests: the entry model is ArchiveEntry. */
export type ZipEntry = ArchiveEntry

const U32 = 0xffffffff
const U16 = 0xffff
const Z64_THRESHOLD = 0xffff0000

function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear()
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

interface Central {
  name: Buffer; kind: "file" | "dir"; crc: number; size: number; offset: number; zip64: boolean
  time: number; date: number; mode: number; flags: number
}

function localHeader(name: Buffer, flags: number, zip64: boolean, time: number, date: number, dir: boolean): Buffer {
  const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0)
  if (zip64) {
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(16, 2) // original + compressed size (0: in the data descriptor)
  }
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(zip64 ? 45 : dir ? 20 : 20, 4)
  h.writeUInt16LE(flags, 6)
  h.writeUInt16LE(0, 8) // stored
  h.writeUInt16LE(time, 10)
  h.writeUInt16LE(date, 12)
  h.writeUInt32LE(0, 14) // crc (data descriptor)
  h.writeUInt32LE(zip64 ? U32 : 0, 18)
  h.writeUInt32LE(zip64 ? U32 : 0, 22)
  h.writeUInt16LE(name.length, 26)
  h.writeUInt16LE(extra.length, 28)
  return Buffer.concat([h, name, extra])
}

function dataDescriptor(crc: number, size: number, zip64: boolean): Buffer {
  const d = Buffer.alloc(zip64 ? 24 : 16)
  d.writeUInt32LE(0x08074b50, 0)
  d.writeUInt32LE(crc >>> 0, 4)
  if (zip64) {
    d.writeBigUInt64LE(BigInt(size), 8)
    d.writeBigUInt64LE(BigInt(size), 16)
  } else {
    d.writeUInt32LE(size, 8)
    d.writeUInt32LE(size, 12)
  }
  return d
}

function centralHeader(c: Central): Buffer {
  const bigSize = c.zip64 || c.size >= U32
  const bigOffset = c.offset >= U32
  const fields: bigint[] = []
  if (bigSize) fields.push(BigInt(c.size), BigInt(c.size))
  if (bigOffset) fields.push(BigInt(c.offset))
  const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0)
  if (fields.length) {
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(fields.length * 8, 2)
    fields.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8))
  }
  const needs = bigSize || bigOffset ? 45 : 20
  const h = Buffer.alloc(46)
  h.writeUInt32LE(0x02014b50, 0)
  h.writeUInt16LE((3 << 8) | 45, 4) // made by: Unix, spec 4.5
  h.writeUInt16LE(needs, 6)
  h.writeUInt16LE(c.flags, 8)
  h.writeUInt16LE(0, 10)
  h.writeUInt16LE(c.time, 12)
  h.writeUInt16LE(c.date, 14)
  h.writeUInt32LE(c.crc >>> 0, 16)
  h.writeUInt32LE(bigSize ? U32 : c.size, 20)
  h.writeUInt32LE(bigSize ? U32 : c.size, 24)
  h.writeUInt16LE(c.name.length, 28)
  h.writeUInt16LE(extra.length, 30)
  h.writeUInt16LE(0, 32) // comment
  h.writeUInt16LE(0, 34) // disk
  h.writeUInt16LE(0, 36) // internal attributes
  const unixMode = (c.kind === "dir" ? 0o040000 : 0o100000) | (c.mode & 0o7777)
  h.writeUInt32LE(((unixMode << 16) | (c.kind === "dir" ? 0x10 : 0)) >>> 0, 38)
  h.writeUInt32LE(bigOffset ? U32 : c.offset, 42)
  return Buffer.concat([h, c.name, extra])
}

function endRecords(count: number, cdOffset: number, cdSize: number, forceZip64: boolean): Buffer {
  const zip64 = forceZip64 || count >= U16 || cdOffset >= U32 || cdSize >= U32
  const parts: Buffer[] = []
  if (zip64) {
    const z = Buffer.alloc(56)
    z.writeUInt32LE(0x06064b50, 0)
    z.writeBigUInt64LE(44n, 4)
    z.writeUInt16LE((3 << 8) | 45, 12)
    z.writeUInt16LE(45, 14)
    z.writeUInt32LE(0, 16)
    z.writeUInt32LE(0, 20)
    z.writeBigUInt64LE(BigInt(count), 24)
    z.writeBigUInt64LE(BigInt(count), 32)
    z.writeBigUInt64LE(BigInt(cdSize), 40)
    z.writeBigUInt64LE(BigInt(cdOffset), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeUInt32LE(0, 4)
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8)
    loc.writeUInt32LE(1, 16)
    parts.push(z, loc)
  }
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0)
  e.writeUInt16LE(0, 4)
  e.writeUInt16LE(0, 6)
  e.writeUInt16LE(zip64 ? U16 : count, 8)
  e.writeUInt16LE(zip64 ? U16 : count, 10)
  e.writeUInt32LE(zip64 ? U32 : cdSize, 12)
  e.writeUInt32LE(zip64 ? U32 : cdOffset, 16)
  e.writeUInt16LE(0, 20)
  parts.push(e)
  return Buffer.concat(parts)
}

/**
 * The archive as a stream of buffers. `forceZip64` writes ZIP64 records for every entry and the end (tests: the
 * large-archive layout without 4 GiB of data).
 */
export async function* zipStream(entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>, opts: { forceZip64?: boolean } = {}): AsyncGenerator<Buffer> {
  const central: Central[] = []
  let offset = 0
  for await (const e of entries) {
    const name = Buffer.from(e.kind === "dir" ? `${e.name.replace(/\/+$/, "")}/` : e.name, "utf8")
    const { time, date } = dosDateTime(e.mtime)
    const offsetHere = offset
    if (e.kind === "dir") {
      const flags = 0x0800
      const h = localHeader(name, flags, false, time, date, true)
      offset += h.length
      yield h
      central.push({ name, kind: "dir", crc: 0, size: 0, offset: offsetHere, zip64: false, time, date, mode: e.mode, flags })
      continue
    }
    // Opened before its header: the size decides ZIP64, and an unreadable file is left out.
    const body = e.open ? await e.open() : null
    if (!body) continue
    try {
      const zip64 = !!opts.forceZip64 || body.size >= Z64_THRESHOLD || offsetHere >= Z64_THRESHOLD
      const flags = 0x0808
      const h = localHeader(name, flags, zip64, time, date, false)
      offset += h.length
      yield h
      let crc = 0
      let size = 0
      for await (const chunk of capped(body)) {
        crc = zlib.crc32(chunk, crc)
        size += chunk.length
        offset += chunk.length
        yield chunk
      }
      const d = dataDescriptor(crc, size, zip64)
      offset += d.length
      yield d
      central.push({ name, kind: "file", crc, size, offset: offsetHere, zip64, time, date, mode: e.mode, flags })
    } finally {
      body.close?.() // also when the client went away while the header was being sent
    }
  }
  const cdOffset = offset
  let cdSize = 0
  for (const c of central) {
    const h = centralHeader(c)
    cdSize += h.length
    yield h
  }
  yield endRecords(central.length, cdOffset, cdSize, !!opts.forceZip64)
}
