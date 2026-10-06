import "server-only"
import type { ShellDTO } from "@/lib/contracts/system"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { readAccountTheme } from "./viewer"

/** Data for the app shell (§7.4): lab name, banner, viewer (with the account theme), build, server time, own reservations and admin chips. */
export async function getShellData(viewer: AuthUser): Promise<ShellDTO> {
  const rt = getRuntime()
  const s = rt.settings.get()
  const mine = rt.reservations.list().filter((r) => r.holderId === viewer.id)
  const theme = await readAccountTheme(rt.prisma, viewer.id)
  const names = mine.length
    ? new Map((await rt.prisma.equipment.findMany({ where: { id: { in: mine.map((r) => r.equipmentId) } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]))
    : new Map<string, string>()
  return {
    labName: s.labName,
    bannerText: s.bannerText,
    viewer: { id: viewer.id, username: viewer.username, name: viewer.name, isAdmin: viewer.isAdmin, mustChangePassword: viewer.mustChangePassword, theme },
    version: rt.config.build.version,
    buildId: rt.config.build.buildId,
    serverNow: new Date().toISOString(),
    reservationWarningMin: s.reservationWarningMin,
    myReservations: mine
      .filter((r) => names.has(r.equipmentId))
      .map((r) => ({ equipmentId: r.equipmentId, equipmentName: names.get(r.equipmentId) ?? "", expiresAt: r.expiresAt })),
    unassignedPorts: viewer.isAdmin ? rt.serial.discovery.unassignedCount() : null,
    capturePaused: viewer.isAdmin ? rt.serial.stats().capture.state === "paused-disk" : null,
    filesEnabled: rt.config.files.enabled,
  }
}
