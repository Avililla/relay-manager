"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ToggleLeftIcon, Trash2Icon } from "lucide-react"
import { deleteEquipment, updateEquipment } from "@/actions/equipment"
import { AppLink } from "@/components/common/app-link"
import { MultiSelect } from "@/components/common/combobox"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { FormErrors, FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { Page, Section } from "@/components/common/page"
import { SaveBar } from "@/components/common/save-bar"
import { BoardChannelPicker } from "@/components/forms/board-channel-picker"
import { ConsoleSlotsEditor } from "@/components/forms/console-slots-editor"
import { RelaySlotsEditor } from "@/components/forms/relay-slots-editor"
import { useServerEvents } from "@/components/providers/events-provider"
import { PageMeta } from "@/components/shell/page-meta"
import { useViewer } from "@/components/shell/shell-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { dataSelector } from "@/components/wizard/focus-return"
import { PortChoiceDialog } from "@/components/wizard/port-choice-dialog"
import { useLiveSerial } from "@/components/wizard/use-live-serial"
import { useRefreshOn } from "@/components/wizard/use-refresh-on"
import { useAction } from "@/hooks/use-action"
import { useLiveState } from "@/hooks/use-live-state"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import type { EquipmentEditDTO } from "@/lib/contracts/equipment"
import type { ServerEvent, ServerEventType } from "@/lib/contracts/events"
import type { ReservationDTO } from "@/lib/contracts/reservations"
import type { ConsoleRuntimeDTO } from "@/lib/contracts/serial"
import { nav } from "@/lib/i18n/shell"
import { settingsText as t, wizardText } from "@/lib/i18n/wizard"
import { clientId } from "@/lib/client/ids"
import { cn } from "@/lib/client/cn"
import { newConsoleDraft, newRelayDraft } from "@/lib/wizard/draft"
import { hasErrors, mergeErrors } from "@/lib/wizard/field-errors"
import { draftPortHolder, isFreePort } from "@/lib/wizard/ports"
import {
  assignSettingsPort, buildUpdateInput, configSignature, isSettingsDirty, settingsDraftFrom, settingsPortHolder, takenSettingsChannels, validateSettings,
  type SettingsBinding, type SettingsConsoleRow, type SettingsDraft, type SettingsRelayRow,
} from "@/lib/wizard/settings"
import { ConsoleBindingCell } from "./console-binding-cell"
import { AccessesEditor } from "@/components/accesses/accesses-editor"
import { followConsoleRenames } from "@/lib/accesses/draft"
import { accessUi } from "@/lib/i18n/accesses"

const RUNTIME_EVENTS: readonly ServerEventType[] = ["console.status"]
const RESERVATION_EVENTS: readonly ServerEventType[] = ["reservation.changed"]
const EQUIPMENT_EVENTS: readonly ServerEventType[] = ["equipment.changed"]
/**
 * Row ids for a draft built from saved data. Deterministic, so the server render and the hydrated client agree on
 * every attribute derived from them (e.g. `data-binding-choose`, the port dialog's focus fallback). Rows added in
 * the page get `clientId("row")`, which never looks like these.
 */
function savedRowIds(): () => string {
  let n = 0
  return () => `saved-${n++}`
}

const SECTIONS = [
  { id: "identidad", label: t.identity },
  { id: "acceso", label: t.access },
  { id: "consolas", label: t.consoles },
  { id: "reles", label: t.relays },
  { id: "accesos", label: t.accesses },
  { id: "peligro", label: t.danger },
] as const

/**
 * Equipo "Ajustes" (§8.9, W2-B, admin): Identidad, Acceso, Consolas (with the binding cell and the PortPicker
 * dialog), Relés (board channel per row) and Zona peligrosa, with one sticky "Guardar cambios".
 */
export function EquipmentSettingsForm({ data }: { data: EquipmentEditDTO }) {
  const router = useRouter()
  const viewer = useViewer()
  const signature = configSignature(data)
  const [base, setBase] = React.useState(() => ({ sig: signature, draft: settingsDraftFrom(data, savedRowIds()) }))
  const [draft, setDraft] = React.useState<SettingsDraft>(base.draft)
  const [conflict, setConflict] = React.useState(false)
  const [deleted, setDeleted] = React.useState(false)
  const [leaving, setLeaving] = React.useState(false)
  const [showErrors, setShowErrors] = React.useState(false)
  const [dialogFor, setDialogFor] = React.useState<string | null>(null)
  /** The row the port dialog was last opened for: still known while it closes, for its focus fallback. */
  const [lastDialogFor, setLastDialogFor] = React.useState<string | null>(null)
  const [showJtag, setShowJtag] = React.useState(!data.hideJtag)
  const [moved, setMoved] = React.useState<string | null>(null)

  const dirty = !leaving && !deleted && isSettingsDirty(draft, base.draft)

  // Adopt a newer saved configuration when clean (after our save + refresh, or another admin's change).
  if (signature !== base.sig) {
    if (!dirty) {
      const fresh = settingsDraftFrom(data, savedRowIds())
      setBase({ sig: signature, draft: fresh })
      setDraft(fresh)
      if (conflict) setConflict(false)
    } else if (!conflict) {
      setConflict(true)
    }
  }

  useUnsavedChanges(dirty)
  const { snapshot } = useLiveSerial(data.serial)
  const initialRuntimes = React.useMemo(() => Object.fromEntries(data.consoles.map((c) => [c.id, c.runtime])), [data])
  const runtimes = useLiveState<Record<string, ConsoleRuntimeDTO>>(initialRuntimes, RUNTIME_EVENTS, (s, e: ServerEvent) =>
    e.type === "console.status" && e.equipmentId === data.id ? { ...s, [e.consoleId]: e.runtime } : s)
  const reservation = useLiveState<ReservationDTO | null>(data.reservation, RESERVATION_EVENTS, (s, e: ServerEvent) =>
    e.type === "reservation.changed" && e.equipmentId === data.id ? e.reservation : s)
  useServerEvents(EQUIPMENT_EVENTS, (e) => {
    if (e.type === "equipment.changed" && e.equipmentId === data.id && e.change === "deleted" && !leaving) setDeleted(true)
  })
  // Any saved equipment can take or free ports and board channels: re-read them (the draft is kept).
  useRefreshOn(EQUIPMENT_EVENTS, (e) => e.type === "equipment.changed" && !leaving && !(e.equipmentId === data.id && e.change === "deleted"))

  const save = useAction(updateEquipment)
  const remove = useAction(deleteEquipment)
  const saved = React.useMemo(() => new Map(data.consoles.map((c) => [c.id, c.binding?.bindingKey ?? null])), [data])
  const originals = React.useMemo(() => new Map(data.consoles.map((c) => [c.id, c])), [data])

  const otherHolder = reservation && reservation.holderId !== viewer.id ? reservation : null
  const text = { relayTargetRequired: t.relayTargetRequired }
  const clientErrors = showErrors ? validateSettings(draft, data.id, text) : {}
  const errors = mergeErrors(clientErrors, save.fieldErrors)
  const set = (patch: Partial<SettingsDraft>) => setDraft((d) => ({ ...d, ...patch }))

  const setBinding = (uid: string, binding: SettingsBinding) => {
    const r = assignSettingsPort(draft, uid, binding, saved)
    setDraft(r.draft)
    setMoved(r.displaced.length ? r.displaced.map((k) => t.portMovedFrom(k)).join(" ") : null)
  }

  const onSave = async () => {
    setShowErrors(true)
    if (hasErrors(validateSettings(draft, data.id, text))) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus())
      return
    }
    setDialogFor(null)
    const r = await save.run(buildUpdateInput(draft, data.id))
    if (r.ok) {
      toast.success(t.saved)
      setShowErrors(false)
      setMoved(null)
      setBase((b) => ({ ...b, draft }))
      router.refresh()
    }
  }

  const discard = () => {
    const fresh = settingsDraftFrom(data, savedRowIds())
    setBase({ sig: signature, draft: fresh })
    setDraft(fresh)
    setShowErrors(false)
    setConflict(false)
    setMoved(null)
  }

  const dialogRow = draft.consoles.find((c) => c.uid === dialogFor) ?? null
  const dialogInitial = (() => {
    if (!dialogRow) return { stableKey: null, matchBy: null }
    if (dialogRow.binding === "keep") {
      const b = dialogRow.id ? originals.get(dialogRow.id)?.binding : null
      return { stableKey: b?.bindingKey ?? null, matchBy: b?.matchBy ?? null }
    }
    return dialogRow.binding ? { stableKey: dialogRow.binding.stableKey, matchBy: dialogRow.binding.matchBy } : { stableKey: null, matchBy: null }
  })()

  if (deleted) {
    return (
      <Page>
        <InlineAlert tone="warn" actions={<Button asChild size="sm"><AppLink href="/">{t.backToBanco}</AppLink></Button>}>{t.deletedElsewhere}</InlineAlert>
      </Page>
    )
  }

  const relaysCount = draft.relays.length

  return (
    <Page className="pb-0">
      <PageMeta breadcrumbs={[{ label: nav.banco, href: "/" }, { label: data.name, href: `/equipos/${data.id}` }, { label: t.breadcrumb }]} />
      <div className="grid min-w-0 gap-8 xl:grid-cols-[11rem_minmax(0,1fr)]">
        <nav aria-label={t.sectionsLabel} className="hidden xl:block">
          <ul className="sticky top-4 flex flex-col gap-0.5 border-l">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className={cn("-ml-px block border-l border-transparent py-1 pl-3 text-body text-muted-foreground hover:border-control-border hover:text-foreground", s.id === "peligro" && "text-danger hover:text-danger")}>
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 max-w-5xl flex-col gap-10 pb-8">
          {conflict ? (
            <InlineAlert tone="warn" role="status" actions={<Button size="sm" onClick={discard}>{t.reloadDiscard}</Button>}>{t.changedElsewhere}</InlineAlert>
          ) : null}
          {otherHolder ? <InlineAlert tone="warn">{t.reservedByOther(otherHolder.holderName)}</InlineAlert> : null}

          <Section id="identidad" title={t.identity} description={data.templateName ? t.fromTemplate(data.templateName) : t.noTemplate}>
            <div className="grid gap-5 md:grid-cols-2">
              <FormField label={t.name} name="name" errors={errors} required>
                <Input value={draft.name} maxLength={60} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
              </FormField>
              <FormField label={t.serialNumber} optionalLabel={t.optional} name="serialNumber" errors={errors}>
                <Input value={draft.serialNumber} maxLength={60} autoComplete="off" spellCheck={false} className="font-mono text-data" onChange={(e) => set({ serialNumber: e.target.value })} />
              </FormField>
              <FormField label={t.description} optionalLabel={t.optional} name="description" errors={errors} className="md:col-span-2">
                <Textarea value={draft.description} maxLength={500} rows={2} onChange={(e) => set({ description: e.target.value })} />
              </FormField>
            </div>
          </Section>

          <Section id="acceso" title={t.access}>
            <FormField label={t.roles} name="roleIds" errors={errors} help={data.roles.length ? t.rolesHelp : t.noRoles} className="max-w-2xl">
              {(p) => (
                <MultiSelect
                  {...p}
                  options={data.roles.map((r) => ({ value: r.id, label: r.name }))}
                  value={draft.roleIds}
                  onChange={(roleIds) => set({ roleIds })}
                  disabled={!data.roles.length}
                />
              )}
            </FormField>
          </Section>

          <Section id="consolas" title={t.consoles} description={t.consolesHelp}>
            {moved ? <InlineAlert tone="info" role="status">{moved}</InlineAlert> : null}
            <ConsoleSlotsEditor<SettingsConsoleRow>
              value={draft.consoles}
              onChange={(consoles) => set({ consoles, accesses: followConsoleRenames(draft.accesses, draft.consoles, consoles) })}
              mode="equipment"
              errors={errors}
              createRow={(index, taken) => ({ ...newConsoleDraft(taken, index, clientId("row")), binding: null })}
              renderRowAside={(row) => (
                <ConsoleBindingCell
                  row={row}
                  original={row.id ? originals.get(row.id) ?? null : null}
                  runtime={row.id ? runtimes[row.id] ?? null : null}
                  snapshot={snapshot}
                  onChange={(b) => setBinding(row.uid, b)}
                  onChoose={() => {
                    setDialogFor(row.uid)
                    setLastDialogFor(row.uid)
                  }}
                />
              )}
            />
          </Section>

          <Section id="reles" title={t.relays} description={relaysCount || data.boards.length ? t.relaysHelp : undefined}>
            {!relaysCount && !data.boards.length ? (
              <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-input px-4 py-4">
                <p className="flex items-start gap-2 text-body text-muted-foreground"><ToggleLeftIcon aria-hidden className="mt-0.5 size-4 shrink-0" />{t.noRelaysNoBoards}</p>
                <Button asChild size="sm"><AppLink href="/descubrimiento?tab=reles">{t.goDiscovery}</AppLink></Button>
              </div>
            ) : (
              <RelaySlotsEditor<SettingsRelayRow>
                value={draft.relays}
                onChange={(relays) => set({ relays })}
                mode="equipment"
                errors={errors}
                createRow={(index, taken) => ({ ...newRelayDraft(taken, index, clientId("row")), target: null })}
                renderRowAside={(row, i) => (
                  <BoardChannelPicker
                    boards={data.boards}
                    value={row.target}
                    onChange={(target) => set({ relays: draft.relays.map((r) => (r.uid === row.uid ? { ...r, target } : r)) })}
                    taken={takenSettingsChannels(draft, row.uid)}
                    invalid={!!errors[`relays.${i}.channel`] || !!errors[`relays.${i}.boardId`]}
                    labelPrefix={`${row.key ?? row.label}: `}
                  />
                )}
              />
            )}
          </Section>

          <Section id="accesos" title={t.accesses} description={accessUi.editorHelp(data.accessContext.settings.range.from, data.accessContext.settings.range.to)}>
            <AccessesEditor
              value={draft.accesses}
              onChange={(accesses) => set({ accesses })}
              mode="equipment"
              errors={errors}
              consoleKeys={draft.consoles.map((c) => c.key)}
              ctx={data.accessContext}
              serial={snapshot}
              equipmentId={data.id}
            />
          </Section>

          <Section id="peligro" title={t.danger}>
            <div className="flex flex-col gap-3 rounded-lg border border-danger/40 px-4 py-4 md:flex-row md:items-center">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <h3 className="text-body font-medium text-foreground">{t.deleteTitle}</h3>
                <p className="text-meta text-muted-foreground">{otherHolder ? t.deleteBlockedHint(otherHolder.holderName) : t.deleteBody(data.consoles.length, data.relays.length)}</p>
              </div>
              {otherHolder ? (
                <div className="flex flex-col items-start gap-1 md:items-end">
                  <Button variant="danger-outline" disabled aria-describedby="delete-blocked"><Trash2Icon aria-hidden />{t.deleteButton}</Button>
                  <span id="delete-blocked" className="text-meta text-muted-foreground">{t.deleteBlocked}</span>
                </div>
              ) : (
                <ConfirmDialog
                  trigger={<Button variant="danger-outline"><Trash2Icon aria-hidden />{t.deleteButton}</Button>}
                  title={t.deleteDialogTitle(data.name)}
                  description={t.deleteDialogBody(data.consoles.length, data.relays.length)}
                  typeToConfirm={data.name}
                  confirmLabel={t.deleteConfirm}
                  onConfirm={async () => {
                    setLeaving(true)
                    const r = await remove.run({ equipmentId: data.id, confirmName: data.name })
                    if (!r.ok) {
                      setLeaving(false)
                      return false
                    }
                    // No toast here: the workspace layout around Ajustes (W2-A) announces the deletion from the
                    // equipment.changed event and navigates too; a second toast would repeat it.
                    router.push("/")
                  }}
                />
              )}
            </div>
          </Section>

          <FormErrors errors={errors} />
        </div>
      </div>

      <SaveBar dirty={dirty} pending={save.pending} onSave={() => void onSave()} onDiscard={discard} saveLabel={t.save} className="-mx-4 px-4 md:-mx-6 md:px-6" />

      <PortChoiceDialog
        open={!!dialogRow}
        onOpenChange={(o) => { if (!o) setDialogFor(null) }}
        title={wizardText.portDialogTitle(dialogRow?.key ?? "")}
        snapshot={snapshot}
        hints={data.serialHints}
        initial={dialogInitial}
        selectable={(p) => isFreePort(p) || p.assignment?.equipmentId === data.id}
        // The list follows the draft: a port another row takes on saving reads "Asignado a este equipo · KEY", and
        // one of this equipment's ports that no row keeps any more reads "Libre".
        holderOf={(p) => draftPortHolder(p, settingsPortHolder(draft, p.stableKey, "", saved), data.id)}
        showJtag={showJtag}
        onShowJtagChange={setShowJtag}
        baudRate={dialogRow?.line.baudRate ?? 115200}
        onConfirm={(c) => {
          if (!dialogRow) return
          const savedKey = dialogRow.id ? saved.get(dialogRow.id) : null
          const savedMatch = dialogRow.id ? originals.get(dialogRow.id)?.binding?.matchBy : null
          setBinding(dialogRow.uid, savedKey === c.stableKey && savedMatch === c.matchBy ? "keep" : { stableKey: c.stableKey, matchBy: c.matchBy })
        }}
        returnFocus={lastDialogFor ? [dataSelector("data-binding-choose", lastDialogFor)] : []}
      />
    </Page>
  )
}
