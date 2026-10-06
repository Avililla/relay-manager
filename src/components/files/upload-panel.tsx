"use client"

import * as React from "react"
import {
  ChevronDownIcon, ChevronUpIcon, CircleAlertIcon, CircleCheckIcon, FileIcon, LoaderCircleIcon, RotateCcwIcon, XIcon, type LucideIcon,
} from "lucide-react"
import { StatusChip, type ChipTone } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { UploadItem, UploadStatus } from "@/lib/files/upload-engine"
import { uploadEngine } from "@/lib/files/upload-store"
import { formatDuration } from "@/lib/i18n/format"
import { filesUi as t } from "@/lib/i18n/files"
import { cn } from "@/lib/client/cn"

const STATUS: Record<UploadStatus, { label: string; tone: ChipTone; icon: LucideIcon | null }> = {
  queued: { label: t.statusQueued, tone: "neutral", icon: null },
  uploading: { label: t.statusUploading, tone: "brand", icon: null },
  done: { label: t.statusDone, tone: "ok", icon: CircleCheckIcon },
  error: { label: t.statusError, tone: "danger", icon: CircleAlertIcon },
  canceled: { label: t.statusCanceled, tone: "neutral", icon: null },
  conflict: { label: t.statusConflict, tone: "warn", icon: CircleAlertIcon },
}

function Row({ item, canReplace }: { item: UploadItem; canReplace: boolean }) {
  const s = STATUS[item.status]
  const pct = item.total > 0 ? (item.sent / item.total) * 100 : item.status === "done" ? 100 : 0
  const eta = item.status === "uploading" && item.speed > 0 ? ((item.total - item.sent) / item.speed) * 1000 : null
  const engine = uploadEngine()
  const where = t.uploadTo(item.rootLabel, item.dir)
  return (
    <li className="flex flex-col gap-1.5 border-b px-3 py-2.5 last:border-b-0" data-upload-status={item.status}>
      <div className="flex min-w-0 items-center gap-2">
        {item.status === "uploading"
          ? <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-brand motion-reduce:animate-none" />
          : <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate text-body text-foreground" title={`${where} · ${item.name}`}>{item.name}</span>
        <StatusChip tone={s.tone} icon={s.icon} quiet>{s.label}</StatusChip>
        {item.status === "queued" || item.status === "uploading" || item.status === "conflict" ? (
          <Button variant="ghost" size="icon-sm" aria-label={t.cancelUpload(item.name)} onClick={() => engine.cancel(item.key)}><XIcon aria-hidden /></Button>
        ) : null}
        {item.status === "error" || item.status === "canceled" ? (
          <Button variant="ghost" size="icon-sm" aria-label={t.retryUpload(item.name)} onClick={() => engine.retry(item.key)}><RotateCcwIcon aria-hidden /></Button>
        ) : null}
      </div>
      {item.status === "uploading" || item.status === "queued" ? (
        <>
          <Progress value={pct} aria-label={`${t.statusUploading} ${item.name}`} />
          <p className="flex flex-wrap gap-x-2 text-meta tabular-nums text-muted-foreground">
            <span>{t.progress(item.sent, item.total)}</span>
            {item.speed > 0 ? <span>{t.speed(item.speed)}</span> : null}
            {eta !== null ? <span>{formatDuration(eta)}</span> : null}
          </p>
        </>
      ) : null}
      {item.status === "done" && item.finalName && item.finalName !== item.name ? (
        <p className="text-meta text-muted-foreground">{t.savedAs(item.finalName)}</p>
      ) : null}
      {item.error && item.status !== "canceled" ? <p className="text-meta text-foreground" role={item.status === "error" ? "alert" : undefined}>{item.error}</p> : null}
      {item.status === "conflict" ? (
        <div className="flex flex-wrap gap-1.5">
          {canReplace ? <Button size="sm" variant="outline" onClick={() => engine.resolveConflict(item.key, "overwrite")}>{t.replace}</Button> : null}
          <Button size="sm" variant="outline" onClick={() => engine.resolveConflict(item.key, "rename")}>{t.keepBoth}</Button>
          <Button size="sm" variant="ghost" onClick={() => engine.cancel(item.key)}>{t.skip}</Button>
        </div>
      ) : null}
    </li>
  )
}

/** Bottom right: «Envíos» above «Subidas» (each panel hides itself when empty). */
export function TransferDock({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2 [&>*]:pointer-events-auto">{children}</div>
}

/**
 * Upload queue (bottom right): one row per file with progress, speed, time left, cancel, retry and the conflict
 * choice. Collapsible; "Quitar las terminadas" empties it.
 */
export function UploadPanel({ items, canReplace = true }: { items: readonly UploadItem[]; canReplace?: boolean }) {
  const [open, setOpen] = React.useState(true)
  if (!items.length) return null
  const done = items.filter((i) => i.status === "done").length
  const active = items.filter((i) => i.status === "uploading" || i.status === "queued")
  const sent = active.reduce((n, i) => n + i.sent, 0)
  const total = active.reduce((n, i) => n + i.total, 0)
  const finished = items.some((i) => i.status === "done" || i.status === "error" || i.status === "canceled")
  return (
    <section
      aria-label={t.uploadsRegion}
      className={cn("flex w-full flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground", "shadow-overlay")}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-section text-foreground">{t.uploads}</h2>
        <span className="text-meta tabular-nums text-muted-foreground">{t.uploadsSummary(done, items.length)}</span>
        <span className="flex-1" />
        {finished ? <Button size="sm" variant="ghost" onClick={() => uploadEngine().clearFinished()}>{t.clearFinished}</Button> : null}
        <Button variant="ghost" size="icon-sm" aria-label={open ? t.collapse : t.expand} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDownIcon aria-hidden /> : <ChevronUpIcon aria-hidden />}
        </Button>
      </header>
      {!open && active.length ? <Progress value={total ? (sent / total) * 100 : 0} aria-label={t.uploads} className="rounded-none" /> : null}
      {open ? <ul className="max-h-[min(20rem,50dvh)] overflow-y-auto">{items.map((i) => <Row key={i.key} item={i} canReplace={canReplace} />)}</ul> : null}
    </section>
  )
}
