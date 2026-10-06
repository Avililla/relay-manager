"use client"

import * as React from "react"
import "@xterm/xterm/css/xterm.css"
import { Spinner } from "@/components/common/spinner"
import { Button } from "@/components/ui/button"
import { useConsoleSocket } from "@/components/terminal/use-console-socket"
import { useXterm } from "@/components/terminal/use-xterm"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { serial, terminal as t } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

const ROWS = 8
const FONT = 11

/**
 * Read-only mini terminal on `/ws/preview/<stableKey>` (§8.8, admin only): 8 lines, 11 px, always the DOM renderer
 * (keeps WebGL contexts ≤ panes). Unmount it before binding the port (the server closes previews on bind anyway).
 */
export function LivePreview({ stableKey, devNode, baudRate = 115200, className }: { stableKey: string; devNode: string; baudRate?: number; className?: string }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const reduced = useReducedMotion()
  const kit = useXterm(hostRef, { renderer: "dom", fontSize: FONT, scrollback: 1000, cursorBlink: false, screenReaderMode: false, disableStdin: true })
  const path = kit ? `/ws/preview/${encodeURIComponent(stableKey)}?baud=${baudRate}` : null
  const socket = useConsoleSocket(path, {
    onReset: () => kit?.term.reset(),
    onData: (b) => kit?.term.write(b),
  })
  const s = socket.state
  const unavailable = s.kind === "closed" && (s.action === "not-found" || s.action === "too-many")
  return (
    <figure className={cn("flex min-w-0 flex-col overflow-hidden rounded-md border", className)} aria-label={serial.previewLabel(devNode)}>
      <figcaption className="flex h-7 items-center justify-between gap-2 border-b bg-secondary px-2 font-mono text-data text-muted-foreground">
        <span className="truncate">{devNode}</span>
        <span className="shrink-0 tabular-nums">{baudRate}</span>
      </figcaption>
      <div className="rm-term relative" style={{ backgroundColor: "var(--xterm-bg)", height: `${Math.ceil(ROWS * FONT * 1.2) + 8}px` }}>
        <div ref={hostRef} className={cn("h-full px-1.5 py-1", unavailable && "opacity-40")} aria-hidden={unavailable || undefined} />
        {s.kind !== "open" && !unavailable ? (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner label={serial.previewConnecting} showLabel={reduced} />
          </div>
        ) : null}
        {unavailable ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
            <p className="text-meta text-foreground">{s.kind === "closed" && s.action === "too-many" ? t.tooMany : serial.previewUnavailable}</p>
            <Button size="sm" onClick={socket.retry}>{t.retry}</Button>
          </div>
        ) : null}
      </div>
    </figure>
  )
}
