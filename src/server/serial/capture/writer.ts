// Continuous console capture (§4.6): one rotating, timestamped log per console and UTC day.
import fs from "node:fs"
import path from "node:path"
import type { InputCapture } from "@/lib/contracts/enums"
import { CAPTURE_MARK } from "@/lib/i18n/serial"
import { parseCaptureName, utcDay } from "./retention"

export interface CaptureMeta { consoleId: string; equipmentId: string; equipmentName: string; key: string; label: string }

export interface CaptureWriterOptions {
  /** <captureDir>/<consoleId> */
  dir: string
  meta: CaptureMeta
  now?: () => Date
  maxFileBytes: () => number
  inputMode: () => InputCapture
  /** Disk guard: while true nothing is written. */
  paused: () => boolean
  /** Called after a size rollover (the service runs retention). */
  onRollover?: () => void
  onError?: (err: unknown) => void
  /** Input bytes closer than this belong to one burst (one marker line). Default 1 s. */
  burstMs?: number
}

const LF = Buffer.from("\n")
const CR = Buffer.from("\r")

class FileSink {
  readonly path: string
  size: number
  private readonly stream: fs.WriteStream
  private last: Promise<void> = Promise.resolve()
  private broken = false

  constructor(p: string, onError: (err: unknown) => void, private readonly onBytes: (n: number) => void) {
    this.path = p
    let size = 0
    try { size = fs.statSync(p).size } catch { /* new file */ }
    this.size = size
    this.stream = fs.createWriteStream(p, { flags: "a", mode: 0o640 })
    this.stream.on("error", (err) => {
      if (!this.broken) onError(err)
      this.broken = true
    })
  }

  write(buf: Buffer): void {
    if (this.broken || buf.length === 0) return
    this.size += buf.length
    this.onBytes(buf.length)
    this.last = new Promise<void>((resolve) => { this.stream.write(buf, () => resolve()) })
  }

  get isBroken(): boolean { return this.broken }

  flush(): Promise<void> { return this.last }

  end(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stream.closed || this.stream.destroyed) return resolve()
      this.stream.end(() => resolve())
      this.stream.once("error", () => resolve())
    })
  }
}

interface Burst { user: string; at: Date; bytes: number; chunks: Buffer[] }

export class CaptureWriter {
  private readonly o: CaptureWriterOptions
  private meta: CaptureMeta
  private readonly now: () => Date
  private main: FileSink | null = null
  private input: FileSink | null = null
  private base: { date: string; index: number } | null = null
  private atLineStart = true
  private pendingCR = false
  private swallowLF = false
  private burst: Burst | null = null
  private burstTimer: NodeJS.Timeout | null = null
  private wasPaused = false
  private closing: Array<Promise<void>> = []
  private dirReady = false
  /** Bytes written since creation (all files): feeds the capture total between retention runs. */
  bytesWritten = 0

  constructor(o: CaptureWriterOptions) {
    this.o = o
    this.meta = o.meta
    this.now = o.now ?? (() => new Date())
  }

  // --- public API --------------------------------------------------------------------------------

  writeRx(chunk: Buffer): void {
    if (!chunk.length || this.blockedByPause()) return
    const now = this.now()
    const sink = this.ensureMain(now)
    if (!sink) return
    sink.write(this.transform(chunk, now))
  }

  writeInput(user: string, bytes: Buffer): void {
    if (!bytes.length || this.blockedByPause()) return
    if (this.burst && this.burst.user !== user) this.flushBurst()
    if (!this.burst) this.burst = { user, at: this.now(), bytes: 0, chunks: [] }
    this.burst.bytes += bytes.length
    if (this.o.inputMode() === "full") this.burst.chunks.push(Buffer.from(bytes))
    if (this.burstTimer) clearTimeout(this.burstTimer)
    this.burstTimer = setTimeout(() => this.flushBurst(), this.o.burstMs ?? 1000)
    this.burstTimer.unref()
  }

  /** "[ISO] --- text ---" on its own line. */
  marker(text: string): void {
    this.line((ts) => `[${ts}] --- ${text} ---\n`)
  }

  /** "# ISO abierto /dev/ttyUSB2 115200 8N1" */
  openMarker(devNode: string, line: string): void {
    this.line((ts) => `# ${ts} ${CAPTURE_MARK.opened(devNode, line)}\n`)
  }

  updateMeta(meta: CaptureMeta): void {
    const changed = JSON.stringify(meta) !== JSON.stringify(this.meta)
    this.meta = meta
    if (changed && this.dirReady) this.writeMeta()
  }

  activeFiles(): string[] {
    return [this.main?.path, this.input?.path].filter((p): p is string => typeof p === "string")
  }

  async flush(): Promise<void> {
    this.flushBurst()
    await Promise.all([this.main?.flush(), this.input?.flush(), ...this.closing])
  }

  async close(): Promise<void> {
    this.flushBurst()
    if (this.pendingCR) {
      this.pendingCR = false
      this.main?.write(CR)
    }
    const sinks = [this.main, this.input]
    this.main = null
    this.input = null
    this.base = null
    await Promise.all([...sinks.map((s) => s?.end()), ...this.closing])
    this.closing = []
  }

  // --- internals ---------------------------------------------------------------------------------

  private blockedByPause(): boolean {
    if (this.o.paused()) {
      this.wasPaused = true
      if (this.burst) { this.burst = null; if (this.burstTimer) clearTimeout(this.burstTimer) }
      return true
    }
    if (this.wasPaused) {
      this.wasPaused = false
      this.line((ts) => `[${ts}] --- captura reanudada (se perdieron datos por falta de espacio) ---\n`, true)
    }
    return false
  }

  private prefix(now: Date): Buffer {
    return Buffer.from(`[${now.toISOString()}] `)
  }

  /** Writes a full line, starting a new line first when the current one is incomplete. */
  private line(render: (ts: string) => string, skipPauseCheck = false): void {
    if (!skipPauseCheck && this.blockedByPause()) return
    const now = this.now()
    const sink = this.ensureMain(now)
    if (!sink) return
    const parts: Buffer[] = []
    if (this.pendingCR) {
      this.pendingCR = false
      this.swallowLF = true
      this.atLineStart = false
    }
    if (!this.atLineStart) parts.push(LF)
    parts.push(Buffer.from(render(now.toISOString())))
    this.atLineStart = true
    sink.write(Buffer.concat(parts))
  }

  private transform(chunk: Buffer, now: Date): Buffer {
    const parts: Buffer[] = []
    const emit = (buf: Buffer) => {
      if (this.atLineStart) {
        parts.push(this.prefix(now))
        this.atLineStart = false
      }
      parts.push(buf)
    }
    const endLine = () => {
      parts.push(LF)
      this.atLineStart = true
    }
    let i = 0
    const n = chunk.length
    while (i < n) {
      const b = chunk[i]
      if (this.swallowLF) {
        this.swallowLF = false
        if (b === 0x0a) { i++; continue }
      }
      if (this.pendingCR) {
        this.pendingCR = false
        if (b === 0x0a) { endLine(); i++; continue }
        emit(CR) // a lone CR is kept inside the line
      }
      if (b === 0x0d) { this.pendingCR = true; i++; continue }
      if (b === 0x0a) { endLine(); i++; continue }
      let j = i
      while (j < n && chunk[j] !== 0x0d && chunk[j] !== 0x0a) j++
      emit(chunk.subarray(i, j))
      i = j
    }
    return Buffer.concat(parts)
  }

  private flushBurst(): void {
    if (this.burstTimer) { clearTimeout(this.burstTimer); this.burstTimer = null }
    const b = this.burst
    this.burst = null
    if (!b || this.o.paused()) return
    this.line(() => `[${b.at.toISOString()}] ${CAPTURE_MARK.input(b.user, b.bytes)}\n`)
    if (this.o.inputMode() === "full" && b.chunks.length) {
      const input = this.ensureInput(this.now())
      input?.write(Buffer.from(`[${b.at.toISOString()}] >>> ${b.user}: ${JSON.stringify(Buffer.concat(b.chunks).toString("utf8"))}\n`))
    }
  }

  private ensureDir(): boolean {
    if (this.dirReady) return true
    try {
      fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o750 })
      this.dirReady = true
      this.writeMeta()
      return true
    } catch (err) {
      this.o.onError?.(err)
      return false
    }
  }

  private writeMeta(): void {
    try {
      const p = path.join(this.o.dir, "meta.json")
      fs.writeFileSync(`${p}.tmp`, JSON.stringify({ ...this.meta, updatedAt: this.now().toISOString() }, null, 2) + "\n", { mode: 0o640 })
      fs.renameSync(`${p}.tmp`, p)
    } catch (err) {
      this.o.onError?.(err)
    }
  }

  private header(): Buffer {
    const m = this.meta
    return Buffer.from(`# ${CAPTURE_MARK.header(m.equipmentName, m.equipmentId, m.key, m.consoleId)}\n`)
  }

  /** Latest existing index for `date` (to append after a restart), or 0. */
  private latestIndex(date: string): number {
    let max = -1
    try {
      for (const name of fs.readdirSync(this.o.dir)) {
        const p = parseCaptureName(name)
        if (p && p.date === date && !p.input && !p.compressed) max = Math.max(max, p.index)
      }
    } catch {
      /* empty */
    }
    return Math.max(0, max)
  }

  private fileName(date: string, index: number, input: boolean): string {
    return `${date}${index > 0 ? `.${index}` : ""}${input ? ".input" : ""}.log`
  }

  private openSink(name: string): FileSink {
    const sink = new FileSink(path.join(this.o.dir, name), (err) => this.o.onError?.(err), (n) => { this.bytesWritten += n })
    if (sink.size === 0) sink.write(this.header())
    return sink
  }

  private retire(sink: FileSink | null): void {
    if (sink) this.closing.push(sink.end())
    if (this.closing.length > 8) this.closing = this.closing.slice(-8)
  }

  /** The main sink for `now`, rolling over on a new UTC day or when the size limit is reached. */
  private ensureMain(now: Date): FileSink | null {
    if (!this.ensureDir()) return null
    const date = utcDay(now)
    const max = Math.max(1, this.o.maxFileBytes())
    let rolledForSize = false
    if (this.main && this.base && !this.main.isBroken && this.base.date === date && this.main.size < max) return this.main
    if (this.main && this.base) {
      // Finish the current line in the old file; the next bytes start a new, timestamped line.
      if (this.pendingCR) { this.pendingCR = false; this.swallowLF = true; this.atLineStart = false }
      if (!this.atLineStart) this.main.write(LF)
      this.atLineStart = true
      rolledForSize = this.base.date === date && this.main.size >= max
      const index = this.base.date === date ? this.base.index + 1 : 0
      this.retire(this.main)
      this.retire(this.input)
      this.input = null
      this.base = { date, index: this.base.date === date ? index : this.latestIndex(date) }
    } else {
      this.base = { date, index: this.latestIndex(date) }
      // After a restart the latest file may already be full.
      try {
        const st = fs.statSync(path.join(this.o.dir, this.fileName(date, this.base.index, false)))
        if (st.size >= max) this.base.index += 1
      } catch {
        /* new file */
      }
    }
    this.main = this.openSink(this.fileName(this.base.date, this.base.index, false))
    if (rolledForSize) this.o.onRollover?.()
    return this.main
  }

  private ensureInput(now: Date): FileSink | null {
    const main = this.ensureMain(now)
    if (!main || !this.base) return null
    if (!this.input) this.input = this.openSink(this.fileName(this.base.date, this.base.index, true))
    return this.input
  }
}
