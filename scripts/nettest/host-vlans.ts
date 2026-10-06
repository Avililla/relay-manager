// Real-kernel test of "Red de equipos" (run by scripts/nettest/inside.sh in an isolated container, as root):
// the app's own planner and `ip` runner create rmv102/rmv103 on usbeth0 with policy routing, and two TCP forwards
// bound to each VLAN's host address reach two equipment that both have 192.168.1.10, while another NIC of the server
// (othernic) is on 192.168.1.0/24 too with its own 192.168.1.10. Checks that the main table, the default route, the lab
// NIC and the other NIC never change, idempotency, strict rp_filter, removal of a stray rmv999, and a clean teardown.
import { execFileSync } from "node:child_process"
import net from "node:net"
import { DEFAULT_EQUIPNET, planEquipnet } from "@/lib/equipnet/plan"
import { planHost, type HostDesired } from "@/server/equipnet/host-plan"
import { findIpBinary, readHostState, runIpCommands } from "@/server/equipnet/iproute"
import { probeTarget, TcpForward } from "@/server/accesses/tcp-forward"

const results: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? "  [ OK ]" : "  [FALLO]"} ${name}${detail && !ok ? `: ${detail}` : ""}\n`)
}
const ipj = (...args: string[]): unknown => JSON.parse(execFileSync("ip", ["-json", ...args], { encoding: "utf8" }) || "[]")
const snapshot = () => ({
  main: JSON.stringify(ipj("-4", "route", "show", "table", "main")),
  labnic: JSON.stringify(ipj("-4", "addr", "show", "dev", "labnic")),
  othernic: JSON.stringify(ipj("-4", "addr", "show", "dev", "othernic")),
  rules: ipj("-4", "rule", "show") as Array<{ priority: number; table?: string; src?: string }>,
})

function ask(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port })
    let out = ""
    s.setTimeout(4000, () => { s.destroy(); reject(new Error("tiempo agotado")) })
    s.on("data", (d) => { out += d.toString() })
    s.on("end", () => resolve(out.trim()))
    s.on("error", reject)
  })
}

async function main(): Promise<void> {
  const bin = findIpBinary(null)
  if (!bin) throw new Error("no hay ip")
  const before = snapshot()
  const avoid = (await readHostState(bin)).addrs.filter((a) => a.ifname !== "lo").map((a) => a.local)
  const plan = planEquipnet({ ...DEFAULT_EQUIPNET, portCount: 3 }, { avoid })
  check("plan: puertos 2 y 3 → rmv102/rmv103, .202 y .204 (la .203 es de othernic)", JSON.stringify(plan.ports.map((p) => [p.ifname, p.hostAddress])) === JSON.stringify([["rmv102", "192.168.1.202"], ["rmv103", "192.168.1.204"]]), JSON.stringify(plan.ports))
  const desired: HostDesired = { parent: "usbeth0", mgmt: plan.mgmt, vlans: plan.ports, subnet: plan.subnet, prefix: plan.prefix }
  const guard = { parent: "usbeth0", forbidden: ["labnic", "othernic", "usbold"], cleanup: [] }

  // A stray interface with our prefix must go.
  execFileSync(bin, ["link", "add", "link", "usbeth0", "name", "rmv999", "type", "vlan", "id", "999"])

  const p1 = planHost(desired, await readHostState(bin))
  process.stdout.write(`  ${p1.commands.length} órdenes:\n${p1.commands.map((c) => `    ip ${c.join(" ")}`).join("\n")}\n`)
  check("ninguna orden toca labnic, othernic, la tabla main ni una ruta por defecto fuera de las tablas propias",
    !p1.commands.some((c) => c.includes("labnic") || c.includes("othernic") || c.includes("main") || (c.includes("default") && c[2] !== "unreachable")))
  await runIpCommands(bin, p1.commands, guard)
  const after = await readHostState(bin)
  const p2 = planHost(desired, after)
  check("idempotente: la segunda pasada no tiene órdenes", p2.commands.length === 0, p2.commands.map((c) => c.join(" ")).join("; "))
  check("todas las VLAN listas y la gestión lista", Object.values(p2.ready).every(Boolean) && p2.mgmtReady, JSON.stringify(p2.ready))
  check("rmv999 borrada", !after.links.some((l) => l.ifname === "rmv999"))
  const mid = snapshot()
  check("tabla main sin cambios", mid.main === before.main, mid.main)
  check("labnic y othernic sin cambios", mid.labnic === before.labnic && mid.othernic === before.othernic)
  const added = mid.rules.filter((r) => !before.rules.some((b) => b.priority === r.priority && b.table === r.table && b.src === r.src))
  check("solo se añaden 3 reglas, con preferencia 1000..5094 (antes que main, 32766) y tablas 20000..24094",
    added.length === 3 && added.every((r) => r.priority >= 1000 && r.priority <= 5094 && Number(r.table) >= 20000 && Number(r.table) <= 24094), JSON.stringify(added))
  check("rp_filter estricto (1) en all y heredado por rmv102", ["all", "rmv102", "rmv103"].every((n) => execFileSync("sysctl", ["-n", `net.ipv4.conf.${n}.rp_filter`], { encoding: "utf8" }).trim() === "1"))

  // Two forwards, same target IP, different VLAN via the source address.
  const fwds: TcpForward[] = []
  for (const p of plan.ports) {
    const f = new TcpForward({ bind: "127.0.0.1", port: 0, target: { host: "192.168.1.10", port: 22 }, localAddress: p.hostAddress, maxConnections: 4, onEvent: () => {} })
    const port = await f.listen()
    fwds.push(f)
    const reply = await ask(port).catch((e: unknown) => `error: ${String(e)}`)
    check(`reenvío por ${p.ifname} (origen ${p.hostAddress}) llega al equipo del puerto ${p.port}`, reply === `VLAN ${p.vid}`, reply)
    check(`probeTarget por ${p.ifname}`, await probeTarget("192.168.1.10", 22, 2000, p.hostAddress))
  }
  for (const f of fwds) await f.close()
  const plain = await new Promise<string>((resolve) => {
    const c = net.connect({ host: "192.168.1.10", port: 22 })
    let out = ""
    c.setTimeout(3000, () => { c.destroy(); resolve("tiempo agotado") })
    c.on("data", (d) => { out += d.toString() })
    c.on("end", () => resolve(out.trim()))
    c.on("error", (e) => resolve(`error: ${e.message}`))
  })
  check("sin dirección de origen de la aplicación, 192.168.1.10 sigue siendo el de la otra red (tabla main intacta)", plain === "otra-red", plain)
  check("addrgenmode none en las VLAN (sin fe80:: propia)", ["rmv102", "rmv103"].every((n) => execFileSync(bin, ["-d", "link", "show", n], { encoding: "utf8" }).includes("addrgenmode none")))

  // The management address moves (.250 → .251): after ONE reconcile the table 20000 route is still there.
  const moved = planEquipnet({ ...DEFAULT_EQUIPNET, portCount: 3, mgmtAddress: "192.168.0.251/24" })
  const desiredMoved: HostDesired = { ...desired, mgmt: moved.mgmt }
  const pm = planHost(desiredMoved, await readHostState(bin))
  process.stdout.write(`  cambio de gestión, ${pm.commands.length} órdenes:\n${pm.commands.map((c) => `    ip ${c.join(" ")}`).join("\n")}\n`)
  await runIpCommands(bin, pm.commands, { ...guard, cleanup: [] })
  const sm = await readHostState(bin)
  check("cambio de gestión: la ruta de la tabla 20000 sigue tras una pasada", sm.routes.some((r) => r.table === "20000" && r.dst === "192.168.0.0/24" && r.dev === "usbeth0"), JSON.stringify(sm.routes.filter((r) => r.table === "20000")))
  const pm2 = planHost(desiredMoved, sm)
  check("cambio de gestión: .251 en usbeth0, .250 fuera, regla nueva, nada pendiente",
    pm2.commands.length === 0 && pm2.mgmtReady && sm.addrs.some((a) => a.ifname === "usbeth0" && a.local === "192.168.0.251") && !sm.addrs.some((a) => a.local === "192.168.0.250")
      && sm.rules.some((r) => r.priority === 1000 && r.src === "192.168.0.251"), pm2.commands.map((c) => c.join(" ")).join("; "))

  // Teardown.
  const pt = planHost({ ...desiredMoved, parent: null, mgmt: null, vlans: [], cleanup: ["usbeth0"] }, await readHostState(bin))
  await runIpCommands(bin, pt.commands, { parent: null, forbidden: ["labnic", "othernic", "usbold"], cleanup: ["usbeth0"] })
  const end = await readHostState(bin)
  check("desmontaje: sin interfaces rmv*", !end.links.some((l) => /^rmv\d+$/.test(l.ifname)))
  check("desmontaje: sin reglas de la aplicación", !end.rules.some((r) => Number(r.table) >= 20000 && Number(r.table) <= 24094))
  check("desmontaje: sin tablas de la aplicación", !end.routes.some((r) => Number(r.table) >= 20000 && Number(r.table) <= 24094))
  check("desmontaje: sin dirección de gestión en usbeth0", !end.addrs.some((a) => a.ifname === "usbeth0"))
  const fin = snapshot()
  check("desmontaje: tabla main, labnic y othernic sin cambios", fin.main === before.main && fin.labnic === before.labnic && fin.othernic === before.othernic)
  check("desmontaje: reglas como al principio", JSON.stringify(fin.rules) === JSON.stringify(before.rules))
}

main().then(() => {
  const bad = results.filter((r) => !r.ok)
  process.stdout.write(`\n${bad.length ? `FALLO: ${bad.length} de ${results.length} comprobaciones` : `PASA: ${results.length} comprobaciones`}\n`)
  process.exit(bad.length ? 1 : 0)
}, (err: unknown) => {
  process.stdout.write(`FALLO: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
