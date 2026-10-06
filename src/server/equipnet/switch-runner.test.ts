import { afterEach, describe, expect, it } from "vitest"
import { createFakeSwitch, type FakeSwitch } from "../../../scripts/sim/fake-tplink-switch.mjs"
import { DEFAULT_EQUIPNET, planEquipnet } from "@/lib/equipnet/plan"
import { planSwitchOps, targetLayout, type Dot1qState } from "@/lib/equipnet/switch-layout"
import { tplinkEasySmart } from "./drivers/tplink-easy-smart"
import { SwitchError, type SwitchSession } from "./drivers/types"
import { detectServerPort, rollback, runSwitchOps, SwitchStepError } from "./switch-runner"

let sw: FakeSwitch | null = null
afterEach(async () => { await sw?.close(); sw = null })

const driver = tplinkEasySmart()
const plan = planEquipnet(DEFAULT_EQUIPNET)
const target = targetLayout(plan.ports, { portCount: 8, uplinkPort: 1 })
async function open(o: Parameters<typeof createFakeSwitch>[0] = {}): Promise<SwitchSession> {
  sw = await createFakeSwitch({ links: [1, 4], ...o })
  return driver.open({ host: "127.0.0.1", httpPort: sw.port, localAddress: null, username: "admin", password: "admin" })
}

describe("TP-Link Easy Smart driver (fake switch built from the real pages)", () => {
  it("fingerprints the login page without credentials", async () => {
    sw = await createFakeSwitch()
    expect(await driver.fingerprint("127.0.0.1", sw.port, null)).toBe(true)
    expect(sw.log.every((r) => r.path === "/")).toBe(true)
  })
  it("wrong password → auth-failed", async () => {
    sw = await createFakeSwitch()
    await expect(driver.open({ host: "127.0.0.1", httpPort: sw.port, localAddress: null, username: "admin", password: "nope" }))
      .rejects.toMatchObject({ code: "auth-failed" })
  })
  it("unreachable → unreachable", async () => {
    await expect(driver.open({ host: "127.0.0.1", httpPort: 9, localAddress: null, username: "admin", password: "admin" }))
      .rejects.toBeInstanceOf(SwitchError)
  })
  it("reads model, links, counters and the factory 802.1Q state", async () => {
    const s = await open()
    expect(await s.info()).toMatchObject({ model: "TL-SG108E", portCount: 8, firmware: "1.0.0 Build 20160722 Rel.50167", mac: "b0:4e:26:37:e9:59" })
    expect((await s.links()).filter((l) => l.linkUp).map((l) => l.port)).toEqual([1, 4])
    expect(await s.dot1q()).toMatchObject({ enabled: false, pvids: [1, 1, 1, 1, 1, 1, 1, 1] })
    expect(await s.otherModes()).toEqual({ portBased: true, mtu: false })
    expect((await s.backup())?.length).toBeGreaterThan(16)
  })
  it("re-logs in when the session expired", async () => {
    const s = await open()
    sw?.reset()
    expect((await s.info()).model).toBe("TL-SG108E")
  })
})

describe("runSwitchOps against the fake switch", () => {
  it("sets up the equipment layout, verifies every step and saves to flash", async () => {
    const s = await open()
    const start = await s.dot1q()
    const steps: string[] = []
    const r = await runSwitchOps(s, start, planSwitchOps(start, target), { uplinkPort: 1, onStep: (p) => steps.push(p.op.op) })
    expect(r.warnings).toEqual([])
    const st = sw?.state()
    expect(st?.dot1q.pvids).toEqual([1, 102, 103, 104, 105, 106, 107, 108])
    expect(st?.dot1q.vlans.find((v) => v.vid === 1)?.untagged).toEqual([1])
    expect(st?.dot1q.vlans.find((v) => v.vid === 104)).toEqual({ vid: 104, name: "rmv104", untagged: [4], tagged: [1] })
    expect(st?.portBased).toBe(false)
    expect(st?.saves).toBe(1)
    expect(st?.saved?.pvids).toEqual(st?.dot1q.pvids)
    expect(steps.at(-1)).toBe("save")
    // Again: nothing to do.
    expect(planSwitchOps(await s.dot1q(), target)).toEqual([])
  })
  it("firmware that does not let VLAN 1 be edited: warning, equipment still isolated", async () => {
    const s = await open({ vlan1Editable: false })
    const start = await s.dot1q()
    const r = await runSwitchOps(s, start, planSwitchOps(start, target), { uplinkPort: 1, optionalVlan1Prune: true, vlan1PruneWarning: "VLAN 1" })
    expect(r.warnings).toEqual(["VLAN 1"])
    expect(sw?.state().dot1q.pvids).toEqual([1, 102, 103, 104, 105, 106, 107, 108])
    expect(sw?.state().saves).toBe(1)
  })
  it("a failing step stops the run and rollback restores the previous state", async () => {
    const s = await open()
    const start = await s.dot1q()
    sw?.failNext("/vlanPvidSet.cgi", 1)
    const err = await runSwitchOps(s, start, planSwitchOps(start, target), { uplinkPort: 1 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SwitchStepError)
    expect(await rollback(s, start as Dot1qState, 1)).toBeNull()
    expect(sw?.state().dot1q.enabled).toBe(false)
  })
  it("finds the port this server is plugged into from the counters", async () => {
    const s = await open({ clientPort: 3, links: [3] })
    expect((await detectServerPort(s)).port).toBe(3)
  })
})
