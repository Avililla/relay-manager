"use client"

import * as React from "react"
import type { SearchAddon } from "@xterm/addon-search"
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { terminal as t } from "@/lib/i18n/shell"

/** Small search bar over the terminal (§8.10): Enter next, Shift+Enter previous, Esc closes. */
export function TerminalSearchBar({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
  const [q, setQ] = React.useState("")
  const [miss, setMiss] = React.useState(false)
  const find = (dir: "next" | "prev") => {
    if (!q) return
    const hit = dir === "next" ? search.findNext(q, { caseSensitive: false }) : search.findPrevious(q, { caseSensitive: false })
    setMiss(!hit)
  }
  return (
    <div role="search" className="absolute top-2 right-3 z-20 flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-overlay">
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setMiss(false)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            find(e.shiftKey ? "prev" : "next")
          } else if (e.key === "Escape") {
            e.preventDefault()
            search.clearDecorations()
            onClose()
          }
        }}
        aria-label={t.searchPlaceholder}
        aria-invalid={miss || undefined}
        placeholder={t.searchPlaceholder}
        spellCheck={false}
        className="h-7 w-44 rounded-sm bg-muted px-2 font-mono text-data text-foreground placeholder:text-faint-foreground aria-invalid:text-danger focus-visible:outline-offset-0"
      />
      <Button variant="ghost" size="icon-sm" aria-label={t.searchPrev} onClick={() => find("prev")}><ChevronUpIcon aria-hidden /></Button>
      <Button variant="ghost" size="icon-sm" aria-label={t.searchNext} onClick={() => find("next")}><ChevronDownIcon aria-hidden /></Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t.searchClose}
        onClick={() => {
          search.clearDecorations()
          onClose()
        }}
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  )
}
