import type { SerialSnapshotDTO } from "@/lib/contracts/serial"

/**
 * Unassigned serial ports, with the server's predicate (W1-A `rt.serial.discovery.unassignedCount()`, the first value
 * of ShellDTO.unassignedPorts): every USB port and every virtual or builtin port ("others") without a console
 * assignment. JTAG-probable ports are skipped only while RM_SERIAL_HIDE_JTAG hides them, which the snapshot reports
 * as `hiddenJtag > 0`.
 */
export function countUnassignedPorts(s: SerialSnapshotDTO): number {
  const hideJtag = s.hiddenJtag > 0
  let n = 0
  for (const p of [...s.adapters.flatMap((a) => a.ports), ...s.others]) {
    if (hideJtag && p.hints.includes("jtag-probable")) continue
    if (!p.assignment) n++
  }
  return n
}
