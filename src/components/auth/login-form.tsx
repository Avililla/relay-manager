"use client"

import * as React from "react"
import { LoaderCircleIcon, LogInIcon } from "lucide-react"
import { signIn } from "next-auth/react"
import { FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel, PanelBody } from "@/components/ui/panel"
import { auth as t } from "@/lib/i18n/admin"
import { safeNextPath } from "@/lib/safe-next"
import { loginErrorKind, type LoginErrorKind } from "./login-result"
import { PasswordInput } from "./password-input"
import { takePasswordChanged } from "./password-changed-flag"

/**
 * Login (§8.9): "Usuario" + "Contraseña" + "Entrar". Errors are inline (`role="alert"`) and never say whether
 * the username exists. `next` has already gone through safeNextPath on the server; it is re-checked here.
 */
export function LoginForm({ next }: { next: string }) {
  const [username, setUsername] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<LoginErrorKind | null>(null)
  const [pending, setPending] = React.useState(false)
  const [changedNotice, setChangedNotice] = React.useState(false)
  const passwordRef = React.useRef<HTMLInputElement>(null)
  const usernameRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    // After "Cambiar contraseña" the tab may be signed out before it can sign in again: explain and prefill.
    const who = takePasswordChanged()
    if (who) {
      setUsername(who)
      setChangedNotice(true)
      passwordRef.current?.focus()
    }
  }, [])

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pending) return
    if (!username.trim()) return usernameRef.current?.focus()
    if (!password) return passwordRef.current?.focus()
    setPending(true)
    setError(null)
    let kind: LoginErrorKind | null
    try {
      const res = await signIn("credentials", { username: username.trim(), password, redirect: false })
      kind = loginErrorKind(res)
    } catch {
      kind = "network"
    }
    if (kind === null) {
      window.location.assign(safeNextPath(next))
      return
    }
    setError(kind)
    setPending(false)
    if (kind === "credentials") {
      setPassword("")
      passwordRef.current?.focus()
    }
  }

  return (
    <Panel>
      <PanelBody className="gap-5 p-5">
        {changedNotice && !error ? <InlineAlert tone="ok" role="status">{t.passwordChanged}</InlineAlert> : null}
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <FormField label={t.username}>
            <Input
              ref={usernameRef}
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="h-9"
            />
          </FormField>
          <FormField label={t.password}>
            {(p) => (
              <PasswordInput
                {...p}
                ref={passwordRef}
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                inputClassName="h-9"
              />
            )}
          </FormField>
          {error ? <InlineAlert tone="danger" role="alert">{t.errors[error]}</InlineAlert> : null}
          <Button type="submit" variant="primary" size="lg" disabled={pending} aria-busy={pending || undefined} className="w-full">
            {pending ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <LogInIcon aria-hidden />}
            {pending ? t.submitting : t.submit}
          </Button>
        </form>
        <p className="text-meta text-muted-foreground text-pretty">{t.forgot}</p>
      </PanelBody>
    </Panel>
  )
}
