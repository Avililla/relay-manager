"use client"

import * as React from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { auth as t } from "@/lib/i18n/admin"
import { cn } from "@/lib/client/cn"

/**
 * Password field with a show/hide toggle (§8.9 Login). The toggle is a real button inside the field's frame
 * (`aria-pressed`, names the action); it never submits and keeps focus where the user is typing.
 * Visibility is internal unless `visible`/`onVisibleChange` control it (e.g. to reveal a generated password).
 */
export function PasswordInput({ className, inputClassName, visible: visibleProp, onVisibleChange, ...props }:
  Omit<React.ComponentProps<"input">, "type"> & { inputClassName?: string; visible?: boolean; onVisibleChange?: (v: boolean) => void }) {
  const [inner, setInner] = React.useState(false)
  const visible = visibleProp ?? inner
  const toggle = () => {
    const v = !visible
    setInner(v)
    onVisibleChange?.(v)
  }
  return (
    <div className={cn("relative flex min-w-0", className)}>
      <Input
        {...props}
        type={visible ? "text" : "password"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn("pr-9", visible && "font-mono text-data", inputClassName)}
      />
      <button
        type="button"
        aria-label={visible ? t.hidePassword : t.showPassword}
        aria-pressed={visible}
        aria-controls={props.id}
        title={visible ? t.hidePassword : t.showPassword}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        disabled={props.disabled}
        className="absolute inset-y-0 right-0 grid w-8 place-items-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-offset-[-2px] disabled:opacity-50"
      >
        {visible ? <EyeOffIcon aria-hidden className="size-4" /> : <EyeIcon aria-hidden className="size-4" />}
      </button>
    </div>
  )
}
