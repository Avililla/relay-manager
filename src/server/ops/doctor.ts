// `relay-manager doctor` output (§4.14): Spanish lines, ANSI colours only on a TTY, summary, exit 1 only on FAIL.
import type { HealthCheckDTO, HealthLevel } from "@/lib/contracts/system"

const TAG: Record<HealthLevel, string> = { ok: "[ OK ]", warn: "[AVISO]", fail: "[FALLO]", info: "[INFO]" }
const COLOUR: Record<HealthLevel, string> = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", info: "\x1b[36m" }
const RESET = "\x1b[0m"

export function summarize(checks: readonly HealthCheckDTO[]): { fails: number; warns: number } {
  return { fails: checks.filter((c) => c.level === "fail").length, warns: checks.filter((c) => c.level === "warn").length }
}

export function doctorExitCode(checks: readonly HealthCheckDTO[]): number {
  return checks.some((c) => c.level === "fail") ? 1 : 0
}

export function formatCheck(c: HealthCheckDTO, color: boolean): string {
  const tag = color ? `${COLOUR[c.level]}${TAG[c.level]}${RESET}` : TAG[c.level]
  const pad = " ".repeat(Math.max(1, 8 - TAG[c.level].length))
  let line = `${tag}${pad}${c.label}: ${c.message}`
  if (c.hint) line += `\n         → ${c.hint}`
  return line
}

export function formatDoctorReport(checks: readonly HealthCheckDTO[], opts: { color: boolean; header?: string; onlyProblems?: boolean }): string {
  const lines: string[] = []
  if (opts.header) lines.push(opts.header, "")
  for (const c of checks) {
    if (opts.onlyProblems && c.level !== "warn" && c.level !== "fail") continue
    lines.push(formatCheck(c, opts.color))
  }
  const s = summarize(checks)
  lines.push("", `${s.fails} fallo(s), ${s.warns} aviso(s)`)
  return lines.join("\n") + "\n"
}
