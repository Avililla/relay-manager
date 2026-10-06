import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { BoardDetail } from "@/components/boards/board-detail"
import { hardwarePages } from "@/lib/i18n/hardware"
import { getAuthUser } from "@/server/authz"
import { getBoardDetail } from "@/server/queries/boards"
import { requireAdminPage } from "../_lib/require-admin-page"

type Props = { params: Promise<{ id: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  const user = await getAuthUser()
  const board = user?.isAdmin ? await getBoardDetail(id) : null
  return { title: board ? `${board.name} · ${hardwarePages.boards}` : hardwarePages.boards }
}

/** Placa de relés detail (§8.9, admin): status, actions, relay map and connection facts. */
export default async function PlacaPage({ params }: Props) {
  const { id } = await params
  await requireAdminPage(`/placas/${encodeURIComponent(id)}`)
  const board = await getBoardDetail(id)
  if (!board) notFound()
  return <BoardDetail board={board} />
}
