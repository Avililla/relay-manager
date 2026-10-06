import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  maskToPorts, parseDot1q, parseLogon, parseModeState, parsePortSettings, parsePortStatistics, parseSystemInfo, parseTip, portsToMask, readVar,
} from "./tplink-parse"

// Pages captured from the real TL-SG108E v3 (firmware 1.0.0 Build 20160722 Rel.50167) with read-only requests.
const FIX = path.resolve(__dirname, "../../../../test/fixtures/tplink-sg108e-v3")
const page = (f: string) => fs.readFileSync(path.join(FIX, f), "latin1")

describe("TP-Link Easy Smart pages (real TL-SG108E v3)", () => {
  it("login page and wrong password", () => {
    expect(parseLogon(page("login.htm"))).toEqual({ isLoginPage: true, code: 0 })
    expect(parseLogon(page("logon-bad-password.htm"))).toEqual({ isLoginPage: true, code: 1 })
    expect(parseLogon(page("SystemInfoRpm.htm")).isLoginPage).toBe(false)
  })
  it("system information", () => {
    expect(parseSystemInfo(page("SystemInfoRpm.htm"))).toEqual({
      model: "TL-SG108E", mac: "B0:4E:26:37:E9:59", ip: "192.168.0.99", firmware: "1.0.0 Build 20160722 Rel.50167", hardware: "TL-SG108E 3.0",
    })
    expect(parseSystemInfo(page("login.htm"))).toBeNull()
  })
  it("port link state: port 1 at 1000 Mb/s, the rest down", () => {
    const p = parsePortSettings(page("PortSettingRpm.htm"))
    expect(p?.portCount).toBe(8)
    expect(p?.ports[0]).toEqual({ port: 1, enabled: true, linkUp: true, speed: "1000 Mb/s dúplex", lag: 0 })
    expect(p?.ports.slice(1).every((x) => !x.linkUp)).toBe(true)
  })
  it("port counters (tx good, tx bad, rx good, rx bad)", () => {
    const c = parsePortStatistics(page("PortStatisticsRpm.htm"))
    expect(c).toHaveLength(8)
    expect(c?.[0]).toMatchObject({ port: 1, txGood: 106, txBad: 0, rxGood: 987, rxBad: 0, linkUp: true })
  })
  it("802.1Q disabled (factory), PVIDs 1; port-based VLAN on, MTU VLAN off", () => {
    expect(parseDot1q(page("Vlan8021QRpm.htm"), page("Vlan8021QPvidRpm.htm"))).toEqual({ enabled: false, portCount: 8, vlans: [], pvids: [1, 1, 1, 1, 1, 1, 1, 1] })
    expect(parseModeState(page("VlanPortBasicRpm.htm"), "pvlan_ds")).toBe(true)
    expect(parseModeState(page("VlanMtuRpm.htm"), "mtu_ds")).toBe(false)
    expect(parseTip(page("Vlan8021QRpm.htm"))).toBe("")
  })
  it("802.1Q enabled (as the firmware writes it)", () => {
    const vlan = `<script>\nvar qvlan_ds = {\nstate:1,\nportNum:8,\nvids:[\n1,102,103\n],\ncount:3,\nmaxVids:32,\nnames:[\n"","rmv102","rmv103"\n],\ntagMbrs:[\n0x0,0x1,0x1\n],\nuntagMbrs:[\n0x1,0x2,0x4\n],\nlagIds:[\n0,0,0,0,0,0,0,0\n],\nlagMbrs:[\n0,0x0,0x0\n]\n};var tip = "";\n</script>`
    const pvid = `<script>\nvar pvid_ds = {\nstate:1,\nportNum:8,\nvids:[\n1,102,103\n],\ncount:3,\nmbrs:[\n0x1,0x3,0x5\n],\npvids:[\n1,102,103,1,1,1,1,1\n],\nlagIds:[0,0,0,0,0,0,0,0],lagMbrs:[0,0x0,0x0]};var tip = "";</script>`
    expect(parseDot1q(vlan, pvid)).toEqual({
      enabled: true, portCount: 8, pvids: [1, 102, 103, 1, 1, 1, 1, 1],
      vlans: [{ vid: 1, name: "", tagged: [], untagged: [1] }, { vid: 102, name: "rmv102", tagged: [1], untagged: [2] }, { vid: 103, name: "rmv103", tagged: [1], untagged: [3] }],
    })
  })
  it("literal reader: never evaluates, rejects what it does not know", () => {
    expect(readVar("var a = new Array(\n0,\n0,0);", "a")).toEqual([0, 0, 0])
    expect(readVar("var a = {k:'x\\'y', n:-0x10, e:[]};", "a")).toEqual({ k: "x'y", n: -16, e: [] })
    expect(() => readVar("var a = alert(1);", "a")).toThrow(/No se entiende/)
    expect(readVar("nothing", "a")).toBeNull()
    expect(maskToPorts(0xff, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(portsToMask([1, 3])).toBe(5)
  })
})
