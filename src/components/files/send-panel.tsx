"use client"

import * as React from "react"
import {
  ChevronDownIcon, ChevronUpIcon, CircleAlertIcon, CircleCheckIcon, CircleSlashIcon, LoaderCircleIcon, SendIcon, ShieldAlertIcon, XIcon, type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { SendJobDTO, SendState } from "@/lib/contracts/files"
import { isFinished, sendStore } from "@/lib/files/send-store"
import { formatDuration } from "@/lib/i18n/format"
import { sendUi as t } from "@/lib/i18n/send"
import { cn } from "@/lib/client/cn"

const STATUS: Record<SendState, { tone: ChipTone; icon: LucideIcon | null }> = {
  queued: { tone: "neutral", icon: null },
  connecting: { tone: "brand", icon: null },
  sending: { tone: "brand", icon: null },
  verifying: { tone: "brand", icon: null },
  done: { tone: "ok", icon: CircleCheckIcon },
  error: { tone: "danger", icon: CircleAlertIcon },
  canceled: { tone: "neutral", icon: CircleSlashIcon },
}

function Row({ job }: { job: SendJobDTO }) {
  const s = STATUS[job.state]
  const running = job.state === "sending" || job.state === "connecting" || job.state === "verifying" || job.state === "queued"
  const pct = job.size > 0 ? (job.sent / job.size) * 100 : job.state === "done" ? 100 : 0
  const eta = job.state === "sending" && job.speed > 0 ? ((job.size - job.sent) / job.speed) * 1000 : null
  const details = job.state === "done"
    ? [job.verification === "verified" ? t.verified(job.checksum ?? "sha256") : t.unverifiable, job.replaced ? t.replaced : null].filter(Boolean).join(" · ")
    : null
  return (
    <li className="flex flex-col gap-1.5 border-b px-3 py-2.5 last:border-b-0" data-send-status={job.state} data-send-name={job.name}>
      <div className="flex min-w-0 items-center gap-2">
        {job.state === "sending" || job.state === "connecting" || job.state === "verifying"
          ? <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-brand motion-reduce:animate-none" />
          : <SendIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate text-body text-foreground" title={`${job.name} ${t.arrow} ${job.equipmentName}`}>
          {job.name} <span className="text-muted-foreground">{t.arrow} {job.equipmentName}</span>
        </span>
        <StatusChip tone={s.tone} icon={s.icon} quiet>{t.status[job.state]}</StatusChip>
        {running ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.cancelSend(job.name, job.equipmentName)}
            onClick={async () => {
              const err = await sendStore().cancel(job.id)
              if (err) toast.error(err)
            }}
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      <p className="truncate font-mono text-data text-muted-foreground" title={`${job.dest} · ${job.via}`}>{job.dest} · {job.via}</p>
      {running ? (
        <>
          <Progress value={pct} aria-label={`${t.status[job.state]} ${job.name}`} />
          <p className="flex flex-wrap gap-x-2 text-meta tabular-nums text-muted-foreground">
            <span>{t.progress(job.sent, job.size)}</span>
            {job.speed > 0 && job.state === "sending" ? <span>{t.speed(job.speed)}</span> : null}
            {eta !== null ? <span>{formatDuration(eta)}</span> : null}
          </p>
        </>
      ) : null}
      {details ? <p className="text-meta text-muted-foreground">{details}</p> : null}
      {job.hostKeyChanged ? (
        <p className="flex gap-1.5 text-meta text-foreground" role="note">
          <ShieldAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <span className="min-w-0 break-words">{t.hostKeyChanged(job.hostKeyChanged.previous, job.hostKeyChanged.current)}</span>
        </p>
      ) : null}
      {job.error ? <p className="text-meta text-foreground" role={job.state === "error" ? "alert" : undefined}>{job.error}</p> : null}
    </li>
  )
}

/** «Envíos» (above «Subidas», same style): one row per file and equipment, with progress, speed, time left and cancel. */
export function SendPanel({ items }: { items: readonly SendJobDTO[] }) {
  const [open, setOpen] = React.useState(true)
  if (!items.length) return null
  const done = items.filter((i) => i.state === "done").length
  const active = items.filter((i) => !isFinished(i))
  const sent = active.reduce((n, i) => n + i.sent, 0)
  const total = active.reduce((n, i) => n + i.size, 0)
  const finished = items.some(isFinished)
  return (
    <section
      aria-label={t.panelRegion}
      className={cn("flex w-full flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground", "shadow-overlay")}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-section text-foreground">{t.panel}</h2>
        <span className="text-meta tabular-nums text-muted-foreground">{t.panelSummary(done, items.length)}</span>
        <span className="flex-1" />
        {finished ? <Button size="sm" variant="ghost" onClick={() => void sendStore().clearFinished()}>{t.clearFinished}</Button> : null}
        <Button variant="ghost" size="icon-sm" aria-label={open ? t.collapse : t.expand} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDownIcon aria-hidden /> : <ChevronUpIcon aria-hidden />}
        </Button>
      </header>
      {!open && active.length ? <Progress value={total ? (sent / total) * 100 : 0} aria-label={t.panel} className="rounded-none" /> : null}
      {open ? <ul className="max-h-[min(20rem,40dvh)] overflow-y-auto">{items.map((i) => <Row key={i.id} job={i} />)}</ul> : null}
    </section>
  )
}
