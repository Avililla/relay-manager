import { describe, expect, it } from "vitest"
import { RelayDriverError } from "../types"
import { fingerprintDsModel, modelByModuleId, modelByName } from "./models"
import { extractTitle, extractToggleVar, isDsIndexXml, parseGrReply, parseIndexXml, parseSrReply, parseStReply, xmlTags } from "./ds"
import { outputsLength, parseModuleInfo, parseOutputs, pulseUnits } from "./eth"

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
function dsXml(relays: boolean[], io: string[]): string {
  const r = range(32).map((i) => `<Rly${i}>${relays[i - 1] ? 1 : 0}</Rly${i}>`).join("")
  return `<response>${r}${io.map((t) => `<${t}>0</${t}>`).join("")}<PingTime1>0</PingTime1></response>`
}
// Tag sets of the stock index.xml per model (devantech report §4.3; same as the simulator).
const TAGS: Record<string, string[]> = {
  dS1242: ["AD1", "AD2", "IO1", "IO2", "IO3", "IO4"],
  dS2242: ["AD1", "AD2", "AD3", "AD4", "IO1", "IO2", "IO3", "IO4"],
  dS3484: ["AD1", "AD2", "AD3", "AD4", ...range(8).map((i) => `IO${i}`)],
  TCP184: range(8).flatMap((i) => [`IO${i}`, `IO${i}_s`]),
  dS378: range(7).flatMap((i) => [`IO${i}`, `IO${i}_s`]),
  dS2408: range(40).map((i) => `IO${i}`),
  dS2824: range(8).flatMap((i) => [`IO${i}`, `IO${i}_s`]),
  dS2832: range(8).flatMap((i) => [`IO${i}`, `IO${i}_s`]),
}

describe("model tables", () => {
  it("maps every module id to its model and physical relay count (D4)", () => {
    const expected: Array<[number, string, number]> = [
      [31, "dS1242", 2], [32, "dS2242", 2], [30, "dS3484", 4], [36, "TCP184", 4], [35, "dS378", 8], [47, "dS2408", 8],
      [34, "dS2824", 24], [42, "dS2832", 32], [18, "ETH002", 2], [19, "ETH008", 8], [20, "ETH484", 4], [21, "ETH8020", 20],
    ]
    for (const [id, model, relays] of expected) {
      expect(modelByModuleId(id)).toMatchObject({ model, relays, moduleId: id })
      expect(modelByName(model.toLowerCase())).toMatchObject({ model, relays })
    }
    expect(modelByModuleId(99)).toBeNull()
    expect(modelByName("dS9999")).toBeNull()
  })

  it("fingerprints all 8 dS tag sets from /index.xml", () => {
    const expected: Record<string, string[]> = {
      dS1242: ["dS1242"], dS2242: ["dS2242"], dS3484: ["dS3484"], dS378: ["dS378"], dS2408: ["dS2408"],
      TCP184: ["dS2824", "dS2832", "TCP184"], dS2824: ["dS2824", "dS2832", "TCP184"], dS2832: ["dS2824", "dS2832", "TCP184"],
    }
    for (const [model, tags] of Object.entries(TAGS)) {
      expect(fingerprintDsModel(xmlTags(dsXml([], tags))), model).toEqual(expected[model])
    }
    expect(fingerprintDsModel(new Set(["Rly1"]))).toEqual([])
  })
})

describe("dS /index.xml", () => {
  it("is recognised only with <response> and a binary <Rly1>", () => {
    expect(isDsIndexXml(dsXml([], TAGS.dS378))).toBe(true)
    expect(isDsIndexXml("<html><body>You do not have permission to view this page</body></html>")).toBe(false)
    expect(isDsIndexXml("<response><Rly1>on</Rly1></response>")).toBe(false)
  })

  it("parses exactly relayCount states (index 0 = channel 1), ignoring the 24 virtual relays", () => {
    const states = [true, false, true, false, false, false, false, true]
    expect(parseIndexXml(dsXml(states, TAGS.dS378), 8)).toEqual(states)
  })

  it("is strict: a missing RlyN tag or a missing <response> root is a protocol error", () => {
    const body = dsXml([true], TAGS.dS378).replace("<Rly5>0</Rly5>", "")
    expect(() => parseIndexXml(body, 8)).toThrow(RelayDriverError)
    try { parseIndexXml(body, 8) } catch (e) {
      expect(e).toMatchObject({ kind: "protocol", message: "Respuesta no reconocida: ¿es una placa Devantech?" })
    }
    expect(() => parseIndexXml("<Rly1>1</Rly1>", 1)).toThrow(/Respuesta no reconocida/)
    expect(() => parseIndexXml("<response><Rly1>2</Rly1></response>", 1)).toThrow(/Respuesta no reconocida/)
  })
})

describe("dS /index.htm", () => {
  it("extracts the toggle variable from the Rly1 button (V20944, V20552)", () => {
    const page = (v: string) => `<title>dS378</title><button id="Rly1" onmousedown="newAJAXCommand('dscript.cgi?${v}=1');">R1</button>`
    expect(extractToggleVar(page("V20944"))).toBe("V20944")
    expect(extractToggleVar(page("V20552"))).toBe("V20552")
  })

  it("falls back to any dscript.cgi?Vn=1 reference when Rly1 has no id", () => {
    expect(extractToggleVar(`<a href="#" onclick="go('dscript.cgi?V20448=1')">1</a>`)).toBe("V20448")
    expect(extractToggleVar(`<a onclick='x("dscript.cgi?V123=1")'>`)).toBe("V123")
    expect(extractToggleVar("<html>no buttons</html>")).toBeNull()
    expect(extractToggleVar(`dscript.cgi?Rly1=1'`)).toBeNull()
  })

  it("accepts only V plus 1..6 digits (the BoardOptions format); anything longer is not a toggle variable", () => {
    expect(extractToggleVar(`<button id="Rly1" onclick="c('dscript.cgi?V123456=1')">`)).toBe("V123456")
    expect(extractToggleVar(`<button id="Rly1" onclick="c('dscript.cgi?V1234567=1')">`)).toBeNull()
    expect(extractToggleVar(`<a onclick="c('dscript.cgi?V${"9".repeat(500)}=1')">`)).toBeNull()
  })

  it("takes the hostname from <title>", () => {
    expect(extractTitle("<html><head><title> banco-dS378 </title></head>")).toBe("banco-dS378")
    expect(extractTitle("<html></html>")).toBeNull()
  })
})

describe("dS ASCII replies", () => {
  it("parses ST (model and firmware)", () => {
    const st = "Module Type: dS378\r\nSystem Firmware Version: 4.12\r\nApplication Firmware Version: 4.12\r\nSupply Voltage: 12.1\r\n"
    expect(parseStReply(st)).toEqual({ model: "dS378", firmware: "4.12" })
    expect(parseStReply("Unknown Command\r\n")).toBeNull()
  })

  it("sanitises and caps the board-supplied ST text (printable ASCII; model 40, firmware 64 characters)", () => {
    const evil = `Module Type: dS3\x1b[2J78${"X".repeat(100)}\r\nSystem Firmware Version: 4.\x0712\xe9${"9".repeat(100)}\r\n`
    const r = parseStReply(evil)
    expect(r?.model).toBe(`dS3[2J78${"X".repeat(100)}`.slice(0, 40))
    expect(r?.model).toHaveLength(40)
    expect(r?.firmware).toBe(`4.12${"9".repeat(100)}`.slice(0, 64))
    expect(r?.firmware).toHaveLength(64)
    expect(parseStReply("Module Type: \x01\x02\x03\r\n")).toBeNull()
    expect(parseStReply("Module Type: dS378\r\nSystem Firmware Version: \x01\x02\r\n")).toEqual({ model: "dS378", firmware: null })
  })

  it("parses GR: Active / InActive, anything else is a protocol error", () => {
    expect(parseGrReply("Active\r\n")).toBe(true)
    expect(parseGrReply("InActive\r\n")).toBe(false)
    expect(() => parseGrReply("Unknown relay number\r\n")).toThrow(RelayDriverError)
    expect(() => parseGrReply("Ok\r\n")).toThrow(RelayDriverError)
  })

  it("maps SR replies: Ok, Unknown relay number → config, Unknown Action → protocol", () => {
    expect(() => parseSrReply("Ok\r\n", 1)).not.toThrow()
    expect(() => parseSrReply("Unknown relay number\r\n", 40)).toThrow(expect.objectContaining({ kind: "config" }))
    expect(() => parseSrReply("Unknown Action\r\n", 1)).toThrow(expect.objectContaining({ kind: "protocol" }))
    expect(() => parseSrReply("garbage\r\n", 1)).toThrow(expect.objectContaining({ kind: "protocol" }))
  })
})

describe("ETH binary", () => {
  it("parses 0x10 module info for the four ETH models", () => {
    expect(parseModuleInfo(Buffer.from([19, 1, 28]))).toEqual({ moduleId: 19, hw: 1, fw: 28, model: "ETH008", relays: 8 })
    expect(parseModuleInfo(Buffer.from([18, 2, 5]))?.model).toBe("ETH002")
    expect(parseModuleInfo(Buffer.from([20, 2, 5]))?.relays).toBe(4)
    expect(parseModuleInfo(Buffer.from([21, 2, 5]))?.relays).toBe(20)
    expect(parseModuleInfo(Buffer.from([35, 1, 1]))).toBeNull()      // a dS module id is not an ETH board
    expect(parseModuleInfo(Buffer.from([19, 1]))).toBeNull()         // short reply
  })

  it("parses 0x24 layouts: 1 byte, ETH484 (first byte only), 3 bytes", () => {
    expect(outputsLength(2)).toBe(1)
    expect(outputsLength(8)).toBe(1)
    expect(outputsLength(20)).toBe(3)
    expect(parseOutputs(Buffer.from([0b10000101]), 8)).toEqual([true, false, true, false, false, false, false, true])
    expect(parseOutputs(Buffer.from([0b10]), 2)).toEqual([false, true])
    expect(parseOutputs(Buffer.from([0b1001, 0xff]), 4)).toEqual([true, false, false, true])   // ETH484: relays, then outputs
    const b = parseOutputs(Buffer.from([0x01, 0x80, 0x08]), 20)
    expect(b).toHaveLength(20)
    expect(b.flatMap((v, i) => (v ? [i + 1] : []))).toEqual([1, 16, 20])
    expect(() => parseOutputs(Buffer.from([1]), 20)).toThrow(RelayDriverError)
  })

  it("converts pulse ms to 100 ms units, clamped to 1..255", () => {
    expect(pulseUnits(500)).toBe(5)
    expect(pulseUnits(20)).toBe(1)
    expect(pulseUnits(149)).toBe(1)
    expect(pulseUnits(150)).toBe(2)
    expect(pulseUnits(60000)).toBe(255)
  })
})
