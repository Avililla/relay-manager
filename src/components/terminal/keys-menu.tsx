"use client"

import * as React from "react"
import { KeyboardIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { TERMINAL_KEYS, terminal as t } from "@/lib/i18n/shell"

/**
 * "Teclas" (§8.9): bytes the browser will not let a page capture over HTTP (Ctrl+W, Ctrl+T…), plus BREAK.
 * Disabled items explain that the equipment must be reserved.
 */
export function KeysMenu({ canWrite, onSend, onBreak, size = "icon-sm" }: {
  canWrite: boolean
  onSend: (bytes: string) => void
  onBreak: () => void
  size?: "icon-sm" | "icon"
}) {
  return (
    <DropdownMenu>
      <SimpleTooltip label={t.keys}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size={size} aria-label={t.keys}>
            <KeyboardIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>{canWrite ? t.keysMenu : t.keysNeedReservation}</DropdownMenuLabel>
        {TERMINAL_KEYS.map((k) => (
          <DropdownMenuItem key={k.id} disabled={!canWrite} onSelect={() => onSend(k.bytes)}>
            {k.label.includes("+") ? <Kbd className="font-sans">{k.label}</Kbd> : <span>{k.label}</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!canWrite} onSelect={onBreak}>
          <span className="font-mono">BREAK</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
