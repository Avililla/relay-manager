"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FileJsonIcon, FileUpIcon, LoaderCircleIcon, SearchCheckIcon, UploadIcon } from "lucide-react"
import { toast } from "sonner"
import { importConfig } from "@/actions/system"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { Tag } from "@/components/ui/tag"
import { useAction } from "@/hooks/use-action"
import { useMounted } from "@/hooks/use-mounted"
import type { ImportReportDTO } from "@/lib/contracts/config-io"
import { system as t } from "@/lib/i18n/admin"
import { formatDateTime } from "@/lib/i18n/format"
import { inspectConfigFile, type ConfigFileCheck } from "./system-model"

type Chosen = { name: string; text: string; check: ConfigFileCheck }

function ReportView({ report, final }: { report: ImportReportDTO; final: boolean }) {
  const nothing = Object.values(report.created).every((n) => n === 0)
  return (
    <div className="flex flex-col gap-3" role="status">
      <p className="text-body font-medium text-foreground">{final ? t.importResultTitle : t.importPreviewTitle}</p>
      {nothing ? (
        <p className="text-body text-muted-foreground">{t.importNothing}</p>
      ) : (
        <p className="text-body text-foreground">
          <span className="text-muted-foreground">{final ? t.importCreatedLabel : t.importWillCreate}: </span>
          {t.importCreated(report.created)}
        </p>
      )}
      {report.skipped.length ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-meta font-medium text-muted-foreground">{t.importSkipped(report.skipped.length)}</p>
          <ul className="flex max-h-40 flex-col overflow-y-auto rounded-md border bg-muted/40">
            {report.skipped.map((s, i) => (
              <li key={`${s.kind}-${s.name}-${i}`} className="flex items-baseline gap-2 border-b px-2.5 py-1.5 text-meta last:border-b-0">
                <Tag className="shrink-0">{t.importKind[s.kind]}</Tag>
                <span className="font-medium text-foreground">{s.name}</span>
                <span className="min-w-0 text-muted-foreground">{s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.warnings.length ? (
        <InlineAlert tone="warn" title={t.importWarnings(report.warnings.length)}>
          <ul className="flex max-h-40 list-disc flex-col gap-0.5 overflow-y-auto pl-4 text-meta">
            {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </InlineAlert>
      ) : null}
    </div>
  )
}

/**
 * Configuración del banco (§8.9 Copias): export as JSON, and "Importar configuración…" with a dry run first
 * (file → dry-run report → "Importar"). The file is checked locally (size, JSON, format) before the server's dry run.
 */
export function ConfigPanel() {
  const router = useRouter()
  const mounted = useMounted()
  const [open, setOpen] = React.useState(false)
  const [chosen, setChosen] = React.useState<Chosen | null>(null)
  const [preview, setPreview] = React.useState<ImportReportDTO | null>(null)
  const [result, setResult] = React.useState<ImportReportDTO | null>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const action = useAction(importConfig)
  const fileId = React.useId()

  const reset = () => {
    setChosen(null)
    setPreview(null)
    setResult(null)
    if (fileRef.current) fileRef.current.value = ""
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    setPreview(null)
    setResult(null)
    if (!file) return setChosen(null)
    const text = await file.text()
    setChosen({ name: file.name, text, check: inspectConfigFile(text) })
  }

  async function check() {
    if (!chosen?.check.ok) return
    const r = await action.run({ json: chosen.text, dryRun: true })
    if (r.ok) setPreview(r.data)
  }

  async function run() {
    if (!chosen?.check.ok || !preview) return
    const r = await action.run({ json: chosen.text, dryRun: false })
    if (!r.ok) return
    setResult(r.data)
    toast.success(t.importDone)
    router.refresh()
  }

  return (
    <Panel>
      <PanelHeader>
        <div className="mr-auto flex min-w-0 flex-col py-1">
          <PanelTitle as="h2">{t.configSection}</PanelTitle>
        </div>
      </PanelHeader>
      <PanelBody className="gap-4">
        <PanelDescription className="max-w-[72ch] text-body">{t.configHelp}</PanelDescription>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="default">
            <a href="/api/config/export" download><FileJsonIcon aria-hidden />{t.exportConfig}</a>
          </Button>
          <Button variant="default" onClick={() => { reset(); setOpen(true) }}>
            <FileUpIcon aria-hidden />{t.importConfig}
          </Button>
        </div>
      </PanelBody>

      <Dialog open={open} onOpenChange={(o) => { if (!action.pending) { setOpen(o); if (!o) reset() } }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t.importTitle}</DialogTitle>
            <DialogDescription>{t.importIntro}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {!result ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={fileId}>{t.importFile}</Label>
                <input
                  ref={fileRef}
                  id={fileId}
                  type="file"
                  accept=".json,application/json"
                  onChange={onFile}
                  disabled={action.pending}
                  aria-describedby={`${fileId}-help`}
                  className="block w-full min-w-0 rounded-md border border-input bg-muted text-body text-foreground file:mr-3 file:h-8 file:border-0 file:border-r file:border-input file:bg-secondary file:px-3 file:text-body file:font-medium file:text-foreground hover:border-control-border"
                />
                <p id={`${fileId}-help`} className="text-meta text-muted-foreground">{t.importFileHelp}</p>
              </div>
            ) : null}
            {chosen && !chosen.check.ok ? <InlineAlert tone="danger" role="alert">{chosen.check.reason}</InlineAlert> : null}
            {chosen?.check.ok && !preview && !result ? (
              <p className="text-meta text-muted-foreground">
                {mounted ? t.importFileSummary(chosen.check.appVersion, formatDateTime(chosen.check.exportedAt)) : null}
              </p>
            ) : null}
            {result ? <ReportView report={result} final /> : preview ? <ReportView report={preview} final={false} /> : null}
          </div>
          <DialogFooter>
            {result ? (
              <Button variant="primary" size="lg" onClick={() => { setOpen(false); reset() }}>{t.close}</Button>
            ) : (
              <>
                <Button variant="ghost" size="lg" onClick={() => { setOpen(false); reset() }} disabled={action.pending}>{t.close}</Button>
                {!preview ? (
                  <Button variant="primary" size="lg" onClick={() => void check()} disabled={!chosen?.check.ok || action.pending} aria-busy={action.pending || undefined}>
                    {action.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <SearchCheckIcon aria-hidden />}
                    {action.pending ? t.importChecking : t.importCheck}
                  </Button>
                ) : (
                  <Button variant="primary" size="lg" onClick={() => void run()} disabled={action.pending || (Object.values(preview.created).every((n) => n === 0) && preview.warnings.length === 0)} aria-busy={action.pending || undefined}>
                    {action.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <UploadIcon aria-hidden />}
                    {action.pending ? t.importRunning : t.importRun}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}
