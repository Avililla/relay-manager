import { describe, expect, it } from "vitest"
import { snapshotFixture } from "@/components/serial/__fixtures__/serial"
import { countUnassigned } from "./chips"

// The live chip must count exactly like the server's first value (ShellDTO.unassignedPorts, W1-A
// `rt.serial.discovery.unassignedCount()`): every port, USB and "others" (virtual and builtin), without a console
// assignment, skipping JTAG-probable ports only while RM_SERIAL_HIDE_JTAG hides them (snapshot.hiddenJtag > 0).
describe("countUnassigned (same predicate as the server)", () => {
  it("counts unassigned USB ports and unassigned virtual/builtin ports; hidden JTAG ports are skipped", () => {
    // FT4232 C+D, CP2105 A+B, CH340, ttyV1 and ttyS4; the hidden Digilent (JTAG) port is not counted.
    expect(countUnassigned(snapshotFixture)).toBe(7)
  })

  it("counts JTAG-probable ports while they are shown (hideJtag off → hiddenJtag 0)", () => {
    expect(countUnassigned({ ...snapshotFixture, hiddenJtag: 0 })).toBe(8)
  })

  it("an assigned port is never counted, whatever its group", () => {
    const assigned = { equipmentId: "e", equipmentName: "E", consoleId: "c", consoleKey: "K", consoleLabel: "K" }
    const all = {
      ...snapshotFixture,
      adapters: snapshotFixture.adapters.map((a) => ({ ...a, ports: a.ports.map((p) => ({ ...p, assignment: assigned })) })),
      others: snapshotFixture.others.map((p) => ({ ...p, assignment: assigned })),
    }
    expect(countUnassigned(all)).toBe(0)
  })
})
