// «Enviar a equipo» against the real OpenSSH of this machine (sshd run unprivileged on a free port, skipped when it is
// not installed): the real sftp-server (posix-rename@openssh.com, statvfs@openssh.com, realpath) and, without the SFTP
// subsystem, the real `scp -t` sink. Logs in with a key (an unprivileged sshd cannot check passwords).
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { checkRemotePath } from "@/lib/files/remote-path"
import { withTempDir } from "../../../../test/helpers"
import { sendFile, type TransferOptions } from "./transfer"

const SSHD = "/usr/sbin/sshd"
const SFTP_SERVER = ["/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server", "/usr/libexec/sftp-server"].find((p) => fs.existsSync(p))
const available = fs.existsSync(SSHD) && !!SFTP_SERVER && process.getuid?.() !== 0 && (() => {
  try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }) } catch (e) { return (e as { status?: number }).status !== 127 }
  return true
})()

const freePort = () => new Promise<number>((r) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as net.AddressInfo).port
    s.close(() => r(p))
  })
})

describe.skipIf(!available)("OpenSSH real (sshd sin privilegios)", () => {
  let t: { dir: string; cleanup: () => void }
  const daemons: ChildProcess[] = []
  const ports: Record<"sftp" | "scp", number> = { sftp: 0, scp: 0 }
  let key = ""

  async function daemon(withSftp: boolean): Promise<number> {
    const port = await freePort()
    const cfg = path.join(t.dir, `sshd-${port}.conf`)
    fs.writeFileSync(cfg, [
      `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${path.join(t.dir, "hostkey")}`, "PidFile none",
      `AuthorizedKeysFile ${path.join(t.dir, "authorized_keys")}`, "StrictModes no", "UsePAM no", "PasswordAuthentication no",
      "KbdInteractiveAuthentication no", ...(withSftp ? [`Subsystem sftp ${SFTP_SERVER}`] : []), "",
    ].join("\n"))
    const p = spawn(SSHD, ["-D", "-e", "-f", cfg], { stdio: ["ignore", "ignore", "pipe"] })
    daemons.push(p)
    let log = ""
    p.stderr?.on("data", (d: Buffer) => { log += d.toString() })
    for (let i = 0; i < 100 && !/Server listening/.test(log); i++) await new Promise((r) => setTimeout(r, 50))
    if (!/Server listening/.test(log)) throw new Error(`sshd no arranca: ${log}`)
    return port
  }

  beforeAll(async () => {
    t = withTempDir("rm-openssh-")
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(t.dir, "hostkey")])
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(t.dir, "userkey")])
    fs.copyFileSync(path.join(t.dir, "userkey.pub"), path.join(t.dir, "authorized_keys"))
    key = fs.readFileSync(path.join(t.dir, "userkey"), "utf8")
    ports.sftp = await daemon(true)
    ports.scp = await daemon(false)
  })
  afterAll(() => {
    for (const d of daemons) d.kill("SIGTERM")
    t?.cleanup()
  })

  function opts(proto: "sftp" | "scp", data: Buffer, to: string, name = "BOOT.BIN"): TransferOptions {
    const dest = checkRemotePath(to)
    if (!dest.ok) throw new Error(dest.error)
    return {
      route: { host: "127.0.0.1", port: ports[proto], localAddress: null, switchPort: null, link: null, bindError: null },
      username: os.userInfo().username, password: "", privateKey: key, dest, multi: false, signal: new AbortController().signal,
      source: { name, size: data.length, mode: 0o644, async *chunks(n: number) { for (let i = 0; i < data.length; i += n) yield data.subarray(i, i + n) } },
    }
  }

  it.each(["sftp", "scp"] as const)("%s: llega entero, verificado, reemplaza y sin temporales", async (proto) => {
    const dir = path.join(t.dir, `destino-${proto}`)
    fs.mkdirSync(dir)
    const data = crypto.randomBytes(5 * 1024 * 1024 + 11)
    const r = await sendFile(opts(proto, data, `${dir}/`))
    expect(r).toMatchObject({ protocol: proto, finalPath: path.join(dir, "BOOT.BIN"), verification: "verified", checksum: "sha256", replaced: false })
    expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "BOOT.BIN"))).digest("hex")).toBe(crypto.createHash("sha256").update(data).digest("hex"))
    const again = await sendFile(opts(proto, Buffer.from("otra"), path.join(dir, "BOOT.BIN")))
    expect(again.replaced).toBe(true)
    expect(fs.readFileSync(path.join(dir, "BOOT.BIN"), "utf8")).toBe("otra")
    expect(fs.readdirSync(dir)).toEqual(["BOOT.BIN"])
    expect(fs.statSync(path.join(dir, "BOOT.BIN")).mode & 0o777).toBe(0o644)
  })

  it.each(["sftp", "scp"] as const)("%s: ~ es la carpeta personal real y un nombre con comillas y $() llega tal cual", async (proto) => {
    const name = `rm-e2e-${proto}-${process.pid} it's $(x).bin`
    const r = await sendFile(opts(proto, Buffer.from("x"), "~", name))
    try {
      expect(r.finalPath).toBe(path.join(os.homedir(), name))
      expect(fs.readFileSync(r.finalPath, "utf8")).toBe("x")
    } finally {
      fs.rmSync(path.join(os.homedir(), name), { force: true })
    }
  })

  it.each(["sftp", "scp"] as const)("%s: carpeta sin permiso: error de permisos", async (proto) => {
    const ro = path.join(t.dir, `ro-${proto}`)
    fs.mkdirSync(ro, { mode: 0o555 })
    await expect(sendFile(opts(proto, Buffer.from("x"), `${ro}/`))).rejects.toMatchObject({ kind: "permission" })
    fs.chmodSync(ro, 0o755)
  })
})
