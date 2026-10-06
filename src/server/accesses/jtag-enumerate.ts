// USB JTAG cable enumerator (sysfs, like the serial one: no udev, no libusb). Lists /sys/bus/usb/devices and keeps the
// devices that look like JTAG cables: Digilent (FTDI with "Digilent" descriptors or Digilent's own VID), Xilinx
// Platform Cables (VID 03fd) and FTDI boards that say "JTAG". The serial number is what hw_server filters on.
import { promises as fs } from "node:fs"
import path from "node:path"
import type { JtagCableFamily } from "@/lib/contracts/accesses"
import { sanitizeDescriptor, locationLabel } from "@/lib/serial/format"

export interface JtagCable {
  serial: string | null
  vendorId: string
  productId: string
  manufacturer: string | null
  product: string | null
  family: JtagCableFamily
  busnum: number
  devnum: number
  portPath: string
  location: string
}

/** Which JTAG family a USB device belongs to, or null when it is not a JTAG cable. */
export function classifyJtag(d: { vendorId: string; productId: string; manufacturer: string | null; product: string | null }): JtagCableFamily | null {
  const vid = d.vendorId.toLowerCase()
  const text = `${d.manufacturer ?? ""} ${d.product ?? ""}`.toLowerCase()
  if (vid === "03fd") return "xilinx"
  if (vid === "1443" || text.includes("digilent")) return "digilent"
  if (vid === "0403" && text.includes("jtag")) return "ftdi"
  return null
}

async function readAttr(dir: string, attr: string): Promise<string | null> {
  try {
    const v = (await fs.readFile(path.join(dir, attr), "utf8")).trim()
    return v.length ? v : null
  } catch {
    return null
  }
}

/** USB devices only ("1-3.1"); interfaces ("1-3.1:1.0") and root hubs ("usb1") are skipped. */
const DEVICE_NAME = /^\d+-\d+(\.\d+)*$/

export async function scanJtagCables(sysRoot: string): Promise<JtagCable[]> {
  const dir = path.join(sysRoot, "bus", "usb", "devices")
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const found = await Promise.all(names.filter((n) => DEVICE_NAME.test(n)).map(async (name): Promise<JtagCable | null> => {
    const d = path.join(dir, name)
    const [vendorId, productId, manufacturer, product, serial, busnum, devnum] = await Promise.all([
      readAttr(d, "idVendor"), readAttr(d, "idProduct"), readAttr(d, "manufacturer"), readAttr(d, "product"), readAttr(d, "serial"),
      readAttr(d, "busnum"), readAttr(d, "devnum"),
    ])
    if (!vendorId || !productId || !/^[0-9a-fA-F]{4}$/.test(vendorId) || !/^[0-9a-fA-F]{4}$/.test(productId)) return null
    const desc = { vendorId: vendorId.toLowerCase(), productId: productId.toLowerCase(), manufacturer: sanitizeDescriptor(manufacturer), product: sanitizeDescriptor(product) }
    const family = classifyJtag(desc)
    if (!family) return null
    const cleanSerial = sanitizeDescriptor(serial)
    const bus = Number(busnum ?? name.split("-")[0])
    return {
      ...desc,
      serial: cleanSerial && /^[A-Za-z0-9._:-]{1,64}$/.test(cleanSerial) ? cleanSerial : null,
      family,
      busnum: Number.isFinite(bus) ? bus : 0,
      devnum: Number(devnum ?? 0) || 0,
      portPath: name,
      location: locationLabel({ busnum: Number.isFinite(bus) ? bus : 0, portPath: name }),
    }
  }))
  return found.filter((c): c is JtagCable => c !== null)
    .sort((a, b) => a.busnum - b.busnum || a.portPath.localeCompare(b.portPath, "en", { numeric: true }))
}
