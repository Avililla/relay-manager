"use client"

import * as React from "react"
import { CheckIcon, KeyRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tag } from "@/components/ui/tag"
import type { DetectResultDTO } from "@/lib/contracts/relays"
import { boardForm as t } from "@/lib/i18n/hardware"
import { driverLabel } from "@/lib/i18n/status"
import { cn } from "@/lib/client/cn"

const CONFIDENCE_TONE: Record<DetectResultDTO["confidence"], "ok" | "neutral" | "outline"> = { high: "ok", medium: "neutral", low: "outline" }

/**
 * What "Probar conexión" found (§8.9): one entry per candidate driver, most likely first, with the evidence lines
 * the server collected and an optional "Usar estos valores".
 */
export function DetectResults({ results, onUse, appliedIndex = null, className }: {
  results: DetectResultDTO[]
  onUse?: (r: DetectResultDTO, index: number) => void
  appliedIndex?: number | null
  className?: string
}) {
  return (
    <ol className={cn("flex flex-col gap-3", className)}>
      {results.map((r, i) => {
        const ports = [r.httpPort ? `HTTP ${r.httpPort}` : null, r.tcpPort ? `TCP ${r.tcpPort}` : null].filter(Boolean).join(" · ")
        return (
          <li key={`${r.driver}-${i}`} className="flex flex-col gap-2.5 rounded-md border bg-background/40 p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-body font-semibold text-foreground">{driverLabel(r.driver)}</span>
              <Tag tone={CONFIDENCE_TONE[r.confidence]}>{t.confidence[r.confidence]}</Tag>
              {r.authRequired ? <Tag tone="warn"><KeyRoundIcon aria-hidden />{t.authRequired}</Tag> : null}
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-meta">
              {r.model ? (<><dt className="text-muted-foreground">{t.model}</dt><dd className="font-mono text-data text-foreground">{r.model}{r.moduleId !== null ? ` (id ${r.moduleId})` : ""}</dd></>) : null}
              {r.relayCount !== null ? (<><dt className="text-muted-foreground">{t.detRelays}</dt><dd className="font-mono text-data text-foreground tabular-nums">{r.relayCount}</dd></>) : null}
              {ports ? (<><dt className="text-muted-foreground">{t.detPorts}</dt><dd className="font-mono text-data text-foreground tabular-nums">{ports}</dd></>) : null}
              {r.hostname ? (<><dt className="text-muted-foreground">{t.detHost}</dt><dd className="truncate font-mono text-data text-foreground">{r.hostname}</dd></>) : null}
              {r.mac ? (<><dt className="text-muted-foreground">{t.detMac}</dt><dd className="font-mono text-data text-foreground">{r.mac}</dd></>) : null}
              {r.firmware ? (<><dt className="text-muted-foreground">{t.detFirmware}</dt><dd className="font-mono text-data text-foreground">{r.firmware}</dd></>) : null}
              {r.options.toggleVar ? (<><dt className="text-muted-foreground">toggleVar</dt><dd className="font-mono text-data text-foreground">{r.options.toggleVar}</dd></>) : null}
            </dl>
            {r.evidence.length ? (
              <div className="flex flex-col gap-1">
                <p className="text-micro text-muted-foreground">{t.evidence}</p>
                <ul className="flex flex-col gap-0.5 rounded-sm bg-muted px-2 py-1.5">
                  {r.evidence.map((e, j) => <li key={j} className="font-mono text-data break-words text-muted-foreground">{e}</li>)}
                </ul>
              </div>
            ) : null}
            {onUse ? (
              <div>
                <Button size="sm" variant={appliedIndex === i ? "ghost" : "default"} onClick={() => onUse(r, i)}>
                  {appliedIndex === i ? <CheckIcon aria-hidden className="text-ok" /> : null}
                  {appliedIndex === i ? t.valuesApplied : t.useValues}
                </Button>
              </div>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
