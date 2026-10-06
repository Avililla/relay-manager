import { describe, expect, it } from "vitest"
import type { DetectResultDTO } from "@/lib/contracts/relays"
import { createKnownBoards } from "./known"

const detect = (p: Partial<DetectResultDTO>): DetectResultDTO => ({
  driver: "devantech-ds-ascii", confidence: "high", host: "10.0.0.5", httpPort: 80, tcpPort: 17123,
  model: "dS378", moduleId: 35, relayCount: 8, hostname: null, mac: null, firmware: null,
  authRequired: false, options: {}, evidence: [], ...p,
})

describe("known boards: merging sources", () => {
  it("a later source without firmware or hostname keeps the ones an earlier source found", () => {
    const k = createKnownBoards({ now: () => new Date("2026-09-23T10:00:00.000Z"), boards: () => [], publish: () => {} })
    k.upsert({ ip: "10.0.0.5", mac: "00:04:a3:00:00:01", detect: detect({ firmware: "4.12", hostname: "dS378", mac: "00:04:a3:00:00:01" }), reachable: true }, "udp-active")
    const after = k.upsert({ ip: "10.0.0.5", httpPort: 80, detect: detect({ options: { toggleVar: "V20944" }, evidence: ["ST -> dS378"] }), reachable: true }, "scan")
    expect(after.detect).toMatchObject({ firmware: "4.12", hostname: "dS378", mac: "00:04:a3:00:00:01", options: { toggleVar: "V20944" }, evidence: ["ST -> dS378"] })
  })
  it("a newer non-null value still wins", () => {
    const k = createKnownBoards({ now: () => new Date("2026-09-23T10:00:00.000Z"), boards: () => [], publish: () => {} })
    k.upsert({ ip: "10.0.0.5", mac: "00:04:a3:00:00:01", detect: detect({ firmware: "4.12" }) }, "udp-active")
    expect(k.upsert({ ip: "10.0.0.5", mac: "00:04:a3:00:00:01", detect: detect({ firmware: "4.13" }) }, "scan").detect?.firmware).toBe("4.13")
  })
})
