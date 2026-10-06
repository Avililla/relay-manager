import { describe, expect, it } from "vitest"
import { ByteRing } from "./byte-ring"
import { LineTracker } from "./line-tracker"
import { TokenBucket } from "./token-bucket"

describe("ByteRing", () => {
  it("keeps the newest bytes and reports truncation", () => {
    const r = new ByteRing(8)
    r.push(Buffer.from("abc"))
    r.push(Buffer.from("defg"))
    expect(r.snapshot().toString()).toBe("abcdefg")
    expect(r.truncated).toBe(false)
    r.push(Buffer.from("hij"))
    expect(r.snapshot().toString()).toBe("cdefghij")
    expect(r.truncated).toBe(true)
    expect(r.tail(3).toString()).toBe("hij")
    r.push(Buffer.from("0123456789"))
    expect(r.snapshot().toString()).toBe("23456789")
    r.clear()
    expect(r.length).toBe(0)
    expect(r.truncated).toBe(false)
  })
  it("wraps correctly across many small pushes", () => {
    const r = new ByteRing(5)
    let all = ""
    for (let i = 0; i < 37; i++) {
      const s = String.fromCharCode(97 + (i % 26))
      all += s
      r.push(Buffer.from(s))
    }
    expect(r.snapshot().toString()).toBe(all.slice(-5))
  })
})

describe("LineTracker", () => {
  it("strips ANSI split across chunks and keeps the prompt as the current line", () => {
    const t = new LineTracker()
    t.push(Buffer.from("U-Boot 2022.01\r\n\x1b[1;3"))
    t.push(Buffer.from("2mroot@placa\x1b[0m:~# "))
    expect(t.lastLine()).toBe("root@placa:~#")
  })
  it("a CR overwrites (countdowns); empty lines keep the last text; UTF-8 split across chunks", () => {
    const t = new LineTracker()
    t.push(Buffer.from("Hit any key: 3\rHit any key: 2"))
    expect(t.lastLine()).toBe("Hit any key: 2")
    t.push(Buffer.from("\r\n\r\n"))
    expect(t.lastLine()).toBe("Hit any key: 2")
    const e = Buffer.from("señal ó")
    t.push(e.subarray(0, 3))
    t.push(e.subarray(3))
    expect(t.lastLine()).toBe("señal ó")
  })
  it("caps at 160 characters and drops control characters and OSC sequences", () => {
    const t = new LineTracker()
    t.push(Buffer.from(`\x1b]0;title\x07${"x".repeat(300)}\x07\n`))
    expect(t.lastLine()).toBe("x".repeat(160))
  })
})

describe("TokenBucket", () => {
  it("allows the capacity at once and refills per second", () => {
    let now = 0
    const b = new TokenBucket(100, 100, () => now)
    expect(b.take(60)).toBe(true)
    expect(b.take(60)).toBe(false)
    now = 500
    expect(b.take(60)).toBe(true)
    expect(b.take(100)).toBe(false)
  })
})
