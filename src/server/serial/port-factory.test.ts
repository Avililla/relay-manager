import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SerialPortMock } from "serialport"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import { createPortOpener, mapOpenError, openWithDeadline, type PortCtor, type PortHandle } from "./port-factory"

interface MockStream { port?: { recording: Buffer; openOptions: Record<string, unknown>; emitData(d: Buffer): void } ; close(cb: () => void): void }
let streams: MockStream[] = []
beforeEach(() => { SerialPortMock.binding.reset(); streams = [] })
afterEach(() => SerialPortMock.binding.reset())
const opener = () => createPortOpener(SerialPortMock as unknown as PortCtor, { onStream: (s) => streams.push(s as MockStream) })

describe("mapOpenError (§4.5)", () => {
  it("busy / permission / docker cgroup / missing / other", () => {
    expect(mapOpenError(new Error("Error: Resource temporarily unavailable Cannot lock port")).kind).toBe("busy")
    expect(mapOpenError(new Error("Port is locked cannot open")).kind).toBe("busy")
    expect(mapOpenError(Object.assign(new Error("Error: Permission denied, cannot open /dev/ttyUSB0"), { code: "EACCES" }))).toMatchObject({
      kind: "no-permission", detail: "Sin permiso: el usuario del servicio debe pertenecer al grupo dialout",
    })
    expect(mapOpenError(new Error("Error: Operation not permitted, cannot open /dev/ttyUSB0"))).toMatchObject({
      kind: "no-permission", detail: "Docker: faltan device_cgroup_rules c 188/166",
    })
    expect(mapOpenError(Object.assign(new Error("x"), { code: "ENOENT" })).kind).toBe("missing")
    expect(mapOpenError("boom")).toMatchObject({ kind: "error", detail: "No se pudo abrir el puerto: boom" })
  })
})

describe("createPortOpener", () => {
  it("maps line settings, lock and hupcl; data, write and BREAK go through", async () => {
    SerialPortMock.binding.createPort("/dev/ttyFAKE0", { record: true })
    const h = await opener()({ path: "/dev/ttyFAKE0", line: { ...DEFAULT_LINE, baudRate: 9600, dataBits: 7, parity: "even", stopBits: 2, flowControl: "rtscts" }, hupcl: false })
    expect(streams[0].port?.openOptions).toMatchObject({ baudRate: 9600, dataBits: 7, parity: "even", stopBits: 2, rtscts: true, xon: false, lock: true, hupcl: false })
    const got: string[] = []
    h.onData((b) => got.push(b.toString()))
    streams[0].port?.emitData(Buffer.from("Zynq> "))
    await new Promise((r) => setTimeout(r, 20))
    expect(got.join("")).toBe("Zynq> ")
    await h.write(Buffer.from("boot\r"))
    expect(streams[0].port?.recording.toString()).toBe("boot\r")
    await h.set({ brk: true })
    await h.set({ brk: false })
    await h.close()
    expect(h.isOpen()).toBe(false)
    await expect(h.write(Buffer.from("x"))).rejects.toThrow()
  })

  it("a second locked open fails with the lock error", async () => {
    SerialPortMock.binding.createPort("/dev/ttyFAKE1", { record: true })
    const a = await opener()({ path: "/dev/ttyFAKE1", line: DEFAULT_LINE, hupcl: false })
    await expect(opener()({ path: "/dev/ttyFAKE1", line: DEFAULT_LINE, hupcl: false })).rejects.toThrow(/locked/)
    await a.close()
  })

  it("reports an unexpected close once, never our own close", async () => {
    SerialPortMock.binding.createPort("/dev/ttyFAKE2", {})
    const h = await opener()({ path: "/dev/ttyFAKE2", line: DEFAULT_LINE, hupcl: false })
    const lost: Array<Error | null> = []
    h.onClose((e) => lost.push(e))
    await new Promise<void>((r) => streams[0].close(() => r()))     // closed under us
    await new Promise((r) => setTimeout(r, 20))
    expect(lost).toHaveLength(1)
    SerialPortMock.binding.createPort("/dev/ttyFAKE3", {})
    const h2 = await opener()({ path: "/dev/ttyFAKE3", line: DEFAULT_LINE, hupcl: false })
    const lost2: Array<Error | null> = []
    h2.onClose((e) => lost2.push(e))
    await h2.close()
    await new Promise((r) => setTimeout(r, 20))
    expect(lost2).toEqual([])
  })

  it("an open error rejects", async () => {
    await expect(opener()({ path: "/dev/ttyNOPE", line: DEFAULT_LINE, hupcl: false })).rejects.toThrow(/does not exist/)
  })
})

describe("openWithDeadline", () => {
  const opts = { path: "/dev/ttyHUNG", line: DEFAULT_LINE, hupcl: false }
  const fakeHandle = (closed: string[]): PortHandle => ({
    path: opts.path, isOpen: () => true, onData() {}, onClose() {}, write: async () => {}, set: async () => {},
    close: async () => { closed.push(opts.path) },
  })

  it("a hung open is rejected after the deadline (kind error); a handle that arrives later is closed at once", async () => {
    let late: (h: PortHandle) => void = () => {}
    const t0 = Date.now()
    const err = await openWithDeadline(() => new Promise<PortHandle>((r) => { late = r }), opts, 60).catch((e: unknown) => e)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50)
    expect(mapOpenError(err)).toMatchObject({ kind: "error", detail: "No se pudo abrir el puerto: Tiempo de espera agotado al abrir el puerto" })
    const closed: string[] = []
    late(fakeHandle(closed))
    await new Promise((r) => setTimeout(r, 10))
    expect(closed).toEqual([opts.path])
  })

  it("a handle or an error in time goes through untouched", async () => {
    const closed: string[] = []
    const h = fakeHandle(closed)
    expect(await openWithDeadline(async () => h, opts, 60)).toBe(h)
    await expect(openWithDeadline(async () => { throw new Error("Port is locked") }, opts, 60)).rejects.toThrow("Port is locked")
    await new Promise((r) => setTimeout(r, 80))
    expect(closed).toEqual([])
  })
})
