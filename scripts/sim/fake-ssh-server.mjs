#!/usr/bin/env node
// Fake SSH server of an equipment (ssh2 Server, pure JavaScript) for «Archivos › Enviar a equipo» tests: password
// (and keyboard-interactive) login, the SFTP subsystem on the real file system (optional: --no-sftp behaves like
// dropbear without sftp-server), and exec: `scp -t <dir>` is emulated here (the sink side of the scp protocol), any
// other command runs with `sh -c` in the home folder (HOME set), like a login shell would.
//
//   node scripts/sim/fake-ssh-server.mjs [--host 127.0.0.1] [--port 2222] [--home DIR] [--user root] [--password root]
//                                        [--no-sftp] [--no-scp] [--no-checksum] [--write-delay MS] [--name eq2]
//
// --write-delay: every SFTP write / scp chunk (32 KiB) waits that long, a slow link (the manuals use it to show a send
// in progress).
// Test knobs (in process): writeDelayMs (slow link: every SFTP write / scp chunk waits), diskFullAfter (bytes: then
// ENOSPC, and df says so), reportFree (bytes df reports), noExec (an SFTP-only account), hostKey (PEM, to present the same or another key).
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import ssh2 from "ssh2"

const { Server, utils } = ssh2
const { STATUS_CODE } = utils.sftp

export function generateHostKey() {
  return utils.generateKeyPairSync("ed25519").private
}

/** One shell word as written by the bench ('…' with '\'' for quotes, or a plain word). */
export function parseShellWords(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    let w = ""
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i]
      if (c === "'") {
        const j = s.indexOf("'", i + 1)
        if (j < 0) throw new Error("comilla sin cerrar")
        w += s.slice(i + 1, j)
        i = j + 1
      } else if (c === "\\" && i + 1 < s.length) {
        w += s[i + 1]
        i += 2
      } else {
        w += c
        i++
      }
    }
    out.push(w)
  }
  return out
}

function statusOf(err) {
  const code = err?.code ?? ""
  if (code === "ENOENT" || code === "ENOTDIR") return STATUS_CODE.NO_SUCH_FILE
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return STATUS_CODE.PERMISSION_DENIED
  return STATUS_CODE.FAILURE
}

function attrsOf(st) {
  return { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {object} o
 * @param {string} [o.host] @param {number} [o.port] @param {string} o.home
 * @param {Record<string,string>} [o.users] @param {boolean} [o.sftp] @param {boolean} [o.scp] @param {boolean} [o.checksum]
 * @param {boolean} [o.noExec] @param {number} [o.writeDelayMs] @param {number|null} [o.diskFullAfter] @param {string} [o.hostKey]
 */
export async function createFakeSshServer(o) {
  const opts = { host: "127.0.0.1", port: 0, users: { root: "root" }, sftp: true, scp: true, checksum: true, noExec: false, writeDelayMs: 0, diskFullAfter: null, reportFree: null, ...o }
  const hostKey = opts.hostKey ?? generateHostKey()
  const logins = []
  const commands = []
  const home = path.resolve(opts.home)
  fs.mkdirSync(home, { recursive: true })
  let written = 0
  const tooFull = (n) => opts.diskFullAfter !== null && written + n > opts.diskFullAfter
  const clients = new Set()

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client)
    client.on("close", () => clients.delete(client))
    client.on("error", () => {})
    let user = null
    client.on("authentication", (ctx) => {
      const want = opts.users[ctx.username]
      if (ctx.method === "password") {
        if (want !== undefined && ctx.password === want) {
          user = ctx.username
          logins.push({ user: ctx.username, ok: true, method: "password" })
          return ctx.accept()
        }
        logins.push({ user: ctx.username, ok: false, method: "password" })
        return ctx.reject(["password"])
      }
      return ctx.reject(["password"])
    })
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession()
        session.on("sftp", (accept, reject) => {
          if (!opts.sftp) return reject()
          serveSftp(accept())
        })
        session.on("exec", (accept, reject, info) => {
          if (opts.noExec) return reject()
          commands.push(info.command)
          runExec(accept(), info.command, user)
        })
      })
    })
  })

  function serveSftp(sftp) {
    const handles = new Map()
    let next = 1
    const handleOf = (buf) => (buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined)
    const fail = (reqid, err) => sftp.status(reqid, statusOf(err), err?.message)
    sftp.on("OPEN", (reqid, filename, flags, attrs) => {
      try {
        const fd = fs.openSync(filename, utils.sftp.flagsToString(flags) ?? "r", attrs?.mode ?? 0o644)
        const id = next++
        handles.set(id, { fd, path: filename })
        const h = Buffer.alloc(4)
        h.writeUInt32BE(id, 0)
        sftp.handle(reqid, h)
      } catch (e) { fail(reqid, e) }
    })
    // Requests are answered in order, one at a time (like OpenSSH's sftp-server).
    let queue = Promise.resolve()
    sftp.on("WRITE", (reqid, handle, offset, data) => {
      queue = queue.then(async () => {
        const h = handleOf(handle)
        if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE)
        if (opts.writeDelayMs) await sleep(opts.writeDelayMs)
        if (tooFull(data.length)) return sftp.status(reqid, STATUS_CODE.FAILURE, "Failure")
        try {
          fs.writeSync(h.fd, data, 0, data.length, offset)
          written += data.length
          sftp.status(reqid, STATUS_CODE.OK)
        } catch (e) { fail(reqid, e) }
      })
    })
    sftp.on("READ", (reqid, handle, offset, length) => {
      const h = handleOf(handle)
      if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE)
      const buf = Buffer.alloc(length)
      fs.read(h.fd, buf, 0, length, offset, (err, n) => {
        if (err) return fail(reqid, err)
        if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF)
        sftp.data(reqid, buf.subarray(0, n))
      })
    })
    sftp.on("CLOSE", (reqid, handle) => {
      const id = handle.length === 4 ? handle.readUInt32BE(0) : -1
      const h = handles.get(id)
      if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE)
      handles.delete(id)
      fs.close(h.fd, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)))
    })
    sftp.on("FSTAT", (reqid, handle) => {
      const h = handleOf(handle)
      if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE)
      fs.fstat(h.fd, (err, st) => (err ? fail(reqid, err) : sftp.attrs(reqid, attrsOf(st))))
    })
    sftp.on("FSETSTAT", (reqid, handle, attrs) => {
      const h = handleOf(handle)
      if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE)
      try {
        if (attrs.mode !== undefined) fs.fchmodSync(h.fd, attrs.mode & 0o7777)
        sftp.status(reqid, STATUS_CODE.OK)
      } catch (e) { fail(reqid, e) }
    })
    sftp.on("SETSTAT", (reqid, p, attrs) => {
      try {
        if (attrs.mode !== undefined) fs.chmodSync(p, attrs.mode & 0o7777)
        sftp.status(reqid, STATUS_CODE.OK)
      } catch (e) { fail(reqid, e) }
    })
    for (const ev of ["STAT", "LSTAT"]) {
      sftp.on(ev, (reqid, p) => {
        const f = ev === "STAT" ? fs.stat : fs.lstat
        f(p, (err, st) => (err ? fail(reqid, err) : sftp.attrs(reqid, attrsOf(st))))
      })
    }
    sftp.on("REALPATH", (reqid, p) => {
      const abs = p === "." || p === "" ? home : path.resolve(home, p)
      sftp.name(reqid, [{ filename: abs, longname: abs, attrs: {} }])
    })
    sftp.on("RENAME", (reqid, from, to) => {
      // SFTP v3: a rename never replaces an existing target.
      if (fs.existsSync(to)) return sftp.status(reqid, STATUS_CODE.FAILURE, "Failure")
      fs.rename(from, to, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)))
    })
    sftp.on("REMOVE", (reqid, p) => fs.unlink(p, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK))))
  }

  /** The sink side of the scp protocol (what `scp -t <dir>` does on the equipment). */
  function scpSink(ch, dir) {
    let buf = Buffer.alloc(0)
    let state = "header"
    let file = null
    let left = 0
    let failed = null
    const ok = () => ch.write(Buffer.from([0]))
    const err = (msg, fatal = false) => ch.write(Buffer.concat([Buffer.from([fatal ? 2 : 1]), Buffer.from(`scp: ${msg}\n`)]))
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      err(`${dir}: No such file or directory`, true)
      ch.exit(1)
      ch.end()
      return
    }
    ok()
    let busy = Promise.resolve()
    const onData = async (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (state === "header") {
          const nl = buf.indexOf(0x0a)
          if (nl < 0) return
          const line = buf.subarray(0, nl).toString("utf8")
          buf = buf.subarray(nl + 1)
          const m = /^C([0-7]{4}) (\d+) (.+)$/.exec(line)
          if (!m) { err(`protocol error: ${line}`, true); ch.exit(1); ch.end(); return }
          left = Number(m[2])
          const target = path.join(dir, m[3])
          failed = null
          try {
            file = fs.openSync(target, "w", parseInt(m[1], 8))
          } catch (e) {
            // Like OpenSSH: the error goes back at once and the source does not send the data.
            err(`${target}: ${e.code === "EACCES" ? "Permission denied" : e.message}`)
            continue
          }
          state = "data"
          ok()
        } else if (state === "data") {
          if (!buf.length) return
          const n = Math.min(left, buf.length)
          const part = buf.subarray(0, n)
          buf = buf.subarray(n)
          left -= n
          if (!failed) {
            if (opts.writeDelayMs) await sleep(opts.writeDelayMs)
            if (tooFull(part.length)) failed = `${dir}: No space left on device`
            else { fs.writeSync(file, part); written += part.length }
          }
          if (left === 0) state = "end"
        } else if (state === "end") {
          if (!buf.length) return
          buf = buf.subarray(1) // the source's \0
          if (file !== null) { fs.closeSync(file); file = null }
          if (failed) err(failed)
          else ok()
          state = "header"
        }
      }
    }
    ch.on("data", (d) => { ch.pause(); busy = busy.then(() => onData(d)).finally(() => ch.resume()) })
    ch.on("end", () => {
      void busy.then(() => {
        if (file !== null) fs.closeSync(file)
        ch.exit(0)
        ch.end()
      })
    })
  }

  function runExec(ch, command, user) {
    const words = (() => { try { return parseShellWords(command) } catch { return [] } })()
    if (words[0] === "scp" && words.includes("-t")) {
      if (!opts.scp) {
        ch.stderr.write("sh: scp: not found\n")
        ch.exit(127)
        ch.end()
        return
      }
      return scpSink(ch, words[words.length - 1])
    }
    // A full disk shows in df too (the bench looks at it when a write fails with SFTP's generic "Failure").
    const reported = opts.reportFree ?? (opts.diskFullAfter !== null ? Math.max(0, opts.diskFullAfter - written) : null)
    if (reported !== null && /^df -Pk /.test(command)) {
      const kb = Math.floor(reported / 1024)
      ch.write(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 1000000 ${1000000 - kb} ${kb} 99% /\n`)
      ch.exit(0)
      ch.end()
      return
    }
    if (!opts.checksum && /^(sha256sum|md5sum)\b/.test(command)) {
      ch.stderr.write(`sh: ${command.split(" ")[0]}: not found\n`)
      ch.exit(127)
      ch.end()
      return
    }
    const p = spawn("sh", ["-c", command], { cwd: home, env: { HOME: home, USER: user ?? "root", PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] })
    p.stdout.pipe(ch, { end: false })
    p.stderr.pipe(ch.stderr, { end: false })
    ch.pipe(p.stdin)
    p.on("close", (code) => {
      ch.exit(code ?? 1)
      ch.end()
    })
    p.on("error", () => { ch.exit(127); ch.end() })
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, opts.host, () => resolve())
  })
  return {
    host: opts.host,
    port: server.address().port,
    home,
    hostKey,
    logins,
    commands,
    set(patch) { Object.assign(opts, patch) },
    written: () => written,
    close: () => new Promise((resolve) => {
      for (const c of clients) c.end()
      server.close(() => resolve())
    }),
  }
}

// Run as a program (also when bundled into another script: then argv[1] is that script, not this file).
if (/fake-ssh-server\.mjs$/.test(process.argv[1] ?? "")) void cli()

async function cli() {
  const args = process.argv.slice(2)
  const val = (name, d) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : d
  }
  const srv = await createFakeSshServer({
    host: val("--host", "127.0.0.1"), port: Number(val("--port", "2222")),
    home: val("--home", fs.mkdtempSync(path.join(os.tmpdir(), "fake-ssh-"))),
    users: { [val("--user", "root")]: val("--password", "root") },
    sftp: !args.includes("--no-sftp"), scp: !args.includes("--no-scp"), checksum: !args.includes("--no-checksum"),
    writeDelayMs: Number(val("--write-delay", "0")) || 0,
  })
  process.stdout.write(`SSH simulado${val("--name", "") ? ` (${val("--name", "")})` : ""} en ${srv.host}:${srv.port}, carpeta ${srv.home}${args.includes("--no-sftp") ? ", sin SFTP" : ""}\n`)
  const stop = () => { void srv.close().then(() => process.exit(0)) }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}
