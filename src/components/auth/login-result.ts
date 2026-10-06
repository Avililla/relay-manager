// Maps the next-auth `signIn(..., { redirect: false })` result onto the three login messages of §8.9.
// The server raises RateLimitedError (code "rate_limited") and DisabledError (code "disabled"); every other
// failure, including a validation failure of the credentials, reads as "Usuario o contraseña incorrectos".

export type LoginErrorKind = "credentials" | "rate_limited" | "disabled" | "network"

/** The subset of next-auth's SignInResponse this page reads. */
export interface SignInOutcome { ok?: boolean; error?: string | null; code?: string | null }

/** null = signed in. */
export function loginErrorKind(res: SignInOutcome | null | undefined): LoginErrorKind | null {
  if (!res) return "credentials"
  if (!res.error) return null
  if (res.code === "rate_limited") return "rate_limited"
  if (res.code === "disabled") return "disabled"
  return "credentials"
}
