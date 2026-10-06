"use client"

import * as React from "react"
import { ChevronRightIcon, PlugZapIcon } from "lucide-react"
import { AppLink } from "@/components/common/app-link"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useLiveState } from "@/hooks/use-live-state"
import type { TargetMode } from "@/lib/contracts/accesses"
import type { EquipnetEditDTO } from "@/lib/contracts/equipnet"
import type { ServerEventType } from "@/lib/contracts/events"
import { equipnetUi as t } from "@/lib/i18n/equipnet"
import { accessUi } from "@/lib/i18n/accesses"
import { cn } from "@/lib/client/cn"
import { editFromStatus, portChoices, portOptionText } from "./equipnet-model"

const EVENTS: readonly ServerEventType[] = ["equipnet.changed"]
const IP = "ip"
const NONE = "none"

export interface EthernetValue {
  targetMode: TargetMode
  switchPort: number | null
  targetHost: string
  targetPort: number | null
  sshUser: string | null
}

/** Live switch ports for the editors (admins get equipnet.changed): link, who has each port, the one just plugged in. */
export function useLiveSwitchPorts(initial: EquipnetEditDTO | null, equipmentId: string | null): EquipnetEditDTO | null {
  return useLiveState(initial, EVENTS, (s, e) => (e.type === "equipnet.changed" ? editFromStatus(e.status, equipmentId, Date.now()) : s))
}

/**
 * The Ethernet of one equipment: a list of switch ports ("Puerto 3 del switch · enlace activo · libre", "Puerto 4 ·
 * Equipo A #02") plus "Sin switch: dirección IP". The equipment IP of Red de equipos, the port (22) and the SSH user sit under
 * «Avanzado»; with "Sin switch" they are the main fields.
 */
export function SwitchPortField({ value, onChange, network, label, invalid, mode = "equipment" }: {
  value: EthernetValue
  onChange: (patch: Partial<EthernetValue>) => void
  network: EquipnetEditDTO | null
  label: string
  invalid?: { port?: boolean; host?: boolean; targetPort?: boolean }
  mode?: "equipment" | "template"
}) {
  const [advanced, setAdvanced] = React.useState(false)
  const choices = portChoices(network, value.switchPort)
  const suggested = network?.suggestedPort ?? null
  const selectValue = value.targetMode === "ip" ? IP : value.switchPort === null ? NONE : String(value.switchPort)
  const onSelect = (v: string) => {
    if (v === IP) onChange({ targetMode: "ip", switchPort: null })
    else if (v === NONE) onChange({ targetMode: "switch", switchPort: null })
    else onChange({ targetMode: "switch", switchPort: Number(v) })
  }
  const known = choices.some((c) => c.port.port === value.switchPort)
  const hostFields = (
    <>
      <Input aria-label={`${accessUi.targetHost} ${label}`} aria-invalid={invalid?.host ? true : undefined} value={value.targetHost} spellCheck={false}
        placeholder={value.targetMode === "switch" ? network?.equipmentIp ?? "192.168.1.10" : accessUi.targetHostPlaceholder}
        onChange={(e) => onChange({ targetHost: e.target.value.trim() })} className="w-44 font-mono text-data" />
      <span aria-hidden className="text-muted-foreground">:</span>
      <Input aria-label={`${accessUi.targetPort} ${label}`} aria-invalid={invalid?.targetPort ? true : undefined} inputMode="numeric" value={value.targetPort ?? ""} placeholder="22"
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 5)
          onChange({ targetPort: v ? Number(v) : null })
        }} className="w-20 font-mono text-data tabular-nums" />
      <Input aria-label={`${t.sshUser} ${label}`} value={value.sshUser ?? ""} placeholder="root" spellCheck={false} maxLength={32}
        onChange={(e) => onChange({ sshUser: e.target.value.trim() || null })} className="w-28 font-mono text-data" title={t.sshUser} />
    </>
  )
  if (mode === "template") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Select value={value.targetMode} onValueChange={(v) => onChange({ targetMode: v as TargetMode, switchPort: null })}>
          <SelectTrigger aria-label={`${t.targetModeSwitch} ${label}`} className="w-60"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="switch">{t.targetModeSwitch} (se elige en cada equipo)</SelectItem>
            <SelectItem value="ip">{t.targetModeIp}</SelectItem>
          </SelectContent>
        </Select>
        {hostFields}
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-2" data-switch-port-field>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selectValue} onValueChange={onSelect}>
          <SelectTrigger aria-label={`${t.targetModeSwitch} ${label}`} aria-invalid={invalid?.port ? true : undefined} className="w-80">
            <SelectValue placeholder={t.choosePort}>
              {value.targetMode === "ip" ? t.targetModeIp : value.switchPort === null ? t.choosePort : t.portOption(value.switchPort)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t.choosePort}</SelectItem>
            {choices.length ? (
              <SelectGroup>
                <SelectLabel>{t.targetModeSwitch}</SelectLabel>
                {choices.map(({ port, taken }) => {
                  const o = portOptionText(port, suggested)
                  return (
                    <SelectItem key={port.port} value={String(port.port)} disabled={taken}>
                      <span className="flex flex-col">
                        <span>{o.title}</span>
                        <span className="text-micro text-muted-foreground">{o.detail}</span>
                      </span>
                    </SelectItem>
                  )
                })}
              </SelectGroup>
            ) : null}
            {value.switchPort !== null && !known ? <SelectItem value={String(value.switchPort)}>{t.portOption(value.switchPort)}</SelectItem> : null}
            <SelectSeparator />
            <SelectItem value={IP}>{t.targetModeIp}</SelectItem>
          </SelectContent>
        </Select>
        {value.targetMode === "ip" ? hostFields : (
          <Collapsible open={advanced} onOpenChange={setAdvanced} className="flex flex-wrap items-center gap-2">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm"><ChevronRightIcon aria-hidden className={cn("transition-transform duration-150 motion-reduce:transition-none", advanced && "rotate-90")} />{t.advanced}</Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-wrap items-center gap-2">{hostFields}</CollapsibleContent>
          </Collapsible>
        )}
      </div>
      {value.targetMode === "switch" && value.switchPort === null && suggested !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-meta text-foreground" role="status">
          <PlugZapIcon aria-hidden className="size-3.5 text-brand" />{t.suggest(suggested)}
          <Button size="sm" variant="outline" onClick={() => onChange({ switchPort: suggested })}>{t.usePort(suggested)}</Button>
        </p>
      ) : null}
      {value.targetMode === "switch" && network && !network.configured ? (
        <p className="text-meta text-muted-foreground">{t.notConfigured} <AppLink href="/sistema/red-equipos" className="text-brand underline">{t.configureLink}</AppLink></p>
      ) : null}
    </div>
  )
}
