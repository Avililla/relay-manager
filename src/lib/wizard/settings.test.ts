import { describe, expect, it } from "vitest"
import { UpdateEquipmentInputSchema, type ConsoleDetailDTO, type EquipmentEditDTO } from "@/lib/contracts/equipment"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import {
  assignSettingsPort, buildUpdateInput, configSignature, effectivePort, isSettingsDirty, settingsDraftFrom, settingsPortHolder,
  takenSettingsChannels, validateSettings,
} from "./settings"

const runtime: ConsoleDetailDTO["runtime"] = {
  status: "open", devNode: "/dev/ttyUSB0", detail: null, since: "2026-09-23T10:00:00.000Z", lastRxAt: null, lastLine: null, viewers: 0, released: null, capture: "active",
}

function consoleDto(id: string, key: string, bindingKey: string | null): ConsoleDetailDTO {
  return {
    id, key, label: key, position: 0, line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, matchBy: bindingKey ? "path" : null,
    adapterLabel: null, adapterShort: null, runtime, hupcl: false, captureToDisk: true, identify: { hostnameRegex: "uart1", bannerRegex: null },
    binding: bindingKey ? {
      matchBy: "path", bindingKey, byId: null, byPath: null, usbVendorId: null, usbProductId: null, usbSerial: null, usbInterface: null,
      usbPortNumber: null, usbIdPath: null, devicePath: "/run/user/1000/sim/ttyV0", adapterLabel: "ttyV0", lastDevNode: "/run/user/1000/sim/ttyV0", lastSeenAt: null,
    } : null,
  }
}

const dto: EquipmentEditDTO = {
  id: "eq1", name: "Equipo A #01", serialNumber: null, description: "Unidad", templateId: "t1", templateName: "Equipo A", roleIds: ["r1"],
  consoles: [consoleDto("c1", "UART0", "virtual:/run/user/1000/sim/ttyV0"), consoleDto("c2", "UART1", "virtual:/run/user/1000/sim/ttyV1"), consoleDto("c3", "AUX", null)],
  relays: [{
    id: "l1", key: "POWER", label: "Alimentación", purpose: "power", position: 0, requireConfirm: true, defaultPulseMs: null, boardId: "b1", boardName: "Placa",
    channel: 1, on: null, stale: false, boardOnline: true, pulse: "emulated", pulseMs: null,
  }],
  reservation: null, roles: [{ id: "r1", name: "Integración" }], boards: [], serial: { scannedAt: "2026-09-23T10:00:00.000Z", adapters: [], others: [], hiddenJtag: 0, watcher: { inotify: true, intervalMs: 2000 } },
  serialHints: [], hideJtag: true,
  accesses: [],
  accessContext: {
    settings: { range: { from: 3201, to: 3230 }, bind: "0.0.0.0", httpPort: 3200, maxConnections: 8 }, usedPorts: [],
    jtag: { scannedAt: "2026-09-23T10:00:00.000Z", cables: [] }, labels: [], hwServer: { path: null, version: null, source: null, problem: null },
    network: null,
  },
}
const saved = new Map(dto.consoles.map((c) => [c.id, c.binding?.bindingKey ?? null]))

function counter() {
  let n = 0
  return () => `u${++n}`
}

describe("equipment settings draft", () => {
  it("starts from the saved equipment with keep bindings and board channels", () => {
    const d = settingsDraftFrom(dto, counter())
    expect(d.consoles.map((c) => c.binding)).toEqual(["keep", "keep", null])
    expect(d.consoles[0].identify).toEqual({ hostnameRegex: "uart1" })
    expect(d.relays[0].target).toEqual({ boardId: "b1", channel: 1 })
    expect(d.description).toBe("Unidad")
  })

  it("builds an update the contract accepts: keep, unbind, rebind and a new console", () => {
    const d = settingsDraftFrom(dto, counter())
    d.consoles[1] = { ...d.consoles[1], binding: null }
    d.consoles[2] = { ...d.consoles[2], binding: { stableKey: "virtual:/run/user/1000/sim/ttyV4", matchBy: "path" } }
    d.consoles.push({ ...d.consoles[2], uid: "new", id: undefined, key: "EXTRA", binding: "keep" })
    const input = buildUpdateInput(d, "eq1")
    expect(input.consoles.map((c) => c.binding)).toEqual(["keep", null, { stableKey: "virtual:/run/user/1000/sim/ttyV4", matchBy: "path" }, null])
    expect(input.consoles[3]).not.toHaveProperty("id")
    expect(input.relays[0]).toMatchObject({ id: "l1", boardId: "b1", channel: 1 })
    expect(UpdateEquipmentInputSchema.safeParse(input).success).toBe(true)
  })

  it("asks for a board channel on relay rows without one, and never sends them", () => {
    const d = settingsDraftFrom(dto, counter())
    d.relays.push({ uid: "r2", key: "RESET", label: "Reset", purpose: "reset", requireConfirm: false, defaultPulseMs: null, target: null })
    expect(validateSettings(d, "eq1", { relayTargetRequired: "Elige placa y canal" })).toEqual({ "relays.1.channel": ["Elige placa y canal"] })
    expect(buildUpdateInput(d, "eq1").relays).toHaveLength(1)
  })

  it("validates names and keys with dotted paths", () => {
    const d = settingsDraftFrom(dto, counter())
    d.name = ""
    d.consoles[1] = { ...d.consoles[1], key: "UART0" }
    const fe = validateSettings(d, "eq1", { relayTargetRequired: "x" })
    expect(fe.name).toEqual(["Obligatorio"])
    expect(fe["consoles.1.key"]).toEqual(["Clave repetida: UART0"])
  })

  it("moves a port between consoles: the one that had it loses it", () => {
    const d = settingsDraftFrom(dto, counter())
    const aux = d.consoles[2].uid
    const r = assignSettingsPort(d, aux, { stableKey: "virtual:/run/user/1000/sim/ttyV1", matchBy: "path" }, saved)
    expect(r.displaced).toEqual(["UART1"])
    expect(r.draft.consoles.map((c) => effectivePort(c, saved))).toEqual(["virtual:/run/user/1000/sim/ttyV0", null, "virtual:/run/user/1000/sim/ttyV1"])
    const back = assignSettingsPort(r.draft, r.draft.consoles[1].uid, "keep", saved)
    expect(back.displaced).toEqual(["AUX"])
  })

  it("names the other row that would lose a port, counting saved and pending bindings", () => {
    const d = settingsDraftFrom(dto, counter())
    const [uart0, uart1, aux] = d.consoles.map((c) => c.uid)
    expect(settingsPortHolder(d, "virtual:/run/user/1000/sim/ttyV1", aux, saved)).toBe("UART1")
    expect(settingsPortHolder(d, "virtual:/run/user/1000/sim/ttyV1", uart1, saved)).toBeNull()
    const r = assignSettingsPort(d, aux, { stableKey: "virtual:/run/user/1000/sim/ttyV4", matchBy: "path" }, saved)
    expect(settingsPortHolder(r.draft, "virtual:/run/user/1000/sim/ttyV4", uart0, saved)).toBe("AUX")
    expect(settingsPortHolder(r.draft, "virtual:/run/user/1000/sim/ttyV9", uart0, saved)).toBeNull()
  })

  it("tracks dirtiness and the configuration signature", () => {
    const d = settingsDraftFrom(dto, counter())
    const again = settingsDraftFrom(dto, counter())
    expect(isSettingsDirty(again, d)).toBe(false)
    expect(isSettingsDirty({ ...d, name: "Otro" }, d)).toBe(true)
    const withRuntime = { ...dto, consoles: dto.consoles.map((c) => ({ ...c, runtime: { ...c.runtime, lastLine: "login:" } })) }
    expect(configSignature(withRuntime)).toBe(configSignature(dto))
    expect(configSignature({ ...dto, name: "X" })).not.toBe(configSignature(dto))
  })

  it("lists channels used by other relay rows", () => {
    const d = settingsDraftFrom(dto, counter())
    d.relays.push({ uid: "r2", key: "RESET", label: "Reset", purpose: "reset", requireConfirm: false, defaultPulseMs: null, target: { boardId: "b1", channel: 2 } })
    expect(takenSettingsChannels(d, "r2")).toEqual(["b1:1"])
  })
})
