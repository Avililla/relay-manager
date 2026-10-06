// Board choices for the wizard and equipment Ajustes (§4.15). W1-B provides no board-choices query.
import type { BoardChoiceDTO } from "@/lib/contracts/relays"
import type { DomainDeps } from "@/server/runtime/types"
import { byName } from "./dto"

/**
 * Every registered board with its free channels (from Prisma) and `online` from the relay controller.
 * With `forEquipmentId`, channels bound to that equipment count as free, so its own assignments stay selectable.
 */
export async function listBoardChoices(
  deps: Pick<DomainDeps, "prisma" | "relays">,
  opts: { forEquipmentId?: string } = {},
): Promise<BoardChoiceDTO[]> {
  const boards = await deps.prisma.relayBoard.findMany({
    select: { id: true, name: true, model: true, relayCount: true, channels: { select: { channel: true, equipmentId: true } } },
  })
  return boards
    .map((b) => {
      const used = new Set(b.channels.filter((c) => c.equipmentId !== opts.forEquipmentId).map((c) => c.channel))
      const freeChannels: number[] = []
      for (let ch = 1; ch <= b.relayCount; ch++) if (!used.has(ch)) freeChannels.push(ch)
      return {
        id: b.id, name: b.name, model: b.model, relayCount: b.relayCount, freeChannels,
        online: deps.relays.controller.boardRuntime(b.id)?.online ?? null,
      }
    })
    .sort(byName)
}
