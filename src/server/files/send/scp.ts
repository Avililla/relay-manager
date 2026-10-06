// The source side of the scp protocol ("scp -t <dir>" on the equipment is the sink), for equipment whose SSH server has
// no SFTP subsystem (dropbear without sftp-server). One regular file per call:
//
//   sink → \0                                   ready
//   us   → "C0644 <size> <name>\n"               then wait for the ack
//   us   → <size bytes> "\0"                     then wait for the ack
//   us   → EOF                                   the sink exits
//
// An ack is one byte: 0 = ok, 1 = warning + message line, 2 = fatal + message line (both are errors for us: OpenSSH's
// sink reports a failed write — disk full, permissions — as a 1 after reading the data).
import type { Duplex } from "node:stream"

export class ScpError extends Error {
  constructor(message: string, readonly remote: string | null, readonly fatal: boolean) {
    super(message)
    this.name = "ScpError"
  }
}

export class ScpAborted extends Error {
  constructor() {
    super("aborted")
    this.name = "ScpAborted"
  }
}

const MAX_LINE = 4096

/** Reads acks from the sink's stdout: one pending reader at a time. */
class AckReader {
  private buf = Buffer.alloc(0)
  private waiter: { resolve: () => void; reject: (e: Error) => void } | null = null
  private ended: Error | null = null
  /** An unsolicited error (the sink gave up while we were still sending data). */
  early: ScpError | null = null

  constructor(private readonly ch: Duplex) {
    ch.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d])
      if (this.buf.length > MAX_LINE * 4) this.buf = this.buf.subarray(this.buf.length - MAX_LINE * 4)
      this.pump()
    })
    const gone = () => {
      this.ended ??= new ScpError("El equipo ha cerrado la conexión de scp antes de terminar.", null, true)
      this.pump()
    }
    ch.on("end", gone)
    ch.on("close", gone)
    ch.on("error", (e: Error) => {
      this.ended ??= new ScpError(e.message, null, true)
      this.pump()
    })
  }

  /** One complete ack from the buffer, or null if more bytes are needed. */
  private take(): { ok: true } | { ok: false; err: ScpError } | null {
    if (!this.buf.length) return null
    const code = this.buf[0]
    if (code === 0) {
      this.buf = this.buf.subarray(1)
      return { ok: true }
    }
    if (code === 1 || code === 2) {
      const nl = this.buf.indexOf(0x0a, 1)
      if (nl < 0) {
        if (this.buf.length > MAX_LINE) {
          const msg = this.buf.subarray(1, MAX_LINE).toString("utf8")
          this.buf = Buffer.alloc(0)
          return { ok: false, err: new ScpError(msg, msg, code === 2) }
        }
        return null
      }
      const msg = this.buf.subarray(1, nl).toString("utf8").trim()
      this.buf = this.buf.subarray(nl + 1)
      return { ok: false, err: new ScpError(msg, msg, code === 2) }
    }
    // Anything else: the remote side is not an scp sink (a shell banner, "scp: not found" on stdout…).
    const line = this.buf.toString("utf8").split("\n")[0]?.slice(0, 200) ?? ""
    this.buf = Buffer.alloc(0)
    return { ok: false, err: new ScpError(`Respuesta inesperada de scp en el equipo: «${line.trim()}»`, line.trim(), true) }
  }

  private pump(): void {
    const w = this.waiter
    if (!w) {
      // Nobody waiting: an ok byte stays for the next wait(); an error is remembered (the sink gave up early).
      if (!this.early && this.buf.length && this.buf[0] !== 0) {
        const r = this.take()
        if (r && !r.ok) this.early = r.err
      }
      return
    }
    const r = this.take()
    if (r) {
      this.waiter = null
      if (r.ok) w.resolve()
      else w.reject(r.err)
      return
    }
    if (this.ended) {
      this.waiter = null
      w.reject(this.ended)
    }
  }

  wait(): Promise<void> {
    if (this.early) return Promise.reject(this.early)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
      this.pump()
    })
  }
}

/** Waits for "drain" (backpressure), failing if the channel closes or errors first; leaves no listener behind. */
function drained(ch: Duplex, closedError: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null) => {
      ch.off("drain", onDrain)
      ch.off("close", onClose)
      ch.off("error", onError)
      if (err) reject(err)
      else resolve()
    }
    const onDrain = () => done(null)
    const onClose = () => done(closedError())
    const onError = (e: Error) => done(e)
    ch.on("drain", onDrain)
    ch.on("close", onClose)
    ch.on("error", onError)
  })
}

export interface ScpSendOptions {
  /** Name of the file in the sink's folder (no "/", no newline: the caller checks). */
  name: string
  size: number
  /** 0o644 / 0o755. */
  mode: number
  data: AsyncIterable<Buffer>
  /** Bytes handed to the channel so far (the SSH window applies backpressure). */
  onProgress?: (sent: number) => void
  signal?: AbortSignal
}

/**
 * Sends one file to an scp sink over `ch` (the exec channel of "scp -t <dir>"). Resolves when the sink acknowledged the
 * data; ends the channel's input either way. Throws ScpError (the sink's message) or ScpAborted.
 */
export async function scpSend(ch: Duplex, o: ScpSendOptions): Promise<void> {
  if (/[\n\r/\0]/.test(o.name)) throw new ScpError("Nombre de archivo no válido para scp.", null, true)
  const acks = new AckReader(ch)
  let aborted = false
  const onAbort = () => {
    aborted = true
    ch.destroy()
  }
  if (o.signal?.aborted) throw new ScpAborted()
  o.signal?.addEventListener("abort", onAbort, { once: true })
  const check = () => {
    if (aborted) throw new ScpAborted()
  }
  try {
    await acks.wait().catch((e: unknown) => { check(); throw e })
    check()
    ch.write(`C${(o.mode & 0o7777).toString(8).padStart(4, "0")} ${o.size} ${o.name}\n`)
    await acks.wait().catch((e: unknown) => { check(); throw e })
    let sent = 0
    for await (const chunk of o.data) {
      check()
      if (acks.early) throw acks.early
      if (sent + chunk.length > o.size) throw new ScpError("El archivo ha crecido mientras se enviaba.", null, true)
      sent += chunk.length
      if (!ch.write(chunk)) await drained(ch, () => acks.early ?? new ScpError("El equipo ha cerrado la conexión de scp durante el envío.", null, true))
      o.onProgress?.(sent)
    }
    check()
    if (sent !== o.size) throw new ScpError("El archivo ha cambiado de tamaño mientras se enviaba.", null, true)
    ch.write(Buffer.from([0]))
    await acks.wait().catch((e: unknown) => { check(); throw e })
    ch.end()
  } catch (e) {
    if (aborted || e instanceof ScpAborted) throw new ScpAborted()
    try { ch.end() } catch { /* already gone */ }
    throw e
  } finally {
    o.signal?.removeEventListener("abort", onAbort)
  }
}
