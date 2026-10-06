// Passive console classifier (§4.7). Pure, server-only (Graph A and its tests).
import type { ProbeState } from "@/lib/contracts/serial"

export type ClassifiedState = Extract<ProbeState, "fsbl" | "uboot-autoboot" | "uboot-prompt" | "linux-booting" | "login" | "shell"
  | "bitreader" | "unreadable" | "silent">

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Prompts are matched on the tail only: they are the console's current state. */
const PROMPTS: Array<[ClassifiedState, RegExp]> = [
  ["login", /(?:^|\n)(?:([\w.-]+) )?login:$/i],
  ["uboot-prompt", /(?:^|\n)(?:Zynq|ZynqMP|U-Boot|=)>$/],
  ["shell", /(?:^|\n)[^\n]*[#$]$/],
]
/** Banners: the latest match wins (the most recent boot phase). */
const BANNERS: Array<[ClassifiedState, RegExp]> = [
  ["fsbl", /First Stage Boot Loader|\bFSBL\b/g],
  ["uboot-prompt", /U-Boot \d{4}\.\d{2}/g],
  ["uboot-autoboot", /Hit any key to stop autoboot:\s*[1-9]/g],
  ["linux-booting", /Starting kernel|Booting Linux on physical CPU|Linux version \d|\[\s*\d+\.\d{6}\]/g],
]

/** ANSI stripped, CRLF/CR → LF. */
export function cleanText(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n?/g, "\n")
}

/**
 * Classifies what a console shows. `text` is the raw capture decoded as latin1 (one char per byte), so the
 * printable ratio counts bytes.
 */
export function classify(text: string): { state: ClassifiedState; hostname: string | null } {
  if (text.length === 0) return { state: "silent", hostname: null }
  const printable = text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "").length / text.length
  if (text.length >= 16 && printable < 0.7) return { state: "unreadable", hostname: null }
  const clean = cleanText(text)
  if (/BITReader_Tool|RESULTADO: (?:OK|ERROR)/.test(clean)) return { state: "bitreader", hostname: null }
  const tail = clean.slice(-400).trimEnd()
  const hostname = /([\w.-]+) login:$/i.exec(tail)?.[1] ?? /(?:^|\n)[\w.-]+@([\w.-]+)[^\n]*[#$]$/.exec(tail)?.[1] ?? null
  for (const [state, re] of PROMPTS) if (re.test(tail)) return { state, hostname }
  let best: { state: ClassifiedState; at: number } | null = null
  for (const [state, re] of BANNERS) {
    for (const m of clean.matchAll(re)) if (!best || m.index >= best.at) best = { state, at: m.index }
  }
  return best ? { state: best.state, hostname } : { state: "silent", hostname: null }
}

/** The last `maxLines` lines, ANSI stripped, other control characters shown as "·" (≤ 600 chars). */
export function printableSample(text: string, maxLines = 6): string {
  const lines = cleanText(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "·")
    .split("\n")
  while (lines.length && lines[lines.length - 1] === "") lines.pop()
  return lines.slice(-maxLines).join("\n").slice(-600)
}
