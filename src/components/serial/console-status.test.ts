import { describe, expect, it } from "vitest"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { consoleStatusView } from "./console-status"

const rt = (p: Partial<ConsoleRuntimeDTO>): ConsoleRuntimeDTO => ({
  status: "open", devNode: "/dev/ttyUSB0", detail: null, since: "2026-09-23T10:00:00.000Z", lastRxAt: null, lastLine: null,
  viewers: 0, released: null, capture: "active", ...p,
})

describe("consoleStatusView: released port", () => {
  it("names the person the way reservations do (short display name)", () => {
    const v = consoleStatusView(rt({ status: "released", released: { byName: "Jorge Duro", at: "2026-09-23T10:00:00.000Z", until: null } }), undefined, false, false)
    expect(v.label).toBe("Puerto soltado por J. Duro")
  })
})
