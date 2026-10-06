import { describe, expect, it } from "vitest"
import { DEFAULT_EQUIPNET, planEquipnet } from "./plan"
import {
  applyOp, freshDot1q, keepsManagement, layoutDrift, planSwitchOps, portList, range, sameMembers, targetLayout,
  type Dot1qState, type SwitchOp,
} from "./switch-layout"

const plan = planEquipnet(DEFAULT_EQUIPNET)
const target = targetLayout(plan.ports, { portCount: 8, uplinkPort: 1 })
const flat: Dot1qState = { enabled: false, portCount: 8, vlans: [], pvids: range(1, 8).map(() => 1) }

/** Runs the ops on a model switch and checks the safety invariants after every step. */
function simulate(start: Dot1qState, ops: SwitchOp[], uplink = 1): Dot1qState {
  let s = start
  for (const op of ops) {
    if (op.op === "pvid") {
      for (const p of op.ports) {
        const v = s.vlans.find((x) => x.vid === op.pvid)
        expect(v, `VLAN ${op.pvid} exists before PVID`).toBeDefined()
        expect([...(v?.untagged ?? []), ...(v?.tagged ?? [])], `port ${p} member of ${op.pvid}`).toContain(p)
      }
    }
    if (op.op === "vlan") expect(op.vlan.untagged.length + op.vlan.tagged.length).toBeGreaterThan(0)
    s = applyOp(s, op)
    expect(keepsManagement(s, uplink), `management after ${JSON.stringify(op)}`).toBe(true)
  }
  return s
}

const same = (a: Dot1qState, b: Dot1qState) => {
  expect(a.enabled).toBe(b.enabled)
  expect(a.pvids).toEqual(b.pvids)
  expect(a.vlans.map((v) => v.vid).sort((x, y) => x - y)).toEqual(b.vlans.map((v) => v.vid).sort((x, y) => x - y))
  for (const v of b.vlans) expect(sameMembers(a.vlans.find((x) => x.vid === v.vid) ?? { vid: 0, name: "", untagged: [], tagged: [] }, v)).toBe(true)
}

describe("targetLayout", () => {
  it("uplink untagged in VLAN 1 and tagged in every equipment VLAN; port n alone in VLAN 100+n", () => {
    expect(target.vlans[0]).toEqual({ vid: 1, name: "Default", untagged: [1], tagged: [] })
    expect(target.vlans.find((v) => v.vid === 103)).toEqual({ vid: 103, name: "rmv103", untagged: [3], tagged: [1] })
    expect(target.pvids).toEqual([1, 102, 103, 104, 105, 106, 107, 108])
    expect(keepsManagement(target, 1)).toBe(true)
    expect(targetLayout(plan.ports, { portCount: 8, uplinkPort: 1, pruneVlan1: false }).vlans[0].untagged).toEqual(range(1, 8))
  })
})

describe("planSwitchOps", () => {
  it("from a factory switch: enable, create VLANs, PVIDs, prune VLAN 1 last, save", () => {
    const ops = planSwitchOps(flat, target)
    expect(ops[0]).toEqual({ op: "enable", on: true })
    const kinds = ops.map((o) => (o.op === "vlan" ? `vlan${o.vlan.vid}:${o.phase}` : o.op))
    expect(kinds.slice(1, 8)).toEqual(["vlan102:add", "vlan103:add", "vlan104:add", "vlan105:add", "vlan106:add", "vlan107:add", "vlan108:add"])
    expect(kinds.filter((k) => k === "pvid")).toHaveLength(7)
    expect(kinds.at(-2)).toBe("vlan1:final")
    expect(kinds.at(-1)).toBe("save")
    same(simulate(flat, ops), target)
  })
  it("nothing to do when the switch already matches", () => {
    expect(planSwitchOps(target, target)).toEqual([])
  })
  it("back to a flat switch: disable 802.1Q and save", () => {
    expect(planSwitchOps(target, flat)).toEqual([{ op: "enable", on: false }, { op: "save" }])
    expect(planSwitchOps(flat, flat)).toEqual([])
  })
  it("restores a previous custom 802.1Q layout without losing the management", () => {
    const previous: Dot1qState = {
      enabled: true, portCount: 8,
      vlans: [{ vid: 1, name: "Default", untagged: [1, 4, 5, 6, 7, 8], tagged: [] }, { vid: 50, name: "lab", untagged: [2, 3], tagged: [1] }],
      pvids: [1, 50, 50, 1, 1, 1, 1, 1],
    }
    const ops = planSwitchOps(target, previous)
    same(simulate(target, ops), previous)
    expect(ops.find((o) => o.op === "delete")).toEqual({ op: "delete", vids: [102, 103, 104, 105, 106, 107, 108] })
  })
  it("random layouts: always reaches the target and never loses the management", () => {
    let seed = 7
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    const randomState = (): Dot1qState => {
      if (rnd(5) === 0) return flat
      const vids = [...new Set(range(0, rnd(5)).map(() => 2 + rnd(40)))]
      const vlans = [{ vid: 1, name: "Default", untagged: [1], tagged: [] as number[] }, ...vids.map((vid) => ({ vid, name: `v${vid}`, untagged: [] as number[], tagged: [1] }))]
      const pvids = range(1, 8).map(() => 1)
      for (let p = 2; p <= 8; p++) {
        const v = vlans[rnd(vlans.length)]
        v.untagged.push(p)
        pvids[p - 1] = v.vid
        const extra = vlans[rnd(vlans.length)]
        if (extra !== v && rnd(3) === 0) extra.tagged.push(p)
      }
      return { enabled: true, portCount: 8, vlans, pvids }
    }
    for (let i = 0; i < 300; i++) {
      const a = randomState()
      const b = randomState()
      same(simulate(a, planSwitchOps(a, b)), b.enabled ? b : flat)
    }
  })
})

describe("drift and helpers", () => {
  it("reports what differs from the applied layout", () => {
    const changed = { ...target, pvids: target.pvids.map((p, i) => (i === 2 ? 1 : p)) }
    expect(layoutDrift(changed, target)).toEqual([{ kind: "pvid", port: 3, expected: 103, actual: 1 }])
    expect(layoutDrift(flat, target)).toEqual([{ kind: "disabled" }])
    expect(layoutDrift(target, target)).toEqual([])
    expect(freshDot1q(5).pvids).toEqual([1, 1, 1, 1, 1])
  })
  it("port lists like the switch pages", () => {
    expect(portList([1, 2, 3, 5, 7, 8])).toBe("1-3,5,7-8")
    expect(portList([])).toBe("")
  })
})
