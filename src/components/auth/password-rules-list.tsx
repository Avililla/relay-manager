"use client"

import { CheckIcon, CircleIcon, XIcon } from "lucide-react"
import { passwordRules as t } from "@/lib/i18n/admin"
import { cn } from "@/lib/client/cn"
import { checkPassword } from "./password-rules"

/**
 * Inline password rules (§8.9 Setup: "mínimo 10 caracteres", "distinta del usuario", "máximo 72 bytes").
 * Ticks as the user types; after a submit attempt, unmet rules turn danger (only the length rule while it is empty). Not a live region: the field
 * references it with aria-describedby and each item carries its state in text.
 */
export function PasswordRulesList({ id, password, username, showErrors = false, className }: {
  id?: string
  password: string
  username?: string
  showErrors?: boolean
  className?: string
}) {
  const { rules } = checkPassword(password, username)
  return (
    <ul id={id} aria-label={t.title} className={cn("flex flex-wrap gap-x-4 gap-y-1 text-meta", className)}>
      {rules.map((r) => {
        // An empty password only fails the length rule: it is not over 72 bytes nor equal to the username yet.
        const failed = !r.ok && showErrors && (r.id === "min" || password.length > 0)
        const Icon = r.ok ? CheckIcon : failed ? XIcon : CircleIcon
        return (
          <li key={r.id} data-ok={r.ok || undefined} className={cn("inline-flex items-center gap-1.5", r.ok ? "text-foreground" : failed ? "text-danger" : "text-muted-foreground")}>
            <Icon aria-hidden className={cn("shrink-0", r.ok ? "size-3.5 text-ok" : failed ? "size-3.5" : "size-2.5 text-faint-foreground")} strokeWidth={r.ok || failed ? 2.5 : 2} />
            <span>{r.label}</span>
            <span className="sr-only">{`: ${r.ok ? t.met : failed ? t.failed : t.unmet}`}</span>
          </li>
        )
      })}
    </ul>
  )
}
