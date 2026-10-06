#!/usr/bin/env node
// Fake network interfaces in a sysfs tree for development and tests (the "Red de equipos" adapter list reads
// <root>/class/net). Point the server at it with RM_NET_SYS_ROOT=<root>.
//
//   node scripts/sim/fake-net-adapter.mjs plug   --root <dir> [--ifname enxfake0] [--mac 02:00:00:00:00:01] [--no-carrier] [--pci]
//   node scripts/sim/fake-net-adapter.mjs unplug --root <dir> --ifname enxfake0
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * A USB 3 Gigabit adapter (ASIX AX88179A, cdc_ncm) by default, or a PCI NIC with `pci: true`. `usb` overrides the USB
 * descriptors and driver of a USB adapter (e.g. { idVendor: "0bda", idProduct: "8153", manufacturer: "Realtek",
 * product: "USB 10/100/1000 LAN", serial: "…", driver: "r8152" }).
 */
export function plugAdapter(root, { ifname = "enxfake0", mac = "02:00:00:00:00:01", carrier = true, pci = false, port = "7", usb = {} } = {}) {
  unplugAdapter(root, ifname)
  const { driver: usbDriver = "cdc_ncm", ...desc } = usb
  const drivers = path.join(root, "bus", pci ? "pci" : "usb", "drivers", pci ? "r8169" : usbDriver)
  fs.mkdirSync(drivers, { recursive: true })
  let ifaceDir
  if (pci) {
    ifaceDir = path.join(root, "devices", "pci0000:00", `0000:00:1c.${port}`)
  } else {
    const usbDev = path.join(root, "devices", "pci0000:00", "0000:00:0d.0", "usb2", `2-${port}`)
    fs.mkdirSync(usbDev, { recursive: true })
    for (const [k, v] of Object.entries({ idVendor: "0b95", idProduct: "1790", manufacturer: "ASIX", product: "AX88179A", serial: "0000000000FAKE", busnum: "2", devpath: port, ...desc })) {
      fs.writeFileSync(path.join(usbDev, k), `${v}\n`)
    }
    ifaceDir = path.join(usbDev, `2-${port}:2.0`)
  }
  const netDir = path.join(ifaceDir, "net", ifname)
  fs.mkdirSync(netDir, { recursive: true })
  fs.symlinkSync(drivers, path.join(ifaceDir, "driver"))
  fs.symlinkSync(ifaceDir, path.join(netDir, "device"))
  for (const [k, v] of Object.entries({ address: mac, type: "1", carrier: carrier ? "1" : "0", operstate: carrier ? "up" : "down", speed: carrier ? "1000" : "-1" })) {
    fs.writeFileSync(path.join(netDir, k), `${v}\n`)
  }
  fs.mkdirSync(path.join(root, "class", "net"), { recursive: true })
  fs.symlinkSync(netDir, path.join(root, "class", "net", ifname))
  return netDir
}

export function setCarrier(root, ifname, carrier) {
  const dir = fs.realpathSync(path.join(root, "class", "net", ifname))
  fs.writeFileSync(path.join(dir, "carrier"), carrier ? "1\n" : "0\n")
  fs.writeFileSync(path.join(dir, "operstate"), carrier ? "up\n" : "down\n")
}

export function unplugAdapter(root, ifname) {
  const link = path.join(root, "class", "net", ifname)
  let target = null
  try { target = fs.realpathSync(link) } catch { return false }
  fs.rmSync(link, { force: true })
  fs.rmSync(path.dirname(path.dirname(target)), { recursive: true, force: true })
  return true
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...args] = process.argv.slice(2)
  const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
  const root = val("--root", null)
  if (!root) { process.stderr.write("Falta --root\n"); process.exit(2) }
  if (cmd === "plug") process.stdout.write(`${plugAdapter(root, { ifname: val("--ifname", "enxfake0"), mac: val("--mac", "02:00:00:00:00:01"), carrier: !args.includes("--no-carrier"), pci: args.includes("--pci") })}\n`)
  else if (cmd === "unplug") process.stdout.write(`${unplugAdapter(root, val("--ifname", "enxfake0")) ? "desconectado" : "no estaba"}\n`)
  else { process.stderr.write("Uso: plug|unplug --root <dir> [--ifname …]\n"); process.exit(2) }
}
