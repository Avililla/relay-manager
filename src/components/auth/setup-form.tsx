"use client"

import * as React from "react"
import { ArrowRightIcon, LoaderCircleIcon, LogInIcon } from "lucide-react"
import { signIn } from "next-auth/react"
import { toast } from "sonner"
import { completeSetup } from "@/actions/setup"
import { CommandLine } from "@/components/admin/command-line"
import { SPANISH_PARSE, mergeFieldErrors, withoutField, zodFieldErrors, type FieldErrors } from "@/components/admin/field-errors"
import { FormErrors, FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel } from "@/components/ui/panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { interpretActionResult, networkFailure } from "@/lib/client/action-result"
import { cn } from "@/lib/client/cn"
import type { ActionResult } from "@/lib/contracts/common"
import { SetupInputSchema } from "@/lib/contracts/users"
import { passwordRules as rulesText, setup as t } from "@/lib/i18n/admin"
import { confirmationMatches, withoutRuleMessages } from "./password-rules"
import { PasswordInput } from "./password-input"
import { PasswordRulesList } from "./password-rules-list"

type Field = "token" | "username" | "name" | "password" | "passwordConfirm"
type Values = Record<Field, string>
type Phase = "form" | "signing-in" | "done" | "signin-failed"

const EMPTY: Values = { token: "", username: "", name: "", password: "", passwordConfirm: "" }

/** The action, with a thrown call (server down, or the request redirected away) turned into an INTERNAL result. */
async function runSetup(input: Values): Promise<ActionResult<{ username: string }>> {
  try {
    return await completeSetup(input)
  } catch {
    return networkFailure()
  }
}

/**
 * Setup finished in another tab: the proxy then answers this tab's action POST with a redirect to /login, which
 * the action call reports like a network failure. A HEAD of /setup that is redirected tells the two apart.
 */
async function setupAlreadyDone(): Promise<boolean> {
  try {
    const res = await fetch("/setup", { method: "HEAD", redirect: "manual", cache: "no-store" })
    return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)
  } catch {
    return false
  }
}

/** A numbered block of the setup page: the step number carries the order the two blocks are filled in. */
function Step({ n, title, children, aside }: { n: number; title: string; children: React.ReactNode; aside: React.ReactNode }) {
  const id = React.useId()
  return (
    <section aria-labelledby={id} className="grid gap-4 px-5 py-6 md:grid-cols-[15rem_minmax(0,1fr)] md:gap-8">
      <div className="flex flex-col gap-1.5">
        <h2 id={id} className="flex items-center gap-2 text-section text-foreground">
          <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-sm border border-input font-mono text-micro text-muted-foreground tabular-nums">{n}</span>
          {title}
        </h2>
        <div className="text-meta text-muted-foreground text-pretty">{aside}</div>
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  )
}

/**
 * First-run setup (§6.6, §8.9): the one-time code from the server log, then the first administrator. Shows no
 * health or hardware data (D23). The code field accepts any shape (a fixed RM_SETUP_TOKEN may have any format):
 * no mask, no maxlength; the XXXX-XXXX-XXXX-XXXX grouping is only the placeholder. An invalid code keeps every
 * field. Success signs in and lands on Banco.
 */
export function SetupForm() {
  const [values, setValues] = React.useState<Values>(EMPTY)
  const [local, setLocal] = React.useState<FieldErrors>({})
  const [server, setServer] = React.useState<FieldErrors>({})
  const [attempted, setAttempted] = React.useState(false)
  const [confirmTouched, setConfirmTouched] = React.useState(false)
  const [phase, setPhase] = React.useState<Phase>("form")
  const formRef = React.useRef<HTMLFormElement>(null)
  const loginLinkRef = React.useRef<HTMLAnchorElement>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const busy = submitting || phase === "signing-in"

  const set = (f: Field) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setValues((s) => ({ ...s, [f]: v }))
    setLocal((x) => withoutField(withoutField(x, f), "_form"))
    setServer((x) => withoutField(x, f))
  }

  const mismatch = (attempted || confirmTouched) && confirmationMatches(values.password, values.passwordConfirm) === false
  const errors = mergeFieldErrors(server, local, mismatch ? { passwordConfirm: [rulesText.mismatch] } : null)

  const focusFirstInvalid = () => requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus())

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    setAttempted(true)
    const parsed = SetupInputSchema.safeParse(values, SPANISH_PARSE)
    if (!parsed.success) {
      setLocal(zodFieldErrors(parsed.error))
      focusFirstInvalid()
      return
    }
    setSubmitting(true)
    const r = await runSetup(values)
    const doneElsewhere = !r.ok && (r.error.code === "SETUP_DONE" || (r.error.code === "INTERNAL" && !r.error.fieldErrors && await setupAlreadyDone()))
    setSubmitting(false)
    if (doneElsewhere) {
      setPhase("done")
      return
    }
    if (!r.ok) {
      const outcome = interpretActionResult(r, "/setup")
      if (outcome.kind === "field-errors") {
        setServer(outcome.fieldErrors)
        focusFirstInvalid()
      } else if (outcome.kind === "redirect") {
        window.location.assign(outcome.to)
      } else if (outcome.kind === "toast") {
        setServer({})
        toast.error(outcome.message)
      }
      return
    }
    setPhase("signing-in")
    try {
      const login = await signIn("credentials", { username: r.data.username, password: values.password, redirect: false })
      if (login && !login.error) {
        window.location.assign("/")
        return
      }
    } catch {
      // fall through: the admin exists, the user can sign in from /login
    }
    setPhase("signin-failed")
  }

  const finished = phase === "done" || phase === "signin-failed"
  // The form (and its focused submit button) is gone: move focus to the one action left.
  React.useEffect(() => {
    if (finished) loginLinkRef.current?.focus()
  }, [finished])

  if (finished) {
    // On its own: no intro ("Crea la cuenta…" no longer applies) and no card around the alert's own box.
    return (
      <InlineAlert
        tone={phase === "done" ? "info" : "warn"}
        role="alert"
        title={phase === "done" ? t.doneTitle : undefined}
        actions={(
          <Button asChild variant="primary">
            <a ref={loginLinkRef} href="/login"><LogInIcon aria-hidden />{t.goToLogin}</a>
          </Button>
        )}
      >
        {phase === "done" ? t.doneBody : t.signInFailed}
      </InlineAlert>
    )
  }

  return (
    // Public page: no AppProviders, so the copy buttons' tooltips need their own provider.
    <TooltipProvider>
    {/* The intro belongs to the form: it sits right under AuthFrame's heading (gap-6 minus 20 px = its gap-1). */}
    <p className="-mt-5 max-w-[64ch] text-body text-muted-foreground text-pretty">{t.intro}</p>
    <form ref={formRef} onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
      <Panel className="divide-y">
        <Step
          n={1}
          title={t.tokenSection}
          aside={<p>{t.tokenAside}</p>}
        >
          <FormField label={t.tokenLabel} name="token" errors={errors} required>
            {(p) => (
              <Input
                {...p}
                aria-describedby={[p["aria-describedby"], "setup-token-help"].filter(Boolean).join(" ")}
                name="token"
                autoFocus
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t.tokenPlaceholder}
                value={values.token}
                onChange={set("token")}
                className="h-9 font-mono text-data tracking-[0.06em]"
              />
            )}
          </FormField>
          <div id="setup-token-help" className="flex flex-col gap-2">
            <p className="text-meta text-muted-foreground">{t.tokenHelpLead}</p>
            <CommandLine command={t.tokenCommand} copyLabel={t.copyCommand} />
            <p className="text-meta text-muted-foreground">{t.tokenDockerLead}</p>
            <CommandLine command={t.tokenDockerCommand} copyLabel={t.copyCommand} />
          </div>
        </Step>

        <Step n={2} title={t.adminSection} aside={<p>{t.adminIntro}</p>}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t.username} name="username" errors={errors} help={errors.username?.length ? undefined : t.usernameHelp} required>
              <Input
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={values.username}
                onChange={set("username")}
                className="h-9"
              />
            </FormField>
            <FormField label={t.name} name="name" errors={errors} required>
              <Input name="name" autoComplete="name" placeholder={t.namePlaceholder} value={values.name} onChange={set("name")} className="h-9" />
            </FormField>
            <FormField label={t.password} name="password" error={withoutRuleMessages(errors.password ?? [])} required>
              {(p) => (
                <PasswordInput
                  {...p}
                  aria-invalid={errors.password?.length ? true : undefined}
                  aria-describedby={[p["aria-describedby"], "setup-password-rules"].filter(Boolean).join(" ")}
                  name="password"
                  autoComplete="new-password"
                  value={values.password}
                  onChange={set("password")}
                  inputClassName="h-9"
                />
              )}
            </FormField>
            <FormField label={t.passwordConfirm} name="passwordConfirm" errors={errors} required>
              {(p) => (
                <PasswordInput
                  {...p}
                  name="passwordConfirm"
                  autoComplete="new-password"
                  value={values.passwordConfirm}
                  onChange={set("passwordConfirm")}
                  onBlur={() => setConfirmTouched(true)}
                  inputClassName="h-9"
                />
              )}
            </FormField>
          </div>
          <PasswordRulesList id="setup-password-rules" password={values.password} username={values.username} showErrors={attempted} />
        </Step>

        <div className="flex flex-col gap-3 px-5 py-4">
          <FormErrors errors={errors} />
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="submit" variant="primary" size="lg" disabled={busy} aria-busy={busy || undefined} className={cn("max-sm:w-full")}>
              {busy ? <LoaderCircleIcon aria-hidden className="animate-spin motion-reduce:hidden" /> : null}
              {phase === "signing-in" ? t.signingIn : submitting ? t.submitting : t.submit}
              {!busy ? <ArrowRightIcon aria-hidden /> : null}
            </Button>
          </div>
        </div>
      </Panel>
    </form>
    </TooltipProvider>
  )
}
