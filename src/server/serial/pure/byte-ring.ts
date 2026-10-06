// Fixed-size ring of raw bytes: the console history replayed to new WS sessions (§4.5).
export class ByteRing {
  private readonly buf: Buffer
  private start = 0
  private len = 0
  private wrapped = false

  constructor(readonly capacity: number) {
    this.buf = Buffer.alloc(Math.max(1, capacity))
  }

  get length(): number { return this.len }
  /** True once bytes were dropped because the ring was full (since the last clear). */
  get truncated(): boolean { return this.wrapped }

  push(chunk: Buffer): void {
    const cap = this.buf.length
    if (chunk.length >= cap) {
      chunk.copy(this.buf, 0, chunk.length - cap)
      this.start = 0
      if (this.len > 0 || chunk.length > cap) this.wrapped = true
      this.len = cap
      return
    }
    const overflow = this.len + chunk.length - cap
    if (overflow > 0) {
      this.start = (this.start + overflow) % cap
      this.len -= overflow
      this.wrapped = true
    }
    let end = (this.start + this.len) % cap
    let off = 0
    while (off < chunk.length) {
      const n = Math.min(chunk.length - off, cap - end)
      chunk.copy(this.buf, end, off, off + n)
      off += n
      end = (end + n) % cap
    }
    this.len += chunk.length
  }

  /** All bytes, oldest first. */
  snapshot(): Buffer {
    return this.tail(this.len)
  }

  /** The newest `n` bytes. */
  tail(n: number): Buffer {
    const cap = this.buf.length
    const take = Math.min(n, this.len)
    const from = (this.start + this.len - take) % cap
    if (from + take <= cap) return Buffer.from(this.buf.subarray(from, from + take))
    return Buffer.concat([this.buf.subarray(from, cap), this.buf.subarray(0, take - (cap - from))])
  }

  clear(): void {
    this.start = 0
    this.len = 0
    this.wrapped = false
  }
}
