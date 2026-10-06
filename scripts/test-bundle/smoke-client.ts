// Bundle smoke client (§11.5 step 6). Built by scripts/test-bundle.sh into dist/test/smoke-client.cjs (ws inlined) and
// run with the bundled node inside ubuntu:24.04 --network none:
//   node smoke-client.cjs http://127.0.0.1:3200 admin smoke-password-1
// Every POST sends Origin (the Origin gate refuses it otherwise); redirects are never followed.
// RM_SMOKE_SKIP=sse,… skips named checks (loudly), only while another stream's route is not merged yet.
// Archivos: uploads RM_SMOKE_FILE (default smoke-<pid>.bin, 1 MiB + 123 bytes) in two chunks, lists it, downloads it
// (whole and a Range) and prints "archivo=<name> sha256=<hex>" so the caller can check the file on disk. It is left
// in the folder. RM_SMOKE_FILES_EXPECT=<name>:<sha256> also downloads a file put there by other means and checks it.
// RM_SMOKE_SEND=<equipment>|<ssh port>|<file>: only «Enviar a equipo» (after the login): starts an equipment SSH server
// (ssh2 Server, inlined like ws) on 127.0.0.1:<ssh port>, sends <file> of the folder to <equipment> (whose Ethernet
// access points there) and checks it arrived, verified — the bundled server's ssh2 client, offline.
// RM_SMOKE_PROFILE=<dir>: the project profile the server runs with («-» = none, generic defaults), read here the way the
// app reads it (perfil.env, plantillas/*.json). Adds: the lab name on /login (RM_LAB_NAME, else «Relay Manager»;
// RM_SMOKE_LAB_NAME overrides it after a config import), every template of plantillas/ on /plantillas, the second
// folder of Archivos (root "extra": upload + list + download, prints "extra=<name> sha256=<hex>", or 404 when the
// profile has none) and the download script (GET /api/files/export available or not as the profile says; with
// RM_SMOKE_EXPORT_RUN=1 it is run, and "descarga=<zip> raiz=<root> sha256=<hex>" printed).
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseEnv } from "node:util"
import WebSocket from "ws"
import { createFakeSshServer } from "../sim/fake-ssh-server.mjs"

const [base = "http://127.0.0.1:3200", username = "admin", password = "smoke-password-1"] = process.argv.slice(2)
const skip = new Set((process.env.RM_SMOKE_SKIP ?? "").split(",").map((s) => s.trim()).filter(Boolean))

/** The profile under test: perfil.env values and the names of the valid-looking templates (as the app lists them). */
interface Profile { dir: string | null; env: Record<string, string>; templates: string[] }
function readProfile(): Profile | null {
  const dir = process.env.RM_SMOKE_PROFILE
  if (!dir) return null
  if (dir === "-") return { dir: null, env: {}, templates: [] }
  let env: Record<string, string> = {}
  try {
    env = Object.fromEntries(Object.entries(parseEnv(fs.readFileSync(path.join(dir, "perfil.env"), "utf8"))).filter((e): e is [string, string] => typeof e[1] === "string"))
  } catch {
    /* no perfil.env: generic values */
  }
  const templates: string[] = []
  const tdir = path.join(dir, "plantillas")
  for (const f of fs.existsSync(tdir) ? fs.readdirSync(tdir).sort() : []) {
    if (!f.endsWith(".json") || f.startsWith(".") || f.startsWith("_")) continue
    try {
      const t = JSON.parse(fs.readFileSync(path.join(tdir, f), "utf8")) as { name?: unknown }
      if (typeof t.name === "string") templates.push(t.name)
    } catch {
      /* invalid: «plantillas comprobar» reports it */
    }
  }
  return { dir, env, templates }
}
const profile = readProfile()
const on = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v !== "false"
/** React escapes these in text nodes. */
const htmlText = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;")
const inHtml = (html: string, t: string) => html.includes(t) || html.includes(htmlText(t))

let failures = 0
function pass(name: string, detail: string): void {
  console.log(`[ OK ] ${name}: ${detail}`)
}
function fail(name: string, detail: string): void {
  failures++
  console.log(`[FALLO] ${name}: ${detail}`)
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Cookie jar: the last Set-Cookie for a name wins. */
const jar = new Map<string, string>()
function keep(res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(";")[0] ?? ""
    const i = kv.indexOf("=")
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1))
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  if (skip.has(name)) {
    console.log(`[OMITIDA] ${name}: RM_SMOKE_SKIP`)
    return
  }
  try {
    pass(name, await fn())
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err))
  }
}

function wsClose(path: string, opts: { cookie: boolean; origin: boolean }): Promise<{ code: number | null; status: number | null }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {}
    if (opts.cookie) headers.cookie = cookieHeader()
    if (opts.origin) headers.origin = base
    const ws = new WebSocket(base.replace(/^http/, "ws") + path, { headers })
    const timer = setTimeout(() => { ws.terminate(); resolve({ code: null, status: null }) }, 10_000)
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer)
      resolve({ code: null, status: res.statusCode ?? null })
      ws.terminate()
    })
    ws.on("close", (code) => { clearTimeout(timer); resolve({ code, status: 101 }) })
    ws.on("error", () => { /* reported through close or unexpected-response */ })
  })
}

async function main(): Promise<void> {
  console.log(`Prueba del paquete contra ${base}`)

  await check("login", async () => {
    const until = Date.now() + 15_000
    let last = ""
    for (;;) {
      const res = await fetch(`${base}/login`, { redirect: "manual" })
      const body = await res.text()
      last = `${res.status} ${res.headers.get("location") ?? ""}`.trim()
      if (res.status === 200 && !res.headers.get("location")) {
        const lab = process.env.RM_SMOKE_LAB_NAME || profile?.env.RM_LAB_NAME || "Relay Manager"
        if (!inHtml(body, lab)) throw new Error(`la página de acceso no contiene «${lab}»`)
        return `GET /login 200 sin Location, contiene «${lab}»`
      }
      if (Date.now() > until) throw new Error(`GET /login sigue respondiendo ${last} tras 15 s`)
      await sleep(500)
    }
  })

  await check("credentials", async () => {
    const csrfRes = await fetch(`${base}/api/auth/csrf`, { redirect: "manual" })
    keep(csrfRes)
    const { csrfToken } = (await csrfRes.json()) as { csrfToken?: string }
    if (!csrfToken) throw new Error("sin csrfToken")
    const res = await fetch(`${base}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: base, cookie: cookieHeader(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, username, password, callbackUrl: `${base}/` }).toString(),
    })
    keep(res)
    const session = [...jar.keys()].find((k) => /(^|\.)authjs\.session-token$/.test(k) || k.startsWith("__Secure-authjs.session-token"))
    if (!session) throw new Error(`sin cookie de sesión (estado ${res.status}, Location ${res.headers.get("location") ?? "-"})`)
    return `sesión iniciada (${res.status}, cookie ${session})`
  })

  // «Copiar a una carpeta del servidor»: RM_SMOKE_COPY='{"file":…,"dest":…,"asRoot":…,"password":…,"conflict":…,
  // "expectStatus":403,"expectMessage":"regex"}'. Prints the root helper's status and, for a copy that must work,
  // "copia=<estado> sha256=<hex> final=<ruta>" so the caller checks owner, mode and contents on disk.
  // RM_SMOKE_STEPS: a JSON array of API steps run in ONE login session (the elevation of «como administrador» belongs to
  // the session): {name, method?, path, body?, status?, message?, match?, noMatch?, save?: {var: "a.0.b"}} or a wait
  // {name, wait: "copy" | "export", id: "${var}", state?: "done"}. "${var}" in path/body is replaced by a saved value.
  // Each step prints "PASO <name> <status> <json>" (json cut at 4000 characters) for the shell to grep.
  const stepsSpec = process.env.RM_SMOKE_STEPS
  if (stepsSpec) {
    await check("steps", async () => {
      type Step = {
        name: string; method?: string; path?: string; body?: unknown; status?: number | number[]; message?: string; match?: string | string[]; noMatch?: string | string[]
        save?: Record<string, string>; wait?: "copy" | "export"; id?: string; state?: string
      }
      const steps = JSON.parse(stepsSpec) as Step[]
      const vars = new Map<string, string>()
      const subst = (t: string) => t.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, k: string) => {
        const v = vars.get(k)
        if (v === undefined) throw new Error(`variable sin valor: ${k}`)
        return v
      })
      const pick = (o: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o)
      const h = { cookie: cookieHeader(), origin: base, "content-type": "application/json" }
      for (const st of steps) {
        if (st.wait) {
          const id = subst(st.id ?? "")
          const url = st.wait === "copy" ? `${base}/api/files/copy` : `${base}/api/files/export`
          let job: { id: string; state: string } & Record<string, unknown> = { id, state: "?" }
          for (let i = 0; i < 1200; i++) {
            const r = await fetch(url, { headers: h })
            const found = ((await r.json()) as { jobs?: Array<{ id: string; state: string } & Record<string, unknown>> }).jobs?.find((j) => j.id === id)
            if (found) job = found
            if (["done", "skipped", "error", "canceled"].includes(job.state)) break
            await sleep(100)
          }
          console.log(`PASO ${st.name} ${job.state} ${JSON.stringify(job).slice(0, 4000)}`)
          if (job.state !== (st.state ?? "done")) throw new Error(`${st.name}: ${st.wait} ${id} → ${job.state} (se esperaba ${st.state ?? "done"}): ${JSON.stringify(job).slice(0, 1500)}`)
          continue
        }
        const method = st.method ?? "GET"
        const res = await fetch(`${base}${subst(st.path ?? "/")}`, {
          method, headers: h, redirect: "manual",
          ...(st.body !== undefined ? { body: subst(JSON.stringify(st.body)) } : {}),
        })
        const text = await res.text()
        let json: unknown = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = { raw: text.slice(0, 200) }
        }
        const flat = JSON.stringify(json)
        console.log(`PASO ${st.name} ${res.status} ${flat.slice(0, 4000)}`)
        const want = ([] as number[]).concat(st.status ?? 200)
        if (!want.includes(res.status)) throw new Error(`${st.name}: ${method} ${st.path} → ${res.status} (se esperaba ${want.join(" o ")}): ${flat.slice(0, 1500)}`)
        const msg = (json as { message?: string } | null)?.message ?? ""
        if (st.message && !new RegExp(st.message).test(msg)) throw new Error(`${st.name}: mensaje «${msg}» no coincide con /${st.message}/`)
        for (const m of ([] as string[]).concat(st.match ?? [])) {
          if (!new RegExp(subst(m)).test(flat)) throw new Error(`${st.name}: la respuesta no contiene /${m}/: ${flat.slice(0, 1500)}`)
        }
        for (const m of ([] as string[]).concat(st.noMatch ?? [])) {
          if (new RegExp(subst(m)).test(flat)) throw new Error(`${st.name}: la respuesta contiene /${m}/: ${flat.slice(0, 1500)}`)
        }
        for (const [k, dotted] of Object.entries(st.save ?? {})) {
          const v = pick(json, dotted)
          if (v === undefined || v === null) throw new Error(`${st.name}: no hay ${dotted} en la respuesta`)
          vars.set(k, String(v))
        }
      }
      return `${steps.length} pasos en una sola sesión`
    })
    console.log(failures ? `${failures} comprobación(es) fallida(s)` : "Todas las comprobaciones han pasado")
    process.exit(failures ? 1 : 0)
  }

  const copySpec = process.env.RM_SMOKE_COPY
  if (copySpec) {
    await check("copy", async () => {
      const o = JSON.parse(copySpec) as { file: string; dest: string; asRoot: boolean; password?: string | null; conflict?: string; expectStatus?: number; expectMessage?: string; root?: string }
      const h = { cookie: cookieHeader(), origin: base, "content-type": "application/json" }
      const ir = await fetch(`${base}/api/files/copy/info`, { headers: h })
      const info = (await ir.json()) as { root?: { available: boolean; user: string | null; problem: string | null; writePaths: string[] } }
      if (ir.status !== 200 || !info.root) throw new Error(`GET /api/files/copy/info → ${ir.status} ${JSON.stringify(info)}`)
      console.log(`root=${info.root.available ? "disponible" : "no"} usuario=${info.root.user ?? "-"} rutas=${info.root.writePaths.join(",")} problema=${info.root.problem ?? "-"}`)
      const st = await fetch(`${base}/api/files/copy`, {
        method: "POST", headers: h,
        body: JSON.stringify({ ...(o.root ? { root: o.root } : {}), paths: [o.file], destDir: o.dest, conflict: o.conflict ?? "keep", asRoot: o.asRoot, password: o.password ?? null }),
      })
      const sb = (await st.json()) as { jobs?: Array<{ id: string }>; message?: string; needsRoot?: boolean; field?: string }
      if (o.expectStatus) {
        if (st.status !== o.expectStatus || (o.expectMessage && !new RegExp(o.expectMessage).test(sb.message ?? ""))) {
          throw new Error(`POST /api/files/copy → ${st.status} ${JSON.stringify(sb)} (se esperaba ${o.expectStatus} /${o.expectMessage ?? ""}/)`)
        }
        console.log(`respuesta=${st.status} mensaje=${sb.message ?? ""}${sb.needsRoot ? " needsRoot" : ""}`)
        return `→ ${st.status}: ${sb.message ?? ""}`
      }
      if (st.status !== 202 || !sb.jobs?.[0]) throw new Error(`POST /api/files/copy → ${st.status} ${sb.message ?? ""}`)
      type Job = { id: string; state: string; sha256: string | null; finalName: string | null; destDir: string; asRoot: boolean; rootUser: string | null; error: string | null }
      let job: Job | undefined
      for (let i = 0; i < 600; i++) {
        const r = await fetch(`${base}/api/files/copy`, { headers: h })
        job = ((await r.json()) as { jobs?: Job[] }).jobs?.find((j) => j.id === sb.jobs?.[0]?.id)
        if (job && ["done", "skipped", "error", "canceled"].includes(job.state)) break
        await sleep(100)
      }
      if (job?.state !== "done") throw new Error(`copia: ${JSON.stringify(job)}`)
      console.log(`copia=${job.state} sha256=${job.sha256} final=${job.destDir}/${job.finalName} root=${job.asRoot} usuario=${job.rootUser ?? "-"}`)
      return `${o.file} → ${job.destDir}/${job.finalName}${job.asRoot ? ` como administrador (${job.rootUser})` : ""}, verificado`
    })
    console.log(failures ? `${failures} comprobación(es) fallida(s)` : "Todas las comprobaciones han pasado")
    process.exit(failures ? 1 : 0)
  }

  const sendSpec = process.env.RM_SMOKE_SEND
  if (sendSpec) {
    await check("send", async () => {
      const [eqName = "", portText = "", file = ""] = sendSpec.split("|")
      const home = fs.mkdtempSync("/tmp/equipo-ssh-")
      const ssh = await createFakeSshServer({ host: "127.0.0.1", port: Number(portText), home })
      try {
        const h = { cookie: cookieHeader(), origin: base }
        const tr = await fetch(`${base}/api/files/send/targets`, { headers: h })
        const { targets = [] } = (await tr.json()) as { targets?: Array<{ equipmentId: string; equipmentName: string; allowed: boolean; blockedReason: string | null }> }
        const tg = targets.find((x) => x.equipmentName === eqName)
        if (tr.status !== 200 || !tg?.allowed) throw new Error(`GET /api/files/send/targets → ${tr.status} ${JSON.stringify(targets)}`)
        const st = await fetch(`${base}/api/files/send`, {
          method: "POST", headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ paths: [file], equipmentId: tg.equipmentId, username: "root", password: "root", destPath: "~", remember: true }),
        })
        const sb = (await st.json()) as { jobs?: Array<{ id: string }>; message?: string }
        if (st.status !== 202 || !sb.jobs?.[0]) throw new Error(`POST /api/files/send → ${st.status} ${sb.message ?? ""}`)
        let job: { state: string; verification: string | null; protocol: string | null; error: string | null; dest: string } | undefined
        for (let i = 0; i < 200; i++) {
          const r = await fetch(`${base}/api/files/send`, { headers: h })
          job = ((await r.json()) as { jobs?: Array<{ id: string; state: string; verification: string | null; protocol: string | null; error: string | null; dest: string }> }).jobs?.find((j) => j.id === sb.jobs?.[0]?.id)
          if (job && ["done", "error", "canceled"].includes(job.state)) break
          await sleep(100)
        }
        if (job?.state !== "done" || job.verification !== "verified") throw new Error(`envío: ${JSON.stringify(job)}`)
        const dl = await fetch(`${base}/api/files/download?path=${encodeURIComponent(file)}`, { headers: { cookie: cookieHeader() } })
        const want = crypto.createHash("sha256").update(Buffer.from(await dl.arrayBuffer())).digest("hex")
        const got = crypto.createHash("sha256").update(fs.readFileSync(path.join(home, file))).digest("hex")
        if (got !== want) throw new Error("el archivo en el equipo simulado no coincide")
        return `${file} → ${eqName} por ${job.protocol} (${job.dest}), verificado; sha256 igual`
      } finally {
        await ssh.close()
      }
    })
    console.log(failures ? `${failures} comprobación(es) fallida(s)` : "Todas las comprobaciones han pasado")
    process.exit(failures ? 1 : 0)
  }

  await check("origin-gate", async () => {
    const res = await fetch(`${base}/api/auth/signout`, {
      method: "POST", redirect: "manual",
      headers: { cookie: cookieHeader(), "content-type": "application/x-www-form-urlencoded" }, body: "",
    })
    const body = await res.text()
    if (res.status !== 403 || !body.includes("FORBIDDEN_ORIGIN")) throw new Error(`POST sin Origin → ${res.status} ${body.slice(0, 80)}`)
    return "POST sin Origin → 403 FORBIDDEN_ORIGIN"
  })

  await check("home", async () => {
    const res = await fetch(`${base}/`, { redirect: "manual", headers: { cookie: cookieHeader() } })
    if (res.status !== 200) throw new Error(`GET / → ${res.status} ${res.headers.get("location") ?? ""}`)
    return "GET / 200"
  })

  await check("sse", async () => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 10_000)
    try {
      const res = await fetch(`${base}/api/events`, { headers: { cookie: cookieHeader(), accept: "text/event-stream" }, signal: ac.signal })
      if (res.status !== 200 || !res.body) throw new Error(`GET /api/events → ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) throw new Error("el flujo terminó sin «hello»")
        buf += dec.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          let event: { type?: string; serverNow?: string }
          try {
            event = JSON.parse(line.slice(5).trim()) as { type?: string; serverNow?: string }
          } catch {
            continue
          }
          if (event.type !== "hello") continue
          if (!event.serverNow || Number.isNaN(Date.parse(event.serverNow))) throw new Error(`«hello» sin serverNow: ${line}`)
          ac.abort()
          return `«hello» con serverNow ${event.serverNow}`
        }
      }
    } finally {
      clearTimeout(timer)
    }
  })

  await check("ws-4004", async () => {
    const r = await wsClose("/ws/console/doesnotexist", { cookie: true, origin: true })
    if (r.code !== 4004) throw new Error(`cierre ${r.code ?? "-"} (HTTP ${r.status ?? "-"}), se esperaba 4004`)
    return "WS con sesión y Origin → cierre 4004"
  })

  await check("ws-origin", async () => {
    const r = await wsClose("/ws/console/doesnotexist", { cookie: true, origin: false })
    if (r.status !== 403) throw new Error(`HTTP ${r.status ?? "-"} (cierre ${r.code ?? "-"}), se esperaba 403`)
    return "WS sin Origin → HTTP 403"
  })

  await check("files", async () => {
    const name = process.env.RM_SMOKE_FILE || `smoke-${process.pid}.bin`
    const data = Buffer.alloc(1024 * 1024 + 123)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff
    const sha = crypto.createHash("sha256").update(data).digest("hex")
    const h = { cookie: cookieHeader(), origin: base }
    const start = await fetch(`${base}/api/files/upload`, {
      method: "POST", redirect: "manual", headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ dir: "", name, size: data.length, conflict: "overwrite" }),
    })
    const s = (await start.json()) as { id?: string; message?: string }
    if (start.status !== 201 || !s.id) throw new Error(`POST /api/files/upload → ${start.status} ${s.message ?? ""}`)
    const half = 512 * 1024
    for (const [offset, part] of [[0, data.subarray(0, half)], [half, data.subarray(half)]] as const) {
      const r = await fetch(`${base}/api/files/upload/${s.id}?offset=${offset}`, { method: "PUT", headers: { ...h, "content-type": "application/octet-stream" }, body: part })
      const b = (await r.json()) as { received?: number; done?: boolean; message?: string }
      if (r.status !== 200) throw new Error(`PUT offset ${offset} → ${r.status} ${b.message ?? ""}`)
      if (offset === half && (!b.done || b.received !== data.length)) throw new Error(`la subida no se completó: ${JSON.stringify(b)}`)
    }
    const list = await fetch(`${base}/api/files/list?path=`, { headers: { cookie: cookieHeader() } })
    const l = (await list.json()) as { entries?: Array<{ name: string; size: number | null }>; disk?: { freeBytes: number } | null }
    const entry = l.entries?.find((e) => e.name === name)
    if (list.status !== 200 || entry?.size !== data.length) throw new Error(`el listado no tiene ${name} con ${data.length} bytes (${list.status})`)
    const dl = await fetch(`${base}/api/files/download?path=${encodeURIComponent(name)}`, { headers: { cookie: cookieHeader() } })
    const got = Buffer.from(await dl.arrayBuffer())
    if (dl.status !== 200 || crypto.createHash("sha256").update(got).digest("hex") !== sha) throw new Error(`la descarga no coincide (${dl.status}, ${got.length} bytes)`)
    const part = await fetch(`${base}/api/files/download?path=${encodeURIComponent(name)}`, { headers: { cookie: cookieHeader(), range: "bytes=1000-1999" } })
    const pb = Buffer.from(await part.arrayBuffer())
    if (part.status !== 206 || !pb.equals(data.subarray(1000, 2000))) throw new Error(`Range → ${part.status}, ${pb.length} bytes`)
    const anon = await fetch(`${base}/api/files/list?path=`)
    if (anon.status !== 401) throw new Error(`sin sesión → ${anon.status} (se esperaba 401)`)
    const escape = await fetch(`${base}/api/files/download?path=..%2F..%2Fetc%2Fpasswd`, { headers: { cookie: cookieHeader() } })
    if (escape.status !== 400) throw new Error(`ruta con .. → ${escape.status} (se esperaba 400)`)
    let extra = ""
    const expect = process.env.RM_SMOKE_FILES_EXPECT
    if (expect) {
      const i = expect.lastIndexOf(":")
      const [ename, esha] = [expect.slice(0, i), expect.slice(i + 1)]
      const r = await fetch(`${base}/api/files/download?path=${encodeURIComponent(ename)}`, { headers: { cookie: cookieHeader() } })
      const b = Buffer.from(await r.arrayBuffer())
      if (r.status !== 200 || crypto.createHash("sha256").update(b).digest("hex") !== esha) throw new Error(`${ename} (copiado a mano) → ${r.status}, sha distinto`)
      extra = `; ${ename} (copiado a mano) descargado`
    }
    return `subido en 2 fragmentos, listado, descargado (entero y Range) y comparado; archivo=${name} sha256=${sha}${extra}`
  })

  if (profile) {
    const env = profile.env
    const h = { cookie: cookieHeader(), origin: base }

    await check("perfil-plantillas", async () => {
      const res = await fetch(`${base}/plantillas`, { redirect: "manual", headers: { cookie: cookieHeader() } })
      const html = await res.text()
      if (res.status !== 200) throw new Error(`GET /plantillas → ${res.status}`)
      const missing = profile.templates.filter((n) => !inHtml(html, n))
      if (missing.length) throw new Error(`/plantillas no muestra ${missing.map((n) => `«${n}»`).join(", ")} (del perfil ${profile.dir})`)
      return profile.dir ? `${profile.templates.length} plantillas del perfil en /plantillas: ${profile.templates.join(", ") || "-"}` : "sin perfil: /plantillas responde"
    })

    const extraOn = on(env.RM_FILES_EXTRA_NAME) && env.RM_FILES_EXTRA_ENABLED !== "0" && env.RM_FILES_EXTRA_ENABLED !== "false"
    await check("perfil-extra", async () => {
      if (!extraOn) {
        const r = await fetch(`${base}/api/files/list?root=extra&path=`, { headers: { cookie: cookieHeader() } })
        if (r.status !== 404 && r.status !== 400) throw new Error(`sin segunda carpeta en el perfil, GET ?root=extra → ${r.status} (se esperaba 404)`)
        return `sin segunda carpeta (root=extra → ${r.status})`
      }
      const name = `smoke-extra-${process.pid}.txt`
      const data = Buffer.from(`segunda carpeta (${env.RM_FILES_EXTRA_NAME})\n`)
      const sha = crypto.createHash("sha256").update(data).digest("hex")
      const start = await fetch(`${base}/api/files/upload`, {
        method: "POST", headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ root: "extra", dir: "", name, size: data.length, conflict: "overwrite" }),
      })
      const s = (await start.json()) as { id?: string; message?: string }
      if (start.status !== 201 || !s.id) throw new Error(`POST /api/files/upload (extra) → ${start.status} ${s.message ?? ""}`)
      const put = await fetch(`${base}/api/files/upload/${s.id}?offset=0`, { method: "PUT", headers: { ...h, "content-type": "application/octet-stream" }, body: data })
      if (put.status !== 200) throw new Error(`PUT (extra) → ${put.status}`)
      const l = (await (await fetch(`${base}/api/files/list?root=extra&path=`, { headers: { cookie: cookieHeader() } })).json()) as { root?: string; entries?: Array<{ name: string }> }
      if (l.root !== "extra" || !l.entries?.some((e) => e.name === name)) throw new Error(`el listado de extra no tiene ${name}: ${JSON.stringify(l).slice(0, 300)}`)
      const t = (await (await fetch(`${base}/api/files/list?path=`, { headers: { cookie: cookieHeader() } })).json()) as { entries?: Array<{ name: string }> }
      if (t.entries?.some((e) => e.name === name)) throw new Error(`${name} aparece también en tftp`)
      const dl = await fetch(`${base}/api/files/download?root=extra&path=${encodeURIComponent(name)}`, { headers: { cookie: cookieHeader() } })
      if (dl.status !== 200 || crypto.createHash("sha256").update(Buffer.from(await dl.arrayBuffer())).digest("hex") !== sha) throw new Error("la descarga de extra no coincide")
      const page = await (await fetch(`${base}/archivos`, { headers: { cookie: cookieHeader() } })).text()
      if (!inHtml(page, env.RM_FILES_EXTRA_NAME ?? "")) throw new Error(`/archivos no muestra «${env.RM_FILES_EXTRA_NAME}»`)
      console.log(`extra=${name} sha256=${sha}`)
      return `«${env.RM_FILES_EXTRA_NAME}» (root=extra): subida, listado aparte de tftp, descarga; extra=${name} sha256=${sha}`
    })

    await check("perfil-descargas", async () => {
      const r = await fetch(`${base}/api/files/export`, { headers: { cookie: cookieHeader() } })
      type Info = { available?: boolean; problem?: string | null; missingTools?: string[] }
      const got = (await r.json().catch(() => ({}))) as Info & { info?: Info }
      const info: Info = got.info ?? got
      if (!on(env.RM_EXPORT_ENABLED)) {
        if (r.status === 200 && info.available) throw new Error("el perfil no activa el script de descarga y la API lo ofrece")
        return `sin script de descarga (${r.status}${info.problem ? `: ${info.problem}` : ""})`
      }
      if (r.status !== 200 || !info.available) throw new Error(`GET /api/files/export → ${r.status} ${JSON.stringify(info)}`)
      const tools = info.missingTools?.length ? `; faltan en el servidor: ${info.missingTools.join(", ")}` : ""
      if (process.env.RM_SMOKE_EXPORT_RUN !== "1") return `script del perfil disponible (${env.RM_EXPORT_DOWNLOADER ?? "?"})${tools}; no se ejecuta`
      const root = env.RM_EXPORT_ROOT || (extraOn ? "extra" : "tftp")
      const st = await fetch(`${base}/api/files/export`, {
        method: "POST", headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ app: "demo_app", version: "1.2.3", extract: false, zipName: null, dir: "" }),
      })
      const sb = (await st.json()) as { job?: { id: string }; message?: string }
      if (st.status !== 202 || !sb.job) throw new Error(`POST /api/files/export → ${st.status} ${sb.message ?? ""}`)
      type Job = { id: string; state: string; error: string | null; finalPath?: string | null; finalName?: string | null }
      let job: Job | undefined
      for (let i = 0; i < 1200; i++) {
        const jr = await fetch(`${base}/api/files/export`, { headers: { cookie: cookieHeader() } })
        job = ((await jr.json()) as { jobs?: Job[] }).jobs?.find((j) => j.id === sb.job?.id)
        if (job && ["done", "error", "canceled"].includes(job.state)) break
        await sleep(100)
      }
      if (job?.state !== "done") throw new Error(`descarga: ${JSON.stringify(job)}`)
      const zip = job.finalPath ?? job.finalName ?? "demo_app-1.2.3_exports.zip"
      const dl = await fetch(`${base}/api/files/download?root=${root}&path=${encodeURIComponent(zip)}`, { headers: { cookie: cookieHeader() } })
      const body = Buffer.from(await dl.arrayBuffer())
      if (dl.status !== 200 || body.subarray(0, 2).toString("latin1") !== "PK") throw new Error(`el zip no está en ${root} (${dl.status}, ${body.length} bytes)`)
      const sha = crypto.createHash("sha256").update(body).digest("hex")
      console.log(`descarga=${zip} raiz=${root} sha256=${sha}`)
      return `script del perfil ejecutado: ${zip} en ${root} (${body.length} bytes)${tools}`
    })
  }

  await check("health", async () => {
    const res = await fetch(`${base}/api/health`)
    const body = (await res.json()) as Record<string, unknown>
    if (res.status !== 200 || body.ok !== true) throw new Error(`GET /api/health → ${res.status} ${JSON.stringify(body)}`)
    if ("setupRequired" in body) throw new Error("/api/health expone setupRequired")
    return `/api/health ${JSON.stringify(body)}`
  })

  console.log(failures ? `${failures} comprobación(es) fallida(s)` : "Todas las comprobaciones han pasado")
  process.exit(failures ? 1 : 0)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
