"use client"

import * as React from "react"
import { StatusChip } from "@/components/common/status-chip"
import { useStale } from "@/hooks/use-server-events"
import { useMounted } from "@/hooks/use-mounted"
import type { BoardDTO } from "@/lib/contracts/relays"
import { formatTime } from "@/lib/i18n/format"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { connection } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"
import { boardStatusView } from "./board-view"

/**
 * Board status (§8.6): Conectada / Sin respuesta desde … / Sin leer todavía / Desactivada, icon + text + colour.
 * The clock time appears after mount (server and browser time zones may differ). Without a live connection the
 * chip is dimmed and says why in its tooltip.
 */
export function BoardStatusChip({ board, quiet = false, className }: { board: Pick<BoardDTO, "enabled" | "runtime">; quiet?: boolean; className?: string }) {
  const mounted = useMounted()
  const stale = useStale()
  const view = boardStatusView(board, (iso) => formatTime(iso))
  const label = !mounted && view.kind === "offline" ? RELAY_TEXT.boardOffline : view.label
  return (
    <StatusChip
      tone={view.tone}
      icon={view.icon}
      quiet={quiet}
      title={stale ? connection.staleState : undefined}
      className={cn(stale && "opacity-60", className)}
    >
      {label}
    </StatusChip>
  )
}
