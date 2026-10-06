import { describe, expect, it } from "vitest"
import type { AccessDTO, AccessRuntimeDTO } from "@/lib/contracts/accesses"
import { accessStatusLabel, accessTone, openCount, reduceAccesses, remoteSessions, waitingForReservation } from "./access-model"

const rt = (p: Partial<AccessRuntimeDTO> = {}): AccessRuntimeDTO => ({ status: "stopped", reason: "not-reserved", detail: null, since: "", connections: [], writable: false, targetReachable: null, pid: null, network: null, ...p })
const acc = (id: string, r: AccessRuntimeDTO): AccessDTO => ({
  id, equipmentId: "e1", position: 0, key: id.toUpperCase(), label: id, kind: "tcp", port: 3201, enabled: true, policy: "reserved",
  cableSerial: null, cableName: null, consoleId: null, consoleKey: null, targetHost: null, targetPort: null, targetMode: "ip", switchPort: null, sshUser: null, runtime: r,
})

describe("access view model", () => {
  it("tones and labels", () => {
    expect([accessTone(rt({ status: "listening" })), accessStatusLabel(rt({ status: "listening" }))]).toEqual(["ok", "Abierto"])
    expect(accessStatusLabel(rt({ reason: "disabled" }))).toBe("Desactivado")
    expect(accessTone(rt({ status: "port-busy" }))).toBe("danger")
    expect(accessTone(rt({ status: "cable-missing" }))).toBe("warn")
  })
  it("merges live status events of this equipment only", () => {
    const list = [acc("a", rt()), acc("b", rt())]
    const next = reduceAccesses(list, { type: "access.status", equipmentId: "e1", accessId: "b", runtime: rt({ status: "listening", reason: null }) }, "e1")
    expect(next[1].runtime.status).toBe("listening")
    expect(next[0]).toBe(list[0])
    expect(reduceAccesses(list, { type: "access.status", equipmentId: "e2", accessId: "b", runtime: rt() }, "e1")).toBe(list)
    expect(openCount(next)).toBe(1)
    expect(waitingForReservation(next)).toBe(true)
    expect(waitingForReservation([acc("c", rt({ status: "listening", reason: null }))])).toBe(false)
  })
  it("lists the remote sessions of an equipment: who (tool), from where, and what a release does to them", () => {
    const conn = (remote: string) => ({ id: remote, remote, since: "2026-09-25T10:00:00.000Z", rxBytes: null, txBytes: null })
    const list: AccessDTO[] = [
      { ...acc("j", rt({ status: "listening", reason: null, connections: [conn("172.16.0.5:50122")] })), kind: "jtag", key: "JTAG0", label: "JTAG 0" },
      { ...acc("s", rt({ status: "listening", reason: null, connections: [conn("[fe80::1]:40000")] })), kind: "serial", key: "SERIE1", label: "Serie 1", policy: "always" },
      { ...acc("t", rt({ status: "listening", reason: null })), kind: "tcp" },
    ]
    const s = remoteSessions(list)
    expect(s.map((x) => [x.accessKey, x.host, x.tool, x.onRelease])).toEqual([
      ["JTAG0", "172.16.0.5", "xsdb/Vivado", "closed"],
      ["SERIE1", "fe80::1", "terminal", "read-only"],
    ])
    expect(s[0].text).toBe("JTAG 0: en uso por xsdb/Vivado desde 172.16.0.5")
    expect(remoteSessions([])).toEqual([])
  })
})
