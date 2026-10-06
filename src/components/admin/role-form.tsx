"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { InfoIcon, LoaderCircleIcon, ShieldPlusIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { createRole, deleteRole, updateRole } from "@/actions/roles"
import { AppLink } from "@/components/common/app-link"
import { MultiSelect, type ComboOption } from "@/components/common/combobox"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { FormErrors, FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { SaveBar } from "@/components/common/save-bar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { Tag } from "@/components/ui/tag"
import { Textarea } from "@/components/ui/textarea"
import { useAction } from "@/hooks/use-action"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { RoleInputSchema, type RoleDTO } from "@/lib/contracts/users"
import { roles as t } from "@/lib/i18n/admin"
import {
  EMPTY_ROLE_DRAFT, equipmentOpenedByDelete, equipmentOpenedByEdit, reservationsLostByEdit, roleDirty, roleEffect, toRoleInput,
  type MemberWithRoles, type ReservedEquipment, type RoleDraft,
} from "./access-model"
import { SPANISH_PARSE, mergeFieldErrors, withoutField, zodFieldErrors, type FieldErrors } from "./field-errors"

export interface RoleMember extends MemberWithRoles { name: string; username: string; disabled: boolean }
export interface RoleEquipment extends ReservedEquipment { detail: string | null }

/** Equipment names as outline tags inside a warning (the names are the thing to check). */
function EquipmentTags({ items }: { items: readonly RoleEquipment[] }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1">
      {items.map((e) => <li key={e.id}><Tag tone="outline" className="text-foreground">{e.name}</Tag></li>)}
    </ul>
  )
}

/** Reservations a change would release: equipment tag plus who holds it. */
function ReservationList({ items }: { items: readonly RoleEquipment[] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {items.map((e) => (
        <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Tag tone="outline" className="text-foreground">{e.name}</Tag>
          {e.reservation ? <span className="text-meta text-muted-foreground">{t.reservedBy(e.reservation.holderName)}</span> : null}
        </li>
      ))}
    </ul>
  )
}

function draftFrom(r: RoleDTO): RoleDraft {
  return { name: r.name, description: r.description ?? "", userIds: r.users.map((u) => u.id), equipmentIds: r.equipments.map((e) => e.id) }
}

/**
 * Role editor (§8.9 Roles): name, description, members and equipment (MultiSelect with search), with the
 * explanation "Los roles limitan qué equipos ve cada usuario…". The right column shows the effect of the change,
 * including equipment that loses its "visible to everyone" state when it gets its first role.
 */
export function RoleForm({ role, users, equipment }: { role: RoleDTO | null; users: RoleMember[]; equipment: RoleEquipment[] }) {
  const router = useRouter()
  const initial = React.useMemo(() => (role ? draftFrom(role) : EMPTY_ROLE_DRAFT), [role])
  const [base, setBase] = React.useState<RoleDraft>(initial)
  const [draft, setDraft] = React.useState<RoleDraft>(initial)
  const [local, setLocal] = React.useState<FieldErrors>({})
  const [server, setServer] = React.useState<FieldErrors>({})
  const [done, setDone] = React.useState(false)
  const formRef = React.useRef<HTMLFormElement>(null)
  const create = useAction(createRole)
  const update = useAction(updateRole, { successMessage: t.saved })
  const remove = useAction(deleteRole)
  const pending = create.pending || update.pending

  const dirty = !done && roleDirty(base, draft)
  useUnsavedChanges(dirty)
  const errors = mergeFieldErrors(server, local)

  const set = <K extends keyof RoleDraft>(k: K, v: RoleDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }))
    setLocal((x) => withoutField(withoutField(x, k), "_form"))
    setServer((x) => withoutField(withoutField(x, k), "_form"))
  }

  const userOptions: ComboOption[] = users.map((u) => ({
    value: u.id, label: u.name, description: u.isAdmin ? `${u.username} · ${t.admins}` : u.username, keywords: [u.username],
  }))
  const equipmentOptions: ComboOption[] = equipment.map((e) => ({ value: e.id, label: e.name, description: e.detail ?? undefined }))
  const effect = roleEffect(equipment, role?.id ?? null, draft.equipmentIds, users, draft.userIds)
  // Saving the draft: equipment that loses its only role (open to everyone) and reservations that lose access.
  const openedByEdit = role ? equipmentOpenedByEdit(equipment, role.id, base.equipmentIds, draft.equipmentIds) : []
  const lostOnSave = dirty ? reservationsLostByEdit(equipment, users, role?.id ?? null, draft.userIds, draft.equipmentIds) : []
  // Deleting the saved role.
  const opened = role ? equipmentOpenedByDelete(equipment, role.id) : []
  const lostOnDelete = role ? reservationsLostByEdit(equipment, users, role.id, [], []) : []

  const focusFirstInvalid = () => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus())

  async function submit() {
    if (pending) return
    const input = toRoleInput(draft)
    const parsed = RoleInputSchema.safeParse(input, SPANISH_PARSE)
    if (!parsed.success) {
      setLocal(zodFieldErrors(parsed.error))
      focusFirstInvalid()
      return
    }
    if (!role) {
      const r = await create.run(input)
      if (!r.ok) {
        setServer(r.error.fieldErrors ?? {})
        focusFirstInvalid()
        return
      }
      setDone(true)
      toast.success(t.created(input.name))
      router.push("/roles")
      return
    }
    const r = await update.run({ ...input, roleId: role.id })
    if (!r.ok) {
      setServer(r.error.fieldErrors ?? {})
      focusFirstInvalid()
      return
    }
    setBase(draft)
    router.refresh()
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <form ref={formRef} onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate className="flex min-w-0 flex-col gap-5" aria-busy={pending || undefined}>
        <InlineAlert tone="info">{t.explanation}</InlineAlert>
        <Panel>
          <PanelHeader><PanelTitle>{t.sectionIdentity}</PanelTitle></PanelHeader>
          <PanelBody className="grid gap-4 md:grid-cols-2">
            <FormField label={t.name} name="name" errors={errors} help={t.nameHelp} required>
              <Input name="name" value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={40} autoComplete="off" />
            </FormField>
            <FormField label={t.description} optionalLabel={t.optional} name="description" errors={errors} className="md:col-span-2">
              <Textarea name="description" value={draft.description} onChange={(e) => set("description", e.target.value)} maxLength={200} rows={2} />
            </FormField>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader><PanelTitle>{t.sectionMembers}</PanelTitle></PanelHeader>
          <PanelBody className="gap-5">
            <FormField label={t.members} name="userIds" errors={errors} help={t.membersHelp}>
              {(p) => users.length
                ? <MultiSelect {...p} options={userOptions} value={draft.userIds} onChange={(v) => set("userIds", v)} placeholder={t.membersPlaceholder} />
                : <p id={p.id} className="text-body text-muted-foreground">{t.noUsersYet}</p>}
            </FormField>
            <FormField label={t.equipment} name="equipmentIds" errors={errors} help={t.equipmentHelp}>
              {(p) => equipment.length
                ? <MultiSelect {...p} options={equipmentOptions} value={draft.equipmentIds} onChange={(v) => set("equipmentIds", v)} placeholder={t.equipmentPlaceholder} />
                : <p id={p.id} className="text-body text-muted-foreground">{t.noEquipmentYet}</p>}
            </FormField>
          </PanelBody>
        </Panel>

        <FormErrors errors={errors} />
        {role ? (
          <SaveBar dirty={dirty} pending={pending} onDiscard={() => { setDraft(base); setLocal({}); setServer({}) }} />
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <Button asChild variant="ghost" size="lg"><AppLink href="/roles">{t.cancel}</AppLink></Button>
            <Button type="submit" variant="primary" size="lg" disabled={pending} aria-busy={pending || undefined}>
              {pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <ShieldPlusIcon aria-hidden />}
              {pending ? t.creating : t.create}
            </Button>
          </div>
        )}
      </form>

      <div className="flex min-w-0 flex-col gap-5 xl:sticky xl:top-5">
        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.effectTitle}</PanelTitle></PanelHeader>
          <PanelBody className="gap-3" aria-live="polite">
            <p className="text-body text-foreground">{t.effectMembers(draft.userIds.length, effect.restricted.length)}</p>
            {effect.newlyRestricted.length ? (
              <InlineAlert tone="warn">
                <p>{t.newlyRestricted(effect.newlyRestricted.length)}</p>
                <EquipmentTags items={effect.newlyRestricted} />
              </InlineAlert>
            ) : null}
            {openedByEdit.length ? (
              <InlineAlert tone="warn">
                <p>{t.openedByEdit(openedByEdit.length)}</p>
                <EquipmentTags items={openedByEdit} />
              </InlineAlert>
            ) : null}
            {lostOnSave.length ? (
              <InlineAlert tone="warn">
                <p>{t.reservationsLost(lostOnSave.length, "save")}</p>
                <ReservationList items={lostOnSave} />
              </InlineAlert>
            ) : null}
            {effect.adminMembers ? <p className="text-meta text-muted-foreground">{t.adminMembers(effect.adminMembers)}</p> : null}
            <p className="flex items-start gap-2 text-meta text-muted-foreground">
              <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-faint-foreground" />
              {t.effectAdmins}
            </p>
          </PanelBody>
        </Panel>

        {role ? (
          <Panel>
            <PanelHeader><PanelTitle as="h2">{t.actionsTitle}</PanelTitle></PanelHeader>
            <PanelBody>
              <ConfirmDialog
                trigger={<Button variant="danger-outline" className="justify-start"><Trash2Icon aria-hidden />{t.remove}</Button>}
                title={t.removeTitle(role.name)}
                description={t.removeBody(role.userCount)}
                confirmLabel={t.removeConfirm}
                onConfirm={async () => {
                  const r = await remove.run({ roleId: role.id })
                  if (!r.ok) return false
                  setDone(true)
                  toast.success(t.removed)
                  router.push("/roles")
                }}
              >
                {opened.length ? (
                  <InlineAlert tone="warn">
                    {/* Same rendering as the Efecto panel: the same fact looks the same in both places. */}
                    <p>{t.becomeOpen(opened.length)}</p>
                    <EquipmentTags items={opened} />
                  </InlineAlert>
                ) : null}
                {lostOnDelete.length ? (
                  <InlineAlert tone="warn">
                    <p>{t.reservationsLost(lostOnDelete.length, "delete")}</p>
                    <ReservationList items={lostOnDelete} />
                  </InlineAlert>
                ) : null}
              </ConfirmDialog>
            </PanelBody>
          </Panel>
        ) : null}
      </div>
    </div>
  )
}
