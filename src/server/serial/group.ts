// Groups the ttys of one physical USB adapter (§4.4).
import type { SerialHint } from "@/lib/contracts/serial"
import { adapterLabel, locationLabel } from "@/lib/serial/format"
import type { SerialDevice } from "./enumerate"

export interface UsbSerialAdapter {
  /** Where it is plugged: idPath without ":<cfg>.<iface>", e.g. "pci-0000:00:14.0-usb-0:3.1". */
  locationKey: string
  /** Which adapter it is: "vid:pid:serial", or null without a (unique) serial. */
  identityKey: string | null
  vendorId: string
  productId: string
  manufacturer: string | null
  product: string | null
  serial: string | null
  busnum: number
  portPath: string
  label: string
  location: string
  hints: SerialHint[]
  /** Ordered by (interfaceNumber, portNumber): the physical channel order (FTDI A/B/C/D, CP2105 ECI/SCI). */
  ports: SerialDevice[]
}

const ADAPTER_HINTS: readonly SerialHint[] = ["no-serial", "duplicate-serial", "jtag-probable"]

export function locationKeyOf(d: SerialDevice): string | null {
  if (!d.usb) return null
  return d.usb.idPath?.replace(/:\d+\.\d+$/, "") ?? d.usb.portPath
}

export function groupByAdapter(devs: readonly SerialDevice[]): UsbSerialAdapter[] {
  const groups = new Map<string, UsbSerialAdapter>()
  for (const d of devs) {
    const u = d.usb
    const locationKey = locationKeyOf(d)
    if (!u || !locationKey) continue
    let g = groups.get(locationKey)
    if (!g) {
      g = {
        locationKey,
        identityKey: u.serial && !d.hints.includes("duplicate-serial") ? `${u.vendorId}:${u.productId}:${u.serial}` : null,
        vendorId: u.vendorId,
        productId: u.productId,
        manufacturer: u.manufacturer,
        product: u.product,
        serial: u.serial,
        busnum: u.busnum,
        portPath: u.portPath,
        label: adapterLabel(u),
        location: locationLabel(u),
        hints: [],
        ports: [],
      }
      groups.set(locationKey, g)
    }
    g.ports.push(d)
    for (const h of d.hints) if (ADAPTER_HINTS.includes(h) && !g.hints.includes(h)) g.hints.push(h)
  }
  for (const g of groups.values()) {
    g.ports.sort((a, b) => (a.usb?.interfaceNumber ?? 0) - (b.usb?.interfaceNumber ?? 0) || (a.usb?.portNumber ?? 0) - (b.usb?.portNumber ?? 0))
    g.hints.sort((a, b) => ADAPTER_HINTS.indexOf(a) - ADAPTER_HINTS.indexOf(b))
  }
  return [...groups.values()].sort((a, b) => a.locationKey.localeCompare(b.locationKey, "en", { numeric: true }))
}
