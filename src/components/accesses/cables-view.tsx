"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { CableIcon, EthernetPortIcon, PencilIcon, RefreshCwIcon, TagIcon, Trash2Icon, UsbIcon } from "lucide-react"
import { toast } from "sonner"
import { deleteCableLabel, rescanJtagCables, updateCableLabel } from "@/actions/cables"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { DataTable, type DataColumn } from "@/components/common/data-table"
import { FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { Page, PageHeader, Section } from "@/components/common/page"
import { RelativeTime } from "@/components/common/relative-time"
import { StatusChip } from "@/components/common/status-chip"
import { PageMeta } from "@/components/shell/page-meta"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useLiveSerial } from "@/components/wizard/use-live-serial"
import { useAction } from "@/hooks/use-action"
import { useLiveState } from "@/hooks/use-live-state"
import type { ServerEventType } from "@/lib/contracts/events"
import { equipnetUi } from "@/lib/i18n/equipnet"
import type { CableKind, CableLabelDTO, CablesPageDTO } from "@/lib/contracts/accesses"
import { adapterIdentity } from "@/lib/accesses/labels"
import { cablesUi as t } from "@/lib/i18n/accesses"
import { cableCandidates, LabelCableDialog } from "./label-cable-dialog"
import { useLiveCables } from "./use-live-cables"

type Tab = "jtag" | "serie" | "red"
const TAB_KIND: Record<Tab, CableKind> = { jtag: "jtag", serie: "serial-adapter", red: "net-adapter" }
const NET_EVENTS: readonly ServerEventType[] = ["equipnet.changed"]

/**
 * Cables (admin): the inventory of named JTAG cables and USB-serial adapters. "Etiquetar un cable" detects the cable
 * being plugged in and names it (chainable); each label can be renamed or deleted; the tables say whether each cable
 * is connected now and where it is used. Live: JTAG hot-plug, serial hot-plug and label changes.
 */
export function CablesView({ data }: { data: CablesPageDTO }) {
  const live = useLiveCables(data.jtag, data.labels)
  const { snapshot: serial } = useLiveSerial(data.serial)
  const tabParam = useSearchParams().get("tab")
  const active: Tab = tabParam === "serie" ? "serie" : tabParam === "red" ? "red" : "jtag"
  const net = useLiveState(data.netAdapters, NET_EVENTS, (s, e) => (e.type === "equipnet.changed" ? e.status.adapters : s))
  const [dialog, setDialog] = React.useState<{ kind: CableKind; identity: string | null } | null>(null)
  const [editing, setEditing] = React.useState<CableLabelDTO | null>(null)
  const rescan = useAction(rescanJtagCables)
  const change = (v: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set("tab", v === "serie" || v === "red" ? v : "jtag")
    window.history.replaceState(null, "", url)
  }
  const jtagIds = new Set(live.jtag.cables.flatMap((c) => (c.serial ? [c.serial] : [])))
  const serialIds = new Set(serial.adapters.map((a) => adapterIdentity(a)))
  const netIds = new Set(net.map((a) => a.mac))
  const labels = live.labels.map((l) => ({ ...l, connected: l.kind === "jtag" ? jtagIds.has(l.identity) : l.kind === "net-adapter" ? netIds.has(l.identity) : serialIds.has(l.identity) }))
  const connected = labels.filter((l) => l.connected).length

  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: t.title }]} />
      <PageHeader
        title={t.title}
        summary={t.summary(labels.length, connected)}
        actions={(
          <>
            <Button variant="outline" onClick={async () => { const r = await rescan.run({}); if (r.ok) toast.success(t.rescanned) }} disabled={rescan.pending}>
              <RefreshCwIcon aria-hidden className={rescan.pending ? "animate-spin motion-reduce:animate-none" : undefined} />{t.rescan}
            </Button>
            <Button variant="primary" onClick={() => setDialog({ kind: TAB_KIND[active], identity: null })}><TagIcon aria-hidden />{t.labelCable}</Button>
          </>
        )}
      >
        <p className="max-w-[80ch] text-meta text-muted-foreground">{t.intro}</p>
      </PageHeader>
      <p className="text-meta text-muted-foreground">
        <span className="font-medium text-foreground">{t.hwServer}: </span>
        {data.hwServer.path ? <span className="font-mono text-data">{t.hwServerFound(data.hwServer.path, data.hwServer.version)}</span> : data.hwServer.problem}
      </p>
      <Tabs value={active} onValueChange={change}>
        <TabsList aria-label={t.tabsLabel}>
          <TabsTrigger value="jtag"><CableIcon aria-hidden />{t.tabJtag}</TabsTrigger>
          <TabsTrigger value="serie"><UsbIcon aria-hidden />{t.tabSerial}</TabsTrigger>
          <TabsTrigger value="red"><EthernetPortIcon aria-hidden />{equipnetUi.tabAdapters}</TabsTrigger>
        </TabsList>
        {(["jtag", "serie", "red"] as const).map((tab) => {
          const kind: CableKind = TAB_KIND[tab]
          const rows = labels.filter((l) => l.kind === kind)
          const unlabelled = cableCandidates(kind, live.jtag, serial, live.labels, net).filter((c) => !c.labelName)
          return (
            <TabsContent key={tab} value={tab} forceMount hidden={active !== tab} className="flex flex-col gap-6 pt-2">
              <LabelsTable rows={rows} kind={kind} onEdit={setEditing} />
              <Section title={t.unlabelledTitle} as="h3">
                {unlabelled.length ? (
                  <ul className="flex flex-col gap-1.5">
                    {unlabelled.map((c) => (
                      <li key={c.identity} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-body text-foreground">{c.title}</span>
                          <span className="truncate font-mono text-data text-muted-foreground">{c.detail}</span>
                        </div>
                        <Button size="sm" variant="outline" aria-label={t.labelThisAria(`${c.title} ${c.detail}`)} onClick={() => setDialog({ kind, identity: c.identity })}>
                          <TagIcon aria-hidden />{t.labelThis}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-meta text-muted-foreground">{t.unlabelledNone}</p>}
              </Section>
            </TabsContent>
          )
        })}
      </Tabs>
      <LabelCableDialog
        open={dialog !== null}
        onOpenChange={(o) => { if (!o) setDialog(null) }}
        kind={dialog?.kind ?? TAB_KIND[active]}
        net={net}
        initialIdentity={dialog?.identity ?? null}
        jtag={live.jtag}
        serial={serial}
        labels={live.labels}
      />
      <EditLabelDialog label={editing} onClose={() => setEditing(null)} />
    </Page>
  )
}

function LabelsTable({ rows, kind, onEdit }: { rows: CableLabelDTO[]; kind: CableKind; onEdit: (l: CableLabelDTO) => void }) {
  const remove = useAction(deleteCableLabel, { successMessage: t.deleted })
  const columns: Array<DataColumn<CableLabelDTO>> = [
    { id: "name", header: t.name, cell: (l) => <span className="font-mono text-data font-medium text-foreground">{l.name}</span>, sortValue: (l) => l.name, searchValue: (l) => l.name },
    {
      id: "identity", header: kind === "jtag" ? t.serial : t.identity,
      cell: (l) => <span className="font-mono text-data text-muted-foreground">{l.identity}</span>, sortValue: (l) => l.identity, searchValue: (l) => l.identity,
    },
    { id: "product", header: t.product, cell: (l) => l.product ?? "-", searchValue: (l) => l.product ?? "" },
    {
      id: "connected", header: t.connected, sortValue: (l) => (l.connected ? 0 : 1),
      cell: (l) => <StatusChip tone={l.connected ? "ok" : "neutral"} quiet>{l.connected ? t.connectedYes : t.connectedNo}</StatusChip>,
    },
    { id: "seen", header: t.lastSeen, cell: (l) => (l.lastSeenAt ? <RelativeTime value={l.lastSeenAt} /> : t.never) },
    {
      id: "assigned", header: t.assigned, searchValue: (l) => l.assignedTo.map((a) => a.equipmentName).join(" "),
      cell: (l) => (l.assignedTo.length ? <span className="text-body">{l.assignedTo.map((a) => `${a.equipmentName} · ${a.key}`).join(", ")}</span> : <span className="text-muted-foreground">{t.unassigned}</span>),
    },
    { id: "notes", header: t.notes, cell: (l) => <span className="text-meta text-muted-foreground">{l.notes ?? ""}</span>, searchValue: (l) => l.notes ?? "" },
    {
      id: "actions", header: t.actions, align: "right",
      cell: (l) => (
        <span className="inline-flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label={`${t.rename}: ${l.name}`} onClick={() => onEdit(l)}><PencilIcon aria-hidden /></Button>
          <ConfirmDialog
            trigger={<Button variant="ghost" size="icon-sm" aria-label={`${t.delete}: ${l.name}`} className="hover:text-danger"><Trash2Icon aria-hidden /></Button>}
            title={t.deleteTitle(l.name)}
            description={t.deleteBody}
            confirmLabel={t.delete}
            onConfirm={async () => (await remove.run({ labelId: l.id })).ok}
          />
        </span>
      ),
    },
  ]
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(l) => l.id}
      search={rows.length > 8}
      initialSort={{ id: "name", dir: "asc" }}
      caption={kind === "jtag" ? t.tabJtag : kind === "net-adapter" ? equipnetUi.tabAdapters : t.tabSerial}
      empty={<p className="px-3 py-4 text-body text-muted-foreground">{kind === "jtag" ? t.emptyJtag : kind === "net-adapter" ? equipnetUi.adaptersEmpty : t.emptySerial}</p>}
    />
  )
}

function EditLabelDialog({ label, onClose }: { label: CableLabelDTO | null; onClose: () => void }) {
  const [name, setName] = React.useState("")
  const [notes, setNotes] = React.useState("")
  const [forId, setForId] = React.useState<string | null>(null)
  const save = useAction(updateCableLabel, { successMessage: t.saved })
  if ((label?.id ?? null) !== forId) {
    setForId(label?.id ?? null)
    setName(label?.name ?? "")
    setNotes(label?.notes ?? "")
  }
  return (
    <Dialog open={!!label} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{label ? t.renameTitle(label.name) : ""}</DialogTitle></DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!label) return
            const r = await save.run({ labelId: label.id, name: name.trim(), notes: notes.trim() || null })
            if (r.ok) onClose()
          }}
        >
          {label ? <InlineAlert tone="info" className="py-1.5"><span className="font-mono text-data">{label.identity}</span></InlineAlert> : null}
          <FormField label={t.name} name="name" errors={save.fieldErrors} required>
            <Input value={name} maxLength={32} spellCheck={false} className="font-mono" onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t.notesOptional} name="notes" errors={save.fieldErrors}>
            <Textarea value={notes} rows={2} maxLength={200} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>{t.cancel}</Button>
            <Button type="submit" variant="primary" disabled={save.pending || !name.trim()}>{t.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
