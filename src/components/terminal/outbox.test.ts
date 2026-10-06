import { describe, expect, it } from "vitest"
import { takeFrame } from "./outbox"

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)

describe("terminal outbox frames", () => {
  it("returns null when nothing is pending", () => {
    expect(takeFrame([], 4)).toBeNull()
    const q = [new Uint8Array(0)]
    expect(takeFrame(q, 4)).toBeNull()
    expect(q).toHaveLength(0)
  })

  it("splits a large write into frames of at most max bytes (11 KiB → 4096/4096/3008)", () => {
    const q = [new Uint8Array(11200)]
    const sizes: number[] = []
    for (let f = takeFrame(q, 4096); f; f = takeFrame(q, 4096)) sizes.push(f.length)
    expect(sizes).toEqual([4096, 4096, 3008])
  })

  it("keeps order: keystrokes typed during a paced paste go out after it, never inside it", () => {
    const q = [bytes("AAAAAAAAAA")] // a paste, max 4 per frame
    expect(text(takeFrame(q, 4))).toBe("AAAA")
    q.push(bytes("x"), bytes("y")) // typed while the paste is going out
    expect(text(takeFrame(q, 4))).toBe("AAAA")
    expect(text(takeFrame(q, 4))).toBe("AAxy")
    expect(takeFrame(q, 4)).toBeNull()
  })

  it("a second paste queues behind the rest of the first instead of replacing it", () => {
    const q = [bytes("111111")]
    expect(text(takeFrame(q, 4))).toBe("1111")
    q.push(bytes("222222"))
    const out: string[] = []
    for (let f = takeFrame(q, 4); f; f = takeFrame(q, 4)) out.push(text(f) ?? "")
    expect(out.join("")).toBe("11222222")
    expect(out).toEqual(["1122", "2222"])
  })

  it("joins small writes up to max", () => {
    const q = [bytes("ab"), bytes("cd"), bytes("ef")]
    expect(text(takeFrame(q, 5))).toBe("abcde")
    expect(text(takeFrame(q, 5))).toBe("f")
  })
})
