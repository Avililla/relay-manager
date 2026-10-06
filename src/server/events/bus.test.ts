import { describe, expect, it, vi } from "vitest"
import { createEventBus } from "./bus"
import type { ServerEvent } from "@/lib/contracts/events"
import type { Logger } from "@/server/log"

const ev: ServerEvent = { type: "viewer.changed", userId: "u1" }

describe("event bus", () => {
  it("delivers synchronously and unsubscribes", () => {
    const bus = createEventBus()
    const got: string[] = []
    const off = bus.subscribe((e) => got.push(e.type))
    expect(bus.listenerCount()).toBe(1)
    bus.publish(ev, { kind: "user", userId: "u1" })
    expect(got).toEqual(["viewer.changed"])
    off()
    expect(bus.listenerCount()).toBe(0)
    bus.publish(ev, { kind: "all" })
    expect(got).toHaveLength(1)
  })
  it("passes the audience to listeners", () => {
    const bus = createEventBus()
    const fn = vi.fn()
    bus.subscribe(fn)
    bus.publish(ev, { kind: "admins" })
    expect(fn).toHaveBeenCalledWith(ev, { kind: "admins" })
  })
  it("isolates a throwing listener and logs it", () => {
    const error = vi.fn()
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error, child: () => log } as unknown as Logger
    const bus = createEventBus({ log })
    const after = vi.fn()
    bus.subscribe(() => { throw new Error("boom") })
    bus.subscribe(after)
    expect(() => bus.publish(ev, { kind: "all" })).not.toThrow()
    expect(after).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalled()
  })
  it("tolerates unsubscribing during delivery", () => {
    const bus = createEventBus()
    const calls: number[] = []
    const off1 = bus.subscribe(() => { calls.push(1); off1() })
    bus.subscribe(() => calls.push(2))
    bus.publish(ev, { kind: "all" })
    bus.publish(ev, { kind: "all" })
    expect(calls).toEqual([1, 2, 2])
  })
})
