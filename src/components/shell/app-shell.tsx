"use client"

import * as React from "react"
import { useBuildCheck } from "@/hooks/use-build-check"
import { useServerToasts } from "@/hooks/use-server-toasts"
import { nav } from "@/lib/i18n/shell"
import { AppRail } from "./app-rail"
import { BannerStrip } from "./chips"
import { useShell } from "./shell-context"
import { TopBar } from "./top-bar"

/**
 * The authenticated frame (§8.1): optional banner strip, rail (≥ 1024 px), 48 px top bar and ONE scroll container,
 * `main`. Workspaces fill `main` (`h-full`) and scroll inside their own panes.
 *
 * `main` and the frame are positioned (`relative`) so every absolutely positioned descendant (each `sr-only`
 * label, for one) is laid out and clipped inside them. Otherwise those boxes hang off the initial containing
 * block, the document itself becomes scrollable, and an anchor link or `scrollIntoView` shifts the top bar and
 * rail off-screen.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { shell } = useShell()
  useBuildCheck(shell.buildId)
  useServerToasts()
  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2"
      >
        {nav.skipToContent}
      </a>
      <BannerStrip />
      <div className="flex min-h-0 flex-1">
        <AppRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main id="main" tabIndex={-1} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-none">
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
