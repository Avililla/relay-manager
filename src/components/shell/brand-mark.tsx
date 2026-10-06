import * as React from "react"
import { cn } from "@/lib/client/cn"

/**
 * The app mark: a console channel strip (three lines, the first with a lit cobalt lamp) on a graphite tile.
 * Same geometry and colours as public/icon.svg (hex, so it also renders where oklch() is missing). In the «Rosa»
 * theme globals.css recolours the parts through the `rm-mark-*` classes, hides the channel lines and shows a
 * lollipop (`rm-mark-pop`, hidden in the other themes).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-7 shrink-0", className)}>
      <rect className="rm-mark-tile" width="32" height="32" rx="7" fill="#1a1d20" />
      <rect className="rm-mark-rim" x="0.5" y="0.5" width="31" height="31" rx="6.5" fill="none" stroke="#3b4145" />
      <circle className="rm-mark-lamp" cx="9" cy="10" r="2.25" fill="#63aaec" />
      <rect className="rm-mark-line" x="13.5" y="9" width="11" height="2" rx="1" fill="#e7eaec" />
      <circle className="rm-mark-dim" cx="9" cy="16" r="2.25" fill="none" stroke="#848a8f" strokeWidth="1.5" />
      <rect className="rm-mark-dim-line" x="13.5" y="15" width="8" height="2" rx="1" fill="#a5aaae" />
      <circle className="rm-mark-dim" cx="9" cy="22" r="2.25" fill="none" stroke="#848a8f" strokeWidth="1.5" />
      <rect className="rm-mark-dim-line" x="13.5" y="21" width="9.5" height="2" rx="1" fill="#a5aaae" />
      {/* «Rosa» only: a lollipop (lemon candy, bubblegum swirl, white stick) in place of the channel lines. */}
      <g className="rm-mark-pop">
        <path d="M22.5 17 L25.5 28.5" stroke="#fff4fa" strokeWidth="2" strokeLinecap="round" />
        <circle cx="21" cy="12" r="7" fill="#ffe45c" />
        <path d="M21 12A0.8 0.8 0 0 1 22.61 12A1.61 1.61 0 0 1 19.39 12A2.42 2.42 0 0 1 24.22 12A3.22 3.22 0 0 1 17.78 12A4.02 4.02 0 0 1 25.83 12" fill="none" stroke="#ff3d9a" strokeWidth="1.3" strokeLinecap="round" />
      </g>
    </svg>
  )
}
