import { describe, expect, it } from "vitest"
import type { BoardDetailDTO, BoardDTO, BoardRuntimeDTO, DetectResultDTO, DiscoveredBoardDTO } from "@/lib/contracts/relays"
import { UpdateBoardInputSchema } from "@/lib/contracts/relays"
import {
  applyDetect, connectionInput, connectionKey, draftEquals, draftFromBoard, draftFromDiscovered, draftToInput, emptyDraft, maxRelays,
  modelOptions, pulseIsEmulated, setDriver, setModel, testGate,
} from "./board-form-model"
import { applyBoardDetailStatus, applyBoardStatus, boardStatusView, boardTcpPort, boardUsage, relayTiles } from "./board-view"
import { boardForm as boardFormText, boards as boardsText, durationText } from "@/lib/i18n/hardware"

const runtime = (over: Partial<BoardRuntimeDTO> = {}): BoardRuntimeDTO => ({
  online: true, lastSeenAt: "2026-09-23T10:00:00.000Z", lastError: null, states: [true, false, null, false], stale: false,
  capabilities: { absoluteSet: true, toggle: "emulated", pulse: "native", pulseMs: { min: 19, max: 60000, step: 1 }, maxRelays: 32 },
  ...over,
})

const board = (over: Partial<BoardDTO> = {}): BoardDTO => ({
  id: "b1", name: "dS378 banco", driver: "devantech-ds-ascii", host: "192.168.1.40", httpPort: 80, tcpPort: null, model: "dS378",
  moduleId: 35, mac: "00:04:a3:00:00:01", relayCount: 8, options: {}, username: null, hasPassword: false, enabled: true,
  usedChannels: 2, equipmentCount: 1, runtime: runtime(), ...over,
})

const detect = (over: Partial<DetectResultDTO> = {}): DetectResultDTO => ({
  driver: "devantech-ds-ascii", confidence: "high", host: "192.168.1.40", httpPort: 80, tcpPort: 17123, model: "dS378", moduleId: 35,
  relayCount: 8, hostname: "dS378", mac: "00:04:a3:00:00:01", firmware: "3.12", authRequired: false, options: { toggleVar: "V20944" },
  evidence: ["ST -> Module Type: dS378"], ...over,
})

describe("board draft", () => {
  it("round-trips a saved board without changes", () => {
    const d = draftFromBoard(board({ tcpPort: 17123, options: { useHttpFallback: true } }))
    const r = draftToInput(d, "edit")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.input).toMatchObject({ name: "dS378 banco", tcpPort: 17123, relayCount: 8, options: { useHttpFallback: true }, password: undefined })
    expect(UpdateBoardInputSchema.safeParse({ ...r.input, boardId: "b1" }).success).toBe(true)
  })

  it("reports Spanish dotted field errors", () => {
    const r = draftToInput({ ...emptyDraft(), name: "", host: "not a host!", mac: "zz", httpPort: "abc" }, "create")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.fieldErrors.name).toEqual(["Obligatorio"])
    expect(r.fieldErrors.host).toEqual(["IP o nombre de host no válido"])
    expect(r.fieldErrors.mac).toEqual(["MAC no válida"])
    expect(r.fieldErrors.httpPort?.[0]).toMatch(/puerto/)
  })

  it("never drops stored options (a learned toggleVar survives a driver change)", () => {
    const d = draftFromBoard(board({ driver: "devantech-ds-ascii", options: { toggleVar: "V20944" } }))
    const r = draftToInput(d, "edit")
    expect(r.ok && r.input.options).toEqual({ toggleVar: "V20944" })
    const http = draftToInput({ ...emptyDraft(), name: "X", host: "10.0.0.2", driver: "devantech-ds-http", toggleVar: " V1 " }, "create")
    expect(http.ok && http.input.options).toEqual({ toggleVar: "V1" })
    expect(http.ok && http.input.tcpPort).toBeNull()
    const eth = draftToInput({ ...emptyDraft(), name: "E", host: "10.0.0.3", driver: "devantech-eth", model: "ETH008", transport: "http" }, "create")
    expect(eth.ok && eth.input.options).toEqual({ transport: "http" })
    expect(draftToInput({ ...emptyDraft(), name: "B", host: "10.0.0.4", toggleVar: "X1" }, "create").ok).toBe(false)
  })

  it("password: keep, replace or clear on edit; none on create", () => {
    const d = { ...draftFromBoard(board({ driver: "devantech-eth", model: "ETH008", hasPassword: true })) }
    const keep = draftToInput(d, "edit")
    const replace = draftToInput({ ...d, password: "secreto" }, "edit")
    const clear = draftToInput({ ...d, clearPassword: true }, "edit")
    expect(keep.ok && keep.input.password).toBeUndefined()
    expect(replace.ok && replace.input.password).toBe("secreto")
    expect(clear.ok && clear.input.password).toBeNull()
    const created = draftToInput({ ...emptyDraft(), name: "N", host: "10.0.0.9" }, "create")
    expect(created.ok && created.input.password).toBeNull()
  })

  it("caps the relay count to the driver", () => {
    const r = draftToInput({ ...emptyDraft(), name: "E", host: "10.0.0.3", driver: "devantech-eth", model: "ETH484", relayCount: 8 }, "create")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fieldErrors.relayCount?.[0]).toMatch(/máximo 4/)
    expect(maxRelays({ driver: "devantech-eth", model: "ETH8020", sim: undefined })).toBe(20)
  })

  it("the model sets the physical relay count and module id", () => {
    expect(setModel(emptyDraft(), "dS2824")).toMatchObject({ model: "dS2824", relayCount: 24, moduleId: 34 })
    expect(modelOptions("devantech-eth").every((m) => m.family === "eth")).toBe(true)
    expect(modelOptions("devantech-ds-http").every((m) => m.family === "ds")).toBe(true)
  })

  it("switching driver drops a model of the other family and an unused TCP port", () => {
    const d = setDriver({ ...setModel(emptyDraft(), "dS378"), tcpPort: "17123" }, "devantech-eth")
    expect(d.model).toBeNull()
    const h = setDriver({ ...emptyDraft(), tcpPort: "17123" }, "devantech-ds-http")
    expect(h.tcpPort).toBe("")
    expect(setDriver(setModel(emptyDraft(), "dS378"), "devantech-ds-http").model).toBe("dS378")
  })

  it("flags the emulated pulse", () => {
    expect(pulseIsEmulated({ driver: "devantech-ds-http", model: null, sim: undefined })).toBe(true)
    expect(pulseIsEmulated({ driver: "devantech-ds-ascii", model: null, sim: undefined })).toBe(false)
  })

  it("applies a detect result but keeps the name", () => {
    const d = applyDetect({ ...emptyDraft(), name: "Rack 3", host: "192.168.1.40" }, detect())
    expect(d).toMatchObject({ name: "Rack 3", driver: "devantech-ds-ascii", tcpPort: "17123", model: "dS378", relayCount: 8, toggleVar: "V20944", mac: "00:04:a3:00:00:01" })
  })

  it("prefills from a discovery result", () => {
    const disc: DiscoveredBoardDTO = {
      key: "00:04:a3:00:00:02", sources: ["udp-active"], firstSeenAt: "2026-09-23T10:00:00.000Z", lastSeenAt: "2026-09-23T10:00:00.000Z",
      ip: "192.168.1.41", mac: "00:04:a3:00:00:02", hostname: "ETH008", model: "ETH008", moduleId: 19, tcpPort: null, httpPort: 80,
      detect: detect({ driver: "devantech-eth", host: "192.168.1.41", tcpPort: 17494, model: "ETH008", moduleId: 19, options: {} }),
      registeredBoardId: null, registeredBoardName: null, ipChanged: false, reachable: true, hints: [],
    }
    const d = draftFromDiscovered(disc)
    expect(d).toMatchObject({ name: "ETH008 192.168.1.41", driver: "devantech-eth", host: "192.168.1.41", tcpPort: "17494", relayCount: 8 })
    expect(draftToInput(d, "create").ok).toBe(true)
  })

  it("detects changes", () => {
    const d = draftFromBoard(board())
    expect(draftEquals(d, draftFromBoard(board()))).toBe(true)
    expect(draftEquals(d, { ...d, name: "Otro" })).toBe(false)
  })
})

describe("connection test gate", () => {
  const d = { ...emptyDraft(), name: "A", host: "192.168.1.40", tcpPort: "17123" }
  it("requires a successful test at the current address before the first save", () => {
    expect(testGate("create", d, null)).toBe("required")
    expect(testGate("create", d, { key: connectionKey(d), results: [] })).toBe("failed")
    expect(testGate("create", d, { key: connectionKey(d), results: [detect()] })).toBe("ok")
    expect(testGate("create", { ...d, host: "192.168.1.41" }, { key: connectionKey(d), results: [detect()] })).toBe("outdated")
    expect(testGate("create", { ...d, host: " 192.168.1.40 " }, { key: connectionKey(d), results: [detect()] })).toBe("ok")
  })
  it("never blocks edits or the simulated driver", () => {
    expect(testGate("edit", d, null)).toBe("ok")
    expect(testGate("create", { ...d, driver: "simulated" }, null)).toBe("ok")
  })
  it("sends the typed connection only", () => {
    expect(connectionInput({ ...d, driver: "devantech-ds-http", password: "" })).toEqual({ driver: undefined, host: "192.168.1.40", httpPort: 80, tcpPort: null, username: null, password: null })
    expect(connectionInput({ ...d, driver: "simulated" }).driver).toBe("simulated")
  })
})

describe("board views", () => {
  const when = (iso: string) => iso.slice(11, 16)
  it("status chip by kind", () => {
    expect(boardStatusView(board(), when)).toMatchObject({ kind: "online", tone: "ok", label: "Conectada" })
    expect(boardStatusView(board({ runtime: runtime({ online: false }) }), when)).toMatchObject({ kind: "offline", tone: "danger", label: "Sin respuesta desde 10:00" })
    expect(boardStatusView(board({ runtime: runtime({ online: null }) }), when).label).toBe("Sin leer todavía")
    expect(boardStatusView(board({ enabled: false }), when).label).toBe("Desactivada")
  })

  it("uses the driver's default TCP port", () => {
    expect(boardTcpPort(board())).toBe(17123)
    expect(boardTcpPort(board({ driver: "devantech-ds-http" }))).toBeNull()
    expect(boardTcpPort(board({ driver: "devantech-eth", tcpPort: 2000 }))).toBe(2000)
  })

  it("applies board.status events", () => {
    const list = [board(), board({ id: "b2" })]
    const next = applyBoardStatus(list, { type: "board.status", boardId: "b2", runtime: runtime({ online: false }) })
    expect(next[0]).toBe(list[0])
    expect(next[1]?.runtime.online).toBe(false)
    expect(applyBoardStatus(list, { type: "heartbeat", serverNow: "x" })).toBe(list)
  })

  const detail = (over: Partial<BoardDetailDTO> = {}): BoardDetailDTO => ({
    ...board({ relayCount: 4 }),
    channels: [
      { channel: 1, state: true, binding: { equipmentId: "e1", equipmentName: "Equipo A #01", channelId: "r1", label: "Alimentación", purpose: "power" } },
      { channel: 2, state: false, binding: { equipmentId: "e1", equipmentName: "Equipo A #01", channelId: "r2", label: "Reinicio", purpose: "reset" } },
      { channel: 3, state: null, binding: null },
      { channel: 4, state: false, binding: { equipmentId: "e2", equipmentName: "Equipo C #01", channelId: "r3", label: "Modo", purpose: "mode" } },
    ],
    ...over,
  })

  it("builds relay tiles with text for occupancy and state", () => {
    const tiles = relayTiles(detail(), false)
    expect(tiles.map((t) => t.state)).toEqual(["on", "off", "unknown", "off"])
    expect(tiles[0]).toMatchObject({ bound: true, bindingText: "Equipo A #01 · Alimentación", equipmentId: "e1" })
    expect(tiles[2]).toMatchObject({ bound: false, bindingText: null })
  })

  it("shows ? when the state is stale, the board is offline or disabled, or the connection is lost", () => {
    for (const d of [detail({ runtime: runtime({ stale: true }) }), detail({ runtime: runtime({ online: false }) }), detail({ enabled: false })]) {
      expect(relayTiles(d, false).every((t) => t.state === "unknown")).toBe(true)
    }
    expect(relayTiles(detail(), true).every((t) => t.state === "unknown")).toBe(true)
  })

  it("counts usage for the delete confirmation", () => {
    expect(boardUsage(detail())).toEqual({ relays: 3, equipment: 2 })
  })

  it("applies board.status to the detail channels", () => {
    const d = applyBoardDetailStatus(detail(), { type: "board.status", boardId: "b1", runtime: runtime({ states: [false, true, true, null] }) })
    expect(d.channels.map((c) => c.state)).toEqual([false, true, true, null])
    expect(applyBoardDetailStatus(detail(), { type: "board.status", boardId: "zz", runtime: runtime() }).channels[0]?.state).toBe(true)
  })
})

describe("board copy (fix round 1)", () => {
  it("formats pulse limits in ms below a second and in s above", () => {
    expect(durationText(19)).toBe("19 ms")
    expect(durationText(1500)).toBe("1,5 s")
    expect(durationText(60000)).toBe("60 s")
    expect(boardsText.capPulseNative(19, 60000)).toBe("Pulso nativo de 19 ms a 60 s")
  })

  it("the model help shows the model's physical relays, and the count in use when it differs", () => {
    expect(boardFormText.relayCountFromModel("dS2824", 24, 24)).toBe("dS2824: 24 relés")
    expect(boardFormText.relayCountFromModel("dS2824", 24, 4)).toBe("dS2824: 24 relés (usas 4)")
  })
})
