import * as React from "react"
import { cn } from "@/lib/client/cn"

/**
 * The «Rosa» theme's icon in the theme menus: a bubblegum-pink disc with candy sprinkles (lemon, turquoise, lime) and
 * a white rim. Fixed hex colours so it previews the theme from any other theme; decorative (the option's label names it).
 */
export function RosaSwatch({ className }: { className?: string; "aria-hidden"?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-4 shrink-0", className)}>
      <circle cx="8" cy="8" r="6.6" fill="#e0237f" stroke="#ffd1e8" strokeWidth="1.2" />
      <circle cx="5.6" cy="6" r="1.25" fill="#ffe45c" />
      <circle cx="10.4" cy="5.4" r="1.05" fill="#5cefe0" />
      <circle cx="9.2" cy="10.4" r="1.25" fill="#7cf29a" />
      <circle cx="5.4" cy="10.2" r="0.8" fill="#ffffff" />
    </svg>
  )
}
