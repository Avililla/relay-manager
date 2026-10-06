import os from "node:os"
import type { Metadata } from "next"
import type { AssignEquipment } from "@/components/discovery/assign-dialog"
import { DiscoveryView } from "@/components/discovery/discovery-view"
import { defaultScanCidrs } from "@/components/discovery/relay-model"
import { hardwarePages } from "@/lib/i18n/hardware"
import { listBoards } from "@/server/queries/boards"
import { listEquipmentCards } from "@/server/queries/equipment"
import { getDiscoveredBoards } from "@/server/queries/relay-discovery"
import { getSerialPageData } from "@/server/queries/serial"
import { getRuntime } from "@/server/runtime/registry"
import { keptSearch, requireAdminPage } from "../placas/_lib/require-admin-page"

export const metadata: Metadata = { title: hardwarePages.discovery }

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

/** Descubrimiento (§8.9, admin): serial adapters and relay boards, both live. `?tab=serie|reles`. */
export default async function DescubrimientoPage({ searchParams }: Props) {
  const sp = await searchParams
  const user = await requireAdminPage(`/descubrimiento${keptSearch(sp, ["tab"])}`)
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab
  const tab = rawTab === "reles" ? "reles" : rawTab === "jtag" ? "jtag" : rawTab === "red" ? "red" : "serie"
  const rt = getRuntime()
  const [serial, boards, registered, cards] = await Promise.all([
    getSerialPageData(user), getDiscoveredBoards(), listBoards(), listEquipmentCards(user),
  ])
  const equipment: AssignEquipment[] = cards.map((e) => ({
    id: e.id,
    name: e.name,
    templateName: e.templateName,
    consoles: e.consoles.map((c) => ({ id: c.id, key: c.key, label: c.label, bound: c.matchBy !== null, adapterShort: c.adapterShort })),
    reservedBy: e.reservation && e.reservation.holderId !== user.id ? e.reservation.holderName : null,
  }))
  const scanDefaults = {
    cidrs: rt.config.relays.scanCidrs ?? defaultScanCidrs(os.networkInterfaces()),
    ports: rt.config.relays.scanPorts,
  }
  return (
    <DiscoveryView
      tab={tab}
      serial={serial}
      boards={boards}
      registered={registered.map((b) => ({ id: b.id, name: b.name, host: b.host }))}
      equipment={equipment}
      scanDefaults={scanDefaults}
      jtag={{ snapshot: rt.accesses.jtag(), labels: rt.accesses.labels(), hwServer: rt.accesses.hwServer() }}
      equipnet={rt.equipnet.status()}
    />
  )
}
