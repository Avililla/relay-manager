// «Enviar a equipo» through the files HTTP API, with a real database and a real SSH server (ssh2 Server): the equipment
// list, who may send (reservation / «Siempre» / roles), the remembered login (sealed, never returned), progress to the
// user only, cancel, the per-user limit, losing the reservation, host key changes and the audit (never the password).
import crypto from "node:crypto"
import fs from "node:fs"
import http, { type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SendJobDTO, SendTargetDTO } from "@/lib/contracts/files"
import type { ServerEvent } from "@/lib/contracts/events"
import { createNullLogger } from "@/server/log"
import { createRequestListener } from "@/server/http/listen"
import type { AuthenticatedSession, AuthUser, EquipnetRoute, FilesService, ReservationChange } from "@/server/runtime/types"
import { createFakeSshServer, type FakeSshServer } from "../../../../scripts/sim/fake-ssh-server.mjs"
import { createTestDb, fakeAudit, fakeBus, fakeEquipnet, fakeReservations, makeUser, testConfig, withTempDir, type TestDb } from "../../../../test/helpers"
import { createFilesServices } from ".."

let t: { dir: string; cleanup: () => void }
let db: TestDb
let root: string
let ssh: FakeSshServer
let server: http.Server | null = null
let svc: FilesService
let base: string
let audit: ReturnType<typeof fakeAudit>
let bus: ReturnType<typeof fakeBus>
let res: ReturnType<typeof fakeReservations> & { fire(c: Partial<ReservationChange> & { equipmentId: string }): void }
const users: Record<string, AuthUser> = {}
let eqIp: { id: string }
let eqSwitch: { id: string }
let eqAlways: { id: string }
let eqHidden: { id: string }
let routes: Record<number, EquipnetRoute>

function reservations() {
  const r = fakeReservations()
  const listeners = new Set<(c: ReservationChange) => void>()
  return Object.assign(r, {
    onChange: (l: (c: ReservationChange) => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    fire: (c: Partial<ReservationChange> & { equipmentId: string }) => {
      for (const l of listeners) l({ before: null, after: null, cause: "release", by: { kind: "system", id: null, name: "x" }, ...c } as ReservationChange)
    },
  })
}

async function start(sshOpts: Partial<Parameters<typeof createFakeSshServer>[0]> = {}, limits: { maxActivePerUser?: number } = {}) {
  ssh = await createFakeSshServer({ home: path.join(t.dir, "equipo"), ...sshOpts })
  const role = await db.prisma.role.create({ data: { name: "otros" } })
  const ana = await makeUser(db.prisma, { username: "ana" })
  const bea = await makeUser(db.prisma, { username: "bea" })
  for (const u of [ana, bea]) users[u.username] = { id: u.id, username: u.username, name: u.name, isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
  const mk = async (name: string, access: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
    const e = await db.prisma.equipment.create({ data: { name, ...extra } })
    if (access) {
      await db.prisma.equipmentAccess.create({ data: { equipmentId: e.id, position: 0, key: "ETH", label: "Ethernet", kind: "tcp", port: 3201 + Math.floor(Math.random() * 29), enabled: true, policy: "reserved", ...access } })
    }
    return e
  }
  eqIp = await mk("Equipo A #01", { targetMode: "ip", targetHost: "127.0.0.1", targetPort: ssh.port })
  eqSwitch = await mk("Equipo A #03", { targetMode: "switch", switchPort: 3, targetPort: 22, port: 3231 })
  eqAlways = await mk("Equipo C #01", { targetMode: "ip", targetHost: "127.0.0.1", targetPort: ssh.port, policy: "always", port: 3232 })
  eqHidden = await mk("Oculto", { targetMode: "ip", targetHost: "127.0.0.1", targetPort: ssh.port, port: 3233 }, { roles: { connect: [{ id: role.id }] } })
  await mk("Sin Ethernet", null)
  routes = { 3: { configured: true, vid: 103, localAddress: null, ready: false, link: "down", equipmentIp: "192.168.1.10", problem: "el servidor aún no tiene la VLAN 103." } }
  audit = fakeAudit()
  bus = fakeBus()
  res = reservations()
  const config = testConfig({
    dataDir: path.join(t.dir, "data"), backupDir: path.join(t.dir, "data", "b"), captureDir: path.join(t.dir, "data", "c"),
    files: { enabled: true, dir: root, maxUploadBytes: 1024 ** 3, deleteAdminOnly: false, extraEnabled: false, extraDir: "/nonexistent-extra", extraName: "Compartida", extraHint: "Segunda carpeta compartida" },
  })
  svc = createFilesServices({
    config, log: createNullLogger(), bus, audit, prisma: db.prisma, settings: undefined as never,
    reservations: res, equipnet: fakeEquipnet({ route: (p) => routes[p] ?? fakeEquipnet().route(p) }),
    authenticate: async (req: IncomingMessage): Promise<AuthenticatedSession | null> => {
      const m = /sid=(\w+)/.exec(String(req.headers.cookie ?? ""))
      const user = m ? users[m[1]] : undefined
      return user ? { user, sv: 1, loginAt: Date.now() } : null
    },
  }, { reserveBytes: 0, send: { progressMs: 0, ...limits } })
  await svc.start()
  const srv = http.createServer()
  server = srv
  const cfgRef = { tls: null, port: 0 }
  srv.on("request", createRequestListener(cfgRef, (req, r) => {
    if (!svc.handleRequest(req, r)) { r.writeHead(418); r.end() }
  }))
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  cfgRef.port = (srv.address() as AddressInfo).port
  base = `http://127.0.0.1:${cfgRef.port}`
}

const H = (u = "ana") => ({ cookie: `sid=${u}`, origin: base, "content-type": "application/json" })
const targets = async (u = "ana") => ((await (await fetch(`${base}/api/files/send/targets`, { headers: H(u) })).json()) as { targets: SendTargetDTO[] }).targets
const send = (body: Record<string, unknown>, u = "ana") => fetch(`${base}/api/files/send`, { method: "POST", headers: H(u), body: JSON.stringify({ username: "root", password: "root", destPath: "~", remember: false, paths: ["BOOT.BIN"], ...body }) })
const jobsOf = async (u = "ana") => ((await (await fetch(`${base}/api/files/send`, { headers: H(u) })).json()) as { jobs: SendJobDTO[] }).jobs
async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now()
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`tiempo agotado esperando ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const finished = (j: SendJobDTO) => j.state === "done" || j.state === "error" || j.state === "canceled"

beforeEach(async () => {
  t = withTempDir("rm-send-svc-")
  root = path.join(t.dir, "tftp")
  fs.mkdirSync(path.join(root, "sub"), { recursive: true })
  fs.writeFileSync(path.join(root, "BOOT.BIN"), crypto.randomBytes(200_000))
  db = await createTestDb()
})
afterEach(async () => {
  const s = server
  server = null
  if (s) {
    s.closeAllConnections()
    await new Promise<void>((r) => s.close(() => r()))
  }
  await svc?.stop()
  await ssh?.close()
  await db.cleanup()
  t.cleanup()
})

describe("«Enviar a equipo» por la API de Archivos", () => {
  it("lista los equipos visibles con acceso Ethernet: ruta, reserva y si se puede enviar", async () => {
    await start()
    res.holders.set(eqIp.id, users.ana.id)
    const list = await targets()
    expect(list.map((x) => x.equipmentName)).toEqual(["Equipo A #01", "Equipo A #03", "Equipo C #01"])
    const by = Object.fromEntries(list.map((x) => [x.equipmentName, x]))
    expect(by["Equipo A #01"]).toMatchObject({ allowed: true, blockedReason: null, route: { mode: "ip", host: "127.0.0.1", port: ssh.port }, reservation: { mine: true }, profile: null, hostKey: null })
    expect(by["Equipo C #01"]).toMatchObject({ allowed: true, policy: "always", reservation: null })
    expect(by["Equipo A #03"]).toMatchObject({
      allowed: false, route: { mode: "switch", switchPort: 3, link: "down", ready: false, host: "192.168.1.10", port: 22 }, blockedReason: "Reserva el equipo para enviarle archivos.",
    })
    // Reserved by me but the VLAN is not ready: the network problem.
    res.holders.set(eqSwitch.id, users.ana.id)
    expect((await targets()).find((x) => x.equipmentId === eqSwitch.id)?.blockedReason).toMatch(/^No se puede llegar al equipo: el servidor aún no tiene la VLAN 103/)
    // Bea sees Ana's reservation.
    const bea = Object.fromEntries((await targets("bea")).map((x) => [x.equipmentName, x]))
    expect(bea["Equipo A #01"]).toMatchObject({ allowed: false, reservation: { mine: false }, blockedReason: expect.stringContaining("ahora lo tiene") })
    expect((await fetch(`${base}/api/files/send/targets`)).status).toBe(401)
  })

  it("envía (IP:puerto), progreso solo al usuario, auditado sin contraseña; recordar guarda cifrado y no se devuelve", async () => {
    await start()
    res.holders.set(eqIp.id, users.ana.id)
    const r = await send({ equipmentId: eqIp.id, remember: true, destPath: "~/" })
    expect(r.status).toBe(202)
    const { jobs } = (await r.json()) as { jobs: SendJobDTO[] }
    expect(jobs).toHaveLength(1)
    expect(["queued", "connecting"]).toContain(jobs[0].state)
    expect(jobs[0]).toMatchObject({ name: "BOOT.BIN", size: 200_000, via: `127.0.0.1:${ssh.port}`, dest: "root@~/" })
    await until("el envío", async () => (await jobsOf()).every(finished))
    const [j] = await jobsOf()
    expect(j).toMatchObject({ state: "done", sent: 200_000, protocol: "sftp", verification: "verified", checksum: "sha256", dest: `root@${ssh.home}/BOOT.BIN`, error: null })
    expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(ssh.home, "BOOT.BIN"))).digest("hex"))
      .toBe(crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "BOOT.BIN"))).digest("hex"))
    // Events: only to Ana.
    const evs = bus.events.filter((e) => e.event.type === "files.send")
    expect(evs.length).toBeGreaterThan(2)
    expect(evs.every((e) => e.audience.kind === "user" && e.audience.userId === users.ana.id)).toBe(true)
    expect((evs.at(-1)?.event as Extract<ServerEvent, { type: "files.send" }>).job.state).toBe("done")
    // Remembered: sealed in the database, never in the API.
    const row = await db.prisma.equipmentSshProfile.findUnique({ where: { equipmentId: eqIp.id } })
    expect(row).toMatchObject({ remembered: true, username: "root", destPath: "~/", hostKeyType: "ssh-ed25519" })
    expect(row?.password).toMatch(/^v1:/)
    expect(row?.password).not.toContain("root")
    const tg = (await targets()).find((x) => x.equipmentId === eqIp.id)
    expect(tg?.profile).toEqual({ username: "root", destPath: "~/", passwordSaved: true })
    expect(tg?.hostKey?.fingerprint).toMatch(/^SHA256:/)
    expect(JSON.stringify(await targets())).not.toMatch(/v1:|"password"/)
    // Audit: the send and the remembered login, never the password.
    await until("la auditoría", () => audit.inputs.some((a) => a.action === "files.send"))
    const a = audit.inputs.find((x) => x.action === "files.send")
    expect(a).toMatchObject({ outcome: "ok", equipment: { id: eqIp.id }, detail: { path: "BOOT.BIN", sizeBytes: 200_000, result: "enviado", checksum: "verificado (sha256)", protocol: "sftp" } })
    expect(audit.inputs.some((x) => x.action === "files.send.login" && (x.detail as Record<string, unknown>).credencial === "guardada")).toBe(true)
    expect(JSON.stringify(audit.inputs)).not.toContain("\"root\"}") // no {password:"root"}
    expect(JSON.stringify(audit.inputs)).not.toMatch(/password/i)
  })

  it("contraseña guardada (null): se usa; incorrecta: «Usuario o contraseña incorrectos»; desmarcar recordar la olvida", async () => {
    await start()
    res.holders.set(eqIp.id, users.ana.id)
    // Nothing saved yet: null password is refused.
    const none = await send({ equipmentId: eqIp.id, password: null })
    expect(none.status).toBe(400)
    expect(await none.json()).toMatchObject({ message: expect.stringContaining("No hay contraseña guardada"), field: "password" })
    await send({ equipmentId: eqIp.id, remember: true })
    await until("el primero", async () => (await jobsOf()).every(finished))
    await send({ equipmentId: eqIp.id, password: null, remember: true, paths: ["BOOT.BIN"] })
    await until("con la guardada", async () => (await jobsOf()).every(finished))
    expect((await jobsOf()).map((j) => j.state)).toEqual(["done", "done"])
    const bad = await send({ equipmentId: eqIp.id, password: "mala", remember: false })
    expect(bad.status).toBe(202)
    await until("el de la contraseña mala", async () => (await jobsOf()).every(finished))
    const last = (await jobsOf()).at(-1)
    expect(last).toMatchObject({ state: "error", error: "Usuario o contraseña incorrectos." })
    // remember:false forgot it (and the wrong password was never stored).
    const row = await db.prisma.equipmentSshProfile.findUnique({ where: { equipmentId: eqIp.id } })
    expect(row).toMatchObject({ remembered: false, password: null, username: null })
    expect(row?.hostKeyFingerprint).toMatch(/^SHA256:/) // the host key stays
    // «Olvidar» explicitly.
    await send({ equipmentId: eqIp.id, remember: true })
    await until("otro", async () => (await jobsOf()).every(finished))
    const f = await fetch(`${base}/api/files/send/profile/${eqIp.id}`, { method: "DELETE", headers: H() })
    expect(f.status).toBe(204)
    expect((await targets()).find((x) => x.equipmentId === eqIp.id)?.profile).toBeNull()
  })

  it("permisos: sin reserva, reservado por otro, equipo oculto por roles, sin Ethernet; «Siempre» sí; sin Origin no", async () => {
    await start()
    const r1 = await send({ equipmentId: eqIp.id })
    expect(r1.status).toBe(403)
    expect(await r1.json()).toMatchObject({ error: "FORBIDDEN", message: "Reserva el equipo para enviarle archivos." })
    expect(audit.inputs.some((a) => a.action === "files.send" && a.outcome === "denied")).toBe(true)
    res.holders.set(eqIp.id, users.bea.id)
    expect(await (await send({ equipmentId: eqIp.id })).json()).toMatchObject({ message: expect.stringContaining("ahora lo tiene") })
    expect((await send({ equipmentId: eqHidden.id })).status).toBe(404)
    const noEth = await db.prisma.equipment.findFirst({ where: { name: "Sin Ethernet" } })
    expect(await (await send({ equipmentId: noEth?.id })).json()).toMatchObject({ error: "NOT_FOUND", message: expect.stringContaining("no tiene acceso Ethernet") })
    const ok = await send({ equipmentId: eqAlways.id })
    expect(ok.status).toBe(202)
    await until("el envío «Siempre»", async () => (await jobsOf()).every(finished))
    expect((await jobsOf())[0].state).toBe("done")
    const noOrigin = await fetch(`${base}/api/files/send`, { method: "POST", headers: { cookie: "sid=ana", "content-type": "application/json" }, body: "{}" })
    expect(noOrigin.status).toBe(403)
    // Paths are the folder's: no escaping, no folders.
    res.holders.set(eqIp.id, users.ana.id)
    expect((await send({ equipmentId: eqIp.id, paths: ["../data/x"] })).status).toBe(400)
    expect(await (await send({ equipmentId: eqIp.id, paths: ["sub"] })).json()).toMatchObject({ error: "INVALID", message: "«sub» no es un archivo: solo se pueden enviar archivos." })
    expect(await (await send({ equipmentId: eqIp.id, destPath: "~otro" })).json()).toMatchObject({ error: "INVALID", field: "destPath" })
    expect(await (await send({ equipmentId: eqIp.id, username: "root; rm -rf /" })).json()).toMatchObject({ error: "INVALID", field: "username" })
    // Other users cannot cancel or see Ana's sends.
    expect(await jobsOf("bea")).toEqual([])
  })

  it("3 envíos a la vez por usuario (el resto en cola), cancelar uno en curso y otro en cola; liberar la reserva corta los demás", async () => {
    await start({ writeDelayMs: 15 })
    res.holders.set(eqIp.id, users.ana.id)
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.bin`), crypto.randomBytes(3 * 1024 * 1024))
    const r = await send({ equipmentId: eqIp.id, paths: ["f0.bin", "f1.bin", "f2.bin", "f3.bin", "f4.bin"] })
    expect(r.status).toBe(202)
    await until("3 en curso", async () => (await jobsOf()).filter((j) => j.state === "sending").length === 3)
    const js = await jobsOf()
    expect(js.filter((j) => j.state === "queued")).toHaveLength(2)
    const running = js.find((j) => j.state === "sending")
    const queued = js.find((j) => j.state === "queued")
    expect((await fetch(`${base}/api/files/send/${running?.id}`, { method: "DELETE", headers: H() })).status).toBe(204)
    expect((await fetch(`${base}/api/files/send/${queued?.id}`, { method: "DELETE", headers: H() })).status).toBe(204)
    expect((await fetch(`${base}/api/files/send/${queued?.id}`, { method: "DELETE", headers: H("bea") })).status).toBe(404)
    await until("los cancelados", async () => (await jobsOf()).filter((j) => j.state === "canceled").length === 2)
    // Ana loses the reservation: the rest stop with the reason.
    res.holders.delete(eqIp.id)
    res.fire({ equipmentId: eqIp.id })
    await until("todo terminado", async () => (await jobsOf()).every(finished), 15_000)
    const end = await jobsOf()
    expect(end.filter((j) => j.error === "Se ha liberado la reserva del equipo: envío cancelado.").length).toBeGreaterThanOrEqual(1)
    expect(end.every((j) => j.state === "canceled")).toBe(true)
    await new Promise((r2) => setTimeout(r2, 300))
    expect(fs.readdirSync(ssh.home).filter((n) => n.startsWith(".rm-send-"))).toEqual([])
    // Clear the finished ones.
    expect((await fetch(`${base}/api/files/send`, { method: "DELETE", headers: H() })).status).toBe(204)
    expect(await jobsOf()).toEqual([])
  })

  it("la huella SSH cambia: se avisa en el envío (sin bloquear) y queda en la auditoría", async () => {
    await start()
    res.holders.set(eqIp.id, users.ana.id)
    await send({ equipmentId: eqIp.id })
    await until("el primero", async () => (await jobsOf()).every(finished))
    const first = (await targets()).find((x) => x.equipmentId === eqIp.id)?.hostKey?.fingerprint
    // The equipment is reinstalled: same port, another host key.
    const port = ssh.port
    await ssh.close()
    ssh = await createFakeSshServer({ home: path.join(t.dir, "equipo"), port })
    await send({ equipmentId: eqIp.id })
    await until("el segundo", async () => (await jobsOf()).every(finished))
    const j = (await jobsOf()).at(-1)
    expect(j?.state).toBe("done")
    expect(j?.hostKeyChanged?.previous).toBe(first)
    expect(j?.hostKeyChanged?.current).not.toBe(first)
    await until("la auditoría", () => audit.inputs.filter((a) => a.action === "files.send").length === 2)
    expect(audit.inputs.filter((a) => a.action === "files.send").at(-1)?.detail).toMatchObject({ hostKeyChanged: true, previousHostKey: first })
    expect((await targets()).find((x) => x.equipmentId === eqIp.id)?.hostKey?.fingerprint).toBe(j?.hostKeyChanged?.current)
  })
})
