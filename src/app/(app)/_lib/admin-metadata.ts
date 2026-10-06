import type { Metadata } from "next"
import { pages } from "@/lib/i18n/shell"
import { getAuthUser } from "@/server/authz"

/**
 * Metadata of an admin page that answers 404 to everyone else: metadata renders before the page's guard, so a
 * non-admin must not get the admin page's name in the tab title of that 404.
 */
export async function adminPageMetadata(title: string): Promise<Metadata> {
  const user = await getAuthUser()
  return { title: user?.isAdmin ? title : pages.notFoundTitle }
}
