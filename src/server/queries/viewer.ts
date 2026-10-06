import "server-only"
import { redirect } from "next/navigation"
import type { PrismaClient } from "@/generated/prisma/client"
import { parseAccountTheme, type ThemePref } from "@/lib/contracts/enums"
import type { ViewerDTO } from "@/lib/contracts/users"
import { getAuthUser } from "@/server/authz"
import { getRuntime, tryGetRuntime } from "@/server/runtime/registry"

/** The account's colour theme (D39): null when never chosen (or an unknown stored value). */
export async function readAccountTheme(prisma: PrismaClient, userId: string): Promise<ThemePref | null> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { theme: true } })
  return parseAccountTheme(row?.theme)
}

/** The signed-in viewer; redirects to /login when there is no session. */
export async function getViewer(): Promise<ViewerDTO> {
  const u = await getAuthUser()
  if (!u) redirect("/login")
  const theme = await readAccountTheme(getRuntime().prisma, u.id)
  return { id: u.id, username: u.username, name: u.name, isAdmin: u.isAdmin, mustChangePassword: u.mustChangePassword, theme }
}

/**
 * For the root layout (every page, no flash): the signed-in viewer's theme, `{ theme: null }` when the account has none,
 * or null when signed out. Never throws (no runtime during `next build`, a broken cookie): the page then falls back to
 * the browser's cached theme, exactly as when signed out.
 */
export async function getViewerTheme(): Promise<{ theme: ThemePref | null } | null> {
  const rt = tryGetRuntime()
  if (!rt) return null
  try {
    const u = await getAuthUser()
    if (!u) return null
    return { theme: await readAccountTheme(rt.prisma, u.id) }
  } catch {
    return null
  }
}
