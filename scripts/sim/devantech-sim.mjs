#!/usr/bin/env node
// Devantech relay board simulator (zero dependencies, Node >= 22). Library + CLI (§10.1).
// Emulates, on one host:
//   - dS stock app HTTP:   GET /index.xml (32 RlyN + the model's IO tags), GET /index.htm (<title>, dscript.cgi buttons),
//                          GET /dscript.cgi?<var>=N (toggle, or pulse when configured with --pulse)
//   - dS ASCII TCP:        ST, SR <n> on|off [ms] (<=2 set, 3 toggle, 4..18 ignored, >=19 pulse), GR <n>
//   - ETH HTTP:            Basic auth, GET /io.cgi?DOAn=t|DOIn=t, GET /status.xml
//   - ETH binary TCP:      0x10 0x20 0x21 0x23 0x24 0x79 0x7A
//   - UDP 30303 responder: Harmony TLV reply to --reply-to (default 127.255.255.255), plus the simulator-only 0x7F
//                          field with the HTTP port. The reply is sent from --host, so the datagram source is the board IP.
//
// CLI:
//   node scripts/sim/devantech-sim.mjs --model dS378 --host 127.0.0.2 --http 18080 --ascii 17123 --udp
//   node scripts/sim/devantech-sim.mjs --model ETH008 --host 127.0.0.3 --http 18081 --eth 17494 --user admin --pass password --udp
// Flags: --model --host --hostname --http --ascii --eth --udp --udp-port --reply-to --udp-unicast --var --user --pass
//        --tcp-pass --latency --fail-rate --mac --pulse "3=500,4=19" --announce-ip
import dgram from "node:dgram"
import http from "node:http"
import net from "node:net"
import { pathToFileURL } from "node:url"

const range = (n) => Array.from({ length: n }, (_, i) => i + 1)

/** Physical relays, module id (UDP 0x40 / ETH 0x10) and the IO tag set of the stock index.xml. */
export const MODELS = {
  dS1242: { family: "ds", relays: 2, moduleId: 31, io: ["AD1", "AD2", "IO1", "IO2", "IO3", "IO4"] },
  dS2242: { family: "ds", relays: 2, moduleId: 32, io: ["AD1", "AD2", "AD3", "AD4", "IO1", "IO2", "IO3", "IO4"] },
  dS3484: { family: "ds", relays: 4, moduleId: 30, io: ["AD1", "AD2", "AD3", "AD4", ...range(8).map((i) => `IO${i}`)] },
  TCP184: { family: "ds", relays: 4, moduleId: 36, io: range(8).flatMap((i) => [`IO${i}`, `IO${i}_s`]) },
  dS378: { family: "ds", relays: 8, moduleId: 35, io: range(7).flatMap((i) => [`IO${i}`, `IO${i}_s`]) },
  dS2408: { family: "ds", relays: 8, moduleId: 47, io: range(40).map((i) => `IO${i}`) },
  dS2824: { family: "ds", relays: 24, moduleId: 34, io: range(8).flatMap((i) => [`IO${i}`, `IO${i}_s`]) },
  dS2832: { family: "ds", relays: 32, moduleId: 42, io: range(8).flatMap((i) => [`IO${i}`, `IO${i}_s`]) },
  ETH002: { family: "eth", relays: 2, moduleId: 18 },
  ETH008: { family: "eth", relays: 8, moduleId: 19 },
  ETH484: { family: "eth", relays: 4, moduleId: 20 },
  ETH8020: { family: "eth", relays: 20, moduleId: 21 },
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function parsePulse(p) {
  if (!p) return {}
  if (typeof p === "object") return Object.fromEntries(Object.entries(p).map(([k, v]) => [Number(k), Number(v)]))
  return Object.fromEntries(String(p).split(",").filter(Boolean).map((kv) => kv.split("=").map(Number)))
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => { server.off("error", reject); resolve(server.address().port) })
  })
}

/**
 * Starts a simulated board. Ports: a number (0 = random) enables the protocol; null/undefined/false disables it
 * (except `http`, which defaults to 0).
 */
export async function createSimulator(opts = {}) {
  const modelName = opts.model ?? "dS378"
  const model = MODELS[modelName]
  if (!model) throw new Error(`Modelo desconocido: ${modelName}`)
  const host = opts.host ?? "127.0.0.1"
  const hostname = opts.hostname ?? modelName
  const toggleVar = opts.toggleVar ?? opts.var ?? "V20944"
  const latency = Number(opts.latency ?? 0)
  const failRate = Number(opts.failRate ?? 0)
  const macStr = (opts.mac ?? "00:04:a3:00:00:01").toLowerCase()
  const mac = macStr.split(":").map((h) => parseInt(h, 16))
  const pulseCfg = parsePulse(opts.pulse)
  const udpPort = Number(opts.udpPort ?? 30303)
  const replyTo = opts.replyTo ?? "127.255.255.255"
  const logFn = opts.log === false ? () => {} : typeof opts.log === "function" ? opts.log : (m) => console.log(`[${modelName} ${host}] ${m}`)
  const VIRTUAL = model.family === "ds" ? 32 : model.relays // dS apps expose 32 relays (physical + virtual)
  const relays = new Array(VIRTUAL).fill(false)
  if (Array.isArray(opts.initial)) opts.initial.forEach((v, i) => { if (i < VIRTUAL) relays[i] = Boolean(v) })
  const timers = new Map()
  const requests = []
  const closers = []
  const sockets = new Set()
  const ports = { http: null, ascii: null, eth: null, udp: null }

  function setRelay(n, on, pulseMs = 0) {
    if (!(n >= 1 && n <= VIRTUAL)) return false
    clearTimeout(timers.get(n))
    relays[n - 1] = on
    if (pulseMs > 0) {
      const t = setTimeout(() => { relays[n - 1] = !on; logFn(`relé ${n} fin de pulso -> ${!on ? "ON" : "OFF"}`) }, pulseMs)
      t.unref?.()
      timers.set(n, t)
    }
    logFn(`relé ${n} -> ${on ? "ON" : "OFF"}${pulseMs ? ` (pulso ${pulseMs} ms)` : ""}`)
    return true
  }
  const shouldFail = () => failRate > 0 && Math.random() < failRate
  const track = (sock) => { sockets.add(sock); sock.on("close", () => sockets.delete(sock)) }

  // ---------------- HTTP ----------------
  const httpOpt = opts.http === undefined ? 0 : opts.http
  if (httpOpt !== null && httpOpt !== false) {
    const basic = opts.user ? "Basic " + Buffer.from(`${opts.user}:${opts.pass ?? ""}`).toString("base64") : null
    const server = http.createServer(async (req, res) => {
      if (latency) await delay(latency)
      if (shouldFail()) { req.socket.destroy(); return }
      const url = new URL(req.url ?? "/", "http://sim")
      requests.push({ proto: "http", method: req.method, path: url.pathname, query: url.search })
      const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type, Connection: "close" }); res.end(body) }

      if (model.family === "ds") {
        if (opts.pass && ["/index.xml", "/index.htm", "/dscript.cgi"].includes(url.pathname)) {
          return send(200, "text/html", "<html><body><h3>You do not have permission to view this page</h3></body></html>")
        }
        if (url.pathname === "/index.xml") {
          const tags = relays.map((v, i) => `<Rly${i + 1}>${v ? 1 : 0}</Rly${i + 1}>`).join("") + model.io.map((t) => `<${t}>0</${t}>`).join("")
          return send(200, "text/xml", `<?xml version="1.0" encoding="UTF-8"?><response>${tags}<PingTime1>0</PingTime1></response>`)
        }
        if (url.pathname === "/index.htm") {
          const buttons = relays.map((_, i) => `<button id="Rly${i + 1}" onmousedown="newAJAXCommand('dscript.cgi?${toggleVar}=${i + 1}');">Relay ${i + 1}</button>`).join("\n")
          return send(200, "text/html", `<!DOCTYPE HTML><html><head><title>${hostname}</title></head><body onload="startAJAX()">\n${buttons}\n</body></html>`)
        }
        if (url.pathname === "/dscript.cgi") {
          const n = Number(url.searchParams.get(toggleVar))
          if (n >= 1 && n <= VIRTUAL) {
            const p = pulseCfg[n]
            if (p && p >= 19) setRelay(n, true, p)
            else setRelay(n, !relays[n - 1])
          }
          return send(200, "text/plain", "")
        }
        return send(404, "text/html", "<html><body>File not found</body></html>")
      }

      // ETH family: HTTP Basic on every page.
      if (basic && req.headers.authorization !== basic) {
        res.writeHead(401, { "WWW-Authenticate": `Basic realm="${modelName}"`, Connection: "close" })
        return res.end()
      }
      if (url.pathname === "/status.xml") {
        const tags = relays.map((v, i) => `<relay${i + 1}>${v ? 1 : 0}</relay${i + 1}>`).join("")
        return send(200, "text/xml", `<response>${tags}<vin>12.1</vin></response>`)
      }
      if (url.pathname === "/io.cgi") {
        for (const [k, v] of url.searchParams) {
          const m = /^DO([AI])(\d+)$/.exec(k)
          if (m) setRelay(Number(m[2]), m[1] === "A", Number(v) * 100)
        }
        return send(200, "text/plain", relays.map((v) => (v ? 1 : 0)).join(""))
      }
      if (url.pathname === "/") return send(200, "text/html", `<html><head><title>${modelName}</title></head></html>`)
      return send(404, "text/html", "not found")
    })
    server.on("connection", track)
    ports.http = await listen(server, Number(httpOpt), host)
    logFn(`HTTP en ${host}:${ports.http}`)
    closers.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }))
  }

  // ---------------- dS ASCII TCP (17123) ----------------
  if (opts.ascii !== undefined && opts.ascii !== null && opts.ascii !== false && model.family === "ds") {
    const server = net.createServer((sock) => {
      track(sock)
      let pending = ""
      sock.on("data", async (buf) => {
        pending += buf.toString("latin1")
        let idx
        while ((idx = pending.search(/\r?\n/)) >= 0) {
          const line = pending.slice(0, idx).trim()
          pending = pending.slice(pending[idx] === "\r" ? idx + 2 : idx + 1)
          if (!line) continue
          requests.push({ proto: "ascii", line })
          if (latency) await delay(latency)
          if (shouldFail()) { sock.destroy(); return }
          sock.write(asciiCommand(line))
        }
      })
      sock.on("error", () => {})
    })
    const asciiCommand = (line) => {
      const parts = line.split(/\s+/)
      const cmd = (parts[0] ?? "").toLowerCase()
      if (cmd === "st") {
        return `Module Type: ${modelName}\r\nSystem Firmware Version: 4.12\r\nApplication Firmware Version: 4.12\r\nSupply Voltage: 12.1\r\nBoard Temperature: 25.0C\r\n`
      }
      if (cmd === "sr") {
        const n = Number(parts[1])
        const act = (parts[2] ?? "").toLowerCase()
        const ms = Number(parts[3] ?? 0)
        const on = ["on", "a", "active"].includes(act) ? true : ["off", "i", "inactive"].includes(act) ? false : null
        if (on === null) return "Unknown Action\r\n"
        if (!(n >= 1 && n <= 32)) return "Unknown relay number\r\n"
        // mirrors app-dS378-v4-12 SetRelay(): <=2 set, 3 toggle, 4..18 ignored, >=19 pulse (ms)
        if (ms <= 2) setRelay(n, on)
        else if (ms <= 3) setRelay(n, !relays[n - 1])
        else if (ms >= 19) setRelay(n, on, ms)
        return "Ok\r\n"
      }
      if (cmd === "gr") {
        const n = Number(parts[1])
        return n >= 1 && n <= 32 ? (relays[n - 1] ? "Active\r\n" : "InActive\r\n") : "Unknown relay number\r\n"
      }
      return "Unknown Command\r\n"
    }
    server.on("connection", track)
    ports.ascii = await listen(server, Number(opts.ascii), host)
    logFn(`dS ASCII TCP en ${host}:${ports.ascii}`)
    closers.push(() => new Promise((r) => server.close(() => r())))
  }

  // ---------------- ETH binary TCP (17494) ----------------
  if (opts.eth !== undefined && opts.eth !== null && opts.eth !== false && model.family === "eth") {
    const tcpPass = opts.tcpPass ?? null
    const server = net.createServer((sock) => {
      track(sock)
      let unlocked = !tcpPass
      sock.on("data", async (b) => {
        requests.push({ proto: "eth", bytes: [...b] })
        if (latency) await delay(latency)
        if (shouldFail()) { sock.destroy(); return }
        const c = b[0]
        if (c === 0x10) return sock.write(Buffer.from([model.moduleId, 1, 28]))
        if (c === 0x79) { unlocked = b.subarray(1).toString("latin1") === tcpPass; return sock.write(Buffer.from([unlocked ? 1 : 2])) }
        if (c === 0x7a) return sock.write(Buffer.from([tcpPass ? (unlocked ? 30 : 0) : 255]))
        if (c === 0x24) {
          // ETH484 answers relays + digital outputs (2 bytes); the others ceil(N/8) bytes, bit0 = relay 1.
          const out = Buffer.alloc(modelName === "ETH484" ? 2 : Math.ceil(model.relays / 8))
          relays.forEach((v, i) => { if (v) out[i >> 3] |= 1 << (i & 7) })
          return sock.write(out)
        }
        if (c === 0x20 || c === 0x21) {
          if (!unlocked) return sock.write(Buffer.from([1]))
          return sock.write(Buffer.from([setRelay(b[1], c === 0x20, (b[2] ?? 0) * 100) ? 0 : 1]))
        }
        if (c === 0x23) {
          if (!unlocked) return sock.write(Buffer.from([1]))
          relays.forEach((_, i) => setRelay(i + 1, Boolean(b[1 + (i >> 3)] & (1 << (i & 7)))))
          return sock.write(Buffer.from([0]))
        }
        // Unknown opcodes get no reply at all, like the real firmware.
      })
      sock.on("error", () => {})
    })
    server.on("connection", track)
    ports.eth = await listen(server, Number(opts.eth), host)
    logFn(`ETH TCP binario en ${host}:${ports.eth}`)
    closers.push(() => new Promise((r) => server.close(() => r())))
  }

  // ---------------- UDP 30303 discovery responder ----------------
  let announce = async () => {}
  if (opts.udp) {
    const announcedIp = (opts.announceIp ?? (net.isIPv4(host) && host !== "0.0.0.0" ? host : "127.0.0.1")).split(".").map(Number)
    const CRLF = [0x0d, 0x0a]
    const cmdPort = model.family === "ds" ? Number(ports.ascii ?? 17123) : Number(ports.eth ?? 17494)
    const httpPort = Number(ports.http ?? 80)
    const reply = Buffer.from([
      0x02, ...mac, ...CRLF,
      0x03, ...Buffer.from("ETH"), ...CRLF,
      0x04, ...Buffer.from(hostname), ...CRLF,
      0x05, ...announcedIp, ...CRLF,
      ...CRLF, // Harmony "user start" separator
      0x40, model.moduleId, ...CRLF,
      0x41, (cmdPort >> 8) & 0xff, cmdPort & 0xff, ...CRLF,
      // non-standard, simulator only: lets one host emulate several boards on high ports
      0x7f, (httpPort >> 8) & 0xff, httpPort & 0xff, ...CRLF,
    ])
    const rx = dgram.createSocket({ type: "udp4", reuseAddr: true })
    const tx = dgram.createSocket({ type: "udp4" })
    rx.on("error", (e) => logFn(`UDP: ${e.message}`))
    tx.on("error", (e) => logFn(`UDP: ${e.message}`))
    await new Promise((resolve, reject) => { rx.once("error", reject); rx.bind(udpPort, "0.0.0.0", () => { rx.off("error", reject); resolve() }) })
    await new Promise((resolve, reject) => {
      tx.once("error", reject)
      tx.bind(0, net.isIPv4(host) ? host : "0.0.0.0", () => { tx.off("error", reject); resolve() })
    })
    rx.setBroadcast(true)
    tx.setBroadcast(true)
    ports.udp = rx.address().port
    const sendReply = (to) => new Promise((resolve) => tx.send(reply, udpPort, to, () => resolve()))
    rx.on("message", (msg, rinfo) => {
      if (msg[0] !== 0x44 /* 'D' */) return // ignore replies (ours and other devices')
      requests.push({ proto: "udp", from: rinfo.address })
      void sendReply(opts.udpUnicast ? rinfo.address : replyTo)
    })
    announce = () => sendReply(replyTo)
    logFn(`UDP de descubrimiento en :${ports.udp} (respuestas a ${opts.udpUnicast ? "origen" : replyTo})`)
    closers.push(() => new Promise((r) => { try { tx.close() } catch {} try { rx.close(() => r()) } catch { r() } }))
  }

  return {
    model: modelName, host, hostname, mac: macStr, toggleVar, moduleId: model.moduleId, relayCount: model.relays,
    ports,
    requests,
    state: () => [...relays],
    setRelay: (n, on) => { setRelay(n, on) },
    announce: () => announce(),
    async stop() {
      for (const t of timers.values()) clearTimeout(t)
      for (const s of sockets) s.destroy()
      await Promise.all(closers.map((c) => c()))
    },
  }
}

// ---------------- CLI ----------------
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith("--")) { out[a.slice(2)] = next; i++ } else out[a.slice(2)] = "true"
  }
  return out
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const num = (v) => (v === undefined ? undefined : Number(v))
  const sim = await createSimulator({
    model: a.model, host: a.host, hostname: a.hostname,
    http: num(a.http) ?? 18080, ascii: num(a.ascii), eth: num(a.eth),
    udp: a.udp === "true", udpPort: num(a["udp-port"]), replyTo: a["reply-to"], udpUnicast: a["udp-unicast"] === "true",
    toggleVar: a.var, user: a.user, pass: a.pass, tcpPass: a["tcp-pass"],
    latency: num(a.latency), failRate: num(a["fail-rate"]), mac: a.mac, pulse: a.pulse, announceIp: a["announce-ip"],
  })
  const stop = () => { sim.stop().finally(() => process.exit(0)) }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`Error del simulador: ${e.message}`); process.exit(1) })
}
