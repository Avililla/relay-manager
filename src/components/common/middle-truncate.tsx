"use client"

import * as React from "react"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/client/cn"
import { CopyButton } from "./copy-button"

/**
 * Long paths truncate in the middle (§8.3): "/dev/serial/by-id/usb-FTDI_Qu…-if02-port0". The tail keeps
 * `tail` characters (the distinctive part of by-id names); the full value is in a tooltip and the copy button.
 * Pure CSS: the head shrinks with an ellipsis, the tail never does.
 */
export function MiddleTruncate({ value, tail = 16, copy = false, copyLabel, mono = true, className }: {
  value: string
  tail?: number
  copy?: boolean
  copyLabel?: string
  mono?: boolean
  className?: string
}) {
  const cut = Math.max(0, value.length - tail)
  const head = value.slice(0, cut)
  const end = value.slice(cut)
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1", className)}>
      <SimpleTooltip label={<span className="font-mono break-all">{value}</span>}>
        {/* Focusable for the tooltip. The full value is sr-only text: aria-label is not allowed on a span with no role. */}
        <span tabIndex={0} className={cn("relative flex min-w-0 rounded-sm", mono && "font-mono text-data")}>
          <span aria-hidden className="min-w-0 truncate">{head}</span>
          <span aria-hidden className="shrink-0 whitespace-pre">{end}</span>
          <span className="sr-only">{value}</span>
        </span>
      </SimpleTooltip>
      {copy ? <CopyButton value={value} label={copyLabel} /> : null}
    </span>
  )
}
