import "server-only"
// Serial read side (W1-A, §7.4): Descubrimiento > Puertos serie, and the capture file list of a console.
import { IdSchema } from "@/lib/contracts/common"
import type { CaptureFileDTO, SerialPageDTO } from "@/lib/contracts/serial"
import { SERIAL_HINT_CHECKS, type HealthCheckDTO } from "@/lib/contracts/system"
import { errorMessage } from "@/lib/i18n/errors"
import { consoleForUser } from "@/server/access"
import { DomainError } from "@/server/errors"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"

/** Admin only: the annotated snapshot, the permission hints for an empty picker and the poke/JTAG policy. */
export async function getSerialPageData(user: AuthUser): Promise<SerialPageDTO> {
  if (!user.isAdmin) throw new DomainError("FORBIDDEN", errorMessage("FORBIDDEN"))
  const rt = getRuntime()
  const ids: readonly string[] = SERIAL_HINT_CHECKS
  let serialHints: HealthCheckDTO[] = []
  try {
    serialHints = (await rt.ops.health.run({ only: SERIAL_HINT_CHECKS })).filter((h) => ids.includes(h.id))
  } catch (err) {
    rt.log.child("serial").warn("No se pudieron calcular las pistas de permisos serie", { error: String(err) })
  }
  return {
    snapshot: rt.serial.discovery.toDTO(),
    serialHints,
    allowPoke: rt.config.serial.allowPoke,
    hideJtag: rt.config.serial.hideJtag,
  }
}

/** Capture files of a visible console, newest first; `.input.log` files only for admins. */
export async function getConsoleCaptureFiles(user: AuthUser, consoleId: string): Promise<CaptureFileDTO[]> {
  if (!IdSchema.safeParse(consoleId).success) return []
  const rt = getRuntime()
  const c = await consoleForUser(rt.prisma, user, consoleId)
  if (!c) return []
  return rt.serial.consoles.listCaptureFiles(c.consoleId, { includeInput: user.isAdmin })
}
