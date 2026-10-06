"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { PREF_EVENT, parsePref, readRaw, writePref, type PrefKey, type PrefValue } from "@/lib/client/prefs"

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange)
  window.addEventListener(PREF_EVENT, onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener(PREF_EVENT, onChange)
  }
}

/**
 * A per-browser preference (§8.8 prefs): parsed and range-checked, synced across hooks in this tab and across
 * tabs through the `storage` event. The server render (and the first client render) use the default value.
 */
export function usePreference<K extends PrefKey>(key: K): [PrefValue<K>, (v: PrefValue<K>) => void] {
  const raw = useSyncExternalStore(subscribe, () => readRaw(key), () => null)
  const value = useMemo(() => parsePref(key, raw), [key, raw])
  const set = useCallback((v: PrefValue<K>) => {
    writePref(key, v)
  }, [key])
  return [value, set]
}
