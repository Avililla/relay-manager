"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArchiveIcon, DatabaseBackupIcon, DownloadIcon, LoaderCircleIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { createBackup, deleteBackup } from "@/actions/system"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { DataTable, type DataColumn } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { MiddleTruncate } from "@/components/common/middle-truncate"
import { RelativeTime } from "@/components/common/relative-time"
import { Button } from "@/components/ui/button"
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { useAction } from "@/hooks/use-action"
import type { BackupDTO } from "@/lib/contracts/system"
import { setup as setupText, system as t } from "@/lib/i18n/admin"
import { formatBytes } from "@/lib/i18n/format"
import { CommandLine } from "./command-line"
import { backupLabel } from "./system-model"

/** Columns shown from md up; on phones they fold into the name cell. */
const WIDE_ONLY = { className: "hidden md:table-cell", headerClassName: "hidden md:table-cell" } as const

function BackupActions({ b }: { b: BackupDTO }) {
  const router = useRouter()
  const remove = useAction(deleteBackup, { successMessage: t.backupRemoved })
  return (
    <span className="flex items-center justify-end gap-1">
      <SimpleTooltip label={t.download}>
        <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
          <a href={`/api/backups/${encodeURIComponent(b.name)}`} download={b.name} aria-label={t.downloadNamed(b.name)}>
            <DownloadIcon aria-hidden />
          </a>
        </Button>
      </SimpleTooltip>
      <ConfirmDialog
        trigger={(
          <Button variant="ghost" size="icon-sm" aria-label={t.removeNamed(b.name)} title={t.remove} className="text-muted-foreground hover:text-danger">
            <Trash2Icon aria-hidden />
          </Button>
        )}
        title={t.removeBackupTitle}
        description={t.removeBackupBody(b.name)}
        confirmLabel={t.remove}
        onConfirm={async () => {
          const r = await remove.run({ name: b.name })
          if (!r.ok) return false
          router.refresh()
        }}
      />
    </span>
  )
}

/**
 * Sistema > Copias (§8.9): the backups on disk (name, tipo, fecha, tamaño, versión) with Descargar / Eliminar, and
 * "Crear copia ahora". Restoring is a CLI operation with the service stopped; the note says how.
 */
export function BackupsPanel({ backups, backupDir }: { backups: BackupDTO[]; backupDir: string }) {
  const router = useRouter()
  const create = useAction(createBackup)
  const columns = React.useMemo<Array<DataColumn<BackupDTO>>>(() => [
    {
      id: "name", header: t.backupColumns.name, sortValue: (b) => b.name, searchValue: (b) => b.name,
      // Phones: the row is Archivo + actions; type, date and size fold under the name (same fold as Usuarios).
      cell: (b) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <MiddleTruncate value={b.name} tail={18} className="w-full text-foreground" />
          <span className="flex flex-wrap items-center gap-x-1.5 text-meta text-muted-foreground md:hidden">
            <span>{backupLabel(b.label)}</span>
            <span aria-hidden>·</span>
            <RelativeTime value={b.createdAt} />
            <span aria-hidden>·</span>
            <span className="font-mono text-data">{formatBytes(b.sizeBytes)}</span>
          </span>
        </span>
      ),
      // Takes the remaining width and truncates in the middle instead of pushing the actions out of the frame.
      className: "w-full max-w-0 min-w-40",
    },
    { id: "label", header: t.backupColumns.label, ...WIDE_ONLY, sortValue: (b) => backupLabel(b.label), cell: (b) => <span className="whitespace-nowrap text-foreground">{backupLabel(b.label)}</span> },
    { id: "date", header: t.backupColumns.date, ...WIDE_ONLY, sortValue: (b) => Date.parse(b.createdAt), cell: (b) => <RelativeTime value={b.createdAt} className="whitespace-nowrap text-muted-foreground" /> },
    { id: "size", header: t.backupColumns.size, ...WIDE_ONLY, align: "right", sortValue: (b) => b.sizeBytes, cell: (b) => <span className="font-mono text-data whitespace-nowrap">{formatBytes(b.sizeBytes)}</span> },
    {
      id: "version", header: t.backupColumns.version, ...WIDE_ONLY, sortValue: (b) => b.appVersion ?? "",
      cell: (b) => b.appVersion ? <span className="font-mono text-data">{b.appVersion}</span> : <span className="text-faint-foreground">{t.unknownVersion}</span>,
    },
    { id: "actions", header: t.backupColumns.actions, align: "right", headerClassName: "sr-only", cell: (b) => <BackupActions b={b} /> },
  ], [])

  const createButton = (
    <Button
      variant="default"
      disabled={create.pending}
      aria-busy={create.pending || undefined}
      onClick={async () => {
        const r = await create.run({})
        if (r.ok) {
          toast.success(t.backupCreated(r.data.name))
          router.refresh()
        }
      }}
    >
      {create.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <DatabaseBackupIcon aria-hidden />}
      {create.pending ? t.creatingBackup : t.createBackup}
    </Button>
  )

  return (
    <Panel>
      <PanelHeader>
        <div className="mr-auto flex min-w-0 flex-col py-1">
          <PanelTitle as="h2">{t.backupsSection}</PanelTitle>
          {/* Long folders truncate in the middle (§8.3): the tail is the meaningful part. */}
          <PanelDescription className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">{t.backupsIn}</span>
            <MiddleTruncate value={backupDir} tail={24} copy copyLabel={t.copyValue(t.aboutBackupDir)} className="min-w-0" />
          </PanelDescription>
        </div>
        {createButton}
      </PanelHeader>
      <PanelBody className="gap-4">
        {backups.length ? (
          <DataTable rows={backups} columns={columns} rowKey={(b) => b.name} caption={t.backupsCaption} initialSort={{ id: "date", dir: "desc" }} maxHeight="28rem" />
        ) : (
          <EmptyState icon={ArchiveIcon} title={t.backupsEmptyTitle}>{t.backupsEmptyBody}</EmptyState>
        )}
      </PanelBody>
    </Panel>
  )
}

/** "Para restaurar una copia usa la línea de comandos" (§8.9): restoring needs the service stopped. */
export function RestoreNote() {
  return (
    <Panel>
      <PanelHeader><PanelTitle as="h2">{t.restoreTitle}</PanelTitle></PanelHeader>
      <PanelBody className="gap-3">
        <PanelDescription className="text-body">{t.restoreBody}</PanelDescription>
        <CommandLine command={t.restoreCommand} copyLabel={setupText.copyCommand} />
        <PanelDescription>{t.restoreAfter}</PanelDescription>
      </PanelBody>
    </Panel>
  )
}
