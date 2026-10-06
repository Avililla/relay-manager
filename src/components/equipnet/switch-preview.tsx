"use client"

import * as React from "react"
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react"
import { InlineAlert } from "@/components/common/inline-alert"
import { Progress } from "@/components/ui/progress"
import type { SwitchJobDTO, SwitchPreviewDTO } from "@/lib/contracts/equipnet"
import { equipnetUi as t } from "@/lib/i18n/equipnet"

/** "Se va a cambiar…" (the ordered changes), the uplink check and the port-by-port before/after table. */
export function SwitchPreviewDetails({ preview }: { preview: SwitchPreviewDTO }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="switch-preview">
      {preview.uplinkCheck.detail ? (
        <p className="flex items-start gap-2 text-meta text-muted-foreground">
          {preview.uplinkCheck.ok
            ? <CircleCheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ok" />
            : <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />}
          {preview.uplinkCheck.detail}
        </p>
      ) : null}
      {preview.nothingToDo ? <p className="text-body text-muted-foreground">{t.nothingToDo}</p> : (
        <div className="flex flex-col gap-1">
          <p className="text-meta font-medium text-foreground">{t.detailsChanges}</p>
          <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-meta text-foreground">
            {preview.changes.map((c, i) => <li key={i}>{c}</li>)}
          </ol>
        </div>
      )}
      {preview.warnings.length ? (
        <InlineAlert tone="warn" title={t.warnings}>
          <ul className="list-disc pl-4">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </InlineAlert>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-meta font-medium text-foreground">{t.detailsPorts}</p>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[34rem] text-meta">
            <thead className="bg-secondary text-left text-micro text-muted-foreground">
              <tr><th className="px-2 py-1.5 font-medium">{t.port}</th><th className="px-2 py-1.5 font-medium">{t.detailsBefore}</th><th className="px-2 py-1.5 font-medium">{t.detailsAfter}</th></tr>
            </thead>
            <tbody>
              {preview.ports.map((p) => (
                <tr key={p.port} className="border-t">
                  <td className="px-2 py-1.5 font-mono tabular-nums">{p.port}{p.role === "uplink" ? ` · ${t.roleUplink}` : ""}</td>
                  <td className="px-2 py-1.5">{p.before.pvid !== null ? `${t.pvid} ${p.before.pvid} · ` : ""}{p.before.vlans}</td>
                  <td className="px-2 py-1.5">{p.after.pvid !== null ? `${t.pvid} ${p.after.pvid} · ` : ""}{p.after.vlans}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/** Progress of a running switch job, then its result (live from equipnet.changed). */
export function SwitchJobProgress({ job }: { job: SwitchJobDTO }) {
  const id = React.useId()
  if (job.state === "running") {
    return (
      <div className="flex flex-col gap-2" aria-live="polite">
        <p id={id} className="text-body text-foreground">{job.label}</p>
        <Progress aria-labelledby={id} value={job.step} max={Math.max(1, job.total)} />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2" role="status">
      {job.state === "done"
        ? <InlineAlert tone="ok">{job.label}</InlineAlert>
        : <InlineAlert tone="danger" role="alert">{job.error ?? job.label}</InlineAlert>}
      {job.warnings.length ? (
        <InlineAlert tone="warn" title={t.warnings}><ul className="list-disc pl-4">{job.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></InlineAlert>
      ) : null}
    </div>
  )
}
