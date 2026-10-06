"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { AppLink } from "@/components/common/app-link"
import { PageMeta } from "@/components/shell/page-meta"
import { system as t } from "@/lib/i18n/admin"
import { SYSTEM_TABS, activeSystemTab, systemTabLabel } from "./system-model"
import { cn } from "@/lib/client/cn"

/** Fades the clipped edge(s) of the scrolling strip. */
const FADE = "24px"
function edgeMask(start: boolean, end: boolean): string | undefined {
  if (!start && !end) return undefined
  return `linear-gradient(to right, ${start ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${end ? "transparent" : "black"})`
}

/**
 * Sistema sub-navigation (§8.9: "sub-nav tabs as routes"). A `nav` of links styled like the underline tabs; the
 * current one has `aria-current="page"`. Links go through AppLink, so a dirty settings form asks before leaving.
 * Scrolls sideways on narrow screens instead of wrapping: the clipped edge fades out so it reads as "more this way",
 * and the current tab is scrolled into view when the route changes.
 */
export function SystemTabs() {
  const pathname = usePathname()
  const active = activeSystemTab(pathname)
  const label = systemTabLabel(pathname)
  const listRef = React.useRef<HTMLUListElement>(null)
  const [edges, setEdges] = React.useState({ start: false, end: false })
  const measure = React.useCallback(() => {
    const ul = listRef.current
    if (!ul) return
    const start = ul.scrollLeft > 1
    const end = ul.scrollLeft + ul.clientWidth < ul.scrollWidth - 1
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }))
  }, [])
  React.useEffect(() => {
    const ul = listRef.current
    if (!ul) return
    const ro = new ResizeObserver(measure)
    ro.observe(ul)
    return () => ro.disconnect()
  }, [measure])
  React.useEffect(() => {
    // Only the strip scrolls (never the page): bring the current tab fully into view with a fade's width to spare.
    const ul = listRef.current
    const el = ul?.querySelector<HTMLElement>("[aria-current=page]")
    if (!ul || !el) return
    const left = el.offsetLeft
    const right = left + el.offsetWidth
    if (right > ul.scrollLeft + ul.clientWidth) ul.scrollLeft = right - ul.clientWidth + 24
    else if (left < ul.scrollLeft) ul.scrollLeft = Math.max(0, left - 24)
    measure()
  }, [active, measure])
  const mask = edgeMask(edges.start, edges.end)
  return (
    <>
    <PageMeta breadcrumbs={label && active !== "/sistema" ? [{ label: t.title, href: "/sistema" }, { label }] : [{ label: t.title }]} />
    <nav aria-label={t.tabsLabel} className="-mx-4 border-b md:-mx-6">
      <ul
        ref={listRef}
        onScroll={measure}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="relative flex h-10 items-stretch gap-1 overflow-x-auto px-3 [scrollbar-width:none] md:px-5"
      >
        {SYSTEM_TABS.map((tab) => {
          const current = tab.href === active
          return (
            <li key={tab.href} className="flex">
              <AppLink
                href={tab.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative inline-flex shrink-0 items-center px-2.5 text-body font-medium whitespace-nowrap text-muted-foreground",
                  "hover:text-foreground focus-visible:outline-offset-[-2px]",
                  "after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent",
                  current && "text-foreground after:bg-brand",
                )}
              >
                {tab.label}
              </AppLink>
            </li>
          )
        })}
      </ul>
    </nav>
    </>
  )
}
