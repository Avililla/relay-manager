import type { ConsoleStatus } from "@/lib/contracts/enums"

/** Below this pane width the actions (Buscar, Copiar, Descargar, Maximizar) move into "⋯" (§8.9). */
export const NARROW_PANE_PX = 520
/** Below these widths the channel strip drops, in order: the label (with the actions), the adapter, the capture badge, the line summary. */
const ADAPTER_MIN_PX = 400
const CAPTURE_MIN_PX = 340
const LINE_MIN_PX = 290

export interface PaneToolbarLayout {
  actionsInMenu: boolean
  label: boolean
  adapter: boolean
  line: boolean
  capture: boolean
}

/**
 * What the 28 px pane toolbar shows at a given pane width (0 = not measured yet: everything, as on the server).
 * Lamp, KEY, "Teclas" and "⋯" always stay. The signature channel strip (adapter, line, capture) survives the common
 * two-consoles-plus-relay-rail layout (~470 px) and folds one part at a time below it. An unbound console has
 * nothing to record, so it never shows the capture badge.
 */
export function paneToolbarLayout(width: number, status: ConsoleStatus): PaneToolbarLayout {
  const fits = (min: number) => width === 0 || width >= min
  return {
    actionsInMenu: !fits(NARROW_PANE_PX),
    label: fits(NARROW_PANE_PX),
    adapter: fits(ADAPTER_MIN_PX),
    line: fits(LINE_MIN_PX),
    capture: status !== "unbound" && fits(CAPTURE_MIN_PX),
  }
}
