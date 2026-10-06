// Network interfaces from sysfs (<root>/class/net/*), like the serial and JTAG enumerators: no udev. USB adapters are
// recognised by their device path (…/usbN/<bus>-<port>/<bus>-<port>:<cfg>.<if>); their USB descriptors come from the
// parent USB device. Virtual interfaces (no device: docker, bridges, veth, tun, lo) are skipped.
import { promises as fs } from "node:fs"
import path from "node:path"
import { locationLabel, sanitizeDescriptor } from "@/lib/serial/format"

export interface NetIface {
  ifname: string
  mac: string
  usb: boolean
  /** "usb", "pci" (a card of the server) or "other" (platform, SDIO…). */
  bus: "usb" | "pci" | "other"
  wireless: boolean
  driver: string | null
  vendorId: string | null
  productId: string | null
  manufacturer: string | null
  product: string | null
  serial: string | null
  location: string | null
  carrier: boolean | null
  operUp: boolean
  speedMbps: number | null
}

async function attr(dir: string, name: string): Promise<string | null> {
  try {
    const v = (await fs.readFile(path.join(dir, name), "utf8")).trim()
    return v.length ? v : null
  } catch {
    return null
  }
}
async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

const USB_IFACE = /^(\d+)-([\d.]+):\d+\.\d+$/
const PCI_DEV = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/i
const IFNAME = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,14}$/
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

export async function scanNetInterfaces(sysRoot: string): Promise<NetIface[]> {
  const base = path.join(sysRoot, "class", "net")
  let names: string[]
  try { names = await fs.readdir(base) } catch { return [] }
  const found = await Promise.all(names.filter((n) => IFNAME.test(n) && n !== "lo").map(async (ifname): Promise<NetIface | null> => {
    const dir = path.join(base, ifname)
    let device: string
    try { device = await fs.realpath(path.join(dir, "device")) } catch { return null } // virtual
    const [mac, type, carrier, operstate, speed] = await Promise.all([attr(dir, "address"), attr(dir, "type"), attr(dir, "carrier"), attr(dir, "operstate"), attr(dir, "speed")])
    if (type !== "1" || !mac || !MAC.test(mac.toLowerCase())) return null
    const wireless = (await exists(path.join(dir, "wireless"))) || (await exists(path.join(dir, "phy80211")))
    let driver: string | null = null
    try { driver = path.basename(await fs.realpath(path.join(device, "driver"))) } catch { /* none */ }
    const m = USB_IFACE.exec(path.basename(device))
    const usb = !!m && device.split(path.sep).some((s) => /^usb\d+$/.test(s))
    let desc = { vendorId: null as string | null, productId: null as string | null, manufacturer: null as string | null, product: null as string | null, serial: null as string | null, location: null as string | null }
    if (usb && m) {
      const u = path.dirname(device)
      const [v, p, mf, pr, sn, busnum] = await Promise.all([attr(u, "idVendor"), attr(u, "idProduct"), attr(u, "manufacturer"), attr(u, "product"), attr(u, "serial"), attr(u, "busnum")])
      const bus = Number(busnum ?? m[1])
      desc = {
        vendorId: v && /^[0-9a-fA-F]{4}$/.test(v) ? v.toLowerCase() : null, productId: p && /^[0-9a-fA-F]{4}$/.test(p) ? p.toLowerCase() : null,
        manufacturer: sanitizeDescriptor(mf), product: sanitizeDescriptor(pr), serial: sanitizeDescriptor(sn),
        location: locationLabel({ busnum: Number.isFinite(bus) ? bus : 0, portPath: path.basename(u) }),
      }
    }
    const sp = Number(speed)
    const bus = usb ? "usb" as const : PCI_DEV.test(path.basename(device)) ? "pci" as const : "other" as const
    return {
      ifname, mac: mac.toLowerCase(), usb, bus, wireless, driver, ...desc,
      carrier: carrier === "1" ? true : carrier === "0" ? false : null,
      operUp: operstate === "up" || operstate === "unknown",
      speedMbps: Number.isFinite(sp) && sp > 0 ? sp : null,
    }
  }))
  return found.filter((x): x is NetIface => x !== null).sort((a, b) => Number(b.usb) - Number(a.usb) || a.ifname.localeCompare(b.ifname))
}
