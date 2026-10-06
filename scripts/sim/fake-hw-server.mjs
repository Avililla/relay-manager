#!/usr/bin/env node
// Fake Xilinx hw_server for development and tests (RM_HW_SERVER=scripts/sim/fake-hw-server.mjs). Accepts the options
// relay-manager uses (-s tcp:<host>:<port>, -p<n>, -e "<command>") and listens on the port; every client first receives
// one recognisable line with what it was started with, then its own lines echoed back:
//   fake-hw_server port=3201 jtag-port-filter=210299ABCDEF gdb=0
// Prints a banner like the real one (the version is parsed by the server). No dependencies.
import net from "node:net"

const args = process.argv.slice(2)
let host = ""
let port = 3121
let gdb = "3000"
const commands = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "-s" || a.startsWith("-s")) {
    const v = a === "-s" ? args[++i] : a.slice(2)
    const m = /^tcp:([^:]*):(\d+)$/.exec(v ?? "")
    if (!m) {
      console.error(`ERROR: -s no válido: ${v}`)
      process.exit(2)
    }
    host = m[1]
    port = Number(m[2])
  } else if (a.startsWith("-p")) {
    gdb = a === "-p" ? args[++i] : a.slice(2)
  } else if (a === "-e") {
    commands.push(args[++i] ?? "")
  }
}
const filter = commands.map((c) => /^set jtag-port-filter\s+(.+)$/.exec(c.trim())?.[1]).find(Boolean) ?? ""

console.log("")
console.log("****** Xilinx hw_server v2099.1 (simulado)")
console.log("  **** Build date : simulado")
console.log("")
console.log(`INFO: hw_server application started`)
console.log(`INFO: jtag-port-filter=${filter || "(ninguno)"}`)

if (process.env.FAKE_HW_SERVER_FAIL) {
  console.error("ERROR: fallo simulado")
  process.exit(1)
}
const delay = Number(process.env.FAKE_HW_SERVER_DELAY_MS ?? 0)

const clients = new Set()
const server = net.createServer((c) => {
  clients.add(c)
  c.on("close", () => clients.delete(c))
  c.on("error", () => {})
  c.write(`fake-hw_server port=${port} jtag-port-filter=${filter} gdb=${gdb}\n`)
  let buf = ""
  c.on("data", (d) => {
    buf += d.toString("utf8")
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      c.write(`E: ${line}\n`)
    }
  })
})
server.on("error", (err) => {
  console.error(`ERROR: no se puede escuchar en ${host || "*"}:${port}: ${err.message}`)
  process.exit(1)
})
setTimeout(() => {
  server.listen({ port, host: host || undefined }, () => console.log(`INFO: To connect to this hw_server instance use url: TCP:${host || "localhost"}:${port}`))
}, delay)

const stop = () => {
  for (const c of clients) c.destroy()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
