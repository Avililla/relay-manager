"use client"

import * as React from "react"
import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SimpleTooltip } from "@/components/ui/tooltip"
import type { CaptureFileDTO } from "@/lib/contracts/serial"
import { formatBytes } from "@/lib/i18n/format"
import { terminal as t } from "@/lib/i18n/shell"

type Load = { state: "idle" | "loading" | "error" } | { state: "ok"; files: CaptureFileDTO[] }

const logsUrl = (consoleId: string) => `/api/consoles/${encodeURIComponent(consoleId)}/logs`

/** Lists `/api/consoles/<id>/logs` on demand. */
function useCaptureFiles(consoleId: string): [Load, () => void] {
  const [load, setLoad] = React.useState<Load>({ state: "idle" })
  const fetchList = React.useCallback(() => {
    setLoad({ state: "loading" })
    fetch(logsUrl(consoleId), { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const files = (await res.json()) as unknown
        setLoad({ state: "ok", files: Array.isArray(files) ? (files as CaptureFileDTO[]) : [] })
      })
      .catch(() => setLoad({ state: "error" }))
  }, [consoleId])
  return [load, fetchList]
}

function CaptureItems({ consoleId, load }: { consoleId: string; load: Load }) {
  const base = logsUrl(consoleId)
  return (
    <>
      {load.state === "loading" || load.state === "idle" ? <DropdownMenuItem disabled>{t.downloadLoading}</DropdownMenuItem> : null}
      {load.state === "error" ? <DropdownMenuItem disabled>{t.downloadError}</DropdownMenuItem> : null}
      {load.state === "ok" && !load.files.length ? <DropdownMenuItem disabled>{t.downloadEmpty}</DropdownMenuItem> : null}
      {load.state === "ok" ? load.files.map((f) => (
        <DropdownMenuItem key={f.name} asChild>
          <a href={`${base}/${encodeURIComponent(f.name)}`} download className="justify-between">
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-data">{f.name}</span>
              {f.input ? <span className="text-micro text-muted-foreground">{t.downloadInput}</span> : null}
            </span>
            <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{formatBytes(f.sizeBytes)}</span>
          </a>
        </DropdownMenuItem>
      )) : null}
    </>
  )
}

/** "Descargar captura" (§8.9): lists the capture files when opened; each item downloads one file. */
export function CaptureMenu({ consoleId, size = "icon-sm" }: { consoleId: string; size?: "icon-sm" | "icon" }) {
  const [load, fetchList] = useCaptureFiles(consoleId)
  return (
    <DropdownMenu onOpenChange={(o) => { if (o) fetchList() }}>
      <SimpleTooltip label={t.download}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size={size} aria-label={t.download}>
            <DownloadIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{t.download}</DropdownMenuLabel>
        <CaptureItems consoleId={consoleId} load={load} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The same list as a submenu, for the overflow "⋯" of a narrow pane. */
export function CaptureSubMenu({ consoleId }: { consoleId: string }) {
  const [load, fetchList] = useCaptureFiles(consoleId)
  return (
    <DropdownMenuSub onOpenChange={(o) => { if (o) fetchList() }}>
      <DropdownMenuSubTrigger>
        <DownloadIcon aria-hidden />
        {t.download}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        <CaptureItems consoleId={consoleId} load={load} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
