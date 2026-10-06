"use client"

import * as React from "react"
import { AlertTriangleIcon, CableIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon, EthernetPortIcon, LoaderCircleIcon, SquareTerminalIcon, type LucideIcon } from "lucide-react"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import type { AccessKind, AccessRuntimeDTO } from "@/lib/contracts/accesses"
import { ACCESS_KIND_LABEL } from "@/lib/i18n/accesses"
import { cableTitle } from "@/lib/accesses/labels"
import { cn } from "@/lib/client/cn"
import { accessStatusLabel, accessTone } from "./access-model"

export const KIND_ICON: Record<AccessKind, LucideIcon> = { jtag: CableIcon, serial: SquareTerminalIcon, tcp: EthernetPortIcon }

export function AccessKindIcon({ kind, className }: { kind: AccessKind; className?: string }) {
  const Icon = KIND_ICON[kind]
  return <Icon aria-label={ACCESS_KIND_LABEL[kind]} role="img" className={cn("size-4 shrink-0 text-muted-foreground", className)} />
}

const STATUS_ICON: Record<ChipTone, LucideIcon> = {
  ok: CircleCheckIcon, brand: LoaderCircleIcon, neutral: CircleDashedIcon, warn: AlertTriangleIcon, danger: CircleXIcon,
}

/** Lamp + Spanish state ("Abierto", "Cable no conectado"…); never colour alone. */
export function AccessStatusChip({ runtime, quiet = false, className }: { runtime: AccessRuntimeDTO; quiet?: boolean; className?: string }) {
  const tone = accessTone(runtime)
  return (
    <StatusChip tone={tone} icon={STATUS_ICON[tone]} quiet={quiet} className={className} iconClassName={runtime.status === "starting" ? "animate-spin motion-reduce:animate-none" : undefined}>
      {accessStatusLabel(runtime)}
    </StatusChip>
  )
}

/** "JTAG-07 · 210299A1B2C3": the label first, the serial second (muted, monospace). */
export function CableName({ name, serial, className }: { name: string | null; serial: string | null; className?: string }) {
  const t = cableTitle(name, serial)
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1.5", className)}>
      <span className={cn("truncate", !name && "font-mono text-data")}>{t.primary}</span>
      {t.secondary ? <span className="truncate font-mono text-data text-muted-foreground">{t.secondary}</span> : null}
    </span>
  )
}
