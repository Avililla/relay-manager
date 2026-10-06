/** Backoff between session checks when the answer is not definite (network error, 5xx, unexpected body). */
export const SESSION_RETRY_MS = [2000, 5000, 10_000, 30_000] as const

export type SessionState = "signed-in" | "signed-out" | "unknown"

/**
 * `/api/auth/session` answer → state. Only a definite answer signs the tab out: 401, or 200 with no user (Auth.js
 * answers `null`). A 5xx, another status or a body that is not a session object is "unknown": the server may be
 * restarting, and a restart must not throw everyone to /login.
 */
export function classifySessionResponse(status: number, body: unknown): SessionState {
  if (status === 401) return "signed-out"
  if (status !== 200) return "unknown"
  if (body === null) return "signed-out"
  if (typeof body !== "object" || Array.isArray(body)) return "unknown"
  return (body as { user?: unknown }).user ? "signed-in" : "signed-out"
}

export interface SessionCheckDeps {
  fetchSession(): Promise<{ status: number; json(): Promise<unknown> }>
  sleep(ms: number, signal: AbortSignal): Promise<void>
  signal: AbortSignal
  delays?: readonly number[]
}

/**
 * Asks until the answer is definite, waiting `delays` between attempts (one attempt more than delays). Resolves
 * "unknown" after the last attempt and "aborted" once `signal` aborts (stream open again, or unmount).
 */
export async function checkSessionUntilKnown(deps: SessionCheckDeps): Promise<SessionState | "aborted"> {
  const delays = deps.delays ?? SESSION_RETRY_MS
  for (let attempt = 0; ; attempt++) {
    if (deps.signal.aborted) return "aborted"
    let state: SessionState = "unknown"
    try {
      const res = await deps.fetchSession()
      let body: unknown = undefined
      try { body = await res.json() } catch { body = undefined }
      state = classifySessionResponse(res.status, body)
    } catch {
      state = "unknown" // network error
    }
    if (deps.signal.aborted) return "aborted"
    if (state !== "unknown") return state
    const wait = delays[attempt]
    if (wait === undefined) return "unknown"
    try { await deps.sleep(wait, deps.signal) } catch { return "aborted" }
  }
}
