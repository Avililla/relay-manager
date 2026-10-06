"use client"

import { usePreference } from "./use-preference"

/**
 * `useLocalStorage` is `usePreference` under its generic name: the app only stores the keys listed in
 * src/lib/client/prefs.ts, always through try/catch. There is deliberately no free-form key variant.
 */
export const useLocalStorage = usePreference
