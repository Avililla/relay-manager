"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { LoaderCircleIcon, UserPlusIcon } from "lucide-react"
import { toast } from "sonner"
import { createUser, updateUser } from "@/actions/users"
import { AppLink } from "@/components/common/app-link"
import { MultiSelect, type ComboOption } from "@/components/common/combobox"
import { FormErrors, FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { SaveBar } from "@/components/common/save-bar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { useAction } from "@/hooks/use-action"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { CreateUserInputSchema, UpdateUserInputSchema, type RoleDTO, type UserDTO } from "@/lib/contracts/users"
import { users as t } from "@/lib/i18n/admin"
import { reservationsLostByUserEdit, type ReservedEquipment } from "./access-model"
import { SPANISH_PARSE, mergeFieldErrors, withoutField, zodFieldErrors, type FieldErrors } from "./field-errors"
import { NewPasswordField } from "./new-password-field"
import { ToggleField } from "./toggle-field"
import {
  EMPTY_USER_DRAFT, toCreateUserInput, toUpdateUserInput, userCreateDirty, userDraftFrom, userEditDirty, userProtections, type UserDraft,
} from "./user-model"
import { UserVisibilityPanel } from "./user-visibility"

type Props =
  | { mode: "create"; roles: RoleDTO[]; equipment: ReservedEquipment[]; viewerId: string; user?: undefined; aside?: undefined }
  | { mode: "edit"; roles: RoleDTO[]; equipment: ReservedEquipment[]; viewerId: string; user: UserDTO; aside?: React.ReactNode }

/**
 * New user and user detail/edit (§8.9 Usuarios). Two columns from 1280 px: the form on the left, what this user
 * will see on the right (live from the admin flag and roles). Edit uses the sticky SaveBar with a dirty
 * indicator and the unsaved-changes guard; create ends with "Crear usuario".
 */
export function UserForm(props: Props) {
  const { mode, roles, equipment, viewerId } = props
  const router = useRouter()
  const initial = React.useMemo(() => (props.mode === "edit" ? userDraftFrom(props.user) : EMPTY_USER_DRAFT), [props.mode, props.user])
  const [base, setBase] = React.useState<UserDraft>(initial)
  const [draft, setDraft] = React.useState<UserDraft>(initial)
  const [local, setLocal] = React.useState<FieldErrors>({})
  const [server, setServer] = React.useState<FieldErrors>({})
  const [attempted, setAttempted] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const formRef = React.useRef<HTMLFormElement>(null)

  const create = useAction(createUser)
  const update = useAction(updateUser, { successMessage: t.saved })
  const pending = create.pending || update.pending

  const dirty = !done && (mode === "create" ? userCreateDirty(draft) : userEditDirty(base, draft))
  useUnsavedChanges(dirty)

  const protections = props.mode === "edit" ? userProtections(props.user, viewerId) : null
  const lockedAdmin = protections !== null && !protections.canDemote && base.isAdmin
  const isSelf = props.mode === "edit" && props.user.id === viewerId
  // Unsaved role or admin changes that take away equipment this user has reserved (released on save, access-lost).
  const lostReservations = props.mode === "edit" && dirty ? reservationsLostByUserEdit(equipment, props.user.id, draft) : []

  const errors = mergeFieldErrors(server, local)
  const set = <K extends keyof UserDraft>(k: K, v: UserDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }))
    setLocal((x) => withoutField(withoutField(x, k), "_form"))
    setServer((x) => withoutField(withoutField(x, k), "_form"))
  }

  const roleOptions: ComboOption[] = roles.map((r) => ({
    value: r.id, label: r.name, description: t.roleEquipment(r.equipmentCount), keywords: r.description ? [r.description] : undefined,
  }))

  const focusFirstInvalid = () => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus())

  async function submit() {
    if (pending) return
    setAttempted(true)
    if (props.mode === "create") {
      const input = toCreateUserInput(draft)
      const parsed = CreateUserInputSchema.safeParse(input, SPANISH_PARSE)
      if (!parsed.success) {
        setLocal(zodFieldErrors(parsed.error))
        focusFirstInvalid()
        return
      }
      const r = await create.run(input)
      if (!r.ok) {
        setServer(r.error.fieldErrors ?? {})
        focusFirstInvalid()
        return
      }
      setDone(true)
      toast.success(t.created(input.name))
      router.push("/usuarios")
      return
    }
    const input = toUpdateUserInput(props.user.id, draft)
    const parsed = UpdateUserInputSchema.safeParse(input, SPANISH_PARSE)
    if (!parsed.success) {
      setLocal(zodFieldErrors(parsed.error))
      focusFirstInvalid()
      return
    }
    const r = await update.run(input)
    if (!r.ok) {
      setServer(r.error.fieldErrors ?? {})
      focusFirstInvalid()
      return
    }
    setBase(draft)
    if (isSelf && !draft.isAdmin) {
      // Self-demotion: this page is admin-only now.
      window.location.assign("/")
      return
    }
    router.refresh()
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void submit()
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <form ref={formRef} onSubmit={onSubmit} noValidate className="flex min-w-0 flex-col gap-5" aria-busy={pending || undefined}>
        <Panel>
          <PanelHeader><PanelTitle>{t.sectionAccount}</PanelTitle></PanelHeader>
          <PanelBody className="grid gap-4 md:grid-cols-2">
            <FormField label={t.username} name="username" errors={errors} help={mode === "edit" ? t.usernameFixed : errors.username?.length ? undefined : t.usernameHelp} required={mode === "create"}>
              <Input
                name="username"
                value={draft.username}
                onChange={(e) => set("username", e.target.value)}
                readOnly={mode === "edit"}
                autoFocus={mode === "create"}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono text-data"
              />
            </FormField>
            <FormField label={t.name} name="name" errors={errors} required>
              <Input name="name" value={draft.name} onChange={(e) => set("name", e.target.value)} autoComplete="off" maxLength={60} />
            </FormField>
            <FormField label={t.email} optionalLabel={t.optional} name="email" errors={errors} help={t.emailHelp} className="md:col-span-2 md:max-w-[calc(50%-0.5rem)]">
              <Input name="email" type="email" inputMode="email" value={draft.email} onChange={(e) => set("email", e.target.value)} autoComplete="off" spellCheck={false} />
            </FormField>
          </PanelBody>
        </Panel>

        {mode === "create" ? (
          <Panel>
            <PanelHeader><PanelTitle>{t.sectionPassword}</PanelTitle></PanelHeader>
            <PanelBody className="gap-4">
              <div className="md:max-w-[calc(50%+6rem)]">
                <NewPasswordField
                  label={t.password}
                  name="password"
                  value={draft.password}
                  onChange={(v) => set("password", v)}
                  username={draft.username}
                  errors={errors}
                  showErrors={attempted}
                  allowGenerate
                />
              </div>
              <ToggleField
                kind="checkbox"
                label={t.mustChange}
                description={t.mustChangeHelp}
                checked={draft.mustChangePassword}
                onCheckedChange={(v) => set("mustChangePassword", v)}
              />
            </PanelBody>
          </Panel>
        ) : null}

        <Panel>
          <PanelHeader><PanelTitle>{t.sectionAccess}</PanelTitle></PanelHeader>
          <PanelBody className="gap-5">
            <ToggleField
              label={t.isAdmin}
              description={t.isAdminHelp}
              checked={draft.isAdmin}
              onCheckedChange={(v) => set("isAdmin", v)}
              disabled={lockedAdmin}
              note={lockedAdmin ? t.lastAdminDemote : isSelf && base.isAdmin && !draft.isAdmin ? <InlineAlert tone="warn">{t.selfDemote}</InlineAlert> : null}
            />
            <FormField
              label={t.roles}
              name="roleIds"
              errors={errors}
              help={draft.isAdmin ? t.rolesAdminHelp : t.rolesHelp}
              className="md:max-w-[calc(50%+6rem)]"
            >
              {(p) => roles.length ? (
                <MultiSelect {...p} options={roleOptions} value={draft.roleIds} onChange={(v) => set("roleIds", v)} placeholder={t.rolesPlaceholder} />
              ) : (
                <p id={p.id} className="flex flex-wrap items-center gap-x-2 text-body text-muted-foreground">
                  {t.noRolesYet}
                  <AppLink href="/roles/nuevo" className="text-brand underline-offset-4 hover:underline">{t.createRole}</AppLink>
                </p>
              )}
            </FormField>
          </PanelBody>
        </Panel>

        <FormErrors errors={errors} />
        {mode === "create" ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <Button asChild variant="ghost" size="lg"><AppLink href="/usuarios">{t.cancel}</AppLink></Button>
            <Button type="submit" variant="primary" size="lg" disabled={pending} aria-busy={pending || undefined}>
              {pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <UserPlusIcon aria-hidden />}
              {pending ? t.creating : t.create}
            </Button>
          </div>
        ) : (
          <SaveBar
            dirty={dirty}
            pending={pending}
            onDiscard={() => { setDraft(base); setLocal({}); setServer({}) }}
          />
        )}
      </form>

      <div className="flex min-w-0 flex-col gap-5 xl:sticky xl:top-5">
        <UserVisibilityPanel equipment={equipment} isAdmin={draft.isAdmin} roleIds={draft.roleIds} lostReservations={lostReservations} />
        {props.aside}
      </div>
    </div>
  )
}
