"use client"

import * as React from "react"
import { FileArchiveIcon } from "lucide-react"
import { useViewer } from "@/components/shell/shell-context"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePreference } from "@/hooks/use-preference"
import { ARCHIVE_FORMATS, DEFAULT_FILES_ROOT, type ArchiveFormat, type FilesRootId } from "@/lib/contracts/files"
import { archiveFormatKey } from "@/lib/client/prefs"
import { archiveUrl } from "@/lib/files/view"
import { filesUi as t } from "@/lib/i18n/files"

/** Starts a download without leaving the page (the server answers with Content-Disposition: attachment). */
export function triggerDownload(href: string): void {
  const a = document.createElement("a")
  a.href = href
  a.rel = "noopener"
  a.download = ""
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const LABEL: Record<ArchiveFormat, string> = { zip: t.formatZip, "tar.gz": t.formatTgz }

/**
 * "Descargar como": a folder or a selection as ZIP or TAR.GZ. The last format chosen by this user (in this browser)
 * comes first and is marked.
 */
export function ArchiveMenu({ root = DEFAULT_FILES_ROOT, dir, names, children }: { root?: FilesRootId; dir: string; names: string[]; children: React.ReactElement }) {
  const viewer = useViewer()
  const [last, setLast] = usePreference(archiveFormatKey(viewer.id))
  const order: readonly ArchiveFormat[] = last === "tar.gz" ? ["tar.gz", "zip"] : ARCHIVE_FORMATS
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t.downloadAs}</DropdownMenuLabel>
        {order.map((f) => (
          <DropdownMenuItem
            key={f}
            data-format={f}
            onSelect={() => {
              setLast(f)
              triggerDownload(archiveUrl(dir, names, f, root))
            }}
          >
            <FileArchiveIcon aria-hidden />
            {LABEL[f]}
            {last === f ? <span className="ml-auto pl-3 text-meta text-muted-foreground">{t.lastUsed}</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
