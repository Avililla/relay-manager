import { z } from "zod"
import { IdSchema, IsoDateSchema, type IsoDate, type JsonValue } from "./common"

export const AUDIT_ACTIONS = [
  "auth.login.ok", "auth.login.fail", "auth.logout", "auth.setup.completed", "auth.setup.fail", "auth.password.changed",
  "auth.denied",
  "user.create", "user.update", "user.disable", "user.enable", "user.delete", "user.password.reset",
  "role.create", "role.update", "role.delete",
  "equipment.create", "equipment.update", "equipment.bindings", "equipment.delete",
  "template.create", "template.update", "template.delete", "template.reset", "template.reload", "template.propagate",
  "board.create", "board.update", "board.delete", "board.enable", "board.disable", "board.test", "board.host.update",
  "reservation.reserve", "reservation.renew", "reservation.release", "reservation.expire", "reservation.force-release",
  "console.session.open", "console.session.close", "console.release", "console.retake", "console.clear", "console.break",
  "console.log.download", "console.probe", "console.poke", "console.preview", "console.capture.purge",
  "relay.set", "relay.pulse",
  "discovery.relay.udp", "discovery.relay.scan", "discovery.serial.rescan", "discovery.jtag.rescan",
  "settings.update",
  "backup.create", "backup.delete", "backup.download", "backup.restore",
  "config.export", "config.import",
  "system.start", "system.stop",
  "audit.purge", "audit.export",
  "access.start", "access.stop", "access.error", "access.connect", "access.disconnect",
  "cable.label.create", "cable.label.update", "cable.label.delete",
  "files.upload", "files.download", "files.mkdir", "files.rename", "files.move", "files.delete", "files.send", "files.send.login", "files.copy", "files.copy.mkdir",
  "files.copy.mount", "files.copy.unmount", "files.copy.elevate", "files.copy.forget", "files.export",
  "equipnet.update", "equipnet.host", "equipnet.discover", "equipnet.switch.apply", "equipnet.switch.restore",
  "equipnet.switch.remove", "equipnet.switch.backup",
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]
export const AUDIT_CATEGORIES = ["auth", "user", "role", "equipment", "template", "board", "reservation", "console",
  "relay", "discovery", "settings", "backup", "config", "system", "audit", "access", "cable", "files", "equipnet"] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]
export type AuditOutcome = "ok" | "denied" | "error"
export type AuditTargetType = "console" | "relay" | "board" | "user" | "role" | "template" | "equipment" | "settings"
  | "backup" | "discovery" | "port" | "config" | "session" | "access" | "cable" | "file" | "switch" | "network"

export interface AuditEventDTO {
  id: number; at: IsoDate
  actorKind: "user" | "system" | "cli"; actorId: string | null; actorName: string; ip: string | null
  action: AuditAction; outcome: AuditOutcome
  equipmentId: string | null; equipmentName: string | null
  targetType: AuditTargetType | null; targetId: string | null; targetName: string | null
  detail: JsonValue | null
}
export const AuditQuerySchema = z.object({
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  actorId: IdSchema.optional(),
  equipmentId: IdSchema.optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  outcome: z.enum(["ok", "denied", "error"]).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type AuditQuery = z.infer<typeof AuditQuerySchema>
