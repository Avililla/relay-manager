import { describe, expect, it } from "vitest"
import type { EquipnetEditDTO, EquipnetStatusDTO, NetAdapterDTO, SwitchPortDTO } from "@/lib/contracts/equipnet"
import { adapterTypeText, currentStep, planLines, portChoices, portOptionText, showOffer } from "./equipnet-model"

const port = (n: number, p: Partial<SwitchPortDTO> = {}): SwitchPortDTO => ({
  port: n, role: n === 1 ? "uplink" : "equipment", vid: n === 1 ? null : 100 + n, ifname: null, hostAddress: null, link: "down", speed: null, linkUpAt: null, usedBy: [], hostReady: true, ...p,
})

describe("equipnet view model", () => {
  it("plan in plain words", () => {
    expect(planLines({ uplinkPort: 1, portCount: 8, equipmentIp: "192.168.1.10" })).toEqual([
      "Puerto 1: este servidor (el cable del adaptador USB).",
      "Puertos 2 a 8: un equipo cada uno, aislados entre sí.",
      "Todos los equipos con la IP 192.168.1.10; se entra a cada uno por SSH (puerto 22) desde su acceso Ethernet.",
      "El switch guarda la configuración y la aplicación hace una copia antes de cambiar nada.",
    ])
    expect(planLines({ uplinkPort: 5, portCount: 8, equipmentIp: "10.0.0.2" })[1]).toBe("Puertos 1-4,6-8: un equipo cada uno, aislados entre sí.")
  })
  it("port options: link, who has it, the one just plugged in", () => {
    expect(portOptionText(port(3, { link: "up" }), 3)).toEqual({ title: "Puerto 3 del switch", detail: "enlace activo · libre · acabas de conectar algo" })
    expect(portOptionText(port(4, { usedBy: [{ equipmentId: "e", equipmentName: "Equipo A #02", accessId: "a", key: "ETH" }] }), null).detail).toBe("sin enlace · Equipo A #02")
    const net: EquipnetEditDTO = { configured: true, equipmentIp: "192.168.1.10", equipmentPort: 22, portCount: 8, uplinkPort: 1, suggestedPort: null,
      ports: [port(2), port(3, { usedBy: [{ equipmentId: "e", equipmentName: "X", accessId: "a", key: "ETH" }] })] }
    expect(portChoices(net, null).map((c) => [c.port.port, c.taken])).toEqual([[2, false], [3, true]])
    expect(portChoices(net, 3).map((c) => c.taken)).toEqual([false, false])
  })
})

const adapter = (p: Partial<NetAdapterDTO> = {}): NetAdapterDTO => ({
  ifname: "enx0", mac: "02:00:00:00:00:01", usb: true, bus: "usb", wireless: false, driver: "cdc_ncm", vendorId: null, productId: null, manufacturer: "ASIX",
  product: "AX88179A", location: "USB 2-3", carrier: true, speedMbps: 1000, addresses: [], defaultRoute: false, nmState: null, nmConnection: null,
  selectable: "yes", problem: null, warning: null, mgmtReuse: null, labelId: null, labelName: null, chosen: false, ...p,
})
const status = (settings: Partial<EquipnetStatusDTO["settings"]>, p: Partial<EquipnetStatusDTO> = {}): EquipnetStatusDTO => ({
  settings: { enabled: false, adapterMac: null, driver: "tplink-easy-smart", switchHost: null, switchUsername: null, hasPassword: false, portCount: 8, uplinkPort: 1,
    vlanBase: 100, mgmtAddress: "192.168.0.250/24", equipmentIp: "192.168.1.10", equipmentPrefix: 24, hostOffset: 200, ...settings },
  adapters: [adapter()], otherInterfaces: [], mgmt: { mode: "none", address: null, subnet: null, ifname: null, ready: false, problem: null }, warnings: [],
  leftovers: { items: [], commands: [] }, host: { state: "off", detail: null, pending: [], canApply: false, ifname: null, networkManagerHint: null, checkedAt: null },
  switch: { state: "unconfigured", detail: null, info: { model: null, hardware: null, firmware: null, mac: null, portCount: null }, dot1qEnabled: null, matches: null, drift: [], checkedAt: null },
  ports: [], detection: null, offerSetup: true, job: null, appliedAt: null, previousAt: null, hasBackup: false, hostMode: "apply", ...p,
})

describe("Sistema › Red de equipos steps", () => {
  it("1 → choose, 2 → find, 3 → prepare, 4 → state", () => {
    expect(currentStep(status({}))).toBe(1)
    const chosen = { adapters: [adapter({ chosen: true })] }
    expect(currentStep(status({ adapterMac: "02:00:00:00:00:01" }, chosen))).toBe(2)
    expect(currentStep(status({ adapterMac: "02:00:00:00:00:01", switchHost: "192.168.0.99" }, chosen))).toBe(3)
    expect(currentStep(status({ adapterMac: "02:00:00:00:00:01", switchHost: "192.168.0.99", enabled: true }, { ...chosen, appliedAt: "2026-09-29T10:00:00.000Z" }))).toBe(4)
    // The chosen interface unplugged: back to step 1 (it says so).
    expect(currentStep(status({ adapterMac: "02:00:00:00:00:01" }))).toBe(1)
  })
  it("the passive card only while nothing is chosen", () => {
    expect(showOffer(status({}))).toBe(true)
    expect(showOffer(status({ adapterMac: "02:00:00:00:00:01" }))).toBe(false)
    expect(showOffer(status({}, { offerSetup: false }))).toBe(false)
  })
  it("interface type in words", () => {
    expect(adapterTypeText(adapter())).toBe("USB · ASIX AX88179A · USB 2-3")
    expect(adapterTypeText(adapter({ bus: "pci", usb: false, manufacturer: null, product: null, driver: "r8169", location: null }))).toBe("PCI (tarjeta del equipo) · r8169")
  })
})
