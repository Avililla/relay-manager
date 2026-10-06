"use client"

import * as React from "react"
import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CornerDownLeftIcon, TriangleAlertIcon, XIcon, type LucideIcon } from "lucide-react"
import { StatusChip } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import type { ProbeResultDTO, SerialPortDTO } from "@/lib/contracts/serial"
import { discovery as t } from "@/lib/i18n/hardware"
import { probeStateLabel } from "@/lib/i18n/status"
import { portDisplayName, probeTone, type ProbeTone } from "./serial-model"

// Samples are console output: shown on the terminal surface (--xterm-bg / --xterm-fg, globals.css; §8.2).

/** Console output uses CR LF; show one line per line. */
function cleanSample(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd()
}

const ICON: Record<ProbeTone, LucideIcon> = { ok: CircleCheckIcon, warn: TriangleAlertIcon, danger: CircleAlertIcon, neutral: CircleDashedIcon }

/**
 * Results of "Identificar" and "Enviar retorno de carro" for one port group: the classified state (§4.7), the
 * hostname when the console printed one, and the last line heard. Passive by default; a poke is labelled.
 */
export function ProbeResults({ ports, results, onClear, title }: {
  ports: SerialPortDTO[]
  results: Record<string, ProbeResultDTO>
  onClear: () => void
  title: string
}) {
  const rows = ports.flatMap((p) => (results[p.stableKey] ? [{ port: p, r: results[p.stableKey]! }] : []))
  if (!rows.length) return null
  return (
    <section aria-label={title} className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-micro text-muted-foreground">{title}</h3>
        <Button variant="ghost" size="sm" onClick={onClear}><XIcon aria-hidden />{t.resultsClear}</Button>
      </div>
      <ul className="flex flex-col divide-y">
        {rows.map(({ port, r }) => {
          const tone = probeTone(r.state)
          return (
            <li key={port.stableKey} className="grid gap-x-4 gap-y-1.5 py-2.5 first:pt-1 last:pb-1 md:grid-cols-[9rem_minmax(0,1fr)]">
              <div className="flex flex-col gap-1">
                <span className="font-mono text-data font-semibold text-foreground">{portDisplayName(port)}</span>
                <StatusChip tone={tone} icon={ICON[tone]} className="w-fit">{probeStateLabel(r.state)}</StatusChip>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-0.5 text-meta">
                  {r.hostname || !r.openByApp ? (
                    <dl className="flex flex-wrap gap-x-5 gap-y-0.5">
                      {r.hostname ? (
                        <div className="flex gap-1.5"><dt className="text-muted-foreground">{t.resultHostname}</dt><dd className="font-mono text-data text-foreground">{r.hostname}</dd></div>
                      ) : null}
                      {/* Read from the app's own buffer there was no listening window: a "0 s" would mislead. */}
                      {!r.openByApp ? (
                        <div className="flex gap-1.5"><dt className="sr-only">{t.resultDuration}</dt><dd className="font-mono text-data text-muted-foreground tabular-nums">{t.resultMs(r.ms)}</dd></div>
                      ) : null}
                    </dl>
                  ) : null}
                  {r.poked ? <p className="flex items-center gap-1 text-muted-foreground"><CornerDownLeftIcon aria-hidden className="size-3.5" />{t.resultPoked}</p> : null}
                  {r.openByApp ? <p className="text-muted-foreground">{t.resultOwnBuffer}</p> : null}
                </div>
                {r.error ? <p className="text-meta text-danger">{r.error}</p> : null}
                {r.sample.trim() ? (
                  <>
                    <p className="sr-only">{t.resultSample}</p>
                    {/* Scrolls when long: focusable so it can be read by keyboard. */}
                    <pre tabIndex={0} style={{ backgroundColor: "var(--xterm-bg)", color: "var(--xterm-fg)" }} className="max-h-24 overflow-auto rounded-sm px-2.5 py-1.5 font-mono text-data whitespace-pre-wrap">{cleanSample(r.sample)}</pre>
                  </>
                ) : (
                  <p className="text-meta text-faint-foreground">{r.openByApp ? t.resultNoSampleBuffer : t.resultNoSample}</p>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
