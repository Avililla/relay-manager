// One WebSocket peer (console or preview): JSON/binary sending with backpressure (§5.5), liveness and counters.
import { WS_CLOSE, WS_LIMITS, type WsServerMsg } from "@/lib/contracts/ws"
import { WS_REASON } from "@/lib/i18n/serial"

/** The part of `ws`'s WebSocket we use (a fake implements it in tests). */
export interface WsLike {
  readonly bufferedAmount: number
  readonly readyState: number
  send(data: Buffer | string, opts: { binary: boolean }, cb?: (err?: Error) => void): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
}

const OPEN = 1

/** Close reasons must fit in 123 UTF-8 bytes (RFC 6455); longer Spanish reasons are cut on a character boundary. */
export function closeReason(text: string): string {
  if (Buffer.byteLength(text) <= 123) return text
  let out = ""
  for (const ch of text) {
    if (Buffer.byteLength(out + ch + "…") > 123) break
    out += ch
  }
  return `${out}…`
}

type Limits = Pick<typeof WS_LIMITS, "sendHighWaterBytes" | "sendLowWaterBytes" | "slowConsumerBytes" | "slowConsumerGraceMs">

export class WsPeer {
  bytesOut = 0
  bytesIn = 0
  droppedTotal = 0
  private dropping = false
  private dropped = 0
  private slowSince: number | null = null
  private missedPongs = 0
  private closed = false
  private readonly now: () => number
  private readonly limits: Limits

  constructor(private readonly ws: WsLike, opts: { now?: () => number; limits?: Limits } = {}) {
    this.now = opts.now ?? Date.now
    this.limits = opts.limits ?? WS_LIMITS
  }

  get isClosed(): boolean { return this.closed || this.ws.readyState !== OPEN }

  sendJson(msg: WsServerMsg): void {
    if (this.isClosed) return
    try {
      this.ws.send(JSON.stringify(msg), { binary: false })
    } catch {
      /* socket going away */
    }
  }

  /** Live data is dropped (and counted) while more than 1 MiB is buffered; history is always sent. */
  sendBinary(chunk: Buffer, opts: { history?: boolean } = {}): void {
    if (this.isClosed) return
    if (!opts.history) {
      if (this.dropping) {
        if (this.ws.bufferedAmount < this.limits.sendLowWaterBytes) this.resume()
        else {
          this.dropped += chunk.length
          this.droppedTotal += chunk.length
          return
        }
      } else if (this.ws.bufferedAmount > this.limits.sendHighWaterBytes) {
        this.dropping = true
        this.dropped += chunk.length
        this.droppedTotal += chunk.length
        return
      }
    }
    try {
      this.ws.send(chunk, { binary: true })
      this.bytesOut += chunk.length
    } catch {
      /* socket going away */
    }
  }

  private resume(): void {
    this.dropping = false
    const n = this.dropped
    this.dropped = 0
    this.sendJson({ t: "gap", droppedBytes: n })
  }

  /** Periodic check (every ~250 ms): resume after draining, and close slow consumers (4008). */
  tick(): void {
    if (this.isClosed) return
    const buffered = this.ws.bufferedAmount
    if (this.dropping && buffered < this.limits.sendLowWaterBytes) this.resume()
    if (buffered > this.limits.slowConsumerBytes) {
      const t = this.now()
      if (this.slowSince === null) this.slowSince = t
      else if (t - this.slowSince >= this.limits.slowConsumerGraceMs) this.close(WS_CLOSE.SLOW_CONSUMER, WS_REASON.slow)
    } else {
      this.slowSince = null
    }
  }

  /** Protocol-level ping every 30 s; two missed pongs terminate the socket. */
  heartbeat(): void {
    if (this.isClosed) return
    if (this.missedPongs >= 2) {
      this.closed = true
      this.ws.terminate()
      return
    }
    this.missedPongs++
    try {
      this.ws.ping()
    } catch {
      /* ignore */
    }
  }

  pong(): void {
    this.missedPongs = 0
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close(code, closeReason(reason))
    } catch {
      this.ws.terminate()
    }
  }
}
