"use client"

import * as React from "react"
import { UsbIcon, ServerIcon } from "lucide-react"
import { MiddleTruncate } from "@/components/common/middle-truncate"
import { NewRowChip } from "@/components/common/spinner"
import { StatusChip } from "@/components/common/status-chip"
import { Tag } from "@/components/ui/tag"
import type { PortGroup, SerialPortDTO } from "@/lib/contracts/serial"
import { cn } from "@/lib/client/cn"
import { hintLabel, portShortName, portStatusView } from "./port-status"

/**
 * One port group (§8.9): an adapter header (label, location, VID:PID, serial, hint chips) or the pseudo-group
 * "Puertos virtuales y del sistema" (no identity chips), then its ports with status and an actions slot.
 * `isNew(stableKey)` marks hot-plugged rows with `animate-new-row`.
 */
export function AdapterGroup({ group, renderPortActions, isNew, className, headerAside }: {
  group: PortGroup
  renderPortActions?: (port: SerialPortDTO) => React.ReactNode
  isNew?: (stableKey: string) => boolean
  className?: string
  headerAside?: React.ReactNode
}) {
  const a = group.adapter
  const headingId = React.useId()
  return (
    <section aria-labelledby={headingId} className={cn("rounded-lg border bg-card", className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2.5">
        {a ? <UsbIcon aria-hidden className="size-4 text-muted-foreground" /> : <ServerIcon aria-hidden className="size-4 text-muted-foreground" />}
        <h3 id={headingId} className="min-w-0 truncate text-body font-semibold text-foreground">{a ? a.label : group.label}</h3>
        {a ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <Tag mono>{a.location}</Tag>
            <Tag mono>{`${a.vendorId}:${a.productId}`}</Tag>
            {a.serial ? <Tag mono>{a.serial}</Tag> : null}
            {a.hints.map((h) => <Tag key={h} tone="warn">{hintLabel(h)}</Tag>)}
          </span>
        ) : null}
        {headerAside ? <span className="ml-auto flex items-center gap-2">{headerAside}</span> : null}
      </header>
      <ul className="divide-y">
        {group.ports.map((p) => {
          const st = portStatusView(p)
          return (
            <li key={p.stableKey} className={cn("grid min-h-10 grid-cols-[3rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-4 py-1.5 md:grid-cols-[3rem_6rem_minmax(0,1fr)_auto_auto]", isNew?.(p.stableKey) && "animate-new-row")}>
              <span className="font-mono text-data font-semibold text-foreground">{portShortName(p)}</span>
              <span className="font-mono text-data text-muted-foreground max-md:hidden">{p.name}</span>
              <span className="min-w-0">
                {/* Paths truncate in the middle (§8.3), keeping the file name that tells rows apart when the name column is hidden. */}
                {p.byId ? <MiddleTruncate value={p.byId} tail={22} className="text-muted-foreground" /> : <MiddleTruncate value={p.devNode} tail={Math.max(12, p.devNode.length - p.devNode.lastIndexOf("/"))} className="text-muted-foreground" />}
              </span>
              <span className="flex items-center gap-2 max-md:col-start-2">
                <StatusChip tone={st.tone} icon={st.icon} quiet={st.free}>{st.label}</StatusChip>
                {isNew?.(p.stableKey) ? <NewRowChip /> : null}
              </span>
              {renderPortActions ? <span className="flex items-center justify-end gap-1 max-md:col-start-2 max-md:justify-start">{renderPortActions(p)}</span> : <span className="max-md:hidden" />}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
