// Real-kernel test of the whole "Red de equipos" service on the bench PC of the lab (run by scripts/nettest/inside.sh in
// an isolated container, as root, after host-vlans.ts): the service with its real `ip`, `ip route get`, sysfs (fake
// tree describing the hardware), /proc/net/route, TCP sweep and the fake TL-SG108E web, exactly as in production.
// Topology (inside.sh): labnic (lab, default route), othernic (192.168.1.203/24 with ANOTHER 192.168.1.10 behind it),
// usbeth0 (the new USB adapter to the switch at 192.168.0.99), usbold (another USB adapter with the management address
// an older version left). Proves: nothing is touched before the admin chooses; only the chosen interface changes;
// the leftover is only removed on request; settings save with a warning (not an error) although othernic is on
// 192.168.1.0/24; each access reaches the equipment of its own port with strict rp_filter; 192.168.1.10 from the
// server without the app's source still goes to othernic; reuse of an existing address; an address equal to the
// switch IP is a clear error; «Enviar a equipo» (the send service with this real route, SSH on 2222) puts the file on
// the equipment of the chosen port only (SFTP on eq2, scp on eq3), never on the other one nor on the other network's
// 192.168.1.10; and a clean teardown.
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { createNullLogger } from "@/server/log"
import { createEquipnetServices } from "@/server/equipnet"
import { TcpForward } from "@/server/accesses/tcp-forward"
import { createSendService } from "@/server/files/send/service"
import type { SendJobDTO } from "@/lib/contracts/files"
import { accessDetail } from "@/lib/i18n/accesses"
import type { EquipnetServices } from "@/server/runtime/types"
import { createTestDb, fakeAudit, fakeBus, fakeReservations, fakeSettings, makeUser, testConfig } from "../../test/helpers"

const results: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? "  [ OK ]" : "  [FALLO]"} ${name}${detail && !ok ? `: ${detail}` : ""}\n`)
}
const ADMIN = { kind: "user" as const, id: "u1", name: "admin", ip: "10.0.0.1" }
const ipj = <T = unknown>(...args: string[]): T => JSON.parse(execFileSync("ip", ["-json", ...args], { encoding: "utf8" }) || "[]") as T
const sh = (...args: string[]) => execFileSync(args[0] ?? "true", args.slice(1), { encoding: "utf8" })

interface Addr { ifname: string; addr_info: Array<{ local: string; prefixlen: number; family: string }> }
interface Route { dst: string; dev?: string; table?: string; type?: string; gateway?: string }
interface Rule { priority: number; src?: string; table?: string }
/** Everything about one interface: its link (flags, MTU, MAC), addresses, and routes through it in every table. */
function aboutIf(name: string): string {
  const l = ipj<Array<Record<string, unknown>>>("link", "show", "dev", name)[0] ?? {}
  const a = ipj<Addr[]>("-4", "addr", "show", "dev", name)[0]?.addr_info ?? []
  const r = ipj<Route[]>("-4", "route", "show", "table", "all").filter((x) => x.dev === name && !(Number(x.table) >= 20000 && Number(x.table) <= 24094))
  return JSON.stringify({ flags: l.flags, mtu: l.mtu, mac: l.address, addrs: a.map((x) => `${x.local}/${x.prefixlen}`), routes: r })
}
const snapshot = () => ({
  labnic: aboutIf("labnic"), othernic: aboutIf("othernic"), usbold: aboutIf("usbold"), usbeth0: aboutIf("usbeth0"),
  main: JSON.stringify(ipj<Route[]>("-4", "route", "show", "table", "main")),
  rules: ipj<Rule[]>("-4", "rule", "show"),
  all: JSON.stringify([ipj("-4", "addr", "show"), ipj("-4", "rule", "show"), ipj("-4", "route", "show", "table", "all"), ipj<Array<{ ifname: string }>>("link", "show").map((l) => l.ifname)]),
})
const switchRequests = async (): Promise<number> => {
  // The fake switch's own counter (its test page), from inside its netns: it must stay at 0 until the admin searches.
  const out = sh("ip", "netns", "exec", "switch", "node", "-e", "require('http').get('http://192.168.0.99/__sim/state',(r)=>{let b='';r.on('data',(d)=>b+=d);r.on('end',()=>process.stdout.write(b))})")
  return (JSON.parse(out) as { requests: number }).requests
}
function ask(port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port })
    let out = ""
    s.setTimeout(4000, () => { s.destroy(); resolve("tiempo agotado") })
    s.on("data", (d) => { out += d.toString() })
    s.on("end", () => resolve(out.trim()))
    s.on("error", (e) => resolve(`error: ${e.message}`))
  })
}
function direct(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    let out = ""
    s.setTimeout(4000, () => { s.destroy(); resolve("tiempo agotado") })
    s.on("data", (d) => { out += d.toString() })
    s.on("end", () => resolve(out.trim()))
    s.on("error", (e) => resolve(`error: ${e.message}`))
  })
}
async function expectError(name: string, p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p
    check(name, false, "no ha dado error")
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    check(name, re.test(m), m)
  }
}
const mac = (n: string) => sh("cat", `/sys/class/net/${n}/address`).trim()

async function main(): Promise<void> {
  const sysRoot = process.env.RM_NETTEST_SYS ?? "/tmp/fake-sys"
  const db = await createTestDb()
  const audit = fakeAudit()
  const base = testConfig()
  const svc: EquipnetServices = createEquipnetServices(
    { config: testConfig({ dataDir: db.dir, net: { ...base.net, hostMode: "apply", sysRoot, ipBin: null, switchHttpPort: 80 } }), log: createNullLogger(), prisma: db.prisma, bus: fakeBus(), audit, settings: fakeSettings() },
    { adapterPollMs: 600_000, reconcileMs: 600_000, switchPollMs: 600_000 },
  )
  const before = snapshot()
  try {
    // --- 1. Nothing chosen: the service lists every interface and touches nothing ------------------------------
    await svc.start()
    await svc.reconcileNow(ADMIN)
    await new Promise((r) => setTimeout(r, 1500))
    const s1 = snapshot()
    check("arranque sin interfaz elegida: la red del servidor, idéntica (direcciones, reglas, todas las tablas)", s1.all === before.all)
    check("arranque: ni una petición al switch (no hay búsqueda automática)", (await switchRequests()) === 0)
    const st = svc.status()
    const by = Object.fromEntries(st.adapters.map((a) => [a.ifname, a]))
    check("lista: labnic no se puede elegir (ruta por defecto)", by.labnic?.selectable === "no" && by.labnic.defaultRoute, JSON.stringify(by.labnic))
    check("lista: othernic solo con confirmación (tiene 192.168.1.203/24)", by.othernic?.selectable === "confirm" && /192\.168\.1\.203\/24/.test(by.othernic.warning ?? ""), JSON.stringify(by.othernic))
    check("lista: usbeth0 elegible", by.usbeth0?.selectable === "yes", JSON.stringify(by.usbeth0))
    check("tarjeta pasiva «Hay adaptadores de red sin configurar»", st.offerSetup)
    check("restos de la versión anterior listados (192.168.0.250 en usbold), sin quitarlos", st.leftovers.items.some((x) => /192\.168\.0\.250\/24 en usbold/.test(x)) && s1.usbold === before.usbold, JSON.stringify(st.leftovers))

    // --- 2. The leftover blocks the same management address; «Quitar restos» removes exactly it ----------------
    await expectError("elegir usbeth0 con el resto en usbold: error claro", svc.chooseAdapter({ mac: mac("usbeth0"), confirmed: false }, ADMIN), /192\.168\.0\.250 ya la tiene usbold.*Quitar restos/)
    await expectError("othernic sin confirmación: error de confirmación", svc.chooseAdapter({ mac: mac("othernic"), confirmed: false }, ADMIN), /confirmación/)
    await expectError("labnic (ruta por defecto): nunca", svc.chooseAdapter({ mac: mac("labnic"), confirmed: true }, ADMIN), /ruta por defecto/)
    check("tras los errores, nada ha cambiado", snapshot().all === before.all)
    await svc.cleanupLeftovers(ADMIN)
    const s2 = snapshot()
    check("«Quitar restos»: usbold sin la dirección de gestión, sin su regla ni su tabla", !s2.usbold.includes("192.168.0.250") && !s2.rules.some((r) => r.priority === 20000) && !ipj<Route[]>("-4", "route", "show", "table", "all").some((r) => r.table === "20000"))
    check("«Quitar restos»: labnic, othernic, usbeth0 y la tabla main sin cambios", s2.labnic === before.labnic && s2.othernic === before.othernic && s2.usbeth0 === before.usbeth0 && s2.main === before.main)
    const baseline = snapshot()

    // --- 3. Choose usbeth0: only its management address (own rule, own table) ---------------------------------
    await svc.chooseAdapter({ mac: mac("usbeth0"), confirmed: false }, ADMIN)
    const s3 = snapshot()
    check("elegida usbeth0: 192.168.0.250/24 añadida solo en usbeth0", s3.usbeth0.includes("192.168.0.250/24") && s3.labnic === baseline.labnic && s3.othernic === baseline.othernic && s3.usbold === baseline.usbold && s3.main === baseline.main)
    check("regla de gestión con preferencia 1000 (antes que main)", s3.rules.some((r) => r.priority === 1000 && r.src === "192.168.0.250" && r.table === "20000"), JSON.stringify(s3.rules))

    // --- 4. «Buscar el switch»: a sweep through usbeth0 only ------------------------------------------------------
    const t0 = Date.now()
    const found = await svc.discover(null, ADMIN)
    check(`«Buscar el switch» por usbeth0 lo encuentra en 192.168.0.99 (${Date.now() - t0} ms)`, found?.host === "192.168.0.99" && found.model === "TL-SG108E", JSON.stringify(found))

    // --- 5. «Preparar switch»: saved with a WARNING (othernic is on 192.168.1.0/24), never an error ------------
    const prep = await svc.prepare({ uplinkConfirmed: true }, ADMIN)
    check("preparar: arranca (el switch se configura)", prep.started, JSON.stringify(prep.preview?.blocked))
    check("preparar: se guarda con un aviso sobre othernic, no con un error", prep.warnings.some((w) => /192\.168\.1\.0\/24\) también está en othernic \(192\.168\.1\.203\/24\)/.test(w)), JSON.stringify(prep.warnings))
    for (let i = 0; i < 200 && svc.status().job?.state === "running"; i++) await new Promise((r) => setTimeout(r, 50))
    check("preparar: trabajo del switch terminado", svc.status().job?.state === "done", JSON.stringify(svc.status().job))
    await svc.reconcileNow(ADMIN)
    const h = svc.status().host
    check("servidor: VLAN listas", h.state === "ok", `${h.state}: ${h.detail}`)
    const r2 = svc.route(2)
    const r3 = svc.route(3)
    check("puerto 2 → rmv102 con 192.168.1.202", r2.ready && r2.localAddress === "192.168.1.202", JSON.stringify(r2))
    check("puerto 3 → rmv103 con otra dirección (la .203 es de othernic)", r3.ready && r3.localAddress !== "192.168.1.203" && !!r3.localAddress, JSON.stringify(r3))

    // --- 6. Traffic -----------------------------------------------------------------------------------------------
    for (const [port, r] of [[2, r2], [3, r3]] as const) {
      const f = new TcpForward({
        bind: "127.0.0.1", port: 0, target: { host: r.equipmentIp ?? "", port: 22 }, localAddress: r.localAddress, bindError: accessDetail.vlanGone(port, r.localAddress ?? ""),
        maxConnections: 4, onEvent: () => {},
      })
      const lp = await f.listen()
      const reply = await ask(lp)
      await f.close()
      check(`acceso del puerto ${port} (origen ${r.localAddress}) llega a su equipo, con rp_filter=1`, reply === `VLAN 10${port}`, reply)
    }
    check("192.168.1.10 desde el servidor sin origen de la aplicación sigue siendo el de la otra red", (await direct("192.168.1.10", 22)) === "otra-red")
    const g2 = ipj<Route[]>("route", "get", "192.168.1.10", "from", r2.localAddress ?? "")[0]
    const g0 = ipj<Route[]>("route", "get", "192.168.1.10")[0]
    check("ip route get desde la VLAN: rmv102 (tabla 20102)", g2?.dev === "rmv102" && g2.table === "20102", JSON.stringify(g2))
    check("ip route get sin origen: othernic (tabla main)", g0?.dev === "othernic", JSON.stringify(g0))
    check("rp_filter=1 en all, default y rmv102/rmv103", ["all", "default", "rmv102", "rmv103"].every((n) => sh("sysctl", "-n", `net.ipv4.conf.${n}.rp_filter`).trim() === "1"))
    const s6 = snapshot()
    check("labnic, othernic, usbold y la tabla main idénticos", s6.labnic === baseline.labnic && s6.othernic === baseline.othernic && s6.usbold === baseline.usbold && s6.main === baseline.main)
    const added = s6.rules.filter((r) => !baseline.rules.some((b) => b.priority === r.priority && b.table === r.table && b.src === r.src))
    check("solo reglas nuevas de la aplicación: preferencia 1000..5094, tablas 20000..24094", added.length === 8 && added.every((r) => r.priority >= 1000 && r.priority <= 5094 && Number(r.table) >= 20000), JSON.stringify(added))
    check("la VLAN sin su dirección: el reenvío falla con un error claro, no sale por othernic", await (async () => {
      const events: Array<{ kind: string; error?: string }> = []
      const f = new TcpForward({ bind: "127.0.0.1", port: 0, target: { host: "192.168.1.10", port: 22 }, localAddress: "192.168.1.240", bindError: "La VLAN del puerto 9 no está lista", maxConnections: 1, onEvent: (e) => events.push(e) })
      const lp = await f.listen()
      const reply = await ask(lp)
      await f.close()
      return reply === "" && events.some((e) => e.kind === "target-error" && e.error === "La VLAN del puerto 9 no está lista")
    })())
    // --- 6b. «Enviar a equipo»: the send service, with the service's real routes, over SSH -------------------------
    {
      const user = await makeUser(db.prisma, { username: "ana" })
      const authUser = { id: user.id, username: "ana", name: user.name, isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
      const eqs: Record<number, string> = {}
      for (const port of [2, 3]) {
        const e = await db.prisma.equipment.create({ data: { name: `Equipo A #0${port}` } })
        await db.prisma.equipmentAccess.create({ data: { equipmentId: e.id, position: 0, key: "ETH", label: "Ethernet", kind: "tcp", port: 3200 + port, targetMode: "switch", switchPort: port, targetPort: 2222 } })
        eqs[port] = e.id
      }
      const srcDir = fs.mkdtempSync("/tmp/rm-send-src-")
      const payload = crypto.randomBytes(1024 * 1024 + 7)
      fs.writeFileSync(path.join(srcDir, "BOOT.BIN"), payload)
      const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex")
      const send = createSendService({
        config: { authSecret: "nettest-secret-0123456789" }, log: createNullLogger(), prisma: db.prisma, bus: fakeBus(), audit,
        reservations: fakeReservations({ holders: { [eqs[2]]: user.id, [eqs[3]]: user.id } }), equipnet: svc,
        openSource: async (_root, rel) => {
          const handle = await fs.promises.open(path.join(srcDir, rel), "r")
          const st = await handle.stat()
          return { handle, size: st.size, mtime: st.mtime, name: path.basename(rel), path: rel, mode: st.mode }
        },
      }, { progressMs: 0 })
      send.begin()
      const targets = await send.targets(authUser)
      const t3 = targets.find((x) => x.equipmentId === eqs[3])
      check("Enviar a equipo: el puerto 3 aparece como «Puerto 3 del switch · enlace activo» y se puede enviar", !!t3 && t3.allowed && t3.route.mode === "switch" && t3.route.switchPort === 3 && t3.route.link === "up", JSON.stringify(t3))
      const home = (n: string) => `/tmp/${n}-home`
      const done = async (id: string): Promise<SendJobDTO | undefined> => {
        for (let i = 0; i < 400; i++) {
          const j = send.jobs(user.id).find((x) => x.id === id)
          if (j && ["done", "error", "canceled"].includes(j.state)) return j
          await new Promise((r) => setTimeout(r, 50))
        }
        return send.jobs(user.id).find((x) => x.id === id)
      }
      const shaAt = (n: string) => {
        const f = path.join(home(n), "BOOT.BIN")
        return fs.existsSync(f) ? sha(fs.readFileSync(f)) : null
      }
      for (const [port, name, proto] of [[3, "eq3", "scp"], [2, "eq2", "sftp"]] as const) {
        // A different file each time: where it lands is told by its checksum.
        const data = Buffer.concat([payload, Buffer.from(`puerto ${port}`)])
        fs.writeFileSync(path.join(srcDir, "BOOT.BIN"), data)
        const { jobs } = await send.start(authUser, "10.0.0.1", { root: "tftp", paths: ["BOOT.BIN"], equipmentId: eqs[port], username: "root", password: "root", destPath: "~", remember: false })
        const j = await done(jobs[0].id)
        check(`Enviar a equipo por el puerto ${port} (${proto}): «Enviado», verificado, por ${j?.via}`, j?.state === "done" && j.protocol === proto && j.verification === "verified" && j.via === `Puerto ${port} del switch`, JSON.stringify(j))
        check(`Enviar a equipo por el puerto ${port}: el archivo está en ${name} (${home(name)}) y es idéntico`, shaAt(name) === sha(data))
        const others = ["eq2", "eq3", "otra"].filter((n) => n !== name)
        check(`Enviar a equipo por el puerto ${port}: no ha llegado a ${others.join(" ni a ")}`, others.every((n) => shaAt(n) !== sha(data)), others.map((n) => `${n}=${shaAt(n)}`).join(" "))
      }
      check("Enviar a equipo: la otra red (su propio 192.168.1.10) no ha recibido nada", !fs.existsSync(path.join(home("otra"), "BOOT.BIN")))
      // A wrong password over the VLAN: the Spanish message.
      const bad = await send.start(authUser, "10.0.0.1", { root: "tftp", paths: ["BOOT.BIN"], equipmentId: eqs[2], username: "root", password: "mala", destPath: "~/", remember: false })
      const jb = await done(bad.jobs[0].id)
      check("Enviar a equipo con una contraseña mala: «Usuario o contraseña incorrectos.»", jb?.state === "error" && jb.error === "Usuario o contraseña incorrectos.", JSON.stringify(jb))
      await send.stop()
      fs.rmSync(srcDir, { recursive: true, force: true })
    }

    await svc.reconcileNow(ADMIN)
    check("idempotente: nada pendiente tras otra pasada", svc.status().host.pending.length === 0 && svc.status().host.state === "ok")
    check("avisos visibles en el estado (othernic, ARP)", svc.status().warnings.some((w) => /othernic/.test(w)) && svc.status().warnings.some((w) => /arp_ignore/.test(w)))

    // --- 7. «Dejar de usar»: back to the baseline ---------------------------------------------------------------
    await svc.chooseAdapter({ mac: null, confirmed: false }, ADMIN)
    check("«Dejar de usar»: la red del servidor vuelve a estar como antes de elegir", snapshot().all === baseline.all)

    // --- 8. The adapter already has an address in the switch network: reused, nothing added --------------------
    sh("ip", "addr", "add", "192.168.0.20/24", "dev", "usbeth0")
    const withStatic = snapshot()
    await svc.chooseAdapter({ mac: mac("usbeth0"), confirmed: false }, ADMIN)
    check("dirección propia en la red del switch (192.168.0.20): se reutiliza, no se añade nada", snapshot().all === withStatic.all && svc.status().mgmt.mode === "reuse")
    const again = await svc.discover(null, ADMIN)
    check("«Buscar el switch» desde 192.168.0.20", again?.host === "192.168.0.99", JSON.stringify(again))
    check("reutilizada: sigue sin añadirse nada", snapshot().all === withStatic.all)
    await svc.chooseAdapter({ mac: null, confirmed: false }, ADMIN)
    sh("ip", "addr", "del", "192.168.0.20/24", "dev", "usbeth0")

    // --- 9. The adapter "got" the switch's IP (the report from the bench PC): a clear error ---------------------
    sh("ip", "addr", "add", "192.168.0.99/24", "dev", "usbeth0")
    await expectError("interfaz con la IP del switch: error claro al elegirla", svc.chooseAdapter({ mac: mac("usbeth0"), confirmed: false }, ADMIN),
      /IP del switch \(192\.168\.0\.99\) la tiene este servidor en usbeth0.*sudo ip addr del 192\.168\.0\.99\/24 dev usbeth0/)
    await expectError("probar una IP que tiene el propio servidor: error claro", svc.discover("192.168.1.203", ADMIN), /Elige primero la interfaz|la tiene este servidor/)
    sh("ip", "addr", "del", "192.168.0.99/24", "dev", "usbeth0")
    check("final: la red del servidor como después de quitar los restos", snapshot().all === baseline.all)
  } finally {
    await svc.stop()
    await db.cleanup()
  }
}

main().then(() => {
  const bad = results.filter((r) => !r.ok)
  process.stdout.write(`\n${bad.length ? `FALLO: ${bad.length} de ${results.length} comprobaciones` : `PASA: ${results.length} comprobaciones`}\n`)
  process.exit(bad.length ? 1 : 0)
}, (err: unknown) => {
  process.stdout.write(`FALLO: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
