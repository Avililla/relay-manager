import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createNullLogger } from "@/server/log"
import { withTempDir } from "../../../../test/helpers/temp"
import { fakeAudit, fakeSettings } from "../../../../test/helpers/fakes"
import { createCaptureService, type CaptureService } from "./service"

const GiB = 1024 ** 3
let tmp: { dir: string; cleanup: () => void }
let svc: CaptureService | null = null
beforeEach(() => { tmp = withTempDir("rm-capsvc-") })
afterEach(async () => { await svc?.stop(); svc = null; tmp.cleanup() })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const meta = (id: string) => ({ consoleId: id, equipmentId: "e1", equipmentName: "Equipo A #01", key: "UART0", label: "UART0" })

function make(o: Partial<Parameters<typeof createCaptureService>[0]> = {}) {
  const audit = fakeAudit()
  let free = 100 * GiB
  svc = createCaptureService({
    captureDir: tmp.dir, enabled: true, settings: fakeSettings(), audit, log: createNullLogger(),
    statfs: async () => ({ bsize: 4096, bavail: Math.floor(free / 4096), blocks: Math.floor(200 * GiB / 4096) }),
    ...o,
  })
  return { svc, audit, setFree: (b: number) => { free = b } }
}

describe("capture service", () => {
  it("writes per console, lists files (input only for admins) and validates download names", async () => {
    const { svc } = make({ settings: fakeSettings({ inputCapture: "full" }) })
    await svc.start()
    const w = svc.writer(meta("c1"), true)
    w.writeRx(Buffer.from("hola\n"))
    w.writeInput("admin", Buffer.from("pw\r"))
    await w.flush()
    const today = new Date().toISOString().slice(0, 10)
    expect((await svc.list("c1", false)).map((f) => f.name)).toEqual([`${today}.log`])
    expect((await svc.list("c1", true)).map((f) => f.name).sort()).toEqual([`${today}.input.log`, `${today}.log`])
    expect(svc.filePath("c1", `${today}.log`)).toBe(path.join(tmp.dir, "c1", `${today}.log`))
    expect(svc.filePath("c1", "../../etc/passwd")).toBeNull()
    expect(svc.filePath("c1", "meta.json")).toBeNull()
    expect(svc.filePath("c1", "2020-01-01.log")).toBeNull()
    expect(svc.filePath("../c1", `${today}.log`)).toBeNull()
    expect(svc.totalBytes()).toBeGreaterThan(0)
  })

  it("runs retention after a size rollover and audits the purge", async () => {
    const { svc, audit } = make({ maxFileBytes: () => 400, maxTotalBytes: () => 1000 })
    await svc.start()
    const w = svc.writer(meta("c1"), true)
    for (let i = 0; i < 40; i++) w.writeRx(Buffer.from(`${"z".repeat(60)}\n`))
    await w.flush()
    await sleep(300)
    await svc.idle()
    const files = fs.readdirSync(path.join(tmp.dir, "c1")).filter((n) => n.endsWith(".log"))
    const total = files.reduce((s, n) => s + fs.statSync(path.join(tmp.dir, "c1", n)).size, 0)
    expect(total).toBeLessThanOrEqual(1000 + 500)
    expect(audit.inputs.some((i) => i.action === "console.capture.purge")).toBe(true)
    expect(svc.lastPurgeAt()).not.toBeNull()
  })

  it("disk guard pauses and resumes with hysteresis, and reports the state", async () => {
    const { svc, setFree } = make()
    const states: string[] = []
    svc.onStateChange((s) => states.push(s))
    await svc.start()
    expect(svc.state()).toBe("on")
    setFree(1 * GiB)                                        // 200 GiB fs → pauseBelow 4 GiB
    await svc.checkDisk()
    expect(svc.state()).toBe("paused-disk")
    expect(svc.consoleState(true)).toBe("paused-disk")
    const w = svc.writer(meta("c2"), true)
    w.writeRx(Buffer.from("lost\n"))
    await w.flush()
    expect(fs.existsSync(path.join(tmp.dir, "c2"))).toBe(false)
    setFree(4.5 * GiB)
    await svc.checkDisk()
    expect(svc.state()).toBe("paused-disk")
    setFree(6 * GiB)
    await svc.checkDisk()
    expect(svc.state()).toBe("on")
    expect(states).toEqual(["paused-disk", "on"])
  })

  it("RM_CAPTURE_ENABLED=0 → off; captureToDisk=false → disabled; no files", async () => {
    const off = make({ enabled: false }).svc
    await off.start()
    expect(off.state()).toBe("off")
    expect(off.consoleState(true)).toBe("off")
    const w = off.writer(meta("c3"), true)
    w.writeRx(Buffer.from("x\n"))
    await w.flush()
    expect(fs.existsSync(path.join(tmp.dir, "c3"))).toBe(false)
    await off.stop()
    const on = make().svc
    await on.start()
    expect(on.consoleState(false)).toBe("disabled")
    const w2 = on.writer(meta("c4"), false)
    w2.writeRx(Buffer.from("x\n"))
    await w2.flush()
    expect(fs.existsSync(path.join(tmp.dir, "c4"))).toBe(false)
  })
})
