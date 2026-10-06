"use client"

import * as React from "react"
import { setMyTheme } from "@/actions/account"
import type { ServerEventType } from "@/lib/contracts/events"
import type { ThemePref } from "@/lib/contracts/enums"
import { browserStorage } from "@/lib/client/prefs"
import { adoptStoredTheme } from "@/lib/client/theme-account"
import { applyAccountTheme } from "@/hooks/use-theme"
import { useServerEvents } from "./events-provider"

const EVENTS: readonly ServerEventType[] = ["account.prefs.changed"]

/**
 * The account theme in a signed-in page (D39):
 * - first login after the upgrade: an account without a theme adopts this browser's earlier choice, once;
 * - `account.prefs.changed` (the same user on another tab or PC) applies the new theme here at once.
 */
export function AccountThemeSync({ viewerId, theme }: { viewerId: string; theme: ThemePref | null }) {
  const adopted = React.useRef(false)
  React.useEffect(() => {
    if (adopted.current) return
    adopted.current = true
    void adoptStoredTheme(theme, { storage: browserStorage(), save: (p) => setMyTheme({ theme: p }) })
  }, [theme])
  useServerEvents(EVENTS, (e) => {
    if (e.type === "account.prefs.changed" && e.userId === viewerId) applyAccountTheme(e.theme)
  })
  return null
}
