"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { ChevronRightIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { nav } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"
import { activeNavItem } from "./nav"
import { useShell, type Breadcrumb } from "./shell-context"

/**
 * TopBar breadcrumb (§8.1): from PageMeta, else the active rail item. Below 640 px only the last segment shows.
 * The last segment is the current page (`aria-current="page"`), never a link.
 */
export function Breadcrumbs({ className }: { className?: string }) {
  const { breadcrumbs } = useShell()
  const pathname = usePathname()
  const fallback = activeNavItem(pathname)
  const items: Breadcrumb[] = breadcrumbs?.length ? breadcrumbs : fallback ? [{ label: fallback.label }] : []
  if (!items.length) return null
  return (
    <nav aria-label={nav.breadcrumb} className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1 text-body">
        {items.map((b, i) => {
          const last = i === items.length - 1
          return (
            <li key={`${i}-${b.label}`} className={cn("flex min-w-0 items-center gap-1", !last && "max-sm:hidden", last ? "shrink" : "shrink-[2]")}>
              {last ? (
                <span aria-current="page" className="truncate font-medium text-foreground">{b.label}</span>
              ) : b.href ? (
                <AppLink href={b.href} className="truncate text-muted-foreground hover:text-foreground hover:underline">{b.label}</AppLink>
              ) : (
                <span className="truncate text-muted-foreground">{b.label}</span>
              )}
              {!last ? <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-faint-foreground" /> : null}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
