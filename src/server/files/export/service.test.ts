import { spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ExportStartSchema, type ExportJobDTO } from "@/lib/contracts/files"
import { isDomainError } from "@/server/errors"
import { createNullLogger } from "@/server/log"
import type { AuthUser } from "@/server/runtime/types"
import { fakeAudit, fakeBus, testConfig, withTempDir } from "../../../../test/helpers"
import { createFilesCore } from "../core"
import {
  buildExportArgs, buildExportEnv, cleanLine, createExportService, defaultZipName, LogSplitter, normalizeZipName, redactLine, scriptSecrets,
  type ExportInternals, type SpawnFn,
} from "./service"

const FAKE = path.resolve(__dirname, "../../../../test/fixtures/fake-export-downloader.sh")
const PASSWORD = "Sup3r-Secreta!"
const ana: AuthUser = { id: "u-ana", username: "ana", name: "Ana", isAdmin: false, roleIds: [], mustChangePassword: false, sessionVersion: 1 }
const bea: AuthUser = { ...ana, id: "u-bea", username: "bea", name: "Bea" }
const admin: AuthUser = { ...ana, id: "u-admin", username: "admin", name: "Admin", isAdmin: true }

let t: { dir: string; cleanup: () => void }
let extra: string
let bus: ReturnType<typeof fakeBus>
let audit: ReturnType<typeof fakeAudit>
const services: Array<{ stop(): Promise<void> }> = []

beforeEach(() => {
  t = withTempDir("rm-export-")
  extra = path.join(t.dir, "compartida")
  fs.mkdirSync(path.join(extra, "apps"), { recursive: true })
  bus = fakeBus()
  audit = fakeAudit()
})
afterEach(async () => {
  for (const s of services.splice(0)) await s.stop()
  t.cleanup()
})

function make(internals: ExportInternals = {}, exportsCfg: Partial<ReturnType<typeof testConfig>["exports"]> = {}) {
  const base = testConfig()
  const config = testConfig({
    files: { ...base.files, extraEnabled: true, extraDir: extra, extraName: "Compartida", extraHint: "Segunda carpeta compartida" },
    exports: { ...base.exports, script: FAKE, user: "downloader", password: PASSWORD, ...exportsCfg },
    dataDir: path.join(t.dir, "data"), backupDir: path.join(t.dir, "data", "b"), captureDir: path.join(t.dir, "data", "c"),
    dbFile: path.join(t.dir, "data", "db"), appDir: path.join(t.dir, "app"),
  })
  fs.mkdirSync(config.dataDir, { recursive: true })
  const core = createFilesCore({ config, log: createNullLogger(), bus, audit, root: { id: "extra", dir: extra, reserved: [".descargas"] } })
  const svc = createExportService({ config, log: createNullLogger(), bus, audit, core, rootLabel: "Compartida" }, { publishMs: 10, killGraceMs: 500, ...internals })
  services.push(svc)
  return { svc, core }
}

const input = (app: string, extra: Partial<{ version: string; extract: boolean; zipName: string | null; dir: string }> = {}) =>
  ExportStartSchema.parse({ app, version: "1.2.3", extract: false, zipName: null, dir: "", ...extra })

async function until(svc: ReturnType<typeof make>["svc"], id: string, states: string[], user: AuthUser = admin, ms = 15_000): Promise<ExportJobDTO> {
  const t0 = Date.now()
  for (;;) {
    const j = svc.jobs(user).find((x) => x.id === id)
    if (j && states.includes(j.state)) return j
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting ${states.join("/")}: ${JSON.stringify(j)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "ok"
  } catch (e) {
    return isDomainError(e) ? String(e.details?.files) : `throw ${String(e)}`
  }
}

describe("pure helpers", () => {
  it("validates app and version (Conan charset, no leading - or .)", () => {
    const ok = (app: string, version = "1.0") => ExportStartSchema.safeParse({ app, version, extract: false, zipName: null, dir: "" }).success
    expect(ok("app_demo")).toBe(true)
    expect(ok("pkg+x.y-z", "2.0.1+build.3")).toBe(true)
    for (const bad of ["", "-x", ".hidden", "a b", "a;rm -rf /", "$(id)", "a/b", "a`id`", "x".repeat(101), "ñ"]) expect(ok(bad), bad).toBe(false)
    expect(ok("app", "--version")).toBe(false)
  })
  it("zip names: default, .zip appended, invalid ones refused", () => {
    expect(defaultZipName("app", "1.0")).toBe("app-1.0_exports.zip")
    expect(normalizeZipName(null, "app", "1.0")).toEqual({ ok: true, name: "app-1.0_exports.zip" })
    expect(normalizeZipName("  ", "app", "1.0")).toEqual({ ok: true, name: "app-1.0_exports.zip" })
    expect(normalizeZipName("entrega", "app", "1.0")).toEqual({ ok: true, name: "entrega.zip" })
    expect(normalizeZipName("x.ZIP", "app", "1.0")).toEqual({ ok: true, name: "x.ZIP" })
    for (const bad of ["a/b", "..", ".oculto", "-x", "a\nb"]) expect(normalizeZipName(bad, "app", "1.0").ok, bad).toBe(false)
  })
  it("arguments are an array; the password is never in them", () => {
    expect(buildExportArgs("/opt/s.sh", { app: "a", version: "1", extract: true }, "/w/a.zip")).toEqual(["/opt/s.sh", "a", "1", "-o", "/w/a.zip", "-x"])
    expect(buildExportArgs("/opt/s.sh", { app: "a", version: "1", extract: false }, "/w/a.zip")).toEqual(["/opt/s.sh", "a", "1", "-o", "/w/a.zip"])
  })
  it("environment: exactly the expected keys, nothing of the server's", () => {
    const names = { envUser: "EXPORT_USER", envPassword: "EXPORT_PASSWORD", envUrl: "EXPORT_URL", envExtra: {} }
    const env = buildExportEnv({ ...names, user: "u", password: "p", url: null }, "/w")
    expect(Object.keys(env).sort()).toEqual(["CI", "EXPORT_PASSWORD", "EXPORT_USER", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"])
    expect(env).toMatchObject({ HOME: "/w", TMPDIR: "/w", EXPORT_USER: "u", EXPORT_PASSWORD: "p", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" })
    expect(Object.keys(buildExportEnv({ ...names, user: null, password: null, url: null }, "/w"))).not.toContain("EXPORT_PASSWORD")
    expect(buildExportEnv({ ...names, user: null, password: null, url: "http://repo:8082/a" }, "/w").EXPORT_URL).toBe("http://repo:8082/a")
  })
  it("environment: the profile names the variables and adds fixed ones, never over the base ones", () => {
    const env = buildExportEnv({
      user: "u", password: "p", url: "http://repo/x", envUser: "REPO_USR", envPassword: "REPO_PSW", envUrl: "REPO_URL",
      envExtra: { TOOL_NO_PROMPT: "true", HOME: "/otra" },
    }, "/w")
    expect(env).toMatchObject({ REPO_USR: "u", REPO_PSW: "p", REPO_URL: "http://repo/x", TOOL_NO_PROMPT: "true", HOME: "/w" })
    expect(Object.keys(env)).not.toContain("EXPORT_PASSWORD")
  })
  it("log lines: ANSI and control characters removed, secrets redacted", () => {
    expect(cleanLine("\u001b[32m✓ ok\u001b[0m\tfin\u0007")).toBe("✓ ok fin")
    expect(cleanLine("x".repeat(3000)).length).toBe(2001)
    expect(redactLine("la clave es Sup3r-Secreta! ya", [PASSWORD])).toBe("la clave es ******** ya")
    expect(redactLine("jf config add --password=abc --user=u", [])).toBe("jf config add --password=******** --user=u")
    expect(redactLine("curl -fL -u downloader:S3creta-De-Prueba! http://x", [])).toBe("curl -fL -u downloader:******** http://x")
    expect(redactLine("http://downloader:clave@10.0.0.35/x", [])).toBe("http://downloader:********@10.0.0.35/x")
    expect(redactLine("REPO_PSW=abc123 fin", [], "REPO_PSW")).toBe("REPO_PSW=******** fin")
    expect(redactLine("MY_REPO_PSW=abc123", [], "REPO_PSW")).toBe("MY_REPO_PSW=abc123")
  })
  it("progress meters (\\r) keep only their last state", () => {
    const out: string[] = []
    const s = new LogSplitter((l) => out.push(l))
    s.push("Descargando\r 10%\r 5")
    s.push("0%\r100%\nlinea 2\r\nlinea 3")
    s.end()
    expect(out).toEqual(["100%", "linea 2", "linea 3"])
  })
})

describe("runner", () => {
  it("runs the script in its work dir with the minimal environment; the zip lands in the destination root (no clobber); work dir removed", async () => {
    const { svc } = make()
    fs.writeFileSync(path.join(extra, "apps", "app-1.2.3_exports.zip"), "ya existía")
    const j0 = await svc.start(ana, "10.0.0.2", input("app", { dir: "apps", extract: true }))
    expect(j0).toMatchObject({ state: expect.stringMatching(/queued|running/), zipName: "app-1.2.3_exports.zip", dir: "apps", userId: ana.id })
    const j = await until(svc, j0.id, ["done", "error"])
    expect(j.error).toBeNull()
    expect(j).toMatchObject({ state: "done", exitCode: 0, finalName: "app-1.2.3_exports (1).zip", finalPath: "apps/app-1.2.3_exports (1).zip" })
    expect(fs.readFileSync(path.join(extra, "apps", "app-1.2.3_exports.zip"), "utf8")).toBe("ya existía")
    const st = fs.statSync(path.join(extra, "apps", "app-1.2.3_exports (1).zip"))
    expect(st.size).toBe(j.sizeBytes)
    expect(st.mode & 0o777).toBe(0o664)
    const log = j.log.join("\n")
    expect(log).toMatch(/ARG app\nARG 1\.2\.3\nARG -o\nARG .*\/data\/descargas\/[0-9a-f]{32}\/app-1\.2\.3_exports\.zip\nARG -x/)
    expect(log).toContain("EXPORT_USER=downloader")
    expect(log).toContain("PSW_SET=yes")
    expect(log).not.toContain(PASSWORD)
    const keys = /ENV_KEYS=(.*)/.exec(log)?.[1].trim().split(" ") ?? []
    expect(keys.filter((k) => !["PWD", "SHLVL", "OLDPWD"].includes(k)).sort()).toEqual(["CI", "EXPORT_PASSWORD", "EXPORT_URL", "EXPORT_USER", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"])
    expect(log).toMatch(/HOME=.*\/data\/descargas\/[0-9a-f]{32}\n/)
    expect(log).toContain("100%")
    expect(log).not.toMatch(/\u001b/)
    await vi.waitFor(() => expect(fs.readdirSync(path.join(t.dir, "data", "descargas"))).toEqual([]), { timeout: 5000 })
    // The root's listing never shows the work dir; the new zip is announced.
    expect(bus.events.some((e) => e.event.type === "files.changed" && e.event.root === "extra" && e.event.dirs.includes("apps"))).toBe(true)
    const ev = bus.events.filter((e) => e.event.type === "files.export")
    expect(ev.every((e) => e.audience.kind === "userAndAdmins" && e.audience.userId === ana.id)).toBe(true)
    expect(ev.flatMap((e) => (e.event.type === "files.export" ? e.event.lines : [])).join("\n")).toContain("ARG app")
    expect(ev.every((e) => e.event.type === "files.export" && e.event.job.log.length === 0)).toBe(true)
    const a = audit.inputs.filter((x) => x.action === "files.export")
    expect(a.map((x) => (x.detail as Record<string, unknown>).fase)).toEqual(["inicio", "fin"])
    expect(a[1]).toMatchObject({ outcome: "ok", detail: { result: "exportado", finalPath: "apps/app-1.2.3_exports (1).zip", exitCode: 0 } })
    expect(JSON.stringify(audit.inputs)).not.toContain(PASSWORD)
  })

  it("a failing script: error with its [ERROR] line and the exit code; nothing left behind", async () => {
    const { svc } = make()
    const j = await until(svc, (await svc.start(ana, null, input("fail"))).id, ["done", "error"])
    expect(j).toMatchObject({ state: "error", exitCode: 3, finalPath: null })
    expect(j.error).toMatch(/fallo simulado \(código 3\)/)
    await vi.waitFor(() => expect(fs.readdirSync(path.join(t.dir, "data", "descargas"))).toEqual([]), { timeout: 5000 })
    await vi.waitFor(() => expect(audit.inputs.at(-1)).toMatchObject({ action: "files.export", outcome: "error", detail: { result: "error", exitCode: 3 } }), { timeout: 5000 })
  })

  it("the configured password is redacted from what the script prints", async () => {
    const { svc } = make()
    const j = await until(svc, (await svc.start(ana, null, input("leak"))).id, ["done", "error"])
    const all = j.log.join("\n") + JSON.stringify(bus.events)
    expect(all).not.toContain(PASSWORD)
    expect(j.log.join("\n")).toContain("la contraseña es ********")
  })

  it("one job at a time; the others wait with their position; per-user and total queue limits", async () => {
    const { svc } = make({ maxQueued: 3, maxQueuedPerUser: 2 })
    const a = await svc.start(ana, null, input("slow"))
    await until(svc, a.id, ["running"])
    const b = await svc.start(ana, null, input("app"))
    const c = await svc.start(bea, null, input("app", { version: "2" }))
    expect(svc.stats()).toEqual({ running: 1, queued: 2 })
    expect(svc.jobs(admin).find((x) => x.id === c.id)?.queuePosition).toBe(2)
    await svc.start(ana, null, input("app", { version: "3" }))
    expect(await kindOf(svc.start(ana, null, input("app", { version: "4" })))).toBe("BUSY")
    expect(await kindOf(svc.start(bea, null, input("app", { version: "5" })))).toBe("BUSY")
    // Visibility: own jobs; administrators see all.
    expect(svc.jobs(bea).map((x) => x.id)).toEqual([c.id])
    expect(svc.jobs(admin).length).toBe(4)
    // Others cannot cancel; the owner and admins can.
    expect(svc.cancel(bea, null, a.id)).toBe(false)
    expect(svc.cancel(admin, null, b.id)).toBe(true)
    expect(svc.jobs(admin).find((x) => x.id === b.id)?.state).toBe("canceled")
    expect(svc.cancel(ana, null, a.id)).toBe(true)
    const ja = await until(svc, a.id, ["canceled", "error", "done"])
    expect(ja.state).toBe("canceled")
    // The next one runs after it.
    expect((await until(svc, c.id, ["done", "error"])).state).toBe("done")
  })

  it("cancel kills the whole process group (the background sleep too) and cleans the work dir", async () => {
    let pid = 0
    const spawn: SpawnFn = (cmd, args, opts) => {
      const ch = nodeSpawn(cmd, args, opts)
      pid = ch.pid ?? 0
      return ch
    }
    const { svc } = make({ spawn })
    const j = await svc.start(ana, null, input("slow"))
    await until(svc, j.id, ["running"])
    for (let i = 0; i < 100 && !svc.jobs(ana)[0].log.some((l) => l.includes("esperando")); i++) await new Promise((r) => setTimeout(r, 20))
    expect(svc.cancel(ana, null, j.id)).toBe(true)
    const done = await until(svc, j.id, ["canceled", "error"])
    expect(done).toMatchObject({ state: "canceled", error: "Descarga cancelada." })
    expect(pid).toBeGreaterThan(0)
    // No process of the group survives.
    let alive = true
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(-pid, 0)
        await new Promise((r) => setTimeout(r, 50))
      } catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
    await vi.waitFor(() => expect(fs.readdirSync(path.join(t.dir, "data", "descargas"))).toEqual([]), { timeout: 5000 })
    expect(audit.inputs.at(-1)).toMatchObject({ action: "files.export", detail: { result: "cancelado" } })
  })

  it("timeout: canceled with a clear message", async () => {
    const { svc } = make({ timeoutMs: 400 })
    const j = await until(svc, (await svc.start(ana, null, input("slow"))).id, ["error", "canceled", "done"])
    expect(j.state).toBe("error")
    expect(j.error).toMatch(/tiempo máximo/)
  })

  it("refuses a missing destination, the reserved work dir and an unavailable downloader", async () => {
    const { svc } = make()
    expect(await kindOf(svc.start(ana, null, input("app", { dir: "nope" })))).toBe("NOT_FOUND")
    expect(await kindOf(svc.start(ana, null, input("app", { dir: ".descargas" })))).toBe("NOT_FOUND")
    expect(await kindOf(svc.start(ana, null, input("app", { zipName: "a/b" })))).toBe("INVALID")
    const off = make({}, { enabled: false }).svc
    expect(await kindOf(off.start(ana, null, input("app")))).toBe("NOT_FOUND")
    expect((await off.info()).available).toBe(false)
    const missing = make({}, { script: path.join(t.dir, "no-existe.sh") }).svc
    expect(await missing.info()).toMatchObject({ available: false, problem: expect.stringMatching(/Falta el script/) })
    expect((await svc.info())).toMatchObject({
      available: true, problem: null, timeoutMin: 60, root: "extra", rootLabel: "Compartida",
      labels: { name: "Descargas", title: "Ejecutar script de descarga…", app: "Aplicación", version: "Versión", extract: "Opción -x" },
    })
    const none = make({}, { script: null }).svc
    expect(await none.info()).toMatchObject({ available: false, problem: expect.stringMatching(/No hay script de descarga configurado/) })
  })

  it("begin() removes work dirs left by a previous run; stop() cancels everything", async () => {
    fs.mkdirSync(path.join(extra, ".descargas", "viejo"), { recursive: true })
    fs.writeFileSync(path.join(extra, ".descargas", "viejo", "jf"), "x")
    const { svc } = make()
    await svc.begin()
    await vi.waitFor(() => expect(fs.readdirSync(path.join(t.dir, "data", "descargas"))).toEqual([]), { timeout: 5000 })
    const a = await svc.start(ana, null, input("slow"))
    const b = await svc.start(bea, null, input("app"))
    await until(svc, a.id, ["running"])
    await svc.stop()
    expect(svc.jobs(admin).map((x) => x.state).sort()).toEqual(["canceled", "canceled"])
    expect(await kindOf(svc.start(ana, null, input("app")))).toBe("UNAVAILABLE")
    expect(b.id).toBeTruthy()
  })

  it("the work dir is the service's own (data dir): a .descargas link planted in the shared folder changes nothing", async () => {
    const victim = path.join(t.dir, "datos")
    fs.mkdirSync(path.join(victim, "importante"), { recursive: true })
    fs.writeFileSync(path.join(victim, "importante", "db"), "x")
    fs.symlinkSync(victim, path.join(extra, ".descargas"))
    const { svc } = make()
    await svc.begin()
    const j = await until(svc, (await svc.start(ana, null, input("app"))).id, ["done", "error"])
    expect(j.state).toBe("done")
    expect(fs.readdirSync(victim)).toEqual(["importante"])
    expect(fs.readFileSync(path.join(victim, "importante", "db"), "utf8")).toBe("x")
  })

  it("drops the service's capabilities for the script (setpriv), and refuses to run without setpriv when it has some", async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const spy: SpawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args })
      // Run the real thing without setpriv (the test process has no capabilities to drop).
      const i = args.indexOf("--")
      return nodeSpawn(args[i + 1], args.slice(i + 2), opts)
    }
    const { svc } = make({ spawn: spy, dropCaps: () => ({ setpriv: "/usr/bin/setpriv", needed: true }) })
    const j = await until(svc, (await svc.start(ana, null, input("app"))).id, ["done", "error"])
    expect(j.state).toBe("done")
    expect(calls[0].cmd).toBe("/usr/bin/setpriv")
    expect(calls[0].args.slice(0, 3)).toEqual(["--inh-caps=-all", "--ambient-caps=-all", "--"])
    expect(calls[0].args[3]).toMatch(/bash$/)
    const none = make({ dropCaps: () => ({ setpriv: null, needed: true }) }).svc
    const k = await until(none, (await none.start(ana, null, input("app"))).id, ["done", "error"])
    expect(k).toMatchObject({ state: "error", error: expect.stringMatching(/setpriv/) })
  })

  it("redacts the password hardcoded in the script itself", () => {
    expect(scriptSecrets("x=1\nREPO_USR=downloader\nREPO_PSW=S3cr3t!x\n", "REPO_PSW")).toEqual(["S3cr3t!x"])
    expect(scriptSecrets('export REPO_PSW="otra clave"\n', "REPO_PSW")).toEqual(["otra clave"])
    expect(scriptSecrets('REPO_PSW="${REPO_PSW:-x}"\n', "REPO_PSW")).toEqual([])
    expect(scriptSecrets("REPO_PSW=S3cr3t!x\n", "EXPORT_PASSWORD")).toEqual([])
    // A script with the password written inside (like some project scripts): it never reaches the log.
    const script = path.join(t.dir, "descarga.sh")
    fs.writeFileSync(script, '#!/bin/bash\nEXPORT_USER="${EXPORT_USER:-usuario}"\nEXPORT_PASSWORD="${EXPORT_PASSWORD:-Clave-Escrita-1}"\nEXPORT_PASSWORD=Clave-Escrita-2\n')
    expect(scriptSecrets(fs.readFileSync(script, "utf8"), "EXPORT_PASSWORD")).toEqual(["Clave-Escrita-2"])
  })

  it("without the extract label (RM_EXPORT_EXTRACT_LABEL) the -x switch is never passed", async () => {
    const { svc } = make({}, { extractLabel: null })
    const j = await until(svc, (await svc.start(ana, null, input("app", { extract: true }))).id, ["done", "error"])
    expect(j.state).toBe("done")
    expect(j.extract).toBe(false)
    expect(j.log.join("\n")).not.toMatch(/ARG -x/)
  })
})
