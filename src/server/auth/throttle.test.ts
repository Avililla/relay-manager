import { describe, expect, it } from "vitest"
import { createLoginThrottle } from "./throttle"

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe("login throttle", () => {
  it("blocks (ip, username) after 5 failures in 5 min, for 5 min", () => {
    const c = clock()
    const th = createLoginThrottle({ now: c.now })
    for (let i = 0; i < 5; i++) expect(th.begin("1.1.1.1", "ana").blocked).toBe(false)
    const b = th.begin("1.1.1.1", "ana")
    expect(b.blocked).toBe(true)
    if (b.blocked) expect(b.retryAfterSec).toBeGreaterThan(290)
    // other username from the same IP is not blocked by the pair window
    expect(th.begin("1.1.1.1", "luis").blocked).toBe(false)
    // other IP for the same username is not blocked either
    expect(th.begin("2.2.2.2", "ana").blocked).toBe(false)
    c.advance(5 * 60_000 + 1)
    expect(th.begin("1.1.1.1", "ana").blocked).toBe(false)
  })

  it("failures older than the 5 min window do not count", () => {
    const c = clock()
    const th = createLoginThrottle({ now: c.now })
    for (let i = 0; i < 4; i++) th.begin("1.1.1.1", "ana")
    c.advance(5 * 60_000 + 1)
    for (let i = 0; i < 4; i++) expect(th.begin("1.1.1.1", "ana").blocked).toBe(false)
    expect(th.begin("1.1.1.1", "ana").blocked).toBe(false)
  })

  it("success removes the pending failure and clears the pair window", () => {
    const c = clock()
    const th = createLoginThrottle({ now: c.now })
    for (let i = 0; i < 4; i++) th.begin("1.1.1.1", "ana")
    const r = th.begin("1.1.1.1", "ana")
    expect(r.blocked).toBe(false)
    if (!r.blocked) th.success("1.1.1.1", "ana", r.ticket)
    for (let i = 0; i < 5; i++) expect(th.begin("1.1.1.1", "ana").blocked).toBe(false)
  })

  it("blocks an IP after 20 failures in 5 min, for 15 min", () => {
    const c = clock()
    const th = createLoginThrottle({ now: c.now })
    for (let i = 0; i < 20; i++) expect(th.begin("3.3.3.3", `u${i}`).blocked).toBe(false)
    const b = th.begin("3.3.3.3", "otro")
    expect(b.blocked).toBe(true)
    if (b.blocked) expect(b.retryAfterSec).toBeGreaterThan(14 * 60)
    c.advance(10 * 60_000)
    expect(th.begin("3.3.3.3", "otro").blocked).toBe(true)
    c.advance(5 * 60_000 + 1)
    expect(th.begin("3.3.3.3", "otro").blocked).toBe(false)
  })

  it("N parallel attempts give at most the window's allowance", () => {
    const th = createLoginThrottle({ now: clock().now })
    const results = Array.from({ length: 12 }, () => th.begin("4.4.4.4", "ana"))
    expect(results.filter((r) => !r.blocked)).toHaveLength(5)
  })

  it("setup attempts: 10 per IP per 10 min and 30 globally", () => {
    const c = clock()
    const th = createLoginThrottle({ now: c.now })
    for (let i = 0; i < 10; i++) expect(th.setupAttempt("5.5.5.5")).toBe(true)
    expect(th.setupAttempt("5.5.5.5")).toBe(false)
    for (let i = 0; i < 10; i++) expect(th.setupAttempt("6.6.6.6")).toBe(true)
    for (let i = 0; i < 10; i++) expect(th.setupAttempt("7.7.7.7")).toBe(true)
    expect(th.setupAttempt("8.8.8.8")).toBe(false) // global window exhausted
    c.advance(10 * 60_000 + 1)
    expect(th.setupAttempt("8.8.8.8")).toBe(true)
    expect(th.setupAttempt("5.5.5.5")).toBe(true)
  })

  it("shouldAuditThrottled is true at most once per block window", () => {
    const c = clock()
    const th = createLoginThrottle({ now: c.now })
    for (let i = 0; i < 6; i++) th.begin("1.1.1.1", "ana")
    expect(th.shouldAuditThrottled("1.1.1.1", "ana")).toBe(true)
    expect(th.shouldAuditThrottled("1.1.1.1", "ana")).toBe(false)
    c.advance(60_000)
    expect(th.shouldAuditThrottled("1.1.1.1", "ana")).toBe(false)
    c.advance(4 * 60_000 + 1)
    for (let i = 0; i < 6; i++) th.begin("1.1.1.1", "ana")
    expect(th.shouldAuditThrottled("1.1.1.1", "ana")).toBe(true)
  })

  it("shouldAuditThrottled for an unblocked key allows one per minute", () => {
    const c = clock()
    const th = createLoginThrottle({ now: c.now })
    expect(th.shouldAuditThrottled("1.1.1.1", "#setup")).toBe(true)
    expect(th.shouldAuditThrottled("1.1.1.1", "#setup")).toBe(false)
    c.advance(60_001)
    expect(th.shouldAuditThrottled("1.1.1.1", "#setup")).toBe(true)
  })
})
