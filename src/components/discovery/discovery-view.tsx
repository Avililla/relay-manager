"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { Page, PageHeader } from "@/components/common/page"
import { PageMeta } from "@/components/shell/page-meta"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { DiscoveredBoardDTO } from "@/lib/contracts/relays"
import type { SerialPageDTO } from "@/lib/contracts/serial"
import { discovery as t, hardwarePages } from "@/lib/i18n/hardware"
import type { AssignEquipment } from "./assign-dialog"
import { RelayDiscoveryPanel, type RegisteredHost } from "./relay-discovery-panel"
import { SerialPortsPanel } from "./serial-ports-panel"
import { JtagCablesPanel } from "@/components/accesses/jtag-cables-panel"
import type { CableLabelDTO, HwServerInfoDTO, JtagSnapshotDTO } from "@/lib/contracts/accesses"
import { cablesUi } from "@/lib/i18n/accesses"
import type { EquipnetStatusDTO } from "@/lib/contracts/equipnet"
import { equipnetUi } from "@/lib/i18n/equipnet"
import { NetAdaptersPanel } from "@/components/equipnet/net-adapters-panel"

export type DiscoveryTab = "serie" | "reles" | "jtag" | "red"
const TABS: readonly DiscoveryTab[] = ["serie", "reles", "jtag", "red"]

/**
 * Descubrimiento (§8.9): tabs "Puertos serie" and "Placas de relés" (`?tab=serie|reles`). Both tabs are rendered
 * on the server and stay mounted (`forceMount`, the inactive one `hidden`): each keeps its live subscription, so a
 * hot-plug or a board found while the other tab is shown is already there on switching. Switching only rewrites
 * the URL (`history.replaceState`, which Next syncs into `useSearchParams`); the URL is the only source of the active
 * tab, so a soft navigation to /descubrimiento from inside the page selects "Puertos serie" again. `tab` is the
 * server's reading of the same URL.
 */
export function DiscoveryView({ serial, boards, registered, equipment, scanDefaults, jtag, equipnet }: {
  tab: DiscoveryTab
  serial: SerialPageDTO
  boards: DiscoveredBoardDTO[]
  registered: RegisteredHost[]
  equipment: AssignEquipment[]
  scanDefaults: { cidrs: string[]; ports: number[] }
  jtag: { snapshot: JtagSnapshotDTO; labels: CableLabelDTO[]; hwServer: HwServerInfoDTO }
  equipnet: EquipnetStatusDTO
}) {
  const param = useSearchParams().get("tab")
  const active: DiscoveryTab = TABS.find((x) => x === param) ?? "serie"
  const change = (v: string) => {
    const next: DiscoveryTab = TABS.find((x) => x === v) ?? "serie"
    const url = new URL(window.location.href)
    url.searchParams.set("tab", next)
    // `null`, not `history.state`: Next skips its own state (`__NA`) and would not sync useSearchParams.
    window.history.replaceState(null, "", url)
  }
  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: hardwarePages.discovery }]} />
      <PageHeader title={t.title} />
      <Tabs value={active} onValueChange={change}>
        <TabsList aria-label={t.tabsLabel}>
          <TabsTrigger value="serie">{t.tabSerial}</TabsTrigger>
          <TabsTrigger value="reles">{t.tabRelays}</TabsTrigger>
          <TabsTrigger value="jtag">{cablesUi.tabJtag}</TabsTrigger>
          <TabsTrigger value="red">{equipnetUi.tabAdapters}</TabsTrigger>
        </TabsList>
        <TabsContent value="serie" forceMount hidden={active !== "serie"} className="pt-1">
          <SerialPortsPanel data={serial} equipment={equipment} active={active === "serie"} />
        </TabsContent>
        <TabsContent value="reles" forceMount hidden={active !== "reles"} className="pt-1">
          <RelayDiscoveryPanel known={boards} registered={registered} scanDefaults={scanDefaults} />
        </TabsContent>
        <TabsContent value="jtag" forceMount hidden={active !== "jtag"} className="pt-1">
          <JtagCablesPanel jtag={jtag.snapshot} labels={jtag.labels} hwServer={jtag.hwServer} />
        </TabsContent>
        <TabsContent value="red" forceMount hidden={active !== "red"} className="pt-1">
          <NetAdaptersPanel status={equipnet} />
        </TabsContent>
      </Tabs>
    </Page>
  )
}
