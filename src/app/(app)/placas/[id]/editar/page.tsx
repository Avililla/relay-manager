import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { BoardForm } from "@/components/boards/board-form"
import { draftFromBoard } from "@/components/boards/board-form-model"
import { hardwarePages } from "@/lib/i18n/hardware"
import { getBoardDetail } from "@/server/queries/boards"
import { getRuntime } from "@/server/runtime/registry"
import { requireAdminPage } from "../../_lib/require-admin-page"

export const metadata: Metadata = { title: hardwarePages.editBoard }

/** Editar placa (§8.9, admin): the same form, prefilled; the saved password is never sent to the browser. */
export default async function EditarPlacaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAdminPage(`/placas/${encodeURIComponent(id)}/editar`)
  const board = await getBoardDetail(id)
  if (!board) notFound()
  return (
    <BoardForm
      mode="edit"
      boardId={board.id}
      boardName={board.name}
      hasPassword={board.hasPassword}
      initial={draftFromBoard(board)}
      simulatedAllowed={getRuntime().relays.simulatedAllowed() || board.driver === "simulated"}
    />
  )
}
