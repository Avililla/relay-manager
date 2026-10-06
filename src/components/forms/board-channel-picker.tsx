"use client"

import * as React from "react"
import { AppLink } from "@/components/common/app-link"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { BoardChoiceDTO } from "@/lib/contracts/relays"
import { forms } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

export interface BoardChannel { boardId: string; channel: number }

/**
 * Board + free channel (§8.8). Channels already used by other rows of the same draft (`taken`, "boardId:channel")
 * are left out; the row's own channel stays selectable. With 0 boards it is disabled with
 * "Registra primero una placa de relés" and a link to Descubrimiento.
 */
export function BoardChannelPicker({ boards, value, onChange, taken = [], invalid, className, labelPrefix = "" }: {
  boards: BoardChoiceDTO[]
  value: BoardChannel | null
  onChange: (v: BoardChannel | null) => void
  taken?: string[]
  invalid?: boolean
  className?: string
  labelPrefix?: string
}) {
  if (!boards.length) {
    return (
      <p className={cn("flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground", className)}>
        {forms.noBoards}.
        <AppLink href="/descubrimiento?tab=reles" className="text-brand underline-offset-4 hover:underline">{forms.goDiscovery}</AppLink>
      </p>
    )
  }
  const board = boards.find((b) => b.id === value?.boardId) ?? null
  const takenSet = new Set(taken.filter((k) => k !== (value ? `${value.boardId}:${value.channel}` : "")))
  const channels = board ? [...new Set([...(board.freeChannels ?? []), ...(value && value.boardId === board.id ? [value.channel] : [])])].sort((a, b) => a - b).filter((c) => !takenSet.has(`${board.id}:${c}`)) : []
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Select
        value={value?.boardId ?? ""}
        onValueChange={(id) => {
          const b = boards.find((x) => x.id === id)
          const first = b?.freeChannels.find((c) => !takenSet.has(`${id}:${c}`))
          onChange(b && first !== undefined ? { boardId: b.id, channel: first } : null)
        }}
      >
        <SelectTrigger aria-label={`${labelPrefix}${forms.board}`} aria-invalid={invalid || undefined} className="w-56">
          <SelectValue placeholder={forms.chooseBoard} />
        </SelectTrigger>
        <SelectContent>
          {boards.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name}{b.model ? ` · ${b.model}` : ""}{b.online === false ? ` (${forms.boardOffline})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={value ? String(value.channel) : ""}
        disabled={!board || channels.length === 0}
        onValueChange={(c) => board && onChange({ boardId: board.id, channel: Number(c) })}
      >
        <SelectTrigger aria-label={`${labelPrefix}${forms.channel}`} aria-invalid={invalid || undefined} className="w-40 tabular-nums">
          <SelectValue placeholder={board && channels.length === 0 ? forms.noFreeChannels : forms.chooseChannel} />
        </SelectTrigger>
        <SelectContent>
          {channels.map((c) => <SelectItem key={c} value={String(c)} className="font-mono text-data">{forms.channelN(c)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}
