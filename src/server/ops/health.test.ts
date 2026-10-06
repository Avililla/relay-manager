import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { BackupDTO, HealthCheckDTO } from "@/lib/contracts/system"
import type { Runtime } from "@/server/runtime/types"
import type { AppConfig } from "@/server/config/schema"
import { fakeRuntime, testConfig, withTempDir } from "../../../test/helpers"
import {
  checkArp, checkBackups, checkBrltty, checkClockSanity, checkDevices, checkExtra, checkExports, checkProfile, checkFiles, headUrl, checkFtdiLatency, checkModemManager, checkNtp, checkOwnership,
  checkSystemd, checkTls, createExec, parseSubjectAltName, EXEC_ENV, nodeHealthContext, runHealthChecks, type ExecFn, type ExecResult, type FileStat,
  type HealthCtx, type HealthFs,
} from "./health"

const cleanups: Array<() => void> = []
afterEach(() => { for (const c of cleanups.splice(0)) c() })
function tmp(prefix = "rm-health-") { const t = withTempDir(prefix); cleanups.push(t.cleanup); return t.dir }

const ok = (stdout = ""): ExecResult => ({ ok: true, code: 0, stdout, stderr: "", missing: false, timedOut: false })
const exit = (code: number, stdout = ""): ExecResult => ({ ok: false, code, stdout, stderr: "", missing: false, timedOut: false })
const MISSING: ExecResult = { ok: false, code: null, stdout: "", stderr: "", missing: true, timedOut: false }

/** exec fake: "cmd arg1 arg2" → result; anything unknown is a missing tool. */
function fakeExec(table: Record<string, ExecResult>): ExecFn {
  return async (cmd, args) => table[[cmd, ...args].join(" ")] ?? MISSING
}

function stat(p: Partial<FileStat> = {}): FileStat {
  return { uid: 1000, gid: 1000, mode: 0o640, size: 1, isDirectory: false, isFile: true, mtimeMs: 0, ...p }
}

/** In-memory fs: files map path → content; stats map path → FileStat; denied maps path → errno for access(). */
function fakeFs(o: { files?: Record<string, string>; dirs?: Record<string, string[]>; stats?: Record<string, FileStat>; denied?: Record<string, string> } = {}): HealthFs {
  return {
    stat: (p) => o.stats?.[p] ?? (o.dirs?.[p] ? stat({ isDirectory: true, isFile: false, mode: 0o750 }) : o.files?.[p] !== undefined ? stat() : null),
    readdir: (p) => o.dirs?.[p] ?? null,
    readText: (p) => o.files?.[p] ?? null,
    access: (p) => o.denied?.[p] ?? (o.files?.[p] !== undefined || o.dirs?.[p] !== undefined || o.stats?.[p] ? null : "ENOENT"),
    statfs: () => ({ freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }),
    dirSize: () => 0,
    canWatch: () => true,
  }
}

function ctx(partial: Partial<HealthCtx> = {}): HealthCtx {
  const config = testConfig({ mode: "native", dev: false, dataDir: "/data", backupDir: "/data/backups", captureDir: "/data/consoles", dbFile: "/data/relay-manager.db" })
  return {
    config,
    rt: null,
    doctor: true,
    fs: fakeFs(),
    exec: fakeExec({}),
    now: () => new Date("2026-09-23T10:00:00.000Z"),
    proc: { uid: 1000, gid: 1000, groups: [1000], username: "relay-manager", nodeVersion: "22.23.2", abi: "127", execPath: "/opt/node" },
    net: { interfaces: () => ({}), portInUse: async () => false, healthOk: async () => false },
    native: async () => ({ sqlite: null, serial: null }),
    readDb: () => null,
    migrations: async () => ({ pending: [], unknown: [], error: null, missingDb: true }),
    backups: () => [],
    dailySkip: () => null,
    hwServer: () => ({ path: null, version: null, source: null, problem: "No se encuentra hw_server." }),
    jtagCables: async () => [],
    rootCopy: async () => ({ available: false, user: null, problem: "Solo con la instalación como servicio", hint: null, writePaths: [] }),
    repository: async () => ({ reachable: false, status: null, error: "ECONNREFUSED" }),
    profileTemplates: () => ({ dir: null, found: false, templates: [], errors: [] }),
    ...partial,
  }
}

const byId = (checks: HealthCheckDTO[], id: string) => {
  const c = checks.find((x) => x.id === id)
  if (!c) throw new Error(`missing check ${id}`)
  return c
}

describe("execFile wrapper", () => {
  it("runs without a shell, with a 2 s timeout and the minimal env (no inherited AUTH_SECRET)", async () => {
    process.env.AUTH_SECRET = "no-debe-filtrarse-no-debe-filtrarse"
    const calls: Array<{ file: string; args: readonly string[]; opts: Record<string, unknown> }> = []
    const exec = createExec((file, args, opts, cb) => {
      calls.push({ file, args, opts: opts as unknown as Record<string, unknown> })
      cb(null, "active\n", "")
    })
    const r = await exec("systemctl", ["is-active", "ModemManager"])
    expect(r).toMatchObject({ ok: true, code: 0, stdout: "active\n", missing: false })
    expect(calls[0].file).toBe("systemctl")
    expect(calls[0].opts.env).toEqual(EXEC_ENV)
    expect(EXEC_ENV).toEqual({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" })
    expect(calls[0].opts.timeout).toBe(2000)
    expect(calls[0].opts.shell).toBeFalsy()
    delete process.env.AUTH_SECRET
  })

  it("maps ENOENT to missing, a non-zero exit to its code, and a kill to timedOut", async () => {
    const enoent = createExec((_f, _a, _o, cb) => cb(Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" }), "", ""))
    expect(await enoent("x", [])).toMatchObject({ ok: false, missing: true })
    const nonzero = createExec((_f, _a, _o, cb) => cb(Object.assign(new Error("exit 3"), { code: 3 }), "inactive\n", ""))
    expect(await nonzero("x", [])).toMatchObject({ ok: false, missing: false, code: 3, stdout: "inactive\n" })
    const killed = createExec((_f, _a, _o, cb) => cb(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), "", ""))
    expect(await killed("x", [])).toMatchObject({ ok: false, timedOut: true })
  })
})

describe("data.files (Archivos)", () => {
  const files = (dir: string, mode: "native" | "portable" | "dev" = "native", enabled = true) =>
    testConfig({ mode, dev: mode === "dev", files: { enabled, dir, maxUploadBytes: 1, deleteAdminOnly: false, extraEnabled: false, extraDir: "/nonexistent-extra", extraName: "Compartida", extraHint: "Segunda carpeta compartida" } })

  it("doctor: writable with room → ok with the free space; missing; not writable; disabled", async () => {
    const fsx = (o: Parameters<typeof fakeFs>[0]) => fakeFs(o)
    const okc = await checkFiles(ctx({ config: files("/srv/tftp"), fs: fsx({ dirs: { "/srv/tftp": [] } }) }))
    expect(okc).toMatchObject({ level: "ok", message: "/srv/tftp: 50 GiB libres de 100 GiB" })
    expect((await checkFiles(ctx({ config: files("/srv/tftp") }))).level).toBe("warn")
    expect((await checkFiles(ctx({ config: files("/home/ana/tftp", "portable") }))).level).toBe("info")
    const denied = await checkFiles(ctx({ config: files("/srv/tftp"), fs: fsx({ dirs: { "/srv/tftp": [] }, denied: { "/srv/tftp": "EACCES" } }) }))
    expect(denied).toMatchObject({ level: "fail", message: "No se puede escribir en /srv/tftp (EACCES)" })
    expect(denied.hint).toContain("install.sh --files-dir /srv/tftp")
    expect((await checkFiles(ctx({ config: files("/srv/tftp", "native", false) }))).message).toContain("RM_FILES_ENABLED=0")
  })

  it("doctor in native mode cannot see a home folder (the unit reaches it through BindPaths): info, not a failure", async () => {
    const c = await checkFiles(ctx({ config: files("/home/ana/tftp"), fs: fakeFs({ denied: { "/home/ana/tftp": "EACCES" } }) }))
    expect(c.level).toBe("info")
    expect(c.message).toContain("Sistema › Salud")
  })

  it("low space → warn, almost none → fail; the runtime status wins when the server runs", async () => {
    const lowFs = (free: number): HealthFs => ({ ...fakeFs({ dirs: { "/srv/tftp": [] } }), statfs: () => ({ freeBytes: free, totalBytes: 10 * 1024 ** 3 }) })
    expect((await checkFiles(ctx({ config: files("/srv/tftp"), fs: lowFs(500 * 1024 ** 2) }))).level).toBe("warn")
    expect((await checkFiles(ctx({ config: files("/srv/tftp"), fs: lowFs(100 * 1024 ** 2) }))).level).toBe("fail")
    const rt = fakeRuntime()
    rt.files.status = async () => ({ enabled: true, root: "/srv/tftp", problem: "La carpeta de archivos /srv/tftp no existe. Avisa al administrador.", writable: false, freeBytes: null, totalBytes: null })
    const r = await checkFiles(ctx({ config: files("/srv/tftp"), rt }))
    expect(r).toMatchObject({ level: "fail", message: "La carpeta de archivos /srv/tftp no existe. Avisa al administrador." })
  })
})

describe("host tool checks", () => {
  it("ModemManager: missing tool → info; docker → info; active without our rule → warn; with it → ok", async () => {
    expect((await checkModemManager(ctx())).level).toBe("info")
    const active = fakeExec({ "systemctl is-active ModemManager": ok("active\n") })
    expect((await checkModemManager(ctx({ exec: active }))).level).toBe("warn")
    const withRule = ctx({ exec: active, fs: fakeFs({ files: { "/etc/udev/rules.d/99-relay-manager.rules": "x" } }) })
    expect((await checkModemManager(withRule)).level).toBe("ok")
    const inactive = fakeExec({ "systemctl is-active ModemManager": exit(3, "inactive\n") })
    expect((await checkModemManager(ctx({ exec: inactive }))).level).toBe("ok")
    const docker = await checkModemManager(ctx({ exec: active, config: testConfig({ mode: "docker" }) }))
    expect(docker).toMatchObject({ level: "info", message: "No comprobable desde el contenedor: revísalo en el anfitrión" })
  })

  it("brltty present → warn; docker → info", async () => {
    const f = fakeFs({ files: { "/usr/bin/brltty": "" } })
    expect((await checkBrltty(ctx({ fs: f }))).level).toBe("warn")
    expect((await checkBrltty(ctx())).level).toBe("ok")
    expect((await checkBrltty(ctx({ fs: f, config: testConfig({ mode: "docker" }) }))).level).toBe("info")
  })

  it("clock.ntp warns only when a server is configured and not synchronised", async () => {
    const servers = (synced: string) => fakeExec({
      "timedatectl show-timesync -p SystemNTPServers -p FallbackNTPServers --value": ok("\nntp.ubuntu.com\n"),
      "timedatectl show -p NTPSynchronized --value": ok(`${synced}\n`),
    })
    expect((await checkNtp(ctx({ exec: servers("no") }))).level).toBe("warn")
    expect((await checkNtp(ctx({ exec: servers("yes") }))).level).toBe("ok")
    const none = fakeExec({
      "timedatectl show-timesync -p SystemNTPServers -p FallbackNTPServers --value": ok("\n\n"),
      "timedatectl show -p NTPSynchronized --value": ok("no\n"),
    })
    const r = await checkNtp(ctx({ exec: none }))
    expect(r).toMatchObject({ level: "info", message: "Sin fuente NTP configurada: ver OPERACION.md (chrony)" })
    expect((await checkNtp(ctx())).level).toBe("info") // timedatectl missing
    expect((await checkNtp(ctx({ exec: servers("no"), config: testConfig({ mode: "docker" }) }))).level).toBe("info")
  })

  it("service.systemd: docker → info; native active → ok; native failed → fail", async () => {
    expect((await checkSystemd(ctx({ config: testConfig({ mode: "docker" }) }))).level).toBe("info")
    expect((await checkSystemd(ctx({ exec: fakeExec({ "systemctl is-active relay-manager": ok("active\n") }) }))).level).toBe("ok")
    expect((await checkSystemd(ctx({ exec: fakeExec({ "systemctl is-active relay-manager": exit(3, "failed\n") }) }))).level).toBe("fail")
    expect((await checkSystemd(ctx())).level).toBe("info")
  })
})

describe("clock.sanity", () => {
  it("fails when the system time is earlier than BUILDINFO built=", async () => {
    const built = testConfig({ build: { version: "2.0.0", buildId: "b", rev: "abc", builtAt: "2026-09-24T00:00:00Z" } })
    expect((await checkClockSanity(ctx({ config: built }))).level).toBe("fail")
    expect((await checkClockSanity(ctx({ config: built, now: () => new Date("2026-10-01T00:00:00Z") }))).level).toBe("ok")
    expect((await checkClockSanity(ctx())).level).toBe("info") // no build date (dev)
  })
})

describe("data.ownership", () => {
  const dirs = { "/data": ["relay-manager.db", "backups", "consoles", "auth-secret"], "/data/backups": ["a.db"], "/data/consoles": ["c1"] }

  it("ok when everything under dataDir, backups/ and consoles/ is ours and writable", async () => {
    expect((await checkOwnership(ctx({ fs: fakeFs({ dirs, files: { "/data/relay-manager.db": "", "/data/auth-secret": "", "/data/backups/a.db": "" } }) }))).level).toBe("ok")
  })

  it("fails with the chown hint when an entry belongs to another uid", async () => {
    const f = fakeFs({ dirs, files: { "/data/relay-manager.db": "", "/data/auth-secret": "", "/data/backups/a.db": "" }, stats: { "/data/backups/a.db": stat({ uid: 0 }) } })
    const r = await checkOwnership(ctx({ fs: f }))
    expect(r.level).toBe("fail")
    expect(r.message).toContain("/data/backups/a.db")
    expect(r.hint).toBe("sudo chown -R relay-manager:relay-manager /var/lib/relay-manager")
  })

  it("fails when backupDir is not writable (EROFS outside StateDirectory)", async () => {
    const f = fakeFs({ dirs, files: { "/data/relay-manager.db": "", "/data/auth-secret": "", "/data/backups/a.db": "" }, denied: { "/data/backups": "EROFS" } })
    const r = await checkOwnership(ctx({ fs: f }))
    expect(r.level).toBe("fail")
    expect(r.message).toContain("EROFS")
  })
})

describe("data.backups", () => {
  const daily = (iso: string): BackupDTO => ({ name: "x", label: "daily", createdAt: iso, sizeBytes: 1, appVersion: "2.0.0" })
  const db = (setupCompletedAt: string | null, enabled = true) => () => ({ quickCheck: "ok", users: 1, setupCompletedAt, backupDailyEnabled: enabled })

  it("ok with a daily backup newer than 48 h", async () => {
    expect((await checkBackups(ctx({ readDb: db("2026-09-01T00:00:00Z"), backups: () => [daily("2026-09-22T03:00:00.000Z")] }))).level).toBe("ok")
  })
  it("info during the 48 h grace after setup, and when disabled", async () => {
    expect((await checkBackups(ctx({ readDb: db("2026-09-22T12:00:00Z") }))).level).toBe("info")
    expect((await checkBackups(ctx({ readDb: db(null) }))).level).toBe("info")
    expect((await checkBackups(ctx({ readDb: db("2026-09-01T00:00:00Z", false) }))).level).toBe("info")
  })
  it("warn when older than 48 h after the grace, or when the last daily run was skipped for space", async () => {
    expect((await checkBackups(ctx({ readDb: db("2026-09-01T00:00:00Z"), backups: () => [daily("2026-09-20T03:00:00.000Z")] }))).level).toBe("warn")
    const skipped = await checkBackups(ctx({
      readDb: db("2026-09-01T00:00:00Z"), backups: () => [daily("2026-09-22T03:00:00.000Z")],
      dailySkip: () => ({ at: new Date("2026-09-23T03:00:00Z"), reason: "low-space" }),
    }))
    expect(skipped.level).toBe("warn")
    expect(skipped.message).toContain("Copia diaria omitida: poco espacio libre")
  })
})

describe("serial checks", () => {
  it("serial.devices lists USB-serial ports and maps EACCES to the dialout hint", async () => {
    const f = fakeFs({
      dirs: { "/sys/class/tty": ["ttyS0", "ttyUSB0", "ttyUSB1", "ttyACM0", "console"] },
      files: { "/sys/class/tty/ttyUSB0/dev": "188:0\n", "/sys/class/tty/ttyUSB1/dev": "188:1\n", "/sys/class/tty/ttyACM0/dev": "166:0\n", "/dev/ttyUSB0": "", "/dev/ttyUSB1": "", "/dev/ttyACM0": "" },
      denied: { "/dev/ttyUSB1": "EACCES" },
    })
    const r = await checkDevices(ctx({ fs: f }))
    expect(r.level).toBe("warn")
    expect(r.message).toContain("3 puertos")
    expect(r.message).toContain("ttyUSB1")
    expect(r.hint).toContain("dialout")
    const none = await checkDevices(ctx({ fs: fakeFs({ dirs: { "/sys/class/tty": ["ttyS0"] } }) }))
    expect(none.level).toBe("info")
  })

  it("serial.devices in Docker reads /hostdev and hints the device_cgroup_rules major on EPERM", async () => {
    const f = fakeFs({
      dirs: { "/sys/class/tty": ["ttyUSB0"] },
      files: { "/sys/class/tty/ttyUSB0/dev": "188:0\n", "/hostdev/ttyUSB0": "" },
      denied: { "/hostdev/ttyUSB0": "EPERM" },
    })
    const config = testConfig({ mode: "docker", serial: { ...testConfig().serial, devRoot: "/hostdev" } })
    const r = await checkDevices(ctx({ fs: f, config }))
    expect(r.level).toBe("warn")
    expect(r.hint).toContain("c 188:* rw")
  })

  it("serial.ftdi-latency: 1 → ok, 16 → warn, no FTDI → info", async () => {
    const mk = (v: string) => fakeFs({ dirs: { "/sys/bus/usb-serial/devices": ["ttyUSB0"] }, files: { "/sys/bus/usb-serial/devices/ttyUSB0/latency_timer": v } })
    expect((await checkFtdiLatency(ctx({ fs: mk("1\n") }))).level).toBe("ok")
    expect((await checkFtdiLatency(ctx({ fs: mk("16\n") }))).level).toBe("warn")
    expect((await checkFtdiLatency(ctx())).level).toBe("info")
  })
})

describe("runHealthChecks", () => {
  it("only restricts the run to the given ids", async () => {
    const r = await runHealthChecks(ctx(), { only: ["serial.brltty", "clock.sanity"] })
    expect(r.map((c) => c.id).sort()).toEqual(["clock.sanity", "serial.brltty"])
  })

  it("doctor mode has the doctor-only checks and no runtime checks; runtime mode the reverse", async () => {
    const doctor = (await runHealthChecks(ctx())).map((c) => c.id)
    expect(doctor).toContain("service.systemd")
    expect(doctor).toContain("service.port")
    expect(doctor).not.toContain("runtime.errors")
    expect(doctor).not.toContain("relays.boards")
    const prisma = { relayBoard: { findMany: async () => [] } } as unknown as Runtime["prisma"]
    const rt = fakeRuntime({ prisma })
    rt.state.uncaughtErrors = 2
    const runtime = await runHealthChecks(ctx({ rt, doctor: false }))
    const ids = runtime.map((c) => c.id)
    expect(ids).not.toContain("service.systemd")
    expect(byId(runtime, "runtime.errors").level).toBe("warn")
    expect(byId(runtime, "relays.boards")).toMatchObject({ level: "info", message: "Sin placas de relés" })
    const noRt = (await runHealthChecks(ctx({ rt, doctor: false }), { runtimeChecks: false })).map((c) => c.id)
    expect(noRt).not.toContain("runtime.errors")
  })

  it("every check has a Spanish label and a known group", async () => {
    const r = await runHealthChecks(ctx())
    for (const c of r) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(["runtime", "data", "serial", "relays", "accesses", "network", "clock", "service"]).toContain(c.group)
    }
    expect(new Set(r.map((c) => c.id)).size).toBe(r.length)
  })

  it("a throwing check becomes a fail result instead of breaking the run", async () => {
    const r = await runHealthChecks(ctx({ native: async () => { throw new Error("boom") } }), { only: ["runtime.native"] })
    expect(r[0]).toMatchObject({ id: "runtime.native", level: "fail" })
  })
})

describe("doctor is read-only", () => {
  it("creates nothing on an empty or missing data dir (real fs, fake exec and port probe)", async () => {
    const root = tmp()
    const empty = path.join(root, "vacío")
    fs.mkdirSync(empty)
    for (const dataDir of [empty, path.join(root, "no-existe")]) {
      const config = testConfig({
        mode: "portable", dev: false, dataDir, dbFile: path.join(dataDir, "relay-manager.db"), backupDir: path.join(dataDir, "backups"),
        captureDir: path.join(dataDir, "consoles"), appDir: path.resolve(__dirname, "../../.."), authSecret: null,
      })
      const c = nodeHealthContext({ config, doctor: true, exec: fakeExec({}), portInUse: async () => false })
      const checks = await runHealthChecks(c)
      expect(checks.length).toBeGreaterThan(15)
      expect(byId(checks, "data.db").level).toBe("info")
      expect(byId(checks, "data.secret").level).toBe("info")
    }
    expect(fs.readdirSync(root)).toEqual(["vacío"])
    expect(fs.readdirSync(empty)).toEqual([])
  })
})

describe("net.tls (exact SAN match)", () => {
  // Self-signed P-256, valid until 2126; SAN: DNS:Banco.Lab.Local, IP Address:10.0.0.12, IP Address:192.168.1.5
  const CERT = [
    "-----BEGIN CERTIFICATE-----",
    "MIIBoDCCAUWgAwIBAgIUVYvFupydDDBeUN5QeUILHjeBupgwCgYIKoZIzj0EAwIw",
    "EDEOMAwGA1UEAwwFYmFuY28wIBcNMjYwOTIzMjE1ODUzWhgPMjEyNjA4MzAyMTU4",
    "NTNaMBAxDjAMBgNVBAMMBWJhbmNvMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
    "5CVrvWb4c7gEV3HwFb0QKCGe9f5eQducsM1txvUC0HNwJbyUcYgoGdMhBfyiPm7A",
    "iD7qaVsvJrpIZE9mEvzADqN7MHkwHQYDVR0OBBYEFHtMxynMNJQvLrt5rT5ec05H",
    "OtRQMB8GA1UdIwQYMBaAFHtMxynMNJQvLrt5rT5ec05HOtRQMA8GA1UdEwEB/wQF",
    "MAMBAf8wJgYDVR0RBB8wHYIPQmFuY28uTGFiLkxvY2FshwQKAAAMhwTAqAEFMAoG",
    "CCqGSM49BAMCA0kAMEYCIQDdcOiQ1B4BdYA0V7cU9xAdwQN/g2SirnPYAV3HZE4/",
    "MwIhAPFSiJtPscxp1Uy+EMBfFZFw4pbthOgB4xdhAy0RL8gc",
    "-----END CERTIFICATE-----",
  ].join("\n")
  const iface = (address: string) => ({ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "", internal: false, cidr: `${address}/24` })
  const tlsCtx = (addresses: string[]) => {
    const base = ctx({ fs: fakeFs({ files: { "/etc/rm/cert.pem": CERT, "/etc/rm/key.pem": "clave" } }) })
    return {
      ...base,
      config: { ...base.config, tls: { certFile: "/etc/rm/cert.pem", keyFile: "/etc/rm/key.pem" } },
      net: { ...base.net, interfaces: () => ({ eth0: addresses.map(iface) }) },
    }
  }

  it("parses DNS and IP entries exactly (quoted values included)", () => {
    expect(parseSubjectAltName("DNS:Banco.Lab.Local, IP Address:10.0.0.12, IP Address:192.168.1.5")).toEqual({
      dns: ["banco.lab.local"], ips: ["10.0.0.12", "192.168.1.5"] })
    expect(parseSubjectAltName('DNS:"a,b.lab", IP Address:10.0.0.1, email:x@y')).toEqual({ dns: ["a,b.lab"], ips: ["10.0.0.1"] })
    expect(parseSubjectAltName("")).toEqual({ dns: [], ips: [] })
  })

  it("10.0.0.1 is not covered by a SAN that only has 10.0.0.12 (no substring match)", async () => {
    const r = await checkTls(tlsCtx(["10.0.0.1"]))
    expect(r).toMatchObject({ id: "net.tls", level: "warn" })
    expect(r.message).toContain("10.0.0.1")
    expect(r.message).not.toContain("10.0.0.12")
  })

  it("ok when every LAN address is an exact SAN IP", async () => {
    expect(await checkTls(tlsCtx(["10.0.0.12", "192.168.1.5"]))).toMatchObject({ level: "ok" })
    expect(await checkTls(tlsCtx(["192.168.1.50"]))).toMatchObject({ level: "warn" })
  })
})


describe("accesses.*", () => {
  const hs3 = { serial: "210299ABCDEF", vendorId: "0403", productId: "6014", manufacturer: "Digilent", product: "Digilent USB Device", family: "digilent" as const, busnum: 1, devnum: 5, portPath: "1-2", location: "USB 1-2" }
  it("hw_server: missing is a warning with the reason; found says where and how", async () => {
    let r = await runHealthChecks(ctx(), { only: ["accesses.hw-server"] })
    expect(r[0]).toMatchObject({ level: "warn", message: "No se encuentra hw_server." })
    r = await runHealthChecks(ctx({ hwServer: () => ({ path: "/tools/Xilinx/Vivado/2024.2/bin/hw_server", version: "2024.2", source: "install", problem: null }) }), { only: ["accesses.hw-server"] })
    expect(r[0]).toMatchObject({ level: "ok", message: "/tools/Xilinx/Vivado/2024.2/bin/hw_server (versión 2024.2), por carpeta de instalación; filtro de cable «{serial}»" })
    // How to check the cable filter against a real hw_server, and the alternative format.
    expect(r[0].hint).toMatch(/jtag targets/)
    expect(r[0].hint).toMatch(/RM_HW_SERVER_FILTER_FORMAT=\{vendor\}\/\{serial\}/)
  })
  it("cables: none, listed, and without USB permission", async () => {
    expect((await runHealthChecks(ctx(), { only: ["accesses.cables"] }))[0]).toMatchObject({ level: "info" })
    expect((await runHealthChecks(ctx({ jtagCables: async () => [hs3] }), { only: ["accesses.cables"] }))[0]).toMatchObject({ level: "ok", message: "1 cable JTAG: 210299ABCDEF" })
    const denied = ctx({ jtagCables: async () => [hs3], fs: { ...fakeFs(), access: (p: string) => (p === "/dev/bus/usb/001/005" ? "EACCES" : null) } })
    expect((await runHealthChecks(denied, { only: ["accesses.cables"] }))[0]).toMatchObject({ level: "warn", hint: expect.stringMatching(/udev/) })
  })
  it("ports: free range, or the ports in use by another program", async () => {
    expect((await runHealthChecks(ctx(), { only: ["accesses.ports"] }))[0]).toMatchObject({ level: "ok", message: "Rango 3201-3230 libre en 127.0.0.1" })
    const busy = ctx({ net: { interfaces: () => ({}), portInUse: async (_h: string, p: number) => p === 3205, healthOk: async () => false } })
    expect((await runHealthChecks(busy, { only: ["accesses.ports"] }))[0]).toMatchObject({ level: "warn", message: "1 puerto en uso del rango 3201-3230: 3205" })
  })
})

describe("net.arp (Red de equipos next to another NIC on the same network)", () => {
  const v4 = (address: string, prefix = 24) => ({ address, netmask: prefix === 16 ? "255.255.0.0" : "255.255.255.0", family: "IPv4" as const, mac: "", internal: false, cidr: `${address}/${prefix}` })
  const withIfs = (ifs: Record<string, ReturnType<typeof v4>[]>, files: Record<string, string> = {}) =>
    ctx({ net: { interfaces: () => ifs, portInUse: async () => false, healthOk: async () => false }, fs: fakeFs({ files }) })
  it("nothing to say without rmv* interfaces, or when no other interface shares the equipment network", async () => {
    expect(await checkArp(withIfs({ enp3s0: [v4("172.20.5.50", 16)] }))).toMatchObject({ level: "ok", message: expect.stringMatching(/Sin interfaces/) })
    expect(await checkArp(withIfs({ enp3s0: [v4("172.20.5.50", 16)], rmv102: [v4("192.168.1.202")] }))).toMatchObject({ level: "ok", message: expect.stringMatching(/Ninguna otra/) })
  })
  it("warns with the install flag when another NIC is on 192.168.1.0/24 and arp_ignore is 0", async () => {
    const ifs = { enp3s0: [v4("172.20.5.50", 16)], enp4s0: [v4("192.168.1.50")], rmv102: [v4("192.168.1.202")], docker0: [v4("192.168.1.1")] }
    const c = await checkArp(withIfs(ifs))
    expect(c).toMatchObject({ id: "net.arp", level: "warn" })
    expect(c.message).toMatch(/^enp4s0 también está en la red de los equipos/)
    expect(c.hint).toMatch(/--red-equipos-arp-estricto/)
    const strict = { "/proc/sys/net/ipv4/conf/all/arp_ignore": "1\n", "/proc/sys/net/ipv4/conf/all/arp_announce": "2\n" }
    expect(await checkArp(withIfs(ifs, strict))).toMatchObject({ level: "ok", message: expect.stringMatching(/arp_ignore=1 y arp_announce=2/) })
  })
})

describe("data.copy-root («Copiar como administrador (sudo)»)", () => {
  const ok = { available: true, user: "ingeniero", problem: null, hint: null, writePaths: ["/media", "/run/media", "/mnt"] }
  it("ok with the user and where it writes; a native install without a working helper is a warning", async () => {
    expect((await runHealthChecks(ctx({ rootCopy: async () => ok }), { only: ["data.copy-root"] }))[0]).toMatchObject({
      level: "ok", label: "Copia como administrador (sudo)", message: "Ayudante listo: contraseña de ingeniero (sudo); escribe en /media, /run/media, /mnt",
    })
    const broken = { ...ok, available: false, problem: "El ayudante de copia como administrador no responde (relay-manager-rootcopy.socket).", hint: "sudo systemctl enable --now relay-manager-rootcopy.socket" }
    expect((await runHealthChecks(ctx({ rootCopy: async () => broken }), { only: ["data.copy-root"] }))[0]).toMatchObject({ level: "warn", hint: broken.hint })
  })
  it("portable, development and Docker have no helper by design: information", async () => {
    const c = ctx({ config: testConfig({ mode: "portable", dev: false }) })
    expect((await runHealthChecks(c, { only: ["data.copy-root"] }))[0].level).toBe("info")
    const off = ctx({ config: testConfig({ copy: { enabled: false, roots: ["/"], deny: [], rootPaths: [], sudoUser: null, helperSocket: null, testRemovable: null } }) })
    expect((await runHealthChecks(off, { only: ["data.copy-root"] }))[0]).toMatchObject({ level: "info", message: expect.stringMatching(/RM_COPY_ENABLED=0/) })
  })
})

describe("data.extra, data.exports («Descargas») and config.profile", () => {
  const cfg = (files: Partial<AppConfig["files"]> = {}, exports: Partial<AppConfig["exports"]> = {}) => {
    const base = testConfig({ mode: "native", dev: false })
    return testConfig({
      mode: "native", dev: false,
      files: { ...base.files, extraEnabled: true, extraDir: "/srv/compartida", extraName: "Compartida", ...files },
      exports: { ...base.exports, script: "/etc/relay-manager/perfil/herramientas/descarga.sh", name: "Descargas del proyecto", ...exports },
    })
  }
  it("second folder: writable with room → ok, labelled with its name; off → info; missing in native → warn", async () => {
    const okc = await checkExtra(ctx({ config: cfg(), fs: fakeFs({ dirs: { "/srv/compartida": [] } }) }))
    expect(okc.level).toBe("ok")
    expect(okc.label).toBe("Carpeta Compartida")
    expect((await checkExtra(ctx({ config: cfg({ extraEnabled: false }) })))).toMatchObject({ level: "info", message: expect.stringMatching(/RM_FILES_EXTRA_NAME/) })
    expect((await checkExtra(ctx({ config: cfg(), fs: fakeFs() }))).level).toBe("warn")
  })
  it("downloader: titled with RM_EXPORT_NAME; off → info; no script → warn; unreachable repository → info; reachable → ok", async () => {
    const fsx = fakeFs({ files: { "/etc/relay-manager/perfil/herramientas/descarga.sh": "#!/bin/bash", "/bin/bash": "" } })
    const down = await checkExports(ctx({ config: cfg(), fs: fsx }))
    expect(down).toMatchObject({ level: "info", label: "Descargas del proyecto", message: expect.stringMatching(/no responde: ECONNREFUSED/) })
    const up = await checkExports(ctx({ config: cfg(), fs: fsx, repository: async () => ({ reachable: true, status: 200, error: null }) }))
    expect(up).toMatchObject({ level: "ok", message: expect.stringMatching(/HTTP 200/) })
    expect(await checkExports(ctx({ config: cfg({}, { url: null }), fs: fsx }))).toMatchObject({ level: "ok", message: expect.stringMatching(/^Script listo/) })
    expect((await checkExports(ctx({ config: cfg({}, { enabled: false }) }))).level).toBe("info")
    expect((await checkExports(ctx({ config: cfg(), fs: fakeFs() }))).level).toBe("warn")
    expect((await checkExports(ctx({ config: cfg({}, { script: null }), fs: fsx }))).message).toMatch(/No hay script de descarga/)
    expect((await checkExports(ctx({ config: cfg({ extraEnabled: false }), fs: fsx }))).level).toBe("warn")
  })
  it("profile: none → info; RM_PROFILE_DIR missing → warn; template errors → fail with file and path; ok", async () => {
    const base = testConfig()
    const none = await checkProfile(ctx())
    expect(none).toMatchObject({ level: "info", label: "Perfil" })
    const missing = await checkProfile(ctx({ config: testConfig({ profile: { ...base.profile, path: "/no/existe", explicit: true } }) }))
    expect(missing).toMatchObject({ level: "warn", message: expect.stringMatching(/\/no\/existe/) })
    const withProfile = testConfig({ profile: { dir: "/etc/relay-manager/perfil", path: "/etc/relay-manager/perfil", explicit: false, envFile: "/etc/relay-manager/perfil/perfil.env", warnings: [] } })
    const bad = await checkProfile(ctx({
      config: withProfile,
      profileTemplates: () => ({ dir: "/etc/relay-manager/perfil", found: true, templates: [], errors: [{ file: "plantillas/a.json", key: "equipo-a", messages: ["plantillas/a.json: consoles[0].key: Usa mayúsculas, números y _ (p. ej. UART0)"] }] }),
    }))
    expect(bad).toMatchObject({ level: "fail", message: expect.stringContaining("plantillas/a.json: consoles[0].key") })
    const ok = await checkProfile(ctx({ config: withProfile }))
    expect(ok).toMatchObject({ level: "ok", message: "/etc/relay-manager/perfil: 0 plantillas, perfil.env" })
    const warned = await checkProfile(ctx({ config: testConfig({ profile: { ...withProfile.profile, warnings: ["Variable no permitida en perfil.env: RM_PORT (se ignora; defínela en config.env)"] } }) }))
    expect(warned.level).toBe("warn")
  })
  it("headUrl: a closed port is unreachable with a reason, quickly", async () => {
    const r = await headUrl("http://127.0.0.1:9/repositorio", 3000)
    expect(r.reachable).toBe(false)
    expect(r.error).toBeTruthy()
  })
})
