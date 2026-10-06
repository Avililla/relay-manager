"use client"

import * as React from "react"
import { CloudDownloadIcon } from "lucide-react"
import { toast } from "sonner"
import { FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ExportInfoDTO } from "@/lib/contracts/files"
import { exportStore } from "@/lib/files/export-store"
import { checkExportForm, type ExportForm, type ExportFormErrors } from "@/lib/files/export-form"
import { exportUi as t } from "@/lib/i18n/files"

const EMPTY: ExportForm = { app: "", version: "", extract: false, zipName: "", dir: "" }

/**
 * «Descargas» (the profile's download script): application, version, the optional -x switch (when the profile names
 * it), the zip name (optional) and the destination folder (the folder being shown by default). The texts come from the
 * profile (ExportInfoDTO.labels). The server runs the script (one at a time, the rest wait in a queue); its progress
 * and log go to the panel.
 */
export function ExportDialog({ open, dir, info, onClose }: { open: boolean; dir: string; info: ExportInfoDTO; onClose: () => void }) {
  const L = info.labels
  const root = info.rootLabel
  const [form, setForm] = React.useState<ExportForm>(EMPTY)
  const [errors, setErrors] = React.useState<ExportFormErrors>({})
  const [formError, setFormError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [forOpen, setForOpen] = React.useState(false)
  if (open !== forOpen) {
    setForOpen(open)
    if (open) {
      // The application and version typed last time stay (several versions in a row); the folder follows the page.
      setForm((f) => ({ ...f, zipName: "", dir }))
      setErrors({})
      setFormError(null)
    }
  }
  const set = <K extends keyof ExportForm>(k: K, v: ExportForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (k in errors) setErrors((e) => ({ ...e, [k]: undefined }))
  }
  const unavailable = !info.available

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const c = checkExportForm(L.extract ? form : { ...form, extract: false })
    if (!c.ok) {
      setErrors(c.errors)
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const r = await exportStore().start(c.input)
      if (!r.ok) {
        if (r.field === "app" || r.field === "version" || r.field === "zipName" || r.field === "dir") setErrors({ [r.field]: r.message })
        else setFormError(r.message)
        return
      }
      toast.success(t.started(L.name))
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const placeholder = t.zipDefault(form.app.trim(), form.version.trim())
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="grid min-w-0 gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t.dialogTitle(L.title)}</DialogTitle>
            <DialogDescription>{L.description}</DialogDescription>
          </DialogHeader>
          {unavailable ? <InlineAlert tone="warn" title={t.unavailable(L.name)}>{info.problem}</InlineAlert> : null}
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <FormField label={L.app} error={errors.app} help={t.appHelp} required>
              <Input value={form.app} onChange={(e) => set("app", e.target.value)} autoFocus spellCheck={false} autoComplete="off" maxLength={100} className="font-mono" data-testid="export-app" />
            </FormField>
            <FormField label={L.version} error={errors.version} help={t.versionHelp} required>
              <Input value={form.version} onChange={(e) => set("version", e.target.value)} spellCheck={false} autoComplete="off" maxLength={100} className="font-mono" data-testid="export-version" />
            </FormField>
          </div>
          {L.extract ? (
            <div className="flex items-start gap-2">
              <Checkbox id="export-extract" checked={form.extract} onCheckedChange={(v) => set("extract", v === true)} aria-describedby="export-extract-help" className="mt-0.5" />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="export-extract" className="font-normal">{L.extract}</Label>
                <p id="export-extract-help" className="text-meta text-muted-foreground">{t.extractHelp}</p>
              </div>
            </div>
          ) : null}
          <FormField label={t.zipName} error={errors.zipName} help={t.zipNameHelp(placeholder)}>
            <Input value={form.zipName} onChange={(e) => set("zipName", e.target.value)} placeholder={placeholder} spellCheck={false} autoComplete="off" maxLength={255} data-testid="export-zip" />
          </FormField>
          <FormField
            label={t.dir(root)}
            error={errors.dir}
            help={t.dirHelp(root)}
            labelAside={dir !== form.dir ? <Button type="button" size="sm" variant="ghost" onClick={() => set("dir", dir)}>{t.useCurrent}</Button> : null}
          >
            <Input value={form.dir} onChange={(e) => set("dir", e.target.value)} placeholder={t.rootDir(root)} spellCheck={false} autoComplete="off" className="font-mono" data-testid="export-dir" />
          </FormField>
          <p className="text-meta text-muted-foreground">{t.timeout(info.timeoutMin)}</p>
          {formError ? <InlineAlert tone="danger" role="alert">{formError}</InlineAlert> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t.cancel}</Button>
            <Button type="submit" variant="primary" pending={busy} disabled={unavailable}><CloudDownloadIcon aria-hidden />{t.start}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
