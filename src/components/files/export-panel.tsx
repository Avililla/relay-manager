"use client"

import * as React from "react"
import {
  ChevronDownIcon, ChevronUpIcon, CircleAlertIcon, CircleCheckIcon, CircleSlashIcon, CloudDownloadIcon, DownloadIcon, FolderOpenIcon,
  LoaderCircleIcon, ScrollTextIcon, XIcon, type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import { useViewer } from "@/components/shell/shell-context"
import { Button } from "@/components/ui/button"
import type { ExportJobDTO, ExportState, FilesRootId } from "@/lib/contracts/files"
import { exportStore, isExportFinished } from "@/lib/files/export-store"
import { downloadUrl } from "@/lib/files/view"
import { formatBytes } from "@/lib/i18n/format"
import { exportUi as t } from "@/lib/i18n/files"
import { cn } from "@/lib/client/cn"

const STATUS: Record<ExportState, { tone: ChipTone; icon: LucideIcon | null }> = {
  queued: { tone: "neutral", icon: null },
  running: { tone: "brand", icon: null },
  done: { tone: "ok", icon: CircleCheckIcon },
  error: { tone: "danger", icon: CircleAlertIcon },
  canceled: { tone: "neutral", icon: CircleSlashIcon },
}

/** The live log: monospace, follows the end while the reader is at the bottom (scrolling up stops following). */
function LogView({ job }: { job: ExportJobDTO }) {
  const ref = React.useRef<HTMLPreElement>(null)
  const follow = React.useRef(true)
  React.useEffect(() => {
    const el = ref.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [job.log.length])
  return (
    <pre
      ref={ref}
      // Not a live region: a download prints hundreds of lines (the state chip above announces the changes).
      aria-label={t.log(job.app, job.version)}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      className="max-h-48 min-h-16 overflow-auto rounded-md border bg-muted px-2.5 py-1.5 font-mono text-data whitespace-pre-wrap break-all text-foreground"
      data-testid="export-log"
    >
      {job.logDropped ? <span className="text-muted-foreground">{t.logDropped(job.logDropped)}{"\n"}</span> : null}
      {job.log.length ? job.log.join("\n") : <span className="text-muted-foreground">{t.logEmpty}</span>}
    </pre>
  )
}

function Row({ job, mine, isAdmin, root, rootLabel, onOpenFolder }: {
  job: ExportJobDTO; mine: boolean; isAdmin: boolean; root: FilesRootId; rootLabel: string; onOpenFolder: (dir: string) => void
}) {
  const s = STATUS[job.state]
  const finished = isExportFinished(job)
  const [showLog, setShowLog] = React.useState(!finished)
  const label = job.state === "queued" ? t.queued(job.queuePosition) : t.status[job.state]
  return (
    <li className="flex flex-col gap-1.5 border-b px-3 py-2.5 last:border-b-0" data-export-status={job.state} data-export-app={job.app}>
      <div className="flex min-w-0 items-center gap-2">
        {job.state === "running"
          ? <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-brand motion-reduce:animate-none" />
          : <CloudDownloadIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate text-body text-foreground" title={`${job.app} ${job.version} → ${rootLabel}/${job.dir}`}>
          <span className="font-mono">{job.app}</span> <span className="font-mono text-muted-foreground">{job.version}</span>
          {!mine ? <span className="text-meta text-muted-foreground"> · {t.by(job.userName)}</span> : null}
        </span>
        <span aria-live="polite" className="contents">
          <StatusChip tone={s.tone} icon={s.icon} quiet>{label}</StatusChip>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={showLog ? t.hideLog : t.showLog}
          aria-expanded={showLog}
          onClick={() => setShowLog((v) => !v)}
        >
          <ScrollTextIcon aria-hidden />
        </Button>
        {!finished && (mine || isAdmin) ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.cancelJob(job.app, job.version)}
            onClick={async () => {
              const err = await exportStore().cancel(job.id)
              if (err) toast.error(err)
            }}
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      {job.state === "done" && job.finalPath ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-meta">
          <span className="text-muted-foreground">{t.savedTo(rootLabel)}</span>
          <span className="min-w-0 truncate font-mono text-data text-foreground" title={job.finalPath}>{job.finalPath}</span>
          {job.sizeBytes !== null ? <span className="tabular-nums text-muted-foreground">{formatBytes(job.sizeBytes)}</span> : null}
          <span className="flex-1" />
          <Button asChild size="sm" variant="outline">
            <a href={downloadUrl(job.finalPath, root)} download><DownloadIcon aria-hidden />{t.download}</a>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpenFolder(job.dir)}><FolderOpenIcon aria-hidden />{t.open}</Button>
        </div>
      ) : null}
      {job.error && job.state !== "canceled" ? (
        <p className="text-meta text-foreground" role={job.state === "error" ? "alert" : undefined}>
          {job.error}{job.exitCode !== null ? ` (${t.exitCode(job.exitCode)})` : ""}
        </p>
      ) : null}
      {showLog ? <LogView job={job} /> : null}
    </li>
  )
}

/** «Descargas» (with «Copias», «Envíos» and «Subidas», same style): the download script's jobs and their live log. */
export function ExportPanel({ items, root, rootLabel, name, onOpenFolder }: {
  items: readonly ExportJobDTO[]; root: FilesRootId; rootLabel: string; name: string | null; onOpenFolder: (dir: string) => void
}) {
  const viewer = useViewer()
  const [open, setOpen] = React.useState(true)
  if (!items.length) return null
  const done = items.filter((i) => i.state === "done").length
  const finished = items.some(isExportFinished)
  return (
    <section aria-label={name ?? t.panel} className={cn("flex w-full flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground", "shadow-overlay")}>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-section text-foreground">{name ?? t.panel}</h2>
        <span className="text-meta tabular-nums text-muted-foreground">{t.panelSummary(done, items.length)}</span>
        <span className="flex-1" />
        {finished ? <Button size="sm" variant="ghost" onClick={() => exportStore().clearFinished()}>{t.clearFinished}</Button> : null}
        <Button variant="ghost" size="icon-sm" aria-label={open ? t.collapse : t.expand} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDownIcon aria-hidden /> : <ChevronUpIcon aria-hidden />}
        </Button>
      </header>
      {open ? (
        <ul className="max-h-[min(26rem,55dvh)] overflow-y-auto">
          {items.map((i) => <Row key={i.id} job={i} mine={i.userId === viewer.id} isAdmin={viewer.isAdmin} root={root} rootLabel={rootLabel} onOpenFolder={onOpenFolder} />)}
        </ul>
      ) : null}
    </section>
  )
}
