import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { InputCapture } from "@/lib/contracts/enums"
import { withTempDir } from "../../../../test/helpers/temp"
import { CaptureWriter, type CaptureWriterOptions } from "./writer"

let tmp: { dir: string; cleanup: () => void }
let clock: Date
let writer: CaptureWriter | null = null
beforeEach(() => {
  tmp = withTempDir("rm-cap-")
  clock = new Date("2026-09-23T10:00:00.000Z")
})
afterEach(async () => {
  await writer?.close()
  writer = null
  tmp.cleanup()
})

const at = (iso: string) => { clock = new Date(iso) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function make(o: Partial<CaptureWriterOptions> & { mode?: InputCapture; maxBytes?: number; paused?: () => boolean } = {}): CaptureWriter {
  writer = new CaptureWriter({
    dir: path.join(tmp.dir, "c1"),
    meta: { consoleId: "c1", equipmentId: "e1", equipmentName: "Equipo A #07", key: "UART0", label: "UART0" },
    now: () => clock,
    maxFileBytes: () => o.maxBytes ?? 64 * 1024 * 1024,
    inputMode: () => o.mode ?? "markers",
    paused: o.paused ?? (() => false),
    burstMs: 50,
    ...o,
  })
  return writer
}

/** Capture file names of c1, oldest first (by rollover index, not lexically). */
function logs(): string[] {
  const idx = (n: string) => Number(/^\d{4}-\d{2}-\d{2}(?:\.(\d+))?\.log$/.exec(n)?.[1] ?? 0)
  return fs.readdirSync(path.join(tmp.dir, "c1")).filter((n) => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(n)).sort((a, b) => idx(a) - idx(b))
}
function read(name: string): string {
  return fs.readFileSync(path.join(tmp.dir, "c1", name), "utf8")
}
function body(name: string): string[] {
  return read(name).split("\n").filter((l) => !l.startsWith("# relay-manager captura v1"))
}

describe("CaptureWriter", () => {
  it("writes a header and meta.json, and timestamps each line with the time of its first byte", async () => {
    const w = make()
    w.writeRx(Buffer.from("U-Boot 2022.01\r\nCPU: Zynq\r\n"))
    at("2026-09-23T10:00:01.500Z")
    w.writeRx(Buffer.from("third"))
    await w.flush()
    const text = read("2026-09-23.log")
    expect(text.split("\n")[0]).toBe('# relay-manager captura v1 · equipo "Equipo A #07" (e1) · consola UART0 (c1)')
    expect(body("2026-09-23.log")).toEqual([
      "[2026-09-23T10:00:00.000Z] U-Boot 2022.01",
      "[2026-09-23T10:00:00.000Z] CPU: Zynq",
      "[2026-09-23T10:00:01.500Z] third",
    ])
    const meta = JSON.parse(fs.readFileSync(path.join(tmp.dir, "c1", "meta.json"), "utf8")) as Record<string, unknown>
    expect(meta).toMatchObject({ consoleId: "c1", equipmentId: "e1", equipmentName: "Equipo A #07", key: "UART0", label: "UART0" })
  })

  it("CRLF → LF (also split across chunks); a lone CR is kept; ANSI and invalid UTF-8 kept byte for byte", async () => {
    const w = make()
    w.writeRx(Buffer.from("Hit any key: 3\rHit any key: 2\r"))
    w.writeRx(Buffer.from("\nnext\x1b[0m \xff\xfe\r\n", "latin1"))
    await w.flush()
    const raw = fs.readFileSync(path.join(tmp.dir, "c1", "2026-09-23.log"))
    const lines = raw.toString("latin1").split("\n").slice(1)
    expect(lines[0]).toBe("[2026-09-23T10:00:00.000Z] Hit any key: 3\rHit any key: 2")
    expect(lines[1]).toBe("[2026-09-23T10:00:00.000Z] next\x1b[0m \xff\xfe")
  })

  it("partial lines across chunks keep the first byte's time", async () => {
    const w = make()
    w.writeRx(Buffer.from("hel"))
    at("2026-09-23T10:00:02.000Z")
    w.writeRx(Buffer.from("lo\r"))
    at("2026-09-23T10:00:03.000Z")
    w.writeRx(Buffer.from("\nnext\n"))
    await w.flush()
    expect(body("2026-09-23.log").slice(0, 2)).toEqual(["[2026-09-23T10:00:00.000Z] hello", "[2026-09-23T10:00:03.000Z] next"])
  })

  it("input markers (markers mode): one line per burst, never the typed text", async () => {
    const w = make({ mode: "markers" })
    w.writeRx(Buffer.from("login: "))
    w.writeInput("ingeniero", Buffer.from("ro"))
    w.writeInput("ingeniero", Buffer.from("ot\r"))
    await sleep(120)
    w.writeRx(Buffer.from("root\r\nPassword: "))
    w.writeInput("ingeniero", Buffer.from("secret\r"))
    await w.flush()
    const b = body("2026-09-23.log").join("\n")
    expect(b).toContain("[2026-09-23T10:00:00.000Z] >>> ingeniero: 5 bytes")
    expect(b).toContain("[2026-09-23T10:00:00.000Z] >>> ingeniero: 7 bytes")
    expect(b).not.toContain("secret")
    expect(fs.existsSync(path.join(tmp.dir, "c1", "2026-09-23.input.log"))).toBe(false)
    // the marker starts on a new line
    expect(body("2026-09-23.log")[0]).toBe("[2026-09-23T10:00:00.000Z] login: ")
  })

  it("full mode: the text goes only to .input.log (JSON-escaped); the main log gets the marker", async () => {
    const w = make({ mode: "full" })
    w.writeInput("ingeniero", Buffer.from("secret\r"))
    await w.flush()
    expect(read("2026-09-23.log")).not.toContain("secret")
    expect(read("2026-09-23.log")).toContain(">>> ingeniero: 7 bytes")
    expect(body("2026-09-23.input.log")).toContain('[2026-09-23T10:00:00.000Z] >>> ingeniero: "secret\\r"')
  })

  it("status markers start on a new line", async () => {
    const w = make()
    w.writeRx(Buffer.from("partial"))
    w.marker("puerto soltado por admin (hasta 10:35 UTC)")
    w.openMarker("/dev/ttyUSB2", "115200 8N1")
    await w.flush()
    expect(body("2026-09-23.log")).toEqual([
      "[2026-09-23T10:00:00.000Z] partial",
      "[2026-09-23T10:00:00.000Z] --- puerto soltado por admin (hasta 10:35 UTC) ---",
      "# 2026-09-23T10:00:00.000Z abierto /dev/ttyUSB2 115200 8N1",
      "",
    ])
  })

  it("size rollover continues in .1.log, .2.log and reports it", async () => {
    let rolled = 0
    const w = make({ maxBytes: 300, onRollover: () => { rolled++ } })
    for (let i = 0; i < 12; i++) w.writeRx(Buffer.from(`line ${i} ${"x".repeat(40)}\n`))
    await w.flush()
    const names = logs()
    expect(names).toContain("2026-09-23.log")
    expect(names).toContain("2026-09-23.1.log")
    expect(rolled).toBeGreaterThanOrEqual(1)
    expect(fs.statSync(path.join(tmp.dir, "c1", "2026-09-23.log")).size).toBeLessThan(420)
    expect(w.activeFiles()).toEqual([path.join(tmp.dir, "c1", names[names.length - 1])])
  })

  it("UTC day rollover at the first byte after midnight", async () => {
    at("2026-09-23T23:59:59.900Z")
    const w = make()
    w.writeRx(Buffer.from("before "))
    at("2026-09-24T00:00:00.100Z")
    w.writeRx(Buffer.from("after\n"))
    await w.flush()
    expect(body("2026-09-23.log")).toEqual(["[2026-09-23T23:59:59.900Z] before ", ""])
    expect(body("2026-09-24.log")[0]).toBe("[2026-09-24T00:00:00.100Z] after")
  })

  it("after a restart it appends to today's latest file", async () => {
    const w1 = make({ maxBytes: 200 })
    for (let i = 0; i < 6; i++) w1.writeRx(Buffer.from(`${"y".repeat(60)}\n`))
    await w1.close()
    const before = logs()
    const w2 = make({ maxBytes: 100_000 })
    w2.writeRx(Buffer.from("again\n"))
    await w2.flush()
    const after = logs()
    expect(after).toEqual(before)
    expect(read(before[before.length - 1])).toContain("again")
  })

  it("writes nothing while paused and marks the resume", async () => {
    let paused = true
    const w = make({ paused: () => paused })
    w.writeRx(Buffer.from("lost\n"))
    w.marker("puerto cerrado")
    await w.flush()
    expect(fs.existsSync(path.join(tmp.dir, "c1", "2026-09-23.log"))).toBe(false)
    paused = false
    w.writeRx(Buffer.from("kept\n"))
    await w.flush()
    const b = body("2026-09-23.log")
    expect(b[0]).toBe("[2026-09-23T10:00:00.000Z] --- captura reanudada (se perdieron datos por falta de espacio) ---")
    expect(b[1]).toBe("[2026-09-23T10:00:00.000Z] kept")
  })

  it("files are created with mode 0640 (umask permitting)", async () => {
    const old = process.umask(0o027)
    try {
      const w = make()
      w.writeRx(Buffer.from("x\n"))
      await w.flush()
      expect(fs.statSync(path.join(tmp.dir, "c1", "2026-09-23.log")).mode & 0o777).toBe(0o640)
    } finally {
      process.umask(old)
    }
  })
})
