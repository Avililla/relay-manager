import { describe, expect, it } from "vitest"
import { DEFAULT_EQUIPNET, MGMT_TABLE, PREF_BASE, planEquipnet, portForVid, prefOfTable, vlanIfname } from "./plan"

describe("planEquipnet", () => {
  it("default: ports 2..8 get VLAN 102..108, rmv102.., .202.. and their own tables", () => {
    const p = planEquipnet(DEFAULT_EQUIPNET)
    expect(p.errors).toEqual({})
    expect(p.subnet).toBe("192.168.1.0/24")
    expect(p.ports.map((x) => x.port)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(p.ports[0]).toEqual({ port: 2, vid: 102, ifname: "rmv102", hostAddress: "192.168.1.202", table: 20102, pref: 1102 })
    expect(p.mgmt).toEqual({ address: "192.168.0.250", prefix: 24, subnet: "192.168.0.0/24", table: MGMT_TABLE, pref: PREF_BASE })
    expect(vlanIfname(102)).toBe("rmv102")
    expect(portForVid(p, 105)?.port).toBe(5)
  })
  it("rule preferences sort before the main table (32766) and before Tailscale (5210..5270)", () => {
    const p = planEquipnet({ ...DEFAULT_EQUIPNET, vlanBase: 4000, portCount: 48 })
    const prefs = [p.mgmt?.pref ?? 0, ...p.ports.map((x) => x.pref)]
    expect(Math.min(...prefs)).toBe(1000)
    expect(Math.max(...prefs)).toBeLessThanOrEqual(5094)
    expect(prefOfTable(20000 + 4094)).toBe(5094)
  })
  it("VLAN addresses never take an address the server already has (another NIC on 192.168.1.0/24)", () => {
    const p = planEquipnet(DEFAULT_EQUIPNET, { avoid: ["192.168.1.203", "192.168.1.209", "172.20.5.50"] })
    expect(p.errors).toEqual({})
    const byPort = Object.fromEntries(p.ports.map((x) => [x.port, x.hostAddress]))
    // Port 3's usual .203 is taken: it gets the first free one after the last port's (.209 is taken too → .210).
    expect(byPort).toEqual({ 2: "192.168.1.202", 3: "192.168.1.210", 4: "192.168.1.204", 5: "192.168.1.205", 6: "192.168.1.206", 7: "192.168.1.207", 8: "192.168.1.208" })
    expect(new Set(Object.values(byPort)).size).toBe(7)
    // Never the equipment IP either.
    const q = planEquipnet({ ...DEFAULT_EQUIPNET, equipmentIp: "192.168.1.209" }, { avoid: ["192.168.1.203"] })
    expect(q.ports.find((x) => x.port === 3)?.hostAddress).toBe("192.168.1.210")
    // No room left → a clear error.
    expect(planEquipnet({ ...DEFAULT_EQUIPNET, hostOffset: 246 }, { avoid: ["192.168.1.248"] }).errors.hostOffset?.[0]).toMatch(/ninguna dirección libre/)
  })
  it("the uplink port has no VLAN of its own", () => {
    const p = planEquipnet({ ...DEFAULT_EQUIPNET, uplinkPort: 8 })
    expect(p.ports.map((x) => x.port)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
  it("never gives the server the equipment IP, the network or the broadcast address", () => {
    expect(planEquipnet({ ...DEFAULT_EQUIPNET, equipmentIp: "192.168.1.203" }).errors.hostOffset?.[0]).toMatch(/192\.168\.1\.203/)
    expect(planEquipnet({ ...DEFAULT_EQUIPNET, hostOffset: 250 }).errors.hostOffset?.[0]).toMatch(/fuera de la red|difusión/)
    expect(planEquipnet({ ...DEFAULT_EQUIPNET, equipmentIp: "192.168.1.0" }).errors.equipmentIp).toBeDefined()
  })
  it("rejects VLAN ids out of 2..4094 and an uplink beyond the port count", () => {
    expect(planEquipnet({ ...DEFAULT_EQUIPNET, vlanBase: 4090 }).errors.vlanBase).toBeDefined()
    expect(planEquipnet({ ...DEFAULT_EQUIPNET, uplinkPort: 9 }).errors.uplinkPort).toBeDefined()
  })
  it("the management and equipment networks must not overlap", () => {
    expect(planEquipnet({ ...DEFAULT_EQUIPNET, mgmtAddress: "192.168.1.250/24" }).errors.mgmtAddress?.[0]).toMatch(/misma red/)
  })
})
