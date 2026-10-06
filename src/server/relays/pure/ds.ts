// dS stock app parsers (HTTP /index.xml, /index.htm; ASCII ST/GR/SR). Server-only pure code.
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { RelayDriverError } from "../types"
import { MODEL_TEXT_MAX, sanitizeText } from "./text"

const unrecognised = () => new RelayDriverError(RELAY_TEXT.errUnrecognised, "protocol")

/** A dS stock-app XML: a `<response>` root with a binary `<Rly1>`. */
export function isDsIndexXml(body: string): boolean {
  return /<response>/i.test(body) && /<Rly1>[01]<\/Rly1>/.test(body)
}

/** Every element name in the XML. */
export function xmlTags(body: string): Set<string> {
  return new Set([...body.matchAll(/<([A-Za-z_][\w]*)>/g)].map((m) => m[1] ?? ""))
}

/** Strict parse: the `<response>` root and every Rly1..RlyN (N = relayCount) are required. Index 0 = channel 1. */
export function parseIndexXml(body: string, relayCount: number): boolean[] {
  if (!/<response>[\s\S]*<\/response>/i.test(body)) throw unrecognised()
  const out: boolean[] = []
  for (let i = 1; i <= relayCount; i++) {
    const m = new RegExp(`<Rly${i}>([01])</Rly${i}>`).exec(body)
    if (!m) throw unrecognised()
    out.push(m[1] === "1")
  }
  return out
}

/**
 * The dScript variable behind the relay buttons (D5), e.g. "V20944". Only `V` plus 1..6 digits, the format that
 * BoardOptions accepts; anything else on the page is not a toggle variable.
 */
export function extractToggleVar(html: string): string | null {
  const rly1 = /id="Rly1"[^>]*dscript\.cgi\?(V\d{1,6})=1['"]/.exec(html)
  if (rly1?.[1]) return rly1[1]
  const any = /dscript\.cgi\?(V\d{1,6})=1['"]/.exec(html)
  return any?.[1] ?? null
}

export function extractTitle(html: string): string | null {
  const t = /<title>([^<]*)<\/title>/i.exec(html)?.[1]
  return t ? sanitizeText(t) || null : null
}

/** `ST` reply → model and firmware (board text: sanitised and capped); null when there is no "Module Type:" line. */
export function parseStReply(text: string): { model: string; firmware: string | null } | null {
  const rawModel = /^Module Type:\s*(\S+)/m.exec(text)?.[1]
  const model = rawModel ? sanitizeText(rawModel, MODEL_TEXT_MAX) : ""
  if (!model) return null
  const rawFirmware = /^System Firmware Version:\s*(\S+)/m.exec(text)?.[1]
  const firmware = rawFirmware ? sanitizeText(rawFirmware) || null : null
  return { model, firmware }
}

/** `GR n` reply: "Active" / "InActive"; anything else is a protocol error. */
export function parseGrReply(text: string): boolean {
  const t = text.trim()
  if (t === "Active") return true
  if (t === "InActive") return false
  throw unrecognised()
}

/** `SR n …` reply: "Ok"; "Unknown relay number" → config; "Unknown Action" (or anything else) → protocol. */
export function parseSrReply(text: string, channel: number): void {
  const t = text.trim()
  if (t === "Ok") return
  if (t === "Unknown relay number") throw new RelayDriverError(RELAY_TEXT.errUnknownRelay(channel), "config")
  if (t === "Unknown Action") throw new RelayDriverError(RELAY_TEXT.errUnknownAction, "protocol")
  throw unrecognised()
}

/** True once a CRLF-terminated line arrived. */
export const hasLine = (b: Buffer): boolean => b.includes("\r\n") || b.includes("\n")
