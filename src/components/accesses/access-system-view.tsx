"use client"

import * as React from "react"
import { CableIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { DataTable, type DataColumn } from "@/components/common/data-table"
import { Section } from "@/components/common/page"
import { Button } from "@/components/ui/button"
import { useLiveState } from "@/hooks/use-live-state"
import type { AccessPortRowDTO, AccessSystemDTO, JtagCableDTO } from "@/lib/contracts/accesses"
import type { ServerEventType } from "@/lib/contracts/events"
import { ACCESS_KIND_LABEL, ACCESS_POLICY_LABEL, accessSystemUi as t, cablesUi, JTAG_FAMILY_LABEL } from "@/lib/i18n/accesses"
import { cableProduct } from "@/lib/accesses/labels"
import { AccessKindIcon, AccessStatusChip, CableName } from "./access-bits"
import { useLiveCables } from "./use-live-cables"
import { remoteHost } from "./access-model"

const ACCESS_EVENTS: readonly ServerEventType[] = ["access.status"]

/** Sistema > Accesos: the bench's port map, hw_server and the JTAG cables (live). */
export function AccessSystemView({ data }: { data: AccessSystemDTO }) {
  const ports = useLiveState(data.ports, ACCESS_EVENTS, (s, e) => (e.type === "access.status" ? s.map((p) => (p.accessId === e.accessId ? { ...p, runtime: e.runtime } : p)) : s))
  const live = useLiveCables(data.jtag, data.labels)
  const { settings, hwServer } = data
  const total = settings.range.to - settings.range.from + 1 - (settings.httpPort >= settings.range.from && settings.httpPort <= settings.range.to ? 1 : 0)
  const columns: Array<DataColumn<AccessPortRowDTO>> = [
    { id: "port", header: t.port, cell: (p) => <span className="font-mono text-data tabular-nums text-foreground">{p.port}</span>, sortValue: (p) => p.port, searchValue: (p) => String(p.port) },
    {
      id: "equipment", header: t.equipment, sortValue: (p) => p.equipmentName, searchValue: (p) => p.equipmentName,
      cell: (p) => <AppLink href={`/equipos/${p.equipmentId}/accesos`} className="text-foreground hover:underline">{p.equipmentName}</AppLink>,
    },
    {
      id: "access", header: t.access, searchValue: (p) => `${p.key} ${p.label} ${p.cableName ?? ""} ${p.cableSerial ?? ""}`,
      cell: (p) => (
        <span className="flex min-w-0 items-center gap-2">
          <AccessKindIcon kind={p.kind} />
          <span className="truncate">{p.label}</span>
          {p.kind === "jtag" && p.cableSerial ? <CableName name={p.cableName} serial={p.cableSerial} className="text-meta text-muted-foreground" /> : null}
        </span>
      ),
    },
    { id: "kind", header: t.kind, cell: (p) => `${ACCESS_KIND_LABEL[p.kind]} · ${ACCESS_POLICY_LABEL[p.policy]}`, sortValue: (p) => p.kind },
    { id: "state", header: t.state, cell: (p) => <AccessStatusChip runtime={p.runtime} quiet />, sortValue: (p) => p.runtime.status },
    {
      id: "clients", header: t.clients, align: "right", sortValue: (p) => p.runtime.connections.length,
      searchValue: (p) => p.runtime.connections.map((c) => remoteHost(c.remote)).join(" "),
      cell: (p) => (p.runtime.connections.length
        ? <span className="tabular-nums" title={p.runtime.connections.map((c) => c.remote).join(", ")}>{p.runtime.connections.length} · {[...new Set(p.runtime.connections.map((c) => remoteHost(c.remote)))].join(", ")}</span>
        : <span className="tabular-nums text-muted-foreground">0</span>),
    },
  ]
  const cableCols: Array<DataColumn<JtagCableDTO>> = [
    { id: "name", header: cablesUi.name, cell: (c) => <CableName name={c.labelName} serial={c.serial} />, sortValue: (c) => c.labelName ?? c.serial ?? "" },
    { id: "product", header: cablesUi.product, cell: (c) => cableProduct(JTAG_FAMILY_LABEL[c.family], c.product, `${c.vendorId}:${c.productId}`) },
    { id: "where", header: "USB", cell: (c) => <span className="font-mono text-data">{c.location}</span> },
    {
      id: "assigned", header: cablesUi.assigned,
      cell: (c) => (c.assignedTo.length ? c.assignedTo.map((a) => `${a.equipmentName} · ${a.key}`).join(", ") : <span className="text-muted-foreground">{cablesUi.unassigned}</span>),
    },
  ]
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 md:grid-cols-2">
        <Section title={t.rangeTitle} as="h2">
          <ul className="flex flex-col gap-1 text-body">
            <li className="font-mono text-data">{t.range(settings.range.from, settings.range.to, settings.bind)}</li>
            <li>{t.httpPort(settings.httpPort)}</li>
            <li>{t.freePorts(Math.max(0, total - ports.length))}</li>
            <li>{t.maxConnections(settings.maxConnections)}</li>
            <li className="text-meta text-muted-foreground">{t.configHint}</li>
          </ul>
        </Section>
        <Section title={t.hwServerTitle} as="h2">
          {hwServer.path ? (
            <ul className="flex flex-col gap-1 text-body">
              <li className="font-mono text-data break-all">{hwServer.path}</li>
              {hwServer.version ? <li>{t.version(hwServer.version)}</li> : null}
              {hwServer.source ? <li className="text-meta text-muted-foreground">{t.hwServerSource[hwServer.source] ?? hwServer.source}</li> : null}
            </ul>
          ) : <p className="text-body text-muted-foreground">{hwServer.problem}</p>}
        </Section>
      </div>
      <Section title={t.portMapTitle} as="h2">
        <DataTable
          rows={ports}
          columns={columns}
          rowKey={(p) => p.accessId}
          search={ports.length > 10}
          initialSort={{ id: "port", dir: "asc" }}
          caption={t.portMapTitle}
          empty={<p className="px-3 py-4 text-body text-muted-foreground">{t.portMapEmpty}</p>}
        />
      </Section>
      <Section title={t.jtagTitle} as="h2" actions={<Button asChild size="sm" variant="outline"><AppLink href="/cables"><CableIcon aria-hidden />{t.manageCables}</AppLink></Button>}>
        <DataTable
          rows={live.jtag.cables}
          columns={cableCols}
          rowKey={(c) => `${c.serial ?? ""}@${c.location}`}
          caption={t.jtagTitle}
          empty={<p className="px-3 py-4 text-body text-muted-foreground">{t.jtagEmpty}</p>}
        />
      </Section>
    </div>
  )
}
