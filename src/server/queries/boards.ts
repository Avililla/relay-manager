import "server-only"
// Relay board read side (§7.4, W1-B). Admin pages call requireAdmin() first; these check it again.
import { IdSchema } from "@/lib/contracts/common"
import { DriverIdSchema, RelayPurposeSchema, type DriverId } from "@/lib/contracts/enums"
import { BoardOptionsSchema, type BoardDetailDTO, type BoardDTO, type BoardOptions, type BoardRuntimeDTO } from "@/lib/contracts/relays"
import { driverCapabilities } from "@/lib/relays/capabilities"
import { requireAdmin } from "@/server/authz"
import { getRuntime } from "@/server/runtime/registry"
import type { Runtime } from "@/server/runtime/types"

interface BoardRow {
  id: string; name: string; driver: string; host: string; httpPort: number; tcpPort: number | null; model: string | null
  moduleId: number | null; mac: string | null; relayCount: number; options: unknown; username: string | null
  password: string | null; enabled: boolean; online: boolean; lastSeenAt: Date | null; lastError: string | null; relayState: string
}

const driverOf = (d: string): DriverId => {
  const p = DriverIdSchema.safeParse(d)
  return p.success ? p.data : "simulated"
}
const optionsOf = (o: unknown): BoardOptions => {
  const p = BoardOptionsSchema.safeParse(o ?? {})
  return p.success ? p.data : {}
}

/** Live runtime from the controller; the persisted columns when the controller does not know the board yet. */
function runtimeOf(rt: Runtime, r: BoardRow, driver: DriverId, options: BoardOptions): BoardRuntimeDTO {
  const live = rt.relays.controller.boardRuntime(r.id)
  if (live) return live
  return {
    online: null,
    lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
    lastError: r.lastError,
    states: Array.from({ length: r.relayCount }, () => null),
    stale: true,
    capabilities: driverCapabilities(driver, { model: r.model, options }),
  }
}

function toBoardDTO(rt: Runtime, r: BoardRow, channels: Array<{ equipmentId: string }>): BoardDTO {
  const driver = driverOf(r.driver)
  const options = optionsOf(r.options)
  return {
    id: r.id, name: r.name, driver, host: r.host, httpPort: r.httpPort, tcpPort: r.tcpPort, model: r.model, moduleId: r.moduleId,
    mac: r.mac, relayCount: r.relayCount, options, username: r.username, hasPassword: r.password !== null, enabled: r.enabled,
    usedChannels: channels.length, equipmentCount: new Set(channels.map((c) => c.equipmentId)).size,
    runtime: runtimeOf(rt, r, driver, options),
  }
}

export async function listBoards(): Promise<BoardDTO[]> {
  await requireAdmin()
  const rt = getRuntime()
  const rows = await rt.prisma.relayBoard.findMany({ include: { channels: { select: { equipmentId: true } } } })
  rows.sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true }))
  return rows.map((r) => toBoardDTO(rt, r, r.channels))
}

export async function getBoardDetail(id: string): Promise<BoardDetailDTO | null> {
  await requireAdmin()
  if (!IdSchema.safeParse(id).success) return null
  const rt = getRuntime()
  const r = await rt.prisma.relayBoard.findUnique({
    where: { id },
    include: { channels: { select: { id: true, channel: true, label: true, purpose: true, equipmentId: true, equipment: { select: { name: true } } } } },
  })
  if (!r) return null
  const dto = toBoardDTO(rt, r, r.channels)
  const byChannel = new Map(r.channels.map((c) => [c.channel, c]))
  return {
    ...dto,
    channels: Array.from({ length: r.relayCount }, (_, i) => {
      const n = i + 1
      const c = byChannel.get(n)
      const purpose = c ? RelayPurposeSchema.safeParse(c.purpose) : null
      return {
        channel: n,
        state: dto.runtime.states[i] ?? null,
        binding: c ? { equipmentId: c.equipmentId, equipmentName: c.equipment.name, channelId: c.id, label: c.label, purpose: purpose?.success ? purpose.data : "generic" } : null,
      }
    }),
  }
}
