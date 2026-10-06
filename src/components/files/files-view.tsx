"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import {
  ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ChevronDownIcon, CircleSlashIcon, CloudDownloadIcon, CopyIcon, DownloadIcon, FileArchiveIcon, FileIcon, FolderIcon, FolderInputIcon,
  FolderOpenIcon, FolderPlusIcon, HardDriveIcon, Link2Icon, MoreHorizontalIcon, PencilIcon, RefreshCwIcon, SearchIcon, SendIcon, Trash2Icon,
  UploadIcon, XIcon, type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { createFolder, deleteEntries, moveEntries, renameEntry } from "@/actions/files"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { CopyButton } from "@/components/common/copy-button"
import { EmptyState } from "@/components/common/empty-state"
import { InlineAlert } from "@/components/common/inline-alert"
import { Page, PageHeader } from "@/components/common/page"
import { RelativeTime } from "@/components/common/relative-time"
import { PageMeta } from "@/components/shell/page-meta"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { useAction } from "@/hooks/use-action"
import { parseFilesRoot, type FileEntryDTO, type FilesPageDTO, type FilesRootId } from "@/lib/contracts/files"
import { joinRel, parentRel, parseRelPath } from "@/lib/files/names"
import { uploadEngine } from "@/lib/files/upload-store"
import { crumbs, downloadUrl, filterEntries, pageUrl, sortEntries, totals, type SortKey, type SortState } from "@/lib/files/view"
import { formatBytes } from "@/lib/i18n/format"
import { filesUi as t } from "@/lib/i18n/files"
import { copyUi } from "@/lib/i18n/copy"
import { sendUi } from "@/lib/i18n/send"
import { cn } from "@/lib/client/cn"
import { ArchiveMenu, triggerDownload } from "./archive-menu"
import { ConflictDialog, type ConflictChoice } from "./conflict-dialog"
import { CopyDialog, type CopyItem } from "./copy-dialog"
import { CopyPanel } from "./copy-panel"
import { ExportDialog } from "./export-dialog"
import { ExportPanel } from "./export-panel"
import { MoveDialog } from "./move-dialog"
import { NameDialog } from "./name-dialog"
import { SendDialog, type SendItem } from "./send-dialog"
import { SendPanel } from "./send-panel"
import { TransferDock, UploadPanel } from "./upload-panel"
import { useFileDrop } from "./use-file-drop"
import { useFilesListing } from "./use-files-listing"
import { useCopies } from "./use-copies"
import { useExports } from "./use-exports"
import { useSends } from "./use-sends"
import { useLeaveGuard, useUploads } from "./use-uploads"

const LOW_SPACE = 1024 ** 3

/** Navigation inside the page: the address changes (history entry, shareable link) without a server round trip. */
function go(path: string, root: FilesRootId, replace = false): void {
  const url = pageUrl(path, root)
  if (replace) window.history.replaceState(null, "", url)
  else window.history.pushState(null, "", url)
}

/** One action of a row, shown in its «⋯» menu and in its right-click menu. */
interface RowAction { key: string; label: string; icon: LucideIcon; onSelect: () => void; danger?: boolean; separatorBefore?: boolean }

function EntryIcon({ e }: { e: FileEntryDTO }) {
  if (e.kind === "dir") return <FolderIcon aria-hidden className="size-4 shrink-0 text-brand" />
  if (e.kind === "other") return <CircleSlashIcon aria-hidden className="size-4 shrink-0 text-faint-foreground" />
  return <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
}

/**
 * Archivos: the shared folder of the bench host. Breadcrumb navigation, a sortable and filterable table, uploads by
 * button or drag and drop (queue with progress, speed, cancel and conflict choice), new folder, rename, move,
 * delete (confirmed), single-file and .zip downloads, the free space and (for administrators) the server path.
 * Live: other people's changes (SSE), our own uploads, focus and a slow poll.
 */
export function FilesView({ data }: { data: FilesPageDTO }) {
  const sp = useSearchParams()
  const root: FilesRootId = parseFilesRoot(sp.get("raiz")) ?? data.root
  const parsed = parseRelPath(sp.get("ruta") ?? "")
  const path = parsed.ok ? parsed.path : ""
  const listing = useFilesListing(data, root, path)
  const nav = (p: string) => go(p, root)
  const rootInfo = data.roots.find((r) => r.id === root) ?? null
  const rootPath = rootInfo ? rootInfo.path : data.rootPath
  const rootLabel = rootInfo?.label ?? root
  const entries = React.useMemo(() => listing.listing?.entries ?? [], [listing.listing])
  const [filter, setFilter] = React.useState("")
  const [sort, setSort] = React.useState<SortState>({ key: "name", dir: "asc" })
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  const [selectedFor, setSelectedFor] = React.useState(`${root}\0${path}`)
  const [newFolder, setNewFolder] = React.useState(false)
  const [renaming, setRenaming] = React.useState<FileEntryDTO | null>(null)
  const [moving, setMoving] = React.useState<string[] | null>(null)
  const [deleting, setDeleting] = React.useState<FileEntryDTO[] | null>(null)
  const [conflicts, setConflicts] = React.useState<{ names: string[]; files: File[]; root: FilesRootId; dir: string } | null>(null)
  const [sending, setSending] = React.useState<SendItem[] | null>(null)
  const sends = useSends()
  const [copying, setCopying] = React.useState<CopyItem[] | null>(null)
  const copies = useCopies(data.canCopy)
  const exports = useExports(data.exportRoot !== null)
  const exportInfo = exports.info ?? data.exports
  const [exporting, setExporting] = React.useState(false)
  const canExport = root === data.exportRoot && !!exportInfo
  const fileInput = React.useRef<HTMLInputElement>(null)
  const uploads = useUploads()
  const activeUploads = uploads.some((u) => u.status === "queued" || u.status === "uploading")
  useLeaveGuard(activeUploads)

  if (selectedFor !== `${root}\0${path}`) {
    setSelectedFor(`${root}\0${path}`)
    setSelected(new Set())
    setFilter("")
  }

  const mkdir = useAction(createFolder)
  const rename = useAction(renameEntry, { successMessage: t.renamed })
  const move = useAction(moveEntries, { successMessage: (d) => t.moved(d.moved) })
  const remove = useAction(deleteEntries, { successMessage: (d) => t.deleted(d.removed) })

  const visible = React.useMemo(() => sortEntries(filterEntries(entries, filter), sort), [entries, filter, sort])
  const names = React.useMemo(() => new Set(entries.map((e) => e.name)), [entries])
  const selectedEntries = entries.filter((e) => selected.has(e.name))
  const allVisibleSelected = visible.length > 0 && visible.every((e) => selected.has(e.name))
  const someSelected = visible.some((e) => selected.has(e.name))
  const sum = totals(entries)
  const disk = listing.listing?.disk ?? null
  const shownPath = listing.path
  const settings = data.settings
  const canDelete = data.canDelete

  // ---------------------------------------------------------------------------------------------------------
  // Uploads
  const enqueue = React.useCallback((files: File[], rt: FilesRootId, dir: string, choices: Map<string, ConflictChoice>) => {
    const reqs = files.flatMap((f) => {
      const c = choices.get(f.name) ?? "fail"
      return c === "skip" ? [] : [{ file: f, root: rt, rootLabel: data.roots.find((r) => r.id === rt)?.label ?? rt, dir, conflict: c }]
    })
    if (reqs.length) uploadEngine().add(reqs)
  }, [data.roots])

  const startUploads = React.useCallback((files: File[], folders = 0) => {
    if (folders) toast.warning(t.dropNoFolders)
    if (!files.length || listing.error || !listing.listing) return
    const dir = listing.path
    const rt = listing.root
    const ok: File[] = []
    for (const f of files) {
      if (f.size > settings.maxUploadBytes) toast.error(t.tooBig(f.name, settings.maxUploadBytes))
      else ok.push(f)
    }
    // The same name twice in one batch: the second keeps both.
    const seen = new Set<string>()
    const clashes = [...new Set(ok.filter((f) => names.has(f.name)).map((f) => f.name))]
    const choices = new Map<string, ConflictChoice>()
    for (const f of ok) {
      if (seen.has(f.name) && !names.has(f.name)) choices.set(f.name, "rename")
      seen.add(f.name)
    }
    if (clashes.length) setConflicts({ names: clashes, files: ok, root: rt, dir })
    else enqueue(ok, rt, dir, choices)
  }, [listing.error, listing.listing, listing.path, listing.root, settings.maxUploadBytes, names, enqueue])

  const dragging = useFileDrop(startUploads, !listing.error && !!listing.listing)

  // ---------------------------------------------------------------------------------------------------------
  const toggle = (name: string, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(name)
    else next.delete(name)
    setSelected(next)
  }
  const cycleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }))
  const where = shownPath ? `${rootLabel} / ${shownPath.split("/").join(" / ")}` : rootLabel

  /** «Enviar a equipo…» on a row: the whole selection when the row is part of a selection of files, else the row. */
  const sendItemsFor = (e: FileEntryDTO): SendItem[] => {
    const sel = selected.has(e.name) && selectedEntries.length > 1 && selectedEntries.every((x) => x.kind === "file") ? selectedEntries : [e]
    return sel.map((x) => ({ path: joinRel(shownPath, x.name), name: x.name, root }))
  }
  const rowActions = (e: FileEntryDTO, rel: string): RowAction[] => [
    ...(e.kind === "dir" ? [{ key: "open", label: t.openFolder(e.name), icon: FolderOpenIcon, onSelect: () => nav(rel) }] : []),
    ...(e.kind === "file" ? [
      { key: "download", label: t.download, icon: DownloadIcon, onSelect: () => triggerDownload(downloadUrl(rel, root)) },
      { key: "send", label: sendUi.menuItem, icon: SendIcon, onSelect: () => setSending(sendItemsFor(e)) },
      ...(data.canCopy ? [{ key: "copy", label: copyUi.menuItem, icon: CopyIcon, onSelect: () => setCopying(sendItemsFor(e)) }] : []),
    ] : []),
    { key: "rename", label: t.rename, icon: PencilIcon, onSelect: () => setRenaming(e), separatorBefore: e.kind !== "other" },
    { key: "move", label: t.move, icon: FolderInputIcon, onSelect: () => setMoving([rel]) },
    ...(canDelete ? [{ key: "delete", label: t.delete, icon: Trash2Icon, onSelect: () => setDeleting([e]), danger: true, separatorBefore: true }] : []),
  ]

  const header = (key: SortKey, label: string, align: "left" | "right" = "left", className?: string) => {
    const active = sort.key === key
    return (
      <TableHead aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={cn(align === "right" && "text-right", className)}>
        <button type="button" onClick={() => cycleSort(key)} className={cn("-mx-1 inline-flex items-center gap-1 rounded-sm px-1 hover:text-foreground", active && "text-foreground", align === "right" && "flex-row-reverse")}>
          {label}
          {active ? (sort.dir === "asc" ? <ArrowUpIcon aria-hidden className="size-3.5" /> : <ArrowDownIcon aria-hidden className="size-3.5" />)
            : <ArrowUpDownIcon aria-hidden className="size-3.5 text-faint-foreground" />}
        </button>
      </TableHead>
    )
  }

  const breadcrumbs = [
    { label: t.title, href: shownPath || root !== data.roots[0]?.id ? "/archivos" : undefined },
    ...(data.roots.length > 1 ? [{ label: rootLabel, href: shownPath ? pageUrl("", root) : undefined }] : []),
    ...crumbs(shownPath).map((c, i, all) => ({ label: c.name, href: i < all.length - 1 ? pageUrl(c.path, root) : undefined })),
  ]

  return (
    <Page>
      <PageMeta breadcrumbs={breadcrumbs} />
      <PageHeader
        title={t.title}
        summary={listing.listing ? t.summary(sum.dirs, sum.files, sum.bytes) : undefined}
        actions={(
          <>
            {canExport && exportInfo ? (
              <Button variant="outline" onClick={() => setExporting(true)} disabled={!!listing.error || !listing.listing} data-testid="export-open">
                <CloudDownloadIcon aria-hidden />{exportInfo.labels.title}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setNewFolder(true)} disabled={!!listing.error || !listing.listing}><FolderPlusIcon aria-hidden />{t.newFolder}</Button>
            <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={!!listing.error || !listing.listing}><UploadIcon aria-hidden />{t.upload}</Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="files-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ""
                startUploads(files)
              }}
            />
          </>
        )}
      >
        <p className="max-w-[80ch] text-meta text-muted-foreground">{t.intro} {t.maxSize(settings.maxUploadBytes)}.</p>
      </PageHeader>

      {data.roots.length > 1 ? (
        <nav aria-label={t.rootsLabel} className="-mb-1 flex h-9 items-stretch gap-1 overflow-x-auto border-b [scrollbar-width:none]" data-testid="files-roots">
          {data.roots.map((r) => {
            const active = r.id === root
            return (
              <a
                key={r.id}
                href={pageUrl("", r.id)}
                aria-current={active ? "page" : undefined}
                title={r.hint}
                data-root={r.id}
                onClick={(ev) => {
                  if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return
                  ev.preventDefault()
                  if (!active || shownPath) go("", r.id)
                }}
                className={cn(
                  "relative inline-flex shrink-0 items-center gap-1.5 px-2.5 text-body font-medium whitespace-nowrap text-muted-foreground hover:text-foreground",
                  "after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent",
                  active && "text-foreground after:bg-brand",
                )}
              >
                <HardDriveIcon aria-hidden className="size-4 shrink-0" />{r.label}
              </a>
            )
          })}
        </nav>
      ) : null}

      {rootPath ? (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
          <span className="font-medium text-foreground">{t.serverFolder}:</span>
          <span className="min-w-0 font-mono text-data break-all text-foreground" data-testid="files-server-path">{shownPath ? `${rootPath}/${shownPath}` : rootPath}</span>
          <CopyButton value={shownPath ? `${rootPath}/${shownPath}` : rootPath} />
        </p>
      ) : null}

      <nav aria-label={t.pathLabel} className="flex min-w-0 flex-wrap items-center gap-1">
        <ol className="flex min-w-0 flex-wrap items-center gap-1 text-body">
          <li>
            <a
              href={pageUrl("", root)}
              aria-current={shownPath ? undefined : "page"}
              onClick={(e) => { e.preventDefault(); nav("") }}
              className={cn("inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 hover:bg-secondary", !shownPath ? "font-medium text-foreground" : "text-brand")}
            >
              <HardDriveIcon aria-hidden className="size-4" />{data.roots.length > 1 ? rootLabel : t.root}
            </a>
          </li>
          {crumbs(shownPath).map((c, i, all) => (
            <li key={c.path} className="flex min-w-0 items-center gap-1">
              <span aria-hidden className="text-faint-foreground">/</span>
              {i === all.length - 1 ? (
                <span aria-current="page" className="truncate px-1.5 font-medium text-foreground">{c.name}</span>
              ) : (
                <a href={pageUrl(c.path, root)} onClick={(e) => { e.preventDefault(); nav(c.path) }} className="truncate rounded-sm px-1.5 py-0.5 text-brand hover:bg-secondary">{c.name}</a>
              )}
            </li>
          ))}
        </ol>
        {shownPath ? (
          <SimpleTooltip label={t.up}>
            <Button variant="ghost" size="icon-sm" aria-label={t.up} onClick={() => nav(parentRel(shownPath))}><ArrowUpIcon aria-hidden /></Button>
          </SimpleTooltip>
        ) : null}
      </nav>

      {listing.error ? (
        listing.error.kind === "not-found" || listing.error.kind === "not-dir" || listing.error.kind === "invalid" ? (
          <EmptyState icon={FolderOpenIcon} title={t.notFoundTitle} actions={<Button variant="outline" onClick={() => nav("")}>{t.backToRoot}</Button>}>
            {listing.error.kind === "not-found" ? t.notFoundBody : listing.error.message}
          </EmptyState>
        ) : (
          <InlineAlert tone="danger" title={t.unavailableTitle} actions={<Button variant="outline" size="sm" onClick={() => void listing.refresh()}>{t.retry}</Button>}>
            {listing.error.message}
          </InlineAlert>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-72">
              <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t.filterPlaceholder} aria-label={t.filterLabel} className="pl-8" />
            </div>
            {selectedEntries.length ? (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t.selected(selectedEntries.length)}>
                <span className="px-1 text-meta tabular-nums text-foreground">{t.selected(selectedEntries.length)}</span>
                {selectedEntries.length === 1 && selectedEntries[0].kind === "file" ? (
                  <Button size="sm" variant="outline" onClick={() => triggerDownload(downloadUrl(joinRel(shownPath, selectedEntries[0].name), root))}>
                    <DownloadIcon aria-hidden />{t.download}
                  </Button>
                ) : (
                  <ArchiveMenu root={root} dir={shownPath} names={selectedEntries.map((e) => e.name)}>
                    <Button size="sm" variant="outline"><FileArchiveIcon aria-hidden />{t.downloadSelection}<ChevronDownIcon aria-hidden /></Button>
                  </ArchiveMenu>
                )}
                {selectedEntries.every((e) => e.kind === "file") ? (
                  <Button size="sm" variant="outline" onClick={() => setSending(selectedEntries.map((e) => ({ path: joinRel(shownPath, e.name), name: e.name, root })))}>
                    <SendIcon aria-hidden />{sendUi.selectionButton}
                  </Button>
                ) : null}
                {data.canCopy && selectedEntries.every((e) => e.kind === "file") ? (
                  <Button size="sm" variant="outline" onClick={() => setCopying(selectedEntries.map((e) => ({ path: joinRel(shownPath, e.name), name: e.name, root })))}>
                    <CopyIcon aria-hidden />{copyUi.selectionButton}
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => setMoving(selectedEntries.map((e) => joinRel(shownPath, e.name)))}><FolderInputIcon aria-hidden />{t.move}</Button>
                {canDelete ? <Button size="sm" variant="danger-outline" onClick={() => setDeleting(selectedEntries)}><Trash2Icon aria-hidden />{t.delete}</Button> : null}
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}><XIcon aria-hidden />{t.clearSelection}</Button>
              </div>
            ) : null}
            <span className="flex-1" />
            {disk ? (
              <span className={cn("inline-flex items-center gap-1.5 text-meta tabular-nums", disk.freeBytes < LOW_SPACE ? "text-foreground" : "text-muted-foreground")} data-testid="files-free">
                <HardDriveIcon aria-hidden className={cn("size-3.5", disk.freeBytes < LOW_SPACE ? "text-warn" : "text-faint-foreground")} />
                {t.free(disk.freeBytes, disk.totalBytes)}
                {disk.freeBytes < LOW_SPACE ? <span className="sr-only">{t.lowSpace}</span> : null}
              </span>
            ) : null}
            <SimpleTooltip label={t.refresh}>
              <Button variant="ghost" size="icon-sm" aria-label={t.refresh} onClick={() => void listing.refresh()}>
                <RefreshCwIcon aria-hidden className={listing.loading ? "animate-spin motion-reduce:animate-none" : undefined} />
              </Button>
            </SimpleTooltip>
          </div>

          {listing.listing?.truncated ? <InlineAlert tone="warn">{t.truncated(listing.listing.entries.length)}</InlineAlert> : null}

          {listing.listing && entries.length === 0 ? (
            <EmptyState
              icon={FolderOpenIcon}
              title={t.emptyTitle}
              actions={<Button variant="primary" onClick={() => fileInput.current?.click()}><UploadIcon aria-hidden />{t.upload}</Button>}
            >
              {t.emptyBody}
            </EmptyState>
          ) : (
            <Table containerClassName="rounded-lg border bg-card" aria-busy={listing.loading}>
              <caption className="sr-only">{where}</caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10 first:rounded-tl-lg">
                    <Checkbox
                      aria-label={t.selectAll}
                      checked={allVisibleSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={(v) => setSelected(v === true ? new Set([...selected, ...visible.map((e) => e.name)]) : new Set())}
                      disabled={!visible.length}
                    />
                  </TableHead>
                  {header("name", t.name)}
                  {header("size", t.size, "right")}
                  {header("mtime", t.modified, "left", "hidden sm:table-cell")}
                  <TableHead className="text-right last:rounded-tr-lg"><span className="sr-only">{t.actions}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length ? visible.map((e) => {
                  const rel = joinRel(shownPath, e.name)
                  const isSel = selected.has(e.name)
                  const actions = rowActions(e, rel)
                  return (
                    <ContextMenu key={e.name}>
                    <ContextMenuTrigger asChild>
                    <TableRow data-state={isSel ? "selected" : undefined} data-entry={e.name} data-kind={e.kind}>
                      <TableCell className="w-10">
                        <Checkbox aria-label={t.selectRow(e.name)} checked={isSel} onCheckedChange={(v) => toggle(e.name, v === true)} />
                      </TableCell>
                      <TableCell className="max-w-[min(60ch,55vw)]">
                        <span className="flex min-w-0 items-center gap-2">
                          <EntryIcon e={e} />
                          {e.kind === "dir" ? (
                            <a href={pageUrl(rel, root)} onClick={(ev) => { if (!ev.metaKey && !ev.ctrlKey && !ev.shiftKey) { ev.preventDefault(); nav(rel) } }} className="min-w-0 truncate font-medium text-foreground hover:text-brand hover:underline">
                              {e.name}
                            </a>
                          ) : e.kind === "file" ? (
                            <a href={downloadUrl(rel, root)} download className="min-w-0 truncate text-foreground hover:text-brand hover:underline" title={t.downloadFile(e.name)}>
                              {e.name}
                            </a>
                          ) : (
                            <SimpleTooltip label={t.unavailableEntryHint}>
                              <span tabIndex={0} className="min-w-0 truncate text-muted-foreground">{e.name} <span className="text-meta">({t.unavailableEntry})</span></span>
                            </SimpleTooltip>
                          )}
                          {e.link && e.kind !== "other" ? (
                            <SimpleTooltip label={t.linkTo}><Link2Icon aria-label={t.link} className="size-3.5 shrink-0 text-faint-foreground" /></SimpleTooltip>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-data tabular-nums whitespace-nowrap text-muted-foreground">
                        {e.kind === "file" && e.size !== null ? <span title={`${new Intl.NumberFormat("es-ES").format(e.size)} B`}>{formatBytes(e.size)}</span> : null}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-meta text-muted-foreground sm:table-cell">
                        {e.mtime ? <RelativeTime value={e.mtime} /> : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="inline-flex items-center gap-0.5">
                          {e.kind === "file" ? (
                            <Button asChild variant="ghost" size="icon-sm">
                              <a href={downloadUrl(rel, root)} download aria-label={t.downloadFile(e.name)}><DownloadIcon aria-hidden /></a>
                            </Button>
                          ) : e.kind === "dir" ? (
                            <ArchiveMenu root={root} dir={shownPath} names={[e.name]}>
                              <Button variant="ghost" size="icon-sm" aria-label={t.downloadFolder(e.name)}><FileArchiveIcon aria-hidden /></Button>
                            </ArchiveMenu>
                          ) : <span className="inline-block size-7" />}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={t.moreActions(e.name)}><MoreHorizontalIcon aria-hidden /></Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {actions.filter((a) => a.key !== "open" && a.key !== "download").map((a, i) => (
                                <React.Fragment key={a.key}>
                                  {a.separatorBefore && i > 0 ? <DropdownMenuSeparator /> : null}
                                  <DropdownMenuItem variant={a.danger ? "danger" : "default"} onSelect={a.onSelect}><a.icon aria-hidden />{a.label}</DropdownMenuItem>
                                </React.Fragment>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </span>
                      </TableCell>
                    </TableRow>
                    </ContextMenuTrigger>
                    <ContextMenuContent aria-label={t.moreActions(e.name)}>
                      {actions.map((a, i) => (
                        <React.Fragment key={a.key}>
                          {a.separatorBefore && i > 0 ? <ContextMenuSeparator /> : null}
                          <ContextMenuItem variant={a.danger ? "danger" : "default"} onSelect={a.onSelect}><a.icon aria-hidden />{a.label}</ContextMenuItem>
                        </React.Fragment>
                      ))}
                    </ContextMenuContent>
                    </ContextMenu>
                  )
                }) : (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="py-6 text-muted-foreground">{t.noMatches}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
          {!canDelete ? <p className="text-meta text-muted-foreground">{t.deleteAdminOnly}</p> : null}
        </>
      )}

      {dragging ? (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-background/80 p-6">
          <div className="flex max-w-lg flex-col items-center gap-3 rounded-xl border-2 border-dashed border-brand bg-card px-8 py-10 text-center">
            <UploadIcon className="size-8 text-brand" />
            <p className="text-section text-foreground">{t.dropHere(where)}</p>
            <p className="text-meta text-muted-foreground">{t.maxSize(settings.maxUploadBytes)}</p>
          </div>
        </div>
      ) : null}

      <TransferDock>
        {data.exportRoot ? <ExportPanel items={exports.jobs} root={data.exportRoot} rootLabel={exportInfo?.rootLabel ?? data.exportRoot} name={exportInfo?.labels.name ?? null} onOpenFolder={(dir) => go(dir, data.exportRoot ?? "tftp")} /> : null}
        <CopyPanel items={copies} />
        <SendPanel items={sends} />
        <UploadPanel items={uploads} canReplace={canDelete} />
      </TransferDock>
      <SendDialog items={sending} onClose={() => setSending(null)} />
      {data.canCopy ? <CopyDialog items={copying} onClose={() => setCopying(null)} /> : null}
      {canExport && exportInfo ? <ExportDialog open={exporting} dir={shownPath} info={exportInfo} onClose={() => setExporting(false)} /> : null}

      <ConflictDialog
        names={conflicts?.names ?? null}
        canReplace={canDelete}
        onDone={(choices) => {
          const c = conflicts
          setConflicts(null)
          if (c) enqueue(c.files, c.root, c.dir, choices)
        }}
      />

      <NameDialog
        open={newFolder}
        title={t.newFolderTitle}
        label={t.folderName}
        submitLabel={t.create}
        initial=""
        field="name"
        onClose={() => setNewFolder(false)}
        onSubmit={async (name) => {
          const r = await mkdir.run({ root, dir: shownPath, name })
          if (r.ok) {
            toast.success(t.created(name))
            void listing.refresh()
            return null
          }
          return r.error.fieldErrors ?? {}
        }}
      />
      <NameDialog
        open={!!renaming}
        title={renaming ? t.renameTitle(renaming.name) : ""}
        label={t.newName}
        submitLabel={t.save}
        initial={renaming?.name ?? ""}
        field="newName"
        onClose={() => setRenaming(null)}
        onSubmit={async (newName) => {
          if (!renaming) return null
          const r = await rename.run({ root, path: joinRel(shownPath, renaming.name), newName })
          if (r.ok) {
            setSelected(new Set())
            void listing.refresh()
            return null
          }
          return r.error.fieldErrors ?? {}
        }}
      />
      <MoveDialog
        root={root}
        items={moving}
        from={shownPath}
        onClose={() => setMoving(null)}
        onMove={async (toDir) => {
          const r = await move.run({ root, paths: moving ?? [], toDir })
          if (r.ok) {
            setSelected(new Set())
            void listing.refresh()
          }
          return r.ok
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => { if (!o) setDeleting(null) }}
        title={deleting ? t.deleteTitle(deleting.length, deleting[0]?.name ?? "") : ""}
        description={deleting?.some((d) => d.kind === "dir") ? `${t.deleteBody} ${t.deleteBodyFolder}` : t.deleteBody}
        confirmLabel={t.delete}
        onConfirm={async () => {
          if (!deleting) return true
          const r = await remove.run({ root, paths: deleting.map((d) => joinRel(shownPath, d.name)) })
          if (r.ok) {
            setSelected(new Set())
            void listing.refresh()
          }
          return r.ok
        }}
      >
        {deleting && deleting.length > 1 ? (
          <ul className="max-h-40 overflow-y-auto rounded-md border px-3 py-2 font-mono text-data text-foreground">
            {deleting.map((d) => <li key={d.name} className="truncate">{d.kind === "dir" ? `${d.name}/` : d.name}</li>)}
          </ul>
        ) : null}
      </ConfirmDialog>
      <span className="sr-only" aria-live="polite">{listing.loading ? "" : where}</span>
    </Page>
  )
}
