"use client"

import * as React from "react"
import { useMediaQuery } from "@/hooks/use-media-query"
import { Breadcrumbs } from "./breadcrumbs"
import { CapturePausedChip, ReservationExpiryChip, UnassignedPortsLink } from "./chips"
import { ConnectionIndicator } from "./connection-indicator"
import { MobileNavTrigger } from "./mobile-nav-trigger"
import { ThemeToggle } from "./theme-toggle"
import { UserMenu } from "./user-menu"

/**
 * 48 px top bar (§8.1). Left: menu button (< 1024 px) and breadcrumb. Right: connection, near-expiry chip,
 * admin chips, theme toggle (in the user menu below 640 px) and the user menu.
 */
export function TopBar() {
  const narrow = useMediaQuery("(max-width: 639px)")
  return (
    <header data-slot="top-bar" className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2 sm:px-4">
      <MobileNavTrigger />
      <Breadcrumbs className="mr-auto pl-1 lg:pl-0" />
      <div className="flex shrink-0 items-center gap-1.5">
        <ConnectionIndicator className="max-md:hidden" />
        <ConnectionIndicator compact className="md:hidden" />
        <ReservationExpiryChip />
        <UnassignedPortsLink />
        <CapturePausedChip />
        <ThemeToggle className="max-sm:hidden" />
        <UserMenu themeInMenu={narrow} />
      </div>
    </header>
  )
}
