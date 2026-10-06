import "server-only"
// Discovered relay boards (§7.4, W1-B): the known-boards map (passive, active and scan results, §4.10).
import type { DiscoveredBoardDTO } from "@/lib/contracts/relays"
import { requireAdmin } from "@/server/authz"
import { getRuntime } from "@/server/runtime/registry"

export async function getDiscoveredBoards(): Promise<DiscoveredBoardDTO[]> {
  await requireAdmin()
  return getRuntime().relays.discovery.known()
}

/** `/placas/nueva?desde=<key>`: a discovered board, or null when it is no longer known (e.g. after a restart). */
export async function getDiscoveredBoard(key: string): Promise<DiscoveredBoardDTO | null> {
  await requireAdmin()
  if (!key || key.length > 64) return null
  return getRuntime().relays.discovery.find(key)
}
