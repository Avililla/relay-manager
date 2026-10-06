"use client"

import * as React from "react"
import { KeyRoundIcon, LoaderCircleIcon, NetworkIcon, SendIcon, ServerOffIcon } from "lucide-react"
import { toast } from "sonner"
import { FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { StatusChip } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioCard, RadioGroup } from "@/components/ui/radio-group"
import { DEFAULT_FILES_ROOT, FILES_API, type FilesRootId, type SendJobDTO, type SendTargetDTO } from "@/lib/contracts/files"
import { checkRemotePath, DEFAULT_REMOTE_PATH, DEFAULT_SSH_PASSWORD, DEFAULT_SSH_USER } from "@/lib/files/remote-path"
import { sendStore } from "@/lib/files/send-store"
import { sendUi as t } from "@/lib/i18n/send"

/** A file of a root of Archivos (`root` defaults to tftp). */
export interface SendItem { path: string; name: string; root?: FilesRootId }

interface Form { username: string; password: string; destPath: string; remember: boolean }

function formFor(target: SendTargetDTO | undefined): Form {
  const p = target?.profile
  return {
    username: p?.username ?? DEFAULT_SSH_USER,
    // A remembered password is never sent to the browser: the field stays empty and "null" means "use it".
    password: p?.passwordSaved ? "" : DEFAULT_SSH_PASSWORD,
    destPath: p?.destPath ?? DEFAULT_REMOTE_PATH,
    remember: !!p,
  }
}

function routeLine(tg: SendTargetDTO): string {
  return tg.route.mode === "switch" ? t.viaSwitch(tg.route.switchPort, tg.route.link) : t.viaIp(tg.route.host, tg.route.port)
}

function ReservationChip({ tg }: { tg: SendTargetDTO }) {
  if (tg.reservation?.mine) return <StatusChip tone="ok" quiet>{t.reservedMine}</StatusChip>
  if (tg.reservation) return <StatusChip tone="warn" quiet>{t.reservedBy(tg.reservation.holderName)}</StatusChip>
  if (tg.policy === "always") return <StatusChip tone="brand" quiet>{t.always}</StatusChip>
  return <StatusChip tone="neutral" quiet>{t.free}</StatusChip>
}

/**
 * «Enviar a equipo…»: pick an equipment with an Ethernet access (its switch port and link, or IP:port, and its
 * reservation), the SSH user, password and destination (root / root / ~ unless remembered), and send. Progress goes to
 * the «Envíos» panel.
 */
export function SendDialog({ items, onClose }: { items: SendItem[] | null; onClose: () => void }) {
  const open = !!items?.length
  const [targets, setTargets] = React.useState<SendTargetDTO[] | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<string>("")
  const [form, setForm] = React.useState<Form>(() => formFor(undefined))
  const [errors, setErrors] = React.useState<{ username?: string; password?: string; destPath?: string; form?: string }>({})
  const [busy, setBusy] = React.useState(false)
  const [forItems, setForItems] = React.useState<SendItem[] | null>(null)

  const load = React.useCallback(async (keep?: string) => {
    try {
      const r = await fetch(FILES_API.sendTargets, { credentials: "same-origin", cache: "no-store" })
      const body = (await r.json()) as { targets?: SendTargetDTO[]; message?: string }
      if (!r.ok) throw new Error(body.message ?? t.loadError)
      const list = body.targets ?? []
      setTargets(list)
      setLoadError(null)
      const pick = (keep ? list.find((x) => x.equipmentId === keep) : undefined)
        ?? list.find((x) => x.allowed && x.reservation?.mine) ?? list.find((x) => x.allowed) ?? list[0]
      setSelected(pick?.equipmentId ?? "")
      setForm(formFor(pick))
      setErrors({})
    } catch (e) {
      setTargets([])
      setLoadError(e instanceof Error ? e.message : t.loadError)
    }
  }, [])

  if (items !== forItems) {
    setForItems(items)
    setTargets(null)
    setLoadError(null)
    setErrors({})
  }
  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  if (!items?.length) return null
  const target = targets?.find((x) => x.equipmentId === selected)
  const multi = items.length > 1
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!target || !items) return
    const next: typeof errors = {}
    if (!form.username.trim()) next.username = "Escribe el usuario."
    const dp = checkRemotePath(form.destPath)
    if (!dp.ok) next.destPath = dp.error
    setErrors(next)
    if (Object.keys(next).length) return
    setBusy(true)
    try {
      const saved = !!target.profile?.passwordSaved
      const r = await fetch(FILES_API.send, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: items[0]?.root ?? DEFAULT_FILES_ROOT, paths: items.map((i) => i.path), equipmentId: target.equipmentId, username: form.username.trim(),
          password: saved && form.password === "" ? null : form.password, destPath: form.destPath, remember: form.remember,
        }),
      })
      const body = (await r.json().catch(() => ({}))) as { jobs?: SendJobDTO[]; message?: string; field?: string }
      if (!r.ok) {
        const msg = body.message ?? "No se ha podido enviar."
        if (body.field === "username" || body.field === "password" || body.field === "destPath") setErrors({ [body.field]: msg })
        else setErrors({ form: msg })
        return
      }
      // The «Envíos» panel shows them at once (and follows them over SSE).
      for (const j of body.jobs ?? []) sendStore().apply(j)
      onClose()
    } catch {
      setErrors({ form: "No se ha podido enviar: sin conexión con el servidor." })
    } finally {
      setBusy(false)
    }
  }

  async function forget() {
    if (!target) return
    const r = await fetch(`${FILES_API.sendProfile}/${encodeURIComponent(target.equipmentId)}`, { method: "DELETE", credentials: "same-origin" })
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { message?: string }
      toast.error(body.message ?? "No se ha podido olvidar.")
      return
    }
    toast.success(t.forgotten(target.equipmentName))
    await load(target.equipmentId)
  }

  const passwordSaved = !!target?.profile?.passwordSaved
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent className="max-w-xl">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t.title(items.length, items[0].name)}</DialogTitle>
            <DialogDescription>{t.description}</DialogDescription>
          </DialogHeader>
          {multi ? (
            <ul className="max-h-24 overflow-y-auto rounded-md border px-3 py-2 font-mono text-data text-foreground">
              {items.map((i) => <li key={i.path} className="truncate">{i.name}</li>)}
            </ul>
          ) : null}

          {targets === null ? (
            <p className="flex items-center gap-2 text-body text-muted-foreground" role="status">
              <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />{t.equipmentLoading}
            </p>
          ) : loadError ? (
            <InlineAlert tone="danger" actions={<Button type="button" size="sm" variant="outline" onClick={() => void load()}>Reintentar</Button>}>{loadError}</InlineAlert>
          ) : targets.length === 0 ? (
            <InlineAlert tone="info" icon={ServerOffIcon} title={t.noEquipmentTitle}>{t.noEquipmentBody}</InlineAlert>
          ) : (
            <fieldset className="flex min-w-0 flex-col gap-1.5">
              <legend className="mb-1.5 text-body font-medium text-foreground">{t.equipment}</legend>
              <RadioGroup
                value={selected}
                onValueChange={(v) => {
                  setSelected(v)
                  setForm(formFor(targets.find((x) => x.equipmentId === v)))
                  setErrors({})
                }}
                className="max-h-64 overflow-y-auto"
              >
                {targets.map((tg) => (
                  <RadioCard key={tg.equipmentId} value={tg.equipmentId} aria-describedby={`send-eq-${tg.equipmentId}`} data-equipment={tg.equipmentName}>
                    <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 truncate text-body font-semibold text-foreground">{tg.equipmentName}</span>
                      <span className="flex-1" />
                      <ReservationChip tg={tg} />
                    </span>
                    <span id={`send-eq-${tg.equipmentId}`} className="flex min-w-0 flex-col gap-0.5 text-meta text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <NetworkIcon aria-hidden className="size-3.5 shrink-0" />
                        <span className="truncate">{routeLine(tg)}</span>
                      </span>
                      {tg.blockedReason ? <span className="text-foreground">{tg.blockedReason}</span> : null}
                    </span>
                  </RadioCard>
                ))}
              </RadioGroup>
            </fieldset>
          )}

          {target ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t.username} error={errors.username}>
                <Input value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" spellCheck={false} maxLength={32} />
              </FormField>
              <FormField label={t.password} error={errors.password} help={passwordSaved ? t.passwordSaved : undefined}>
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => set({ password: e.target.value })}
                  placeholder={passwordSaved ? t.passwordSavedPlaceholder : undefined}
                  autoComplete="new-password"
                  maxLength={256}
                />
              </FormField>
              <FormField label={t.destPath} error={errors.destPath} help={multi ? t.destHelpMulti : t.destHelp} className="sm:col-span-2">
                <Input value={form.destPath} onChange={(e) => set({ destPath: e.target.value })} className="font-mono" autoComplete="off" spellCheck={false} maxLength={1024} />
              </FormField>
              <div className="flex items-start gap-3 sm:col-span-2">
                <Checkbox id="send-remember" checked={form.remember} onCheckedChange={(v) => set({ remember: v === true })} className="mt-0.5" aria-describedby="send-remember-help" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Label htmlFor="send-remember" className="font-medium">{t.remember}</Label>
                  <p id="send-remember-help" className="text-meta text-muted-foreground">{form.remember ? t.rememberHelp : target.profile ? t.rememberOffHelp : t.rememberHelp}</p>
                </div>
                {target.profile ? <Button type="button" size="sm" variant="ghost" onClick={() => void forget()}>{t.forget}</Button> : null}
              </div>
              {target.hostKey ? (
                <p className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground sm:col-span-2">
                  <KeyRoundIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate font-mono" title={target.hostKey.fingerprint}>{t.hostKey(target.hostKey.fingerprint)}</span>
                </p>
              ) : null}
            </div>
          ) : null}

          {errors.form ? <InlineAlert tone="danger" role="alert">{errors.form}</InlineAlert> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{t.cancel}</Button>
            <Button type="submit" variant="primary" pending={busy} disabled={!target?.allowed}>
              <SendIcon aria-hidden />{t.send}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
