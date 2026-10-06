"use client"

import * as React from "react"
import { InlineAlert } from "@/components/common/inline-alert"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { MATCH_BY, type MatchBy } from "@/lib/contracts/enums"
import type { SerialPortDTO } from "@/lib/contracts/serial"
import { serial } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

/** Suggested match mode for a port: adapter when it has a unique serial, USB socket otherwise, path for virtual. */
export function suggestedMatchBy(port: SerialPortDTO | null): MatchBy {
  if (!port || !port.usb) return "path"
  return port.hints.includes("no-serial") || port.hints.includes("duplicate-serial") || !port.usb.serial ? "usb-port" : "adapter"
}

/**
 * How a console finds its port again (§8.8): by adapter serial, by USB socket or by path, with the warnings that
 * matter for the chosen port (no unique serial, path on a USB port).
 */
export function MatchByField({ value, onChange, port, disabled, className, legend = serial.matchMode }: {
  value: MatchBy
  onChange: (v: MatchBy) => void
  port: SerialPortDTO | null
  disabled?: boolean
  className?: string
  legend?: string
}) {
  const id = React.useId()
  const usb = !!port?.usb
  const noUniqueSerial = !!port && (port.hints.includes("no-serial") || port.hints.includes("duplicate-serial") || (usb && !port.usb?.serial))
  const available = (m: MatchBy) => (m === "path" ? true : usb)
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-2", className)} disabled={disabled}>
      <legend className="mb-1 text-body font-medium text-foreground">{legend}</legend>
      <RadioGroup value={value} onValueChange={(v) => onChange(v as MatchBy)} className="gap-1.5">
        {MATCH_BY.map((m) => (
          <div key={m} className={cn("flex items-start gap-2", !available(m) && "opacity-50")}>
            <RadioGroupItem id={`${id}-${m}`} value={m} disabled={!available(m)} className="mt-0.5" />
            <Label htmlFor={`${id}-${m}`} className="flex flex-col items-start gap-0 font-normal">
              <span className="text-body text-foreground">{serial.matchBy[m]}</span>
              <span className="text-meta text-muted-foreground">{serial.matchByHelp[m]}</span>
            </Label>
          </div>
        ))}
      </RadioGroup>
      {value === "adapter" && noUniqueSerial ? <InlineAlert tone="warn">{serial.matchNoSerialWarning}</InlineAlert> : null}
      {value === "path" && usb ? <InlineAlert tone="warn">{serial.matchPathWarning}</InlineAlert> : null}
    </fieldset>
  )
}
