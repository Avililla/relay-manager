"use client"

import { useCallback, useState, useTransition } from "react"
import { toast } from "sonner"
import type { ActionResult } from "@/lib/contracts/common"
import { interpretActionResult, networkFailure } from "@/lib/client/action-result"

export interface UseActionOptions<T> {
  /** Toast shown on success (string or built from the data). */
  successMessage?: string | ((data: T) => string)
}

export interface UseActionResult<I, T> {
  run(input: I): Promise<ActionResult<T>>
  pending: boolean
  /** Dotted keys (`consoles.2.key`, `_form`) from the last failed run; cleared by the next run. */
  fieldErrors: Record<string, string[]>
  clearFieldErrors(): void
}

/**
 * Runs a server action (§8.8) inside a transition:
 * - UNAUTHENTICATED → /login?next=<current path>; PASSWORD_CHANGE_REQUIRED → /cuenta?cambiar=1
 * - errors with fieldErrors → returned for inline display (FormField, FormErrors)
 * - other errors → a toast with the Spanish message
 * - a thrown action (server down) → a toast "No se ha podido contactar con el servidor…"
 * The promise always resolves with the ActionResult, so callers can chain (e.g. reserve after force-release).
 */
export function useAction<I, T>(action: (input: I) => Promise<ActionResult<T>>, opts: UseActionOptions<T> = {}): UseActionResult<I, T> {
  const [pending, startTransition] = useTransition()
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const { successMessage } = opts

  const run = useCallback((input: I) => new Promise<ActionResult<T>>((resolve) => {
    startTransition(async () => {
      let r: ActionResult<T>
      try {
        r = await action(input)
      } catch {
        r = networkFailure()
      }
      const outcome = interpretActionResult(r, window.location.pathname + window.location.search)
      startTransition(() => {
        switch (outcome.kind) {
          case "ok":
            setFieldErrors({})
            if (successMessage) toast.success(typeof successMessage === "function" ? successMessage(outcome.data) : successMessage)
            break
          case "field-errors":
            setFieldErrors(outcome.fieldErrors)
            break
          case "toast":
            setFieldErrors({})
            toast.error(outcome.message)
            break
          case "redirect":
            window.location.assign(outcome.to)
            break
        }
      })
      resolve(r)
    })
  }), [action, successMessage])

  const clearFieldErrors = useCallback(() => setFieldErrors({}), [])
  return { run, pending, fieldErrors, clearFieldErrors }
}
