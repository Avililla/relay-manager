// Probe safety (§4.10): discovery and detection must never actuate a relay. Every detect write goes through here.
import type { Logger } from "@/server/log"
import type { HttpGetOptions, RelayTransports, TcpConnectOptions, TcpConversation } from "../types"

export class UnsafeProbeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeProbeError"
  }
}

export const SAFE_HTTP_PATHS = ["/index.xml", "/index.htm", "/status.xml", "/"] as const

const ST = "ST\r\n"
const ASCII_SAFE = [ST]
const ETH_SAFE = ["\x10", "\x24", "\x7a"]
/** dS binary set commands ('1' '2' '7' '8' '9'). */
const FORBIDDEN_ASCII_FIRST = new Set([0x31, 0x32, 0x37, 0x38, 0x39])
/** ETH set active/inactive/all and the ASCII ":DOA" form. */
const FORBIDDEN_ETH_FIRST = new Set([0x20, 0x21, 0x23, 0x3a])

/**
 * Port 17123 (dS ASCII) accepts only `ST\r\n`; port 17494 (ETH) only 0x10, 0x24 or 0x7A. Any other port (a board or a
 * simulator on a custom port) accepts only the union of those payloads. Throws UnsafeProbeError otherwise.
 */
export function assertSafeProbe(port: number, bytes: Uint8Array): void {
  const payload = Buffer.from(bytes).toString("latin1")
  const first = bytes[0]
  if (first === undefined) throw new UnsafeProbeError("Sonda vacía")
  if (FORBIDDEN_ASCII_FIRST.has(first) || FORBIDDEN_ETH_FIRST.has(first)) {
    throw new UnsafeProbeError(`Sonda prohibida: primer byte 0x${first.toString(16)} en el puerto ${port}`)
  }
  const allowed = port === 17123 ? ASCII_SAFE : port === 17494 ? ETH_SAFE : [...ASCII_SAFE, ...ETH_SAFE]
  if (!allowed.includes(payload)) throw new UnsafeProbeError(`Sonda no permitida en el puerto ${port}`)
}

/** Probes use only GET on /index.xml, /index.htm, /status.xml and / (never dscript.cgi or io.cgi). */
export function assertSafeHttpProbe(method: string, path: string): void {
  if (method !== "GET" || !(SAFE_HTTP_PATHS as readonly string[]).includes(path)) {
    throw new UnsafeProbeError(`Sonda HTTP no permitida: ${method} ${path}`)
  }
}

/** Wraps transports for detect paths: every write is checked, and every probe is logged at debug level. */
export function probeTransports(t: RelayTransports, log: Logger): RelayTransports {
  return {
    async httpGet(o: HttpGetOptions) {
      assertSafeHttpProbe("GET", o.path)
      log.debug("Sonda HTTP", { destino: o.host, puerto: o.port, ruta: o.path })
      return t.httpGet(o)
    },
    async tcpConnect(o: TcpConnectOptions): Promise<TcpConversation> {
      const conv = await t.tcpConnect(o)
      return {
        host: conv.host,
        port: conv.port,
        close: () => conv.close(),
        request(data, until, opts) {
          assertSafeProbe(o.port, data)
          log.debug("Sonda TCP", { destino: o.host, puerto: o.port, datos: Buffer.from(data).toString("hex") })
          return conv.request(data, until, opts)
        },
      }
    },
    tcpProbe: (o) => {
      log.debug("Sonda de conexión TCP", { destino: o.host, puerto: o.port })
      return t.tcpProbe(o)
    },
  }
}
