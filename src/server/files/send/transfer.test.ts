// «Enviar a equipo» against a real SSH server in this process (ssh2 Server: scripts/sim/fake-ssh-server.mjs): with
// SFTP, without SFTP (the scp protocol over `scp -t`), password root/root, bytes and checksum, destination rules,
// cancel in the middle, wrong password, no route, disk full, permissions and the host key.
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkRemotePath } from "@/lib/files/remote-path"
import { createFakeSshServer, generateHostKey, type FakeSshServer } from "../../../../scripts/sim/fake-ssh-server.mjs"
import { withTempDir } from "../../../../test/helpers"
import { hostKeyOf, sendFile, SendError, type TransferOptions, type TransferSource } from "./transfer"

let t: { dir: string; cleanup: () => void }
let srv: FakeSshServer | null = null

beforeEach(() => { t = withTempDir("rm-send-") })
afterEach(async () => {
  await srv?.close()
  srv = null
  t.cleanup()
})

function source(data: Buffer, name = "BOOT.BIN", mode = 0o644): TransferSource {
  return {
    name, size: data.length, mode,
    async *chunks(n: number) {
      for (let i = 0; i < data.length; i += n) yield data.subarray(i, Math.min(i + n, data.length))
    },
  }
}
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex")

async function start(o: Partial<Parameters<typeof createFakeSshServer>[0]> = {}) {
  srv = await createFakeSshServer({ home: path.join(t.dir, "root"), ...o })
  return srv
}

function opts(s: FakeSshServer, p: Partial<Omit<TransferOptions, "dest">> & { data?: Buffer; to?: string } = {}): TransferOptions {
  const dest = checkRemotePath(p.to ?? "~")
  if (!dest.ok) throw new Error(dest.error)
  const { data, to: _to, ...rest } = p
  void _to
  return {
    route: { host: "127.0.0.1", port: s.port, localAddress: null, switchPort: null, link: null, bindError: null },
    username: "root", password: "root", multi: false, source: source(data ?? Buffer.from("hola")), signal: new AbortController().signal,
    ...rest, dest,
  }
}

describe.each([["SFTP", true], ["scp (sin SFTP)", false]] as const)("envío por %s", (_label, sftp) => {
  it("llega entero a la carpeta personal (~), con la suma verificada y 0644; un ejecutable queda 0755", async () => {
    const s = await start({ sftp })
    const data = crypto.randomBytes(3 * 1024 * 1024 + 123)
    const phases: string[] = []
    let last = 0
    const r = await sendFile(opts(s, { data, onPhase: (p) => phases.push(p), onProgress: (n) => { last = n } }))
    const file = path.join(s.home, "BOOT.BIN")
    expect(sha(fs.readFileSync(file))).toBe(sha(data))
    expect(fs.statSync(file).mode & 0o777).toBe(0o644)
    expect(r).toMatchObject({ protocol: sftp ? "sftp" : "scp", finalPath: file, replaced: false, verification: "verified", checksum: "sha256" })
    expect(r.hostKey?.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(phases).toEqual(["connecting", "sending", "verifying"])
    expect(last).toBe(data.length)
    expect(fs.readdirSync(s.home)).toEqual(["BOOT.BIN"]) // no temporary left
    const x = await sendFile(opts(s, { source: { ...source(Buffer.from("#!/bin/sh\necho hi\n"), "run.sh", 0o755) } }))
    expect(fs.statSync(x.finalPath).mode & 0o777).toBe(0o755)
  })

  it("rutas: carpeta → conserva el nombre; ruta nueva → ese nombre; existente → se reemplaza; ~/sub y absolutas", async () => {
    const s = await start({ sftp })
    fs.mkdirSync(path.join(s.home, "imgs"))
    const abs = path.join(t.dir, "abs")
    fs.mkdirSync(abs)
    expect((await sendFile(opts(s, { to: "~/imgs" }))).finalPath).toBe(path.join(s.home, "imgs", "BOOT.BIN"))
    expect((await sendFile(opts(s, { to: "imgs/otro.bin" }))).finalPath).toBe(path.join(s.home, "imgs", "otro.bin"))
    const again = await sendFile(opts(s, { to: "~/imgs/otro.bin", data: Buffer.from("segunda") }))
    expect(again.replaced).toBe(true)
    expect(fs.readFileSync(path.join(s.home, "imgs", "otro.bin"), "utf8")).toBe("segunda")
    expect((await sendFile(opts(s, { to: `${abs}/` }))).finalPath).toBe(path.join(abs, "BOOT.BIN"))
    expect((await sendFile(opts(s, { to: `${abs}/nombre con 'comillas' y $(espacios).bin` }))).finalPath).toBe(path.join(abs, "nombre con 'comillas' y $(espacios).bin"))
    expect(fs.existsSync(path.join(abs, "nombre con 'comillas' y $(espacios).bin"))).toBe(true)
    await expect(sendFile(opts(s, { to: "~/no/existe.bin" }))).rejects.toMatchObject({ kind: "path", message: expect.stringContaining("no existe en el equipo") })
    await expect(sendFile(opts(s, { to: "~/nueva/" }))).rejects.toMatchObject({ kind: "path" })
    await expect(sendFile(opts(s, { to: "~/imgs/otro.bin/" }))).rejects.toMatchObject({ kind: "path", message: expect.stringContaining("no es una carpeta") })
    await expect(sendFile(opts(s, { to: "~/imgs/nuevo.bin", multi: true }))).rejects.toMatchObject({ kind: "path", message: expect.stringContaining("varios archivos") })
    fs.rmSync(path.join(s.home, "imgs", "BOOT.BIN"))
    fs.mkdirSync(path.join(s.home, "imgs", "BOOT.BIN"))
    await expect(sendFile(opts(s, { to: "~/imgs" }))).rejects.toMatchObject({ kind: "path", message: expect.stringContaining("ya hay una carpeta") })
  })

  it("cancelar a mitad: se para, no queda el temporal y el error es «cancelado»", async () => {
    const s = await start({ sftp, writeDelayMs: 20 })
    const data = crypto.randomBytes(4 * 1024 * 1024)
    const ac = new AbortController()
    let sent = 0
    const p = sendFile(opts(s, { data, signal: ac.signal, onProgress: (n) => {
      sent = n
      if (n > 256 * 1024) ac.abort()
    } }))
    await expect(p).rejects.toMatchObject({ kind: "canceled", message: "Envío cancelado." })
    expect(sent).toBeLessThan(data.length)
    await new Promise((r) => setTimeout(r, 300))
    expect(fs.readdirSync(s.home).filter((n) => n.startsWith(".rm-send-"))).toEqual([])
    expect(fs.existsSync(path.join(s.home, "BOOT.BIN"))).toBe(false)
  })

  it("disco lleno: antes de empezar (no cabe) y a mitad del envío: error claro y nada a medias", async () => {
    const s = await start({ sftp, diskFullAfter: 100_000 })
    await expect(sendFile(opts(s, { data: crypto.randomBytes(500_000) }))).rejects.toMatchObject({
      kind: "no-space", message: expect.stringMatching(/^No queda espacio en el equipo \(quedan 97 KiB y el archivo ocupa 488,3 KiB\)\.$/),
    })
    expect(s.written()).toBe(0)
    // The disk fills up while sending (df said there was room at first).
    s.set({ diskFullAfter: 300_000, reportFree: 10 * 1024 ** 3 })
    await expect(sendFile(opts(s, { data: crypto.randomBytes(1_000_000), onProgress: (n) => { if (n > 100_000) s.set({ reportFree: null }) } }))).rejects.toMatchObject({
      kind: "no-space", message: expect.stringContaining("No queda espacio en el equipo"),
    })
    expect(fs.readdirSync(s.home)).toEqual([])
  })
})

describe("errores y casos especiales", () => {
  it("contraseña incorrecta: «Usuario o contraseña incorrectos»", async () => {
    const s = await start()
    await expect(sendFile(opts(s, { password: "mala" }))).rejects.toMatchObject({ kind: "auth", message: "Usuario o contraseña incorrectos." })
    expect(s.logins.some((l) => !l.ok)).toBe(true)
  })

  it("nadie escucha: «no acepta SSH»; nadie contesta: «no responde por su Ethernet» con el puerto del switch", async () => {
    const free = await new Promise<number>((r) => {
      const x = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (x.address() as net.AddressInfo).port
        x.close(() => r(p))
      })
    })
    const base = { username: "root", password: "root", multi: false, source: source(Buffer.from("x")), signal: new AbortController().signal, dest: { ok: true as const, base: "home" as const, rest: "", trailingSlash: false } }
    await expect(sendFile({ ...base, route: { host: "127.0.0.1", port: free, localAddress: null, switchPort: null, link: null, bindError: null } }))
      .rejects.toMatchObject({ kind: "refused", message: expect.stringContaining(`no acepta SSH en el puerto ${free}`) })
    // 192.0.2.1 (TEST-NET-1) never answers: a timeout, reported as the switch port without link.
    await expect(sendFile({ ...base, route: { host: "192.0.2.1", port: 22, localAddress: null, switchPort: 3, link: "down", bindError: null }, timeouts: { connectMs: 300 } }))
      .rejects.toMatchObject({ kind: "unreachable", message: "El equipo no responde por su Ethernet (puerto 3 del switch sin enlace): comprueba que está encendido y con el cable conectado." })
    // A source address the server does not have (the VLAN is gone): the access's own message, never another route.
    await expect(sendFile({ ...base, route: { host: "127.0.0.1", port: free, localAddress: "192.0.2.77", switchPort: 4, link: "up", bindError: "La VLAN del puerto 4 no está lista" } }))
      .rejects.toMatchObject({ kind: "network", message: "La VLAN del puerto 4 no está lista" })
  })

  it("sin sha256sum ni md5sum: «no verificable» (el tamaño sí se comprueba)", async () => {
    const s = await start({ checksum: false })
    const r = await sendFile(opts(s, { data: Buffer.from("abc") }))
    expect(r).toMatchObject({ verification: "unverifiable", checksum: null })
    const r2 = await sendFile(opts(s, { data: Buffer.from("abc"), forceScp: true }))
    expect(r2).toMatchObject({ protocol: "scp", verification: "unverifiable" })
  })

  it("cuenta solo SFTP (sin exec): se envía por SFTP y queda «no verificable»", async () => {
    const s = await start({ noExec: true })
    const r = await sendFile(opts(s, { data: Buffer.from("solo sftp") }))
    expect(r).toMatchObject({ protocol: "sftp", verification: "unverifiable" })
    expect(fs.readFileSync(path.join(s.home, "BOOT.BIN"), "utf8")).toBe("solo sftp")
  })

  it("sin SFTP ni scp: error claro", async () => {
    const s = await start({ sftp: false, scp: false })
    await expect(sendFile(opts(s))).rejects.toMatchObject({ kind: "no-transfer", message: expect.stringContaining("no tiene SFTP ni scp") })
  })

  it("sin permiso en la carpeta: error de permisos con el usuario", async () => {
    if (process.getuid?.() === 0) return // root writes anywhere
    const s = await start()
    const ro = path.join(t.dir, "ro")
    fs.mkdirSync(ro, { mode: 0o555 })
    await expect(sendFile(opts(s, { to: ro }))).rejects.toMatchObject({ kind: "permission", message: `Sin permiso para escribir en «${ro}» en el equipo (usuario root).` })
    const s2 = await createFakeSshServer({ home: path.join(t.dir, "h2"), sftp: false })
    try {
      await expect(sendFile(opts(s2, { to: ro }))).rejects.toMatchObject({ kind: "permission" })
    } finally {
      await s2.close()
    }
    fs.chmodSync(ro, 0o755)
  })

  it("huella de la clave: la misma clave da la misma huella; otra clave, otra (se informa, no se bloquea)", async () => {
    const key = generateHostKey()
    const s = await start({ hostKey: key })
    const seen: string[] = []
    const a = await sendFile(opts(s, { onHostKey: (k) => seen.push(k.fingerprint) }))
    await s.close()
    srv = await createFakeSshServer({ home: path.join(t.dir, "root"), hostKey: key })
    const b = await sendFile(opts(srv))
    await srv.close()
    srv = await createFakeSshServer({ home: path.join(t.dir, "root") })
    const c = await sendFile(opts(srv))
    expect(a.hostKey?.fingerprint).toBe(seen[0])
    expect(b.hostKey?.fingerprint).toBe(a.hostKey?.fingerprint)
    expect(c.hostKey?.fingerprint).not.toBe(a.hostKey?.fingerprint)
    expect(a.hostKey?.type).toBe("ssh-ed25519")
  })

  it("hostKeyOf: tipo y huella al estilo de OpenSSH", () => {
    const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)])
    const k = hostKeyOf(blob)
    expect(k.type).toBe("ssh-ed25519")
    expect(k.fingerprint).toBe(`SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`)
  })

  it("SendError es un Error con su tipo", () => {
    const e = new SendError("auth", "x")
    expect(e).toBeInstanceOf(Error)
    expect(e.kind).toBe("auth")
  })
})
