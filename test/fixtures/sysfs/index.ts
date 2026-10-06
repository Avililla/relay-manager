// Fake sysfs + /dev tree that mimics the kernel layout for USB-serial adapters (W1-A, §11.2).
// Ported from $SCRATCH/sertest/fixture.sh. Tests pass `sysRoot`/`devRoot` to the enumerator and the watcher.
import fs from "node:fs"
import path from "node:path"

export interface UsbDeviceSpec {
  /** Hub port path after the bus, e.g. "3.1" → sysfs dir "1-3.1". */
  port: string
  bus?: number
  devnum?: number
  vendorId: string
  productId: string
  manufacturer?: string | null
  product?: string | null
  serial?: string | null
  numInterfaces: number
  speed?: number
}

export interface UsbDeviceHandle { dir: string; name: string; spec: UsbDeviceSpec }

export interface UsbSerialTtySpec { iface: number; tty: string; portNumber?: number; driver: string; ifname?: string }

const PCI_HOST = "pci0000:00/0000:00:14.0"

function rel(fromDir: string, to: string): string {
  return path.relative(fromDir, to) || "."
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

export class SysfsFixture {
  readonly root: string
  readonly sysRoot: string
  readonly devRoot: string
  private readonly classDir: string

  constructor(root: string, opts: { devDirName?: string } = {}) {
    this.root = root
    this.sysRoot = path.join(root, "sys")
    this.devRoot = path.join(root, opts.devDirName ?? "dev")
    this.classDir = path.join(this.sysRoot, "class", "tty")
    fs.mkdirSync(this.classDir, { recursive: true })
    fs.mkdirSync(path.join(this.devRoot, "serial", "by-id"), { recursive: true })
    fs.mkdirSync(path.join(this.devRoot, "serial", "by-path"), { recursive: true })
  }

  private hostController(bus: number): string {
    return path.join(this.sysRoot, "devices", PCI_HOST, `usb${bus}`)
  }

  /** Creates the USB device directory (and hub parents) with its descriptor attributes. */
  addUsbDevice(spec: UsbDeviceSpec): UsbDeviceHandle {
    const bus = spec.bus ?? 1
    const parts = spec.port.split(".")
    let dir = this.hostController(bus)
    for (let i = 1; i <= parts.length; i++) dir = path.join(dir, `${bus}-${parts.slice(0, i).join(".")}`)
    fs.mkdirSync(dir, { recursive: true })
    write(path.join(dir, "idVendor"), `${spec.vendorId}\n`)
    write(path.join(dir, "idProduct"), `${spec.productId}\n`)
    if (spec.manufacturer != null) write(path.join(dir, "manufacturer"), `${spec.manufacturer}\n`)
    if (spec.product != null) write(path.join(dir, "product"), `${spec.product}\n`)
    if (spec.serial != null) write(path.join(dir, "serial"), `${spec.serial}\n`)
    write(path.join(dir, "bNumInterfaces"), `${String(spec.numInterfaces).padStart(2, " ")}\n`)
    write(path.join(dir, "busnum"), `${bus}\n`)
    write(path.join(dir, "devnum"), `${spec.devnum ?? 7}\n`)
    write(path.join(dir, "speed"), `${spec.speed ?? 480}\n`)
    write(path.join(dir, "devpath"), `${spec.port}\n`)
    // /sys/bus/usb/devices/<name> → the device (the JTAG cable enumerator lists USB devices from there)
    const busDir = path.join(this.sysRoot, "bus", "usb", "devices")
    fs.mkdirSync(busDir, { recursive: true })
    fs.rmSync(path.join(busDir, path.basename(dir)), { force: true })
    fs.symlinkSync(rel(busDir, dir), path.join(busDir, path.basename(dir)))
    return { dir, name: path.basename(dir), spec }
  }

  /** Adds a USB interface directory (`<dev>:1.<n>`) with bInterfaceNumber and a driver link. */
  addInterface(dev: UsbDeviceHandle, ifnum: number, driver: string, ifname?: string): string {
    const d = path.join(dev.dir, `${dev.name}:1.${ifnum}`)
    fs.mkdirSync(d, { recursive: true })
    write(path.join(d, "bInterfaceNumber"), `${ifnum.toString(16).padStart(2, "0")}\n`)
    const drv = path.join(this.sysRoot, "bus", "usb", "drivers", driver)
    fs.mkdirSync(drv, { recursive: true })
    fs.symlinkSync(rel(d, drv), path.join(d, "driver"))
    if (ifname) write(path.join(d, "interface"), `${ifname}\n`)
    return d
  }

  private addDevNode(tty: string): void {
    fs.writeFileSync(path.join(this.devRoot, tty), "")
  }

  private addClassLink(tty: string, ttyDir: string): void {
    fs.symlinkSync(rel(this.classDir, ttyDir), path.join(this.classDir, tty))
  }

  /** usb-serial driver (ftdi_sio, cp210x, ch341…): interface → port dir (port_number, driver) → tty/<name>. */
  addUsbSerialTty(ifaceDir: string, tty: string, portNumber: number, driver: string): void {
    const portDir = path.join(ifaceDir, tty)
    const ttyDir = path.join(portDir, "tty", tty)
    fs.mkdirSync(ttyDir, { recursive: true })
    write(path.join(portDir, "port_number"), `${portNumber}\n`)
    const drv = path.join(this.sysRoot, "bus", "usb-serial", "drivers", driver)
    fs.mkdirSync(drv, { recursive: true })
    fs.symlinkSync(rel(portDir, drv), path.join(portDir, "driver"))
    fs.symlinkSync(`../../../${tty}`, path.join(ttyDir, "device"))
    this.addClassLink(tty, ttyDir)
    this.addDevNode(tty)
  }

  /** cdc_acm: the tty hangs directly off the interface (no usb-serial level). */
  addAcmTty(ifaceDir: string, tty: string): void {
    const ttyDir = path.join(ifaceDir, "tty", tty)
    fs.mkdirSync(ttyDir, { recursive: true })
    fs.symlinkSync(`../../../${path.basename(ifaceDir)}`, path.join(ttyDir, "device"))
    this.addClassLink(tty, ttyDir)
    this.addDevNode(tty)
  }

  /** A /dev/serial/by-id or by-path link (relative, like udev's). Last one wins, like udev. */
  link(kind: "by-id" | "by-path", name: string, tty: string): void {
    const p = path.join(this.devRoot, "serial", kind, name)
    fs.rmSync(p, { force: true })
    fs.symlinkSync(`../../${tty}`, p)
  }

  /** An on-board 8250 UART. type 0 = phantom placeholder (nr_uarts). */
  addBuiltin(name: string, type: number): void {
    const n = name.replace(/^\D+/, "")
    const parent = path.join(this.sysRoot, "devices", "platform", "serial8250", "serial8250:0", `serial8250:0.${n}`)
    const ttyDir = path.join(parent, "tty", name)
    fs.mkdirSync(ttyDir, { recursive: true })
    write(path.join(ttyDir, "type"), `${type}\n`)
    fs.symlinkSync(`../../../serial8250:0.${n}`, path.join(ttyDir, "device"))
    this.addClassLink(name, ttyDir)
    this.addDevNode(name)
  }

  /** Convenience: a USB device with one usb-serial tty per interface. */
  addUsbSerialAdapter(spec: UsbDeviceSpec, ttys: UsbSerialTtySpec[], links: { byId?: (t: UsbSerialTtySpec) => string | null; byPath?: boolean } = {}): UsbDeviceHandle {
    const dev = this.addUsbDevice(spec)
    for (const t of ttys) {
      const ifDir = this.addInterface(dev, t.iface, t.driver, t.ifname)
      this.addUsbSerialTty(ifDir, t.tty, t.portNumber ?? 0, t.driver)
      const id = links.byId?.(t)
      if (id) this.link("by-id", id, t.tty)
      if (links.byPath !== false) this.link("by-path", `pci-0000:00:14.0-usb-0:${spec.port}:1.${t.iface}-port${t.portNumber ?? 0}`, t.tty)
    }
    return dev
  }

  /** Removes a tty: class link, dev node and every /dev/serial link that points at it (like udev on unplug). */
  removeTty(tty: string): void {
    const link = path.join(this.classDir, tty)
    try {
      const target = fs.realpathSync(link)
      // the tty dir itself (…/tty/<name>) goes away with the device
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      /* already gone */
    }
    fs.rmSync(link, { force: true })
    fs.rmSync(path.join(this.devRoot, tty), { force: true })
    for (const kind of ["by-id", "by-path"] as const) {
      const dir = path.join(this.devRoot, "serial", kind)
      let entries: string[] = []
      try { entries = fs.readdirSync(dir) } catch { continue }
      for (const e of entries) {
        try {
          if (path.basename(fs.readlinkSync(path.join(dir, e))) === tty) fs.rmSync(path.join(dir, e), { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Removes a whole USB device and its ttys. */
  removeUsbDevice(dev: UsbDeviceHandle): void {
    for (const name of fs.readdirSync(this.classDir)) {
      let target: string
      try { target = fs.realpathSync(path.join(this.classDir, name)) } catch { continue }
      if (target.startsWith(dev.dir + path.sep)) this.removeTty(name)
    }
    fs.rmSync(dev.dir, { recursive: true, force: true })
    fs.rmSync(path.join(this.sysRoot, "bus", "usb", "devices", dev.name), { force: true })
  }

  /** Xilinx Platform Cable USB II: a JTAG cable with no tty at all. */
  addXilinxPlatformCable(port = "7", serial = "000013ca3a2001"): UsbDeviceHandle {
    return this.addUsbDevice({ port, vendorId: "03fd", productId: "0008", manufacturer: "Xilinx", product: "Platform Cable USB II", serial, numInterfaces: 1 })
  }

  /** Removes /dev/serial entirely (Docker without the host /dev links, or no adapter ever plugged). */
  removeSerialLinks(): void {
    fs.rmSync(path.join(this.devRoot, "serial"), { recursive: true, force: true })
  }

  chmodDev(tty: string, mode: number): void {
    fs.chmodSync(path.join(this.devRoot, tty), mode)
  }

  removeDevNode(tty: string): void {
    fs.rmSync(path.join(this.devRoot, tty), { force: true })
  }

  // ---------------------------------------------------------------------------------------------
  // The standard §11.2 fixture
  // ---------------------------------------------------------------------------------------------

  addFt4232h(port = "3.1", serial: string | null = "FT4ABCDE", firstTty = 0, ifaces: number[] = [0, 1, 2, 3]): UsbDeviceHandle {
    return this.addUsbSerialAdapter(
      { port, vendorId: "0403", productId: "6011", manufacturer: "FTDI", product: "Quad RS232-HS", serial, numInterfaces: 4 },
      ifaces.map((i) => ({ iface: i, tty: `ttyUSB${firstTty + i}`, driver: "ftdi_sio" })),
      { byId: serial ? (t) => `usb-FTDI_Quad_RS232-HS_${serial}-if0${t.iface}-port0` : undefined },
    )
  }

  addCp2105(port = "3.2", first = 4): UsbDeviceHandle {
    return this.addUsbSerialAdapter(
      { port, vendorId: "10c4", productId: "ea70", manufacturer: "Silicon Labs", product: "CP2105 Dual USB to UART Bridge Controller", serial: "00A1B2C3", numInterfaces: 2 },
      [
        { iface: 0, tty: `ttyUSB${first}`, driver: "cp210x", ifname: "Enhanced Com Port" },
        { iface: 1, tty: `ttyUSB${first + 1}`, driver: "cp210x", ifname: "Standard Com Port" },
      ],
      { byId: (t) => `usb-Silicon_Labs_CP2105_Dual_USB_to_UART_Bridge_Controller_00A1B2C3-if0${t.iface}-port0` },
    )
  }

  addCh342(port = "4"): UsbDeviceHandle {
    const dev = this.addUsbDevice({ port, vendorId: "1a86", productId: "55d2", manufacturer: "WCH.CN", product: "USB Dual_Serial", serial: "5959012345", numInterfaces: 4 })
    const i0 = this.addInterface(dev, 0, "cdc_acm")
    this.addAcmTty(i0, "ttyACM0")
    this.addInterface(dev, 1, "cdc_acm")
    const i2 = this.addInterface(dev, 2, "cdc_acm")
    this.addAcmTty(i2, "ttyACM1")
    this.addInterface(dev, 3, "cdc_acm")
    this.link("by-id", "usb-1a86_USB_Dual_Serial_5959012345-if00", "ttyACM0")
    this.link("by-id", "usb-1a86_USB_Dual_Serial_5959012345-if02", "ttyACM1")
    return dev
  }

  addCh340(port: string, tty: string): UsbDeviceHandle {
    return this.addUsbSerialAdapter(
      { port, vendorId: "1a86", productId: "7523", manufacturer: null, product: "USB Serial", serial: null, numInterfaces: 1 },
      [{ iface: 0, tty, driver: "ch341" }],
      { byId: () => "usb-1a86_USB_Serial-if00-port0" },  // collides: udev keeps the last one
    )
  }

  addDigilentHs3(port = "2", tty = "ttyUSB8"): UsbDeviceHandle {
    return this.addUsbSerialAdapter(
      { port, vendorId: "0403", productId: "6014", manufacturer: "Digilent", product: "Digilent USB Device", serial: "210299ABCDEF", numInterfaces: 1 },
      [{ iface: 0, tty, driver: "ftdi_sio" }],
      { byId: () => "usb-Digilent_Digilent_USB_Device_210299ABCDEF-if00-port0" },
    )
  }

  /** FT4232H, CP2105, CH342 (cdc_acm), 2× CH340 without serial, Digilent HS3, phantom ttyS0 (type 0), real ttyS4. */
  static standard(root: string, opts: { devDirName?: string } = {}): SysfsFixture & { handles: Record<string, UsbDeviceHandle> } {
    const f = new SysfsFixture(root, opts)
    const handles: Record<string, UsbDeviceHandle> = {
      ft4232h: f.addFt4232h(),
      cp2105: f.addCp2105(),
      ch342: f.addCh342(),
      ch340a: f.addCh340("5", "ttyUSB6"),
      ch340b: f.addCh340("6", "ttyUSB7"),
      hs3: f.addDigilentHs3(),
    }
    f.addBuiltin("ttyS0", 0)
    f.addBuiltin("ttyS4", 4)
    return Object.assign(f, { handles })
  }
}
