import { describe, expect, it } from "vitest"
import { defaultRouteInterfaces, findIpBinary, hasNetAdmin, readHostState, runIpCommands } from "./iproute"

describe("iproute helpers", () => {
  it("CAP_NET_ADMIN from CapEff", () => {
    expect(hasNetAdmin("Name:\tnode\nCapEff:\t0000000000001000\n")).toBe(true)
    expect(hasNetAdmin("CapEff:\t0000000000000000\n")).toBe(false)
    expect(hasNetAdmin("CapEff:\t000001ffffffffff\n")).toBe(true)
  })
  it("default route interfaces (IPv4 and IPv6)", () => {
    const r4 = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\nenp3s0\t00000000\tFE1EA8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\nenp3s0\t001EA8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n"
    const r6 = "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003 wlan0\n00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200 lo\n"
    expect(defaultRouteInterfaces(r4, r6).sort()).toEqual(["enp3s0", "wlan0"])
  })
  it("reads the real state without privileges (when iproute2 is installed)", async () => {
    const bin = findIpBinary(null)
    if (!bin) return
    const s = await readHostState(bin)
    expect(s.links.some((l) => l.ifname === "lo")).toBe(true)
    expect(s.rules.some((r) => r.table === "main")).toBe(true)
  })
  it("refuses a dangerous command before running anything", async () => {
    await expect(runIpCommands("/bin/false", [["route", "replace", "default", "via", "1.2.3.4"]], { parent: "x", forbidden: [] })).rejects.toThrow(/rechazada/)
  })
})
