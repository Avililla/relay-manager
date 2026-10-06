"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { KeyRoundIcon, LoaderCircleIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { signIn } from "next-auth/react"
import { toast } from "sonner"
import { changeOwnPassword } from "@/actions/account"
import { PasswordInput } from "@/components/auth/password-input"
import { clearPasswordChanged, markPasswordChanged } from "@/components/auth/password-changed-flag"
import { confirmationMatches } from "@/components/auth/password-rules"
import { FormErrors, FormField } from "@/components/common/form-field"
import { NumberStepper } from "@/components/common/number-stepper"
import { SegmentedControl } from "@/components/common/segmented-control"
import { RosaSwatch } from "@/components/shell/theme-swatch"
import { useTerminalTheme } from "@/components/terminal/use-terminal-theme"
import { Button } from "@/components/ui/button"
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { useAction } from "@/hooks/use-action"
import { usePreference } from "@/hooks/use-preference"
import { useThemePreference } from "@/hooks/use-theme"
import { ChangeOwnPasswordInputSchema } from "@/lib/contracts/users"
import { TERM_FONT, TERM_SCROLLBACK } from "@/lib/client/prefs"
import type { ThemePref } from "@/lib/client/theme"
import { account as t, passwordRules as rulesText } from "@/lib/i18n/admin"
import { SPANISH_PARSE, mergeFieldErrors, withoutField, zodFieldErrors, type FieldErrors } from "./field-errors"
import { NewPasswordField } from "./new-password-field"
import { ToggleField } from "./toggle-field"

type PwField = "currentPassword" | "newPassword" | "confirmPassword"
const EMPTY = { currentPassword: "", newPassword: "", confirmPassword: "" }

/**
 * "Cambiar contraseña" (§8.9 Mi cuenta). changeOwnPassword bumps the session version, so the client signs in again
 * with the new password. The server also revokes this user's live sessions, so the tab's events runtime may sign it
 * out first: the flag set here lets the login page explain that and prefill the username.
 */
export function ChangePasswordForm({ username, mustChange }: { username: string; mustChange: boolean }) {
  const router = useRouter()
  const [values, setValues] = React.useState(EMPTY)
  const [local, setLocal] = React.useState<FieldErrors>({})
  const [server, setServer] = React.useState<FieldErrors>({})
  const [attempted, setAttempted] = React.useState(false)
  const [confirmTouched, setConfirmTouched] = React.useState(false)
  const [signingIn, setSigningIn] = React.useState(false)
  const formRef = React.useRef<HTMLFormElement>(null)
  const action = useAction(changeOwnPassword)
  const busy = action.pending || signingIn

  const mismatch = (attempted || confirmTouched) && confirmationMatches(values.newPassword, values.confirmPassword) === false
  const errors = mergeFieldErrors(server, local, mismatch ? { confirmPassword: [rulesText.mismatch] } : null)
  const set = (f: PwField, v: string) => {
    setValues((s) => ({ ...s, [f]: v }))
    setLocal((x) => withoutField(withoutField(x, f), "_form"))
    setServer((x) => withoutField(withoutField(x, f), "_form"))
  }
  const focusFirstInvalid = () => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus())

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setAttempted(true)
    const parsed = ChangeOwnPasswordInputSchema.safeParse(values, SPANISH_PARSE)
    if (!parsed.success) {
      setLocal(zodFieldErrors(parsed.error))
      focusFirstInvalid()
      return
    }
    markPasswordChanged(username)
    const r = await action.run(values)
    if (!r.ok) {
      clearPasswordChanged()
      setServer(r.error.fieldErrors ?? {})
      focusFirstInvalid()
      return
    }
    setSigningIn(true)
    let ok = false
    try {
      const res = await signIn("credentials", { username, password: values.newPassword, redirect: false })
      ok = !!res && !res.error
    } catch {
      ok = false
    }
    if (!ok) {
      window.location.assign("/login")
      return
    }
    toast.success(t.changed)
    // If the events runtime has not signed this tab out by now, the notice is not needed any more.
    setTimeout(() => clearPasswordChanged(), 4000)
    if (mustChange) {
      window.location.assign("/")
      return
    }
    setValues(EMPTY)
    setAttempted(false)
    setConfirmTouched(false)
    setSigningIn(false)
    router.refresh()
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
      <Panel>
        <PanelHeader><PanelTitle as="h2">{t.passwordSection}</PanelTitle></PanelHeader>
        <PanelBody className="gap-5">
          <PanelDescription className="text-body">{t.passwordHelp}</PanelDescription>
          <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
          <FormField label={t.currentPassword} name="currentPassword" errors={errors} required className="max-w-md">
            {(p) => (
              <PasswordInput
                {...p}
                autoComplete="current-password"
                value={values.currentPassword}
                onChange={(e) => set("currentPassword", e.target.value)}
              />
            )}
          </FormField>
          <div className="grid gap-5 md:grid-cols-2">
            <NewPasswordField
              label={t.newPassword}
              name="newPassword"
              value={values.newPassword}
              onChange={(v) => set("newPassword", v)}
              username={username}
              errors={errors}
              showErrors={attempted}
            />
            <FormField label={t.confirmPassword} name="confirmPassword" errors={errors} required>
              {(p) => (
                <PasswordInput
                  {...p}
                  autoComplete="new-password"
                  value={values.confirmPassword}
                  onChange={(e) => set("confirmPassword", e.target.value)}
                  onBlur={() => setConfirmTouched(true)}
                />
              )}
            </FormField>
          </div>
          <FormErrors errors={errors} />
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
            <Button type="submit" variant="primary" size="lg" disabled={busy} aria-busy={busy || undefined}>
              {busy ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : <KeyRoundIcon aria-hidden />}
              {busy ? t.submitting : t.submit}
            </Button>
          </div>
        </PanelBody>
      </Panel>
    </form>
  )
}

/** A few lines of console output in the terminal palette at the chosen size (§8.10: consoles stay dark; Rosa tints them grape). */
function TerminalPreview({ fontSize }: { fontSize: number }) {
  const th = useTerminalTheme()
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-md border px-3 py-2.5 font-mono whitespace-pre"
      style={{ background: th.background as string, color: th.foreground as string, fontSize, lineHeight: 1.2 }}
    >
      <div><span style={{ color: th.green as string }}>equipo-a-01-uart1 login:</span> root</div>
      <div>Password:</div>
      <div><span style={{ color: th.blue as string }}>root@equipo-a-01</span>:~# uname -r</div>
      <div>6.1.30-xilinx-v2023.2</div>
      <div><span style={{ color: th.blue as string }}>root@equipo-a-01</span>:~# <span className="inline-block h-[1em] w-[0.6em] translate-y-[0.15em]" style={{ background: th.cursor as string }} /></div>
    </div>
  )
}

/**
 * Preferencias (§8.9): the theme is saved in the account (useThemePreference → setMyTheme, D39); terminal font size,
 * scrollback and screen-reader mode are per browser (usePreference). They apply immediately; open terminals follow.
 */
export function PreferencesPanel() {
  const [theme, setTheme] = useThemePreference()
  const [fontSize, setFontSize] = usePreference("rm-term-font")
  const [scrollback, setScrollback] = usePreference("rm-term-scrollback")
  const [sr, setSr] = usePreference("rm-term-sr")
  return (
    <Panel>
      <PanelHeader><PanelTitle as="h2">{t.prefsSection}</PanelTitle></PanelHeader>
      <PanelBody className="gap-6">
        <PanelDescription className="text-body">{t.prefsHelp}</PanelDescription>
        <div className="flex flex-col gap-1.5">
          <span className="text-body font-medium text-foreground">{t.theme}</span>
          <SegmentedControl<ThemePref>
            aria-label={t.theme}
            value={theme}
            onChange={setTheme}
            className="w-fit max-w-full max-sm:w-full max-sm:flex-col"
            options={[
              { value: "dark", label: t.themeDark, icon: <MoonIcon aria-hidden /> },
              { value: "light", label: t.themeLight, icon: <SunIcon aria-hidden /> },
              { value: "system", label: t.themeSystem, icon: <MonitorIcon aria-hidden /> },
              { value: "rosa", label: t.themeRosa, icon: <RosaSwatch /> },
            ]}
          />
          <span className="text-meta text-muted-foreground">{t.themeHelp}</span>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <FormField label={t.termFont} help={t.termFontHelp}>
            {(p) => <NumberStepper {...p} value={fontSize} onChange={setFontSize} min={TERM_FONT.min} max={TERM_FONT.max} unit={t.px} className="w-36" />}
          </FormField>
          <FormField label={t.termScrollback} help={t.termScrollbackHelp}>
            {(p) => <NumberStepper {...p} value={scrollback} onChange={setScrollback} min={TERM_SCROLLBACK.min} max={TERM_SCROLLBACK.max} step={1000} unit={t.lines} className="w-48" />}
          </FormField>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-meta text-muted-foreground">{t.preview}</span>
          <TerminalPreview fontSize={fontSize} />
        </div>
        <ToggleField label={t.termSr} description={t.termSrHelp} checked={sr} onCheckedChange={setSr} />
      </PanelBody>
    </Panel>
  )
}
