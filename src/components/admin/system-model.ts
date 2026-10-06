// Pure model of the Sistema screens: settings patches, backup labels, config-file inspection and health summaries.
import { ConfigExportV1Schema } from "@/lib/contracts/config-io"
import type { SettingsDTO, UpdateSettingsInput } from "@/lib/contracts/settings"
import type { HealthCheckDTO, HealthGroup, HealthLevel } from "@/lib/contracts/system"
import { backupLabels, system as t } from "@/lib/i18n/admin"

// ---------------------------------------------------------------------------------------------------------------
// Sub-navigation
// ---------------------------------------------------------------------------------------------------------------

export const SYSTEM_TABS = [
  { href: "/sistema", label: t.tabs.general },
  { href: "/sistema/reservas", label: t.tabs.reservas },
  { href: "/sistema/consolas", label: t.tabs.consolas },
  { href: "/sistema/copias", label: t.tabs.copias },
  { href: "/sistema/salud", label: t.tabs.salud },
  { href: "/sistema/accesos", label: t.tabs.accesos },
  { href: "/sistema/red-equipos", label: t.tabs.redEquipos },
  { href: "/sistema/acerca", label: t.tabs.acerca },
] as const

/** Which Sistema tab a path belongs to ("/sistema" only matches itself). */
export function activeSystemTab(pathname: string): string | null {
  const hit = SYSTEM_TABS.find((tab) => (tab.href === "/sistema" ? pathname === "/sistema" : pathname === tab.href || pathname.startsWith(`${tab.href}/`)))
  return hit?.href ?? null
}

/** The label of the active tab (breadcrumb "Sistema / Copias"). */
export function systemTabLabel(pathname: string): string | null {
  const href = activeSystemTab(pathname)
  return SYSTEM_TABS.find((tab) => tab.href === href)?.label ?? null
}

// ---------------------------------------------------------------------------------------------------------------
// Settings forms
// ---------------------------------------------------------------------------------------------------------------

export type SettingsKey = keyof UpdateSettingsInput
export type SettingsDraft<K extends SettingsKey> = Pick<SettingsDTO, K>

export function pickSettings<K extends SettingsKey>(s: SettingsDTO, keys: readonly K[]): SettingsDraft<K> {
  const out = {} as SettingsDraft<K>
  for (const k of keys) out[k] = s[k]
  return out
}

const norm = (v: unknown): unknown => (typeof v === "string" ? v.trim() : v)

/** The changed keys only (the action takes a partial patch). Strings are trimmed; an empty banner becomes null. */
export function settingsPatch<K extends SettingsKey>(base: SettingsDraft<K>, draft: SettingsDraft<K>, keys: readonly K[]): UpdateSettingsInput {
  const patch: Record<string, unknown> = {}
  for (const k of keys) {
    let v: unknown = norm(draft[k])
    if (k === "bannerText" && v === "") v = null
    const b = k === "bannerText" && norm(base[k]) === "" ? null : norm(base[k])
    if (v !== b) patch[k] = v
  }
  return patch as UpdateSettingsInput
}

export function settingsDirty<K extends SettingsKey>(base: SettingsDraft<K>, draft: SettingsDraft<K>, keys: readonly K[]): boolean {
  return Object.keys(settingsPatch(base, draft, keys)).length > 0
}

/** The server's cross-field rule (warning < timeout), checked locally for an inline error before saving. */
export function reservationWarningError(timeoutMin: number, warningMin: number): string | null {
  return warningMin >= timeoutMin ? t.warningTooLong : null
}

// ---------------------------------------------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------------------------------------------

/** Spanish "Tipo" for a backup label (§4.14): daily, manual, pre-migrate, pre-upgrade-<a>-to-<b>, pre-restore, import… */
export function backupLabel(label: string): string {
  const up = /^pre-upgrade-(.+)-to-(.+)$/.exec(label)
  if (up) return backupLabels.preUpgrade(up[1], up[2])
  if (label.startsWith("pre-upgrade")) return backupLabels.preUpgradeShort
  switch (label) {
    case "daily": return backupLabels.daily
    case "manual": return backupLabels.manual
    case "pre-migrate": return backupLabels["pre-migrate"]
    case "pre-restore": return backupLabels["pre-restore"]
    case "import": return backupLabels.import
    case "portable": return backupLabels.portable
    default: return label
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Config import
// ---------------------------------------------------------------------------------------------------------------

export const CONFIG_IMPORT_MAX_CHARS = 2_000_000

export type ConfigFileCheck =
  | { ok: true; appVersion: string; exportedAt: string; counts: { roles: number; templates: number; boards: number; equipment: number } }
  | { ok: false; reason: string }

/**
 * A quick local look at the chosen file before the server's dry run: size, JSON and the export format.
 * The server stays the authority (importConfig with dryRun) and reports duplicates and warnings.
 */
export function inspectConfigFile(text: string): ConfigFileCheck {
  if (text.length > CONFIG_IMPORT_MAX_CHARS) return { ok: false, reason: t.importTooLarge }
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return { ok: false, reason: t.importNotJson }
  }
  if (typeof v !== "object" || v === null || (v as { format?: unknown }).format !== "relay-manager-config") {
    return { ok: false, reason: t.importWrongFormat }
  }
  const parsed = ConfigExportV1Schema.safeParse(v)
  if (!parsed.success) return { ok: false, reason: t.importWrongFormat }
  const c = parsed.data
  return {
    ok: true, appVersion: c.appVersion, exportedAt: c.exportedAt,
    counts: { roles: c.roles.length, templates: c.templates.length, boards: c.boards.length, equipment: c.equipment.length },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------------------------

export const HEALTH_GROUP_ORDER: readonly HealthGroup[] = ["runtime", "data", "serial", "relays", "accesses", "network", "clock", "service"]
const SEVERITY: Record<HealthLevel, number> = { fail: 3, warn: 2, info: 1, ok: 0 }

export function worstLevel(levels: readonly HealthLevel[]): HealthLevel {
  return levels.reduce<HealthLevel>((w, l) => (SEVERITY[l] > SEVERITY[w] ? l : w), "ok")
}

export interface HealthGroupView { group: HealthGroup; checks: HealthCheckDTO[]; worst: HealthLevel }

/** Groups in the §8.9 order (Runtime, Datos, Serie, Relés, Red, Reloj, Servicio); checks keep the server order. */
export function groupHealth(checks: readonly HealthCheckDTO[]): HealthGroupView[] {
  return HEALTH_GROUP_ORDER.map((group) => {
    const list = checks.filter((c) => c.group === group)
    return { group, checks: list, worst: worstLevel(list.map((c) => c.level)) }
  }).filter((g) => g.checks.length > 0)
}

/**
 * The same groups ordered for triage: groups with a failure first, then those with a warning, then the rest (each
 * tier keeps the §8.9 order); inside a group, checks go fail → warn → info → ok (stable within a level).
 */
export function prioritizeHealth(groups: readonly HealthGroupView[]): HealthGroupView[] {
  const tier = (g: HealthGroupView) => (g.worst === "fail" ? 0 : g.worst === "warn" ? 1 : 2)
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => tier(a.g) - tier(b.g) || a.i - b.i)
    .map(({ g }) => ({
      ...g,
      checks: g.checks.map((c, i) => ({ c, i })).sort((a, b) => SEVERITY[b.c.level] - SEVERITY[a.c.level] || a.i - b.i).map(({ c }) => c),
    }))
}

/** Keeps only the checks that need attention (fail, warn) and drops the groups left empty. */
export function onlyHealthIssues(groups: readonly HealthGroupView[]): HealthGroupView[] {
  return groups
    .map((g) => ({ ...g, checks: g.checks.filter((c) => c.level === "fail" || c.level === "warn") }))
    .filter((g) => g.checks.length > 0)
}

export interface HintSegment { text: string; code: boolean }

const COMMAND_START = /^(?:sudo|chmod|chown|relay-manager|systemctl|usermod|udevadm|apt|timedatectl|journalctl|\.\/install\.sh)$/
const COMMAND_STOP = new Set(["y", "o", "muestra", "crea", "genera", "en", "para", "si"])

/**
 * Splits a health hint into prose and shell commands so the commands render in mono with a copy button:
 * "Restaura la última copia: relay-manager restore <copia>" → prose "Restaura la última copia: " + code.
 * A command starts at a known program at the start or after ": ", "; " or "(", and runs until a Spanish connective
 * ("y", "o", "muestra"…), a token that opens a parenthesis, or a token that ends with "," or ")".
 */
export function hintSegments(hint: string): HintSegment[] {
  const tokens = hint.split(/( +)/)
  const out: HintSegment[] = []
  const push = (text: string, code: boolean) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.code === code && !code) last.text += text
    else out.push({ text, code })
  }
  let code: string[] | null = null
  let prev = ""
  const flush = () => {
    if (code) push(code.join("").trimEnd(), true)
    code = null
  }
  for (const tok of tokens) {
    if (/^ +$/.test(tok)) {
      if (code) code.push(tok)
      else push(tok, false)
      continue
    }
    if (code) {
      if (COMMAND_STOP.has(tok) || tok.startsWith("(")) {
        const trailing = code.join("").match(/ +$/)?.[0] ?? ""
        flush()
        push(trailing + tok, false)
      } else if (/[,)]$/.test(tok)) {
        code.push(tok.slice(0, -1))
        flush()
        push(tok.slice(-1), false)
      } else code.push(tok)
    } else {
      const bare = tok.replace(/^\(/, "")
      const atBoundary = prev === "" || /[:;]$/.test(prev) || tok.startsWith("(")
      if (atBoundary && COMMAND_START.test(bare)) {
        if (bare !== tok) push("(", false)
        code = [bare]
      } else push(tok, false)
    }
    prev = tok
  }
  flush()
  return out
}

export function healthCounts(checks: readonly HealthCheckDTO[]): Record<HealthLevel, number> & { worst: HealthLevel } {
  const c = { ok: 0, warn: 0, fail: 0, info: 0 }
  for (const x of checks) c[x.level]++
  return { ...c, worst: worstLevel(checks.map((x) => x.level)) }
}

// ---------------------------------------------------------------------------------------------------------------
// Acerca de
// ---------------------------------------------------------------------------------------------------------------

/** "3 d 4 h", "2 h 15 min", "5 min", "menos de 1 min". */
export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h ? `${d} d ${h} h` : `${d} d`
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`
  if (m > 0) return `${m} min`
  return t.uptimeUnderMinute
}
