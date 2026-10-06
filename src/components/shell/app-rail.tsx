"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { AppLink } from "@/components/common/app-link"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { nav } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"
import { BrandMark } from "./brand-mark"
import { activeNavItem, navGroupsFor, type NavItem } from "./nav"
import { useShell } from "./shell-context"

/** Rail item: icon + label; `aria-current="page"` on the active one (surface-2 + brand icon, never a hue fill). */
function RailLink({ item, active, collapsed, onNavigate }: { item: NavItem; active: boolean; collapsed: boolean; onNavigate?: () => void }) {
  const link = (
    <AppLink
      data-slot="rail-link"
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={cn(
        "group/rail flex h-8 items-center gap-2.5 rounded-md px-2 text-body text-muted-foreground tint-transition",
        "hover:bg-secondary hover:text-foreground aria-[current=page]:bg-secondary aria-[current=page]:font-medium aria-[current=page]:text-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <item.icon aria-hidden className="size-4 shrink-0 text-faint-foreground group-hover/rail:text-muted-foreground group-aria-[current=page]/rail:text-brand" />
      <span className={cn("truncate", collapsed && "sr-only")}>{item.label}</span>
    </AppLink>
  )
  return collapsed ? <SimpleTooltip label={item.label} side="right">{link}</SimpleTooltip> : link
}

/**
 * Navigation content shared by the desktop rail and the mobile sheet. `mode="auto"` shows labels from 1280 px and
 * icons only between 1024 and 1279 px (§8.1).
 */
export function RailNav({ mode, onNavigate }: { mode: "auto" | "full"; onNavigate?: () => void }) {
  const { shell } = useShell()
  const pathname = usePathname()
  const active = activeNavItem(pathname)
  const groups = navGroupsFor(shell.viewer.isAdmin, { filesEnabled: shell.filesEnabled })
  const renderGroups = (collapsed: boolean) => (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.id} role="group" aria-label={g.label ?? nav.banco} className="flex flex-col gap-0.5">
          {g.label ? (
            collapsed ? <div aria-hidden className="mx-2 mb-1 h-px bg-border" /> : <div aria-hidden className="px-2 pb-1 text-micro text-faint-foreground">{g.label}</div>
          ) : null}
          {g.items.map((item) => (
            <RailLink key={item.href} item={item} active={active?.href === item.href} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </div>
  )
  if (mode === "full") return renderGroups(false)
  return (
    <>
      <div className="max-xl:hidden">{renderGroups(false)}</div>
      <div className="xl:hidden">{renderGroups(true)}</div>
    </>
  )
}

export function RailBrand({ collapsible = true }: { collapsible?: boolean }) {
  const { shell } = useShell()
  return (
    <AppLink href="/" className={cn("flex h-12 shrink-0 items-center gap-2.5 px-3.5", collapsible && "max-xl:justify-center max-xl:px-0")}>
      <BrandMark className="size-6" />
      <span className={cn("min-w-0 truncate text-body font-semibold text-foreground", collapsible && "max-xl:sr-only")}>{shell.labName}</span>
    </AppLink>
  )
}

/** Desktop rail (≥ 1024 px): a `nav` landmark; collapses to icons below 1280 px. */
export function AppRail() {
  return (
    <nav aria-label={nav.mainNav} className="flex w-14 shrink-0 flex-col border-r bg-card max-lg:hidden xl:w-56">
      <RailBrand />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <RailNav mode="auto" />
      </div>
    </nav>
  )
}
