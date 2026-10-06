#!/usr/bin/env node
// Entorno de demostración para las capturas de los manuales (las fuentes de los manuales viven en el perfil del
// proyecto, <perfil>/manuales: ver docs/DESARROLLO.md, «Manuales»).
//
//   node scripts/manuales/entorno.mjs --dir <carpeta> [--port 3200] [--ctl 3289] [--proxy 3298] [--ip 192.0.2.97]
//                                     [--data-link <enlace>] [--tools-link <enlace>] [--files-link <enlace>]
//                                     [--bind 127.0.0.1] [--red-equipos sin-permiso|contenedor]
//                                     [--perfil <carpeta>] [--manuales <carpeta>]
//
// Monta en <carpeta> un banco simulado completo y arranca el servidor compilado (build/server.js) con datos vacíos:
//   - un sysfs y un /dev falsos (RM_SERIAL_SYS_ROOT / RM_SERIAL_DEV_ROOT) con adaptadores USB-serie creíbles
//     (FTDI FT2232H, FT4232H, CH340…) cuyos /dev/ttyUSBn son ptys de scripts/sim/fake-zynq.py;
//   - un sysfs aparte para los cables JTAG (RM_JTAG_SYS_ROOT, scripts/sim/fake-jtag-cable.mjs) y un hw_server simulado
//     (scripts/sim/fake-hw-server.mjs, presentado como <tools>/Xilinx/Vivado_Lab/2024.2/bin/hw_server);
//   - dos placas Devantech simuladas (dS378 en 127.0.0.2 y ETH008 en 127.0.0.3) con anuncios UDP;
//   - el servidor en modo portátil en 127.0.0.1:<port> con el código de configuración fijo y los accesos de red en
//     127.0.0.1:3201-3230 (el puerto de la web queda fuera del rango), la carpeta de Archivos en <carpeta>/tftp y la
//     segunda carpeta compartida (si el perfil la activa) en <carpeta>/extra;
//   - con --perfil, el servidor carga ese perfil (RM_PROFILE_DIR: plantillas, nombre del laboratorio, segunda carpeta…);
//     con --manuales, los nombres de host de las consolas simuladas salen de <manuales>/banco.json
//     ({"hosts": {"ttyUSB0": "…", …}}), si existe; si no, los genéricos de ADAPTERS;
//   - un proxy HTTP en 127.0.0.1:<proxy> para que los Chrome de las capturas abran la web como http://<ip>:<port>
//     (la IP de ejemplo de los manuales): cualquier destino va a 127.0.0.1, con el mismo puerto.
//   - la red de equipos: un sysfs de red falso (RM_NET_SYS_ROOT) con la tarjeta del laboratorio (enp3s0) y, al
//     enchufarlo, el adaptador USB-Ethernet enx08beac3882ce, y un switch TL-SG108E simulado. Con
//     `--red-equipos contenedor` (lo arranca contenedor.mjs dentro de Docker, con red propia) las interfaces existen
//     de verdad (y además enp4s0 en 192.168.1.203/24 y un adaptador USB con restos), el servidor tiene CAP_NET_ADMIN y
//     el switch está en 192.168.0.99 detrás del adaptador (red-equipos.sh);
//     con `sin-permiso` (por defecto) el switch escucha en 127.0.0.1 y el servidor no puede cambiar la red, así que
//     Sistema › Red de equipos muestra «Sin permiso para cambiar la red» con las órdenes pendientes.
// Un pequeño servidor de control en <bind>:<ctl> permite a capturas.mjs «desenchufar» y «enchufar» adaptadores y
// cables JTAG, y cambiar el enlace de los puertos del switch:
//   GET /unplug?usb=1-5   GET /plug?usb=1-5   GET /jtag-plug?serial=…&port=…[&xilinx=1]   GET /jtag-unplug?serial=…
//   GET /net-plug   GET /net-unplug   GET /switch-link?port=3&up=1   GET /switch-state   GET /state   GET /stop
// Ctrl+C (o /stop) lo detiene todo y deja los datos en <carpeta>.
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FAKE_HW_SERVER, plugCable, unplugCable } from "../sim/fake-jtag-cable.mjs"
import { plugAdapter, unplugAdapter } from "../sim/fake-net-adapter.mjs"
import { createFakeSwitch } from "../sim/fake-tplink-switch.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, "..", "..")
export const SETUP_TOKEN = "7KQM-X2PD-9HVA-RT4C"

/** Adaptadores USB-serie simulados. `plugged: false` = no conectado al arrancar (se enchufa desde capturas.mjs). */
export const ADAPTERS = [
  {
    usb: "1-2", devnum: 4, vid: "0403", pid: "6010", driver: "ftdi_sio", manufacturer: "FTDI", product: "Dual RS232-HS", serial: "FT6ZA1B2",
    ports: [
      { tty: "ttyUSB0", stage: "boot", host: "equipo-a-01-uart0", tick: 47, autoboot: 2 },
      { tty: "ttyUSB1", stage: "login", host: "equipo-a-01-uart1", tick: 53 },
    ],
  },
  {
    usb: "1-3", devnum: 5, vid: "0403", pid: "6010", driver: "ftdi_sio", manufacturer: "FTDI", product: "Dual RS232-HS", serial: "FT6ZA1C7",
    ports: [
      { tty: "ttyUSB2", stage: "shell", host: "equipo-a-02-uart0", tick: 41 },
      { tty: "ttyUSB3", stage: "uboot", host: "equipo-a-02-uart1" },
    ],
  },
  {
    usb: "1-4", devnum: 6, vid: "0403", pid: "6011", driver: "ftdi_sio", manufacturer: "FTDI", product: "Quad RS232-HS", serial: "FT4Q9K3M",
    ports: [
      { tty: "ttyUSB4", stage: "boot", host: "equipo-b-01-uart0", tick: 43, autoboot: 6 },
      { tty: "ttyUSB5", stage: "login", host: "equipo-b-01-uart1", tick: 59 },
      { tty: "ttyUSB6", stage: "silent", host: "equipo-b-01-aux" },
      { tty: "ttyUSB7", stage: "garbage", host: "equipo-b-01-dbg" },
    ],
  },
  {
    usb: "1-5.2", devnum: 8, vid: "1a86", pid: "7523", driver: "ch341-uart", manufacturer: null, product: "USB Serial", serial: null,
    ports: [{ tty: "ttyUSB8", stage: "login", host: "equipo-c-01", tick: 37 }],
  },
  {
    usb: "1-6", devnum: 9, vid: "10c4", pid: "ea60", driver: "cp210x", manufacturer: "Silicon Labs", product: "CP2102 USB to UART Bridge Controller", serial: "0001",
    plugged: false,
    ports: [{ tty: "ttyUSB9", stage: "boot", host: "equipo-c-02", autoboot: 4, tick: 51 }],
  },
]

/** Cables JTAG conectados al arrancar (el resto los enchufa capturas.mjs). Una Platform Cable USB II sin etiqueta. */
export const JTAG_AT_START = [{ serial: "0000137A4C9B01", port: "8", xilinx: true }]

/** Accesos de red: fuera del puerto de la web (3200) y solo en 127.0.0.1. */
export const ACCESS_PORTS = "3201-3230"

export const RELAY_SIMS = [
  { model: "dS378", host: "127.0.0.2", http: 18080, ascii: 17123, mac: "00:04:a3:5e:12:01", hostname: "ds378-banco" },
  { model: "ETH008", host: "127.0.0.3", http: 18081, eth: 17494, user: "admin", pass: "password", mac: "00:04:a3:5e:12:02", hostname: "eth008-rack2" },
]

/** Red de equipos: la tarjeta del laboratorio y el adaptador USB (mismos nombres y MAC que en red-equipos.sh). */
export const NET = {
  lab: { ifname: "enp3s0", mac: "3c:ec:ef:6a:21:90" },
  usb: { ifname: "enx08beac3882ce", mac: "08:be:ac:38:82:ce" },
  /** Solo con el contenedor: la segunda tarjeta de la placa, en 192.168.1.203/24 (la red de los equipos)… */
  other: { ifname: "enp4s0", mac: "3c:ec:ef:6a:21:91" },
  /** …y otro adaptador USB, sin cable, con la dirección de gestión que dejó una versión anterior (restos). */
  old: { ifname: "enx00e04c680a1f", mac: "00:e0:4c:68:0a:1f", usb: { idVendor: "0bda", idProduct: "8153", manufacturer: "Realtek", product: "USB 10/100/1000 LAN", serial: "000001", driver: "r8152" } },
  /** Puertos del switch con algo conectado al arrancar (1 = el servidor). */
  links: [1, 2, 4, 5],
}

const PCI = "devices/pci0000:00/0000:00:14.0/usb1"

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${value}\n`)
}
function symlink(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  try { fs.unlinkSync(link) } catch { /* no estaba */ }
  fs.symlinkSync(target, link)
}

/** Crea (o quita) en el sysfs falso el dispositivo USB y sus ttys, y los enlaces by-id/by-path del /dev falso. */
function sysfsAdd(root, a) {
  const sys = path.join(root, "sys")
  const dev = path.join(root, "dev")
  const usbDir = path.join(sys, PCI, a.usb)
  write(path.join(usbDir, "idVendor"), a.vid)
  write(path.join(usbDir, "idProduct"), a.pid)
  if (a.manufacturer) write(path.join(usbDir, "manufacturer"), a.manufacturer)
  if (a.product) write(path.join(usbDir, "product"), a.product)
  if (a.serial) write(path.join(usbDir, "serial"), a.serial)
  write(path.join(usbDir, "busnum"), "1")
  write(path.join(usbDir, "devnum"), String(a.devnum))
  write(path.join(usbDir, "bNumInterfaces"), ` ${a.ports.length}`)
  const drvDir = path.join(sys, "bus", "usb-serial", "drivers", a.driver)
  fs.mkdirSync(drvDir, { recursive: true })
  a.ports.forEach((p, i) => {
    const ifDir = path.join(usbDir, `${a.usb}:1.${i}`)
    write(path.join(ifDir, "bInterfaceNumber"), String(i).padStart(2, "0"))
    if (a.product) write(path.join(ifDir, "interface"), a.product)
    const portDir = path.join(ifDir, p.tty)
    write(path.join(portDir, "port_number"), "0")
    if (a.driver === "ftdi_sio") write(path.join(portDir, "latency_timer"), "1")
    symlink(path.relative(portDir, drvDir), path.join(portDir, "driver"))
    fs.mkdirSync(path.join(sys, "class", "tty", p.tty), { recursive: true })
    symlink(path.relative(path.join(sys, "class", "tty", p.tty), portDir), path.join(sys, "class", "tty", p.tty, "device"))
    symlink(path.relative(path.join(sys, "bus", "usb-serial", "devices"), portDir), path.join(sys, "bus", "usb-serial", "devices", p.tty))
    const vendor = (a.manufacturer ?? (a.vid === "1a86" ? "1a86" : a.vid)).replace(/\s+/g, "_")
    const prod = (a.product ?? "USB_Serial").replace(/\s+/g, "_")
    const byId = `usb-${vendor}_${prod}${a.serial ? `_${a.serial}` : ""}-if${String(i).padStart(2, "0")}-port0`
    symlink(`../../${p.tty}`, path.join(dev, "serial", "by-id", byId))
    const idPath = `pci-0000:00:14.0-usb-0:${a.usb.replace(/^\d+-/, "")}:1.${i}`
    symlink(`../../${p.tty}`, path.join(dev, "serial", "by-path", `${idPath}-port0`))
  })
}

function sysfsRemove(root, a) {
  const sys = path.join(root, "sys")
  const dev = path.join(root, "dev")
  for (const p of a.ports) {
    fs.rmSync(path.join(sys, "class", "tty", p.tty), { recursive: true, force: true })
    fs.rmSync(path.join(sys, "bus", "usb-serial", "devices", p.tty), { force: true })
    for (const kind of ["by-id", "by-path"]) {
      const d = path.join(dev, "serial", kind)
      for (const e of fs.existsSync(d) ? fs.readdirSync(d) : []) {
        try { if (fs.readlinkSync(path.join(d, e)) === `../../${p.tty}`) fs.unlinkSync(path.join(d, e)) } catch { /* ya no está */ }
      }
    }
  }
  fs.rmSync(path.join(sys, PCI, a.usb), { recursive: true, force: true })
}

const canConnect = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port })
  const done = (v) => { s.destroy(); resolve(v) }
  s.setTimeout(300, () => done(false))
  s.once("connect", () => done(true))
  s.once("error", () => done(false))
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(200)
  }
  throw new Error(`Tiempo agotado esperando ${what}`)
}

export async function startEnv({ dir, port = 3200, ctlPort = 3289, proxyPort = 3298, ip = "192.0.2.97", dataLink = null, toolsLink = null, filesLink = null, bind = "127.0.0.1", netMode = "sin-permiso", perfil = null, manuales = null, log = (s) => process.stdout.write(`${s}\n`) }) {
  const root = path.resolve(dir)
  let dataDir = path.join(root, "data")
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o750 })
  // Ruta corta para que las pantallas (Sistema, Copias) no muestren la carpeta temporal completa.
  if (dataLink) {
    try { fs.unlinkSync(dataLink) } catch { /* no estaba */ }
    fs.symlinkSync(dataDir, dataLink)
    dataDir = dataLink
  }
  fs.mkdirSync(path.join(root, "dev"), { recursive: true })
  fs.mkdirSync(path.join(root, "sys", "class", "tty"), { recursive: true })
  const logs = fs.createWriteStream(path.join(root, "sim.log"), { flags: "a" })
  logs.setMaxListeners(0)
  const children = new Map() // tty → proceso fake-zynq
  // Nombres de host de las consolas simuladas propios del proyecto (<manuales>/banco.json), si los hay.
  const bancoJson = manuales ? path.join(path.resolve(manuales), "banco.json") : null
  const hosts = bancoJson && fs.existsSync(bancoJson) ? (JSON.parse(fs.readFileSync(bancoJson, "utf8")).hosts ?? {}) : {}
  const others = []

  function startZynq(p) {
    const args = [path.join(REPO, "scripts", "sim", "fake-zynq.py"), "--link", path.join(root, "dev", p.tty), "--stage", p.stage, "--host", hosts[p.tty] ?? p.host]
    if (p.tick) args.push("--tick", String(p.tick))
    if (p.autoboot !== undefined) args.push("--autoboot", String(p.autoboot))
    const ch = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] })
    ch.stdout.pipe(logs, { end: false })
    ch.stderr.pipe(logs, { end: false })
    children.set(p.tty, ch)
  }
  async function stopZynq(p) {
    const ch = children.get(p.tty)
    if (!ch) return
    children.delete(p.tty)
    if (ch.exitCode === null && ch.signalCode === null) {
      await new Promise((resolve) => { ch.once("exit", resolve); ch.kill("SIGTERM"); setTimeout(() => ch.kill("SIGKILL"), 2000) })
    }
  }
  const state = new Map(ADAPTERS.map((a) => [a.usb, false]))
  async function plug(a) {
    if (state.get(a.usb)) return
    for (const p of a.ports) startZynq(p)
    await waitUntil(() => a.ports.every((p) => fs.existsSync(path.join(root, "dev", p.tty))), 5000, `los pty de ${a.usb}`)
    sysfsAdd(root, a)
    state.set(a.usb, true)
    // El watcher mira /dev: toca el directorio para que vuelva a leer el sysfs ya completo.
    const touch = path.join(root, "dev", ".plug")
    fs.writeFileSync(touch, String(Date.now()))
    fs.rmSync(touch, { force: true })
  }
  async function unplug(a) {
    if (!state.get(a.usb)) return
    sysfsRemove(root, a)
    for (const p of a.ports) await stopZynq(p)
    state.set(a.usb, false)
  }

  for (const a of ADAPTERS) if (a.plugged !== false) await plug(a)

  for (const r of RELAY_SIMS) {
    const args = [path.join(REPO, "scripts", "sim", "devantech-sim.mjs"), "--model", r.model, "--host", r.host, "--http", String(r.http), "--udp", "--reply-to", "127.255.255.255", "--mac", r.mac, "--hostname", r.hostname]
    if (r.ascii) args.push("--ascii", String(r.ascii))
    if (r.eth) args.push("--eth", String(r.eth))
    if (r.user) args.push("--user", r.user, "--pass", r.pass)
    const ch = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] })
    ch.stdout.pipe(logs, { end: false })
    ch.stderr.pipe(logs, { end: false })
    others.push(ch)
  }
  for (const r of RELAY_SIMS) await waitUntil(() => canConnect(r.host, r.http), 8000, `el simulador ${r.model}`)

  // Cables JTAG (sysfs propio) y hw_server simulado con la estructura de carpetas de Vivado Lab.
  const jtagRoot = path.join(root, "jtag-sys")
  fs.mkdirSync(path.join(jtagRoot, "bus", "usb", "devices"), { recursive: true })
  for (const c of JTAG_AT_START) plugCable(jtagRoot, c)
  const tools = path.join(root, "tools")
  const hwDir = path.join(tools, "Xilinx", "Vivado_Lab", "2024.2", "bin")
  fs.mkdirSync(hwDir, { recursive: true })
  const sim = path.join(tools, "hw_server-sim.mjs")
  fs.writeFileSync(sim, fs.readFileSync(FAKE_HW_SERVER, "utf8").replace("v2099.1 (simulado)", "v2024.2"))
  fs.writeFileSync(path.join(hwDir, "hw_server"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(sim)} "$@"\n`, { mode: 0o755 })
  let toolsDir = tools
  if (toolsLink) {
    try { fs.unlinkSync(toolsLink) } catch { /* no estaba */ }
    fs.symlinkSync(tools, toolsLink)
    toolsDir = toolsLink
  }
  const hwServer = path.join(toolsDir, "Xilinx", "Vivado_Lab", "2024.2", "bin", "hw_server")

  // Carpeta de Archivos (RM_FILES_DIR); con --files-link, las pantallas muestran la ruta corta del enlace.
  const filesReal = path.join(root, "tftp")
  fs.mkdirSync(filesReal, { recursive: true })
  let filesDir = filesReal
  if (filesLink) {
    try { fs.unlinkSync(filesLink) } catch { /* no estaba */ }
    fs.symlinkSync(filesReal, filesLink)
    filesDir = filesLink
  }

  // Segunda carpeta compartida (solo se usa si el perfil la activa con RM_FILES_EXTRA_NAME).
  const extraDir = path.join(root, "extra")
  fs.mkdirSync(extraDir, { recursive: true })

  // Red de equipos: sysfs de red con la tarjeta del laboratorio; el adaptador USB se enchufa desde capturas.mjs.
  const netRoot = path.join(root, "net-sys")
  fs.rmSync(netRoot, { recursive: true, force: true })
  plugAdapter(netRoot, { ifname: NET.lab.ifname, mac: NET.lab.mac, pci: true, port: "0" })
  const inContainer = netMode === "contenedor"
  if (inContainer) {
    // Como el PC del banco: otra tarjeta en la red de los equipos y un adaptador USB con restos (red-equipos.sh).
    plugAdapter(netRoot, { ifname: NET.other.ifname, mac: NET.other.mac, pci: true, port: "1" })
    plugAdapter(netRoot, { ifname: NET.old.ifname, mac: NET.old.mac, port: "4", carrier: false, usb: NET.old.usb })
  }
  const switchSock = path.join(root, "switch.sock")
  const localSwitch = inContainer ? null : await createFakeSwitch({ host: "127.0.0.1", ip: "192.168.0.1", links: NET.links })
  async function switchCtl(p) {
    if (localSwitch) {
      const u = new URL(p, "http://x")
      if (u.pathname === "/link") localSwitch.setLink(Number(u.searchParams.get("port")), u.searchParams.get("up") === "1")
      return localSwitch.state()
    }
    return new Promise((resolve, reject) => {
      http.get({ socketPath: switchSock, path: p }, (r) => {
        let b = ""
        r.on("data", (c) => { b += c })
        r.on("end", () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } })
      }).on("error", reject)
    })
  }

  const cfgFile = path.join(root, "config.env")
  if (!fs.existsSync(cfgFile)) fs.writeFileSync(cfgFile, "# Entorno de capturas de los manuales: todo por variables de entorno\n")
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith("RM_") || k === "AUTH_URL" || k === "NEXTAUTH_URL") delete env[k]
  Object.assign(env, {
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    TZ: process.env.TZ ?? "Europe/Madrid",
    RM_MODE: "portable",
    RM_APP_DIR: REPO,
    RM_DATA_DIR: dataDir,
    RM_FILES_DIR: filesDir,
    RM_FILES_EXTRA_DIR: extraDir,
    ...(perfil ? { RM_PROFILE_DIR: path.resolve(perfil) } : {}),
    RM_CONFIG: cfgFile,
    RM_PORT: String(port),
    RM_HOST: "127.0.0.1",
    RM_LOG_LEVEL: "info",
    RM_SETUP_TOKEN: SETUP_TOKEN,
    RM_SERIAL_SYS_ROOT: path.join(root, "sys"),
    RM_SERIAL_DEV_ROOT: path.join(root, "dev"),
    RM_RELAY_DISCOVERY_BROADCASTS: "127.255.255.255",
    RM_RELAY_SCAN_CIDRS: "127.0.0.0/29",
    RM_RELAY_SCAN_PORTS: RELAY_SIMS.map((r) => r.http).join(","),
    RM_RELAY_SIMULATE: "0",
    RM_ACCESS_PORTS: ACCESS_PORTS,
    RM_ACCESS_BIND: "127.0.0.1",
    RM_JTAG_SYS_ROOT: jtagRoot,
    RM_HW_SERVER: hwServer,
    RM_NET_SYS_ROOT: netRoot,
    RM_NET_POLL_MS: "2000",
    ...(localSwitch ? { RM_NET_SWITCH_HTTP_PORT: String(localSwitch.port) } : {}),
  })
  const out = fs.openSync(path.join(root, "server.log"), "a")
  const server = spawn(process.execPath, [path.join(REPO, "build", "server.js"), "start"], { env, stdio: ["ignore", out, out] })
  fs.closeSync(out)
  const base = `http://127.0.0.1:${port}`
  await waitUntil(async () => {
    if (server.exitCode !== null) throw new Error(`El servidor terminó al arrancar; ver ${path.join(root, "server.log")}`)
    try { return (await fetch(`${base}/api/health`)).ok } catch { return false }
  }, 60_000, "el servidor")

  // Proxy para los navegadores: http://<ip>:<port> (o cualquier otro destino) → 127.0.0.1, mismo puerto.
  const localPort = (hostPort) => Number(String(hostPort).split(":").pop()) || 80
  const proxy = http.createServer((req, res) => {
    let u
    try { u = new URL(req.url) } catch { res.statusCode = 400; return res.end() }
    const headers = { ...req.headers }
    delete headers["proxy-connection"]
    const up = http.request({ host: "127.0.0.1", port: Number(u.port) || 80, method: req.method, path: `${u.pathname}${u.search}`, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.rawHeaders)
      r.pipe(res)
    })
    up.on("error", () => { if (!res.headersSent) res.statusCode = 502; res.end() })
    // Si el navegador cierra (EventSource, navegación), se cierra también la petición al servidor.
    res.on("close", () => { if (!res.writableFinished) up.destroy() })
    req.pipe(up)
  })
  proxy.on("connect", (req, sock, head) => {
    const up = net.connect({ host: "127.0.0.1", port: localPort(req.url) }, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head?.length) up.write(head)
      up.pipe(sock)
      sock.pipe(up)
    })
    up.on("error", () => sock.destroy())
    sock.on("error", () => up.destroy())
  })
  proxy.on("upgrade", (req, sock, head) => {
    let u
    try { u = new URL(req.url) } catch { return sock.destroy() }
    const up = net.connect({ host: "127.0.0.1", port: Number(u.port) || 80 }, () => {
      const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      up.write(`${lines.join("\r\n")}\r\n\r\n`)
      if (head?.length) up.write(head)
      up.pipe(sock)
      sock.pipe(up)
    })
    up.on("error", () => sock.destroy())
    sock.on("error", () => up.destroy())
  })
  proxy.requestTimeout = 0
  proxy.headersTimeout = 0
  proxy.keepAliveTimeout = 0
  await new Promise((resolve) => proxy.listen(proxyPort, bind, resolve))
  const publicBase = `http://${ip}:${port}`

  let stopping = null
  async function stop() {
    if (stopping) return stopping
    stopping = (async () => {
      ctl.close()
      proxy.close()
      proxy.closeAllConnections?.()
      if (server.exitCode === null) {
        await new Promise((resolve) => { server.once("exit", resolve); server.kill("SIGTERM"); setTimeout(() => server.kill("SIGKILL"), 10_000) })
      }
      for (const a of ADAPTERS) for (const p of a.ports) await stopZynq(p)
      for (const ch of others) if (ch.exitCode === null) ch.kill("SIGTERM")
      await sleep(300)
      for (const ch of others) if (ch.exitCode === null) ch.kill("SIGKILL")
      await localSwitch?.close()
    })()
    return stopping
  }

  const ctl = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x")
    try {
      const a = ADAPTERS.find((x) => x.usb === u.searchParams.get("usb"))
      if (u.pathname === "/unplug" && a) await unplug(a)
      else if (u.pathname === "/plug" && a) await plug(a)
      else if (u.pathname === "/restart-port") {
        const p = ADAPTERS.flatMap((x) => x.ports).find((x) => x.tty === u.searchParams.get("tty"))
        if (p) { await stopZynq(p); startZynq(p) }
      } else if (u.pathname === "/jtag-plug") {
        plugCable(jtagRoot, { serial: u.searchParams.get("serial"), port: u.searchParams.get("port") ?? "9", xilinx: u.searchParams.get("xilinx") === "1" })
      } else if (u.pathname === "/jtag-unplug") {
        unplugCable(jtagRoot, u.searchParams.get("serial") ?? "")
      } else if (u.pathname === "/net-plug") {
        plugAdapter(netRoot, { ifname: NET.usb.ifname, mac: NET.usb.mac })
      } else if (u.pathname === "/net-unplug") {
        unplugAdapter(netRoot, NET.usb.ifname)
      } else if (u.pathname === "/switch-link" || u.pathname === "/switch-state") {
        const st = await switchCtl(u.pathname === "/switch-link" ? `/link${u.search}` : "/state")
        res.setHeader("content-type", "application/json")
        return res.end(JSON.stringify(st))
      } else if (u.pathname === "/stop") {
        res.end("ok\n")
        await stop()
        process.exit(0)
      } else if (u.pathname !== "/state") { res.statusCode = 404; return res.end("?\n") }
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ base: publicBase, local: base, dataDir, plugged: Object.fromEntries(state), serverPid: server.pid }))
    } catch (e) {
      res.statusCode = 500
      res.end(String(e?.stack ?? e))
    }
  })
  await new Promise((resolve) => ctl.listen(ctlPort, bind, resolve))
  fs.writeFileSync(path.join(root, "entorno.json"), JSON.stringify({
    base: publicBase, local: base, proxy: `http://127.0.0.1:${proxyPort}`, ctl: `http://127.0.0.1:${ctlPort}`, pid: process.pid, serverPid: server.pid,
    dataDir, jtagRoot, accessPorts: ACCESS_PORTS, toolsLink, filesDir, filesReal, extraDir, net: netMode, perfil, manuales,
  }, null, 2))
  log(`[manuales] Servidor en ${base} (pid ${server.pid}), para los navegadores ${publicBase} por el proxy 127.0.0.1:${proxyPort}; control en http://127.0.0.1:${ctlPort}; datos en ${dataDir}`)
  return { base: publicBase, local: base, root, dataDir, jtagRoot, server, stop, plug, unplug }
}

function parseArgs(argv) {
  const o = { dir: null, port: 3200, ctl: 3289, proxy: 3298, ip: "192.0.2.97", dataLink: null, toolsLink: null, filesLink: null, bind: "127.0.0.1", net: "sin-permiso", perfil: null, manuales: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") o.dir = argv[++i]
    else if (argv[i] === "--port") o.port = Number(argv[++i])
    else if (argv[i] === "--ctl") o.ctl = Number(argv[++i])
    else if (argv[i] === "--proxy") o.proxy = Number(argv[++i])
    else if (argv[i] === "--ip") o.ip = argv[++i]
    else if (argv[i] === "--data-link") o.dataLink = path.resolve(argv[++i])
    else if (argv[i] === "--tools-link") o.toolsLink = path.resolve(argv[++i])
    else if (argv[i] === "--files-link") o.filesLink = path.resolve(argv[++i])
    else if (argv[i] === "--bind") o.bind = argv[++i]
    else if (argv[i] === "--red-equipos") o.net = argv[++i]
    else if (argv[i] === "--perfil") o.perfil = path.resolve(argv[++i])
    else if (argv[i] === "--manuales") o.manuales = path.resolve(argv[++i])
  }
  if (!["sin-permiso", "contenedor"].includes(o.net)) throw new Error("--red-equipos: sin-permiso o contenedor")
  if (!o.dir) throw new Error("Uso: node scripts/manuales/entorno.mjs --dir <carpeta> [--port 3200] [--ctl 3289] [--proxy 3298] [--ip 192.0.2.97]")
  return o
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2))
  const envh = await startEnv({ dir: o.dir, port: o.port, ctlPort: o.ctl, proxyPort: o.proxy, ip: o.ip, dataLink: o.dataLink, toolsLink: o.toolsLink, filesLink: o.filesLink, bind: o.bind, netMode: o.net, perfil: o.perfil, manuales: o.manuales })
  const bye = () => { envh.stop().then(() => process.exit(0)) }
  process.on("SIGINT", bye)
  process.on("SIGTERM", bye)
}
