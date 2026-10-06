import { describe, expect, it } from "vitest"
import { suggestedMatchBy } from "@/components/serial/match-by-field"
import { emptySnapshotFixture, snapshotFixture } from "@/components/serial/__fixtures__/serial"
import { portGroups, type SerialPortDTO, type SerialSnapshotDTO } from "@/lib/contracts/serial"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import {
  emptyStateHints,
  allowedMatchBy, assignBindings, canIdentify, canPoke, canPreview, identifyTargets, initialAssignDraft, isFreePort, newPortKeys,
  portCounts, portDisplayName, probeTone, setAssignPort, singlePortGroup, snapshotPorts, type AssignConsole,
} from "./serial-model"

const groups = portGroups(snapshotFixture, { showJtag: true })
const ft = groups.find((g) => g.adapter?.serial === "FT4ABCDE")!
const cp = groups.find((g) => g.adapter?.serial === "01A7F3C2")!
const ch = groups.find((g) => g.adapter?.hints.includes("no-serial"))!
const others = groups.find((g) => g.key === "others")!
const port = (g: typeof ft, i: number): SerialPortDTO => g.ports[i]!

describe("snapshot helpers", () => {
  it("lists adapters then others", () => {
    const all = snapshotPorts(snapshotFixture)
    expect(all[0]?.kind).toBe("usb")
    expect(all.at(-1)?.kind).not.toBe("usb")
  })

  it("finds hot-plugged ports", () => {
    const extra: SerialPortDTO = { ...port(others, 0), stableKey: "path:/tmp/banco/sim/ttyV9", name: "ttyV9", devNode: "/tmp/banco/sim/ttyV9" }
    const next: SerialSnapshotDTO = { ...snapshotFixture, others: [...snapshotFixture.others, extra] }
    expect(newPortKeys(snapshotFixture, next)).toEqual(["path:/tmp/banco/sim/ttyV9"])
    expect(newPortKeys(next, snapshotFixture)).toEqual([])
    expect(newPortKeys(emptySnapshotFixture, snapshotFixture)).toHaveLength(snapshotPorts(snapshotFixture).length)
  })

  it("counts free and assigned ports of the visible groups", () => {
    const c = portCounts(groups)
    expect(c.total).toBe(groups.flatMap((g) => g.ports).length)
    expect(c.assigned).toBe(3)
    expect(c.free).toBe(groups.flatMap((g) => g.ports).filter(isFreePort).length)
    expect(portCounts([])).toEqual({ total: 0, free: 0, assigned: 0 })
  })
})

describe("row actions", () => {
  it("previews and pokes only free ports", () => {
    expect(canPreview(port(ft, 2))).toBe(true)
    expect(canPreview(port(ft, 0))).toBe(false) // assigned
    expect(canPreview(port(ft, 3))).toBe(false) // in use by another program
    expect(canPreview(port(cp, 1))).toBe(false) // EACCES
    expect(canPoke(port(ft, 2), true)).toBe(true)
    expect(canPoke(port(ft, 2), false)).toBe(false)
    // held by the app (a preview) without a console: still assignable and previewable, but not pokeable
    const held: SerialPortDTO = { ...port(ft, 2), inUse: "app" }
    expect(isFreePort(held)).toBe(true)
    expect(canPreview(held)).toBe(true)
    expect(canPoke(held, true)).toBe(false)
  })

  it("identifies accessible ports, including the ones the app holds", () => {
    expect(canIdentify(port(ft, 0))).toBe(true)
    expect(canIdentify(port(ft, 3))).toBe(false)
    expect(canIdentify(port(cp, 1))).toBe(false)
    expect(identifyTargets(ft)).toEqual([port(ft, 0), port(ft, 1), port(ft, 2)].map((p) => p.stableKey))
  })

  it("maps probe states to tones", () => {
    expect(probeTone("shell")).toBe("ok")
    expect(probeTone("uboot-autoboot")).toBe("neutral")
    expect(probeTone("unreadable")).toBe("warn")
    expect(probeTone("no-permission")).toBe("danger")
  })

  it("offers only the match modes a port supports", () => {
    expect(allowedMatchBy(port(ft, 2))).toEqual(["adapter", "usb-port", "path"])
    expect(allowedMatchBy(port(ch, 0))).toEqual(["usb-port", "path"])
    expect(allowedMatchBy(port(others, 0))).toEqual(["path"])
  })

  it("names ports for people", () => {
    expect(portDisplayName(port(ft, 2))).toBe("ttyUSB2 · C")
    expect(portDisplayName(port(ch, 0))).toBe("ttyUSB6")
    expect(portDisplayName(port(others, 0))).toMatch(/^tty/)
  })
})

describe("assign dialog draft", () => {
  const consoles: AssignConsole[] = [
    { id: "c1", key: "UART0", label: "UART0", bound: true, adapterShort: "FT4ABCDE·A" },
    { id: "c2", key: "UART1", label: "UART1", bound: false, adapterShort: null },
    { id: "c3", key: "PL", label: "PL", bound: false, adapterShort: null },
  ]

  it("suggests the free ports in physical order onto the unbound consoles", () => {
    const draft = initialAssignDraft(consoles, ft, suggestedMatchBy)
    expect(Object.keys(draft).sort()).toEqual(["c2", "c3"])
    expect(draft.c2).toEqual({ stableKey: port(ft, 2).stableKey, matchBy: "adapter" })
    expect(draft.c3).toEqual({ stableKey: null, matchBy: "path" }) // ttyUSB3 is in use by another program
  })

  it("maps the pseudo-group of virtual ports with the path mode", () => {
    const draft = initialAssignDraft(consoles, others, suggestedMatchBy)
    const free = others.ports.filter(isFreePort)
    expect(draft.c2).toEqual({ stableKey: free[0]!.stableKey, matchBy: "path" })
  })

  it("a single-port group maps only that port", () => {
    const g = singlePortGroup(cp, port(cp, 0))
    expect(g.ports).toHaveLength(1)
    const draft = initialAssignDraft(consoles, g, suggestedMatchBy)
    expect(draft.c2?.stableKey).toBe(port(cp, 0).stableKey)
    expect(draft.c3?.stableKey).toBeNull()
  })

  it("never assigns one port to two consoles", () => {
    let draft = initialAssignDraft(consoles, ft, suggestedMatchBy)
    draft = setAssignPort(draft, "c3", port(ft, 2), suggestedMatchBy)
    expect(draft.c3?.stableKey).toBe(port(ft, 2).stableKey)
    expect(draft.c2?.stableKey).toBeNull()
    draft = setAssignPort(draft, "c3", null, suggestedMatchBy)
    expect(assignBindings(consoles, draft)).toEqual([])
  })

  it("builds the action rows in console order", () => {
    let draft = initialAssignDraft(consoles, others, suggestedMatchBy)
    draft = setAssignPort(draft, "c3", others.ports.filter(isFreePort)[1]!, suggestedMatchBy)
    const rows = assignBindings(consoles, draft)
    expect(rows.map((r) => r.consoleId)).toEqual(["c2", "c3"])
    expect(rows.every((r) => r.binding.matchBy === "path")).toBe(true)
  })
})

describe("emptyStateHints (0 adapters: the empty state already says «no adapters»)", () => {
  const check = (id: string, level: HealthCheckDTO["level"]): HealthCheckDTO => ({ id, group: "serial", label: id, level, message: "m", hint: null })
  it("drops the info-level «no hay adaptadores» check and keeps the rest", () => {
    expect(emptyStateHints([check("serial.devices", "info"), check("serial.dialout", "warn")]).map((c) => c.id)).toEqual(["serial.dialout"])
  })
  it("keeps a devices check that reports a real problem", () => {
    expect(emptyStateHints([check("serial.devices", "warn")]).map((c) => c.id)).toEqual(["serial.devices"])
  })
})
