// Binding records ↔ live devices (§4.4). Resolution only ever returns a device from the scanned snapshot.
import type { MatchBy } from "@/lib/contracts/enums"
import type { ConsoleBindingRecord } from "@/lib/contracts/serial"
import { SERIAL_DETAIL } from "@/lib/i18n/serial"
import { adapterLabel, consoleAdapterLabel, interfaceLetter } from "@/lib/serial/format"
import type { SerialDevice } from "./enumerate"

export type MatchResult =
  | { status: "ok"; device: SerialDevice; via: string; warning: string | null }
  | { status: "missing" }
  | { status: "ambiguous"; candidates: SerialDevice[] }

/** Interface letter of a device: A/B/C/D on multi-interface adapters, if<N> on single-interface ones. */
export function letterOf(d: SerialDevice): string | null {
  if (!d.usb) return null
  return interfaceLetter(d.usb.interfaceNumber, d.usb.portNumber, d.usb.numInterfaces === 1)
}

function sameIf(d: SerialDevice, b: ConsoleBindingRecord): boolean {
  return d.usb !== null && d.usb.interfaceNumber === (b.usbInterface ?? 0) && d.usb.portNumber === (b.usbPortNumber ?? 0)
}

export function resolveBinding(b: ConsoleBindingRecord, devs: readonly SerialDevice[]): MatchResult {
  const usb = devs.filter((d) => d.usb !== null)

  if (b.matchBy === "adapter" && b.usbSerial) {
    const c = usb.filter((d) => d.usb?.vendorId === b.usbVendorId && d.usb?.productId === b.usbProductId && d.usb?.serial === b.usbSerial && sameIf(d, b))
    if (c.length === 1) return { status: "ok", device: c[0], via: "serial", warning: null }
    if (c.length > 1) {
      // Duplicate serial (clones): tie-break on the stored USB socket.
      const loc = c.filter((d) => d.usb?.idPath === b.usbIdPath)
      return loc.length === 1 ? { status: "ok", device: loc[0], via: "serial+usb-port", warning: null } : { status: "ambiguous", candidates: c }
    }
  }
  if ((b.matchBy === "adapter" || b.matchBy === "usb-port") && b.usbIdPath) {
    const l = usb.filter((d) => d.usb?.idPath === b.usbIdPath && sameIf(d, b))
    if (l.length === 1) {
      const d = l[0]
      const otherModel = d.usb?.vendorId !== b.usbVendorId || d.usb?.productId !== b.usbProductId
      const otherSerial = !!b.usbSerial && d.usb?.serial !== b.usbSerial
      if (b.matchBy === "adapter" && (otherModel || otherSerial)) return { status: "missing" } // a DIFFERENT adapter sits there
      return { status: "ok", device: d, via: "usb-port", warning: otherModel || otherSerial ? SERIAL_DETAIL.otherAdapterInSocket : null }
    }
    if (l.length > 1) return { status: "ambiguous", candidates: l }
  }
  // Literal paths (virtual, builtin, or links), each only where it keeps the mode's meaning: by-id is an identity
  // (adapter), by-path is a socket (usb-port). lastDevNode ("ttyUSBn") is never an identity outside path mode.
  const literal = b.matchBy === "path"
    ? [b.devicePath, b.byId, b.byPath, b.lastDevNode]
    : b.matchBy === "adapter" ? [b.byId, b.devicePath] : [b.byPath, b.devicePath]
  for (const p of literal) {
    if (!p) continue
    const d = devs.find((x) => x.devNode === p || x.byId.includes(p) || x.byPath.includes(p))
    if (!d) continue
    if (b.matchBy !== "path" && d.usb && b.usbSerial && d.usb.serial !== b.usbSerial) continue
    return { status: "ok", device: d, via: "path", warning: null }
  }
  return { status: "missing" }
}

/** The binding record for a picked port (canonical paths, default adapterLabel). */
export function bindingFromDevice(d: SerialDevice, matchBy?: MatchBy | null): ConsoleBindingRecord {
  const u = d.usb
  const uniqueSerial = !!u?.serial && !d.hints.includes("duplicate-serial")
  const mode: MatchBy = matchBy ?? (u ? (uniqueSerial ? "adapter" : "usb-port") : "path")
  const letter = letterOf(d)
  const label = u && letter ? consoleAdapterLabel(adapterLabel(u), letter) : `${d.name} (${d.kind === "virtual" ? "virtual" : "puerto del sistema"})`
  const byId = d.byId[0] ?? null
  const byPath = d.byPath[0] ?? null
  return {
    matchBy: mode,
    bindingKey: d.stableKey,
    byId,
    byPath,
    usbVendorId: u?.vendorId ?? null,
    usbProductId: u?.productId ?? null,
    usbSerial: u?.serial ?? null,
    usbInterface: u?.interfaceNumber ?? null,
    usbPortNumber: u?.portNumber ?? null,
    usbIdPath: u?.idPath ?? null,
    devicePath: u ? (mode === "path" ? byPath ?? byId ?? d.devNode : null) : d.devNode,
    adapterLabel: label.slice(0, 120),
    lastDevNode: d.devNode,
  }
}
