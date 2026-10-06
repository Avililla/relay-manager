"use client"

import * as React from "react"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { parseThemePref, type ThemePref } from "@/lib/client/theme"
import { useThemePreference } from "@/hooks/use-theme"
import { shell } from "@/lib/i18n/shell"
import { RosaSwatch } from "./theme-swatch"

type ThemeIcon = React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>

export const THEME_OPTIONS: Array<{ value: ThemePref; label: string; icon: ThemeIcon }> = [
  { value: "dark", label: shell.themeDark, icon: MoonIcon },
  { value: "light", label: shell.themeLight, icon: SunIcon },
  { value: "system", label: shell.themeSystem, icon: MonitorIcon },
  { value: "rosa", label: shell.themeRosa, icon: RosaSwatch },
]

/** Radio items for the theme; reused inside the user menu below 640 px and by Mi cuenta. */
export function ThemeRadioItems() {
  const [pref, setPref] = useThemePreference()
  return (
    <DropdownMenuRadioGroup value={pref} onValueChange={(v) => setPref(parseThemePref(v))}>
      {THEME_OPTIONS.map((o) => (
        <DropdownMenuRadioItem key={o.value} value={o.value}>
          <o.icon aria-hidden />
          {o.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

/** TopBar theme menu: "Oscuro (predeterminado)" · "Claro" · "Sistema" (D39) · "Rosa". */
export function ThemeToggle({ className }: { className?: string }) {
  const [pref] = useThemePreference()
  const current = THEME_OPTIONS.find((o) => o.value === pref) ?? THEME_OPTIONS[0]
  return (
    <DropdownMenu>
      <SimpleTooltip label={`${shell.theme}: ${current.label}`}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className={className} aria-label={`${shell.theme}: ${current.label}`}>
            <current.icon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{shell.theme}</DropdownMenuLabel>
        <ThemeRadioItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
