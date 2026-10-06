"use client"

import { equipnetUi, LINK_LABEL } from "@/lib/i18n/equipnet"
import * as React from "react"
import { InfoIcon, NetworkIcon, SettingsIcon, UsersIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { CopyButton } from "@/components/common/copy-button"
import { EmptyState } from "@/components/common/empty-state"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { useEquipment } from "@/components/workspace/equipment-context"
import { useLiveState } from "@/hooks/use-live-state"
import { useMounted } from "@/hooks/use-mounted"
import type { AccessDTO } from "@/lib/contracts/accesses"
import type { ServerEventType } from "@/lib/contracts/events"
import { accessAddress, accessCommands, type AccessCommand } from "@/lib/accesses/commands"
import { ACCESS_KIND_LABEL, ACCESS_POLICY_HELP, ACCESS_POLICY_LABEL, accessUi as t, accessesText, sessionText } from "@/lib/i18n/accesses"
import { reservation as rt } from "@/lib/i18n/banco"
import { formatBytes } from "@/lib/i18n/format"
import { cn } from "@/lib/client/cn"
import { AccessKindIcon, AccessStatusChip, CableName } from "./access-bits"
import { reduceAccesses, remoteSessions, waitingForReservation } from "./access-model"

const ACCESS_EVENTS: readonly ServerEventType[] = ["access.status"]

/**
 * Equipo › Accesos: one card per access with the address the engineer uses from their PC (the host the browser
 * used + the access port), its state, who is connected and the command to copy (xsdb/Vivado, nc/telnet, ssh).
 */
export function AccessesPanel({ equipmentId, accesses: initial }: { equipmentId: string; accesses: AccessDTO[] }) {
  const { reservation, actions, viewer } = useEquipment()
  const accesses = useLiveState(initial, ACCESS_EVENTS, (s, e) => reduceAccesses(s, e, equipmentId))
  const mounted = useMounted()
  const host = mounted ? window.location.hostname : "…"

  if (!accesses.length) {
    return (
      <div className="p-4 md:p-6">
        <EmptyState
          icon={NetworkIcon}
          className="max-w-3xl"
          title={t.none}
          actions={viewer.isAdmin ? (
            <Button asChild variant="primary"><AppLink href={`/equipos/${equipmentId}/ajustes#accesos`}><SettingsIcon aria-hidden />{t.configure}</AppLink></Button>
          ) : null}
        >
          {viewer.isAdmin ? t.noneAdmin : null}
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-section text-foreground">{t.panelTitle}</h2>
          <p className="max-w-[80ch] text-meta text-muted-foreground">{t.panelIntro}</p>
        </div>
        {viewer.isAdmin ? <Button asChild size="sm" variant="ghost"><AppLink href={`/equipos/${equipmentId}/ajustes#accesos`}><SettingsIcon aria-hidden />{t.configure}</AppLink></Button> : null}
      </div>
      {waitingForReservation(accesses) && !reservation ? (
        <InlineAlert
          tone="info"
          icon={InfoIcon}
          className="py-1.5"
          actions={<Button size="sm" variant="outline" onClick={() => void actions.reserve(null)} disabled={actions.pending.reserve}>{rt.reserve}</Button>}
        >
          {t.notReservedBanner}
        </InlineAlert>
      ) : null}
      <ul aria-label={t.panelTitle} className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {accesses.map((a) => <AccessCard key={a.id} access={a} host={host} />)}
      </ul>
    </div>
  )
}

function AccessCard({ access: a, host }: { access: AccessDTO; host: string }) {
  const r = a.runtime
  const cmds = accessCommands(a, host)
  const addr = accessAddress(host, a.port)
  const conns = r.connections
  const sessions = remoteSessions([a])
  return (
    <li className={cn("flex min-w-0 flex-col rounded-lg border bg-card", r.status === "listening" && "border-ok/40")} aria-label={`${a.label} · ${ACCESS_KIND_LABEL[a.kind]}`}>
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
        <AccessKindIcon kind={a.kind} />
        <span className="truncate text-body font-medium text-foreground">{a.label}</span>
        <span className="font-mono text-data text-faint-foreground">{a.key}</span>
        <AccessStatusChip runtime={r} className="ml-auto" />
      </div>
      <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-20 shrink-0 text-meta text-muted-foreground">{t.address}</span>
          <code className="min-w-0 truncate font-mono text-data text-foreground">{addr}</code>
          <CopyButton value={addr} label={t.copyCommand(addr)} />
        </div>
        <Details access={a} />
        {r.detail && r.reason !== "not-reserved" ? <p className="text-meta text-muted-foreground">{r.detail}</p> : null}
        <ul className="flex flex-col gap-1">
          {cmds.map((c) => <CommandLine key={c.id} cmd={c} />)}
        </ul>
        {a.kind === "jtag" ? <p className="text-micro text-muted-foreground">{t.vivadoHint}</p> : null}
        {a.kind === "serial" ? <p className="text-micro text-muted-foreground">{t.serialHint}</p> : null}
      </div>
      <div className="mt-auto flex min-w-0 items-center gap-2 border-t px-3 py-1.5 text-meta text-muted-foreground">
        <UsersIcon aria-hidden className="size-3.5 shrink-0" />
        {conns.length ? (
          <SimpleTooltip label={<span className="flex flex-col">{conns.map((c) => (
            <span key={c.id}>{t.connectedFrom(c.remote)}{c.rxBytes !== null && c.txBytes !== null ? ` · ${formatBytes(c.rxBytes)} / ${formatBytes(c.txBytes)}` : ""}</span>
          ))}</span>}>
            <span tabIndex={0} className="truncate rounded-sm text-foreground">
              {sessionText.inUse(sessions[0]?.tool ?? "", [...new Set(sessions.map((x) => x.host))].join(", "))}
              {conns.length > 1 ? ` · ${accessesText.connections(conns.length)}` : ""}
            </span>
          </SimpleTooltip>
        ) : <span>{t.noClients}</span>}
        <span className="ml-auto shrink-0" title={ACCESS_POLICY_HELP[a.policy]}>{ACCESS_POLICY_LABEL[a.policy]}</span>
      </div>
    </li>
  )
}

function Details({ access: a }: { access: AccessDTO }) {
  const r = a.runtime
  if (a.kind === "jtag") {
    return (
      <div className="flex min-w-0 items-center gap-2 text-body">
        <span className="w-20 shrink-0 text-meta text-muted-foreground">{t.cable}</span>
        {a.cableSerial ? <CableName name={a.cableName} serial={a.cableSerial} /> : <span className="text-muted-foreground">{t.noCable}</span>}
      </div>
    )
  }
  if (a.kind === "serial") {
    return (
      <div className="flex min-w-0 items-center gap-2 text-body">
        <span className="w-20 shrink-0 text-meta text-muted-foreground">{t.console}</span>
        <span className="font-mono text-data">{a.consoleKey ?? "-"}</span>
        {r.status === "listening" ? <span className="text-meta text-muted-foreground">· {r.writable ? t.writable : t.readOnly}</span> : null}
      </div>
    )
  }
  if (a.targetMode === "switch") {
    const n = r.network
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body" data-testid="access-network">
        <span className="w-20 shrink-0 text-meta text-muted-foreground">{t.target}</span>
        {a.switchPort === null ? <span className="text-muted-foreground">{equipnetUi.choosePort}</span> : (
          <>
            <span>{equipnetUi.viaSwitch(a.switchPort)}</span>
            <span className="text-meta text-muted-foreground">· {LINK_LABEL[n?.link ?? "unknown"].toLowerCase()}</span>
            {n?.target ? <span className="font-mono text-data">· {n.target}</span> : null}
            {r.targetReachable !== null && n?.target ? <span className="text-meta text-muted-foreground">{r.targetReachable ? t.reachable.toLowerCase() : t.unreachable.toLowerCase()}</span> : null}
          </>
        )}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-2 text-body">
      <span className="w-20 shrink-0 text-meta text-muted-foreground">{t.target}</span>
      {a.targetHost && a.targetPort ? <span className="font-mono text-data">{accessAddress(a.targetHost, a.targetPort)}</span> : <span className="text-muted-foreground">{t.targetUnknown}</span>}
      {r.targetReachable !== null ? <span className="text-meta text-muted-foreground">· {r.targetReachable ? t.reachable : t.unreachable}</span> : null}
    </div>
  )
}

function CommandLine({ cmd }: { cmd: AccessCommand }) {
  const label = t.commandLabel[cmd.id]
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md bg-secondary/60 py-0.5 pr-0.5 pl-2">
      <span className="w-20 shrink-0 truncate text-micro text-muted-foreground" title={label}>{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-data text-foreground">{cmd.command}</code>
      <CopyButton value={cmd.command} label={t.copyCommand(cmd.command)} />
    </li>
  )
}

/** Compact "Accesos 2/5" link for the workspace status bar. */
export function AccessesStatusLink({ equipmentId, accesses: initial }: { equipmentId: string; accesses: AccessDTO[] }) {
  const accesses = useLiveState(initial, ACCESS_EVENTS, (s, e) => reduceAccesses(s, e, equipmentId))
  if (!accesses.length) return null
  const open = accesses.filter((a) => a.runtime.status === "listening").length
  return (
    <AppLink href={`/equipos/${equipmentId}/accesos`} aria-label={t.statusBarLabel} className="inline-flex shrink-0 items-center gap-1.5 rounded-sm hover:text-foreground">
      <NetworkIcon aria-hidden className={cn("size-3.5", open ? "text-ok" : "text-faint-foreground")} />
      <span className="tabular-nums">{t.statusBarChip(open, accesses.length)}</span>
    </AppLink>
  )
}

