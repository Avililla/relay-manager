import { describe, expect, it } from "vitest"
import { checkSessionUntilKnown, classifySessionResponse, SESSION_RETRY_MS } from "./session-check"

describe("session check after the event stream closes (EventsProvider)", () => {
  it("classifies: 200 with a user → signed-in; 200 with null or without user, or 401 → signed-out; anything else → unknown", () => {
    expect(classifySessionResponse(200, { user: { name: "ana" }, expires: "x" })).toBe("signed-in")
    expect(classifySessionResponse(200, null)).toBe("signed-out")
    expect(classifySessionResponse(200, {})).toBe("signed-out")
    expect(classifySessionResponse(401, null)).toBe("signed-out")
    expect(classifySessionResponse(500, null)).toBe("unknown")
    expect(classifySessionResponse(502, null)).toBe("unknown")
    expect(classifySessionResponse(503, { user: null })).toBe("unknown")
    expect(classifySessionResponse(404, null)).toBe("unknown")
  })

  const res = (status: number, body: unknown) => ({ status, json: async () => body })

  it("a 5xx or a network error is retried with backoff, never treated as signed out", async () => {
    const replies: Array<() => Promise<{ status: number; json(): Promise<unknown> }>> = [
      async () => res(502, null),
      async () => { throw new TypeError("Failed to fetch") },
      async () => res(200, "<html>"),        // not JSON-shaped: still unknown
      async () => res(200, { user: { name: "ana" } }),
    ]
    const waits: number[] = []
    const r = await checkSessionUntilKnown({
      fetchSession: () => (replies.shift() ?? (async () => res(500, null)))(),
      sleep: async (ms) => { waits.push(ms) },
      signal: new AbortController().signal,
    })
    expect(r).toBe("signed-in")
    expect(waits).toEqual(SESSION_RETRY_MS.slice(0, 3))
  })

  it("stops at the first definite answer: signed-out", async () => {
    let calls = 0
    const r = await checkSessionUntilKnown({
      fetchSession: async () => { calls++; return calls === 1 ? res(503, null) : res(200, null) },
      sleep: async () => undefined,
      signal: new AbortController().signal,
    })
    expect(r).toBe("signed-out")
    expect(calls).toBe(2)
  })

  it("gives up (unknown) after the last retry, and stops when aborted", async () => {
    let calls = 0
    const r = await checkSessionUntilKnown({ fetchSession: async () => { calls++; return res(500, null) }, sleep: async () => undefined, signal: new AbortController().signal })
    expect(r).toBe("unknown")
    expect(calls).toBe(SESSION_RETRY_MS.length + 1)
    const ac = new AbortController()
    let n = 0
    const aborted = await checkSessionUntilKnown({
      fetchSession: async () => { n++; if (n === 2) ac.abort(); return res(500, null) },
      sleep: async () => undefined,
      signal: ac.signal,
    })
    expect(aborted).toBe("aborted")
    expect(n).toBe(2)
  })
})
