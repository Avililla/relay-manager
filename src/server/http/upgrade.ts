import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { STATUS_CODES } from "node:http"
import type { Runtime } from "@/server/runtime/types"
import { sanitizeForwarded } from "./forwarded"
import { isOriginAllowed } from "./origin"

/** Writes a bare HTTP error on a raw upgrade socket and destroys it. */
export function rejectHttp(socket: Duplex, code: number): void {
  try {
    if (!socket.destroyed && socket.writable) {
      socket.write(`HTTP/1.1 ${code} ${STATUS_CODES[code] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
  } catch {
    // the socket is going away anyway
  }
  socket.destroy()
}

type UpgradeRuntime = Pick<Runtime, "config" | "serial" | "log">

/**
 * Our 'upgrade' listener (§2.9, D11): handles /ws/* only and returns for every other path, so Next's own listener
 * (dev HMR) serves those. It never throws on attacker input and never leaks a socket.
 */
export function attachUpgradeRouter(server: Pick<Server, "on">, rt: UpgradeRuntime): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy())
    let url: URL
    try { url = new URL(req.url ?? "/", "http://localhost") } catch { return rejectHttp(socket, 400) }
    if (!url.pathname.startsWith("/ws/")) return // Next HMR and anything else: not ours
    try {
      sanitizeForwarded(req, rt.config)
      if (!isOriginAllowed(req, rt.config)) return rejectHttp(socket, 403)
      const c = /^\/ws\/console\/([A-Za-z0-9]{1,64})$/.exec(url.pathname)
      if (c) return rt.serial.handleUpgrade(req, socket, head, { kind: "console", consoleId: c[1] })
      const p = /^\/ws\/preview\/([^/]{1,300})$/.exec(url.pathname)
      if (p) {
        let stableKey: string
        try { stableKey = decodeURIComponent(p[1]) } catch { return rejectHttp(socket, 400) }
        const baud = Number(url.searchParams.get("baud") ?? "115200")
        return rt.serial.handleUpgrade(req, socket, head, { kind: "preview", stableKey, baudRate: baud })
      }
      return rejectHttp(socket, 404)
    } catch (err) {
      rt.log.child("ws").error("Error al atender upgrade", { err })
      return rejectHttp(socket, 500)
    }
  })
}
