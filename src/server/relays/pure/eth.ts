// ETH series binary protocol (TCP 17494) parsers. Server-only pure code.
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { RelayDriverError } from "../types"
import { modelByModuleId } from "./models"

export const ETH = {
  MODULE_INFO: 0x10,
  ACTIVE: 0x20,
  INACTIVE: 0x21,
  GET_OUTPUTS: 0x24,
  PASSWORD: 0x79,
  UNLOCK_TIME: 0x7a,
} as const

/** 0x10 → [id, hw, fw]; null unless id is an ETH module (18..21). */
export function parseModuleInfo(buf: Buffer): { moduleId: number; hw: number; fw: number; model: string; relays: number } | null {
  if (buf.length < 3) return null
  const m = modelByModuleId(buf[0] ?? -1)
  if (!m || m.family !== "eth") return null
  return { moduleId: m.moduleId, hw: buf[1] ?? 0, fw: buf[2] ?? 0, model: m.model, relays: m.relays }
}

/** Bytes needed from a 0x24 reply: ⌈N/8⌉ (the ETH484 sends a second byte with the digital outputs; it is ignored). */
export function outputsLength(relayCount: number): number {
  return Math.ceil(relayCount / 8)
}

/** 0x24 reply → states; bit k of byte ⌊k/8⌋ is relay k+1. */
export function parseOutputs(buf: Buffer, relayCount: number): boolean[] {
  if (buf.length < outputsLength(relayCount)) throw new RelayDriverError(RELAY_TEXT.errUnrecognised, "protocol")
  return Array.from({ length: relayCount }, (_, k) => (((buf[k >> 3] ?? 0) >> (k & 7)) & 1) === 1)
}

/** Pulse time in 100 ms units, clamped to 1..255. */
export function pulseUnits(ms: number): number {
  return Math.min(255, Math.max(1, Math.round(ms / 100)))
}
