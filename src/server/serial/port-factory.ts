// Port opener (§4.5): wraps serialport with lock (flock), hupcl and the line settings. Injectable for tests.
import { SerialPort } from "serialport"
import type { LineSettings } from "@/lib/contracts/enums"
import { SERIAL_DETAIL } from "@/lib/i18n/serial"

export interface PortOpenOptions { path: string; line: LineSettings; hupcl: boolean; lock?: boolean }

export interface PortHandle {
  readonly path: string
  isOpen(): boolean
  onData(cb: (chunk: Buffer) => void): void
  /** Called once when the port goes away under us (unplug, I/O error); never for our own close(). */
  onClose(cb: (err: Error | null) => void): void
  write(data: Buffer): Promise<void>
  set(flags: { brk?: boolean }): Promise<void>
  close(): Promise<void>
}
export type PortOpener = (opts: PortOpenOptions) => Promise<PortHandle>

/** The subset of serialport's stream API we use (SerialPort and SerialPortMock both provide it). */
interface StreamLike {
  isOpen: boolean
  open(cb: (err: Error | null) => void): void
  close(cb: (err: Error | null) => void): void
  write(data: Buffer, cb: (err: Error | null | undefined) => void): boolean
  set(opts: { brk?: boolean }, cb: (err: Error | null) => void): void
  on(ev: "data", cb: (chunk: Buffer) => void): unknown
  on(ev: "close", cb: (err: Error | null) => void): unknown
  on(ev: "error", cb: (err: Error) => void): unknown
  removeAllListeners(): unknown
  removeListener(ev: "error", cb: (err: Error) => void): unknown
}
interface StreamOptions {
  path: string; baudRate: number; dataBits: 5 | 6 | 7 | 8; parity: LineSettings["parity"]; stopBits: 1 | 2
  rtscts: boolean; xon: boolean; xoff: boolean; hupcl: boolean; lock: boolean; autoOpen: false
}
export type PortCtor = new (opts: StreamOptions) => StreamLike

export type OpenErrorKind = "busy" | "no-permission" | "missing" | "error"

/** Maps an open error to a console status and a Spanish detail (§4.5). */
export function mapOpenError(err: unknown): { kind: OpenErrorKind; detail: string; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined
  if (/Cannot lock port|Port is locked|Resource temporarily unavailable/i.test(message)) return { kind: "busy", detail: SERIAL_DETAIL.busy, message }
  if (code === "EPERM" || /Operation not permitted/i.test(message)) return { kind: "no-permission", detail: SERIAL_DETAIL.noPermissionDocker, message }
  if (code === "EACCES" || /Permission denied/i.test(message)) return { kind: "no-permission", detail: SERIAL_DETAIL.noPermission, message }
  if (code === "ENOENT" || /No such file or directory|does not exist/i.test(message)) return { kind: "missing", detail: SERIAL_DETAIL.missing, message }
  return { kind: "error", detail: SERIAL_DETAIL.openError(message.slice(0, 200)), message }
}

class StreamHandle implements PortHandle {
  readonly path: string
  private closing = false
  private lost = false
  private dataCb: ((chunk: Buffer) => void) | null = null
  private closeCb: ((err: Error | null) => void) | null = null

  constructor(private readonly s: StreamLike, path: string) {
    this.path = path
    s.on("data", (chunk: Buffer) => {
      try { this.dataCb?.(chunk) } catch { /* the consumer logs its own errors */ }
    })
    s.on("close", (err: Error | null) => this.gone(err))
    s.on("error", (err: Error) => {
      // An I/O error while open (EIO after unplug, a failed write) means the port is unusable: close it promptly
      // so the kernel frees the tty minor, and report it once.
      if (this.closing || this.lost) return
      if (this.s.isOpen) this.s.close(() => this.gone(err))
      else this.gone(err)
    })
  }

  private gone(err: Error | null): void {
    if (this.closing || this.lost) return
    this.lost = true
    try { this.closeCb?.(err) } catch { /* consumer error */ }
  }

  isOpen(): boolean { return !this.closing && !this.lost && this.s.isOpen }
  onData(cb: (chunk: Buffer) => void): void { this.dataCb = cb }
  onClose(cb: (err: Error | null) => void): void { this.closeCb = cb }

  write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) return reject(new Error("Port is not open"))
      this.s.write(data, (err) => (err ? reject(err) : resolve()))
    })
  }

  set(flags: { brk?: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) return reject(new Error("Port is not open"))
      this.s.set(flags, (err) => (err ? reject(err) : resolve()))
    })
  }

  close(): Promise<void> {
    if (this.closing) return Promise.resolve()
    this.closing = true
    return new Promise((resolve) => {
      if (!this.s.isOpen) {
        this.s.removeAllListeners()
        this.s.on("error", () => {})
        return resolve()
      }
      const t = setTimeout(() => resolve(), 2000)
      t.unref()
      this.s.close(() => {
        clearTimeout(t)
        this.s.removeAllListeners()
        this.s.on("error", () => {})
        resolve()
      })
    })
  }
}

export const OPEN_TIMEOUT_MS = 10_000
export const OPEN_TIMEOUT_MESSAGE = "Tiempo de espera agotado al abrir el puerto"

/**
 * A hung open (a misbehaving USB device) must not hang its caller: reject after `ms` (mapped to kind "error");
 * a handle that arrives later is closed at once, which also releases its lock.
 */
export function openWithDeadline(open: PortOpener, opts: PortOpenOptions, ms: number = OPEN_TIMEOUT_MS): Promise<PortHandle> {
  return new Promise<PortHandle>((resolve, reject) => {
    let late = false
    const timer = setTimeout(() => {
      late = true
      reject(new Error(OPEN_TIMEOUT_MESSAGE))
    }, ms)
    timer.unref()
    open(opts).then(
      (h) => {
        clearTimeout(timer)
        if (late) void h.close().catch(() => undefined)
        else resolve(h)
      },
      (err: unknown) => {
        clearTimeout(timer)
        if (!late) reject(err)
      },
    )
  })
}

export function createPortOpener(Ctor: PortCtor = SerialPort as unknown as PortCtor, hooks: { onStream?: (s: unknown) => void } = {}): PortOpener {
  return (opts) => new Promise<PortHandle>((resolve, reject) => {
    let s: StreamLike
    try {
      s = new Ctor({
        path: opts.path,
        baudRate: opts.line.baudRate,
        dataBits: opts.line.dataBits,
        parity: opts.line.parity,
        stopBits: opts.line.stopBits,
        rtscts: opts.line.flowControl === "rtscts",
        xon: opts.line.flowControl === "xonxoff",
        xoff: opts.line.flowControl === "xonxoff",
        hupcl: opts.hupcl,
        lock: opts.lock ?? true,
        autoOpen: false,
      })
    } catch (err) {
      return reject(err)
    }
    hooks.onStream?.(s)
    const onEarlyError = () => {}
    s.on("error", onEarlyError)
    s.open((err) => {
      if (err) return reject(err)
      const handle = new StreamHandle(s, opts.path)
      s.removeListener("error", onEarlyError)
      resolve(handle)
    })
  })
}
