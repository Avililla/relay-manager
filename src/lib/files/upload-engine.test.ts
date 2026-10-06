import { describe, expect, it } from "vitest"
import { createUploadEngine, nextChunkSize, speedOf, type UploadTransport, type TransportResult } from "./upload-engine"

const MiB = 1024 * 1024

describe("nextChunkSize", () => {
  it("aims at a few seconds per request within [256 KiB, max], growing at most 4× per step", () => {
    expect(nextChunkSize(4 * MiB, 4 * MiB, 400, 64 * MiB)).toBe(16 * MiB) // 10 MiB/s → 40 MiB wanted, capped at ×4
    expect(nextChunkSize(16 * MiB, 16 * MiB, 400, 64 * MiB)).toBe(64 * MiB)
    expect(nextChunkSize(64 * MiB, 64 * MiB, 60_000, 64 * MiB)).toBe(4_473_924) // slow link (~1 MiB/s): ~4 s of data
    expect(nextChunkSize(4 * MiB, 4 * MiB, 100_000, 64 * MiB)).toBe(256 * 1024) // ~40 KB/s
    expect(nextChunkSize(4 * MiB, 0, 0, 64 * MiB)).toBe(4 * MiB)
  })
})

describe("speedOf", () => {
  it("averages the last seconds of samples", () => {
    expect(speedOf([])).toBe(0)
    expect(speedOf([{ t: 0, bytes: 0 }, { t: 1000, bytes: 1000 }, { t: 2000, bytes: 3000 }])).toBe(1500)
  })
})

/** A scripted transport: records calls; `put` delivers the whole chunk (progress in two steps). */
function fakeTransport(script: { start?: (name: string) => TransportResult<{ id: string; chunkMaxBytes: number }>; put?: (id: string, offset: number, size: number) => TransportResult<{ received: number; done: boolean; name: string | null }> } = {}) {
  const calls: string[] = []
  const t: UploadTransport = {
    async start(input) {
      calls.push(`start ${input.name} ${input.size} ${input.conflict}${input.root === "tftp" ? "" : ` ${input.root}`}`)
      return script.start?.(input.name) ?? { ok: true, data: { id: `id-${input.name}`, chunkMaxBytes: 64 * MiB } }
    },
    put(id, offset, blob, onProgress) {
      calls.push(`put ${id} ${offset} ${blob.size}`)
      const r = script.put?.(id, offset, blob.size)
      return {
        promise: (async () => {
          onProgress(Math.floor(blob.size / 2))
          onProgress(blob.size)
          return r ?? { ok: true, data: { received: offset + blob.size, done: false, name: null } }
        })(),
        abort: () => { calls.push(`abort ${id}`) },
      }
    },
    async cancel(id) { calls.push(`cancel ${id}`) },
  }
  return { t, calls }
}

const file = (name: string, size: number) => ({ name, size, slice: (a: number, b: number) => ({ size: Math.max(0, Math.min(b, size) - a) }) })
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }

describe("createUploadEngine", () => {
  it("uploads each file in chunks, reports progress and the final name", async () => {
    let final = 0
    const { t, calls } = fakeTransport({
      put: (id, offset, size) => ({ ok: true, data: { received: offset + size, done: offset + size === 10 * MiB, name: offset + size === 10 * MiB ? "b (1).bin" : null } }),
    })
    const e = createUploadEngine(t, { concurrency: 2, initialChunk: 4 * MiB, onFinished: () => { final++ } })
    e.add([{ file: file("b.bin", 10 * MiB), dir: "sub", conflict: "rename" }])
    await settle()
    const [it] = e.snapshot()
    expect(it).toMatchObject({ status: "done", sent: 10 * MiB, total: 10 * MiB, finalName: "b (1).bin", dir: "sub" })
    expect(calls[0]).toBe("start b.bin 10485760 rename")
    expect(calls.filter((c) => c.startsWith("put")).length).toBeGreaterThanOrEqual(2)
    expect(final).toBe(1)
  })

  it("uploads to the root of each request (tftp when none is given)", async () => {
    const { t, calls } = fakeTransport({ put: (id, offset, size) => ({ ok: true, data: { received: offset + size, done: true, name: id.slice(3) } }) })
    const e = createUploadEngine(t, {})
    e.add([{ file: file("a.zip", 5), root: "extra", dir: "apps", conflict: "fail" }, { file: file("b.bin", 5), dir: "", conflict: "fail" }])
    await settle()
    expect(calls).toContain("start a.zip 5 fail extra")
    expect(calls).toContain("start b.bin 5 fail")
    expect(e.snapshot().map((i) => [i.name, i.root, i.status])).toEqual([["a.zip", "extra", "done"], ["b.bin", "tftp", "done"]])
  })

  it("sends an empty file as one empty chunk", async () => {
    const { t, calls } = fakeTransport({ put: () => ({ ok: true, data: { received: 0, done: true, name: "vacío" } }) })
    const e = createUploadEngine(t, {})
    e.add([{ file: file("vacío", 0), dir: "", conflict: "fail" }])
    await settle()
    expect(e.snapshot()[0].status).toBe("done")
    expect(calls).toEqual(["start vacío 0 fail", "put id-vacío 0 0"])
  })

  it("marks a name clash as a conflict the user can resolve (then uploads with the chosen mode)", async () => {
    let first = true
    const { t, calls } = fakeTransport({
      start: () => {
        if (first) {
          first = false
          return { ok: false, status: 409, error: "EXISTS", message: "Ya existe «a.txt» en esta carpeta." }
        }
        return { ok: true, data: { id: "id-a", chunkMaxBytes: 64 * MiB } }
      },
      put: () => ({ ok: true, data: { received: 3, done: true, name: "a.txt" } }),
    })
    const e = createUploadEngine(t, {})
    e.add([{ file: file("a.txt", 3), dir: "", conflict: "fail" }])
    await settle()
    const [it] = e.snapshot()
    expect(it).toMatchObject({ status: "conflict", error: "Ya existe «a.txt» en esta carpeta." })
    e.resolveConflict(it.key, "overwrite")
    await settle()
    expect(e.snapshot()[0].status).toBe("done")
    expect(calls).toContain("start a.txt 3 overwrite")
  })

  it("resumes from the server offset after a lost chunk and retries network errors", async () => {
    let n = 0
    const { t } = fakeTransport({
      put: (_id, offset, size) => {
        n++
        if (n === 1) return { ok: false, status: 0, error: "NETWORK", message: "red" }
        if (n === 2) return { ok: false, status: 409, error: "OFFSET", message: "", extra: { received: 0 } }
        return { ok: true, data: { received: offset + size, done: true, name: "x" } }
      },
    })
    const e = createUploadEngine(t, { retryDelaysMs: [0, 0, 0] })
    e.add([{ file: file("x", 100), dir: "", conflict: "fail" }])
    await settle()
    expect(e.snapshot()[0].status).toBe("done")
  })

  it("stops on server errors with the Spanish message; retry starts again; cancel aborts and tells the server", async () => {
    let fail = true
    const { t, calls } = fakeTransport({
      put: (_i, offset, size) => (fail ? { ok: false, status: 507, error: "NO_SPACE", message: "No hay espacio en el disco del servidor." } : { ok: true, data: { received: offset + size, done: true, name: "y" } }),
    })
    const e = createUploadEngine(t, { retryDelaysMs: [0] })
    e.add([{ file: file("y", 10), dir: "", conflict: "fail" }])
    await settle()
    expect(e.snapshot()[0]).toMatchObject({ status: "error", error: "No hay espacio en el disco del servidor." })
    fail = false
    e.retry(e.snapshot()[0].key)
    await settle()
    expect(e.snapshot()[0].status).toBe("done")
    // Cancel while queued (concurrency 0 keeps it waiting).
    const e2 = createUploadEngine(t, { concurrency: 1 })
    e2.add([{ file: file("z1", 10), dir: "", conflict: "fail" }, { file: file("z2", 10), dir: "", conflict: "fail" }])
    e2.cancel(e2.snapshot()[1].key)
    await settle()
    expect(e2.snapshot().map((i) => i.status)).toEqual(["done", "canceled"])
    expect(calls.filter((c) => c.includes("z2"))).toEqual([])
  })

  it("refuses files over the limit and bad names without contacting the server", async () => {
    const { t, calls } = fakeTransport()
    const e = createUploadEngine(t, { maxBytes: 100 })
    e.add([{ file: file("grande", 101), dir: "", conflict: "fail" }, { file: file("a\\b", 1), dir: "", conflict: "fail" }])
    await settle()
    expect(e.snapshot().map((i) => i.status)).toEqual(["error", "error"])
    expect(e.snapshot()[0].error).toMatch(/máximo/)
    expect(calls).toEqual([])
    e.clearFinished()
    expect(e.snapshot()).toEqual([])
  })
})
