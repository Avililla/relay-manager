// Hand-off between Mi cuenta and the login page after a password change.
//
// changeOwnPassword bumps sessionVersion and publishes session.revoked for the user; the tab's EventsProvider
// (W1-E) may therefore sign the user out and navigate to /login before our own re-sign-in finishes. The flag
// lets the login page explain what happened and prefill the username, whichever side wins that race.
// sessionStorage (per tab, not a preference); every access is guarded (§8.12).

export const PASSWORD_CHANGED_KEY = "rm-password-changed"
const MAX_AGE_MS = 10 * 60_000
const REAUTH_WINDOW_MS = 60_000
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/

export interface FlagStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function sessionFlagStorage(): FlagStorage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null
  } catch {
    return null
  }
}

export function markPasswordChanged(username: string, storage: FlagStorage | null = sessionFlagStorage(), now = Date.now()): void {
  try {
    storage?.setItem(PASSWORD_CHANGED_KEY, JSON.stringify({ u: username, at: now }))
  } catch {
    // Blocked storage: the login page simply shows no notice.
  }
}

export function clearPasswordChanged(storage: FlagStorage | null = sessionFlagStorage()): void {
  try {
    storage?.removeItem(PASSWORD_CHANGED_KEY)
  } catch {
    // ignore
  }
}

/** Reads and removes the flag. Returns the username when the flag is fresh and well formed. */
export function takePasswordChanged(storage: FlagStorage | null = sessionFlagStorage(), now = Date.now()): string | null {
  let raw: string | null = null
  try {
    raw = storage?.getItem(PASSWORD_CHANGED_KEY) ?? null
    if (raw !== null) storage?.removeItem(PASSWORD_CHANGED_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== "object" || v === null) return null
    const { u, at } = v as { u?: unknown; at?: unknown }
    if (typeof u !== "string" || !USERNAME.test(u) || typeof at !== "number") return null
    if (now - at < 0 || now - at > MAX_AGE_MS) return null
    return u
  } catch {
    return null
  }
}

/**
 * True while this tab is signing in again after changing its own password (flag set less than a minute ago). The
 * events runtime then ignores the `session.revoked` meant for the user's other sessions and gives the re-sign-in
 * time before checking the session, instead of signing this tab out. Does not consume the flag.
 */
export function isChangingOwnPassword(storage: FlagStorage | null = sessionFlagStorage(), now = Date.now()): boolean {
  try {
    const raw = storage?.getItem(PASSWORD_CHANGED_KEY)
    if (!raw) return false
    const v: unknown = JSON.parse(raw)
    const at = typeof v === "object" && v !== null ? (v as { at?: unknown }).at : undefined
    return typeof at === "number" && now - at >= 0 && now - at <= REAUTH_WINDOW_MS
  } catch {
    return false
  }
}
