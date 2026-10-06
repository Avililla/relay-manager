// sysfs serial enumerator (§4.4, D1): no udevadm, no native code. SerialPort.list() only off Linux.
import { promises as fs, constants as fsc } from "node:fs"
import path from "node:path"
import type { SerialHint } from "@/lib/contracts/serial"
import { sanitizeDescriptor } from "@/lib/serial/format"
import { expandGlob, toCanonical, toOpenPath } from "./paths"

export type PortKind = "usb" | "pci" | "platform" | "virtual"

export interface UsbInfo {
  readonly vendorId: string
  readonly productId: string
  readonly manufacturer: string | null
  readonly product: string | null
  readonly serial: string | null
  readonly interfaceNumber: number
  readonly interfaceName: string | null
  readonly portNumber: number
  /** udev's ID_PATH computed from sysfs: "pci-0000:00:14.0-usb-0:3.1:1.2". */
  readonly idPath: string | null
  /** sysfs name of the USB device: "1-3.1". */
  readonly portPath: string
  readonly busnum: number
  readonly devnum: number
  readonly numInterfaces: number | null
}

export interface SerialDevice {
  name: string
  /** Canonical host path ("/dev/ttyUSB2") or the literal virtual path. Stored and shown. */
  devNode: string
  /** The path this process opens (devRoot-mapped). */
  openPath: string
  kind: PortKind
  driver: string | null
  usb: UsbInfo | null
  byId: string[]
  byPath: string[]
  stableKey: string
  accessible: boolean
  accessError: string | null
  hints: SerialHint[]
  /** Virtual ports: the resolved target (a re-created pty link changes it). */
  target: string | null
}

interface Described { devReal: string; usbDir: string | null; devnum: number | null; kind: PortKind; driver: string | null; usb: UsbInfo | null }
export interface DescribeCache { entries: Map<string, Described> }
export function createDescribeCache(): DescribeCache {
  return { entries: new Map() }
}

export interface PlatformPortInfo { path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }

export interface ScanOptions {
  sysRoot: string
  devRoot: string
  extraGlobs: readonly string[]
  includeBuiltin: boolean
  /** Caches the USB description per (name, busnum, devnum): a steady-state scan re-reads one attribute per port. */
  cache?: DescribeCache
  platform?: NodeJS.Platform
  /** Non-Linux fallback (tests inject it). */
  listPorts?: () => Promise<PlatformPortInfo[]>
}

export const USB_TTY = /^tty(USB|ACM|XRUSB|WCHUSB|CH\d+USB)\d+$/
const BUILTIN_TTY = /^tty(S|AMA|PS|mxc|SAC|O)\d+$/

async function readAttr(dir: string, attr: string): Promise<string | null> {
  try {
    const v = (await fs.readFile(path.join(dir, attr), "utf8")).trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function findAncestorWith(start: string, marker: string, stop: string): Promise<string | null> {
  let dir = start
  while (dir.startsWith(stop) && dir !== stop && dir !== path.dirname(dir)) {
    if (await exists(path.join(dir, marker))) return dir
    dir = path.dirname(dir)
  }
  return null
}

async function driverName(dir: string): Promise<string | null> {
  try {
    return path.basename(await fs.readlink(path.join(dir, "driver")))
  } catch {
    return null
  }
}

/** Kernel name → canonical /dev/serial/by-id|by-path links pointing at it. The directory may not exist. */
async function readLinks(devRoot: string, kind: "by-id" | "by-path"): Promise<Map<string, string[]>> {
  const dir = path.join(devRoot, "serial", kind)
  const map = new Map<string, string[]>()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return map
  }
  await Promise.all(entries.map(async (e) => {
    try {
      const target = path.basename(path.resolve(dir, await fs.readlink(path.join(dir, e))))
      const list = map.get(target) ?? []
      list.push(`/dev/serial/${kind}/${e}`)
      map.set(target, list)
    } catch {
      /* dangling or not a link */
    }
  }))
  for (const list of map.values()) list.sort()
  return map
}

/** ".../0000:00:14.0/usb1/1-3/1-3.1/1-3.1:1.2" → "pci-0000:00:14.0-usb-0:3.1:1.2" (udev path_id). */
export function computeIdPath(ifaceRealPath: string): string | null {
  const parts = ifaceRealPath.split(path.sep)
  const m = /^\d+-(.+)$/.exec(parts[parts.length - 1])
  if (!m) return null
  const usbIdx = parts.findIndex((p) => /^usb\d+$/.test(p))
  if (usbIdx <= 0) return null
  const host = parts[usbIdx - 1]
  const prefix = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/.test(host) ? `pci-${host}` : `platform-${host}`
  return `${prefix}-usb-0:${m[1]}`
}

async function describeUsb(ttyDeviceReal: string, sysRoot: string): Promise<{ usb: UsbInfo; usbDir: string } | null> {
  // ttyUSB: device → …/1-3.1:1.2/ttyUSB2 (usb-serial port: port_number); ttyACM: device → …/1-4:1.2 (the interface)
  const ifaceDir = await findAncestorWith(ttyDeviceReal, "bInterfaceNumber", sysRoot)
  if (!ifaceDir) return null
  const usbDir = path.dirname(ifaceDir)
  const [vendorId, productId, manufacturer, product, serial, busnum, devnum, numIf, ifNum, ifName, portNum] = await Promise.all([
    readAttr(usbDir, "idVendor"), readAttr(usbDir, "idProduct"), readAttr(usbDir, "manufacturer"), readAttr(usbDir, "product"),
    readAttr(usbDir, "serial"), readAttr(usbDir, "busnum"), readAttr(usbDir, "devnum"), readAttr(usbDir, "bNumInterfaces"),
    readAttr(ifaceDir, "bInterfaceNumber"), readAttr(ifaceDir, "interface"), readAttr(ttyDeviceReal, "port_number"),
  ])
  if (!vendorId || !productId || !/^[0-9a-fA-F]{4}$/.test(vendorId) || !/^[0-9a-fA-F]{4}$/.test(productId)) return null
  // Attributes every USB device/interface has: a null means it was torn down while we read.
  if (ifNum === null || busnum === null || devnum === null) return null
  const n = (v: string | null, radix = 10): number => {
    const x = v === null ? NaN : parseInt(v, radix)
    return Number.isFinite(x) && x >= 0 ? x : 0
  }
  const interfaceNumber = Math.min(n(ifNum, 16), 255)
  return {
    usbDir,
    usb: {
      vendorId: vendorId.toLowerCase(),
      productId: productId.toLowerCase(),
      manufacturer: sanitizeDescriptor(manufacturer),
      product: sanitizeDescriptor(product),
      serial: sanitizeDescriptor(serial),
      interfaceNumber,
      interfaceName: sanitizeDescriptor(ifName),
      portNumber: Math.min(n(portNum), 255),
      idPath: computeIdPath(ifaceDir),
      portPath: path.basename(usbDir),
      busnum: n(busnum),
      devnum: n(devnum),
      numInterfaces: numIf === null ? null : n(numIf.trim()) || null,
    },
  }
}

async function accessOf(p: string): Promise<{ ok: boolean; err: string | null }> {
  try {
    await fs.access(p, fsc.R_OK | fsc.W_OK)
    return { ok: true, err: null }
  } catch (e) {
    return { ok: false, err: (e as NodeJS.ErrnoException).code ?? "EUNKNOWN" }
  }
}

function jtagProbable(u: UsbInfo): boolean {
  const s = `${u.manufacturer ?? ""} ${u.product ?? ""}`.toLowerCase()
  return s.includes("digilent") || s.includes("jtag") || u.vendorId === "03fd"
}

async function describeTty(name: string, classDir: string, sysRoot: string, cache: DescribeCache | undefined, isUsb: boolean): Promise<Described | null> {
  let devReal: string
  try {
    devReal = await fs.realpath(path.join(classDir, name, "device"))
  } catch {
    return null // a tty without "device" is virtual (console, ptmx…)
  }
  const cached = cache?.entries.get(name)
  if (cached && cached.devReal === devReal) {
    if (!cached.usbDir) return cached
    const devnum = await readAttr(cached.usbDir, "devnum")
    if (devnum !== null && Number(devnum) === cached.devnum) return cached
  }
  let d: Described
  if (isUsb) {
    // A ttyUSB/ttyACM always hangs off a USB interface. No USB ancestor means it is being unplugged while we
    // scan: skip it for this scan and cache nothing, never report it as a non-USB port.
    const u = await describeUsb(devReal, sysRoot)
    if (!u) return null
    const driver = (await driverName(devReal)) ?? (await driverName(path.dirname(devReal)))
    // Unplugged while we read: attributes/driver read as null would give a wrong interface, serial or driver.
    // The tty is unregistered before its parents (port, interface, device) go, so if it is still
    // registered now every read above saw the device whole.
    if ((await fs.realpath(path.join(classDir, name, "device")).catch(() => null)) !== devReal) return null
    d = { devReal, usbDir: u.usbDir, devnum: u.usb.devnum, kind: "usb", driver, usb: u.usb }
  } else {
    // 8250 placeholders (nr_uarts) have type 0 = PORT_UNKNOWN: no UART behind them.
    const type = await readAttr(path.join(classDir, name), "type")
    if (type === "0") return null
    d = { devReal, usbDir: null, devnum: null, kind: devReal.includes("/pci") ? "pci" : "platform", driver: await driverName(devReal), usb: null }
  }
  cache?.entries.set(name, d)
  return d
}

function usbStableKey(u: UsbInfo, unique: boolean): string {
  return unique && u.serial
    ? `usb:${u.vendorId}:${u.productId}:${u.serial}:if${u.interfaceNumber}:p${u.portNumber}`
    : `path:${u.idPath ?? u.portPath}:if${u.interfaceNumber}:p${u.portNumber}`
}

async function scanPlatform(opts: ScanOptions): Promise<SerialDevice[]> {
  const list = opts.listPorts ?? (async () => {
    const { SerialPort } = await import("serialport")
    return SerialPort.list()
  })
  let ports: PlatformPortInfo[] = []
  try {
    ports = await list()
  } catch {
    return []
  }
  return ports.map((p) => ({
    name: path.basename(p.path), devNode: p.path, openPath: p.path, kind: "platform" as const, driver: null, usb: null,
    byId: [], byPath: [], stableKey: `dev:${p.path}`, accessible: true, accessError: null, hints: [], target: null,
  }))
}

export async function scanSerialPorts(opts: ScanOptions): Promise<SerialDevice[]> {
  if ((opts.platform ?? process.platform) !== "linux") return scanPlatform(opts)
  const classDir = path.join(opts.sysRoot, "class", "tty")
  const [names, byIdMap, byPathMap] = await Promise.all([
    fs.readdir(classDir).catch(() => [] as string[]),
    readLinks(opts.devRoot, "by-id"),
    readLinks(opts.devRoot, "by-path"),
  ])

  const scanned = await Promise.all(names.map(async (name): Promise<SerialDevice | null> => {
    const isUsb = USB_TTY.test(name)
    const isBuiltin = !isUsb && BUILTIN_TTY.test(name)
    if (!isUsb && !(isBuiltin && opts.includeBuiltin)) return null
    const d = await describeTty(name, classDir, opts.sysRoot, opts.cache, isUsb)
    if (!d) return null
    const openPath = path.join(opts.devRoot, name)
    const acc = await accessOf(openPath)
    const hints: SerialHint[] = []
    if (d.usb && !d.usb.serial) hints.push("no-serial")
    if (d.usb && jtagProbable(d.usb)) hints.push("jtag-probable")
    if (isBuiltin) hints.push("builtin")
    return {
      name,
      devNode: toCanonical(opts.devRoot, openPath),
      openPath,
      kind: d.kind,
      driver: d.driver,
      usb: d.usb,
      byId: byIdMap.get(name) ?? [],
      byPath: byPathMap.get(name) ?? [],
      stableKey: d.usb ? usbStableKey(d.usb, true) : `dev:${name}`,
      accessible: acc.ok,
      accessError: acc.err,
      hints,
      target: null,
    }
  }))
  const out = scanned.filter((d): d is SerialDevice => d !== null)
  if (opts.cache) {
    const live = new Set(names)
    for (const k of opts.cache.entries.keys()) if (!live.has(k)) opts.cache.entries.delete(k)
  }

  // Duplicate serials (CP2102 clones "0001"…): the identity is useless, key by location instead.
  const locations = new Map<string, Set<string>>()
  for (const d of out) {
    if (!d.usb?.serial) continue
    const k = `${d.usb.vendorId}:${d.usb.productId}:${d.usb.serial}`
    const set = locations.get(k) ?? new Set<string>()
    set.add(`${d.usb.busnum}-${d.usb.portPath}`)
    locations.set(k, set)
  }
  for (const d of out) {
    if (!d.usb?.serial) continue
    if ((locations.get(`${d.usb.vendorId}:${d.usb.productId}:${d.usb.serial}`)?.size ?? 0) > 1) {
      d.hints.push("duplicate-serial")
      d.stableKey = usbStableKey(d.usb, false)
    }
  }

  // Extra globs → virtual ports (simulators, unusual drivers). Dangling links (a dead pty) are not ports.
  const known = new Set(out.map((d) => d.devNode))
  for (const g of opts.extraGlobs) {
    for (const openPath of await expandGlob(toOpenPath(opts.devRoot, g))) {
      const devNode = toCanonical(opts.devRoot, openPath)
      if (known.has(devNode)) continue
      let target: string
      try {
        target = await fs.realpath(openPath)
      } catch {
        continue
      }
      known.add(devNode)
      const acc = await accessOf(openPath)
      out.push({
        name: path.basename(openPath), devNode, openPath, kind: "virtual", driver: null, usb: null, byId: [], byPath: [],
        stableKey: `virtual:${devNode}`, accessible: acc.ok, accessError: acc.err, hints: ["simulated"], target,
      })
    }
  }
  return out.sort((a, b) => a.devNode.localeCompare(b.devNode, "en", { numeric: true }))
}
