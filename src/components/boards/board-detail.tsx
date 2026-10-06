"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { PauseIcon, PencilIcon, PlayIcon, PlugZapIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { InlineAlert } from "@/components/common/inline-alert"
import { Page, PageHeader } from "@/components/common/page"
import { RelativeTime } from "@/components/common/relative-time"
import { Spinner } from "@/components/common/spinner"
import { PageMeta } from "@/components/shell/page-meta"
import { Button } from "@/components/ui/button"
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { useAction } from "@/hooks/use-action"
import { useLiveState } from "@/hooks/use-live-state"
import { deleteBoard, refreshBoard, setBoardEnabled, testBoardConnection } from "@/actions/boards"
import type { ServerEventType } from "@/lib/contracts/events"
import type { BoardDetailDTO, DetectResultDTO } from "@/lib/contracts/relays"
import { boardForm as tf, boards as t, hardwarePages } from "@/lib/i18n/hardware"
import { common } from "@/lib/i18n/common"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { driverLabel } from "@/lib/i18n/status"
import { BoardStatusChip } from "./board-status-chip"
import { applyBoardDetailStatus, boardHttpAddress, boardTcpPort, boardUsage } from "./board-view"
import { DetectResults } from "./detect-results"
import { RelayMap } from "./relay-map"

const EVENTS: readonly ServerEventType[] = ["board.status"]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 py-2 first:pt-0 last:pb-0">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-body break-words text-foreground">{children}</dd>
    </div>
  )
}

const mono = "font-mono text-data tabular-nums"

/**
 * Placa de relés detail (§8.9): status and actions (Editar, Probar, Refrescar, Desactivar/Activar, Eliminar), the
 * read-only relay map, and the connection facts. Live through `board.status`.
 */
export function BoardDetail({ board: serverBoard }: { board: BoardDetailDTO }) {
  const router = useRouter()
  const board = useLiveState(serverBoard, EVENTS, applyBoardDetailStatus)
  const [test, setTest] = React.useState<DetectResultDTO[] | null>(null)
  const testButton = React.useRef<HTMLButtonElement>(null)
  const testAct = useAction(testBoardConnection)
  const refreshAct = useAction(refreshBoard, { successMessage: t.refreshed })
  const enableAct = useAction(setBoardEnabled)
  const deleteAct = useAction(deleteBoard)
  const usage = boardUsage(board)
  const tcp = boardTcpPort(board)
  const caps = board.runtime.capabilities

  const runTest = async () => {
    const r = await testAct.run({ driver: board.driver, host: board.host, httpPort: board.httpPort, tcpPort: board.tcpPort, username: board.username, password: null })
    if (r.ok) setTest(r.data)
  }
  const closeTest = () => {
    setTest(null)
    testButton.current?.focus() // the close button goes away with the panel
  }
  const toggleEnabled = async () => {
    const enabled = !board.enabled
    const r = await enableAct.run({ boardId: board.id, enabled })
    if (r.ok) toast.success(enabled ? t.enabledDone(board.name) : t.disabledDone(board.name))
  }

  const capabilityText = [
    caps.absoluteSet ? t.capAbsolute : t.capToggle,
    caps.pulse === "native" && caps.pulseMs ? t.capPulseNative(caps.pulseMs.min, Math.min(caps.pulseMs.max, 60000)) : caps.pulse === "emulated" ? t.capPulseEmulated : t.capPulseNone,
  ]

  return (
    <Page>
      <PageMeta breadcrumbs={[{ label: hardwarePages.boards, href: "/placas" }, { label: board.name }]} />
      <PageHeader
        title={board.name}
        actions={(
          <>
            <Button asChild variant="default"><AppLink href={`/placas/${board.id}/editar`}><PencilIcon aria-hidden />{t.edit}</AppLink></Button>
            <Button ref={testButton} variant="default" pending={testAct.pending} onClick={() => void runTest()}>
              <PlugZapIcon aria-hidden />{testAct.pending ? t.testing : t.test}
            </Button>
            <Button variant="default" disabled={!board.enabled} pending={refreshAct.pending} onClick={() => void refreshAct.run({ boardId: board.id })}>
              <RefreshCwIcon aria-hidden className={refreshAct.pending ? "animate-spin motion-reduce:animate-none" : undefined} />
              {refreshAct.pending ? t.refreshing : t.refresh}
            </Button>
            <Button variant="default" pending={enableAct.pending} onClick={() => void toggleEnabled()}>
              {board.enabled ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
              {board.enabled ? t.disable : t.enable}
            </Button>
            <ConfirmDialog
              trigger={<Button variant="danger-outline"><Trash2Icon aria-hidden />{t.delete}</Button>}
              title={t.deleteTitle(board.name)}
              description={t.deleteBody(usage.relays, usage.equipment)}
              typeToConfirm={board.name}
              confirmLabel={t.deleteConfirm}
              onConfirm={async () => {
                const r = await deleteAct.run({ boardId: board.id, confirmName: board.name })
                if (!r.ok) return false
                toast.success(t.deleted(board.name, r.data.detachedChannels))
                router.push("/placas")
                return true
              }}
            />
          </>
        )}
      >
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-muted-foreground">
          <BoardStatusChip board={board} />
          <span className="text-meta">{driverLabel(board.driver)}</span>
          {board.model ? (<><span aria-hidden className="text-faint-foreground">·</span><span className="font-mono text-data">{board.model}</span></>) : null}
          <span aria-hidden className="text-faint-foreground">·</span>
          <span className="font-mono text-data tabular-nums">{boardHttpAddress(board)}</span>
          {tcp ? (<><span aria-hidden className="text-faint-foreground">·</span><span className="font-mono text-data tabular-nums">{t.tcp(tcp)}</span></>) : null}
        </div>
      </PageHeader>

      {!board.enabled ? <InlineAlert tone="info">{t.disabledNotice}</InlineAlert> : null}
      {board.enabled && board.runtime.lastError && board.runtime.online === false ? (
        <InlineAlert tone="danger" title={RELAY_TEXT.boardNoAnswer(board.host)}>{board.runtime.lastError}</InlineAlert>
      ) : null}

      {testAct.pending || test ? (
        <Panel aria-live="polite">
          <PanelHeader>
            <PanelTitle>{tf.testTitle}</PanelTitle>
            {test ? (
              <Button variant="ghost" size="icon-sm" aria-label={common.close} title={common.close} onClick={closeTest}><XIcon aria-hidden /></Button>
            ) : null}
          </PanelHeader>
          <PanelBody>
            {testAct.pending ? <Spinner label={tf.testRunning} showLabel /> : test && test.length ? (
              <DetectResults results={test} className="md:grid md:grid-cols-2 md:gap-3 md:[&>li]:m-0" />
            ) : (
              <InlineAlert tone="warn" title={tf.testNone}>{tf.testNoneHint}</InlineAlert>
            )}
          </PanelBody>
        </Panel>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <Panel>
          <PanelHeader className="flex-col items-start gap-0.5 py-3">
            <PanelTitle>{t.mapTitle}</PanelTitle>
            <PanelDescription>{t.mapDescription}</PanelDescription>
          </PanelHeader>
          <PanelBody>
            <RelayMap board={board} />
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader><PanelTitle>{t.connectionTitle}</PanelTitle></PanelHeader>
          <PanelBody>
            <dl className="flex flex-col divide-y">
              <Row label={t.fDriver}>{driverLabel(board.driver)}</Row>
              <Row label={t.fAddress}><span className={mono}>{boardHttpAddress(board)}</span></Row>
              {tcp ? <Row label={t.fTcpPort}><span className={mono}>{board.tcpPort === null ? t.fTcpDefault(tcp) : tcp}</span></Row> : null}
              <Row label={t.fModel}>{board.model ? <span className={mono}>{board.model}</span> : <span className="text-faint-foreground">{t.notSet}</span>}</Row>
              {board.moduleId !== null ? <Row label={t.fModuleId}><span className={mono}>{board.moduleId}</span></Row> : null}
              <Row label={t.fMac}>{board.mac ? <span className={mono}>{board.mac}</span> : <span className="text-faint-foreground">{t.notSet}</span>}</Row>
              <Row label={t.fRelays}><span className="tabular-nums">{t.relaysUsedLabel(usage.relays, board.relayCount)}</span></Row>
              <Row label={t.fEquipment}><span className="tabular-nums">{usage.equipment || t.none}</span></Row>
              {board.driver === "devantech-ds-http" ? <Row label={t.fToggleVar}>{board.options.toggleVar ? <span className={mono}>{board.options.toggleVar}</span> : <span className="text-faint-foreground">{t.notSet}</span>}</Row> : null}
              {board.driver === "devantech-ds-ascii" ? <Row label={t.fHttpFallback}>{board.options.useHttpFallback ? t.yes : t.no}</Row> : null}
              {board.driver === "devantech-eth" ? (
                <>
                  <Row label={t.fTransport}>{board.options.transport === "http" ? t.transportHttp : t.transportTcp}</Row>
                  <Row label={t.fUser}>{board.username ? <span className={mono}>{board.username}</span> : <span className="text-faint-foreground">{t.notSet}</span>}</Row>
                  <Row label={t.fPassword}>{board.hasPassword ? t.passwordSaved : <span className="text-faint-foreground">{t.passwordNone}</span>}</Row>
                </>
              ) : null}
              <Row label={t.fCapabilities}>
                <ul className="flex flex-col">{capabilityText.map((c) => <li key={c}>{c}</li>)}</ul>
              </Row>
              <Row label={t.fLastRead}>
                {board.runtime.lastSeenAt ? <RelativeTime value={board.runtime.lastSeenAt} /> : <span className="text-faint-foreground">{t.never}</span>}
              </Row>
              {board.runtime.lastError ? <Row label={t.fLastError}><span className="text-danger">{board.runtime.lastError}</span></Row> : null}
            </dl>
          </PanelBody>
        </Panel>
      </div>

    </Page>
  )
}
