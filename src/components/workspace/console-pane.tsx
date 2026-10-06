"use client"

import * as React from "react"
import { EraserIcon, FileDownIcon, RotateCcwIcon, UnplugIcon } from "lucide-react"
import { toast } from "sonner"
import { clearConsoleHistory, releaseConsolePort, retakeConsolePort } from "@/actions/consoles"
import { AppLink } from "@/components/common/app-link"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Terminal, type TerminalHandle, type TerminalStatus } from "@/components/terminal/terminal"
import { TerminalToolbar } from "@/components/terminal/terminal-toolbar"
import type { ConsoleDetailDTO } from "@/lib/contracts/equipment"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { captureDownloadName } from "@/lib/serial/format"
import { useAction } from "@/hooks/use-action"
import { workspace as t } from "@/lib/i18n/banco"
import { cn } from "@/lib/client/cn"
import { useEquipment } from "./equipment-context"
import { ReleasePortDialog } from "./release-dialog"
import { mergeRuntime } from "./runtime-merge"

/**
 * P2 "Guardar lo visible" (§8.10): the terminal buffer as a .txt, built in the browser; nothing goes to the server
 * (continuous capture already keeps everything). Returns the file name.
 */
function downloadVisible(text: string, equipmentName: string, key: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, "-")
  const name = captureDownloadName(equipmentName, key, `visible-${stamp}.txt`).ascii
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return name
}

/**
 * One console pane (§8.9): 28 px toolbar (lamp, KEY · label, adapter, line, capture, Buscar, Copiar, Descargar
 * captura, Teclas, Maximizar, ⋯) over the terminal. The overflow menu (Soltar / Retomar / Borrar historial) is for
 * the holder, and for admins while the unit is free (D24). Port problems dim the terminal under an alert with the
 * cause and, when it helps, the fix ("Retomar puerto", "Asignar puerto").
 */
export function ConsolePane({ console: c, maximized, hiddenByMaximize, onToggleMaximize, onStatus, registerHandle, className }: {
  console: ConsoleDetailDTO
  maximized: boolean
  hiddenByMaximize: boolean
  onToggleMaximize: (id: string) => void
  onStatus: (id: string, s: TerminalStatus) => void
  registerHandle: (id: string, h: TerminalHandle | null) => void
  className?: string
}) {
  const { equipment, reservation, viewer, canWriteConsoles, actions } = useEquipment()
  const term = React.useRef<TerminalHandle | null>(null)
  const [status, setStatus] = React.useState<TerminalStatus | null>(null)
  const [dialog, setDialog] = React.useState<"release" | "clear" | null>(null)
  const release = useAction(releaseConsolePort)
  const retake = useAction(retakeConsolePort)
  const clear = useAction(clearConsoleHistory)

  const runtime: ConsoleRuntimeDTO = mergeRuntime(c.runtime, status?.runtime ?? null)
  const setRef = React.useCallback((h: TerminalHandle | null) => {
    term.current = h
    registerHandle(c.id, h)
  }, [registerHandle, c.id])
  const onStatusChange = React.useCallback((s: TerminalStatus) => {
    setStatus(s)
    onStatus(c.id, s)
  }, [onStatus, c.id])

  const doRetake = React.useCallback(async () => {
    const r = await retake.run({ consoleId: c.id })
    if (r.ok) toast.success(t.retaken(c.key))
  }, [retake, c.id, c.key])

  const released = runtime.status === "released"
  const bound = runtime.status !== "unbound"
  const saveItem = (
    <DropdownMenuItem
      onSelect={() => {
        const name = downloadVisible(term.current?.bufferText() ?? "", equipment.name, c.key)
        toast.success(t.savedVisible(name))
      }}
    >
      <FileDownIcon aria-hidden />
      {t.saveVisible}
    </DropdownMenuItem>
  )
  const overflowItems = canWriteConsoles ? (
    <>
      {saveItem}
      <DropdownMenuSeparator />
      {released ? (
        <DropdownMenuItem onSelect={() => void doRetake()} disabled={retake.pending}>
          <RotateCcwIcon aria-hidden />
          {t.retakePort}
        </DropdownMenuItem>
      ) : bound ? (
        <DropdownMenuItem onSelect={() => setDialog("release")}>
          <UnplugIcon aria-hidden />
          {t.releasePort}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem variant="danger" onSelect={() => setDialog("clear")}>
        <EraserIcon aria-hidden />
        {t.clearHistory}
      </DropdownMenuItem>
    </>
  ) : saveItem

  const statusAction = (r: ConsoleRuntimeDTO): React.ReactNode => {
    if (r.status === "released" && canWriteConsoles) {
      return <Button size="sm" variant="primary" onClick={() => void doRetake()} disabled={retake.pending}>{t.retakePort}</Button>
    }
    if (r.status === "unbound" && viewer.isAdmin) {
      return <Button size="sm" asChild><AppLink href={`/equipos/${equipment.id}/ajustes`}>{t.configure}</AppLink></Button>
    }
    return null
  }

  return (
    <section
      data-console-pane=""
      data-console-id={c.id}
      aria-label={`${c.key} · ${c.label}`}
      inert={hiddenByMaximize || undefined}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-card",
        maximized && "absolute inset-2 z-20 h-auto shadow-overlay md:inset-3",
        className,
      )}
    >
      <TerminalToolbar
        console={{
          id: c.id, key: c.key, label: c.label, line: c.line, adapterShort: c.adapterShort, adapterLabel: c.adapterLabel,
          matchBy: c.matchBy, byId: c.binding?.byId ?? null,
        }}
        runtime={runtime}
        terminal={term}
        canWrite={status?.mode === "rw"}
        maximized={maximized}
        onToggleMaximize={() => onToggleMaximize(c.id)}
        overflowItems={overflowItems}
      />
      <Terminal
        ref={setRef}
        consoleId={c.id}
        keyName={c.key}
        label={c.label}
        onStatusChange={onStatusChange}
        onReserve={reservation ? undefined : () => void actions.reserve(null)}
        renderStatusAction={statusAction}
      />
      <ReleasePortDialog
        open={dialog === "release"}
        onOpenChange={(o) => setDialog(o ? "release" : null)}
        title={t.releaseTitle(c.key)}
        description={t.releaseBody(runtime.devNode)}
        confirmLabel={t.releaseConfirm}
        onConfirm={async (minutes) => {
          const r = await release.run({ consoleId: c.id, durationMin: minutes })
          if (r.ok) toast.success(t.released(c.key))
          return r.ok
        }}
      />
      <ConfirmDialog
        open={dialog === "clear"}
        onOpenChange={(o) => setDialog(o ? "clear" : null)}
        title={t.clearTitle(c.key)}
        description={t.clearBody}
        confirmLabel={t.clearConfirm}
        onConfirm={async () => {
          const r = await clear.run({ consoleId: c.id })
          if (r.ok) toast.success(t.cleared(c.key))
          return r.ok
        }}
      />
    </section>
  )
}
