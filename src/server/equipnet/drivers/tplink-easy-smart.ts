// TP-Link Easy Smart web management (TL-SG105E/108E/116E, TL-SG1016DE/1024DE; hardware v2-v5). Endpoints read from
// the pages of a real TL-SG108E v3 (firmware 1.0.0 Build 20160722 Rel.50167):
//   login   POST /logon.cgi  username, password, logon=Login  → the login page with logonInfo[0] (0 ok, 1 bad credentials)
//           The session is tied to the client IP (no cookie); /Logout.htm ends it.
//   read    GET /SystemInfoRpm.htm (info_ds) · /PortSettingRpm.htm (all_info.spd_act) · /PortStatisticsRpm.htm (pkts)
//           /Vlan8021QRpm.htm (qvlan_ds) · /Vlan8021QPvidRpm.htm (pvid_ds) · /VlanPortBasicRpm.htm · /VlanMtuRpm.htm
//   802.1Q  GET /qvlanSet.cgi?qvlan_en=1|0&qvlan_mode=Apply   (enabling turns port-based and MTU VLAN off)
//           GET /qvlanSet.cgi?vid=N&vname=NAME&selType_1..n=0 untagged|1 tagged|2 not member&qvlan_add=Add%2FModify
//           GET /qvlanSet.cgi?selVlans=N[&selVlans=M]&qvlan_del=Delete
//           GET /vlanPvidSet.cgi?pbm=<port bitmask>&pvid=N
//   save    POST /savingconfig.cgi  action_op=save       backup  GET /config_back.cgi?btnBackup=Backup+Config
// The write endpoints come from the forms and scripts of those pages (they were never sent to the real switch while
// developing); every write is verified by reading the pages again (runner), so a firmware that differs is detected.
import type { Dot1qState, Dot1qVlan } from "@/lib/equipnet/switch-layout"
import { httpRequest, HttpError, type HttpFn, type HttpResponse } from "../http-client"
import {
  LOGON_ERRORS, parseDot1q, parseLogon, parseModeState, parsePortSettings, parsePortStatistics, parseSystemInfo, portsToMask,
} from "./tplink-parse"
import { SwitchError, type SwitchDriver, type SwitchInfo, type SwitchPortLink, type SwitchSession, type SwitchTarget } from "./types"

const VNAME = /^[A-Za-z0-9_-]{0,10}$/

class TplinkSession implements SwitchSession {
  private queue: Promise<unknown> = Promise.resolve()
  private portCount = 0
  constructor(private readonly t: SwitchTarget, private readonly http: HttpFn) {}

  /** One request at a time: the switch's web server is small and single-threaded. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async raw(method: "GET" | "POST", path: string, body?: string): Promise<HttpResponse> {
    try {
      return await this.http({ host: this.t.host, port: this.t.httpPort, method, path, body, localAddress: this.t.localAddress, timeoutMs: 8000 })
    } catch (err) {
      const code = err instanceof HttpError ? err.code : ""
      throw new SwitchError("unreachable", `No se puede conectar con el switch en ${this.t.host} (${code || (err instanceof Error ? err.message : String(err))})`)
    }
  }

  async login(): Promise<void> {
    const body = new URLSearchParams({ username: this.t.username, password: this.t.password, logon: "Login" }).toString()
    const res = await this.raw("POST", "/logon.cgi", body)
    const logon = parseLogon(res.body.toString("latin1"))
    const why = logon.code ? LOGON_ERRORS[logon.code] : undefined
    if (why === "bad-credentials" || why === "not-allowed") throw new SwitchError("auth-failed", "El switch no acepta el usuario o la contraseña")
    if (why === "users-full" || why === "sessions-full") throw new SwitchError("sessions-full", "El switch tiene demasiadas sesiones abiertas: espera unos minutos o reinícialo")
    // Success answers with the login page and logonInfo[0] = 0; confirm by reading a page.
    const check = await this.raw("GET", "/SystemInfoRpm.htm")
    if (check.status !== 200 || parseLogon(check.body.toString("latin1")).isLoginPage) {
      throw new SwitchError("auth-failed", "El switch no ha abierto la sesión: comprueba el usuario y la contraseña")
    }
  }

  /** GET a page; if the session expired (the login page comes back), log in again once. */
  private get(path: string): Promise<string> {
    return this.serial(async () => {
      for (let attempt = 0; ; attempt++) {
        const res = await this.raw("GET", path)
        const html = res.body.toString("latin1")
        if (parseLogon(html).isLoginPage || res.status === 401) {
          if (attempt > 0) throw new SwitchError("auth-failed", "El switch ha cerrado la sesión")
          await this.login()
          continue
        }
        if (res.status !== 200) throw new SwitchError("protocol", `El switch responde ${res.status} a ${path.split("?")[0]}`)
        return html
      }
    })
  }

  async info(): Promise<SwitchInfo> {
    const sys = parseSystemInfo(await this.get("/SystemInfoRpm.htm"))
    const ports = parsePortSettings(await this.get("/PortSettingRpm.htm"))
    if (!sys || !ports) throw new SwitchError("protocol", "No se reconocen las páginas del switch (¿otro modelo o firmware?)")
    this.portCount = ports.portCount
    return { model: sys.model, hardware: sys.hardware, firmware: sys.firmware, mac: sys.mac?.toLowerCase() ?? null, portCount: ports.portCount }
  }

  async links(): Promise<SwitchPortLink[]> {
    const p = parsePortSettings(await this.get("/PortSettingRpm.htm"))
    if (!p) throw new SwitchError("protocol", "No se reconoce la página de puertos del switch")
    this.portCount = p.portCount
    return p.ports
  }

  async rxCounters(): Promise<number[]> {
    const c = parsePortStatistics(await this.get("/PortStatisticsRpm.htm"))
    if (!c) throw new SwitchError("protocol", "No se reconoce la página de estadísticas del switch")
    return c.map((x) => x.rxGood)
  }

  async dot1q(): Promise<Dot1qState> {
    const s = parseDot1q(await this.get("/Vlan8021QRpm.htm"), await this.get("/Vlan8021QPvidRpm.htm"))
    if (!s) throw new SwitchError("protocol", "No se reconoce la página de VLAN 802.1Q del switch")
    this.portCount = s.portCount
    return s
  }

  async otherModes(): Promise<{ portBased: boolean | null; mtu: boolean | null }> {
    return {
      portBased: parseModeState(await this.get("/VlanPortBasicRpm.htm"), "pvlan_ds"),
      mtu: parseModeState(await this.get("/VlanMtuRpm.htm"), "mtu_ds"),
    }
  }

  private async ports(): Promise<number> {
    if (!this.portCount) await this.info()
    return this.portCount
  }

  async enableDot1q(on: boolean): Promise<void> {
    await this.get(`/qvlanSet.cgi?qvlan_en=${on ? 1 : 0}&qvlan_mode=Apply`)
  }

  async setVlan(v: Dot1qVlan): Promise<void> {
    if (v.vid < 1 || v.vid > 4094 || !Number.isInteger(v.vid)) throw new SwitchError("rejected", `VLAN ${v.vid} no válida`)
    const name = VNAME.test(v.name) ? v.name : ""
    const n = await this.ports()
    const q = new URLSearchParams()
    q.append("vid", String(v.vid))
    q.append("vname", name)
    for (let p = 1; p <= n; p++) q.append(`selType_${p}`, v.untagged.includes(p) ? "0" : v.tagged.includes(p) ? "1" : "2")
    q.append("qvlan_add", "Add/Modify")
    await this.get(`/qvlanSet.cgi?${q.toString()}`)
  }

  async deleteVlans(vids: number[]): Promise<void> {
    const q = new URLSearchParams()
    for (const v of vids) {
      if (v <= 1 || v > 4094 || !Number.isInteger(v)) throw new SwitchError("rejected", `VLAN ${v} no se puede borrar`)
      q.append("selVlans", String(v))
    }
    q.append("qvlan_del", "Delete")
    await this.get(`/qvlanSet.cgi?${q.toString()}`)
  }

  async setPvid(ports: number[], pvid: number): Promise<void> {
    if (!ports.length) return
    if (pvid < 1 || pvid > 4094 || !Number.isInteger(pvid)) throw new SwitchError("rejected", `PVID ${pvid} no válido`)
    await this.get(`/vlanPvidSet.cgi?pbm=${portsToMask(ports)}&pvid=${pvid}`)
  }

  async save(): Promise<void> {
    await this.serial(async () => {
      const res = await this.raw("POST", "/savingconfig.cgi", "action_op=save")
      if (parseLogon(res.body.toString("latin1")).isLoginPage) throw new SwitchError("auth-failed", "El switch ha cerrado la sesión al guardar")
    })
  }

  async backup(): Promise<Buffer | null> {
    return this.serial(async () => {
      const res = await this.raw("GET", "/config_back.cgi?btnBackup=Backup+Config")
      const type = String(res.headers["content-type"] ?? "")
      if (res.status !== 200 || !type.includes("octet-stream") || res.body.length < 16) return null
      return res.body
    })
  }

  async close(): Promise<void> {
    await this.serial(async () => {
      try { await this.raw("GET", "/Logout.htm") } catch { /* best effort */ }
    })
  }
}

export function tplinkEasySmart(http: HttpFn = httpRequest): SwitchDriver {
  return {
    id: "tplink-easy-smart",
    automatic: true,
    async open(target) {
      const s = new TplinkSession(target, http)
      await s.login()
      return s
    },
    async fingerprint(host, httpPort, localAddress) {
      try {
        const res = await http({ host, port: httpPort, method: "GET", path: "/", localAddress, timeoutMs: 2500 })
        const html = res.body.toString("latin1")
        return /logonInfo/.test(html) && /logon\.cgi/.test(html) && /TP-LINK|tp-link/i.test(html)
      } catch {
        return false
      }
    },
  }
}
