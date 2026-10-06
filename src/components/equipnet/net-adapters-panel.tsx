"use client"

import * as React from "react"
import { EthernetPortIcon, SettingsIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { StatusChip } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { useLiveState } from "@/hooks/use-live-state"
import type { EquipnetStatusDTO, NetAdapterDTO } from "@/lib/contracts/equipnet"
import type { ServerEventType } from "@/lib/contracts/events"
import { equipnetUi as t } from "@/lib/i18n/equipnet"
import { cn } from "@/lib/client/cn"
import { EquipnetOfferCard } from "./equipnet-offer-card"
import { reduceEquipnet } from "./equipnet-model"

const EVENTS: readonly ServerEventType[] = ["equipnet.changed"]

/** Descubrimiento › Red: the network adapters (hot-plug) and which one is the equipment network (chosen in Sistema). */
export function NetAdaptersPanel({ status: initial }: { status: EquipnetStatusDTO }) {
  const status = useLiveState(initial, EVENTS, reduceEquipnet)
  return (
    <div className="flex flex-col gap-4" data-testid="net-adapters">
      <EquipnetOfferCard status={status.offerSetup ? status : null} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-[80ch] text-meta text-muted-foreground">{t.adapterHelp}</p>
        <Button asChild size="sm" variant="ghost"><AppLink href="/sistema/red-equipos"><SettingsIcon aria-hidden />{t.title}</AppLink></Button>
      </div>
      {!status.adapters.length ? <p className="text-body text-muted-foreground">{t.noInterfaces}</p> : (
        <ul className="flex flex-col gap-2">
          {status.adapters.map((a) => <AdapterRow key={a.mac} a={a} />)}
        </ul>
      )}
    </div>
  )
}

function AdapterRow({ a }: { a: NetAdapterDTO }) {
  return (
    <li className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2", a.problem && "opacity-90")} data-adapter={a.ifname}>
      <EthernetPortIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-body text-foreground">
          {a.labelName ? <span className="font-mono font-medium">{a.labelName} · </span> : null}
          {[a.manufacturer, a.product].filter(Boolean).join(" ") || a.driver || a.ifname}
        </span>
        <span className="font-mono text-data text-muted-foreground">
          {a.ifname} · {a.mac}{a.location ? ` · ${a.location}` : ""}{a.addresses.length ? ` · ${a.addresses.join(", ")}` : ""}
        </span>
        {a.problem ? <span className="text-meta text-muted-foreground">{t.adapterReadOnly}: {a.problem}</span> : a.warning && !a.chosen ? <span className="text-meta text-muted-foreground">{a.warning}</span> : null}
      </div>
      {a.chosen ? <StatusChip tone="brand">{t.equipmentNetwork}</StatusChip> : null}
      <StatusChip tone={a.carrier ? "ok" : "neutral"} quiet>{t.adapterCarrier[String(a.carrier)]}{a.speedMbps ? ` · ${t.speed(a.speedMbps)}` : ""}</StatusChip>
    </li>
  )
}
