// Port row status (§8.9 Descubrimiento): Libre / Asignado a … / En uso por otro programa / Sin permiso / No visible.
import { BanIcon, CircleIcon, EyeOffIcon, Link2Icon, ShieldAlertIcon, type LucideIcon } from "lucide-react"
import type { SerialHint, SerialPortDTO } from "@/lib/contracts/serial"
import { serial } from "@/lib/i18n/shell"

export interface PortStatusView { tone: "ok" | "warn" | "danger" | "neutral"; icon: LucideIcon; label: string; free: boolean }

export function portStatusView(p: SerialPortDTO): PortStatusView {
  if (p.assignment) {
    return { tone: "neutral", icon: Link2Icon, label: serial.assignedTo(p.assignment.equipmentName, p.assignment.consoleKey), free: false }
  }
  if (!p.accessible) {
    return p.accessError === "EACCES"
      ? { tone: "danger", icon: ShieldAlertIcon, label: serial.noPermission, free: false }
      : { tone: "danger", icon: EyeOffIcon, label: serial.notVisible, free: false }
  }
  if (p.inUse === "other") return { tone: "warn", icon: BanIcon, label: serial.busyOther, free: false }
  return { tone: "neutral", icon: CircleIcon, label: serial.free, free: true }
}

const HINT: Record<SerialHint, string> = {
  "no-serial": serial.hintNoSerial,
  "duplicate-serial": serial.hintDuplicateSerial,
  "jtag-probable": serial.hintJtag,
  simulated: serial.hintSimulated,
  builtin: serial.hintBuiltin,
}

export const hintLabel = (h: SerialHint): string => HINT[h]

/** "A", "B"… for multi-interface adapters; empty for single-interface and virtual ports (their path says it all). */
export function portShortName(p: SerialPortDTO): string {
  return p.interfaceLetter ?? ""
}
