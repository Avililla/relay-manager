/** Spanish formatting helpers (§8.7). Pure: usable on server and client. */

/** `plural(n, { one, other })`; "#" is replaced by the number. */
export function plural(n: number, forms: { one: string; other: string }): string {
  const rule = new Intl.PluralRules("es").select(n)
  return (rule === "one" ? forms.one : forms.other).replaceAll("#", new Intl.NumberFormat("es-ES").format(n))
}

const INTEGER = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0, useGrouping: "always" })

/** "10.000", "1.000", "512": es-ES digit grouping from four digits (the number inputs and their help texts). */
export function formatInteger(n: number): string {
  return INTEGER.format(n)
}

/**
 * Reads what a person types in a number input: "10.000", "10 000" and "10000" are all ten thousand (dots and
 * spaces group digits); a comma is the decimal separator. null when it is not a number.
 */
export function parseInteger(raw: string): number | null {
  const t = raw.trim().replace(/[.\s\u00a0\u202f]/g, "").replace(",", ".")
  if (t === "") return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

const toDate = (v: string | Date): Date => (v instanceof Date ? v : new Date(v))

/** "23/9/2026, 13:42:05" in the browser's zone (or the given one). */
export function formatDateTime(v: string | Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone,
  }).format(toDate(v))
}

/** "13:42" */
export function formatTime(v: string | Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(toDate(v))
}

/** Binary units with Spanish decimals: "1,5 KiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const s = new Intl.NumberFormat("es-ES", { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)
  return `${s} ${units[i]}`
}

/** "m:ss", or "h:mm:ss" from one hour; negative → "0:00". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}
