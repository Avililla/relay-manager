"use client"

import * as React from "react"
import { ArrowUpIcon, FolderIcon, HomeIcon, LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DEFAULT_FILES_ROOT, type FileEntryDTO, type FilesRootId } from "@/lib/contracts/files"
import { joinRel, parentRel } from "@/lib/files/names"
import { crumbs, listUrl } from "@/lib/files/view"
import { filesUi as t } from "@/lib/i18n/files"

/**
 * "Mover": browse the folders (starting at the current one) and move the selection there. A folder cannot go into
 * itself or its own subfolders; moving to the folder it is already in is disabled.
 */
export function MoveDialog({ root = DEFAULT_FILES_ROOT, items, from, onClose, onMove }: {
  root?: FilesRootId
  items: string[] | null
  from: string
  onClose: () => void
  onMove: (toDir: string) => Promise<boolean>
}) {
  const [dir, setDir] = React.useState(from)
  const [folders, setFolders] = React.useState<FileEntryDTO[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [forItems, setForItems] = React.useState<string[] | null>(null)
  if (items !== forItems) {
    setForItems(items)
    setDir(from)
    setFolders(null)
  }
  const open = !!items?.length
  React.useEffect(() => {
    if (!open) return
    let stop = false
    fetch(listUrl(dir, root), { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json()) as { entries?: FileEntryDTO[]; message?: string }
        if (stop) return
        if (!r.ok) {
          setError(body.message ?? t.loadError)
          setFolders([])
        } else {
          setError(null)
          setFolders((body.entries ?? []).filter((e) => e.kind === "dir").sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true })))
        }
      })
      .catch(() => { if (!stop) { setError(t.loadError); setFolders([]) } })
    return () => { stop = true }
  }, [dir, open, root])
  if (!items?.length) return null
  const moving = new Set(items)
  const intoItself = items.some((p) => dir === p || dir.startsWith(`${p}/`))
  const same = dir === from
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.moveTitle(items.length, items[0].split("/").pop() ?? "")}</DialogTitle>
          <DialogDescription>{t.moveDestination}: <span className="font-mono text-data text-foreground">/{dir}</span></DialogDescription>
        </DialogHeader>
        <nav aria-label={t.moveDestination} className="flex flex-wrap items-center gap-1 text-meta">
          <Button size="sm" variant="ghost" onClick={() => { setFolders(null); setDir("") }}><HomeIcon aria-hidden />{t.root}</Button>
          {crumbs(dir).map((c) => (
            <React.Fragment key={c.path}>
              <span aria-hidden className="text-faint-foreground">/</span>
              <Button size="sm" variant="ghost" onClick={() => { setFolders(null); setDir(c.path) }}>{c.name}</Button>
            </React.Fragment>
          ))}
          {dir ? <Button size="icon-sm" variant="ghost" aria-label={t.up} onClick={() => { setFolders(null); setDir(parentRel(dir)) }}><ArrowUpIcon aria-hidden /></Button> : null}
        </nav>
        <ul className="flex max-h-64 min-h-24 flex-col overflow-y-auto rounded-md border" aria-busy={folders === null}>
          {folders === null ? (
            <li className="flex items-center gap-2 px-3 py-2 text-muted-foreground"><LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />…</li>
          ) : folders.length === 0 ? (
            <li className="px-3 py-2 text-meta text-muted-foreground">{error ?? t.moveNoSubfolders}</li>
          ) : folders.map((f) => {
            const p = joinRel(dir, f.name)
            const disabled = moving.has(p)
            return (
              <li key={f.name}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => { setFolders(null); setDir(p) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body hover:bg-secondary focus-visible:bg-secondary disabled:opacity-50"
                >
                  <FolderIcon aria-hidden className="size-4 text-brand" />
                  <span className="truncate">{f.name}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.cancelLabel}</Button>
          <Button
            variant="primary"
            pending={busy}
            disabled={same || intoItself}
            onClick={async () => {
              setBusy(true)
              try {
                if (await onMove(dir)) onClose()
              } finally {
                setBusy(false)
              }
            }}
          >
            {t.moveHere}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
