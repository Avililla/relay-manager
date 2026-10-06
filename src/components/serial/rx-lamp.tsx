"use client"

import * as React from "react"
import type { IsoDate } from "@/lib/contracts/common"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { cn } from "@/lib/client/cn"
import { createDecayLamp, type DecayLamp } from "@/lib/client/decay-lamp"

const MIN_FLASH_GAP_MS = 100 // ≤ 10 Hz
const REDUCED_LIT_MS = 1000

/**
 * RX lamp (§8.5): flashes on every new `lastRxAt` (opacity 1 → 0.3 in 250 ms, at most 10 Hz). With reduced motion it
 * stays lit while data arrived in the last second. `stale` keeps it unlit (no live connection). Decorative: the
 * status text next to it carries the meaning. The timing lives in one `DecayLamp` for the lamp's lifetime: its decay
 * timer is re-armed by every pulse and cleared only on unmount, so the lamp always goes off.
 */
export function RxLamp({ lastRxAt, stale = false, className }: { lastRxAt: IsoDate | null; stale?: boolean; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const lampRef = React.useRef<DecayLamp | null>(null)
  const reduced = useReducedMotion()
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const lamp = createDecayLamp((lit) => (lit ? el.setAttribute("data-lit", "") : el.removeAttribute("data-lit")), { minGapMs: MIN_FLASH_GAP_MS })
    lampRef.current = lamp
    return () => {
      lamp.dispose()
      lampRef.current = null
      el.removeAttribute("data-lit")
    }
  }, [])
  React.useEffect(() => {
    const lamp = lampRef.current
    if (!lamp) return
    if (stale) lamp.off()
    else if (lastRxAt) lamp.pulse(reduced ? REDUCED_LIT_MS : 16)
  }, [lastRxAt, stale, reduced])
  return (
    <span
      ref={ref}
      aria-hidden
      className={cn("rx-lamp inline-block h-2.5 w-1.5 shrink-0 rounded-[1px]", stale ? "bg-faint-foreground" : "bg-ok", className)}
    />
  )
}
