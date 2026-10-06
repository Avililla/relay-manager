"use client"

import * as React from "react"
import { ChevronRightIcon, DownloadIcon, NetworkIcon, RefreshCwIcon, SearchIcon, Trash2Icon, Undo2Icon, Unlink2Icon, WrenchIcon } from "lucide-react"
import { toast } from "sonner"
import {
  applySwitch, chooseEquipnetAdapter, cleanupEquipnetLeftovers, discoverSwitch, previewSwitch, reconcileEquipnet, saveEquipnetSettings, testSwitch,
} from "@/actions/equipnet"
import { CopyButton } from "@/components/common/copy-button"
import { FormErrors, FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { Section } from "@/components/common/page"
import { StatusChip } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useAction } from "@/hooks/use-action"
import { useLiveState } from "@/hooks/use-live-state"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import {
  SWITCH_DRIVERS, type EquipnetSettingsDTO, type EquipnetSettingsInput, type EquipnetStatusDTO, type ManualInstructionsDTO,
  type NetAdapterDTO, type SwitchDriverId, type SwitchJobDTO, type SwitchJobKind, type SwitchPreviewDTO,
} from "@/lib/contracts/equipnet"
import type { ServerEventType } from "@/lib/contracts/events"
import { isIPv4 } from "@/lib/equipnet/ipv4"
import { portList } from "@/lib/equipnet/switch-layout"
import {
  HOST_STATE_LABEL, JOB_KIND_LABEL, LINK_LABEL, SWITCH_DRIVER_LABEL, SWITCH_STATE_LABEL, equipnetUi as t,
} from "@/lib/i18n/equipnet"
import { formatDateTime } from "@/lib/i18n/format"
import { cn } from "@/lib/client/cn"
import { adapterTypeText, currentStep, HOST_TONE, LINK_TONE, reduceEquipnet, SWITCH_TONE } from "./equipnet-model"
import { PrepareSwitchDialog } from "./prepare-switch-dialog"
import { SwitchJobProgress, SwitchPreviewDetails } from "./switch-preview"

const EVENTS: readonly ServerEventType[] = ["equipnet.changed"]

/**
 * Sistema › Red de equipos (admins), as steps: (1) choose the interface wired to the switch (every interface listed;
 * nothing is touched before this), (2) find the switch through that interface only (or type its IP), (3) prepare the
 * switch (preview, explicit click), (4) state: server side, switch, ports and the switch actions. Then the settings,
 * the manual instructions, and the leftovers of older versions (removed only on request).
 */
export function EquipnetView({ status: initial, manual }: { status: EquipnetStatusDTO; manual: ManualInstructionsDTO }) {
  const status = useLiveState(initial, EVENTS, reduceEquipnet)
  const [dialog, setDialog] = React.useState<SwitchJobKind | null>(null)
  const step = currentStep(status)
  return (
    <div className="flex flex-col gap-6" data-testid="equipnet-view">
      <p className="max-w-[90ch] text-meta text-muted-foreground">{t.intro}</p>
      <LeftoversPanel status={status} />
      {status.warnings.length ? (
        <InlineAlert tone="warn" title={t.warningsTitle}>
          <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="equipnet-warnings">{status.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </InlineAlert>
      ) : null}
      <InterfaceStep status={status} done={step > 1} />
      <SwitchStep status={status} done={step > 2} active={step >= 2} />
      <PrepareStep status={status} done={step > 3} active={step >= 3} />
      <Section title={t.step4Title} id="estado">
        <div className="grid gap-4 xl:grid-cols-2">
          <HostPanel status={status} />
          <SwitchPanel status={status} />
        </div>
        <PortsSection status={status} />
        <div className="flex flex-col gap-2" id="configurar">
          <p className="text-meta text-muted-foreground">{t.actionsHelp}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => setDialog("apply")} disabled={status.settings.driver !== "tplink-easy-smart" || !status.settings.switchHost || !status.settings.adapterMac}>
              <WrenchIcon aria-hidden />{t.applyAction}
            </Button>
            <Button onClick={() => setDialog("restore")} disabled={!status.previousAt || status.settings.driver !== "tplink-easy-smart"}><Undo2Icon aria-hidden />{t.restoreAction}</Button>
            <Button variant="danger-outline" onClick={() => setDialog("remove")} disabled={status.settings.driver !== "tplink-easy-smart" || !status.settings.switchHost || !status.settings.adapterMac}><Unlink2Icon aria-hidden />{t.removeAction}</Button>
            {status.hasBackup ? <Button variant="ghost" asChild><a href="/api/equipnet/switch-backup" download><DownloadIcon aria-hidden />{t.downloadBackup}</a></Button> : null}
          </div>
          <div className="flex flex-col gap-0.5 text-meta text-muted-foreground">
            {status.appliedAt ? <span>{t.appliedAt(formatDateTime(status.appliedAt))}</span> : null}
            {status.previousAt ? <span>{t.previousAt(formatDateTime(status.previousAt))}</span> : null}
          </div>
          {status.job && !dialog ? <SwitchJobProgress job={status.job} /> : null}
        </div>
      </Section>
      <SettingsForm status={status} />
      <ManualSection manual={manual} open={status.settings.driver === "manual"} />
      {dialog ? <SwitchActionDialog kind={dialog} job={status.job} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}

function StepTitle({ title, done }: { title: string; done: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {title}
      <StatusChip tone={done ? "ok" : "neutral"} quiet>{done ? t.stepDone : t.stepPending}</StatusChip>
    </span>
  )
}

/** Leftovers of older versions (a management address on another interface…): listed, removed only on request. */
function LeftoversPanel({ status }: { status: EquipnetStatusDTO }) {
  const clean = useAction(cleanupEquipnetLeftovers, { successMessage: t.leftoversDone })
  const l = status.leftovers
  if (!l.items.length) return null
  const script = l.commands.map((c) => `sudo ${c}`).join("\n")
  return (
    <InlineAlert tone="warn" title={t.leftoversTitle}
      actions={<Button size="sm" variant="danger-outline" onClick={() => void clean.run({})} pending={clean.pending}><Trash2Icon aria-hidden />{t.leftoversAction}</Button>}>
      <div className="flex flex-col gap-2" data-testid="equipnet-leftovers">
        <ul className="list-disc pl-4">{l.items.map((x) => <li key={x} className="font-mono text-data">{x}</li>)}</ul>
        <p className="text-meta text-muted-foreground">{t.leftoversHelp}</p>
        {script ? (
          <div className="flex items-start gap-2">
            <pre className="max-h-40 flex-1 overflow-auto rounded-md bg-muted p-2 font-mono text-data text-foreground">{script}</pre>
            <CopyButton value={script} label={t.leftoversTitle} />
          </div>
        ) : null}
      </div>
    </InlineAlert>
  )
}

/** Step 1: every network interface; «Usar esta» (with what will happen, and an extra confirmation when risky). */
function InterfaceStep({ status, done }: { status: EquipnetStatusDTO; done: boolean }) {
  const [choose, setChoose] = React.useState<NetAdapterDTO | null>(null)
  const [stop, setStop] = React.useState<NetAdapterDTO | null>(null)
  const [others, setOthers] = React.useState(false)
  const list = status.adapters
  const chosenMissing = status.settings.adapterMac && !list.some((a) => a.chosen)
  return (
    <Section title={<StepTitle title={t.step1Title} done={done} />} description={t.step1Help} id="interfaz">
      {chosenMissing ? <InlineAlert tone="danger">{status.host.detail}</InlineAlert> : null}
      {!list.length ? <p className="text-body text-muted-foreground">{t.noInterfaces}</p> : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[60rem] text-body" data-testid="equipnet-interfaces">
            <caption className="sr-only">{t.step1Title}</caption>
            <thead className="bg-secondary text-left text-micro text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t.colIface}</th><th className="px-3 py-2 font-medium">{t.colMac}</th><th className="px-3 py-2 font-medium">{t.colType}</th>
                <th className="px-3 py-2 font-medium">{t.colLink}</th><th className="px-3 py-2 font-medium">{t.colAddresses}</th><th className="px-3 py-2 font-medium">{t.colDefault}</th>
                <th className="px-3 py-2 font-medium">{t.colNm}</th><th className="px-3 py-2 font-medium"><span className="sr-only">{t.colAction}</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.mac} className={cn("border-t align-top", a.chosen && "bg-brand-tint")} data-iface={a.ifname}>
                  <td className="px-3 py-2">
                    <span className="flex flex-col">
                      <span className="font-mono text-data font-medium text-foreground">{a.ifname}</span>
                      {a.labelName ? <span className="text-micro text-muted-foreground">{a.labelName}</span> : null}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-data text-muted-foreground">{a.mac}</td>
                  <td className="px-3 py-2 text-meta">{adapterTypeText(a)}</td>
                  <td className="px-3 py-2"><StatusChip tone={a.carrier ? "ok" : "neutral"} quiet>{t.adapterCarrier[String(a.carrier)]}{a.speedMbps ? ` · ${t.speed(a.speedMbps)}` : ""}</StatusChip></td>
                  <td className="px-3 py-2 font-mono text-data">{a.addresses.length ? a.addresses.join(", ") : <span className="text-muted-foreground">-</span>}</td>
                  <td className="px-3 py-2">{a.defaultRoute ? <StatusChip tone="warn" quiet>{t.yes}</StatusChip> : <span className="text-muted-foreground">{t.no}</span>}</td>
                  <td className="px-3 py-2 text-meta">{a.nmState ? t.nmState(a.nmState, a.nmConnection) : t.nmUnknown}</td>
                  <td className="px-3 py-2">
                    {a.chosen ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusChip tone="brand">{t.inUse}</StatusChip>
                        <Button size="sm" variant="ghost" onClick={() => setStop(a)}>{t.stopUsing}</Button>
                      </span>
                    ) : a.selectable === "no" ? (
                      <span className="text-meta text-muted-foreground" title={a.problem ?? undefined}>{t.notSelectable}: {a.problem}</span>
                    ) : (
                      <span className="flex flex-col items-start gap-1">
                        <Button size="sm" variant={a.selectable === "yes" ? "primary" : "default"} onClick={() => setChoose(a)} aria-label={`${t.useThis}: ${a.ifname}`}>{t.useThis}</Button>
                        {a.warning ? <span className="max-w-[28ch] text-micro text-warn">{a.warning}</span> : null}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {status.otherInterfaces.length ? (
        <Collapsible open={others} onOpenChange={setOthers}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2"><ChevronRightIcon aria-hidden className={cn("transition-transform duration-150 motion-reduce:transition-none", others && "rotate-90")} />{t.otherIfaces(status.otherInterfaces.length)}</Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <ul className="flex flex-col gap-1 font-mono text-data text-muted-foreground" data-testid="equipnet-other-interfaces">
              {status.otherInterfaces.map((o) => (
                <li key={o.ifname}>{o.ifname}{o.kind ? ` (${o.kind})` : ""}{o.addresses.length ? ` · ${o.addresses.join(", ")}` : ""}{o.defaultRoute ? ` · ${t.colDefault.toLowerCase()}` : ""}</li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {choose ? <ChooseDialog adapter={choose} status={status} onClose={() => setChoose(null)} /> : null}
      {stop ? <StopDialog adapter={stop} onClose={() => setStop(null)} /> : null}
    </Section>
  )
}

function ChooseDialog({ adapter: a, status, onClose }: { adapter: NetAdapterDTO; status: EquipnetStatusDTO; onClose: () => void }) {
  const choose = useAction(chooseEquipnetAdapter)
  const [risk, setRisk] = React.useState(false)
  const needsRisk = a.selectable === "confirm"
  const mgmt = status.settings.mgmtAddress
  const go = async () => {
    const r = await choose.run({ mac: a.mac, confirmed: needsRisk && risk })
    if (r.ok) onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl" data-testid="choose-interface-dialog">
        <DialogHeader>
          <DialogTitle>{t.chooseTitle(a.ifname)}</DialogTitle>
          <DialogDescription>{adapterTypeText(a)} · {a.mac}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {needsRisk && a.warning ? <InlineAlert tone="warn" title={t.chooseRiskTitle} role="alert">{a.warning}</InlineAlert> : null}
          <p className="text-body font-medium text-foreground">{t.chooseWill}</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-foreground">
            {status.settings.driver === "tplink-easy-smart" ? <li>{a.mgmtReuse ? t.chooseWillReuse(a.mgmtReuse) : t.chooseWillOwn(mgmt, a.ifname)}</li> : null}
            <li>{t.chooseWillVlans}</li>
            <li>{t.chooseWillNothingElse}</li>
          </ul>
          {needsRisk ? (
            <div className="flex items-start gap-2">
              <Checkbox id="choose-risk" checked={risk} onCheckedChange={(v) => setRisk(v === true)} className="mt-0.5" />
              <Label htmlFor="choose-risk" className="font-normal">{t.chooseConfirmRisk}</Label>
            </div>
          ) : null}
          <FormErrors errors={choose.fieldErrors} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t.close}</Button>
          <Button variant="primary" onClick={() => void go()} pending={choose.pending} disabled={needsRisk && !risk}>{t.chooseAction}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StopDialog({ adapter: a, onClose }: { adapter: NetAdapterDTO; onClose: () => void }) {
  const choose = useAction(chooseEquipnetAdapter)
  const go = async () => {
    const r = await choose.run({ mac: null, confirmed: false })
    if (r.ok) onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.stopTitle(a.ifname)}</DialogTitle>
          <DialogDescription>{t.stopBody}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t.close}</Button>
          <Button variant="danger" onClick={() => void go()} pending={choose.pending}>{t.stopAction}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Step 2: find the switch through the chosen interface only (sweep of its management network), or at a typed IP. */
function SwitchStep({ status, done, active }: { status: EquipnetStatusDTO; done: boolean; active: boolean }) {
  const find = useAction(discoverSwitch)
  const [ip, setIp] = React.useState("")
  const chosen = status.adapters.find((a) => a.chosen)
  const m = status.mgmt
  const run = async (host?: string) => {
    const r = await find.run(host ? { host } : {})
    if (!r.ok) return
    if (r.data) toast.success(t.found(r.data.host))
    else toast.error(t.notFound)
  }
  const d = status.detection
  const manual = status.settings.driver !== "tplink-easy-smart"
  return (
    <Section title={<StepTitle title={t.step2Title} done={done} />} description={chosen ? t.step2Help(chosen.ifname, m.subnet) : undefined} id="buscar"
      className={cn(!active && "opacity-60")}>
      {!active || !chosen ? <p className="text-meta text-muted-foreground">{status.settings.adapterMac ? status.host.detail : t.chooseFirst}</p> : manual ? (
        <p className="text-meta text-muted-foreground">{t.mgmtNone}</p>
      ) : (
        <div className="flex flex-col gap-3" data-testid="equipnet-find">
          {m.address && m.ifname ? (
            <p className="text-meta text-foreground">
              {m.mode === "reuse" ? t.mgmtReuse(m.address, m.ifname) : t.mgmtOwn(m.address, m.ifname)}
              {!m.ready ? <span className="text-muted-foreground">: {t.mgmtPending}</span> : null}
            </p>
          ) : null}
          {m.problem ? <InlineAlert tone="danger">{m.problem}</InlineAlert> : null}
          <div className="flex flex-wrap items-end gap-2">
            <Button variant={done ? "default" : "primary"} onClick={() => void run()} pending={find.pending && !ip} disabled={!m.ready}>
              <SearchIcon aria-hidden />{find.pending ? t.finding : t.find}
            </Button>
            <FormField label={t.typeIp} name="host" errors={find.fieldErrors} className="max-w-56">
              <Input value={ip} placeholder="192.168.0.1" className="font-mono text-data" onChange={(e) => setIp(e.target.value.trim())} />
            </FormField>
            <Button onClick={() => void run(ip)} disabled={!isIPv4(ip)} pending={find.pending && !!ip}>{t.testIp}</Button>
          </div>
          {d ? (
            <p className="text-body text-foreground" data-testid="equipnet-found">
              {t.foundLine(d.model, d.host)}
              {d.loginOk === true ? <span className="text-muted-foreground"> · {t.loginOk}</span> : d.loginOk === false ? <span className="text-warn"> · {t.loginBad}</span> : null}
            </p>
          ) : status.settings.switchHost ? <p className="text-body text-foreground">{t.switchKnown(status.settings.switchHost)}</p> : null}
        </div>
      )}
    </Section>
  )
}

/** Step 3: «Preparar el switch…» (the dialog with the plan, the password, «Detalles» and one explicit button). */
function PrepareStep({ status, done, active }: { status: EquipnetStatusDTO; done: boolean; active: boolean }) {
  const [open, setOpen] = React.useState(false)
  const running = status.job?.state === "running" && status.job.kind === "apply"
  const auto = status.settings.driver === "tplink-easy-smart"
  return (
    <Section title={<StepTitle title={t.step3Title} done={done} />} description={t.step3Help} id="preparar" className={cn(!active && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={done ? "default" : "primary"} onClick={() => setOpen(true)} disabled={!active || !auto || !status.settings.switchHost}>
          <WrenchIcon aria-hidden />{running ? t.preparing : t.prepareOpen}
        </Button>
        {status.appliedAt ? <span className="text-meta text-muted-foreground">{t.preparedAt(formatDateTime(status.appliedAt))}</span> : null}
      </div>
      {open ? <PrepareSwitchDialog status={status} open={open} onOpenChange={setOpen} /> : null}
    </Section>
  )
}

function HostPanel({ status }: { status: EquipnetStatusDTO }) {
  const h = status.host
  const check = useAction(reconcileEquipnet)
  const script = h.pending.map((c) => `sudo ${c}`).join("\n")
  return (
    <Panel aria-label={t.serverSide}>
      <PanelHeader>
        <PanelTitle as="h2">{t.serverSide}</PanelTitle>
        <StatusChip tone={HOST_TONE[h.state]}>{HOST_STATE_LABEL[h.state]}</StatusChip>
        <Button size="sm" variant="ghost" onClick={() => void check.run({})} pending={check.pending}><RefreshCwIcon aria-hidden />{t.checkNow}</Button>
      </PanelHeader>
      <PanelBody className="gap-3">
        {h.detail ? <p className="text-body text-foreground">{h.detail}</p> : null}
        {h.ifname ? <p className="font-mono text-data text-muted-foreground">{h.ifname}</p> : null}
        {h.pending.length ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <p className="text-meta font-medium text-foreground">{t.pendingTitle}</p>
              <CopyButton value={script} label={t.pendingTitle} />
            </div>
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-data text-foreground">{script}</pre>
            <p className="text-meta text-muted-foreground">{t.pendingHelp}</p>
          </div>
        ) : null}
        {h.networkManagerHint ? <InlineAlert tone="warn" title={t.nmTitle}>{h.networkManagerHint}</InlineAlert> : null}
      </PanelBody>
    </Panel>
  )
}

function SwitchPanel({ status }: { status: EquipnetStatusDTO }) {
  const s = status.switch
  const test = useAction(testSwitch)
  return (
    <Panel aria-label={t.switchSide}>
      <PanelHeader>
        <PanelTitle as="h2">{t.switchSide}</PanelTitle>
        <StatusChip tone={SWITCH_TONE[s.state]}>{SWITCH_STATE_LABEL[s.state]}</StatusChip>
        {status.settings.driver === "tplink-easy-smart" && status.settings.switchHost ? (
          <Button size="sm" variant="ghost" onClick={() => void test.run({})} pending={test.pending}><RefreshCwIcon aria-hidden />{t.test}</Button>
        ) : null}
      </PanelHeader>
      <PanelBody className="gap-2">
        {s.info.model ? (
          <p className="text-body text-foreground">
            {s.info.hardware ?? s.info.model} · <span className="font-mono text-data">{status.settings.switchHost}</span>
            {s.info.firmware ? <span className="text-muted-foreground"> · firmware {s.info.firmware}</span> : null}
          </p>
        ) : null}
        {s.detail ? <p className="text-body text-muted-foreground">{s.detail}</p> : null}
        {s.matches === false ? (
          <InlineAlert tone="warn" title={t.drift}><ul className="list-disc pl-4">{s.drift.map((x) => <li key={x}>{x}</li>)}</ul></InlineAlert>
        ) : null}
      </PanelBody>
    </Panel>
  )
}

function PortsSection({ status }: { status: EquipnetStatusDTO }) {
  const ports = status.ports
  return (
    <Section title={t.portsTitle}>
      {!ports.length ? <p className="text-meta text-muted-foreground">{t.portsEmpty}</p> : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[46rem] text-body" data-testid="switch-ports">
            <thead className="bg-secondary text-left text-micro text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t.port}</th><th className="px-3 py-2 font-medium">{t.role}</th><th className="px-3 py-2 font-medium">{t.vlan}</th>
                <th className="px-3 py-2 font-medium">{t.link}</th><th className="px-3 py-2 font-medium">{t.usedBy}</th><th className="px-3 py-2 font-medium">{t.hostAddress}</th>
                <th className="px-3 py-2 font-medium">{t.hostReady}</th>
              </tr>
            </thead>
            <tbody>
              {ports.map((p) => (
                <tr key={p.port} className="h-9 border-t" data-port={p.port}>
                  <td className="px-3 font-mono tabular-nums">{p.port}</td>
                  <td className="px-3">{p.role === "uplink" ? t.roleUplink : t.roleEquipment}</td>
                  <td className="px-3 font-mono tabular-nums">{p.vid ?? (p.role === "uplink" ? "1" : "-")}</td>
                  <td className="px-3"><StatusChip tone={LINK_TONE[p.link]} quiet>{LINK_LABEL[p.link]}{p.speed ? ` · ${p.speed}` : ""}</StatusChip></td>
                  <td className="px-3">{p.usedBy.length ? p.usedBy.map((u) => `${u.equipmentName} · ${u.key}`).join(", ") : <span className="text-muted-foreground">{p.role === "uplink" ? "" : t.free}</span>}</td>
                  <td className="px-3 font-mono text-data">{p.hostAddress ? `${p.hostAddress} (${p.ifname})` : ""}</td>
                  <td className="px-3">{p.role === "uplink" ? "" : <StatusChip tone={p.hostReady ? "ok" : "neutral"} quiet>{p.hostReady ? t.ready : t.notReady}</StatusChip>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

/** Preview → «He revisado los cambios» → apply → progress. */
function SwitchActionDialog({ kind, job, onClose }: { kind: SwitchJobKind; job: SwitchJobDTO | null; onClose: () => void }) {
  const preview = useAction(previewSwitch)
  const apply = useAction(applySwitch)
  const [p, setP] = React.useState<SwitchPreviewDTO | null>(null)
  const [reviewed, setReviewed] = React.useState(false)
  const [uplinkOk, setUplinkOk] = React.useState(false)
  const [startedId, setStartedId] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)
  const run = preview.run
  React.useEffect(() => {
    void run({ kind }).then((r) => {
      if (r.ok) setP(r.data)
      else setFailed(true)
    })
  }, [kind, run])
  const current = startedId && job?.id === startedId ? job : null
  const running = current?.state === "running"
  const needsUplink = !!p && !p.blocked && !p.uplinkCheck.ok
  const go = async () => {
    if (!p) return
    const r = await apply.run({ kind, planId: p.planId, confirmed: true, uplinkConfirmed: uplinkOk })
    if (r.ok) setStartedId(r.data.id)
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !running) onClose() }}>
      <DialogContent className="max-w-2xl" data-testid="switch-action-dialog">
        <DialogHeader>
          <DialogTitle>{t.confirmTitle[kind]}</DialogTitle>
          <DialogDescription>{JOB_KIND_LABEL[kind]}</DialogDescription>
        </DialogHeader>
        {current ? <SwitchJobProgress job={current} /> : !p ? (
          <p className="text-body text-muted-foreground" aria-live="polite">{failed ? "" : t.detailsLoading}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {p.blocked ? <InlineAlert tone="danger" role="alert">{p.blocked}</InlineAlert> : null}
            <SwitchPreviewDetails preview={p} />
            {!p.blocked && !p.nothingToDo ? (
              <>
                {needsUplink ? (
                  <div className="flex items-start gap-2">
                    <Checkbox id="sw-uplink" checked={uplinkOk} onCheckedChange={(v) => setUplinkOk(v === true)} className="mt-0.5" />
                    <Label htmlFor="sw-uplink" className="font-normal">{t.confirmUplink(p.uplinkCheck.expected)}</Label>
                  </div>
                ) : null}
                <div className="flex items-start gap-2">
                  <Checkbox id="sw-reviewed" checked={reviewed} onCheckedChange={(v) => setReviewed(v === true)} className="mt-0.5" />
                  <Label htmlFor="sw-reviewed" className="font-normal">{t.confirmCheck}</Label>
                </div>
              </>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {current && current.state !== "running" ? <Button variant="primary" onClick={onClose}>{t.done}</Button> : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={running}>{t.close}</Button>
              {!current && p && !p.blocked && !p.nothingToDo ? (
                <Button variant={kind === "remove" ? "danger" : "primary"} onClick={() => void go()} pending={apply.pending} disabled={!reviewed || (needsUplink && !uplinkOk)}>{t.apply}</Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Draft = Omit<EquipnetSettingsDTO, "hasPassword" | "adapterMac" | "equipmentIp"> & { equipmentIp: string; switchPassword: string; clearPassword: boolean }
const toDraft = (s: EquipnetSettingsDTO): Draft => ({
  enabled: s.enabled, driver: s.driver, switchHost: s.switchHost, switchUsername: s.switchUsername, portCount: s.portCount, uplinkPort: s.uplinkPort,
  vlanBase: s.vlanBase, mgmtAddress: s.mgmtAddress, equipmentIp: s.equipmentIp ?? "", equipmentPrefix: s.equipmentPrefix, hostOffset: s.hostOffset,
  switchPassword: "", clearPassword: false,
})
const num = (v: string): number => (v.trim() === "" ? Number.NaN : Number(v))

function SettingsForm({ status }: { status: EquipnetStatusDTO }) {
  const server = status.settings
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(server))
  const [base, setBase] = React.useState(server)
  if (base !== server && JSON.stringify(base) !== JSON.stringify(server)) {
    setBase(server)
    setDraft(toDraft(server))
  }
  const save = useAction(saveEquipnetSettings)
  // Open when the equipment IP is still missing (no profile default): it must be set before anything works.
  const [advanced, setAdvanced] = React.useState(!server.equipmentIp)
  const dirty = JSON.stringify(toDraft(server)) !== JSON.stringify(draft)
  useUnsavedChanges(dirty)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const e = save.fieldErrors
  const input = (): EquipnetSettingsInput => {
    const { switchPassword, clearPassword, ...rest } = draft
    return { ...rest, switchPassword: clearPassword ? null : switchPassword ? switchPassword : undefined }
  }
  const onSave = async () => {
    const r = await save.run(input())
    if (!r.ok) return
    if (r.data.warnings.length) toast.warning(t.settingsWarnings, { description: r.data.warnings.join(" ") })
    else toast.success(t.saved)
  }
  return (
    <Section title={t.settingsTitle} id="ajustes">
      <div className="grid gap-4 lg:grid-cols-2">
        <FormField label={t.driver} name="driver" errors={e}>
          {(ctl) => (
            <Select value={draft.driver} onValueChange={(v) => set("driver", v as SwitchDriverId)}>
              <SelectTrigger id={ctl.id}><SelectValue /></SelectTrigger>
              <SelectContent>{SWITCH_DRIVERS.map((d) => <SelectItem key={d} value={d}>{SWITCH_DRIVER_LABEL[d]}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </FormField>
        {draft.driver === "tplink-easy-smart" ? (
          <>
            <FormField label={t.switchHost} name="switchHost" errors={e} help={t.switchHostHelp}>
              <Input value={draft.switchHost ?? ""} placeholder="192.168.0.1" className="font-mono text-data" onChange={(ev) => set("switchHost", ev.target.value.trim() || null)} />
            </FormField>
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t.switchUser} name="switchUsername" errors={e}>
                <Input value={draft.switchUsername ?? ""} placeholder="admin" autoComplete="off" onChange={(ev) => set("switchUsername", ev.target.value.trim() || null)} />
              </FormField>
              <FormField label={t.switchPassword} name="switchPassword" errors={e} help={server.hasPassword ? t.switchPasswordStored : t.passwordHelpDefault}>
                <Input type="password" value={draft.switchPassword} autoComplete="new-password" maxLength={16} disabled={draft.clearPassword} onChange={(ev) => set("switchPassword", ev.target.value)} />
              </FormField>
            </div>
          </>
        ) : null}
        <div className="grid grid-cols-2 gap-4">
          <FormField label={t.portCount} name="portCount" errors={e}>
            <Input inputMode="numeric" value={Number.isFinite(draft.portCount) ? String(draft.portCount) : ""} onChange={(ev) => set("portCount", num(ev.target.value))} className="font-mono tabular-nums" />
          </FormField>
          <FormField label={t.uplinkPort} name="uplinkPort" errors={e}>
            <Input inputMode="numeric" value={Number.isFinite(draft.uplinkPort) ? String(draft.uplinkPort) : ""} onChange={(ev) => set("uplinkPort", num(ev.target.value))} className="font-mono tabular-nums" />
          </FormField>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <Switch id="eq-enabled" checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} disabled={!server.adapterMac && !draft.enabled} />
            <div className="flex flex-col gap-0.5"><Label htmlFor="eq-enabled">{t.enabled}</Label><p className="text-meta text-muted-foreground">{t.enabledHelp}</p></div>
          </div>
          {server.hasPassword ? (
            <div className="flex items-center gap-2">
              <Checkbox id="eq-clear" checked={draft.clearPassword} onCheckedChange={(v) => set("clearPassword", v === true)} />
              <Label htmlFor="eq-clear" className="font-normal">{t.switchPasswordClear}</Label>
            </div>
          ) : null}
        </div>
      </div>
      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="-ml-2"><ChevronRightIcon aria-hidden className={cn("transition-transform duration-150 motion-reduce:transition-none", advanced && "rotate-90")} />{t.addressesTitle}</Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pt-2">
          <p className="text-meta text-muted-foreground">{t.addressesHelp}</p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <FormField label={t.equipmentIp} name="equipmentIp" errors={e}>
              <Input value={draft.equipmentIp} className="font-mono text-data" onChange={(ev) => set("equipmentIp", ev.target.value.trim())} />
            </FormField>
            <FormField label={t.equipmentPrefix} name="equipmentPrefix" errors={e}>
              <Input inputMode="numeric" value={Number.isFinite(draft.equipmentPrefix) ? String(draft.equipmentPrefix) : ""} className="font-mono tabular-nums" onChange={(ev) => set("equipmentPrefix", num(ev.target.value))} />
            </FormField>
            <FormField label={t.mgmtAddress} name="mgmtAddress" errors={e}>
              <Input value={draft.mgmtAddress} className="font-mono text-data" onChange={(ev) => set("mgmtAddress", ev.target.value.trim())} />
            </FormField>
            <FormField label={t.vlanBase} name="vlanBase" errors={e}>
              <Input inputMode="numeric" value={Number.isFinite(draft.vlanBase) ? String(draft.vlanBase) : ""} className="font-mono tabular-nums" onChange={(ev) => set("vlanBase", num(ev.target.value))} />
            </FormField>
            <FormField label={t.hostOffset} name="hostOffset" errors={e}>
              <Input inputMode="numeric" value={Number.isFinite(draft.hostOffset) ? String(draft.hostOffset) : ""} className="font-mono tabular-nums" onChange={(ev) => set("hostOffset", num(ev.target.value))} />
            </FormField>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <FormErrors errors={e} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void onSave()} pending={save.pending} disabled={!dirty}>{t.save}</Button>
        {dirty ? <Button variant="ghost" onClick={() => setDraft(toDraft(server))}>Descartar cambios</Button> : null}
      </div>
    </Section>
  )
}

function ManualSection({ manual, open: initialOpen }: { manual: ManualInstructionsDTO; open: boolean }) {
  const [open, setOpen] = React.useState(initialOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2"><ChevronRightIcon aria-hidden className={cn("transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} /><NetworkIcon aria-hidden />{t.manualTitle}</Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-2" data-testid="manual-instructions">
        <p className="max-w-[90ch] text-meta text-muted-foreground">{t.manualHelp}</p>
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-body">
              <caption className="sr-only">{t.manualVlans}</caption>
              <thead className="bg-secondary text-left text-micro text-muted-foreground">
                <tr><th className="px-3 py-2 font-medium">{t.vlan}</th><th className="px-3 py-2 font-medium">{t.manualUntagged}</th><th className="px-3 py-2 font-medium">{t.manualTagged}</th></tr>
              </thead>
              <tbody>
                {manual.vlans.map((v) => (
                  <tr key={v.vid} className="h-9 border-t"><td className="px-3 font-mono">{v.vid}{v.vid !== 1 ? ` «${v.name}»` : ""}</td><td className="px-3 font-mono">{portList(v.untagged) || "-"}</td><td className="px-3 font-mono">{portList(v.tagged) || "-"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-body">
              <caption className="sr-only">{t.manualTitle}</caption>
              <thead className="bg-secondary text-left text-micro text-muted-foreground">
                <tr><th className="px-3 py-2 font-medium">{t.manualPort}</th><th className="px-3 py-2 font-medium">{t.manualPvid}</th><th className="px-3 py-2 font-medium">{t.manualUntagged}</th><th className="px-3 py-2 font-medium">{t.manualTagged}</th></tr>
              </thead>
              <tbody>
                {manual.rows.map((r) => (
                  <tr key={r.port} className="h-9 border-t"><td className="px-3 font-mono">{r.port}{r.role === "uplink" ? ` · ${t.roleUplink}` : ""}</td><td className="px-3 font-mono">{r.pvid}</td><td className="px-3 font-mono">{r.untagged.join(", ") || "-"}</td><td className="px-3 font-mono">{portList(r.tagged) || "-"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
