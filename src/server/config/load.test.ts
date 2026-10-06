import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { applyConfigEnv, ConfigError, nodeConfigFs, resolveConfig, type ConfigContext, type ConfigFs } from "./load"
import { withTempDir } from "../../../test/helpers"

/** In-memory fs: files by absolute path; realpaths map symlinked dirs. */
function memFs(files: Record<string, string> = {}, realpaths: Record<string, string> = {}): ConfigFs & { writes: string[] } {
  const data = new Map(Object.entries(files))
  const writes: string[] = []
  return {
    writes,
    readText: (p) => data.get(p) ?? null,
    exists: (p) => data.has(p) || [...data.keys()].some((k) => k.startsWith(p.endsWith("/") ? p : p + "/")),
    realpath: (p) => {
      for (const [from, to] of Object.entries(realpaths)) if (p === from || p.startsWith(from + "/")) return to + p.slice(from.length)
      return p
    },
    canRead: (p) => data.has(p),
    mkdirp: (p) => { writes.push(`mkdir ${p}`) },
    writeFileExclusive: (p, content) => { writes.push(`write ${p}`); data.set(p, content) },
    fileMode: (p) => (data.has(p) ? 0o600 : null),
    chmod: (p) => { writes.push(`chmod ${p}`) },
    isOwnedByProcess: () => true,
  }
}
const log = () => ({ info: vi.fn(), warn: vi.fn() })
function ctx(env: Record<string, string>, over: Partial<ConfigContext> = {}): ConfigContext {
  return { env, argv1: "/opt/x/app/server.js", cwd: "/repo", fs: memFs(), log: log(), ...over }
}
const noSide = { ensureDirs: false, ensureSecret: false }
const SECRET = "s".repeat(40)

describe("mode autodetect", () => {
  it("RM_DEV=1 → dev with repo defaults (appDir = cwd)", () => {
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1" }))
    expect(c).toMatchObject({ mode: "dev", dev: true, appDir: "/repo", bundleRoot: null, dataDir: "/repo/.data", dbFile: "/repo/.data/relay-manager.db" })
    expect(c.relays.simulate).toBe(true)
  })
  it("/.dockerenv → docker", () => {
    const c = resolveConfig(noSide, ctx({}, { fs: memFs({ "/.dockerenv": "" }), argv1: "/opt/relay-manager/app/server.js" }))
    expect(c).toMatchObject({ mode: "docker", dev: false, appDir: "/opt/relay-manager/app", dataDir: "/data" })
  })
  it("realpath(appDir) under /opt/relay-manager/releases/ → native", () => {
    const f = memFs({}, { "/opt/relay-manager/current": "/opt/relay-manager/releases/2.0.0" })
    const c = resolveConfig(noSide, ctx({}, { fs: f, argv1: "/opt/relay-manager/current/app/server.js" }))
    expect(c).toMatchObject({ mode: "native", appDir: "/opt/relay-manager/current/app", dataDir: "/var/lib/relay-manager", backupDir: "/var/lib/relay-manager/backups", captureDir: "/var/lib/relay-manager/consoles" })
    expect(c.relays.simulate).toBe(false)
  })
  it("otherwise → portable with bundleRoot = dirname(appDir)", () => {
    const c = resolveConfig(noSide, ctx({}, { argv1: "/home/u/relay-manager-2.0.0-linux-x64/app/server.js" }))
    expect(c).toMatchObject({ mode: "portable", bundleRoot: "/home/u/relay-manager-2.0.0-linux-x64", dataDir: "/home/u/relay-manager-2.0.0-linux-x64/data" })
  })
  it("RM_MODE wins; RM_APP_DIR sets appDir", () => {
    const c = resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/b/app" }, { fs: memFs({ "/.dockerenv": "" }) }))
    expect(c).toMatchObject({ mode: "portable", appDir: "/b/app", bundleRoot: "/b", dataDir: "/b/data" })
  })
  it("a missing config file never changes the mode; a present one never selects it", () => {
    const withFile = memFs({ "/b/config.env": "RM_MODE=docker\n" })
    const c = resolveConfig(noSide, ctx({ RM_APP_DIR: "/b/app" }, { fs: withFile }))
    expect(c.mode).toBe("portable")
    expect(c.configFile).toBe("/b/config.env")
    expect(resolveConfig(noSide, ctx({ RM_APP_DIR: "/b/app" })).configFile).toBeNull()
  })
})

describe("precedence and defaults", () => {
  it("process env > config file > mode defaults", () => {
    const f = memFs({ "/repo/config.env": "RM_PORT=4000\nRM_LOG_LEVEL=debug\nRM_HOST=127.0.0.1\n" })
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1", RM_PORT: "5000" }, { fs: f }))
    expect(c.port).toBe(5000)
    expect(c.logLevel).toBe("debug")
    expect(c.host).toBe("127.0.0.1")
    expect(c.configFile).toBe("/repo/config.env")
  })
  it("RM_CONFIG selects the file", () => {
    const f = memFs({ "/etc/x.env": "RM_PORT=4100\n" })
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1", RM_CONFIG: "/etc/x.env" }, { fs: f })).port).toBe(4100)
  })
  it("defaults", () => {
    const c = resolveConfig(noSide, ctx({ RM_MODE: "native", RM_APP_DIR: "/opt/a/app" }))
    expect(c).toMatchObject({
      host: "0.0.0.0", port: 3200, tls: null, sessionMaxAgeHours: 12, logLevel: "info", authSecret: null, setupTokenOverride: null,
      allowUnknownMigrations: false, allowRoot: false, pidFile: "/var/lib/relay-manager/server.pid", lockFile: "/var/lib/relay-manager/.instance-lock",
      serial: { devRoot: "/dev", sysRoot: "/sys", extraGlobs: [], includeBuiltin: false, hideJtag: true, scanIntervalMs: 2000, settleMs: 800, allowPoke: true, historyBytes: 256 * 1024 },
      capture: { enabled: true },
      net: { hostMode: "apply", sysRoot: "/sys", ipBin: null, allowNonUsb: false, switchHttpPort: 80, pollMs: 10000 },
      relays: { pollMs: 5000, offlinePollMs: 15000, timeoutMs: 1500, passiveDiscovery: true, discoveryPort: 30303, broadcastTargets: null, scanCidrs: null, scanPorts: [80], simulate: false },
    })
  })
  it("never reads HOSTNAME", () => {
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1", HOSTNAME: "abc123container" })).host).toBe("0.0.0.0")
  })
  it("resolves relative paths against cwd", () => {
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1", RM_DATA_DIR: ".data-w0", RM_BACKUP_DIR: "bk" }))
    expect(c.dataDir).toBe("/repo/.data-w0")
    expect(c.backupDir).toBe("/repo/bk")
    expect(c.captureDir).toBe("/repo/.data-w0/consoles")
  })
  it("warns about unknown RM_* keys in the file", () => {
    const l = log()
    resolveConfig(noSide, ctx({ RM_DEV: "1" }, { fs: memFs({ "/repo/config.env": "RM_NOPE=1\nOTHER=2\n" }), log: l }))
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining("RM_NOPE"))
    expect(l.warn).toHaveBeenCalledTimes(1)
  })
  it("reads version, buildId and BUILDINFO", () => {
    const f = memFs({
      "/b/app/package.json": JSON.stringify({ version: "2.0.0" }),
      "/b/app/.next/BUILD_ID": "2.0.0-abc-123\n",
      "/b/BUILDINFO": "version=2.0.0\nrev=abc1234\nnode=22.23.2\nbuilt=2026-09-23T10:00:00Z\n",
    })
    const c = resolveConfig(noSide, ctx({ RM_APP_DIR: "/b/app" }, { fs: f }))
    expect(c.build).toEqual({ version: "2.0.0", buildId: "2.0.0-abc-123", rev: "abc1234", builtAt: "2026-09-23T10:00:00Z" })
    const d = resolveConfig(noSide, ctx({ RM_DEV: "1" }))
    expect(d.build).toMatchObject({ buildId: "dev", rev: "dev", builtAt: null })
  })
  it("parses lists and ranges", () => {
    const c = resolveConfig(noSide, ctx({
      RM_DEV: "1", RM_RELAY_DISCOVERY_BROADCASTS: "127.255.255.255, 192.168.1.255", RM_RELAY_SCAN_CIDRS: "127.0.0.0/29,10.0.0.0/22",
      RM_RELAY_SCAN_PORTS: "18080,18081", RM_SERIAL_HISTORY_KB: "16", RM_RELAY_SIMULATE: "0", RM_CAPTURE_ENABLED: "0",
    }))
    expect(c.relays.broadcastTargets).toEqual(["127.255.255.255", "192.168.1.255"])
    expect(c.relays.scanCidrs).toEqual(["127.0.0.0/29", "10.0.0.0/22"])
    expect(c.relays.scanPorts).toEqual([18080, 18081])
    expect(c.serial.historyBytes).toBe(16 * 1024)
    expect(c.relays.simulate).toBe(false)
    expect(c.capture.enabled).toBe(false)
  })
})

describe("validation → ConfigError naming the variable", () => {
  const bad: Array<[Record<string, string>, string]> = [
    [{ RM_PORT: "abc" }, "RM_PORT"],
    [{ RM_PORT: "70000" }, "RM_PORT"],
    [{ RM_LOG_LEVEL: "verbose" }, "RM_LOG_LEVEL"],
    [{ RM_SERIAL_SCAN_INTERVAL_MS: "10" }, "RM_SERIAL_SCAN_INTERVAL_MS"],
    [{ RM_SESSION_MAX_AGE_H: "200" }, "RM_SESSION_MAX_AGE_H"],
    [{ RM_MODE: "cloud" }, "RM_MODE"],
    [{ RM_RELAY_SCAN_CIDRS: "10.0.0.0/16" }, "RM_RELAY_SCAN_CIDRS"],
    [{ RM_RELAY_SCAN_PORTS: "1,2,3,4,5" }, "RM_RELAY_SCAN_PORTS"],
    [{ RM_RELAY_DISCOVERY_BROADCASTS: "not-an-ip" }, "RM_RELAY_DISCOVERY_BROADCASTS"],
    [{ RM_HOST: "bad host!" }, "RM_HOST"],
    [{ RM_ALLOW_ROOT: "maybe" }, "RM_ALLOW_ROOT"],
  ]
  for (const [env, variable] of bad) {
    it(`${variable}=${Object.values(env)[0]}`, () => {
      try {
        resolveConfig(noSide, ctx({ RM_DEV: "1", ...env }))
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError)
        expect((e as ConfigError).variable).toBe(variable)
        expect((e as ConfigError).message).toContain(variable)
      }
    })
  }
  it("accepts RM_PORT=0 (ephemeral port for tests)", () => {
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1", RM_PORT: "0" })).port).toBe(0)
  })
})

describe("accesses (RM_ACCESS_*, RM_HW_SERVER, RM_JTAG_SYS_ROOT)", () => {
  it("defaults: ports 3201-3230 on 0.0.0.0, 8 connections, hw_server autodetected, JTAG sysfs = serial sysfs", () => {
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1", RM_SERIAL_SYS_ROOT: "/fake/sys" }))
    expect(c.accesses).toEqual({ range: { from: 3201, to: 3230 }, bind: "0.0.0.0", hwServer: null, jtagSysRoot: "/fake/sys", maxConnections: 8, hwServerFilter: "{serial}" })
  })
  it("reads every variable and resolves relative paths", () => {
    const c = resolveConfig(noSide, ctx({
      RM_DEV: "1", RM_ACCESS_PORTS: "4001-4010", RM_ACCESS_BIND: "192.0.2.97", RM_HW_SERVER: "tools/hw_server",
      RM_JTAG_SYS_ROOT: "fixtures/sys", RM_ACCESS_MAX_CONNECTIONS: "2", RM_HW_SERVER_FILTER_FORMAT: "{vendor}/{serial}",
    }))
    expect(c.accesses).toEqual({ range: { from: 4001, to: 4010 }, bind: "192.0.2.97", hwServer: "/repo/tools/hw_server", jtagSysRoot: "/repo/fixtures/sys", maxConnections: 2, hwServerFilter: "{vendor}/{serial}" })
  })
  it("rejects bad ranges, binds and limits naming the variable", () => {
    for (const [k, v] of [["RM_ACCESS_PORTS", "3230-3201"], ["RM_ACCESS_PORTS", "80-90"], ["RM_ACCESS_BIND", "no valid!"], ["RM_ACCESS_MAX_CONNECTIONS", "0"],
      ["RM_HW_SERVER_FILTER_FORMAT", "Digilent/"], ["RM_HW_SERVER_FILTER_FORMAT", "{serial}; exit"], ["RM_HW_SERVER_FILTER_FORMAT", "{serial} {x}"]] as const) {
      let err: unknown
      try { resolveConfig(noSide, ctx({ RM_DEV: "1", [k]: v })) } catch (e) { err = e }
      expect(err, `${k}=${v}`).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).variable).toBe(k)
    }
  })
  it("the new variables are known (no warning in the config file)", () => {
    const l = log()
    resolveConfig(noSide, ctx({ RM_DEV: "1" }, { log: l, fs: memFs({ "/repo/config.env": "RM_ACCESS_PORTS=3201-3210\nRM_HW_SERVER=/opt/x/hw_server\nRM_ACCESS_BIND=0.0.0.0\nRM_JTAG_SYS_ROOT=/sys\nRM_ACCESS_MAX_CONNECTIONS=4\nRM_HW_SERVER_FILTER_FORMAT={serial}\n" }) }))
    expect(l.warn).not.toHaveBeenCalled()
  })
})

describe("TLS", () => {
  it("both or neither", () => {
    expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1", RM_TLS_CERT: "/c.pem" }))).toThrow(ConfigError)
    expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1", RM_TLS_KEY: "/k.pem" }))).toThrow(ConfigError)
  })
  it("files must be readable", () => {
    expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1", RM_TLS_CERT: "/c.pem", RM_TLS_KEY: "/k.pem" }))).toThrow(/RM_TLS/)
    const f = memFs({ "/c.pem": "x", "/k.pem": "y" })
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1", RM_TLS_CERT: "/c.pem", RM_TLS_KEY: "/k.pem" }, { fs: f })).tls).toEqual({ certFile: "/c.pem", keyFile: "/k.pem" })
  })
})

describe("RM_SERIAL_EXTRA_GLOBS allow-list", () => {
  const ok = ["/dev/ttyV*", "/run/user/1000/relay-manager-sim/ttyV*", "/run/relay-manager/sim/ttyV?", "/srv/rm/sim/ttyV*"]
  it("accepts allowed directories (including $RM_DATA_DIR/sim/)", () => {
    const c = resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/b/app", RM_DATA_DIR: "/srv/rm", RM_SERIAL_EXTRA_GLOBS: ok.join(",") }))
    expect(c.serial.extraGlobs).toEqual(ok)
  })
  it("accepts <repo>/.data/sim/ only in dev", () => {
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1", RM_DATA_DIR: "/other", RM_SERIAL_EXTRA_GLOBS: "/repo/.data/sim/ttyV*" })).serial.extraGlobs).toEqual(["/repo/.data/sim/ttyV*"])
    expect(() => resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/repo/app", RM_DATA_DIR: "/other", RM_SERIAL_EXTRA_GLOBS: "/repo/.data/sim/ttyV*" }))).toThrow(ConfigError)
  })
  it("rejects other directories, wildcards before the last component and traversal", () => {
    for (const g of ["/tmp/x/ttyV*", "/dev/*/tty0", "/dev/../etc/*", "/run/userx/ttyV*", "/etc/passwd"]) {
      expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1", RM_SERIAL_EXTRA_GLOBS: g })), g).toThrow(/RM_SERIAL_EXTRA_GLOBS/)
    }
  })
})

describe("secrets and setup token", () => {
  it("refuses placeholder and short secrets", () => {
    for (const s of ["tu-secreto-super-seguro-aqui", "changeme", "secret", "short"]) {
      expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1", RM_AUTH_SECRET: s }))).toThrow(/RM_AUTH_SECRET/)
    }
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1", RM_AUTH_SECRET: SECRET })).authSecret).toBe(SECRET)
  })
  it("RM_SETUP_TOKEN needs 16 characters (8 in dev) after removing spaces and dashes", () => {
    expect(() => resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/b/app", RM_SETUP_TOKEN: "ABCD-EFGH-JKMN" }))).toThrow(/RM_SETUP_TOKEN/)
    expect(resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/b/app", RM_SETUP_TOKEN: "E2E0-E2E0-E2E0-E2E0" })).setupTokenOverride).toBe("E2E0-E2E0-E2E0-E2E0")
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1", RM_SETUP_TOKEN: "DEV0-DEV0" })).setupTokenOverride).toBe("DEV0-DEV0")
    expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1", RM_SETUP_TOKEN: "AB-CD" }))).toThrow(ConfigError)
  })
})

describe("side effects (real fs)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const c of cleanups.splice(0)) c() })

  function spyFs() {
    const real = nodeConfigFs()
    const spied = {
      ...real,
      mkdirp: vi.fn(real.mkdirp), writeFileExclusive: vi.fn(real.writeFileExclusive), chmod: vi.fn(real.chmod),
    }
    return spied
  }

  it("ensureDirs:false + ensureSecret:false creates no file or directory and returns authSecret null", () => {
    const t = withTempDir(); cleanups.push(t.cleanup)
    const f = spyFs()
    const dataDir = path.join(t.dir, "data")
    const c = resolveConfig(noSide, { env: { RM_DEV: "1", RM_DATA_DIR: dataDir }, cwd: t.dir, fs: f, log: log() })
    expect(c.authSecret).toBeNull()
    expect(f.mkdirp).not.toHaveBeenCalled()
    expect(f.writeFileExclusive).not.toHaveBeenCalled()
    expect(f.chmod).not.toHaveBeenCalled()
    expect(fs.readdirSync(t.dir)).toEqual([])
  })

  it("ensureDirs + ensureSecret create the dirs and a 0600 secret, then reuse it", () => {
    const t = withTempDir(); cleanups.push(t.cleanup)
    const dataDir = path.join(t.dir, "data")
    const l = log()
    const c1 = resolveConfig({ ensureDirs: true, ensureSecret: true }, { env: { RM_DEV: "1", RM_DATA_DIR: dataDir }, cwd: t.dir, fs: nodeConfigFs(), log: l })
    expect(c1.authSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(fs.statSync(path.join(dataDir, "auth-secret")).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dataDir).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(dataDir, "backups")).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(dataDir, "consoles")).isDirectory()).toBe(true)
    expect(l.info).toHaveBeenCalledWith(expect.stringContaining("Generado nuevo secreto de sesión en"))
    const c2 = resolveConfig({ ensureDirs: true, ensureSecret: true }, { env: { RM_DEV: "1", RM_DATA_DIR: dataDir }, cwd: t.dir, fs: nodeConfigFs(), log: log() })
    expect(c2.authSecret).toBe(c1.authSecret)
    // read without ensureSecret also finds it
    expect(resolveConfig(noSide, { env: { RM_DEV: "1", RM_DATA_DIR: dataDir }, cwd: t.dir, fs: nodeConfigFs(), log: log() }).authSecret).toBe(c1.authSecret)
  })

  it("fixes a secret file with a loose mode (only with ensureSecret) and warns", () => {
    const t = withTempDir(); cleanups.push(t.cleanup)
    fs.writeFileSync(path.join(t.dir, "auth-secret"), SECRET + "\n", { mode: 0o644 })
    fs.chmodSync(path.join(t.dir, "auth-secret"), 0o644)
    const l1 = log()
    resolveConfig(noSide, { env: { RM_DEV: "1", RM_DATA_DIR: t.dir }, cwd: t.dir, fs: nodeConfigFs(), log: l1 })
    expect(fs.statSync(path.join(t.dir, "auth-secret")).mode & 0o777).toBe(0o644)
    const l2 = log()
    const c = resolveConfig({ ensureDirs: true, ensureSecret: true }, { env: { RM_DEV: "1", RM_DATA_DIR: t.dir }, cwd: t.dir, fs: nodeConfigFs(), log: l2 })
    expect(c.authSecret).toBe(SECRET)
    expect(l2.warn).toHaveBeenCalled()
    expect(fs.statSync(path.join(t.dir, "auth-secret")).mode & 0o777).toBe(0o600)
  })

  it("RM_AUTH_SECRET wins over the file and nothing is generated", () => {
    const t = withTempDir(); cleanups.push(t.cleanup)
    const c = resolveConfig({ ensureDirs: true, ensureSecret: true }, { env: { RM_DEV: "1", RM_DATA_DIR: t.dir, RM_AUTH_SECRET: SECRET }, cwd: t.dir, fs: nodeConfigFs(), log: log() })
    expect(c.authSecret).toBe(SECRET)
    expect(fs.existsSync(path.join(t.dir, "auth-secret"))).toBe(false)
  })
})

describe("Archivos (RM_FILES_*)", () => {
  it("defaults: $HOME/tftp in dev and portable, <datos>/tftp native, /files in Docker", () => {
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1", HOME: "/home/ana" })).files).toEqual({
      enabled: true, dir: "/home/ana/tftp", maxUploadBytes: 4096 * 1024 * 1024, deleteAdminOnly: false,
      extraEnabled: false, extraDir: "/home/ana/extra", extraName: "extra", extraHint: "Segunda carpeta compartida",
    })
    expect(resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/b/app", HOME: "/home/ana" })).files.dir).toBe("/home/ana/tftp")
    expect(resolveConfig(noSide, ctx({ RM_MODE: "native", RM_APP_DIR: "/opt/relay-manager/current/app", HOME: "/var/lib/relay-manager" })).files.dir)
      .toBe("/var/lib/relay-manager/tftp")
    expect(resolveConfig(noSide, ctx({ RM_MODE: "docker", RM_APP_DIR: "/opt/relay-manager/app" })).files.dir).toBe("/files")
    // No HOME (and no home from the passwd entry): next to the data.
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1" }, { home: null })).files.dir).toBe("/repo/.data/tftp")
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1" }, { home: "/home/pw" })).files.dir).toBe("/home/pw/tftp")
  })

  it("reads RM_FILES_DIR (relative to cwd), the size limit, the delete policy and the switch", () => {
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1", RM_FILES_DIR: "compartido", RM_FILES_MAX_UPLOAD_MB: "10", RM_FILES_DELETE: "admins", RM_FILES_ENABLED: "0" }))
    expect(c.files).toMatchObject({ enabled: false, dir: "/repo/compartido", maxUploadBytes: 10 * 1024 * 1024, deleteAdminOnly: true })
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1", RM_FILES_DELETE: "users" })).files.deleteAdminOnly).toBe(false)
  })

  it.each([
    [{ RM_FILES_MAX_UPLOAD_MB: "0" }, "RM_FILES_MAX_UPLOAD_MB"],
    [{ RM_FILES_MAX_UPLOAD_MB: "abc" }, "RM_FILES_MAX_UPLOAD_MB"],
    [{ RM_FILES_DELETE: "todos" }, "RM_FILES_DELETE"],
    [{ RM_FILES_ENABLED: "si" }, "RM_FILES_ENABLED"],
    [{ RM_FILES_DIR: "/" }, "RM_FILES_DIR"],
    [{ RM_FILES_DIR: "/etc" }, "RM_FILES_DIR"],
    [{ RM_FILES_DIR: "/home" }, "RM_FILES_DIR"],
    [{ RM_FILES_DIR: "/etc/relay-manager/tftp" }, "RM_FILES_DIR"],
    [{ RM_FILES_DIR: "/srv/rm" }, "RM_FILES_DIR"],            // the data dir itself
    [{ RM_FILES_DIR: "/srv" }, "RM_FILES_DIR"],               // contains the data dir
    [{ RM_FILES_DIR: "/srv/rm/backups/x" }, "RM_FILES_DIR"],  // inside the backups
    [{ RM_FILES_DIR: "/srv/rm/consoles" }, "RM_FILES_DIR"],   // the captures
    [{ RM_FILES_DIR: "/b" }, "RM_FILES_DIR"],                 // contains the app
  ])("rejects %j", (env, variable) => {
    try {
      resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/b/app", RM_DATA_DIR: "/srv/rm", ...env }))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).variable).toBe(variable)
    }
  })

  it("allows a dedicated folder inside the data dir (the native fallback)", () => {
    expect(resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/b/app", RM_DATA_DIR: "/srv/rm", RM_FILES_DIR: "/srv/rm/tftp" })).files.dir).toBe("/srv/rm/tftp")
  })

  it("RM_FILES_* are known variables in the config file", () => {
    const l = log()
    const f = memFs({ "/repo/config.env": "RM_FILES_DIR=/srv/tftp\nRM_FILES_MAX_UPLOAD_MB=100\nRM_FILES_ENABLED=1\nRM_FILES_DELETE=admins\n" })
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1" }, { fs: f, log: l }))
    expect(c.files).toMatchObject({ dir: "/srv/tftp", maxUploadBytes: 100 * 1024 * 1024, deleteAdminOnly: true })
    expect(l.warn).not.toHaveBeenCalled()
  })
})

describe("applyConfigEnv", () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  it("sets auth/Next variables, normalises the session age and deletes AUTH_URL/NEXTAUTH_URL", () => {
    process.env.AUTH_URL = "http://0.0.0.0:3000"
    process.env.NEXTAUTH_URL = "http://0.0.0.0:3000"
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1", RM_AUTH_SECRET: SECRET, RM_SESSION_MAX_AGE_H: "24" }))
    applyConfigEnv(c)
    expect(process.env.AUTH_SECRET).toBe(SECRET)
    expect(process.env.AUTH_TRUST_HOST).toBe("true")
    expect(process.env.NEXT_TELEMETRY_DISABLED).toBe("1")
    expect(process.env.RM_SESSION_MAX_AGE_H).toBe("24")
    expect(process.env.NODE_ENV).toBe("development")
    expect(process.env.AUTH_URL).toBeUndefined()
    expect(process.env.NEXTAUTH_URL).toBeUndefined()
    applyConfigEnv(resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/b/app", RM_AUTH_SECRET: SECRET })))
    expect(process.env.NODE_ENV).toBe("production")
  })
})

describe("second folder and the download script (RM_FILES_EXTRA_*, RM_EXPORT_*)", () => {
  it("generic defaults: no second folder, downloader off without a script, no repository URL", () => {
    const n = resolveConfig(noSide, ctx({ RM_MODE: "native", RM_APP_DIR: "/opt/relay-manager/current/app" }))
    expect(n.files.extraEnabled).toBe(false)
    expect(n.exports).toEqual({
      enabled: false, script: null, timeoutMs: 60 * 60_000, root: "tftp",
      name: "Descargas", title: "Ejecutar script de descarga…", description: expect.stringMatching(/script de descarga/), appLabel: "Aplicación", versionLabel: "Versión",
      extractLabel: null, user: null, password: null, url: null,
      envUser: "EXPORT_USER", envPassword: "EXPORT_PASSWORD", envUrl: "EXPORT_URL", envExtra: {},
    })
    expect(n.defaults).toEqual({ labName: "Relay Manager", equipmentIp: null, equipmentPort: 22 })
    expect(n.copy.testRemovable).toBeNull()
  })
  it("the folder: ~/<name> (dev, portable), <datos>/<name> native, /extra in Docker; ~ expanded", () => {
    const named = { RM_FILES_EXTRA_NAME: "Compartida" }
    expect(resolveConfig(noSide, ctx({ ...named, RM_MODE: "portable", RM_APP_DIR: "/b/app", HOME: "/home/ana" })).files).toMatchObject({ extraEnabled: true, extraDir: "/home/ana/Compartida", extraName: "Compartida" })
    expect(resolveConfig(noSide, ctx({ ...named, RM_MODE: "native", RM_APP_DIR: "/opt/relay-manager/current/app", HOME: "/var/lib/relay-manager" })).files.extraDir)
      .toBe("/var/lib/relay-manager/Compartida")
    expect(resolveConfig(noSide, ctx({ ...named, RM_MODE: "docker", RM_APP_DIR: "/opt/relay-manager/app" })).files.extraDir).toBe("/extra")
    expect(resolveConfig(noSide, ctx({ ...named, RM_DEV: "1", HOME: "/home/ana", RM_FILES_EXTRA_DIR: "~/datos/comp" })).files.extraDir).toBe("/home/ana/datos/comp")
    expect(resolveConfig(noSide, ctx({ ...named, RM_DEV: "1", RM_FILES_EXTRA_ENABLED: "0" })).files.extraEnabled).toBe(false)
  })
  it("reads the variables", () => {
    const c = resolveConfig(noSide, ctx({
      RM_DEV: "1", RM_FILES_EXTRA_NAME: "Compartida", RM_FILES_EXTRA_DIR: "/srv/compartida", RM_FILES_EXTRA_HINT: "Para todos",
      RM_EXPORT_ENABLED: "1", RM_EXPORT_DOWNLOADER: "/opt/fake.sh", RM_EXPORT_ROOT: "tftp", RM_EXPORT_NAME: "Bajadas", RM_EXPORT_EXTRACT_LABEL: "Extraer",
      RM_EXPORT_TIMEOUT_MIN: "5", RM_EXPORT_USER: "downloader", RM_EXPORT_PASSWORD: "s3cr3t!$ x", RM_EXPORT_URL: "https://repo.lab:8082/artefactos",
      RM_EXPORT_ENV_USER: "REPO_USR", RM_EXPORT_ENV_PASSWORD: "REPO_PSW", RM_EXPORT_ENV_URL: "REPO_URL", RM_EXPORT_ENV_EXTRA: " TOOL_A=false  TOOL_B=1.2:x ",
      RM_COPY_TEST_REMOVABLE: "/dev/loop7", RM_LAB_NAME: "Laboratorio", RM_EQUIPNET_EQUIPMENT_IP: "10.0.0.5", RM_EQUIPNET_EQUIPMENT_PORT: "2222",
    }))
    expect(c.files).toMatchObject({ extraEnabled: true, extraDir: "/srv/compartida", extraName: "Compartida", extraHint: "Para todos" })
    expect(c.exports).toMatchObject({
      enabled: true, script: "/opt/fake.sh", root: "tftp", name: "Bajadas", extractLabel: "Extraer", timeoutMs: 5 * 60_000,
      user: "downloader", password: "s3cr3t!$ x", url: "https://repo.lab:8082/artefactos",
      envUser: "REPO_USR", envPassword: "REPO_PSW", envUrl: "REPO_URL", envExtra: { TOOL_A: "false", TOOL_B: "1.2:x" },
    })
    expect(c.defaults).toEqual({ labName: "Laboratorio", equipmentIp: "10.0.0.5", equipmentPort: 2222 })
    expect(c.copy.testRemovable).toBe("/dev/loop7")
  })
  it.each([
    [{ RM_FILES_EXTRA_NAME: "C", RM_FILES_EXTRA_DIR: "/etc/compartida" }, "RM_FILES_EXTRA_DIR"],
    [{ RM_FILES_EXTRA_NAME: "C", RM_FILES_EXTRA_DIR: "/home/ana/tftp/c", RM_FILES_DIR: "/home/ana/tftp" }, "RM_FILES_EXTRA_DIR"],
    [{ RM_FILES_EXTRA_NAME: "C", RM_FILES_EXTRA_DIR: "/home/ana/x", RM_FILES_DIR: "/home/ana/x" }, "RM_FILES_EXTRA_DIR"],
    [{ RM_FILES_EXTRA_NAME: "a/b" }, "RM_FILES_EXTRA_NAME"],
    [{ RM_EXPORT_ROOT: "otra" }, "RM_EXPORT_ROOT"],
    [{ RM_EXPORT_TIMEOUT_MIN: "0" }, "RM_EXPORT_TIMEOUT_MIN"],
    [{ RM_EXPORT_USER: "a b" }, "RM_EXPORT_USER"],
    [{ RM_EXPORT_PASSWORD: "a\nb" }, "RM_EXPORT_PASSWORD"],
    [{ RM_EXPORT_URL: "ftp://x" }, "RM_EXPORT_URL"],
    [{ RM_EXPORT_ENV_USER: "user" }, "RM_EXPORT_ENV_USER"],
    [{ RM_EXPORT_ENV_PASSWORD: "LD_PRELOAD" }, "RM_EXPORT_ENV_PASSWORD"],
    [{ RM_EXPORT_ENV_URL: "PATH" }, "RM_EXPORT_ENV_URL"],
    [{ RM_EXPORT_ENV_URL: "RM_AUTH_SECRET" }, "RM_EXPORT_ENV_URL"],
    [{ RM_EXPORT_ENV_USER: "X", RM_EXPORT_ENV_PASSWORD: "X" }, "RM_EXPORT_ENV_USER"],
    [{ RM_EXPORT_ENV_EXTRA: "HOME=/x" }, "RM_EXPORT_ENV_EXTRA"],
    [{ RM_EXPORT_ENV_EXTRA: "EXPORT_PASSWORD=x" }, "RM_EXPORT_ENV_EXTRA"],
    [{ RM_EXPORT_ENV_EXTRA: "A=$(id)" }, "RM_EXPORT_ENV_EXTRA"],
    [{ RM_EXPORT_ENV_EXTRA: "novale" }, "RM_EXPORT_ENV_EXTRA"],
    [{ RM_EQUIPNET_EQUIPMENT_IP: "1.2.3" }, "RM_EQUIPNET_EQUIPMENT_IP"],
    [{ RM_EQUIPNET_EQUIPMENT_PORT: "70000" }, "RM_EQUIPNET_EQUIPMENT_PORT"],
    [{ RM_COPY_TEST_REMOVABLE: "/dev/sda" }, "RM_COPY_TEST_REMOVABLE"],
  ])("rejects %j", (env, name) => {
    expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1", ...env }))).toThrow(name)
  })
})

describe("profile («perfil»: RM_PROFILE_DIR, perfil.env)", () => {
  const PERFIL = [
    'RM_LAB_NAME="Laboratorio X"', "RM_FILES_EXTRA_NAME=Compartida", "RM_FILES_EXTRA_DIR=~/compartida", "RM_EXPORT_ENABLED=1",
    "RM_EXPORT_DOWNLOADER=herramientas/descarga.sh", "RM_EQUIPNET_EQUIPMENT_IP=192.168.1.10", "RM_PORT=9999", "",
  ].join("\n")
  it("default location per mode; none → generic values", () => {
    expect(resolveConfig(noSide, ctx({ RM_DEV: "1" })).profile).toEqual({ dir: null, path: "/repo/perfil", explicit: false, envFile: null, warnings: [] })
    expect(resolveConfig(noSide, ctx({ RM_MODE: "native", RM_APP_DIR: "/opt/relay-manager/current/app" })).profile.path).toBe("/etc/relay-manager/perfil")
    expect(resolveConfig(noSide, ctx({ RM_MODE: "portable", RM_APP_DIR: "/b/app" })).profile.path).toBe("/b/perfil")
    expect(resolveConfig(noSide, ctx({ RM_MODE: "docker", RM_APP_DIR: "/opt/relay-manager/app" })).profile.path).toBe("/perfil")
  })
  it("perfil.env sets project defaults; relative paths are relative to the profile; disallowed keys are ignored with a warning", () => {
    const l = log()
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1", HOME: "/home/ana" }, { fs: memFs({ "/repo/perfil/perfil.env": PERFIL }), log: l }))
    expect(c.profile).toMatchObject({ dir: "/repo/perfil", envFile: "/repo/perfil/perfil.env", explicit: false })
    expect(c.profile.warnings).toEqual(["Variable no permitida en perfil.env: RM_PORT (se ignora; defínela en config.env)"])
    expect(l.warn).toHaveBeenCalled()
    expect(c.port).toBe(3200)
    expect(c.defaults).toMatchObject({ labName: "Laboratorio X", equipmentIp: "192.168.1.10" })
    expect(c.files).toMatchObject({ extraEnabled: true, extraName: "Compartida", extraDir: "/home/ana/compartida" })
    expect(c.exports).toMatchObject({ enabled: true, script: "/repo/perfil/herramientas/descarga.sh", root: "extra" })
  })
  it("precedence: process env > config.env > perfil.env > defaults; RM_PROFILE_DIR from config.env", () => {
    const f = memFs({
      "/repo/config.env": "RM_PROFILE_DIR=/srv/perfil\nRM_LAB_NAME=Desde config\nRM_EXPORT_DOWNLOADER=otra.sh\n",
      "/srv/perfil/perfil.env": PERFIL,
    })
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1", HOME: "/home/ana", RM_FILES_EXTRA_NAME: "Desde entorno" }, { fs: f }))
    expect(c.profile).toMatchObject({ dir: "/srv/perfil", explicit: true })
    expect(c.defaults.labName).toBe("Desde config")
    expect(c.files.extraName).toBe("Desde entorno")
    // A relative path from config.env is relative to the working directory, not to the profile.
    expect(c.exports.script).toBe("/repo/otra.sh")
    expect(c.defaults.equipmentIp).toBe("192.168.1.10")
  })
  it("RM_PROFILE_DIR set but missing: generic values and a warning", () => {
    const l = log()
    const c = resolveConfig(noSide, ctx({ RM_DEV: "1", RM_PROFILE_DIR: "/no/existe" }, { log: l }))
    expect(c.profile).toMatchObject({ dir: null, path: "/no/existe", explicit: true })
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/No existe la carpeta del perfil \/no\/existe/))
  })
  it("a bad value in perfil.env names the file", () => {
    const f = memFs({ "/repo/perfil/perfil.env": "RM_EXPORT_ENABLED=quizá\n" })
    expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1" }, { fs: f }))).toThrow("RM_EXPORT_ENABLED")
    const g = memFs({ "/repo/perfil/perfil.env": "RM_EQUIPNET_EQUIPMENT_IP=x\n" })
    expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1" }, { fs: g }))).toThrow("/repo/perfil/perfil.env")
  })
})

describe("Copiar a una carpeta del servidor (RM_COPY_*, RM_SUDO_USER)", () => {
  it("defaults: enabled, browse from /, root writes in /media, /run/media and /mnt; the helper socket only in native", () => {
    const dev = resolveConfig(noSide, ctx({ RM_DEV: "1", USER: "ana" }))
    expect(dev.copy).toEqual({ enabled: true, roots: ["/"], deny: [], rootPaths: ["/media", "/run/media", "/mnt"], sudoUser: "ana", helperSocket: null, testRemovable: null })
    const native = resolveConfig(noSide, ctx({ RM_MODE: "native", RM_APP_DIR: "/opt/relay-manager/current/app", USER: "relay-manager" }))
    expect(native.copy).toMatchObject({ sudoUser: null, helperSocket: "/run/relay-manager-rootcopy/rootcopy.sock" })
    expect(resolveConfig(noSide, ctx({ RM_MODE: "docker", RM_APP_DIR: "/opt/relay-manager/app" })).copy.helperSocket).toBeNull()
  })
  it("reads the lists, the switch, the sudo user and the socket", () => {
    const c = resolveConfig(noSide, ctx({
      RM_DEV: "1", RM_COPY_ENABLED: "0", RM_COPY_ROOTS: "/media, /srv/banco/", RM_COPY_DENY: "/srv/banco/privado", RM_COPY_ROOT_PATHS: "/media,/srv/banco",
      RM_SUDO_USER: "ingeniero", RM_COPY_HELPER_SOCKET: "/tmp/rc.sock",
    }))
    expect(c.copy).toEqual({ enabled: false, roots: ["/media", "/srv/banco"], deny: ["/srv/banco/privado"], rootPaths: ["/media", "/srv/banco"], sudoUser: "ingeniero", helperSocket: "/tmp/rc.sock", testRemovable: null })
  })
  it.each([
    [{ RM_COPY_ROOTS: "media" }, "RM_COPY_ROOTS"],
    [{ RM_COPY_DENY: "/a/../etc" }, "RM_COPY_DENY"],
    [{ RM_COPY_ROOT_PATHS: "/media,mnt" }, "RM_COPY_ROOT_PATHS"],
    [{ RM_COPY_ENABLED: "si" }, "RM_COPY_ENABLED"],
    [{ RM_SUDO_USER: "ana;rm -rf" }, "RM_SUDO_USER"],
  ])("rejects %j", (env, name) => {
    expect(() => resolveConfig(noSide, ctx({ RM_DEV: "1", ...env }))).toThrow(name)
  })
})
