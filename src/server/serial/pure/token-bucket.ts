// Input rate limit per WS session (64 KiB/s, §4.5 write path).
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(private readonly capacity: number, private readonly perSecond: number, private readonly now: () => number = Date.now) {
    this.tokens = capacity
    this.last = now()
  }

  take(n: number): boolean {
    const t = this.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSecond)
    this.last = t
    if (n > this.tokens) return false
    this.tokens -= n
    return true
  }
}
