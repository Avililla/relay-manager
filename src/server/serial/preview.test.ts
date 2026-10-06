import { describe, expect, it } from "vitest"
import type { WsServerMsg } from "@/lib/contracts/ws"
import { createNullLogger } from "@/server/log"
import { fakeAudit } from "../../../test/helpers"
import type { PortOpener } from "./port-factory"
import { PreviewManager, type PreviewSessionLike } from "./preview"
import { FakeDiscovery, fakeOpener, virtualDevice } from "./testing/fakes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const actor = { kind: "user" as const, id: "u1", name: "admin", ip: "127.0.0.1" }
const dev = virtualDevice("ttyV7")

let seq = 1000
function session(): PreviewSessionLike & { msgs: WsServerMsg[]; closes: Array<[number, string]> } {
  const msgs: WsServerMsg[] = []
  const closes: Array<[number, string]> = []
  return { id: ++seq, msgs, closes, sendJson: (m) => { msgs.push(m) }, sendBinary: () => {}, close: (code, reason) => { closes.push([code, reason]) } }
}

function setup() {
  const opener = fakeOpener()
  let release = () => {}
  const gate = new Promise<void>((r) => { release = r })
  let entered = 0
  const openPort: PortOpener = async (o) => { entered++; await gate; return opener.open(o) }
  const pm = new PreviewManager({
    discovery: new FakeDiscovery([dev]), openPort, usage: { busy: new Set() }, audit: fakeAudit(), log: createNullLogger(),
    claim: () => null, graceMs: 40, maxIdleMs: 60_000, openTimeoutMs: 2000,
  })
  return { pm, opener, release, entered: () => entered }
}

describe("PreviewManager: a session that leaves while its port is opening", () => {
  it("is never adopted, and the port closes on the grace timer", async () => {
    const t = setup()
    const s = session()
    const joining = t.pm.join(dev.stableKey, 115200, s, actor)
    await sleep(5)
    expect(t.entered()).toBe(1)
    t.pm.leave(s)                                      // the socket's close ran before the open finished
    t.release()
    expect(await joining).toBe(false)
    expect(s.msgs).toEqual([])                         // no hello to a gone socket
    expect(t.pm.sessionCount()).toBe(0)
    const port = t.opener.last(dev.openPath)
    expect(port?.closed).toBe(false)
    expect(t.pm.isOpen(dev.stableKey)).toBe(true)
    await sleep(80)                                    // grace 40 ms
    expect(port?.closed).toBe(true)
    expect(t.pm.isOpen(dev.stableKey)).toBe(false)
    t.pm.leave(s)                                      // the later cleanup is a no-op
    expect(t.pm.sessionCount()).toBe(0)
  })

  it("does not affect another session waiting on the same open", async () => {
    const t = setup()
    const gone = session()
    const stays = session()
    const a = t.pm.join(dev.stableKey, 115200, gone, actor)
    const b = t.pm.join(dev.stableKey, 115200, stays, actor)
    await sleep(5)
    expect(t.entered()).toBe(1)                        // one shared open per stableKey
    t.pm.leave(gone)
    t.release()
    expect(await a).toBe(false)
    expect(await b).toBe(true)
    expect(stays.msgs.map((m) => m.t)).toEqual(["hello", "history-end"])
    expect(t.pm.sessionCount()).toBe(1)
    await sleep(80)
    const port = t.opener.last(dev.openPath)
    expect(port?.closed).toBe(false)                   // still viewed
    t.pm.leave(stays)
    await sleep(80)
    expect(port?.closed).toBe(true)
  })

  it("a normal leave after hello still closes the port after the grace", async () => {
    const t = setup()
    t.release()
    const s = session()
    expect(await t.pm.join(dev.stableKey, 115200, s, actor)).toBe(true)
    const port = t.opener.last(dev.openPath)
    t.pm.leave(s)
    await sleep(10)
    expect(port?.closed).toBe(false)
    await sleep(70)
    expect(port?.closed).toBe(true)
    await t.pm.closeAll()
  })
})
