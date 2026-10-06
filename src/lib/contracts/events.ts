import { z } from "zod"
import type { IsoDate } from "./common"
import type { ReservationCause, ReservationDTO } from "./reservations"
import type { ConsoleRuntimeDTO, SerialSnapshotDTO } from "./serial"
import type { BoardRuntimeDTO, DiscoveredBoardDTO, RelayChannelStateDTO } from "./relays"
import type { AccessRuntimeDTO, CableLabelDTO, JtagSnapshotDTO } from "./accesses"
import type { CopyJobDTO, ExportJobDTO, FilesChange, FilesRootId, SendJobDTO } from "./files"
import type { EquipnetStatusDTO } from "./equipnet"
import type { ThemePref } from "./enums"

export type Audience =
  | { kind: "all" }
  | { kind: "admins" }
  | { kind: "user"; userId: string }
  /** One user and every administrator (each viewer gets the event once). */
  | { kind: "userAndAdmins"; userId: string }
  | { kind: "equipment"; equipmentId: string }

export type ServerEvent =
  | { type: "hello"; serverNow: IsoDate; buildId: string; version: string; viewerId: string }
  | { type: "heartbeat"; serverNow: IsoDate }
  | { type: "reservation.changed"; equipmentId: string; equipmentName: string; reservation: ReservationDTO | null; cause: ReservationCause; byName: string | null; serverNow: IsoDate }
  | { type: "console.status"; equipmentId: string; consoleId: string; runtime: ConsoleRuntimeDTO }
  | { type: "console.activity"; equipmentId: string; consoleId: string; lastLine: string | null; lastRxAt: IsoDate }
  | { type: "relay.state"; equipmentId: string; channels: RelayChannelStateDTO[]; at: IsoDate }
  | { type: "board.status"; boardId: string; runtime: BoardRuntimeDTO }
  | { type: "equipment.changed"; equipmentId: string; change: "created" | "updated" | "deleted" }
  | { type: "serial.changed"; snapshot: SerialSnapshotDTO; change: { kind: "adapter-added" | "adapter-changed" | "adapter-removed" | "port-added" | "port-removed" | "rescan"; label: string } }
  | { type: "relay.discovered"; board: DiscoveredBoardDTO }
  | { type: "discovery.progress"; runId: string; done: number; total: number }
  | { type: "settings.changed"; labName: string; bannerText: string | null; reservationWarningMin: number }
  | { type: "viewer.changed"; userId: string }
  | { type: "session.revoked"; userId: string; reason: "disabled" | "deleted" | "password-changed" | "revoked" | "expired" }
  | { type: "toast"; level: "info" | "warn"; message: string }
  | { type: "access.status"; equipmentId: string; accessId: string; runtime: AccessRuntimeDTO }
  | { type: "jtag.changed"; snapshot: JtagSnapshotDTO; change: { kind: "cable-added" | "cable-removed" | "rescan" | "labels"; label: string } }
  | { type: "cable-labels.changed"; labels: CableLabelDTO[] }
  /** "Archivos": `dirs` are the relative folders of `root` whose listing changed ("" = the root). Audience: all. */
  | { type: "files.changed"; root: FilesRootId; dirs: string[]; change: FilesChange; names: string[]; byName: string }
  /** «Enviar a equipo»: one send changed (state, progress every ~0.5 s). Audience: the user who started it. */
  | { type: "files.send"; job: SendJobDTO }
  /** «Copiar a una carpeta del servidor»: one copy changed (state, progress every ~0.5 s). Audience: the user who started it. */
  | { type: "files.copy"; job: CopyJobDTO }
  /** «Descargas» (the profile's download script): one job changed; `lines` are the log lines appended since the previous
   * event (the job's own `log` is empty here). Audience: the user who started it and the administrators. */
  | { type: "files.export"; job: ExportJobDTO; lines: string[] }
  /** "Red de equipos": adapters, server VLANs, switch, ports and the running job. Audience: admins. */
  | { type: "equipnet.changed"; status: EquipnetStatusDTO }
  /** The account's preferences changed (the theme, D39): the user's other tabs and PCs apply it. Audience: that user. */
  | { type: "account.prefs.changed"; userId: string; theme: ThemePref }
export type ServerEventType = ServerEvent["type"]

export const SERVER_EVENT_TYPES = ["hello", "heartbeat", "reservation.changed", "console.status", "console.activity",
  "relay.state", "board.status", "equipment.changed", "serial.changed", "relay.discovered", "discovery.progress",
  "settings.changed", "viewer.changed", "session.revoked", "toast", "access.status", "jtag.changed", "cable-labels.changed", "files.changed", "files.send", "files.copy", "files.export", "equipnet.changed", "account.prefs.changed"] as const satisfies readonly ServerEventType[]
/** Client-side guard: validates the discriminant only (the server is trusted). */
export const ServerEventEnvelopeSchema = z.looseObject({ type: z.enum(SERVER_EVENT_TYPES) })
