"use client"

import * as React from "react"
import { LoaderCircleIcon, ShieldAlertIcon } from "lucide-react"
import { FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Textarea } from "@/components/ui/textarea"
import { common } from "@/lib/i18n/common"
import { discovery as t } from "@/lib/i18n/hardware"
import { parseCidrList, scanHostEstimate, scanInput, type ScanForm } from "./relay-model"

/**
 * "Escanear subred…" (§8.9, D20): CIDRs prefilled with the /24 of each interface (or RM_RELAY_SCAN_CIDRS), ports,
 * the read-only warning with the address count, and a progress bar fed by `discovery.progress`. The scan runs on
 * the server; closing the dialog does not stop it.
 */
export function ScanDialog({ open, onOpenChange, defaults, running, progress, onStart, returnFocusRef }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaults: { cidrs: string[]; ports: number[] }
  running: boolean
  progress: { done: number; total: number } | null
  onStart: (input: { cidrs: string[]; ports: number[] }) => void
  /** The button that opened the dialog (it has no Radix trigger of its own). */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}) {
  const [form, setForm] = React.useState<ScanForm>(() => ({ cidrs: defaults.cidrs.join("\n"), ports: defaults.ports.join(", ") }))
  const [touched, setTouched] = React.useState(false)
  const parsed = scanInput(form)
  // No address count while the networks do not parse: "hasta 0 direcciones" would read as a harmless scan.
  const cidrList = parseCidrList(form.cidrs)
  const estimate = cidrList.invalid.length || !cidrList.cidrs.length ? null : scanHostEstimate(cidrList.cidrs)
  const cidrError = !touched || parsed.ok || !parsed.cidrs ? null
    : parsed.cidrs.kind === "empty" ? t.scanErrCidrs
      : parsed.cidrs.kind === "too-many" ? t.scanErrTooMany : t.scanErrCidr(parsed.cidrs.value)
  const portsError = touched && !parsed.ok && parsed.ports ? t.scanErrPorts : null
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  const start = () => {
    if (running) return
    setTouched(true)
    if (parsed.ok) onStart({ cidrs: parsed.cidrs, ports: parsed.ports })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        returnFocus={() => returnFocusRef?.current ?? null}
      >
        <DialogHeader>
          <DialogTitle>{t.scanTitle}</DialogTitle>
          <DialogDescription>{t.scanDescription}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            start()
          }}
        >
          <FormField label={t.scanCidrs} help={t.scanCidrsHelp} error={cidrError}>
            <Textarea
              value={form.cidrs}
              rows={3}
              readOnly={running}
              spellCheck={false}
              className="font-mono text-data read-only:bg-secondary"
              onChange={(e) => setForm((f) => ({ ...f, cidrs: e.target.value }))}
            />
          </FormField>
          <FormField label={t.scanPorts} help={t.scanPortsHelp} error={portsError}>
            <Input
              value={form.ports}
              readOnly={running}
              inputMode="numeric"
              spellCheck={false}
              className="max-w-48 font-mono text-data"
              onChange={(e) => setForm((f) => ({ ...f, ports: e.target.value }))}
            />
          </FormField>
          <InlineAlert tone="warn" icon={ShieldAlertIcon}>{t.scanWarning(estimate)}</InlineAlert>
          {running ? (
            <div className="flex flex-col gap-1.5">
              <Progress value={pct} aria-label={t.scanProgressLabel} />
              <p className="text-meta text-muted-foreground tabular-nums">
                {progress ? t.scanProgress(progress.done, progress.total) : t.scanPreparing}
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" size="lg" onClick={() => onOpenChange(false)}>{running ? common.close : common.cancel}</Button>
            {/* Values are read-only (not disabled) while the scan runs, and the button stays focusable: disabling the
                focused control would drop keyboard focus to <body>. */}
            <Button type="submit" variant="primary" size="lg" pending={running}>
              {running ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : null}
              {running ? t.scanning : t.scanStart}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
