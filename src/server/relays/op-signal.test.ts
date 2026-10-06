import { getEventListeners } from "node:events"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { opSignal, withOpSignal } from "./op-signal"

const abortListeners = (s: AbortSignal) => getEventListeners(s, "abort").length

describe("opSignal", () => {
  it("detaches from the parent when disposed (nothing accumulates on a long-lived signal)", async () => {
    const life = new AbortController()
    for (let i = 0; i < 1000; i++) await withOpSignal(life.signal, 60_000, async (s) => { expect(s.aborted).toBe(false) })
    expect(abortListeners(life.signal)).toBe(0)
    const op = opSignal(life.signal, 60_000)
    expect(abortListeners(life.signal)).toBe(1)
    op.dispose()
    op.dispose()
    expect(abortListeners(life.signal)).toBe(0)
  })

  it("detaches even when the operation throws", async () => {
    const life = new AbortController()
    await expect(withOpSignal(life.signal, 60_000, async () => { throw new Error("x") })).rejects.toThrow("x")
    expect(abortListeners(life.signal)).toBe(0)
  })

  it("aborts with a TimeoutError after the deadline, and detaches", async () => {
    const life = new AbortController()
    const op = opSignal(life.signal, 10)
    await new Promise((r) => setTimeout(r, 40))
    expect(op.signal.aborted).toBe(true)
    expect((op.signal.reason as Error).name).toBe("TimeoutError")
    expect(abortListeners(life.signal)).toBe(0)
  })

  it("follows the parent's abort with the same reason; an already aborted parent gives an aborted signal", () => {
    const life = new AbortController()
    const op = opSignal(life.signal, 60_000)
    const reason = new Error("parada")
    life.abort(reason)
    expect(op.signal.aborted).toBe(true)
    expect(op.signal.reason).toBe(reason)
    const late = opSignal(life.signal, 60_000)
    expect(late.signal.aborted).toBe(true)
    expect(late.signal.reason).toBe(reason)
  })
})

describe("relay code never builds composite signals", () => {
  // AbortSignal.any with a process-lifetime signal leaks one composite per call on Node 22 (see op-signal.ts).
  it("no AbortSignal.any( in src/server/relays (non-test files)", () => {
    const root = path.dirname(new URL(import.meta.url).pathname)
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && p !== path.join(root, "op-signal.ts")) {
          if (/AbortSignal\.any\s*\(/.test(readFileSync(p, "utf8"))) offenders.push(path.relative(root, p))
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
