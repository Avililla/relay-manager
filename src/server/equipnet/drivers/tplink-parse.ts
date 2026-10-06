// Parsers for the web pages of TP-Link Easy Smart switches (TL-SG105E/108E/116E/1016DE/1024DE, hardware v2-v5,
// verified on a TL-SG108E v3 with firmware 1.0.0 Build 20160722). Every page carries its data as a JavaScript literal
// in a <script> at the top ("var qvlan_ds = {...};", "var logonInfo = new Array(0,0,0);"). This reads those
// literals with a tiny parser for the subset they use (objects, arrays, numbers incl. hex, strings); nothing is
// ever evaluated. Pure; unit-tested against the real pages in test/fixtures/tplink-sg108e-v3.
import type { Dot1qState, Dot1qVlan } from "@/lib/equipnet/switch-layout"

export type JsValue = number | string | boolean | null | JsValue[] | { [k: string]: JsValue }

class Reader {
  i = 0
  constructor(readonly s: string) {}
  ws(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++
      if (this.s.startsWith("//", this.i)) {
        const j = this.s.indexOf("\n", this.i)
        this.i = j < 0 ? this.s.length : j
      } else if (this.s.startsWith("/*", this.i)) {
        const j = this.s.indexOf("*/", this.i + 2)
        this.i = j < 0 ? this.s.length : j + 2
      } else return
    }
  }
  fail(what: string): never {
    throw new Error(`No se entiende la página del switch (${what} en ${this.i})`)
  }
  value(depth = 0): JsValue {
    if (depth > 20) this.fail("anidamiento")
    this.ws()
    const c = this.s[this.i]
    if (c === "{") return this.object(depth)
    if (c === "[") return this.array("]", depth)
    if (c === '"' || c === "'") return this.string()
    if (this.s.startsWith("new Array", this.i)) {
      this.i += "new Array".length
      this.ws()
      if (this.s[this.i] !== "(") this.fail("new Array")
      return this.array(")", depth)
    }
    const m = /^(-?0x[0-9a-fA-F]+|-?\d+(\.\d+)?|true|false|null)/.exec(this.s.slice(this.i, this.i + 40))
    if (!m) this.fail("valor")
    this.i += m[0].length
    if (m[0] === "true") return true
    if (m[0] === "false") return false
    if (m[0] === "null") return null
    return m[0].toLowerCase().includes("0x") ? Number.parseInt(m[0], 16) : Number(m[0])
  }
  string(): string {
    const q = this.s[this.i++]
    let out = ""
    while (this.i < this.s.length && this.s[this.i] !== q) {
      const c = this.s[this.i++]
      if (c === "\\") {
        const e = this.s[this.i++]
        out += e === "n" ? "\n" : e === "t" ? "\t" : e ?? ""
      } else out += c
    }
    if (this.s[this.i] !== q) this.fail("cadena")
    this.i++
    return out
  }
  array(close: "]" | ")", depth: number): JsValue[] {
    this.i++
    const out: JsValue[] = []
    for (;;) {
      this.ws()
      if (this.s[this.i] === close) { this.i++; return out }
      out.push(this.value(depth + 1))
      this.ws()
      if (this.s[this.i] === ",") { this.i++; continue }
      if (this.s[this.i] === close) { this.i++; return out }
      this.fail("lista")
    }
  }
  object(depth: number): { [k: string]: JsValue } {
    this.i++
    const out: { [k: string]: JsValue } = {}
    for (;;) {
      this.ws()
      if (this.s[this.i] === "}") { this.i++; return out }
      let key: string
      if (this.s[this.i] === '"' || this.s[this.i] === "'") key = this.string()
      else {
        const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 64))
        if (!m) this.fail("clave")
        key = m[0]
        this.i += key.length
      }
      this.ws()
      if (this.s[this.i] !== ":") this.fail("dos puntos")
      this.i++
      out[key] = this.value(depth + 1)
      this.ws()
      if (this.s[this.i] === ",") { this.i++; continue }
      if (this.s[this.i] === "}") { this.i++; return out }
      this.fail("objeto")
    }
  }
}

/** The value of `var <name> = <literal>` in a page, or null when absent. Throws on a literal it cannot read. */
export function readVar(html: string, name: string): JsValue | null {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*`)
  const m = re.exec(html)
  if (!m) return null
  const r = new Reader(html)
  r.i = m.index + m[0].length
  return r.value()
}

const obj = (v: JsValue | null): { [k: string]: JsValue } => (v && typeof v === "object" && !Array.isArray(v) ? v : {})
const arr = (v: JsValue | undefined): JsValue[] => (Array.isArray(v) ? v : [])
const num = (v: JsValue | undefined, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d)
const str = (v: JsValue | undefined): string | null => {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === "string" ? x : null
}
/** Port bitmask (bit 0 = port 1) → port numbers. */
export function maskToPorts(mask: number, portCount: number): number[] {
  const out: number[] = []
  for (let p = 1; p <= portCount; p++) if ((mask >>> (p - 1)) & 1) out.push(p)
  return out
}
export function portsToMask(ports: readonly number[]): number {
  return ports.reduce((m, p) => (m | (1 << (p - 1))) >>> 0, 0)
}

/** The login page (served with 401 when there is no session): `logonInfo[0]` 0 = ok/none, 1 = wrong credentials… */
export function parseLogon(html: string): { isLoginPage: boolean; code: number | null } {
  const v = readVarSafe(html, "logonInfo")
  if (!Array.isArray(v)) return { isLoginPage: false, code: null }
  return { isLoginPage: /logon\.cgi/.test(html), code: num(v[0], 0) }
}
function readVarSafe(html: string, name: string): JsValue | null {
  try { return readVar(html, name) } catch { return null }
}

/** Why a login failed, from logonInfo[0] (the codes of the login page's own script). */
export const LOGON_ERRORS: Record<number, "bad-credentials" | "not-allowed" | "users-full" | "sessions-full" | "timeout"> = {
  1: "bad-credentials", 2: "not-allowed", 3: "users-full", 4: "sessions-full", 5: "timeout",
}

export interface TplinkSystemInfo { model: string | null; mac: string | null; ip: string | null; firmware: string | null; hardware: string | null }
export function parseSystemInfo(html: string): TplinkSystemInfo | null {
  const v = readVar(html, "info_ds")
  if (!v) return null
  const o = obj(v)
  return { model: str(o.descriStr), mac: str(o.macStr), ip: str(o.ipStr), firmware: str(o.firmwareStr), hardware: str(o.hardwareStr) }
}

/** Link/speed codes of PortSettingRpm (spd_act) and PortStatisticsRpm (link_status). */
const LINK_TEXT = ["", "Auto", "10 Mb/s semidúplex", "10 Mb/s dúplex", "100 Mb/s semidúplex", "100 Mb/s dúplex", "1000 Mb/s dúplex"]
export interface TplinkPortStatus { port: number; enabled: boolean; linkUp: boolean; speed: string | null; lag: number }
export function parsePortSettings(html: string): { portCount: number; ports: TplinkPortStatus[] } | null {
  const info = readVar(html, "all_info")
  if (!info) return null
  const portCount = num(readVar(html, "max_port_num"), 0)
  const o = obj(info)
  const state = arr(o.state)
  const act = arr(o.spd_act)
  const lag = arr(o.trunk_info)
  const ports: TplinkPortStatus[] = []
  for (let i = 0; i < portCount; i++) {
    const code = num(act[i])
    ports.push({ port: i + 1, enabled: num(state[i], 1) === 1, linkUp: code > 0 && code < 7, speed: code > 0 ? LINK_TEXT[code] ?? null : null, lag: num(lag[i]) })
  }
  return { portCount, ports }
}

export interface TplinkPortCounters { port: number; txGood: number; txBad: number; rxGood: number; rxBad: number; linkUp: boolean }
export function parsePortStatistics(html: string): TplinkPortCounters[] | null {
  const info = readVar(html, "all_info")
  if (!info) return null
  const portCount = num(readVar(html, "max_port_num"), 0)
  const o = obj(info)
  const pk = arr(o.pkts)
  const ls = arr(o.link_status)
  return Array.from({ length: portCount }, (_, i) => ({
    port: i + 1, txGood: num(pk[4 * i]), txBad: num(pk[4 * i + 1]), rxGood: num(pk[4 * i + 2]), rxBad: num(pk[4 * i + 3]),
    linkUp: num(ls[i]) > 0,
  }))
}

/** Vlan8021QRpm.htm (qvlan_ds) + Vlan8021QPvidRpm.htm (pvid_ds) → the 802.1Q state. */
export function parseDot1q(vlanHtml: string, pvidHtml: string): Dot1qState | null {
  const q = readVar(vlanHtml, "qvlan_ds")
  const p = readVar(pvidHtml, "pvid_ds")
  if (!q || !p) return null
  const o = obj(q)
  const portCount = num(o.portNum, 0)
  const enabled = num(o.state) === 1
  const vids = arr(o.vids)
  const names = arr(o.names)
  const tag = arr(o.tagMbrs)
  const untag = arr(o.untagMbrs)
  const vlans: Dot1qVlan[] = enabled
    ? vids.map((vid, i) => ({
      vid: num(vid), name: typeof names[i] === "string" ? names[i] : "",
      tagged: maskToPorts(num(tag[i]), portCount), untagged: maskToPorts(num(untag[i]), portCount),
    }))
    : []
  const po = obj(p)
  const pvids = arr(po.pvids).slice(0, portCount).map((x) => num(x, 1))
  while (pvids.length < portCount) pvids.push(1)
  return { enabled, portCount, vlans, pvids }
}

/** LAG ids per port (a port in a LAG cannot be set up alone). */
export function parseLagIds(vlanHtml: string): number[] {
  return arr(obj(readVarSafe(vlanHtml, "qvlan_ds")).lagIds).map((x) => num(x))
}

/** Other VLAN modes (they are switched off when 802.1Q is enabled). */
export function parseModeState(html: string, name: "pvlan_ds" | "mtu_ds"): boolean | null {
  const v = readVarSafe(html, name)
  if (!v) return null
  return num(obj(v).state) === 1
}

/** The `tip` a page shows after an operation ("" when none). */
export function parseTip(html: string): string {
  const v = readVarSafe(html, "tip")
  return typeof v === "string" ? v : ""
}
