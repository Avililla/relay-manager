import { describe, expect, it } from "vitest"
import type { ExportJobDTO } from "@/lib/contracts/files"
import { appendLog, createExportStore } from "./export-store"

const job = (over: Partial<ExportJobDTO> = {}): ExportJobDTO => ({
  id: "a".repeat(32), app: "app_demo", version: "1.2.3", extract: false, dir: "", zipName: "app_demo-1.2.3_exports.zip",
  finalName: null, finalPath: null, sizeBytes: null, state: "running", queuePosition: null, exitCode: null, error: null,
  userId: "u1", userName: "ana", createdAt: "2026-10-05T10:00:00.000Z", startedAt: "2026-10-05T10:00:01.000Z", finishedAt: null,
  log: [], logDropped: 0, ...over,
})

function fakeFetch(routes: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: string | null }> = []
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null })
    const r = routes[`${method} ${url}`]?.(init) ?? { status: 404, body: {} }
    return new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe("appendLog", () => {
  it("keeps the last lines and counts the dropped ones", () => {
    expect(appendLog(["a"], 0, ["b", "c"], 2)).toEqual({ log: ["b", "c"], dropped: 1 })
    expect(appendLog(["a"], 5, [], 2)).toEqual({ log: ["a"], dropped: 5 })
  })
})

describe("export store", () => {
  it("syncs the jobs and the availability, then appends the lines of each event to the log", async () => {
    const { f } = fakeFetch({
      "GET /api/files/export": () => ({ status: 200, body: { jobs: [job({ log: ["Downloading tools..."] })], info: { available: true, problem: null, missingTools: [], timeoutMin: 60 } } }),
    })
    const s = createExportStore(f)
    await s.sync()
    expect(s.info()?.available).toBe(true)
    s.apply(job({ log: [] }), ["Checking connection with the repository..."])
    s.apply(job({ state: "done", finalName: "x.zip", finishedAt: "2026-10-05T10:01:00.000Z" }), ["All available exports packed successfully"])
    const [j] = s.snapshot()
    expect(j.state).toBe("done")
    expect(j.log).toEqual(["Downloading tools...", "Checking connection with the repository...", "All available exports packed successfully"])
    // A late "running" event never takes a finished job back, but its lines are kept.
    s.apply(job({ state: "running" }), ["tarde"])
    expect(s.snapshot()[0].state).toBe("done")
    expect(s.snapshot()[0].log.at(-1)).toBe("tarde")
  })

  it("starts a job (the JSON body as the API expects) and reports field errors", async () => {
    const { f, calls } = fakeFetch({
      "POST /api/files/export": (init) => {
        const b = JSON.parse(String(init?.body)) as { app: string }
        return b.app === "-x"
          ? { status: 400, body: { error: "INVALID", message: "No puede empezar por «-»", field: "app" } }
          : { status: 202, body: { job: job({ state: "queued", queuePosition: 1 }) } }
      },
    })
    const s = createExportStore(f)
    const ok = await s.start({ app: "app_demo", version: "1.2.3", extract: true, zipName: null, dir: "apps" })
    expect(ok.ok).toBe(true)
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ app: "app_demo", version: "1.2.3", extract: true, zipName: null, dir: "apps" })
    expect(s.snapshot()[0].queuePosition).toBe(1)
    const bad = await s.start({ app: "-x", version: "1", extract: false, zipName: null, dir: "" })
    expect(bad).toEqual({ ok: false, message: "No puede empezar por «-»", field: "app" })
  })

  it("cancels with DELETE /<id> and hides finished jobs locally", async () => {
    const { f, calls } = fakeFetch({ [`DELETE /api/files/export/${"a".repeat(32)}`]: () => ({ status: 204, body: {} }) })
    const s = createExportStore(f)
    s.apply(job())
    expect(await s.cancel("a".repeat(32))).toBeNull()
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `/api/files/export/${"a".repeat(32)}` })
    s.apply(job({ state: "canceled" }))
    s.clearFinished()
    expect(s.snapshot()).toEqual([])
  })
})
