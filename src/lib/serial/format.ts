// UI-safe serial labels (W1-A, §4.4). Pure: importable by server and UI code.
import type { ConsoleBindingRecord } from "@/lib/contracts/serial"

export interface AdapterIdentity {
  vendorId: string; productId: string
  manufacturer: string | null; product: string | null; serial: string | null
}

/** Descriptor strings come from devices under test: strip control characters (C0, DEL, C1), trim, cap at 64. */
export function sanitizeDescriptor(v: string | null | undefined): string | null {
  if (v == null) return null
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 64).trim()
  return s.length ? s : null
}

/**
 * "<manufacturer> <product> (<serial | sin nº de serie>)". The manufacturer is prefixed only when the product
 * does not already name it ("FTDI Quad RS232-HS", but "Digilent USB Device"); without strings, "vid:pid".
 */
export function adapterLabel(a: AdapterIdentity): string {
  const m = a.manufacturer?.trim() || null
  const p = a.product?.trim() || null
  let name: string
  if (p && m) name = p.toLowerCase().includes(m.toLowerCase()) ? p : `${m} ${p}`
  else name = p ?? m ?? `${a.vendorId}:${a.productId}`
  return `${name} (${a.serial?.trim() || "sin nº de serie"})`
}

/** "USB <busnum>-<ports>" from the sysfs device name ("1-3.1"). */
export function locationLabel(u: { busnum: number; portPath: string }): string {
  const ports = u.portPath.replace(/^\d+-/, "")
  return `USB ${u.busnum}-${ports}`
}

/** "A".."Z" from the interface number (FTDI A/B/C/D), "if<N>" on single-interface adapters; "+port" when > 0. */
export function interfaceLetter(interfaceNumber: number, portNumber: number, singleInterface: boolean): string {
  if (singleInterface || interfaceNumber > 25) return `if${interfaceNumber}${portNumber > 0 ? `.${portNumber}` : ""}`
  return `${String.fromCharCode(65 + interfaceNumber)}${portNumber > 0 ? portNumber : ""}`
}

const MAX_ADAPTER_LABEL = 120

/** Default `SerialConsole.adapterLabel`: "<adapter label> · <letter>" (≤ 120 chars, the letter is always kept). */
export function consoleAdapterLabel(adapter: string, letter: string): string {
  const suffix = ` · ${letter}`
  const room = MAX_ADAPTER_LABEL - suffix.length
  const head = adapter.length > room ? `${adapter.slice(0, room - 1)}…` : adapter
  return `${head}${suffix}`
}

type ShortBinding = Pick<ConsoleBindingRecord, "matchBy" | "bindingKey" | "usbSerial" | "usbInterface" | "usbPortNumber"
  | "usbIdPath" | "devicePath" | "lastDevNode" | "adapterLabel">

function letterOf(b: ShortBinding): string {
  const m = / · ([A-Z]\d*|if\d+(?:\.\d+)?)$/.exec(b.adapterLabel ?? "")
  if (m) return m[1]
  return interfaceLetter(b.usbInterface ?? 0, b.usbPortNumber ?? 0, false)
}

/** "3.1" from "pci-0000:00:14.0-usb-0:3.1:1.2" (the hub port path; the bus number is not part of the binding). */
function portsOfIdPath(idPath: string): string | null {
  const m = /-usb-\d+:([\d.]+):\d+\.\d+$/.exec(idPath)
  return m ? m[1] : null
}

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}

/**
 * Short adapter name for the channel strip (`ConsoleSummaryDTO.adapterShort`), from the binding record alone so it
 * works while the adapter is unplugged: "FT4ABCDE·B", "USB 3.1·B" (no unique serial), "ttyV0" (virtual/builtin).
 */
export function adapterShort(b: ShortBinding | null): string | null {
  if (!b) return null
  const isUsb = b.bindingKey.startsWith("usb:") || b.bindingKey.startsWith("path:")
  if (b.bindingKey.startsWith("usb:") && b.usbSerial) return `${b.usbSerial}·${letterOf(b)}`
  if (isUsb) {
    const fromKey = /^path:(.+):if\d+:p\d+$/.exec(b.bindingKey)?.[1] ?? null
    const ports = (b.usbIdPath ? portsOfIdPath(b.usbIdPath) : null) ?? (fromKey ? portsOfIdPath(fromKey) ?? fromKey.replace(/^\d+-/, "") : null)
    if (ports) return `USB ${ports}·${letterOf(b)}`
  }
  const p = b.devicePath ?? b.lastDevNode
  if (p) return basename(p)
  if (b.bindingKey.startsWith("dev:")) return basename(b.bindingKey.slice(4))
  if (b.bindingKey.startsWith("virtual:")) return basename(b.bindingKey.slice(8))
  return null
}

function asciiSlug(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "x"
}

/** Download names for capture files (§7.3): ASCII slug `<equipo>_<KEY>_<file>` plus the UTF-8 original. */
export function captureDownloadName(equipmentName: string, key: string, file: string): { ascii: string; utf8: string } {
  return {
    ascii: `${asciiSlug(equipmentName)}_${asciiSlug(key)}_${file}`,
    utf8: `${equipmentName}_${key}_${file}`,
  }
}
