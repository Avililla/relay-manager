// The only module of the app that changes the server's network: runs iproute2 (`ip`) without a shell (execFile), with
// a short timeout and a minimal environment, only for commands validateIpCommand() accepts, never on the interface of
// the default route. Reading (`ip -json …`) needs no privileges; changing needs CAP_NET_ADMIN (systemd unit:
// AmbientCapabilities=CAP_NET_ADMIN; Docker: cap_add NET_ADMIN + network_mode host).
import { execFile } from "node:child_process"
import fs from "node:fs"
import { z } from "zod"
import type { AddrInfo, HostState, IpCommand, IpGuard, LinkInfo, RouteInfo, RuleInfo } from "./host-plan"
import { validateIpCommand } from "./host-plan"

const CANDIDATES = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"]

/** The iproute2 binary: RM_NET_IP_BIN, else the usual places. null = not installed. */
export function findIpBinary(explicit: string | null): string | null {
  for (const p of explicit ? [explicit] : CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch { /* next */ }
  }
  return null
}

/** Does this process have CAP_NET_ADMIN (effective)? Linux only; false elsewhere. */
export function hasNetAdmin(statusText?: string): boolean {
  let text = statusText
  if (text === undefined) {
    try { text = fs.readFileSync("/proc/self/status", "utf8") } catch { return false }
  }
  const m = /^CapEff:\s*([0-9a-fA-F]+)/m.exec(text)
  if (!m) return false
  return (BigInt(`0x${m[1]}`) & (1n << 12n)) !== 0n
}

/** Interfaces that carry a default route (IPv4 /proc/net/route, IPv6 /proc/net/ipv6_route): never ours to touch. */
export function defaultRouteInterfaces(route4?: string, route6?: string): string[] {
  const out = new Set<string>()
  let r4 = route4
  let r6 = route6
  try { r4 ??= fs.readFileSync("/proc/net/route", "utf8") } catch { r4 = "" }
  try { r6 ??= fs.readFileSync("/proc/net/ipv6_route", "utf8") } catch { r6 = "" }
  for (const line of r4.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length >= 8 && f[1] === "00000000" && f[7] === "00000000") out.add(f[0])
  }
  for (const line of r6.split("\n")) {
    const f = line.trim().split(/\s+/)
    if (f.length >= 10 && /^0{32}$/.test(f[0]) && f[1] === "00" && f[9] !== "lo") out.add(f[9])
  }
  return [...out]
}

const LinkJson = z.looseObject({
  ifname: z.string(),
  flags: z.array(z.string()).default([]),
  address: z.string().optional(),
  link: z.string().optional(),
  linkinfo: z.looseObject({ info_kind: z.string().optional(), info_data: z.looseObject({ id: z.number().optional() }).optional() }).optional(),
})
const AddrJson = z.looseObject({
  ifname: z.string(),
  addr_info: z.array(z.looseObject({ family: z.string(), local: z.string(), prefixlen: z.number() })).default([]),
})
const RuleJson = z.looseObject({ priority: z.number(), src: z.string().optional(), srclen: z.number().optional(), table: z.string().optional() })
const RouteJson = z.looseObject({ dst: z.string(), dev: z.string().optional(), table: z.string().optional(), type: z.string().optional() })

export class IpError extends Error {
  readonly permission: boolean
  readonly stderr: string
  constructor(message: string, stderr: string, permission: boolean) {
    super(message)
    this.name = "IpError"
    this.stderr = stderr
    this.permission = permission
  }
}

/** A "del" of something already gone is done (the kernel may drop routes with the last address of a device). */
const ALREADY_GONE = /No such process|Cannot assign requested address|Cannot find device|No such file or directory|does not exist/i

function run(bin: string, args: readonly string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "production" } }, (err, stdout, stderr) => {
      if (err) {
        const text = String(stderr || err.message).trim()
        if (args[1] === "del" && ALREADY_GONE.test(text)) return resolve("")
        const permission = /Operation not permitted|Permission denied|EPERM/i.test(text)
        reject(new IpError(`ip ${args.join(" ")}: ${text.split("\n")[0] ?? ""}`, text, permission))
      } else resolve(stdout)
    })
  })
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T[] {
  const raw: unknown = text.trim() ? JSON.parse(text) : []
  if (!Array.isArray(raw)) return []
  return raw.flatMap((x) => {
    const r = schema.safeParse(x)
    return r.success ? [r.data] : []
  })
}

/** The current state: links (with VLAN details), IPv4 addresses, rules and every route table. */
export async function readHostState(bin: string): Promise<HostState> {
  const [l, a, r, t] = await Promise.all([
    run(bin, ["-json", "-d", "link", "show"]),
    run(bin, ["-json", "-4", "addr", "show"]),
    run(bin, ["-json", "-4", "rule", "show"]),
    run(bin, ["-json", "-4", "route", "show", "table", "all"]),
  ])
  const links: LinkInfo[] = parseJson(LinkJson, l).map((x) => ({
    ifname: x.ifname, up: x.flags.includes("UP"), kind: x.linkinfo?.info_kind ?? null,
    vlanId: x.linkinfo?.info_kind === "vlan" ? x.linkinfo.info_data?.id ?? null : null,
    parent: x.link ?? null, mac: x.address?.toLowerCase() ?? null,
  }))
  const addrs: AddrInfo[] = parseJson(AddrJson, a).flatMap((x) => x.addr_info.filter((i) => i.family === "inet").map((i) => ({ ifname: x.ifname, local: i.local, prefixlen: i.prefixlen })))
  const rules: RuleInfo[] = parseJson(RuleJson, r).map((x) => ({ priority: x.priority, src: x.src ?? null, srclen: x.srclen ?? null, table: x.table ?? null }))
  const routes: RouteInfo[] = parseJson(RouteJson, t).map((x) => ({ table: x.table ?? "main", dst: x.dst, dev: x.dev ?? null, type: x.type ?? null }))
  return { links, addrs, rules, routes }
}

/** Runs the planned commands one by one after validating each. Stops at the first failure. */
export async function runIpCommands(bin: string, cmds: readonly IpCommand[], guard: IpGuard): Promise<void> {
  for (const c of cmds) {
    const why = validateIpCommand(c, guard)
    if (why) throw new IpError(`Orden rechazada por seguridad: ${why}`, "", false)
  }
  for (const c of cmds) await run(bin, c)
}

const RouteGetJson = z.looseObject({ dev: z.string().optional(), table: z.string().optional(), type: z.string().optional() })

/**
 * Where the kernel would send a packet from `from` to `dst` right now (`ip -json route get <dst> from <from>`): the
 * interface and the table, or null when there is no route (unreachable, or `from` is not an address of the server).
 * Reading only: needs no privileges. This is what the reconcile loop checks for every VLAN, so any rule of the system
 * that sorts before the app's (and would send the traffic elsewhere) is caught.
 */
export async function routeGet(bin: string, dst: string, from: string): Promise<{ dev: string | null; table: string | null } | null> {
  let text: string
  try { text = await run(bin, ["-json", "route", "get", dst, "from", from], 3000) } catch { return null }
  const r = parseJson(RouteGetJson, text)[0]
  if (!r || (r.type && r.type !== "unicast")) return null
  return { dev: r.dev ?? null, table: r.table ?? "main" }
}

/** "sudo ip link add …" lines for the admin to run by hand when the service cannot. */
export const commandText = (c: IpCommand): string => `ip ${c.join(" ")}`
