#!/usr/bin/env node
// Switch TL-SG108E simulado para las capturas de los manuales (red de equipos), con control por un socket Unix.
//
//   node scripts/manuales/switch-sim.mjs --host 192.168.0.1 --port 80 --sock <carpeta>/switch.sock [--links 1,2,4,5]
//
// Es la web del switch de scripts/sim/fake-tplink-switch.mjs (la que usa el servidor para prepararlo). En el entorno
// del contenedor (red-equipos.sh) corre dentro del espacio de red del «switch», donde el servidor solo llega por el
// adaptador USB simulado; el control (enlace de un puerto, estado) va por un socket Unix, que sí se ve desde fuera:
//   GET /link?port=3&up=1   GET /state
import fs from "node:fs"
import http from "node:http"
import { createFakeSwitch } from "../sim/fake-tplink-switch.mjs"

const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const host = val("--host", "127.0.0.1")
const sock = val("--sock", null)
const sw = await createFakeSwitch({
  host, port: Number(val("--port", "0")), ip: val("--ip", host === "127.0.0.1" ? "192.168.0.1" : host),
  links: String(val("--links", "1")).split(",").map(Number).filter(Boolean),
})
process.stdout.write(`[switch] TL-SG108E simulado en http://${host}:${sw.port}/${sock ? `, control en ${sock}` : ""}\n`)

let ctl = null
if (sock) {
  try { fs.unlinkSync(sock) } catch { /* no estaba */ }
  ctl = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x")
    if (u.pathname === "/link") sw.setLink(Number(u.searchParams.get("port")), u.searchParams.get("up") === "1")
    else if (u.pathname !== "/state") { res.statusCode = 404; return res.end("?\n") }
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(sw.state()))
  })
  await new Promise((resolve) => ctl.listen(sock, resolve))
}
const stop = () => { ctl?.close(); void sw.close().then(() => process.exit(0)) }
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
