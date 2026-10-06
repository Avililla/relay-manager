// Folder downloads of "Archivos": the entry model shared by the streaming ZIP and tar writers.

export { ARCHIVE_FORMATS, type ArchiveFormat } from "@/lib/contracts/files"

/** What a writer reads for one file: its size when opened (the header needs it) and its bytes. */
export interface ArchiveBody {
  size: number
  stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
  /** Releases the file (called in any case once the entry is written or the archive is abandoned). */
  close?: () => void
}

export interface ArchiveEntry {
  /** Path inside the archive, "/"-separated, without a trailing slash. */
  name: string
  kind: "file" | "dir"
  mtime: Date
  /** Unix permission bits. */
  mode: number
  /** Files: opens the contents at the moment the entry is written; null = unreadable now (the entry is skipped). */
  open?: () => Promise<ArchiveBody | null>
}

/** At most `size` bytes of the body (a file growing while it is archived never overflows its header). */
export async function* capped(body: ArchiveBody): AsyncGenerator<Buffer> {
  let left = body.size
  for await (const raw of body.stream) {
    if (left <= 0) break
    const chunk = raw.length > left ? raw.subarray(0, left) : raw
    left -= chunk.length
    yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)
  }
}
