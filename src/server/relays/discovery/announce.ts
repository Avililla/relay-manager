// Microchip "Discoverer" announcements on UDP 30303 (§4.10): Harmony TLV and MLA text. Pure.
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { modelByModuleId } from "../pure/models"
import { sanitizeText } from "../pure/text"

/** The 30-byte request: "Discovery: Who is out there?\0\n" (latin1). */
export const DISCOVERY_REQUEST = Buffer.from("Discovery: Who is out there?\0\n", "latin1")

export const MICROCHIP_OUIS = ["00:04:a3", "00:1e:c0", "d8:80:39"] as const

export interface Announcement {
  format: "harmony" | "mla"
  /** Always the datagram source (UDP is spoofable; the TLV IP is only a hint). */
  ip: string
  mac: string | null
  macName: string | null
  hostname: string | null
  moduleId: number | null
  model: string | null
  /** TLV 0x41: probably the TCP command port. */
  tcpPort: number | null
  /** TLV 0x7F: simulator-only HTTP port, honoured only with RM_RELAY_SIMULATE=1. */
  httpPort: number | null
  announcedIp: string | null
  message: string | null
  hints: string[]
}

export { sanitizeText } from "../pure/text"

const hex2 = (b: number) => b.toString(16).padStart(2, "0")
const FIXED: Record<number, number> = { 0x02: 6, 0x05: 4, 0x06: 16, 0x07: 16, 0x08: 16, 0x09: 16, 0x40: 1, 0x41: 2, 0x7f: 2 }

function isCrlf(buf: Buffer, i: number): boolean {
  return buf[i] === 0x0d && buf[i + 1] === 0x0a
}
function untilCrlf(buf: Buffer, i: number): number {
  let j = i
  while (j < buf.length && !isCrlf(buf, j)) j++
  return j
}

function parseHarmony(buf: Buffer, sourceIp: string, simulate: boolean): Announcement | null {
  const a: Announcement = {
    format: "harmony", ip: sourceIp, mac: null, macName: null, hostname: null, moduleId: null, model: null,
    tcpPort: null, httpPort: null, announcedIp: null, message: null, hints: [],
  }
  let i = 0
  while (i < buf.length) {
    if (isCrlf(buf, i)) { i += 2; continue } // bare separator ("user start")
    const t = buf[i++] ?? 0
    const fixed = FIXED[t]
    if (fixed !== undefined) {
      if (i + fixed > buf.length) break // truncated field
      const v = buf.subarray(i, i + fixed)
      i += fixed
      if (t === 0x02) a.mac = [...v].map(hex2).join(":")
      else if (t === 0x05) a.announcedIp = [...v].join(".")
      else if (t === 0x40) { a.moduleId = v[0] ?? null; a.model = a.moduleId === null ? null : (modelByModuleId(a.moduleId)?.model ?? null) }
      else if (t === 0x41) a.tcpPort = ((v[0] ?? 0) << 8) | (v[1] ?? 0)
      else if (t === 0x7f && simulate) a.httpPort = ((v[0] ?? 0) << 8) | (v[1] ?? 0)
      if (isCrlf(buf, i)) i += 2
      continue
    }
    if (t === 0x01) continue // truncated marker, no payload
    const end = untilCrlf(buf, i)
    const text = buf.subarray(i, end).toString("latin1")
    if (t === 0x03) a.macName = sanitizeText(text) || null
    else if (t === 0x04) a.hostname = sanitizeText(text) || null
    // unknown types: skipped up to the next CRLF
    i = end + 2
  }
  if (!a.mac && !a.hostname && a.moduleId === null) return null
  return a
}

function parseMla(buf: Buffer, sourceIp: string): Announcement | null {
  const lines = buf.toString("latin1").split("\r\n")
  const macLine = (lines[1] ?? "").trim()
  if (!/^([0-9A-Fa-f]{2}[-:]){5}[0-9A-Fa-f]{2}$/.test(macLine)) return null
  const message = sanitizeText(lines.slice(2).join(" "))
  return {
    format: "mla", ip: sourceIp, mac: macLine.toLowerCase().replace(/-/g, ":"), macName: null,
    hostname: sanitizeText(lines[0] ?? "") || null, moduleId: null, model: null, tcpPort: null, httpPort: null,
    announcedIp: null, message: message || null, hints: [],
  }
}

/**
 * Parses one datagram. Drops requests (first byte 'D', ours or another finder's) and packets shorter than 10 bytes.
 * The announced `ip` is always `sourceIp`.
 */
export function parseAnnouncement(buf: Buffer, sourceIp: string, opts: { simulate: boolean }): Announcement | null {
  if (buf.length < 10 || buf[0] === 0x44) return null
  const a = buf[0] === 0x02 ? parseHarmony(buf, sourceIp, opts.simulate) : parseMla(buf, sourceIp)
  if (!a) return null
  if (a.mac && MICROCHIP_OUIS.some((o) => a.mac?.startsWith(o))) a.hints.push(RELAY_TEXT.hintMicrochip)
  if (a.announcedIp && a.announcedIp !== sourceIp) a.hints.push(RELAY_TEXT.hintOtherIp(a.announcedIp))
  return a
}
