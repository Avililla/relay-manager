"use client"

import * as React from "react"
import { CableIcon, RefreshCwIcon, TagIcon } from "lucide-react"
import { toast } from "sonner"
import { rescanJtagCables } from "@/actions/cables"
import { AppLink } from "@/components/common/app-link"
import { EmptyState } from "@/components/common/empty-state"
import { Button } from "@/components/ui/button"
import { useAction } from "@/hooks/use-action"
import type { CableLabelDTO, HwServerInfoDTO, JtagSnapshotDTO } from "@/lib/contracts/accesses"
import { cablesUi, JTAG_FAMILY_LABEL, accessSystemUi } from "@/lib/i18n/accesses"
import { cableProduct } from "@/lib/accesses/labels"
import { CableName } from "./access-bits"
import { LabelCableDialog } from "./label-cable-dialog"
import { useLiveCables } from "./use-live-cables"

/** Descubrimiento › Cables JTAG: what is plugged in now (label first, serial second, where it is used), live. */
export function JtagCablesPanel({ jtag, labels, hwServer }: { jtag: JtagSnapshotDTO; labels: CableLabelDTO[]; hwServer: HwServerInfoDTO }) {
  const live = useLiveCables(jtag, labels)
  const rescan = useAction(rescanJtagCables)
  const [labelFor, setLabelFor] = React.useState<string | null | undefined>(undefined)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={rescan.pending} onClick={async () => { const r = await rescan.run({}); if (r.ok) toast.success(cablesUi.rescanned) }}>
          <RefreshCwIcon aria-hidden className={rescan.pending ? "animate-spin motion-reduce:animate-none" : undefined} />{cablesUi.rescan}
        </Button>
        <Button size="sm" onClick={() => setLabelFor(null)}><TagIcon aria-hidden />{cablesUi.labelCable}</Button>
        <Button asChild size="sm" variant="ghost"><AppLink href="/cables"><CableIcon aria-hidden />{accessSystemUi.manageCables}</AppLink></Button>
        <span className="ml-auto text-meta text-muted-foreground">
          {cablesUi.hwServer}: {hwServer.path ? <span className="font-mono text-data">{cablesUi.hwServerFound(hwServer.path, hwServer.version)}</span> : hwServer.problem}
        </span>
      </div>
      {live.jtag.cables.length ? (
        <ul aria-label={cablesUi.tabJtag} className="flex flex-col gap-1.5">
          {live.jtag.cables.map((c) => (
            <li key={`${c.serial ?? ""}@${c.location}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-card px-3 py-2">
              <CableIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <CableName name={c.labelName} serial={c.serial} className="min-w-44 text-body" />
              <span className="text-meta text-muted-foreground">{cableProduct(JTAG_FAMILY_LABEL[c.family], c.product, `${c.vendorId}:${c.productId}`)} · <span className="font-mono">{c.location}</span></span>
              <span className="text-meta">{c.assignedTo.length ? c.assignedTo.map((a) => `${a.equipmentName} · ${a.key}`).join(", ") : <span className="text-muted-foreground">{cablesUi.unassigned}</span>}</span>
              {!c.labelName && c.serial ? (
                <Button size="sm" variant="outline" className="ml-auto" aria-label={cablesUi.labelThisAria(c.serial)} onClick={() => setLabelFor(c.serial)}><TagIcon aria-hidden />{cablesUi.labelThis}</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={CableIcon} title={accessSystemUi.jtagEmpty}>{cablesUi.waitingHelp}</EmptyState>
      )}
      <LabelCableDialog
        open={labelFor !== undefined}
        onOpenChange={(o) => { if (!o) setLabelFor(undefined) }}
        kind="jtag"
        lockKind
        initialIdentity={labelFor ?? null}
        jtag={live.jtag}
        serial={null}
        labels={live.labels}
      />
    </div>
  )
}
