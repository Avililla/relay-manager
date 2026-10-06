"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { BanIcon, KeyRoundIcon, LoaderCircleIcon, LockIcon, Trash2Icon, UserCheckIcon } from "lucide-react"
import { toast } from "sonner"
import { deleteUser, resetUserPassword, setUserDisabled } from "@/actions/users"
import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { FormErrors } from "@/components/common/form-field"
import { RelativeTime } from "@/components/common/relative-time"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { useAction } from "@/hooks/use-action"
import { ResetUserPasswordInputSchema, type UserDTO } from "@/lib/contracts/users"
import { users as t } from "@/lib/i18n/admin"
import { SPANISH_PARSE, mergeFieldErrors, zodFieldErrors, type FieldErrors } from "./field-errors"
import { NewPasswordField } from "./new-password-field"
import { ToggleField } from "./toggle-field"
import { UserStatusChip } from "./users-table"
import { userProtections } from "./user-model"

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-body text-foreground tabular-nums">{children}</dd>
    </div>
  )
}

function ResetPasswordDialog({ user, open, onOpenChange }: { user: UserDTO; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter()
  const [password, setPassword] = React.useState("")
  const [mustChange, setMustChange] = React.useState(true)
  const [local, setLocal] = React.useState<FieldErrors>({})
  const [server, setServer] = React.useState<FieldErrors>({})
  const [attempted, setAttempted] = React.useState(false)
  const action = useAction(resetUserPassword, { successMessage: t.resetDone })
  const errors = mergeFieldErrors(server, local)
  const formRef = React.useRef<HTMLFormElement>(null)
  // After a failed submit, focus goes to the invalid field (same as the user form).
  const focusFirstInvalid = () => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus())

  const reset = () => {
    setPassword("")
    setMustChange(true)
    setLocal({})
    setServer({})
    setAttempted(false)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setAttempted(true)
    const input = { userId: user.id, password, mustChangePassword: mustChange }
    const parsed = ResetUserPasswordInputSchema.safeParse(input, SPANISH_PARSE)
    if (!parsed.success) {
      setLocal(zodFieldErrors(parsed.error))
      focusFirstInvalid()
      return
    }
    const r = await action.run(input)
    if (!r.ok) {
      setServer(r.error.fieldErrors ?? {})
      if (r.error.fieldErrors) focusFirstInvalid()
      return
    }
    reset()
    onOpenChange(false)
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!action.pending) { if (!o) reset(); onOpenChange(o) } }}>
      <DialogContent className="sm:max-w-lg">
        <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t.resetTitle(user.name)}</DialogTitle>
            <DialogDescription>{t.resetBody}</DialogDescription>
          </DialogHeader>
          <NewPasswordField
            label={t.newPassword}
            name="password"
            value={password}
            onChange={(v) => { setPassword(v); setLocal({}); setServer({}) }}
            username={user.username}
            errors={errors}
            showErrors={attempted}
            allowGenerate
          />
          <ToggleField kind="checkbox" label={t.mustChange} description={t.mustChangeHelp} checked={mustChange} onCheckedChange={setMustChange} />
          <FormErrors errors={errors} />
          <DialogFooter>
            <Button variant="ghost" size="lg" onClick={() => onOpenChange(false)} disabled={action.pending}>{t.cancel}</Button>
            <Button type="submit" variant="primary" size="lg" pending={action.pending}>
              {action.pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <KeyRoundIcon aria-hidden />}
              {t.resetSubmit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Right column of a user's page: account state and the account actions (§8.9): "Restablecer contraseña…",
 * "Desactivar/Activar", "Eliminar". Disable and delete are blocked, with the reason shown, for yourself and for the
 * last enabled admin (UserDTO.isLastEnabledAdmin).
 */
export function UserAccountPanel({ user, viewerId }: { user: UserDTO; viewerId: string }) {
  const router = useRouter()
  const [resetOpen, setResetOpen] = React.useState(false)
  const p = userProtections(user, viewerId)
  const disable = useAction(setUserDisabled)
  const remove = useAction(deleteUser)

  return (
    <>
      <Panel>
        <PanelHeader><PanelTitle as="h2">{t.factsTitle}</PanelTitle></PanelHeader>
        <PanelBody className="gap-2">
          <dl className="flex flex-col divide-y divide-border">
            <Fact label={t.statusLabel}><UserStatusChip user={user} /></Fact>
            <Fact label={t.createdAt}>
              <RelativeTime value={user.createdAt} />
            </Fact>
            <Fact label={t.lastLogin}>{user.lastLoginAt ? <RelativeTime value={user.lastLoginAt} /> : <span className="text-faint-foreground">{t.never}</span>}</Fact>
            <Fact label={t.activeReservations}>{user.activeReservations}</Fact>
          </dl>
          {user.disabled ? <p className="text-meta text-muted-foreground">{t.disabledNote}</p>
            : user.mustChangePassword ? <p className="text-meta text-muted-foreground">{t.mustChangeNote}</p> : null}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader><PanelTitle as="h2">{t.actionsTitle}</PanelTitle></PanelHeader>
        <PanelBody className="gap-3">
          <Button variant="default" className="justify-start" onClick={() => setResetOpen(true)}>
            <KeyRoundIcon aria-hidden />{t.resetPassword}
          </Button>
          {user.disabled ? (
            <Button
              variant="default"
              className="justify-start"
              disabled={disable.pending}
              onClick={async () => {
                const r = await disable.run({ userId: user.id, disabled: false })
                if (r.ok) { toast.success(t.enabled); router.refresh() }
              }}
            >
              <UserCheckIcon aria-hidden />{t.enable}
            </Button>
          ) : (
            <ConfirmDialog
              trigger={<Button variant="danger-outline" className="justify-start" disabled={!p.canDisable}><BanIcon aria-hidden />{t.disable}</Button>}
              title={t.disableTitle(user.name)}
              description={t.disableBody(user.activeReservations)}
              confirmLabel={t.disableConfirm}
              onConfirm={async () => {
                const r = await disable.run({ userId: user.id, disabled: true })
                if (!r.ok) return false
                toast.success(t.disabled)
                router.refresh()
              }}
            />
          )}
          <ConfirmDialog
            trigger={<Button variant="danger-outline" className="justify-start" disabled={!p.canDelete}><Trash2Icon aria-hidden />{t.remove}</Button>}
            title={t.removeTitle(user.name)}
            description={t.removeBody}
            typeToConfirm={user.username}
            confirmLabel={t.removeConfirm}
            onConfirm={async () => {
              const r = await remove.run({ userId: user.id })
              if (!r.ok) return false
              toast.success(t.removed)
              router.push("/usuarios")
            }}
          />
          {p.blockedReason ? (
            <p className="flex items-start gap-2 text-meta text-muted-foreground">
              <LockIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-faint-foreground" />
              {p.blockedReason}
            </p>
          ) : null}
        </PanelBody>
      </Panel>
      <ResetPasswordDialog user={user} open={resetOpen} onOpenChange={setResetOpen} />
    </>
  )
}
