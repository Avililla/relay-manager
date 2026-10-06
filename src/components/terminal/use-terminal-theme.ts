"use client"

import type { ITheme } from "@xterm/xterm"
import { useResolvedTheme } from "@/hooks/use-theme"
import { terminalThemeFor } from "./theme"

/** The xterm palette of the theme applied to <html>; follows theme switches live (MutationObserver on data-theme). */
export function useTerminalTheme(): ITheme {
  return terminalThemeFor(useResolvedTheme())
}
