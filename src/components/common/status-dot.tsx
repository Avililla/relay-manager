import * as React from "react"
import { cn } from "@/lib/client/cn"

export type StatusTone = "ok" | "warn" | "danger" | "brand" | "faint"

const FILL: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  brand: "bg-brand",
  faint: "bg-faint-foreground",
}

const RING: Record<StatusTone, string> = {
  ok: "border-ok",
  warn: "border-warn",
  danger: "border-danger",
  brand: "border-brand",
  faint: "border-faint-foreground",
}

/** An 8 px lamp. Decorative: always pair it with a text label (colour is never the only carrier, §8.6). */
export function StatusDot({ tone, hollow = false, className }: { tone: StatusTone; hollow?: boolean; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", hollow ? cn("border-[1.5px]", RING[tone]) : FILL[tone], className)} />
}
