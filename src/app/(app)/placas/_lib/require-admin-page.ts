import { redirect } from "next/navigation"
import { safeNextPath } from "@/lib/safe-next"
import { getAuthUser } from "@/server/authz"
import type { AuthUser } from "@/server/runtime/types"

/** `?key=value` for the params the page wants to keep in `?next=` (first value of each, empty ones dropped). */
export function keptSearch(sp: Record<string, string | string[] | undefined>, keys: readonly string[]): string {
  const out = new URLSearchParams()
  for (const k of keys) {
    const v = Array.isArray(sp[k]) ? sp[k][0] : sp[k]
    if (v) out.set(k, v)
  }
  const s = out.toString()
  return s ? `?${s}` : ""
}

/**
 * Gate for the admin pages of W2-C (Descubrimiento, Placas de relés, Auditoría), §6.8: no session → /login with
 * `?next=` back to `returnTo` (the proxy already does this for anonymous requests; this covers a cookie whose
 * session no longer holds, e.g. a deleted or disabled user), a pending password change → /cuenta?cambiar=1, a
 * non-admin → Banco. Never a 500 page.
 */
export async function requireAdminPage(returnTo: string): Promise<AuthUser> {
  const user = await getAuthUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(safeNextPath(returnTo))}`)
  if (user.mustChangePassword) redirect("/cuenta?cambiar=1")
  if (!user.isAdmin) redirect("/")
  return user
}
