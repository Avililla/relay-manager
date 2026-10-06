// Console status → icon + Spanish label + tone (§8.6). Pure, shared by chips, strips and the terminal overlay.
import {
  BanIcon, CircleAlertIcon, CircleDashedIcon, CircleDotIcon, CirclePauseIcon, LoaderCircleIcon, PlugZapIcon, ShieldAlertIcon, UnplugIcon,
  type LucideIcon,
} from "lucide-react"
import type { ConsoleStatus } from "@/lib/contracts/enums"
import type { CaptureState, ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { captureStateLabel, consoleStatusLabel } from "@/lib/i18n/status"
import { formatTime } from "@/lib/i18n/format"
import { serial } from "@/lib/i18n/shell"
import { shortName } from "@/lib/i18n/banco"

export type ConsoleTone = "ok" | "warn" | "danger" | "neutral"

export interface ConsoleStatusView {
  tone: ConsoleTone
  /** null = the RX lamp is the icon. */
  icon: LucideIcon | null
  label: string
  /** Whether the lamp is lit (data in the last 5 s). */
  receiving: boolean
}

/** Data within this window counts as "Recibiendo" (§8.6). */
export const RECEIVING_WINDOW_MS = 5000

const PROBLEMS: ReadonlySet<ConsoleStatus> = new Set(["missing", "no-permission", "busy", "released", "unbound", "error"])

/** Statuses where the pane shows the dimmed terminal + an alert with the cause (§8.9). */
export function isPortProblem(s: ConsoleStatus): boolean {
  return PROBLEMS.has(s)
}

/**
 * `now` is server time (useServerNow) when known; without it, an open console shows "Sin datos" semantics only
 * from `lastRxAt`. `stale` (no live connection for > 5 s) never lights the lamp. `withTimes: false` leaves the
 * clock times out of the labels: the server render and the hydration pass use it, because `formatTime` depends
 * on the runtime's time zone and the server's may differ from the browser's.
 */
export function consoleStatusView(r: ConsoleRuntimeDTO, now?: number, stale = false, withTimes = true): ConsoleStatusView {
  const time = (iso: string | null | undefined) => (iso && withTimes ? formatTime(iso) : null)
  switch (r.status) {
    case "open": {
      const last = r.lastRxAt ? Date.parse(r.lastRxAt) : Number.NaN
      const receiving = !stale && now !== undefined && Number.isFinite(last) && now - last < RECEIVING_WINDOW_MS
      if (receiving) return { tone: "ok", icon: null, label: serial.receiving, receiving: true }
      const since = time(r.lastRxAt)
      return { tone: "neutral", icon: null, label: since ? serial.noDataSince(since) : serial.noData, receiving: false }
    }
    case "opening":
      return { tone: "neutral", icon: LoaderCircleIcon, label: serial.opening, receiving: false }
    case "error":
      return { tone: "danger", icon: CircleAlertIcon, label: serial.error(r.detail), receiving: false }
    case "missing":
      return { tone: "danger", icon: PlugZapIcon, label: consoleStatusLabel("missing"), receiving: false }
    case "no-permission":
      return { tone: "danger", icon: ShieldAlertIcon, label: consoleStatusLabel("no-permission"), receiving: false }
    case "busy":
      return { tone: "warn", icon: BanIcon, label: consoleStatusLabel("busy"), receiving: false }
    case "released":
      return {
        tone: "warn",
        icon: UnplugIcon,
        label: r.released ? serial.releasedBy(shortName(r.released.byName), time(r.released.until)) : consoleStatusLabel("released"),
        receiving: false,
      }
    case "unbound":
      return { tone: "neutral", icon: CircleDashedIcon, label: serial.noAdapter, receiving: false }
  }
}

export interface CaptureView { tone: "neutral" | "warn"; icon: LucideIcon | null; label: string; tooltip: string | null }

/** Capture badge (§8.9 pane toolbar): active → "Grabando"; paused-disk → warn; disabled/off → faint. */
export function captureView(c: CaptureState): CaptureView {
  switch (c) {
    case "active": return { tone: "neutral", icon: CircleDotIcon, label: captureStateLabel("active"), tooltip: serial.captureTooltip }
    case "paused-disk": return { tone: "warn", icon: CirclePauseIcon, label: captureStateLabel("paused-disk"), tooltip: null }
    case "disabled": return { tone: "neutral", icon: null, label: captureStateLabel("disabled"), tooltip: null }
    case "off": return { tone: "neutral", icon: null, label: captureStateLabel("off"), tooltip: null }
  }
}
