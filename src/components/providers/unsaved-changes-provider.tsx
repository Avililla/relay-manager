"use client"

import * as React from "react"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { unsaved } from "@/lib/i18n/shell"

/**
 * Unsaved-changes guard (§8.8). Forms register their dirty flag with `useUnsavedChanges(dirty)`; AppLink asks
 * `confirmLeave()` before an in-app navigation. The browser Back button is not intercepted (documented limitation);
 * reloads and tab closes are covered by `beforeunload`.
 */
interface UnsavedContextValue {
  setDirty(id: string, dirty: boolean): void
  isDirty(): boolean
  /** Runs `proceed` now when nothing is dirty; otherwise asks first. */
  confirmLeave(proceed: () => void): void
}

const UnsavedContext = React.createContext<UnsavedContextValue | null>(null)

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const [dirtyIds] = React.useState(() => new Set<string>())
  const [pending, setPending] = React.useState<null | (() => void)>(null)

  const value = React.useMemo<UnsavedContextValue>(() => ({
    setDirty(id, dirty) {
      if (dirty) dirtyIds.add(id)
      else dirtyIds.delete(id)
    },
    isDirty: () => dirtyIds.size > 0,
    confirmLeave(proceed) {
      if (!dirtyIds.size) proceed()
      else setPending(() => proceed)
    },
  }), [dirtyIds])

  const leave = () => {
    const go = pending
    setPending(null)
    // The user chose to discard: forget every dirty form so the navigation is not asked twice.
    dirtyIds.clear()
    go?.()
  }

  return (
    <UnsavedContext.Provider value={value}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{unsaved.title}</AlertDialogTitle>
            <AlertDialogDescription>{unsaved.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{unsaved.stay}</AlertDialogCancel>
            <AlertDialogAction onClick={leave}>{unsaved.leave}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedContext.Provider>
  )
}

export function useUnsavedContext(): UnsavedContextValue | null {
  return React.useContext(UnsavedContext)
}

/** Registers a form's dirty state: AppLink asks before leaving, and `beforeunload` guards reloads. */
export function useUnsavedChanges(dirty: boolean): void {
  const ctx = useUnsavedContext()
  const id = React.useId()
  React.useEffect(() => {
    ctx?.setDirty(id, dirty)
    return () => ctx?.setDirty(id, false)
  }, [ctx, id, dirty])
  React.useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [dirty])
}
