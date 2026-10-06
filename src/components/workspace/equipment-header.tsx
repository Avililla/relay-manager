"use client"

import * as React from "react"
import { useSelectedLayoutSegment } from "next/navigation"
import { ActivityIcon, EllipsisIcon, NetworkIcon, SettingsIcon, SquareTerminalIcon, ToggleRightIcon, UnplugIcon } from "lucide-react"
import { accessUi } from "@/lib/i18n/accesses"
import { toast } from "sonner"
import { releaseConsolePort } from "@/actions/consoles"
import { AppLink } from "@/components/common/app-link"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tag } from "@/components/ui/tag"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { ReservationControl, ReservationExpiryAlert } from "@/components/reservation/reservation-control"
import type { ActionResult } from "@/lib/contracts/common"
import { interpretActionResult, networkFailure } from "@/lib/client/action-result"
import { useLiveState } from "@/hooks/use-live-state"
import { workspace as t } from "@/lib/i18n/banco"
import { cn } from "@/lib/client/cn"
import { useEquipment } from "./equipment-context"
import { ReleasePortDialog } from "./release-dialog"
import { reduceConsoleList } from "./runtime-merge"

const tabClass = cn(
  "relative inline-flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-body font-medium whitespace-nowrap text-muted-foreground",
  "hover:text-foreground focus-visible:outline-offset-[-2px] [&_svg]:size-4 [&_svg]:shrink-0",
  "after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent",
  "aria-[current=page]:text-foreground aria-[current=page]:after:bg-brand",
)

/** Route tabs of the workspace (§8.9): "Consolas" (or "Relés" with 0 consoles), "Accesos", "Actividad", "Ajustes" (admins). */
function WorkspaceTabs() {
  const { equipment, viewer } = useEquipment()
  const segment = useSelectedLayoutSegment()
  const base = `/equipos/${equipment.id}`
  const relaysOnly = equipment.consoleCount === 0 && equipment.relayCount > 0
  const tabs = [
    { href: base, seg: null, label: relaysOnly ? t.tabRelays : t.tabConsoles, icon: relaysOnly ? ToggleRightIcon : SquareTerminalIcon },
    { href: `${base}/accesos`, seg: "accesos", label: accessUi.tab, icon: NetworkIcon },
    { href: `${base}/actividad`, seg: "actividad", label: t.tabActivity, icon: ActivityIcon },
    ...(viewer.isAdmin ? [{ href: `${base}/ajustes`, seg: "ajustes", label: t.tabSettings, icon: SettingsIcon }] : []),
  ]
  return (
    <nav aria-label={t.sections} className="-mb-px flex min-w-0 items-stretch gap-1 overflow-x-auto [scrollbar-width:none]">
      {tabs.map((tab) => {
        const Icon = tab.icon
        const active = segment === tab.seg
        return (
          <AppLink key={tab.href} href={tab.href} aria-current={active ? "page" : undefined} className={tabClass}>
            <Icon aria-hidden />
            {tab.label}
          </AppLink>
        )
      })}
    </nav>
  )
}

const CONSOLE_STATUS_EVENTS = ["console.status"] as const

/**
 * Workspace "⋯" (§8.9, P2): "Soltar todos los puertos…" for whoever may write the consoles (the holder, or an admin
 * while the unit is free). Unassigned and already released ports are skipped.
 */
function WorkspaceMenu() {
  const { equipment, canWriteConsoles } = useEquipment()
  const consoles = useLiveState(equipment.consoles, CONSOLE_STATUS_EVENTS, (s, e) => reduceConsoleList(s, e, equipment.id))
  const [open, setOpen] = React.useState(false)
  if (!canWriteConsoles || !consoles.length) return null
  const targets = consoles.filter((c) => c.runtime.status !== "unbound" && c.runtime.status !== "released")
  return (
    <>
      <DropdownMenu>
        <SimpleTooltip label={t.workspaceMenu}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t.workspaceMenu}><EllipsisIcon aria-hidden /></Button>
          </DropdownMenuTrigger>
        </SimpleTooltip>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem disabled={!targets.length} onSelect={() => setOpen(true)}>
            <UnplugIcon aria-hidden />
            {t.releaseAll}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ReleasePortDialog
        open={open}
        onOpenChange={setOpen}
        title={t.releaseAllTitle(equipment.name)}
        description={t.releaseAllBody}
        confirmLabel={t.releaseAllConfirm}
        onConfirm={async (minutes) => {
          let ok = 0
          let firstError: string | null = null
          for (const c of targets) {
            let r: ActionResult<unknown>
            try {
              r = await releaseConsolePort({ consoleId: c.id, durationMin: minutes })
            } catch {
              r = networkFailure()
            }
            const outcome = interpretActionResult(r, window.location.pathname)
            if (outcome.kind === "redirect") {
              window.location.assign(outcome.to)
              return false
            }
            if (outcome.kind === "ok") ok++
            else firstError ??= outcome.message
          }
          if (ok) toast.success(t.releasedAll(ok))
          if (firstError) toast.error(firstError)
          return ok > 0
        }}
      />
    </>
  )
}

/**
 * Workspace header (§8.9): name (the page's h1), template, S/N and the reservation bar, then the route tabs and,
 * for the holder near expiry, the visible expiry alert.
 */
export function EquipmentHeader() {
  const { equipment, isHolder } = useEquipment()
  return (
    <header className="shrink-0 border-b bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-3 pb-2 md:px-6">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h1 className="min-w-0 truncate text-title text-foreground">{equipment.name}</h1>
          {equipment.templateName ? <Tag className="self-center">{equipment.templateName}</Tag> : null}
          {equipment.serialNumber ? (
            <span className="font-mono text-data text-muted-foreground">
              <span className="sr-only">{t.serialNumber}: </span>
              {equipment.serialNumber}
            </span>
          ) : null}
        </div>
        {/* Phones, holder: one full-width row (chip left; "Mantener" and "⋯" right). */}
        <div className={cn("ml-auto flex min-w-0 items-center gap-2", isHolder && "max-sm:w-full")}>
          <ReservationControl />
          <WorkspaceMenu />
        </div>
      </div>
      <div className="px-2 md:px-4">
        <WorkspaceTabs />
      </div>
    </header>
  )
}

export { ReservationExpiryAlert }
