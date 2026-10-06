"use client"

import * as React from "react"
import {
  ChevronDownIcon, ChevronUpIcon, CircleAlertIcon, CircleCheckIcon, CircleSlashIcon, CopyIcon, LoaderCircleIcon, ShieldCheckIcon, SkipForwardIcon, XIcon,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { CopyJobDTO, CopyState } from "@/lib/contracts/files"
import { copyStore, isCopyFinished } from "@/lib/files/copy-store"
import { formatDuration } from "@/lib/i18n/format"
import { copyUi as t } from "@/lib/i18n/copy"
import { cn } from "@/lib/client/cn"

const STATUS: Record<CopyState, { tone: ChipTone; icon: LucideIcon | null }> = {
  queued: { tone: "neutral", icon: null },
  copying: { tone: "brand", icon: null },
  verifying: { tone: "brand", icon: null },
  done: { tone: "ok", icon: CircleCheckIcon },
  skipped: { tone: "neutral", icon: SkipForwardIcon },
  error: { tone: "danger", icon: CircleAlertIcon },
  canceled: { tone: "neutral", icon: CircleSlashIcon },
}

function Row({ job }: { job: CopyJobDTO }) {
  const s = STATUS[job.state]
  const running = job.state === "copying" || job.state === "verifying" || job.state === "queued"
  const pct = job.size > 0 ? (job.copied / job.size) * 100 : job.state === "done" ? 100 : 0
  const eta = job.state === "copying" && job.speed > 0 ? ((job.size - job.copied) / job.speed) * 1000 : null
  const dest = `${job.destDir === "/" ? "" : job.destDir}/${job.finalName ?? job.name}`
  const details = job.state === "done"
    ? [t.verified, job.replaced ? t.replaced : null, job.finalName && job.finalName !== job.name ? t.savedAs(job.finalName) : null].filter(Boolean).join(" · ")
    : job.state === "skipped" ? t.skippedNote : null
  return (
    <li className="flex flex-col gap-1.5 border-b px-3 py-2.5 last:border-b-0" data-copy-status={job.state} data-copy-name={job.name}>
      <div className="flex min-w-0 items-center gap-2">
        {job.state === "copying" || job.state === "verifying"
          ? <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-brand motion-reduce:animate-none" />
          : <CopyIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate text-body text-foreground" title={`${job.name} ${t.arrow} ${job.destDir}`}>
          {job.name} <span className="text-muted-foreground">{t.arrow} {job.destDir}</span>
        </span>
        {job.asRoot ? (
          <StatusChip tone="warn" icon={ShieldCheckIcon} quiet>{t.asRootBadge(job.rootUser)}</StatusChip>
        ) : null}
        <StatusChip tone={s.tone} icon={s.icon} quiet>{t.status[job.state]}</StatusChip>
        {running ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.cancelCopy(job.name)}
            onClick={async () => {
              const err = await copyStore().cancel(job.id)
              if (err) toast.error(err)
            }}
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      {job.state === "done" ? <p className="truncate font-mono text-data text-muted-foreground" title={dest}>{dest}</p> : null}
      {running ? (
        <>
          <Progress value={pct} aria-label={`${t.status[job.state]} ${job.name}`} />
          <p className="flex flex-wrap gap-x-2 text-meta tabular-nums text-muted-foreground">
            <span>{t.progress(job.copied, job.size)}</span>
            {job.speed > 0 && job.state === "copying" ? <span>{t.speed(job.speed)}</span> : null}
            {eta !== null ? <span>{formatDuration(eta)}</span> : null}
          </p>
        </>
      ) : null}
      {details ? <p className="text-meta text-muted-foreground">{details}</p> : null}
      {job.error && job.state !== "canceled" ? <p className="text-meta text-foreground" role={job.state === "error" ? "alert" : undefined}>{job.error}</p> : null}
    </li>
  )
}

/** «Copias» (with «Envíos» and «Subidas», same style): one row per file, with progress, speed, time left and cancel. */
export function CopyPanel({ items }: { items: readonly CopyJobDTO[] }) {
  const [open, setOpen] = React.useState(true)
  if (!items.length) return null
  const done = items.filter((i) => i.state === "done" || i.state === "skipped").length
  const active = items.filter((i) => !isCopyFinished(i))
  const copied = active.reduce((n, i) => n + i.copied, 0)
  const total = active.reduce((n, i) => n + i.size, 0)
  const finished = items.some(isCopyFinished)
  return (
    <section aria-label={t.panelRegion} className={cn("flex w-full flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground", "shadow-overlay")}>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-section text-foreground">{t.panel}</h2>
        <span className="text-meta tabular-nums text-muted-foreground">{t.panelSummary(done, items.length)}</span>
        <span className="flex-1" />
        {finished ? <Button size="sm" variant="ghost" onClick={() => void copyStore().clearFinished()}>{t.clearFinished}</Button> : null}
        <Button variant="ghost" size="icon-sm" aria-label={open ? t.collapse : t.expand} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDownIcon aria-hidden /> : <ChevronUpIcon aria-hidden />}
        </Button>
      </header>
      {!open && active.length ? <Progress value={total ? (copied / total) * 100 : 0} aria-label={t.panel} className="rounded-none" /> : null}
      {open ? <ul className="max-h-[min(20rem,40dvh)] overflow-y-auto">{items.map((i) => <Row key={i.id} job={i} />)}</ul> : null}
    </section>
  )
}
