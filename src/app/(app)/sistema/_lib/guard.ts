// Page guards for the W2-D admin screens (§6.8 "Pages call requireUser()/requireAdmin() and redirect() on
// failure: non-admins go to /, never to a 500 page"). Shared by Usuarios, Roles and Sistema.
import { redirect } from "next/navigation"
import { getAuthUser } from "@/server/authz"
import type { AuthUser } from "@/server/runtime/types"

/** The fresh admin, or a redirect: no session → /login; must change password → /cuenta?cambiar=1; not admin → /. */
export async function adminPage(): Promise<AuthUser> {
  const u = await getAuthUser()
  if (!u) redirect("/login")
  if (u.mustChangePassword) redirect("/cuenta?cambiar=1")
  if (!u.isAdmin) redirect("/")
  return u
}

/** Any signed-in user (Mi cuenta allows a pending password change). */
export async function userPage(): Promise<AuthUser> {
  const u = await getAuthUser()
  if (!u) redirect("/login")
  return u
}
