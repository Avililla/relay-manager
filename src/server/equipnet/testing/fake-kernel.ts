// Test-only model of the kernel's links, addresses, rules and routes: applies the `ip` commands the host planner emits
// (after the same safety validation the real runner does), so service tests run the whole reconcile loop. It also
// answers `ip route get <dst> from <src>` like the kernel (policy rules by preference, longest prefix per table).
import { inSubnet } from "@/lib/equipnet/ipv4"
import { validateIpCommand, type HostState, type IpCommand, type IpGuard } from "../host-plan"

const prefixOf = (dst: string) => (dst === "default" ? 0 : Number(dst.split("/")[1] ?? 32))
const matches = (ip: string, dst: string) => dst === "default" || (dst.includes("/") ? inSubnet(ip, dst) : ip === dst)

export class FakeKernel {
  state: HostState
  readonly ran: string[] = []
  constructor(initial: HostState) {
    this.state = JSON.parse(JSON.stringify(initial)) as HostState
  }
  read = async (): Promise<HostState> => JSON.parse(JSON.stringify(this.state)) as HostState
  run = async (cmds: readonly IpCommand[], guard: IpGuard): Promise<void> => {
    for (const c of cmds) {
      const why = validateIpCommand(c, guard)
      if (why) throw new Error(`rechazada: ${why}`)
    }
    for (const c of cmds) {
      this.ran.push(c.join(" "))
      this.apply(c)
    }
  }
  /** Applies commands without the safety validation (planner tests that only check convergence). */
  force(cmds: readonly IpCommand[]): HostState {
    for (const c of cmds) this.apply(c)
    return this.state
  }
  /** Like `ip route get <dst> from <from>`: null when `from` is not local or the result is not a unicast route. */
  routeGet = async (dst: string, from: string): Promise<{ dev: string | null; table: string | null } | null> => {
    if (!this.state.addrs.some((a) => a.local === from)) return null
    const rules = [...this.state.rules].sort((a, b) => a.priority - b.priority)
    for (const r of rules) {
      if (r.src && r.src !== "all" && r.src !== from) continue
      const table = r.table ?? "main"
      const cands = this.state.routes.filter((x) => x.table === table && matches(dst, x.dst)).sort((a, b) => prefixOf(b.dst) - prefixOf(a.dst))
      const best = cands[0]
      if (!best) continue
      if (best.type && best.type !== "unicast") return null
      return { dev: best.dev, table }
    }
    return null
  }
  private apply(c: IpCommand): void {
    const n = this.state
    const [o, v] = c
    if (o === "link" && v === "add") n.links.push({ ifname: c[5], up: false, kind: "vlan", vlanId: Number(c[9]), parent: c[3], mac: null })
    else if (o === "link" && v === "set") {
      const l = n.links.find((x) => x.ifname === c[3])
      if (l && c[4] === "up") l.up = true
    } else if (o === "link" && v === "del") {
      n.links = n.links.filter((x) => x.ifname !== c[3])
      n.addrs = n.addrs.filter((a) => a.ifname !== c[3])
      n.routes = n.routes.filter((r) => r.dev !== c[3])
    } else if (o === "addr" && v === "add") {
      const [ip, len] = c[2].split("/")
      n.addrs.push({ ifname: c[4], local: ip, prefixlen: Number(len) })
    } else if (o === "addr" && v === "del") {
      const [ip] = c[2].split("/")
      n.addrs = n.addrs.filter((a) => !(a.ifname === c[4] && a.local === ip))
      // Like the kernel: without addresses left, the device's routes go away (in every table).
      if (!n.addrs.some((a) => a.ifname === c[4])) n.routes = n.routes.filter((r) => r.dev !== c[4])
    } else if (o === "route" && v === "replace" && c[2] === "unreachable") {
      n.routes = n.routes.filter((r) => !(r.table === c[5] && r.dst === c[3]))
      n.routes.push({ table: c[5], dst: c[3], dev: null, type: "unreachable" })
    } else if (o === "route" && v === "replace") {
      n.routes = n.routes.filter((r) => !(r.table === c[6] && r.dst === c[2]))
      n.routes.push({ table: c[6], dst: c[2], dev: c[4], type: null })
    } else if (o === "route" && v === "del") {
      const typed = c.length === 6
      const [dst, table] = typed ? [c[3], c[5]] : [c[2], c[4]]
      const hit = (r: HostState["routes"][number]) => r.table === table && r.dst === dst && (typed ? r.type === c[2] : !r.type || r.type === "unicast")
      if (!n.routes.some(hit)) throw new Error("RTNETLINK answers: No such process")
      n.routes = n.routes.filter((r) => !hit(r))
    }
    else if (o === "rule" && v === "add") n.rules.push({ priority: Number(c[7]), src: c[3].split("/")[0], srclen: null, table: c[5] })
    else if (o === "rule" && v === "del") n.rules = n.rules.filter((r) => !(String(r.priority) === c[3] && r.table === c.at(-1)))
  }
  /** The adapter was unplugged: its VLAN links go with it (like the kernel). */
  unplug(ifname: string): void {
    const gone = new Set([ifname, ...this.state.links.filter((l) => l.parent === ifname).map((l) => l.ifname)])
    this.state.links = this.state.links.filter((l) => !gone.has(l.ifname))
    this.state.addrs = this.state.addrs.filter((a) => !gone.has(a.ifname))
    this.state.routes = this.state.routes.filter((r) => !r.dev || !gone.has(r.dev))
  }
}
