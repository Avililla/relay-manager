#!/usr/bin/env node
// Fake USB JTAG cables for development and tests: writes (or removes) the sysfs attributes the JTAG cable enumerator
// reads under <root>/bus/usb/devices/<bus>-<port>. Point the server at it with RM_JTAG_SYS_ROOT=<root>.
//
//   node scripts/sim/fake-jtag-cable.mjs plug   --root <dir> --serial 210299ABCDEF [--port 9] [--xilinx]
//   node scripts/sim/fake-jtag-cable.mjs unplug --root <dir> --serial 210299ABCDEF
//   node scripts/sim/fake-jtag-cable.mjs list   --root <dir>
// "Plugging" the same serial at another --port is a replug in a different USB socket.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const devicesDir = (root) => path.join(root, "bus", "usb", "devices")

/** Adds a cable. Digilent JTAG-HS3 by default (FTDI 0403:6014), or a Xilinx Platform Cable USB II (03fd:0008). */
export function plugCable(root, { serial, port = "9", bus = 1, devnum = 20, xilinx = false } = {}) {
  if (!serial) throw new Error("Falta --serial")
  unplugCable(root, serial)
  const dir = path.join(devicesDir(root), `${bus}-${port}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const attrs = xilinx
    ? { idVendor: "03fd", idProduct: "0008", manufacturer: "Xilinx", product: "Platform Cable USB II" }
    : { idVendor: "0403", idProduct: "6014", manufacturer: "Digilent", product: "Digilent USB Device" }
  for (const [k, v] of Object.entries({ ...attrs, serial, busnum: String(bus), devnum: String(devnum), devpath: port, bNumInterfaces: " 1" })) {
    fs.writeFileSync(path.join(dir, k), `${v}\n`)
  }
  return dir
}

/** Removes every fake cable with this serial. Returns how many. */
export function unplugCable(root, serial) {
  let n = 0
  let names = []
  try { names = fs.readdirSync(devicesDir(root)) } catch { return 0 }
  for (const name of names) {
    const dir = path.join(devicesDir(root), name)
    let s = ""
    try { s = fs.readFileSync(path.join(dir, "serial"), "utf8").trim() } catch { continue }
    if (s !== serial) continue
    fs.rmSync(dir, { recursive: true, force: true })
    n++
  }
  return n
}

export function listCables(root) {
  let names = []
  try { names = fs.readdirSync(devicesDir(root)) } catch { return [] }
  return names.flatMap((name) => {
    try {
      return [{ where: name, serial: fs.readFileSync(path.join(devicesDir(root), name, "serial"), "utf8").trim() }]
    } catch { return [] }
  })
}

function main(argv) {
  const [cmd, ...rest] = argv
  const opt = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === "--xilinx") opt.xilinx = true
    else if (a.startsWith("--")) opt[a.slice(2)] = rest[++i]
  }
  if (!opt.root) throw new Error("Falta --root <carpeta>")
  const root = path.resolve(opt.root)
  if (cmd === "plug") process.stdout.write(`Cable ${opt.serial} conectado en ${plugCable(root, { serial: opt.serial, port: opt.port ?? "9", xilinx: !!opt.xilinx })}\n`)
  else if (cmd === "unplug") process.stdout.write(`${unplugCable(root, opt.serial)} cable(s) desconectado(s)\n`)
  else if (cmd === "list") for (const c of listCables(root)) process.stdout.write(`${c.where}\t${c.serial}\n`)
  else throw new Error("Usa plug, unplug o list")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)) } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1) }
}
export const FAKE_HW_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-hw-server.mjs")
