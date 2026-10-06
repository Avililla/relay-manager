import { describe, expect, it } from "vitest"
import { z } from "zod"
import { TemplateSpecSchema, formatEquipmentName } from "./templates"
import { CreateEquipmentInputSchema } from "./equipment"
import { lineSummary, DEFAULT_LINE } from "./enums"
import { ConsoleBindingRecordSchema, CaptureFileNameSchema, portGroups, type SerialPortDTO, type SerialSnapshotDTO, type UsbAdapterDTO } from "./serial"
import { PasswordSchema } from "./users"
import { toFieldErrors } from "@/server/actions/define-action"
import { safeNextPath } from "@/lib/safe-next"

const slot = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: key, line: DEFAULT_LINE, ...extra })

describe("TemplateSpecSchema", () => {
  it("accepts a valid spec and applies defaults", () => {
    const r = TemplateSpecSchema.parse({ version: 1, consoles: [slot("UART0")], relays: [] })
    expect(r.namePattern).toBe("{template} #{nn}")
    expect(r.skipInterfaces).toEqual([])
    expect(r.consoles[0].enterMode).toBe("cr")
    expect(r.consoles[0].identify).toEqual({})
  })
  it("rejects duplicate console and relay keys with dotted paths", () => {
    const r = TemplateSpecSchema.safeParse({
      version: 1,
      consoles: [slot("UART0"), slot("UART0")],
      relays: [{ key: "POWER", label: "Power" }, { key: "POWER", label: "Power 2" }],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const fe = toFieldErrors(r.error)
      expect(fe["consoles.1.key"]).toBeDefined()
      expect(fe["relays.1.key"]).toBeDefined()
    }
  })
  it("rejects a regex that does not compile", () => {
    const r = TemplateSpecSchema.safeParse({ version: 1, consoles: [slot("A", { identify: { hostnameRegex: "(" } })], relays: [] })
    expect(r.success).toBe(false)
  })
  it("enforces the limits (16 consoles, 32 relays)", () => {
    const consoles = Array.from({ length: 17 }, (_, i) => slot(`C${i}`))
    expect(TemplateSpecSchema.safeParse({ version: 1, consoles, relays: [] }).success).toBe(false)
    const relays = Array.from({ length: 33 }, (_, i) => ({ key: `R${i}`, label: `R${i}` }))
    expect(TemplateSpecSchema.safeParse({ version: 1, consoles: [], relays }).success).toBe(false)
  })
})

describe("CreateEquipmentInputSchema", () => {
  const base = {
    name: "Equipo A #01", serialNumber: null, description: null, roleIds: [], templateId: null,
    consoles: [] as unknown[], relays: [] as unknown[],
  }
  const console = (key: string, binding: unknown) => ({ key, label: key, line: DEFAULT_LINE, enterMode: "cr", localEcho: false, binding })
  const relay = (boardId: string, channel: number) => ({ key: null, label: "R", purpose: "generic", requireConfirm: false, defaultPulseMs: null, boardId, channel })

  it("defaults templateUpdate to null", () => {
    expect(CreateEquipmentInputSchema.parse(base).templateUpdate).toBeNull()
  })
  it("reports duplicate keys, stableKeys and channels", () => {
    const r = CreateEquipmentInputSchema.safeParse({
      ...base,
      consoles: [console("A", { stableKey: "usb:1", matchBy: "adapter" }), console("A", { stableKey: "usb:1", matchBy: "adapter" })],
      relays: [relay("b1", 1), relay("b1", 1)],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const fe = toFieldErrors(r.error)
      expect(fe["consoles.1.key"]).toBeDefined()
      expect(fe["consoles.1.binding"]).toBeDefined()
      expect(fe["relays.1.channel"]).toBeDefined()
    }
  })
  it("accepts the templateUpdate shape and strips bindings from slots", () => {
    const r = CreateEquipmentInputSchema.parse({
      ...base,
      templateId: "tpl1",
      templateUpdate: { consoles: [{ ...slot("UART0"), binding: { stableKey: "x", matchBy: "path" }, hupcl: true }], relays: [{ key: "POWER", label: "Power" }] },
    })
    expect(r.templateUpdate?.consoles[0]).not.toHaveProperty("binding")
    expect(r.templateUpdate?.consoles[0]).not.toHaveProperty("hupcl")
    expect(r.templateUpdate?.relays[0].purpose).toBe("generic")
  })
  it("rejects a malformed templateUpdate", () => {
    expect(CreateEquipmentInputSchema.safeParse({ ...base, templateUpdate: { consoles: "x", relays: [] } }).success).toBe(false)
  })
})

describe("formatEquipmentName", () => {
  it("pads {nn} and picks the next free number (case-insensitive)", () => {
    expect(formatEquipmentName("{template} #{nn}", "Equipo A", [])).toBe("Equipo A #01")
    expect(formatEquipmentName("{template} #{nn}", "Equipo A", ["equipo a #01", "Equipo A #02"])).toBe("Equipo A #03")
    expect(formatEquipmentName("Equipo C {nnn}", "Equipo C", ["Equipo C 001"])).toBe("Equipo C 002")
    expect(formatEquipmentName("X-{n}", "X", [])).toBe("X-1")
  })
  it("adds a (n) suffix when the pattern has no number token", () => {
    expect(formatEquipmentName("{template}", "Equipo C", ["Equipo C"])).toBe("Equipo C (2)")
  })
})

describe("lineSummary", () => {
  it("formats line settings", () => {
    expect(lineSummary(DEFAULT_LINE)).toBe("115200 8N1")
    expect(lineSummary({ baudRate: 9600, dataBits: 7, parity: "even", stopBits: 2, flowControl: "none" })).toBe("9600 7E2")
  })
})

function port(devNode: string, over: Partial<SerialPortDTO> = {}): SerialPortDTO {
  return {
    stableKey: devNode, name: devNode.split("/").pop() ?? devNode, devNode, kind: "virtual", driver: null, byId: null, byPath: null,
    usb: null, interfaceLetter: null, accessible: true, accessError: null, hints: [], assignment: null, inUse: null, ...over,
  }
}
function adapter(locationKey: string, hints: UsbAdapterDTO["hints"] = []): UsbAdapterDTO {
  return {
    locationKey, identityKey: null, vendorId: "0403", productId: "6011", manufacturer: "FTDI", product: "Quad", serial: null,
    label: `FTDI ${locationKey}`, location: "USB 1-3", hints, ports: [port(`/dev/ttyUSB${locationKey}`, { kind: "usb" })],
  }
}

describe("portGroups", () => {
  const snap = (adapters: UsbAdapterDTO[], others: SerialPortDTO[]): SerialSnapshotDTO => ({
    scannedAt: "2026-09-23T10:00:00.000Z", adapters, others, hiddenJtag: 0, watcher: { inotify: true, intervalMs: 2000 },
  })
  it("lists adapters first and the pseudo-group last, sorted naturally", () => {
    const g = portGroups(snap([adapter("1"), adapter("2")], [port("/tmp/sim/ttyV10"), port("/tmp/sim/ttyV2")]), { showJtag: false })
    expect(g.map((x) => x.key)).toEqual(["1", "2", "others"])
    expect(g[2].label).toBe("Puertos virtuales y del sistema")
    expect(g[2].adapter).toBeNull()
    expect(g[2].ports.map((p) => p.devNode)).toEqual(["/tmp/sim/ttyV2", "/tmp/sim/ttyV10"])
  })
  it("omits the pseudo-group when empty and filters JTAG adapters", () => {
    const g = portGroups(snap([adapter("1", ["jtag-probable"]), adapter("2")], []), { showJtag: false })
    expect(g.map((x) => x.key)).toEqual(["2"])
    expect(portGroups(snap([adapter("1", ["jtag-probable"])], []), { showJtag: true })).toHaveLength(1)
  })
})

describe("ConsoleBindingRecordSchema", () => {
  const rec = {
    matchBy: "path", bindingKey: "path:/dev/ttyS4", byId: null, byPath: null, usbVendorId: null, usbProductId: null,
    usbSerial: null, usbInterface: null, usbPortNumber: null, usbIdPath: null, devicePath: "/dev/ttyS4", adapterLabel: null, lastDevNode: null,
  }
  it("accepts /dev, /run/relay-manager, /run/user and */sim/* paths", () => {
    for (const p of ["/dev/ttyS4", "/run/relay-manager/sim/ttyV0", "/run/user/1000/relay-manager-sim/ttyV0", "/var/lib/relay-manager/sim/ttyV1"]) {
      expect(ConsoleBindingRecordSchema.safeParse({ ...rec, devicePath: p }).success).toBe(true)
    }
  })
  it("rejects other device paths and bad by-id prefixes", () => {
    expect(ConsoleBindingRecordSchema.safeParse({ ...rec, devicePath: "/etc/passwd" }).success).toBe(false)
    expect(ConsoleBindingRecordSchema.safeParse({ ...rec, byId: "/dev/ttyUSB0" }).success).toBe(false)
    expect(ConsoleBindingRecordSchema.safeParse({ ...rec, byId: "/dev/serial/by-id/usb-FTDI-if00" }).success).toBe(true)
    expect(ConsoleBindingRecordSchema.safeParse({ ...rec, usbVendorId: "04G3" }).success).toBe(false)
  })
})

describe("PasswordSchema", () => {
  it("counts bytes, not characters (72-byte bcrypt limit)", () => {
    expect(PasswordSchema.safeParse("a".repeat(72)).success).toBe(true)
    expect(PasswordSchema.safeParse("a".repeat(73)).success).toBe(false)
    expect(PasswordSchema.safeParse("ñ".repeat(36)).success).toBe(true) // 72 bytes
    expect(PasswordSchema.safeParse("ñ".repeat(37)).success).toBe(false) // 74 bytes, 37 chars
    expect(PasswordSchema.safeParse("corta").success).toBe(false)
  })
})

describe("CaptureFileNameSchema", () => {
  it("accepts capture file names including .input.log", () => {
    for (const n of ["2026-09-23.log", "2026-09-23.1.log", "2026-09-22.log.gz", "2026-09-23.input.log", "2026-09-23.2.input.log.gz"]) {
      expect(CaptureFileNameSchema.safeParse(n).success, n).toBe(true)
    }
    for (const n of ["../x.log", "2026-09-23.txt", "meta.json", "2026-9-23.log"]) {
      expect(CaptureFileNameSchema.safeParse(n).success, n).toBe(false)
    }
  })
})

describe("toFieldErrors", () => {
  it("keys by the full dotted path and uses _form for root errors", () => {
    const schema = z.object({ consoles: z.array(z.object({ key: z.string().min(2) })) }).refine(() => false, "Raíz")
    const r = schema.safeParse({ consoles: [{ key: "ok" }, { key: "x" }] })
    expect(r.success).toBe(false)
    if (!r.success) {
      const fe = toFieldErrors(r.error)
      expect(Object.keys(fe)).toContain("consoles.1.key")
    }
    const root = schema.safeParse({ consoles: [] })
    if (!root.success) expect(toFieldErrors(root.error)._form).toEqual(["Raíz"])
  })
})

describe("safeNextPath", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNextPath("/equipos/abc?x=1")).toBe("/equipos/abc?x=1")
    expect(safeNextPath("/")).toBe("/")
  })
  it("rejects protocol-relative, backslash, absolute, api and non-string values", () => {
    for (const v of ["//evil.com", "/\\evil.com", "https://x", "/api/x", "", "equipos", 42, null, undefined, "/a b"]) {
      expect(safeNextPath(v)).toBe("/")
    }
  })
})
