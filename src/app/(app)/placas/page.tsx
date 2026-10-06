import type { Metadata } from "next"
import { BoardsList } from "@/components/boards/boards-list"
import { hardwarePages } from "@/lib/i18n/hardware"
import { listBoards } from "@/server/queries/boards"
import { requireAdminPage } from "./_lib/require-admin-page"

export const metadata: Metadata = { title: hardwarePages.boards }

/** Placas de relés (§8.9, admin): the registered boards with their live status. */
export default async function PlacasPage() {
  await requireAdminPage("/placas")
  return <BoardsList boards={await listBoards()} />
}
