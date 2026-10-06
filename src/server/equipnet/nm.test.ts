import { describe, expect, it } from "vitest"
import { parseNmDevices, splitTerse } from "./nm"

describe("nmcli terse output", () => {
  it("splits on unescaped colons only", () => {
    expect(splitTerse("enp3s0:connected:Wired connection 1")).toEqual(["enp3s0", "connected", "Wired connection 1"])
    expect(splitTerse("enx0:connected:Red\\:equipos\\\\x")).toEqual(["enx0", "connected", "Red:equipos\\x"])
  })
  it("devices, states and connections (-- is none)", () => {
    expect(parseNmDevices("enp3s0:connected:Laboratorio\nenx08beac3882ce:disconnected:--\nrmv102:unmanaged:--\n\n")).toEqual({
      enp3s0: { state: "connected", connection: "Laboratorio" },
      enx08beac3882ce: { state: "disconnected", connection: null },
      rmv102: { state: "unmanaged", connection: null },
    })
  })
})
