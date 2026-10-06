"use client"

import { NetworkIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import { useLiveState } from "@/hooks/use-live-state"
import type { EquipnetStatusDTO } from "@/lib/contracts/equipnet"
import type { ServerEventType } from "@/lib/contracts/events"
import { equipnetUi as t } from "@/lib/i18n/equipnet"
import { reduceEquipnetMaybe, showOffer } from "./equipnet-model"

const EVENTS: readonly ServerEventType[] = ["equipnet.changed"]

/**
 * Banco and Descubrimiento (admins): "Hay adaptadores de red sin configurar · Configurar red de equipos". Passive: it
 * only links to Sistema › Red de equipos, where the admin chooses the interface. Nothing happens on the server.
 */
export function EquipnetOfferCard({ status: initial, className }: { status: EquipnetStatusDTO | null; className?: string }) {
  const status = useLiveState(initial, EVENTS, reduceEquipnetMaybe)
  if (!status || !showOffer(status)) return null
  return (
    <InlineAlert
      tone="info"
      icon={NetworkIcon}
      className={className}
      title={t.offerTitle}
      actions={<Button asChild variant="primary" size="sm"><AppLink href="/sistema/red-equipos">{t.offerAction}</AppLink></Button>}
    >
      {t.offerBody}{status.leftovers.items.length ? ` ${t.offerLeftovers}` : ""}
    </InlineAlert>
  )
}
