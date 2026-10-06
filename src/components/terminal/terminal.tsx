"use client"

import * as React from "react"
import "@xterm/xterm/css/xterm.css"
import { toast } from "sonner"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import type { ViewerPresenceDTO, WsMode } from "@/lib/contracts/ws"
import { copyText } from "@/lib/client/clipboard"
import { formatBytes } from "@/lib/i18n/format"
import { actions, common, terminal as t } from "@/lib/i18n/shell"
import { usePreference } from "@/hooks/use-preference"
import { useReducedMotion } from "@/hooks/use-reduced-motion"
import { cn } from "@/lib/client/cn"
import { consoleStatusView, isPortProblem } from "@/components/serial/console-status"
import { takeFrame } from "./outbox"
import { TerminalSearchBar } from "./search-bar"
import type { SocketState } from "./socket-machine"
import { useConsoleSocket, type SocketHello } from "./use-console-socket"
import { useXterm } from "./use-xterm"

export const PASTE_CONFIRM_BYTES = 4096
const PASTE_CHUNK_BYTES = 4096
const PASTE_CHUNK_GAP_MS = 70 // ≈ 58 KiB/s, under the server's 64 KiB/s input budget
const CALLOUT_MS = 4000

export interface TerminalStatus {
  state: SocketState
  mode: WsMode | null
  runtime: ConsoleRuntimeDTO | null
  viewers: ViewerPresenceDTO[]
  hello: SocketHello | null
  renderer: "webgl" | "dom" | null
}

export interface TerminalHandle {
  focus(): void
  /** Copies the selection (works over plain HTTP); false when nothing is selected or copying failed. */
  copySelection(): Promise<boolean>
  hasSelection(): boolean
  openSearch(): void
  /** Sends raw bytes ("Teclas" menu). Shows the read-only hint and returns false when not `rw`. */
  sendKeys(bytes: string): boolean
  sendBreak(ms?: number): boolean
  retry(): void
  /** The visible buffer as text (P2 "Guardar lo visible"). */
  bufferText(): string
  /** Current grid size (after the last fit). */
  dimensions(): { cols: number; rows: number } | null
}

type Callout = { kind: "reserve" | "info"; text: string } | null

const utf8 = new TextEncoder()

/**
 * xterm host for a console pane (§8.10): WebGL renderer with DOM fallback, refit on pane resize, read-only aware
 * input, Shift+Tab leaves the terminal, Ctrl+Shift+C copies, large pastes ask first and are paced, search bar,
 * status overlays. The pane chrome (toolbar, reservation) belongs to the workspace; it talks to the terminal
 * through `ref` (TerminalHandle) and `onStatusChange`.
 */
export function Terminal({ consoleId, keyName, label, renderer = "webgl", socketPath, onStatusChange, onReserve, renderStatusAction, className, ref }: {
  consoleId: string
  keyName: string
  label: string
  renderer?: "webgl" | "dom"
  /** Overrides `/ws/console/<consoleId>` (development and tests only, e.g. a fake protocol server). */
  socketPath?: string
  onStatusChange?: (s: TerminalStatus) => void
  /** Shown as "Reservar" in the read-only callout. */
  onReserve?: () => void
  /** Extra action for a port problem overlay, e.g. "Retomar puerto" when released. */
  renderStatusAction?: (runtime: ConsoleRuntimeDTO) => React.ReactNode
  className?: string
  ref?: React.Ref<TerminalHandle>
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const [fontSize] = usePreference("rm-term-font")
  const [scrollback] = usePreference("rm-term-scrollback")
  const [sr] = usePreference("rm-term-sr")
  const reducedMotion = useReducedMotion()
  const kit = useXterm(hostRef, { renderer, fontSize, scrollback, cursorBlink: !reducedMotion, screenReaderMode: sr, withSearch: true })
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [callout, setCallout] = React.useState<Callout>(null)
  const [paste, setPaste] = React.useState<string | null>(null)
  const outbox = React.useRef<{ timer: ReturnType<typeof setTimeout> | null; pending: Uint8Array[] }>({ timer: null, pending: [] })

  // Effect 2: the socket, opened once xterm exists so no byte is lost.
  const socket = useConsoleSocket(kit ? (socketPath ?? `/ws/console/${encodeURIComponent(consoleId)}`) : null, {
    onReset: () => kit?.term.reset(),
    onData: (bytes) => kit?.term.write(bytes),
    onCleared: (byName) => {
      kit?.term.clear()
      setCallout({ kind: "info", text: t.cleared(byName) })
    },
    onGap: (n) => setCallout({ kind: "info", text: t.gap(formatBytes(n)) }),
    onInputRejected: (reason) => setCallout(reason === "not-holder" ? { kind: "reserve", text: t.reserveToWrite } : { kind: "info", text: t.inputRejected[reason] }),
    onServerError: (_code, message) => setCallout({ kind: "info", text: message }),
  })

  React.useEffect(() => {
    if (!callout) return
    const id = setTimeout(() => setCallout(null), CALLOUT_MS)
    return () => clearTimeout(id)
  }, [callout])

  const readOnlyHint = React.useCallback(() => setCallout({ kind: "reserve", text: t.reserveToWrite }), [])

  /**
   * Ordered, paced send: a write up to 4 KiB goes out at once; a larger paste leaves in 4 KiB frames ~70 ms apart.
   * While a paced paste is in flight every later write (keystrokes, another paste, "Teclas") queues behind it, so
   * the port gets the bytes in the order they were typed or pasted. A failed send (socket gone) drops the queue.
   */
  const { send } = socket
  const sendOrdered = React.useCallback((data: string | Uint8Array): boolean => {
    const bytes = typeof data === "string" ? utf8.encode(data) : data
    const q = outbox.current
    if (!q.timer && bytes.length <= PASTE_CHUNK_BYTES) return send(bytes)
    if (bytes.length) q.pending.push(bytes)
    if (q.timer) return true
    const pump = (): boolean => {
      q.timer = null
      const frame = takeFrame(q.pending, PASTE_CHUNK_BYTES)
      if (!frame) return true
      if (!send(frame)) {
        q.pending.length = 0
        return false
      }
      if (q.pending.length) q.timer = setTimeout(pump, PASTE_CHUNK_GAP_MS)
      return true
    }
    return pump()
  }, [send])

  const onInput = React.useEffectEvent((data: string, binary = false) => {
    if (socket.mode !== "rw") {
      readOnlyHint()
      return
    }
    // xterm's binary events (some mouse reports) carry one byte per char code: never UTF-8 encode them.
    if (!sendOrdered(binary ? Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff) : data)) return
    if (!binary && socket.hello?.kind === "console" && socket.hello.localEcho) kit?.term.write(data)
  })

  const copySelection = React.useCallback(async (): Promise<boolean> => {
    const sel = kit?.term.getSelection() ?? ""
    if (!sel) {
      toast.info(t.nothingSelected)
      return false
    }
    const ok = await copyText(sel)
    if (ok) toast.success(actions.copied)
    else toast.error(actions.copyFailed)
    return ok
  }, [kit])

  const onKey = React.useEffectEvent((e: KeyboardEvent): boolean => {
    if (e.type !== "keydown") return true
    // Never a keyboard trap (WCAG 2.1.2): Shift+Tab goes back to the pane toolbar. Tab stays for shell completion.
    if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return false
    // Workspace shortcuts: Ctrl+Alt+1..9 and Ctrl+Alt+Enter never reach the port.
    if (e.ctrlKey && e.altKey && (/^[1-9]$/.test(e.key) || e.key === "Enter")) return false
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault()
      void copySelection()
      return false
    }
    // Ctrl+V and Ctrl+Shift+V: let the browser fire `paste` (works without the Clipboard API).
    if (e.ctrlKey && e.key.toLowerCase() === "v") return false
    // Ctrl+C with a selection copies; without one it sends ETX (xterm's default).
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c" && kit?.term.hasSelection()) {
      e.preventDefault()
      void copySelection()
      kit.term.clearSelection()
      return false
    }
    return true
  })

  const onPaste = React.useEffectEvent((e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain") ?? ""
    if (!text) return
    if (socket.mode !== "rw") {
      e.preventDefault()
      e.stopPropagation()
      readOnlyHint()
      return
    }
    if (utf8.encode(text).length > PASTE_CONFIRM_BYTES) {
      e.preventDefault()
      e.stopPropagation()
      setPaste(text)
    }
  })

  // Wire the terminal once it exists (data, keys, paste guard, accessible name).
  React.useEffect(() => {
    if (!kit) return
    const term = kit.term
    const subData = term.onData((d) => onInput(d))
    const subBin = term.onBinary((d) => onInput(d, true))
    term.attachCustomKeyEventHandler((e) => onKey(e))
    term.textarea?.setAttribute("aria-label", t.paneLabel(keyName, label))
    const host = hostRef.current
    const paster = (e: ClipboardEvent) => onPaste(e)
    host?.addEventListener("paste", paster, true)
    const queue = outbox.current
    return () => {
      subData.dispose()
      subBin.dispose()
      host?.removeEventListener("paste", paster, true)
      if (queue.timer) clearTimeout(queue.timer)
      queue.timer = null
      queue.pending.length = 0
    }
  }, [kit, keyName, label])

  const status = React.useMemo<TerminalStatus>(() => ({
    state: socket.state, mode: socket.mode, runtime: socket.runtime, viewers: socket.viewers, hello: socket.hello, renderer: kit?.renderer ?? null,
  }), [socket.state, socket.mode, socket.runtime, socket.viewers, socket.hello, kit])
  React.useEffect(() => {
    onStatusChange?.(status)
  }, [status, onStatusChange])

  React.useImperativeHandle(ref, () => ({
    focus: () => kit?.term.focus(),
    copySelection,
    hasSelection: () => !!kit?.term.hasSelection(),
    openSearch: () => setSearchOpen(true),
    sendKeys: (bytes) => {
      if (socket.mode !== "rw") {
        readOnlyHint()
        return false
      }
      const ok = sendOrdered(bytes)
      kit?.term.focus()
      return ok
    },
    sendBreak: (ms) => {
      if (socket.mode !== "rw") {
        readOnlyHint()
        return false
      }
      const ok = socket.sendBreak(ms)
      if (ok) toast.info(t.breakSent)
      return ok
    },
    retry: socket.retry,
    bufferText: () => {
      const buf = kit?.term.buffer.active
      if (!buf) return ""
      const lines: string[] = []
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "")
      return lines.join("\n")
    },
    dimensions: () => (kit ? { cols: kit.term.cols, rows: kit.term.rows } : null),
  }), [kit, copySelection, readOnlyHint, socket, sendOrdered])

  const s = socket.state
  const runtime = socket.runtime
  const portProblem = runtime && isPortProblem(runtime.status) ? consoleStatusView(runtime) : null
  let socketNotice: { title: string; detail?: string; retry: boolean } | null = null
  if (s.kind === "closed") {
    if (s.action === "too-many") socketNotice = { title: t.tooMany, retry: true }
    else if (s.action === "not-found") socketNotice = { title: t.notFound, detail: t.notFoundHint, retry: false }
    else if (s.action === "protocol-error") socketNotice = { title: t.protocolError, retry: true }
    else if (s.action === "none") socketNotice = { title: t.closed, retry: true }
  }
  const connecting = (s.kind === "connecting" && s.attempt > 0) || (s.kind === "closed" && s.retryInMs !== null)

  return (
    <div
      role="group"
      aria-label={t.paneLabel(keyName, label)}
      className={cn("rm-term relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", className)}
      style={{ backgroundColor: "var(--xterm-bg)" }}
    >
      <div
        ref={hostRef}
        className={cn("min-h-0 min-w-0 flex-1 py-1 pl-2 transition-opacity duration-150 ease-(--ease-out)", (portProblem || socketNotice) && "opacity-70")}
      />
      {searchOpen && kit?.search ? (
        <TerminalSearchBar
          search={kit.search}
          onClose={() => {
            setSearchOpen(false)
            kit.term.focus()
          }}
        />
      ) : null}
      {callout ? (
        <div role="status" className="absolute inset-x-2 top-2 z-10 flex justify-center">
          <InlineAlert
            tone={callout.kind === "reserve" ? "warn" : "info"}
            className="bg-popover shadow-overlay"
            actions={callout.kind === "reserve" && onReserve ? <Button size="sm" variant="primary" onClick={onReserve}>{t.reserve}</Button> : null}
          >
            {callout.text}
          </InlineAlert>
        </div>
      ) : null}
      {connecting && !socketNotice ? (
        <div className="pointer-events-none absolute right-2 bottom-2 z-10 rounded-sm bg-popover/90 px-2 py-1 text-meta text-muted-foreground tabular-nums">
          {s.kind === "connecting" && s.attempt > 0 ? t.connectingAttempt(s.attempt + 1) : t.connecting}
        </div>
      ) : null}
      {socketNotice || portProblem ? (
        <div className="absolute inset-0 z-[5] grid place-items-center p-4">
          {socketNotice ? (
            <InlineAlert
              tone={socketNotice.retry ? "warn" : "danger"}
              title={socketNotice.title}
              className="max-w-md bg-popover shadow-overlay"
              actions={socketNotice.retry ? <Button size="sm" onClick={socket.retry}>{t.retry}</Button> : null}
            >
              {socketNotice.detail}
            </InlineAlert>
          ) : portProblem && runtime ? (
            <InlineAlert
              tone={portProblem.tone === "danger" ? "danger" : "warn"}
              icon={portProblem.icon ?? undefined}
              title={portProblem.label}
              className="max-w-md bg-popover shadow-overlay"
              actions={renderStatusAction?.(runtime)}
            >
              {runtime.detail}
            </InlineAlert>
          ) : null}
        </div>
      ) : null}
      <AlertDialog open={paste !== null} onOpenChange={(o) => { if (!o) setPaste(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.pasteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.pasteBody(formatBytes(paste ? utf8.encode(paste).length : 0), keyName)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant="primary"
              onClick={() => {
                const text = paste
                setPaste(null)
                if (text && kit) {
                  kit.term.paste(text)
                  kit.term.focus()
                }
              }}
            >
              {t.paste}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
