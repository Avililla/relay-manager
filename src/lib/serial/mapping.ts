// "Asignar en orden" (W1-A, §4.4). Pure: used by the wizard (W2-B) and Descubrimiento (W2-C).
import type { PortGroup, SerialPortDTO } from "@/lib/contracts/serial"

function physicalOrder(a: SerialPortDTO, b: SerialPortDTO): number {
  const ai = a.usb?.interfaceNumber ?? 0
  const bi = b.usb?.interfaceNumber ?? 0
  return ai - bi || (a.usb?.portNumber ?? 0) - (b.usb?.portNumber ?? 0)
}

/**
 * Maps the group's ports in physical order (interface, port) onto the unbound slots in order. `skipInterfaces`
 * applies to USB adapters only (never to the pseudo-group of virtual and builtin ports). With `onlyFree`, ports that
 * are assigned or in use are skipped. Extra ports stay unused; extra slots stay unmapped.
 */
export function suggestMapping(
  slots: ReadonlyArray<{ key: string; bound: boolean }>,
  group: PortGroup,
  opts: { skipInterfaces: readonly number[]; onlyFree: boolean },
): Array<{ slotIndex: number; stableKey: string }> {
  const skip = new Set(opts.skipInterfaces)
  const ports = (group.adapter ? [...group.ports].sort(physicalOrder) : [...group.ports])
    .filter((p) => !group.adapter || !p.usb || !skip.has(p.usb.interfaceNumber))
    .filter((p) => !opts.onlyFree || (p.assignment === null && p.inUse === null))
  const free = slots.map((s, i) => ({ s, i })).filter(({ s }) => !s.bound)
  const out: Array<{ slotIndex: number; stableKey: string }> = []
  for (let k = 0; k < Math.min(free.length, ports.length); k++) out.push({ slotIndex: free[k].i, stableKey: ports[k].stableKey })
  return out
}
