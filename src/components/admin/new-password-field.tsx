"use client"

import * as React from "react"
import { DicesIcon } from "lucide-react"
import { PasswordInput } from "@/components/auth/password-input"
import { PasswordRulesList } from "@/components/auth/password-rules-list"
import { withoutRuleMessages } from "@/components/auth/password-rules"
import { CopyButton } from "@/components/common/copy-button"
import { FormField, errorsFor, type FieldErrors } from "@/components/common/form-field"
import { Button } from "@/components/ui/button"
import { passwordRules as t } from "@/lib/i18n/admin"
import { generatePassword } from "./generate-password"

/**
 * A new password with its live rules (Usuarios, Restablecer contraseña, Mi cuenta). With `allowGenerate`, "Generar"
 * fills a random temporary password, reveals it in mono and offers a copy button, so the admin can hand it over.
 */
export function NewPasswordField({ label, name, value, onChange, username, errors, showErrors, allowGenerate = false, autoComplete = "new-password", required = true }: {
  label: string
  name: string
  value: string
  onChange: (v: string) => void
  username?: string
  errors?: FieldErrors
  showErrors?: boolean
  allowGenerate?: boolean
  autoComplete?: string
  required?: boolean
}) {
  const rulesId = React.useId()
  const [visible, setVisible] = React.useState(false)
  const [generated, setGenerated] = React.useState<string | null>(null)
  const isGenerated = generated !== null && generated === value
  // The rules list already shows the length and username failures: only other messages go under the field.
  const all = errorsFor(errors, name)
  const extra = withoutRuleMessages(all)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <FormField
        label={label}
        name={name}
        error={extra}
        required={required}
        help={isGenerated ? t.generated : undefined}
      >
        {(p) => (
          <div className="flex min-w-0 items-center gap-2">
            <PasswordInput
              {...p}
              aria-invalid={all.length ? true : undefined}
              aria-describedby={[p["aria-describedby"], rulesId].filter(Boolean).join(" ")}
              autoComplete={autoComplete}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              visible={visible}
              onVisibleChange={setVisible}
              className="flex-1"
            />
            {isGenerated ? <CopyButton value={value} label={t.copy} size="icon" /> : null}
            {allowGenerate ? (
              <Button
                variant="outline"
                aria-label={t.generateLabel}
                title={t.generateLabel}
                onClick={() => {
                  const p = generatePassword()
                  setGenerated(p)
                  setVisible(true)
                  onChange(p)
                }}
              >
                <DicesIcon aria-hidden />
                {t.generate}
              </Button>
            ) : null}
          </div>
        )}
      </FormField>
      <PasswordRulesList id={rulesId} password={value} username={username} showErrors={showErrors} />
    </div>
  )
}
