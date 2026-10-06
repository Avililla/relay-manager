"use client"

import * as React from "react"
import type { ShellDTO } from "@/lib/contracts/system"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ShellProvider } from "@/components/shell/shell-context"
import { syncThemeFromStorage } from "@/hooks/use-theme"
import { AccountThemeSync } from "./account-theme-sync"
import { EventsProvider } from "./events-provider"
import { ServerClockProvider } from "./server-clock-provider"
import { UnsavedChangesProvider } from "./unsaved-changes-provider"

/**
 * Client runtime for every authenticated page (§8.8): server clock (seeded from ShellDTO.serverNow), SSE events,
 * shell data (viewer, breadcrumbs, live lab name and reservations), the account theme (adoption and live changes),
 * the unsaved-changes guard and tooltips.
 */
export function AppProviders({ shell, children }: { shell: ShellDTO; children: React.ReactNode }) {
  React.useEffect(() => {
    window.addEventListener("storage", syncThemeFromStorage)
    return () => window.removeEventListener("storage", syncThemeFromStorage)
  }, [])
  return (
    <TooltipProvider>
      <ServerClockProvider serverNow={shell.serverNow}>
        <EventsProvider viewerId={shell.viewer.id}>
          <AccountThemeSync viewerId={shell.viewer.id} theme={shell.viewer.theme} />
          <ShellProvider shell={shell}>
            <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
          </ShellProvider>
        </EventsProvider>
      </ServerClockProvider>
    </TooltipProvider>
  )
}
