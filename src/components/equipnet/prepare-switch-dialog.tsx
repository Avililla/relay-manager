"use client"

import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import { prepareSwitch, previewPrepareSwitch } from "@/actions/equipnet"
import { FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAction } from "@/hooks/use-action"
import type { EquipnetStatusDTO, SwitchJobDTO, SwitchPreviewDTO } from "@/lib/contracts/equipnet"
import { equipnetUi as t } from "@/lib/i18n/equipnet"
import { cn } from "@/lib/client/cn"
import { planLines } from "./equipnet-model"
import { SwitchJobProgress, SwitchPreviewDetails } from "./switch-preview"

/**
 * «Preparar el switch para los equipos» (step 3 of Sistema › Red de equipos): the plan in plain words, the switch password (factory «admin»
 * prefilled when none is stored), «Detalles» with the exact changes (read from the switch, nothing applied), and one
 * button. The click is the confirmation; when the server cannot verify the uplink it asks for an explicit tick.
 */
export function PrepareSwitchDialog({ status, open, onOpenChange }: { status: EquipnetStatusDTO; open: boolean; onOpenChange: (o: boolean) => void }) {
  const d = status.detection
  const stored = status.settings.hasPassword
  const askPassword = !stored || d?.loginOk === false
  const [password, setPassword] = React.useState(stored ? "" : "admin")
  const [preview, setPreview] = React.useState<SwitchPreviewDTO | null>(null)
  const [details, setDetails] = React.useState(false)
  const [uplinkOk, setUplinkOk] = React.useState(false)
  const [started, setStarted] = React.useState<SwitchJobDTO | null>(null)
  const pv = useAction(previewPrepareSwitch)
  const prep = useAction(prepareSwitch)
  // The job as the action returned it, then live from equipnet.changed.
  const job = started ? (status.job?.id === started.id ? status.job : started) : null
  const pw = password.trim() ? password : undefined

  React.useEffect(() => {
    if (!open) {
      setPreview(null)
      setDetails(false)
      setUplinkOk(false)
      setStarted(null)
    }
  }, [open])

  const loadPreview = async () => {
    const r = await pv.run({ password: pw })
    if (r.ok) setPreview(r.data)
  }
  const onDetails = (o: boolean) => {
    setDetails(o)
    if (o && !preview) void loadPreview()
  }
  const submit = async () => {
    const r = await prep.run({ password: pw, uplinkConfirmed: uplinkOk })
    if (!r.ok) return
    setPreview(r.data.preview)
    if (r.data.started && r.data.job) setStarted(r.data.job)
    else setDetails(true)
  }

  const portCount = d?.portCount ?? status.settings.portCount
  const blocked = preview?.blocked ?? null
  const needsUplinkTick = !!preview && !preview.blocked && !preview.uplinkCheck.ok
  const running = job?.state === "running"
  const finished = job && job.state !== "running"
  const errors = { ...pv.fieldErrors, ...prep.fieldErrors }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!running) onOpenChange(o) }}>
      <DialogContent className="max-w-2xl" data-testid="prepare-switch-dialog">
        <DialogHeader>
          <DialogTitle>{t.prepareTitle}</DialogTitle>
          <DialogDescription>{d ? t.foundLine(d.model, d.host) : t.switchKnown(status.settings.switchHost ?? "")}</DialogDescription>
        </DialogHeader>
        {job ? <SwitchJobProgress job={job} /> : (
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <p className="text-body font-medium text-foreground">{t.planIntro}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-foreground">
                {planLines({ uplinkPort: status.settings.uplinkPort, portCount, equipmentIp: status.settings.equipmentIp }).map((l) => <li key={l}>{l}</li>)}
              </ul>
            </div>
            {askPassword ? (
              <FormField label={t.password} name="password" errors={errors} help={stored ? t.passwordHelpStored : t.passwordHelpDefault}>
                <Input type="password" autoComplete="off" value={password} maxLength={16} className="max-w-72" onChange={(e) => { setPassword(e.target.value); setPreview(null) }} />
              </FormField>
            ) : null}
            {blocked ? <InlineAlert tone="danger" role="alert">{blocked}</InlineAlert> : null}
            {needsUplinkTick ? (
              <div className="flex items-start gap-2">
                <Checkbox id="uplink-ok" checked={uplinkOk} onCheckedChange={(v) => setUplinkOk(v === true)} className="mt-0.5" />
                <Label htmlFor="uplink-ok" className="font-normal">{t.confirmUplink(status.settings.uplinkPort)}</Label>
              </div>
            ) : null}
            <Collapsible open={details} onOpenChange={onDetails}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="-ml-2 self-start">
                  <ChevronRightIcon aria-hidden className={cn("transition-transform duration-150 motion-reduce:transition-none", details && "rotate-90")} />{t.details}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                {preview ? <SwitchPreviewDetails preview={preview} /> : <p className="text-meta text-muted-foreground" aria-live="polite">{pv.pending ? t.detailsLoading : ""}</p>}
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
        <DialogFooter>
          {finished ? <Button variant="primary" onClick={() => onOpenChange(false)}>{job?.state === "done" ? t.done : t.close}</Button> : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={running}>{t.close}</Button>
              {!running ? (
                <Button variant="primary" onClick={() => void submit()} pending={prep.pending} disabled={!!blocked || (needsUplinkTick && !uplinkOk)}>
                  {prep.pending ? t.preparing : t.prepare}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
