"use client"

import * as React from "react"
import type { Terminal as XTerm } from "@xterm/xterm"
import type { FitAddon } from "@xterm/addon-fit"
import type { SearchAddon } from "@xterm/addon-search"
import { resolvedSnapshot } from "@/hooks/use-theme"
import { monoFamily, terminalFontFamily, terminalThemeFor } from "./theme"
import { useTerminalTheme } from "./use-terminal-theme"

export interface XtermKit {
  term: XTerm
  fit: FitAddon
  search: SearchAddon | null
  /** The renderer actually in use (WebGL falls back to DOM on context loss or when unavailable). */
  renderer: "webgl" | "dom"
}

export interface XtermOptions {
  renderer: "webgl" | "dom"
  fontSize: number
  scrollback: number
  cursorBlink: boolean
  screenReaderMode: boolean
  /** Read-only mini terminals (LivePreview) ignore keyboard input. */
  disableStdin?: boolean
  withSearch?: boolean
}

/**
 * Mount-only xterm lifecycle (§8.10, effect 1): loads xterm and its addons on the client, waits for the mono font,
 * opens the terminal, refits on host resize (ResizeObserver, rAF-throttled) and disposes on unmount. Option
 * changes (font size, scrollback, screen-reader mode, cursor blink) and theme switches (Rosa has its own palette)
 * are applied to the live terminal.
 * Returns null until the terminal is open.
 */
export function useXterm(host: React.RefObject<HTMLDivElement | null>, opts: XtermOptions): XtermKit | null {
  const [kit, setKit] = React.useState<XtermKit | null>(null)
  const initial = React.useRef(opts)
  const palette = useTerminalTheme()

  React.useEffect(() => {
    const el = host.current
    if (!el) return
    let disposed = false
    let ro: ResizeObserver | null = null
    let raf = 0
    let term: XTerm | null = null
    const o = initial.current

    void (async () => {
      const [{ Terminal }, { FitAddon }, searchMod] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        o.withSearch ? import("@xterm/addon-search") : Promise.resolve(null),
      ])
      const first = monoFamily()
      if (first && typeof document !== "undefined" && "fonts" in document) {
        try {
          await document.fonts.load(`${o.fontSize}px ${first}`)
        } catch {
          // The fallback monospace font is fine.
        }
      }
      if (disposed) return
      term = new Terminal({
        fontFamily: terminalFontFamily(),
        fontSize: o.fontSize,
        lineHeight: 1.2,
        scrollback: o.scrollback,
        convertEol: false,
        cursorBlink: o.cursorBlink,
        cursorStyle: "block",
        allowProposedApi: false,
        theme: terminalThemeFor(resolvedSnapshot()),
        screenReaderMode: o.screenReaderMode,
        disableStdin: !!o.disableStdin,
        customGlyphs: true,
        drawBoldTextInBrightColors: true,
        // OSC 8 hyperlinks sent by the device under test must never open URLs.
        linkHandler: { activate: () => {} },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      const search = searchMod ? new searchMod.SearchAddon() : null
      if (search) term.loadAddon(search)
      term.open(el)
      let renderer: "webgl" | "dom" = "dom"
      if (o.renderer === "webgl") {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl")
          if (disposed) return
          const gl = new WebglAddon()
          gl.onContextLoss(() => {
            gl.dispose()
            setKit((k) => (k ? { ...k, renderer: "dom" } : k))
          })
          term.loadAddon(gl)
          renderer = "webgl"
        } catch {
          renderer = "dom"
        }
      }
      if (disposed) return
      try {
        fit.fit()
      } catch {
        // Not laid out yet: the observer fits it.
      }
      ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
          try {
            fit.fit()
          } catch {
            // Hidden pane (tab not visible).
          }
        })
      })
      ro.observe(el)
      const t = term
      setKit({ term: t, fit, search, renderer })
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro?.disconnect()
      term?.dispose()
      setKit(null)
    }
  }, [host])

  React.useEffect(() => {
    if (!kit) return
    const t = kit.term
    if (t.options.fontSize !== opts.fontSize) {
      t.options.fontSize = opts.fontSize
      try {
        kit.fit.fit()
      } catch {
        // Hidden pane.
      }
    }
    if (t.options.scrollback !== opts.scrollback) t.options.scrollback = opts.scrollback
    if (t.options.cursorBlink !== opts.cursorBlink) t.options.cursorBlink = opts.cursorBlink
    if (t.options.screenReaderMode !== opts.screenReaderMode) t.options.screenReaderMode = opts.screenReaderMode
  }, [kit, opts.fontSize, opts.scrollback, opts.cursorBlink, opts.screenReaderMode])

  React.useEffect(() => {
    if (kit && kit.term.options.theme !== palette) kit.term.options.theme = palette
  }, [kit, palette])

  return kit
}
