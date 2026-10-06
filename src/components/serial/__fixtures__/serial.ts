// DTO fixtures for the serial widgets (unit tests and component development). W1-E builds against these, not W1-A code.
import type { ConsoleSummaryDTO } from "@/lib/contracts/equipment"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import type { ConsoleRuntimeDTO, SerialPortDTO, SerialSnapshotDTO, UsbAdapterDTO } from "@/lib/contracts/serial"
import type { HealthCheckDTO } from "@/lib/contracts/system"

const NOW = "2026-09-23T11:42:00.000Z"

function usbPort(p: {
  adapter: { vid: string; pid: string; serial: string | null; manufacturer: string; product: string; location: string; busnum: number; devnum: number }
  n: number; iface: number; letter: string | null; byIdName: string | null; assigned?: SerialPortDTO["assignment"]; inUse?: SerialPortDTO["inUse"]
  accessible?: boolean; accessError?: string | null; hints?: SerialPortDTO["hints"]
}): SerialPortDTO {
  const name = `ttyUSB${p.n}`
  return {
    stableKey: `usb:${p.adapter.vid}:${p.adapter.pid}:${p.adapter.serial ?? p.adapter.location}:${p.iface}`,
    name,
    devNode: `/dev/${name}`,
    kind: "usb",
    driver: p.adapter.vid === "0403" ? "ftdi_sio" : p.adapter.vid === "10c4" ? "cp210x" : "ch341",
    byId: p.byIdName ? `/dev/serial/by-id/${p.byIdName}` : null,
    byPath: `/dev/serial/by-path/pci-0000:00:14.0-usb-0:${p.adapter.location.replace("USB 1-", "")}:1.${p.iface}-port0`,
    usb: {
      vendorId: p.adapter.vid, productId: p.adapter.pid, manufacturer: p.adapter.manufacturer, product: p.adapter.product,
      serial: p.adapter.serial, interfaceNumber: p.iface, interfaceName: null, portNumber: 0,
      idPath: `pci-0000:00:14.0-usb-0:${p.adapter.location.replace("USB 1-", "")}`, portPath: p.adapter.location.replace("USB ", ""),
      busnum: p.adapter.busnum, devnum: p.adapter.devnum,
    },
    interfaceLetter: p.letter,
    accessible: p.accessible ?? true,
    accessError: p.accessError ?? null,
    hints: p.hints ?? [],
    assignment: p.assigned ?? null,
    inUse: p.inUse ?? (p.assigned ? "app" : null),
  }
}

const FT = { vid: "0403", pid: "6011", serial: "FT4ABCDE", manufacturer: "FTDI", product: "Quad RS232-HS", location: "USB 1-3.1", busnum: 1, devnum: 7 }
const CP = { vid: "10c4", pid: "ea70", serial: "01A7F3C2", manufacturer: "Silicon Labs", product: "CP2105 Dual USB to UART Bridge", location: "USB 1-3.2", busnum: 1, devnum: 8 }
const CH = { vid: "1a86", pid: "7523", serial: null, manufacturer: "QinHeng Electronics", product: "USB Serial", location: "USB 1-4", busnum: 1, devnum: 9 }
const HS3 = { vid: "0403", pid: "6014", serial: "210299A5B1C2", manufacturer: "Digilent", product: "Digilent USB Device", location: "USB 1-2", busnum: 1, devnum: 5 }

const ft4232: UsbAdapterDTO = {
  locationKey: "pci-0000:00:14.0-usb-0:3.1", identityKey: "0403:6011:FT4ABCDE", vendorId: FT.vid, productId: FT.pid,
  manufacturer: FT.manufacturer, product: FT.product, serial: FT.serial, label: "FTDI Quad RS232-HS (FT4ABCDE)", location: FT.location, hints: [],
  ports: [
    usbPort({ adapter: FT, n: 0, iface: 0, letter: "A", byIdName: "usb-FTDI_Quad_RS232-HS_FT4ABCDE-if00-port0",
      assigned: { equipmentId: "eq07", equipmentName: "Equipo A #07", consoleId: "c1", consoleKey: "UART0", consoleLabel: "Interfaz segura" } }),
    usbPort({ adapter: FT, n: 1, iface: 1, letter: "B", byIdName: "usb-FTDI_Quad_RS232-HS_FT4ABCDE-if01-port0",
      assigned: { equipmentId: "eq07", equipmentName: "Equipo A #07", consoleId: "c2", consoleKey: "UART1", consoleLabel: "UART1" } }),
    usbPort({ adapter: FT, n: 2, iface: 2, letter: "C", byIdName: "usb-FTDI_Quad_RS232-HS_FT4ABCDE-if02-port0" }),
    usbPort({ adapter: FT, n: 3, iface: 3, letter: "D", byIdName: "usb-FTDI_Quad_RS232-HS_FT4ABCDE-if03-port0", inUse: "other" }),
  ],
}

const cp2105: UsbAdapterDTO = {
  locationKey: "pci-0000:00:14.0-usb-0:3.2", identityKey: "10c4:ea70:01A7F3C2", vendorId: CP.vid, productId: CP.pid,
  manufacturer: CP.manufacturer, product: CP.product, serial: CP.serial, label: "Silicon Labs CP2105 (01A7F3C2)", location: CP.location, hints: [],
  ports: [
    usbPort({ adapter: CP, n: 4, iface: 0, letter: "A", byIdName: "usb-Silicon_Labs_CP2105_Dual_USB_to_UART_Bridge_Controller_01A7F3C2-if00-port0" }),
    usbPort({ adapter: CP, n: 5, iface: 1, letter: "B", byIdName: "usb-Silicon_Labs_CP2105_Dual_USB_to_UART_Bridge_Controller_01A7F3C2-if01-port0", accessible: false, accessError: "EACCES" }),
  ],
}

const ch340: UsbAdapterDTO = {
  locationKey: "pci-0000:00:14.0-usb-0:4", identityKey: null, vendorId: CH.vid, productId: CH.pid,
  manufacturer: CH.manufacturer, product: CH.product, serial: null, label: "QinHeng USB Serial", location: CH.location, hints: ["no-serial"],
  ports: [usbPort({ adapter: CH, n: 6, iface: 0, letter: null, byIdName: "usb-1a86_USB_Serial-if00-port0", hints: ["no-serial"] })],
}

const hs3: UsbAdapterDTO = {
  locationKey: "pci-0000:00:14.0-usb-0:2", identityKey: "0403:6014:210299A5B1C2", vendorId: HS3.vid, productId: HS3.pid,
  manufacturer: HS3.manufacturer, product: HS3.product, serial: HS3.serial, label: "Digilent USB Device (210299A5B1C2)", location: HS3.location,
  hints: ["jtag-probable"],
  ports: [usbPort({ adapter: HS3, n: 7, iface: 1, letter: "B", byIdName: "usb-Digilent_Digilent_USB_Device_210299A5B1C2-if01-port0", hints: ["jtag-probable"] })],
}

function virtualPort(name: string, dir: string, hints: SerialPortDTO["hints"], assigned?: SerialPortDTO["assignment"]): SerialPortDTO {
  return {
    stableKey: `path:${dir}/${name}`, name, devNode: `${dir}/${name}`, kind: hints.includes("builtin") ? "platform" : "virtual", driver: null,
    byId: null, byPath: null, usb: null, interfaceLetter: null, accessible: true, accessError: null, hints, assignment: assigned ?? null,
    inUse: assigned ? "app" : null,
  }
}

export const snapshotFixture: SerialSnapshotDTO = {
  scannedAt: NOW,
  adapters: [ft4232, cp2105, ch340, hs3],
  others: [
    virtualPort("ttyV1", "/tmp/banco/sim", ["simulated"]),
    virtualPort("ttyV0", "/tmp/banco/sim", ["simulated"], { equipmentId: "eq01", equipmentName: "Equipo A #01", consoleId: "c9", consoleKey: "UART0", consoleLabel: "Interfaz segura" }),
    virtualPort("ttyS4", "/dev", ["builtin"]),
  ],
  hiddenJtag: 1,
  watcher: { inotify: true, intervalMs: 2000 },
}

export const emptySnapshotFixture: SerialSnapshotDTO = { scannedAt: NOW, adapters: [], others: [], hiddenJtag: 0, watcher: { inotify: false, intervalMs: 2000 } }

const rt = (over: Partial<ConsoleRuntimeDTO>): ConsoleRuntimeDTO => ({
  status: "open", devNode: "/dev/ttyUSB0", detail: null, since: "2026-09-23T09:00:00.000Z", lastRxAt: null, lastLine: null, viewers: 0,
  released: null, capture: "active", ...over,
})

/** Consoles in every §8.6 state; `lastRxAt` is relative to `referenceNow`. */
export function consoleFixtures(referenceNow: number): ConsoleSummaryDTO[] {
  const ago = (ms: number) => new Date(referenceNow - ms).toISOString()
  const base = { enterMode: "cr" as const, localEcho: false, matchBy: "adapter" as const, adapterLabel: "FTDI Quad RS232-HS (FT4ABCDE)" }
  return [
    { ...base, id: "c1", key: "UART0", label: "Interfaz segura", position: 0, line: DEFAULT_LINE, adapterShort: "FT4ABCDE·A",
      runtime: rt({ lastRxAt: ago(800), lastLine: "Starting kernel ...", viewers: 2 }) },
    { ...base, id: "c2", key: "UART1", label: "UART1", position: 1, line: DEFAULT_LINE, adapterShort: "FT4ABCDE·B",
      runtime: rt({ devNode: "/dev/ttyUSB1", lastRxAt: ago(15 * 60_000), lastLine: "equipo-uart1 login:" }) },
    { ...base, id: "c3", key: "PS_UART", label: "Zynq PS", position: 2, line: { ...DEFAULT_LINE, baudRate: 921600 }, adapterShort: "01A7F3C2·A",
      runtime: rt({ status: "released", devNode: "/dev/ttyUSB4", released: { byName: "J. Duro", at: ago(60_000), until: new Date(referenceNow + 30 * 60_000).toISOString() } }) },
    { ...base, id: "c4", key: "AUX", label: "Auxiliar", position: 3, line: { baudRate: 9600, dataBits: 7, parity: "even", stopBits: 2, flowControl: "none" },
      adapterShort: "USB 1-4", matchBy: "usb-port", runtime: rt({ status: "missing", devNode: null, detail: "Conecta el adaptador en el puerto USB 1-4 o cambia la asignación en Ajustes." }) },
    { ...base, id: "c5", key: "DBG", label: "Depuración", position: 4, line: DEFAULT_LINE, adapterShort: "01A7F3C2·B",
      runtime: rt({ status: "no-permission", devNode: "/dev/ttyUSB5", detail: "No se puede abrir /dev/ttyUSB5: permiso denegado. Añade el usuario del servicio al grupo dialout." }) },
    { ...base, id: "c6", key: "BITREADER", label: "BITReader", position: 5, line: DEFAULT_LINE, adapterShort: "FT4ABCDE·D",
      runtime: rt({ status: "busy", devNode: "/dev/ttyUSB3", detail: "Otro programa tiene abierto el puerto (picocom)." }) },
    { ...base, id: "c7", key: "SPARE", label: "Reserva", position: 6, line: DEFAULT_LINE, adapterShort: null, matchBy: null, adapterLabel: null,
      runtime: rt({ status: "unbound", devNode: null, capture: "off" }) },
    { ...base, id: "c8", key: "LOG", label: "Registro", position: 7, line: DEFAULT_LINE, adapterShort: "ttyV0", matchBy: "path",
      runtime: rt({ status: "open", devNode: "/tmp/banco/sim/ttyV0", lastRxAt: ago(2000), lastLine: "U-Boot 2023.01 (Sep 23 2026)", capture: "paused-disk" }) },
    { ...base, id: "c10", key: "OPEN", label: "Apertura", position: 8, line: DEFAULT_LINE, adapterShort: "FT4ABCDE·C",
      runtime: rt({ status: "opening", devNode: "/dev/ttyUSB2" }) },
    { ...base, id: "c11", key: "ERR", label: "Error", position: 9, line: DEFAULT_LINE, adapterShort: "FT4ABCDE·C",
      runtime: rt({ status: "error", devNode: "/dev/ttyUSB2", detail: "Error de E/S al leer" }) },
  ]
}

export const serialHintsFixture: HealthCheckDTO[] = [
  { id: "serial.dialout", group: "serial", level: "fail", label: "Grupo dialout", message: "El usuario del servicio no pertenece al grupo dialout.",
    hint: "sudo usermod -aG dialout relay-manager && sudo systemctl restart relay-manager" },
  { id: "serial.modemmanager", group: "serial", level: "warn", label: "ModemManager", message: "ModemManager está activo y puede enviar comandos AT a los ttyACM.",
    hint: "Instala la regla udev del paquete o desactiva ModemManager." },
]
