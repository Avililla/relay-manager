"use client"

import * as React from "react"
import { applyThemeDecision } from "@/lib/client/theme-account"

/**
 * Keeps <html> on the right theme after the root layout re-renders (router.refresh, a resync after reconnecting): React
 * then patches `data-theme` with the server's value, which is only a placeholder for "Sistema" (dark) and may be older
 * than a change applied live. Runs the inline script's precedence again, before paint. `account` is the layout's
 * `data-theme-user` (null when signed out).
 */
export function ThemeAttrSync({ account }: { account: string | null }) {
  React.useLayoutEffect(() => {
    applyThemeDecision(account)
  }, [account])
  return null
}
