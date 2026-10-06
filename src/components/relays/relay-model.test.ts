import { describe, expect, it } from "vitest"
import type { RelayChannelSummaryDTO } from "@/lib/contracts/equipment"
import { confirmFor, purposeOrder, reduceRelayLive, relayControl, relayStateView } from "./relay-model"

function relay(p: Partial<RelayChannelSummaryDTO> = {}): RelayChannelSummaryDTO {
  return {
    id: "r1", key: "POWER", label: "Alimentación", purpose: "power", position: 0, requireConfirm: false, defaultPulseMs: null,
    boardId: "b1", boardName: "dS378 banco", channel: 1, on: false, stale: false, boardOnline: true, pulse: "native",
    pulseMs: { min: 19, max: 60000, step: 1 }, ...p,
  }
}

describe("relayControl (§8.9 relay rail)", () => {
  it("absolute set switch for known state", () => {
    expect(relayControl(relay({ on: true }))).toEqual({ kind: "switch" })
  })
  it("Encender / Apagar when the state is unknown", () => {
    expect(relayControl(relay({ on: null }))).toEqual({ kind: "on-off" })
  })
  it("Encender / Apagar while the live connection is stale, never a switch in a position nobody confirmed", () => {
    expect(relayControl(relay({ on: true }), true)).toEqual({ kind: "on-off" })
    expect(relayControl(relay({ purpose: "reset", on: true }), true)).toEqual({ kind: "pulse", ms: 500, emulated: false })
  })
  it("reset relays pulse: defaultPulseMs, else 500 clamped to the board range and step", () => {
    expect(relayControl(relay({ purpose: "reset", defaultPulseMs: 300 }))).toEqual({ kind: "pulse", ms: 300, emulated: false })
    expect(relayControl(relay({ purpose: "reset", on: null }))).toEqual({ kind: "pulse", ms: 500, emulated: false })
    expect(relayControl(relay({ purpose: "reset", pulse: "emulated", pulseMs: { min: 100, max: 60000, step: 100 }, defaultPulseMs: 250 })))
      .toEqual({ kind: "pulse", ms: 300, emulated: true })
    expect(relayControl(relay({ purpose: "reset", pulseMs: { min: 1000, max: 25500, step: 100 } }))).toEqual({ kind: "pulse", ms: 1000, emulated: false })
  })
  it("a reset relay on a board that cannot pulse falls back to the switch", () => {
    expect(relayControl(relay({ purpose: "reset", pulse: "none", pulseMs: null }))).toEqual({ kind: "switch" })
  })
})

describe("confirmFor (requireConfirm: OFF and pulse ask first, ON never)", () => {
  it("no question without requireConfirm", () => {
    expect(confirmFor(relay(), "off", "Equipo A #07")).toBeNull()
  })
  it("power off", () => {
    expect(confirmFor(relay({ requireConfirm: true }), "off", "Equipo A #07")).toBe("¿Cortar la alimentación de Equipo A #07?")
    expect(confirmFor(relay({ requireConfirm: true }), "on", "Equipo A #07")).toBeNull()
  })
  it("other purposes and pulses", () => {
    expect(confirmFor(relay({ requireConfirm: true, purpose: "mode", label: "Arranque JTAG" }), "off", "EQ")).toBe("¿Apagar Arranque JTAG de EQ?")
    expect(confirmFor(relay({ requireConfirm: true, purpose: "reset" }), "pulse", "EQ")).toBe("¿Reiniciar EQ?")
    expect(confirmFor(relay({ requireConfirm: true, purpose: "generic", label: "Ventilador" }), "pulse", "EQ")).toBe("¿Enviar un pulso a Ventilador de EQ?")
  })
})

describe("relayStateView (§8.6: ON ok fill, OFF neutral, ? hatched; stale style)", () => {
  it("live values", () => {
    expect(relayStateView(relay({ on: true }), false)).toEqual({ text: "ON", tone: "on", stale: false })
    expect(relayStateView(relay({ on: false }), false)).toEqual({ text: "OFF", tone: "off", stale: false })
    expect(relayStateView(relay({ on: null }), false)).toEqual({ text: "?", tone: "unknown", stale: false })
  })
  it("the channel's own stale flag keeps the last value, marked stale", () => {
    expect(relayStateView(relay({ on: true, stale: true }), false)).toEqual({ text: "ON", tone: "on", stale: true })
  })
  it("no live connection: '?' in the stale style", () => {
    expect(relayStateView(relay({ on: true }), true)).toEqual({ text: "?", tone: "unknown", stale: true })
  })
})

describe("reduceRelayLive", () => {
  const live = { relays: [relay(), relay({ id: "r2", channel: 2 })], at: null }
  it("updates on/stale for the equipment's channels and remembers the time", () => {
    const next = reduceRelayLive(live, { type: "relay.state", equipmentId: "e1", channels: [{ channelId: "r2", on: true, stale: true }], at: "2026-09-23T10:00:00.000Z" }, "e1")
    expect(next.relays[1]).toMatchObject({ on: true, stale: true })
    expect(next.relays[0]).toBe(live.relays[0])
    expect(next.at).toBe("2026-09-23T10:00:00.000Z")
  })
  it("ignores other equipment", () => {
    expect(reduceRelayLive(live, { type: "relay.state", equipmentId: "zz", channels: [], at: "x" }, "e1")).toBe(live)
  })
})

describe("purposeOrder", () => {
  it("keeps the configured order (position)", () => {
    const a = relay({ id: "a", position: 1 })
    const b = relay({ id: "b", position: 0 })
    expect(purposeOrder([a, b]).map((r) => r.id)).toEqual(["b", "a"])
  })
})
