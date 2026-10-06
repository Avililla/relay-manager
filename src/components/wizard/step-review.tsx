"use client"

import { equipnetUi } from "@/lib/i18n/equipnet"
import * as React from "react"
import { CircleDashedIcon, InfoIcon } from "lucide-react"
import { FormErrors, errorsUnder, type FieldErrors } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { MiddleTruncate } from "@/components/common/middle-truncate"
import { Section } from "@/components/common/page"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tag } from "@/components/ui/tag"
import { lineSummary } from "@/lib/contracts/enums"
import type { BoardChoiceDTO } from "@/lib/contracts/relays"
import type { SerialSnapshotDTO } from "@/lib/contracts/serial"
import type { TemplateDTO } from "@/lib/contracts/templates"
import { serial as serialText } from "@/lib/i18n/shell"
import { relayPurposeLabel } from "@/lib/i18n/status"
import { wizardText as t } from "@/lib/i18n/wizard"
import { ACCESS_KIND_LABEL, ACCESS_POLICY_LABEL, accessUi as at, accessesText } from "@/lib/i18n/accesses"
import { cn } from "@/lib/client/cn"
import { isRelayTarget, type WizardDraft } from "@/lib/wizard/draft"
import { findPort, portName } from "@/lib/wizard/ports"
import type { TemplateDiff } from "@/lib/wizard/template-diff"

function diffSummary(d: TemplateDiff): string[] {
  const part = (title: string, s: TemplateDiff["consoles"]) => {
    const bits = [
      s.added.length ? t.diffAdded(s.added) : null,
      s.removed.length ? t.diffRemoved(s.removed) : null,
      s.modified.length ? t.diffModified(s.modified) : null,
      s.reordered ? t.diffReordered : null,
    ].filter(Boolean)
    return bits.length ? `${title}: ${bits.join("; ")}` : null
  }
  return [part(t.diffConsoles, d.consoles), part(t.diffRelays, d.relays), part(t.diffAccesses, d.accesses)].filter((x): x is string => !!x)
}

/** Step 5 (§8.9): what will be created, the optional save-back to the template, and form-level errors. */
export function StepReview({ draft, template, diff, snapshot, boards, roles, errors, serverMsg, onSaveToTemplate, accessPorts, cableName }: {
  draft: WizardDraft
  template: TemplateDTO | null
  diff: TemplateDiff | null
  snapshot: SerialSnapshotDTO
  boards: BoardChoiceDTO[]
  roles: Array<{ id: string; name: string }>
  errors: FieldErrors
  serverMsg: string | null
  onSaveToTemplate: (v: boolean) => void
  /** The port each access will get (preview of the server's allocation). */
  accessPorts: Array<number | null>
  cableName: (serial: string) => string | null
}) {
  const roleNames = draft.roleIds.map((id) => roles.find((r) => r.id === id)?.name ?? id)
  const pending = draft.consoles.filter((c) => !draft.bindings[c.uid]).length
  const boardName = (id: string) => boards.find((b) => b.id === id)?.name ?? id
  const saveId = "wizard-save-template"

  return (
    <div className="flex flex-col gap-8">
      {serverMsg ? <InlineAlert tone="danger" role="alert" title={t.serverErrorsTitle}>{serverMsg}</InlineAlert> : null}

      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-micro text-muted-foreground">{t.name}</dt>
          <dd className="truncate text-section text-foreground">{draft.name.trim()}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-micro text-muted-foreground">{t.summaryTemplate}</dt>
          <dd className="text-body text-foreground">{template ? template.name : t.blank}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-micro text-muted-foreground">{t.summarySerial}</dt>
          <dd className={cn("truncate", draft.serialNumber.trim() ? "font-mono text-data text-foreground" : "text-body text-faint-foreground")}>{draft.serialNumber.trim() || t.summaryNoSerial}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-micro text-muted-foreground">{t.summaryRoles}</dt>
          <dd className="flex flex-wrap gap-1 text-body text-foreground">
            {roleNames.length ? roleNames.map((n) => <Tag key={n} tone="neutral">{n}</Tag>) : <span className="text-muted-foreground">{t.summaryNoRoles}</span>}
          </dd>
        </div>
      </dl>

      {/* Below sm the label and line columns give way, so the port (what is being reviewed) stays on screen. */}
      <Section as="h3" title={t.consolesTitle} description={t.consolesCount(draft.consoles.length)}>
        {draft.consoles.length ? (
          <Table containerClassName="rounded-lg border bg-card">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t.colKey}</TableHead>
                <TableHead className="max-sm:hidden">{t.colLabel}</TableHead>
                <TableHead className="max-sm:hidden">{t.colLine}</TableHead>
                <TableHead>{t.colPort}</TableHead>
                <TableHead className="max-sm:hidden">{t.colMatch}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {draft.consoles.map((c, i) => {
                const b = draft.bindings[c.uid]
                const port = b ? findPort(snapshot, b.stableKey) : null
                const bad = errorsUnder(errors, `consoles.${i}`).length > 0
                const portErrors = [...new Set(errorsUnder(errors, `consoles.${i}.binding`))]
                return (
                  <TableRow key={c.uid} className={cn(bad && "bg-danger-tint")}>
                    <TableCell className="font-mono text-data font-semibold">{c.key}</TableCell>
                    <TableCell className="max-w-48 truncate max-sm:hidden">{c.label}</TableCell>
                    <TableCell className="font-mono text-data whitespace-nowrap tabular-nums max-sm:hidden">{lineSummary(c.line)}</TableCell>
                    <TableCell className="max-w-72 max-sm:max-w-56">
                      {b ? (
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="shrink-0 font-mono text-data">{port ? portName(port) : b.stableKey}</span>
                          {port ? <MiddleTruncate value={port.devNode} tail={10} className="min-w-0 text-muted-foreground" /> : null}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-meta text-faint-foreground"><CircleDashedIcon aria-hidden className="size-3.5" />{t.unassigned}</span>
                      )}
                      {b ? <span className="block text-meta text-muted-foreground sm:hidden">{serialText.matchBy[b.matchBy]}</span> : null}
                      {portErrors.length ? <p className="mt-0.5 text-meta whitespace-normal text-danger">{portErrors.join(" ")}</p> : null}
                    </TableCell>
                    <TableCell className="text-meta whitespace-nowrap text-muted-foreground max-sm:hidden">{b ? serialText.matchBy[b.matchBy] : ""}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="text-body text-muted-foreground">{t.noConsoles}</p>
        )}
        {pending > 0 && draft.consoles.length ? (
          <p className="flex items-start gap-2 text-meta text-muted-foreground"><InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-brand" />{t.pendingPorts(pending)}</p>
        ) : null}
      </Section>

      <Section as="h3" title={t.relaysTitle} description={draft.relays.length ? t.relaysCount(draft.relays.length) : undefined}>
        {draft.relays.length ? (
          <Table containerClassName="rounded-lg border bg-card">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t.colKey}</TableHead>
                <TableHead className="max-sm:hidden">{t.colLabel}</TableHead>
                <TableHead className="max-sm:hidden">{t.colPurpose}</TableHead>
                <TableHead>{t.colBoard}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {draft.relays.map((r, i) => {
                const a = draft.relayTargets[r.uid]
                const bad = errorsUnder(errors, `relays.${i}`).length > 0
                return (
                  <TableRow key={r.uid} className={cn(bad && "bg-danger-tint")}>
                    <TableCell className="font-mono text-data font-semibold">{r.key}</TableCell>
                    <TableCell className="max-w-48 truncate max-sm:hidden">{r.label}</TableCell>
                    <TableCell className="text-meta max-sm:hidden">{relayPurposeLabel(r.purpose)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {isRelayTarget(a) ? (
                        <>
                          <span>{boardName(a.boardId)}</span>
                          <span className="text-muted-foreground"> · </span>
                          <span className="font-mono text-data tabular-nums">{a.channel}</span>
                        </>
                      ) : <span className="text-meta text-faint-foreground">{t.skipped}</span>}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="text-body text-muted-foreground">{t.noRelays}</p>
        )}
      </Section>

      <Section as="h3" title={at.reviewTitle} description={draft.accesses.length ? accessesText.count(draft.accesses.length) : undefined}>
        {draft.accesses.length ? (
          <Table containerClassName="rounded-lg border bg-card">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t.colKey}</TableHead>
                <TableHead className="max-sm:hidden">{t.colLabel}</TableHead>
                <TableHead>{at.kind}</TableHead>
                <TableHead>{at.port}</TableHead>
                <TableHead className="max-sm:hidden">{at.target}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {draft.accesses.map((a, i) => {
                const bad = errorsUnder(errors, `accesses.${i}`).length > 0
                const errs = [...new Set(errorsUnder(errors, `accesses.${i}`))]
                const what = a.kind === "jtag"
                  ? (a.cableSerial ? `${cableName(a.cableSerial) ?? a.cableSerial}${cableName(a.cableSerial) ? ` · ${a.cableSerial}` : ""}` : at.noCable)
                  : a.kind === "serial" ? (a.consoleKey ?? at.chooseConsole)
                    : a.targetMode === "switch" ? (a.switchPort !== null ? `${equipnetUi.portOption(a.switchPort)}${a.targetHost ? ` · ${a.targetHost}:${a.targetPort ?? ""}` : ""}` : equipnetUi.choosePort)
                      : (a.targetHost ? `${a.targetHost}:${a.targetPort ?? ""}` : at.targetUnknown)
                return (
                  <TableRow key={a.uid} className={cn(bad && "bg-danger-tint")}>
                    <TableCell className="font-mono text-data font-semibold">{a.key}</TableCell>
                    <TableCell className="max-w-48 truncate max-sm:hidden">{a.label}</TableCell>
                    <TableCell className="text-meta">{ACCESS_KIND_LABEL[a.kind]} · {ACCESS_POLICY_LABEL[a.policy]}</TableCell>
                    <TableCell className="font-mono text-data tabular-nums">{a.port ?? accessPorts[i] ?? "-"}</TableCell>
                    <TableCell className="max-w-72 truncate text-meta max-sm:hidden">
                      {what}
                      {errs.length ? <p className="mt-0.5 whitespace-normal text-danger">{errs.join(" ")}</p> : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : <p className="text-body text-muted-foreground">{at.reviewNone}</p>}
      </Section>

      {template && template.source !== "file" && diff?.changed ? (
        <div className="flex max-w-3xl items-start gap-3 rounded-lg border bg-card px-4 py-3">
          <Checkbox id={saveId} checked={draft.saveToTemplate} onCheckedChange={(v) => onSaveToTemplate(v === true)} className="mt-0.5" />
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={saveId} className="font-medium">{t.saveToTemplate(template.name)}</Label>
            <ul className="flex flex-col text-meta text-muted-foreground">
              {diffSummary(diff).map((line) => <li key={line}>{line}</li>)}
            </ul>
            <p className="text-meta text-muted-foreground">
              {t.saveToTemplateHelp}{template.needsReview ? ` ${t.saveToTemplateReviewed}` : ""}
            </p>
          </div>
        </div>
      ) : null}

      <FormErrors errors={errors} />
    </div>
  )
}
