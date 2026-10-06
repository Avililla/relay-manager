#!/usr/bin/env node
// Fake TP-Link Easy Smart switch (TL-SG108E v3) for development and tests: the management web pages of the real
// switch (test/fixtures/tplink-sg108e-v3, captured with read-only requests, no credentials) with their data blocks
// generated from a model of the switch, and the .cgi endpoints the pages' forms use, applied to that model.
//
//   node scripts/sim/fake-tplink-switch.mjs [--port 18099] [--host 127.0.0.1] [--ports 8] [--client-port 1]
//                                           [--links 1,4] [--vlan1-readonly] [--no-lockout]
//
// Model: the session is per client IP (like the real one); `clientPort` is the switch port the "server" is plugged
// into. With lockout emulation on, a request is dropped (socket destroyed) whenever that port could not reach the
// management (untagged VLAN 1 + PVID 1): exactly what a real lockout looks like from the server.
// Test controls (not on the real switch): GET /__sim/state, POST /__sim/link?port=4&up=1, POST /__sim/client?port=3,
// POST /__sim/reset.
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.resolve(HERE, "..", "..", "test", "fixtures", "tplink-sg108e-v3")
const page = (f) => fs.readFileSync(path.join(FIX, f), "latin1")

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const mask = (ports) => ports.reduce((m, p) => (m | (1 << (p - 1))) >>> 0, 0)
const hex = (n) => `0x${n.toString(16).toUpperCase()}`

function freshState(o) {
  const n = o.ports
  return {
    model: o.model, hardware: o.hardware, firmware: o.firmware, mac: o.mac, ip: o.ip,
    portCount: n,
    dot1q: { enabled: false, vlans: [], pvids: range(1, n).map(() => 1) },
    portBased: true, mtu: false,
    links: range(1, n).map((p) => o.links.includes(p)),
    rx: range(1, n).map(() => 0), tx: range(1, n).map(() => 0),
    saved: null, saves: 0,
  }
}

/** Replaces the first <script>…</script> data block of a fixture page. */
function withData(html, data) {
  const i = html.indexOf("<script>")
  const j = html.indexOf("</script>", i)
  return `${html.slice(0, i)}<script>\n${data}\n</script>${html.slice(j + "</script>".length)}`
}

export async function createFakeSwitch(opts = {}) {
  const o = {
    port: 0, host: "127.0.0.1", ports: 8, clientPort: 1, links: [1], vlan1Editable: true, lockout: true,
    username: "admin", password: "admin", model: "TL-SG108E", hardware: "TL-SG108E 3.0",
    firmware: "1.0.0 Build 20160722 Rel.50167", mac: "B0:4E:26:37:E9:59", ip: "192.168.0.99", ...opts,
  }
  let st = freshState(o)
  let clientPort = o.clientPort
  const sessions = new Set()
  const log = []
  const fail = new Map()     // path prefix → count of requests to reject (test hook)

  const managementReachable = () => {
    if (!o.lockout || !st.dot1q.enabled) return true
    const v1 = st.dot1q.vlans.find((v) => v.vid === 1)
    return !!v1 && v1.untagged.includes(clientPort) && st.dot1q.pvids[clientPort - 1] === 1
  }

  const pages = {
    "/SystemInfoRpm.htm": () => withData(page("SystemInfoRpm.htm"), `var info_ds = {\ndescriStr:[\n"${st.model}"\n],\nmacStr:[\n"${st.mac}"\n],\nipStr:[\n"${st.ip}"\n],\nnetmaskStr:[\n"255.255.255.0"\n],\ngatewayStr:[\n"0.0.0.0"\n],\nfirmwareStr:[\n"${st.firmware}"\n],\nhardwareStr:[\n"${st.hardware}"\n]\n};\nvar tip = "";`),
    "/PortSettingRpm.htm": () => {
      const n = st.portCount
      const pad = (xs) => [...xs, 0, 0].join(",")
      return withData(page("PortSettingRpm.htm"), `var max_port_num = ${n};\nvar port_middle_num  = 16;\nvar all_info = {\nstate:[${pad(range(1, n).map(() => 1))}],\ntrunk_info:[${pad(range(1, n).map(() => 0))}],\nspd_cfg:[${pad(range(1, n).map(() => 1))}],\nspd_act:[${pad(st.links.map((l) => (l ? 6 : 0)))}],\nfc_cfg:[${pad(range(1, n).map(() => 0))}],\nfc_act:[${pad(range(1, n).map(() => 0))}]\n};\nvar tip = "";`)
    },
    "/PortStatisticsRpm.htm": () => {
      const n = st.portCount
      const pk = range(0, n - 1).flatMap((i) => [st.tx[i], 0, st.rx[i], 0])
      return withData(page("PortStatisticsRpm.htm"), `var max_port_num = ${n};\nvar port_middle_num  = 16;\nvar all_info = {\nstate:[${[...range(1, n).map(() => 1), 0, 0].join(",")}],\nlink_status:[${[...st.links.map((l) => (l ? 6 : 0)), 0, 0].join(",")}],\npkts:[${[...pk, 0, 0].join(",")}]\n};\nvar tip = "";`)
    },
    "/Vlan8021QRpm.htm": (tip = "") => {
      const q = st.dot1q
      const v = q.enabled ? q.vlans : []
      return withData(page("Vlan8021QRpm.htm"), `var qvlan_ds = {\nstate:${q.enabled ? 1 : 0},\nportNum:${st.portCount},\nvids:[\n${v.map((x) => x.vid).join(",")}\n],\ncount:${v.length},\nmaxVids:32,\nnames:[\n${v.map((x) => JSON.stringify(x.name)).join(",")}\n],\ntagMbrs:[\n${v.map((x) => hex(mask(x.tagged))).join(",")}\n],\nuntagMbrs:[\n${v.map((x) => hex(mask(x.untagged))).join(",")}\n],\nlagIds:[\n${range(1, st.portCount).map(() => 0).join(",")}\n],\nlagMbrs:[\n0,0x0,0x0\n]\n};var tip = ${JSON.stringify(tip)};`)
    },
    "/Vlan8021QPvidRpm.htm": (tip = "") => {
      const q = st.dot1q
      const v = q.enabled ? q.vlans : []
      return withData(page("Vlan8021QPvidRpm.htm"), `var pvid_ds = {\nstate:${q.enabled ? 1 : 0},\nportNum:${st.portCount},\nvids:[\n${v.map((x) => x.vid).join(",")}\n],\ncount:${v.length},\nmbrs:[\n${v.map((x) => hex(mask([...x.untagged, ...x.tagged]))).join(",")}\n],\npvids:[\n${q.pvids.join(",")}\n],\nlagIds:[\n${range(1, st.portCount).map(() => 0).join(",")}\n],\nlagMbrs:[\n0,0x0,0x0\n]\n};var tip = ${JSON.stringify(tip)};`)
    },
    "/VlanPortBasicRpm.htm": () => withData(page("VlanPortBasicRpm.htm"), `var pvlan_ds = {\nstate:${st.portBased ? 1 : 0},\nportNum:${st.portCount},\nvids:[\n1\n],\ncount:1,\nmbrs:[\n${hex(mask(range(1, st.portCount)))}\n],\nlagIds:[\n${range(1, st.portCount).map(() => 0).join(",")}\n],\nlagMbrs:[\n0,0x0,0x0\n]\n};var tip = "";`),
    "/VlanMtuRpm.htm": () => withData(page("VlanMtuRpm.htm"), `var mtu_ds = {\nstate:${st.mtu ? 1 : 0},\nportNum:${st.portCount},\nuplinkPort:1\n};\nvar tip = "";`),
    "/ConfigRpm.htm": () => page("ConfigRpm.htm"),
    "/SavingConfigRpm.htm": () => page("SavingConfigRpm.htm"),
    "/": () => page("root.htm"),
  }

  function qvlanSet(q) {
    const d = st.dot1q
    if (q.has("qvlan_mode")) {
      const on = q.get("qvlan_en") === "1"
      if (on && !d.enabled) {
        st.dot1q = { enabled: true, vlans: [{ vid: 1, name: "", untagged: range(1, st.portCount), tagged: [] }], pvids: range(1, st.portCount).map(() => 1) }
        st.portBased = false
        st.mtu = false
      } else if (!on && d.enabled) {
        st.dot1q = { enabled: false, vlans: [], pvids: range(1, st.portCount).map(() => 1) }
      }
      return ""
    }
    if (!d.enabled) return "802.1Q VLAN should be enabled before adding or modifying 802.1Q VLAN group!"
    if (q.has("qvlan_add")) {
      const vid = Number(q.get("vid"))
      const name = q.get("vname") ?? ""
      if (!Number.isInteger(vid) || vid < 1 || vid > 4094 || (vid === 1 && !o.vlan1Editable)) return "VLAN ID must be in range of 2-4094!"
      if (!/^[A-Za-z0-9_-]{0,10}$/.test(name)) return "VLAN name is illegal."
      const untagged = []
      const tagged = []
      for (let p = 1; p <= st.portCount; p++) {
        const t = q.get(`selType_${p}`) ?? "2"
        if (t === "0") untagged.push(p)
        else if (t === "1") tagged.push(p)
      }
      if (!untagged.length && !tagged.length) return "Please select at least one port."
      const exists = d.vlans.find((v) => v.vid === vid)
      if (!exists && d.vlans.length >= 32) return "The amount of VLAN is full!"
      // A port whose PVID is this VLAN cannot leave it.
      for (let p = 1; p <= st.portCount; p++) {
        if (d.pvids[p - 1] === vid && !untagged.includes(p) && !tagged.includes(p)) return `Port ${p} PVID is ${vid}.`
      }
      const v = { vid, name: vid === 1 ? (exists?.name ?? "") : name, untagged, tagged }
      d.vlans = exists ? d.vlans.map((x) => (x.vid === vid ? v : x)) : [...d.vlans, v].sort((a, b) => a.vid - b.vid)
      return ""
    }
    if (q.has("qvlan_del")) {
      const vids = q.getAll("selVlans").map(Number)
      for (const vid of vids) {
        if (vid === 1) return "VLAN 1 can not be deleted."
        if (d.pvids.includes(vid)) return `VLAN ${vid} is the PVID of some port.`
      }
      d.vlans = d.vlans.filter((v) => !vids.includes(v.vid))
      return ""
    }
    return "Unknown operation."
  }

  function pvidSet(q) {
    const d = st.dot1q
    if (!d.enabled) return "802.1Q VLAN should be enabled before setting PVID!"
    const pvid = Number(q.get("pvid"))
    const pbm = Number(q.get("pbm"))
    const v = d.vlans.find((x) => x.vid === pvid)
    if (!v) return `VLAN ${pvid} doesn't exist.`
    for (let p = 1; p <= st.portCount; p++) {
      if (!((pbm >>> (p - 1)) & 1)) continue
      if (!v.untagged.includes(p) && !v.tagged.includes(p)) return `Port ${p} is not member of VLAN ${pvid}!`
    }
    for (let p = 1; p <= st.portCount; p++) if ((pbm >>> (p - 1)) & 1) d.pvids[p - 1] = pvid
    return ""
  }

  function send(res, status, body, type = "text/html") {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache", Connection: "close" })
    res.end(body)
  }
  const loginPage = (code = 0) => page("login.htm").replace(/var logonInfo = new Array\([\s\S]*?\);/, `var logonInfo = new Array(\n${code},\n0,0);`)

  const server = http.createServer((req, res) => {
    const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "")
    const url = new URL(req.url ?? "/", "http://x")
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      if (url.pathname.startsWith("/__sim/")) return control(url, res)
      log.push({ method: req.method, path: url.pathname, query: url.search, ip })
      // Every request crosses the server's switch port (packet counters: "which port is the server on?").
      st.rx[clientPort - 1] += 7
      st.tx[clientPort - 1] += 6
      if (!managementReachable()) { req.socket.destroy(); return }
      for (const [prefix, n] of fail) {
        if (n > 0 && url.pathname.startsWith(prefix)) {
          fail.set(prefix, n - 1)
          req.socket.destroy()
          return
        }
      }
      if (url.pathname === "/logon.cgi" && req.method === "POST") {
        const f = new URLSearchParams(body)
        const ok = f.get("username") === o.username && f.get("password") === o.password
        if (ok) sessions.add(ip)
        return send(res, 401, loginPage(ok ? 0 : 1))
      }
      if (url.pathname === "/Logout.htm") {
        sessions.delete(ip)
        return send(res, 401, loginPage(0))
      }
      if (!sessions.has(ip)) return send(res, 401, loginPage(0))
      if (url.pathname === "/qvlanSet.cgi") {
        const tip = qvlanSet(url.searchParams)
        if (!managementReachable()) { req.socket.destroy(); return }
        return send(res, 200, pages["/Vlan8021QRpm.htm"](tip))
      }
      if (url.pathname === "/vlanPvidSet.cgi") {
        const tip = pvidSet(url.searchParams)
        if (!managementReachable()) { req.socket.destroy(); return }
        return send(res, 200, pages["/Vlan8021QPvidRpm.htm"](tip))
      }
      if (url.pathname === "/savingconfig.cgi" && req.method === "POST") {
        if (new URLSearchParams(body).get("action_op") === "save") {
          st.saved = JSON.parse(JSON.stringify(st.dot1q))
          st.saves++
        }
        return send(res, 200, withData(page("SavingConfigRpm.htm"), 'var tip="Operation successful.";'))
      }
      if (url.pathname === "/config_back.cgi") {
        const cfg = Buffer.concat([Buffer.from([0x23, 0x89, 0x23, 0x89]), Buffer.from(JSON.stringify({ fake: true, model: st.model, dot1q: st.dot1q }))])
        res.writeHead(200, { "Content-Type": "application/octet-stream; name=config.cfg", Connection: "close" })
        return res.end(cfg)
      }
      const render = pages[url.pathname]
      if (!render) { req.socket.destroy(); return } // the real switch hangs up on unknown pages
      return send(res, 200, render())
    })
  })

  function control(url, res) {
    const q = url.searchParams
    if (url.pathname === "/__sim/state") return send(res, 200, JSON.stringify({ ...st, clientPort, sessions: [...sessions], requests: log.length }), "application/json")
    if (url.pathname === "/__sim/link") {
      const p = Number(q.get("port"))
      if (p >= 1 && p <= st.portCount) st.links[p - 1] = q.get("up") === "1"
    } else if (url.pathname === "/__sim/client") clientPort = Number(q.get("port")) || 1
    else if (url.pathname === "/__sim/reset") { st = freshState(o); sessions.clear() }
    else if (url.pathname === "/__sim/fail") fail.set(q.get("path") ?? "", Number(q.get("n") ?? 1))
    return send(res, 200, "{}", "application/json")
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(o.port, o.host, resolve)
  })
  const port = server.address().port
  return {
    port,
    host: o.host,
    state: () => st,
    log,
    setLink(p, up) { st.links[p - 1] = up },
    setClientPort(p) { clientPort = p },
    failNext(prefix, n = 1) { fail.set(prefix, n) },
    reset() { st = freshState(o); sessions.clear() },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2)
  const val = (name, d) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : d
  }
  const sw = await createFakeSwitch({
    port: Number(val("--port", "18099")), host: val("--host", "127.0.0.1"), ports: Number(val("--ports", "8")),
    clientPort: Number(val("--client-port", "1")), links: String(val("--links", "1")).split(",").map(Number).filter(Boolean),
    vlan1Editable: !args.includes("--vlan1-readonly"), lockout: !args.includes("--no-lockout"),
  })
  process.stdout.write(`Switch TP-Link simulado (TL-SG108E) en http://${sw.host}:${sw.port}/ (usuario admin, contraseña admin)\n`)
  const stop = () => { void sw.close().then(() => process.exit(0)) }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}
