// Mount helper (relay-manager-rootmount): mounts and unmounts removable devices for «Montar» / «Expulsar» in the copy
// dialog. It runs as root WITHOUT a private mount namespace (its mounts must reach the host and the main service) and
// with CAP_SYS_ADMIN only. Its socket is root:root 0600: only the copy helper (relay-manager-rootcopy, which has already
// authenticated the sudo password or an elevation token) connects. Everything is checked again here: the device
// (devices.ts: removable, never part of a system disk), the filesystem (blkid), the mount folder (/media/<sudo user>/
// <label>, root-owned parents, created here) and, to unmount, that it is a mount of such a device under /media.
// Programs run with execFile and an argument array (absolute paths, no shell).
import { execFile } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { LineReader, parseMountRequest, type HelperErrorCode, type MountMessage, type MountResult, type UnmountResult } from "@/server/files/copy/protocol"
import { normalizeAbs, within } from "@/server/files/copy/policy"
import { parseMountinfo } from "@/server/files/copy/mounts"
import { checkDevice, isSupportedFs, mountDirName, mountOptions, readBlockDevice, familyOf, deviceProblem, parseSwaps, MEDIA_MOUNT_PREFIXES, READ_ONLY_FS, type ProbeEnv } from "./devices"

export class MountError extends Error {
  constructor(readonly code: HelperErrorCode, message: string) {
    super(message)
  }
}

/** The programs (injectable: the tests fake them). */
export interface MountExec {
  /** `blkid -p -o export <dev>` → TYPE, LABEL, UUID… (empty when there is no filesystem). */
  blkid(device: string): Promise<Record<string, string>>
  mount(a: { type: string; options: string; device: string; dir: string }): Promise<void>
  umount(dir: string): Promise<void>
  sync(dir: string): Promise<void>
  /** Best effort: let a group traverse a folder (setfacl -m g:<group>:rx). */
  allowGroup(dir: string, group: string): Promise<void>
  /** The device node exists and is a block device. */
  isBlockDevice(device: string): Promise<boolean>
}

export interface MountHelperConfig {
  enabled: boolean
  sudoUser: string
  /** The group shared by the service and the desktop user (FAT/exFAT/NTFS are mounted with it). */
  filesGroup: string
}

export interface RootMountOptions {
  config: MountHelperConfig
  exec: MountExec
  version: string
  sysRoot?: string
  /** /media (tests: a temporary folder). */
  mediaRoot?: string
  /** Also accepted for «Expulsar» (desktop automounts on some systems). */
  runMediaRoot?: string
  mountinfo?: () => Promise<string>
  swaps?: () => Promise<string>
  passwdFile?: string
  groupFile?: string
  /** created.json lives here (mount folders this helper made). null: in memory. */
  stateDir?: string | null
  /** TESTS ONLY: this /dev/loopN stands in for a USB stick (RM_ROOTMOUNT_TEST_LOOP in the unit's environment). */
  testLoop?: string | null
  /** The uid that must own /media and /media/<user> (0; tests: their own uid). */
  rootUid?: number
  log?: (msg: string) => void
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code ?? ""

/** passwd "<name>:x:<uid>:<gid>:…" → {id: uid, gid}; group "<name>:x:<gid>:…" → {id: gid} (local files only). */
function lookup(text: string, name: string, kind: "passwd" | "group"): { id: number; gid: number } | null {
  for (const line of text.split("\n")) {
    const f = line.split(":")
    if (f[0] !== name || f.length < 4 || !/^\d+$/.test(f[2])) continue
    const id = Number(f[2])
    if (kind === "group") return { id, gid: id }
    if (/^\d+$/.test(f[3])) return { id, gid: Number(f[3]) }
  }
  return null
}

export function createRootMountServer(o: RootMountOptions): net.Server {
  const sysRoot = o.sysRoot ?? "/sys"
  const mediaRoot = o.mediaRoot ?? "/media"
  const runMediaRoot = o.runMediaRoot ?? "/run/media"
  const rootUid = o.rootUid ?? 0
  const log = o.log ?? (() => undefined)
  const env: ProbeEnv = {
    sysRoot,
    mountinfo: o.mountinfo ?? (() => fs.promises.readFile("/proc/self/mountinfo", "utf8")),
    swaps: o.swaps ?? (() => fs.promises.readFile("/proc/swaps", "utf8")),
    testLoop: o.testLoop ?? null,
    mediaPrefixes: [...new Set([mediaRoot, runMediaRoot, ...MEDIA_MOUNT_PREFIXES])],
  }
  const createdFile = o.stateDir ? path.join(o.stateDir, "created.json") : null
  let createdMem: string[] = []
  /** One operation at a time (mount folder names, created.json). */
  let chain: Promise<unknown> = Promise.resolve()
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  async function created(): Promise<string[]> {
    if (!createdFile) return createdMem
    try {
      const v = JSON.parse(await fs.promises.readFile(createdFile, "utf8")) as unknown
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
    } catch {
      return []
    }
  }
  async function saveCreated(list: string[]): Promise<void> {
    if (!createdFile) {
      createdMem = list
      return
    }
    const tmp = `${createdFile}.tmp`
    await fs.promises.writeFile(tmp, JSON.stringify(list), { mode: 0o600 })
    await fs.promises.rename(tmp, createdFile)
  }

  /** A folder that must be a real directory owned by root and not writable by others (no links can be planted). */
  async function rootDir(p: string, create: boolean): Promise<fs.Stats> {
    let st = await fs.promises.lstat(p).catch(() => null)
    if (!st && create) {
      await fs.promises.mkdir(p, { mode: 0o755 }).catch((e: unknown) => { if (errno(e) !== "EEXIST") throw e })
      st = await fs.promises.lstat(p).catch(() => null)
    }
    if (!st) throw new MountError("NOT_FOUND", `No existe ${p}.`)
    if (!st.isDirectory() || st.isSymbolicLink()) throw new MountError("DENIED", `${p} no es una carpeta (¿un enlace?): no se monta ahí.`)
    if (st.uid !== rootUid || (st.mode & 0o022) !== 0) throw new MountError("DENIED", `${p} no es de root o la pueden modificar otros usuarios: no se monta ahí.`)
    return st
  }

  async function ids(): Promise<{ uid: number; gid: number }> {
    const passwd = await fs.promises.readFile(o.passwdFile ?? "/etc/passwd", "utf8").catch(() => "")
    const group = await fs.promises.readFile(o.groupFile ?? "/etc/group", "utf8").catch(() => "")
    const u = lookup(passwd, o.config.sudoUser, "passwd")
    if (!u) throw new MountError("ACCOUNT", `El usuario ${o.config.sudoUser} (RM_SUDO_USER) no existe en este equipo.`)
    const g = lookup(group, o.config.filesGroup, "group")
    return { uid: u.id, gid: g ? g.id : u.gid }
  }

  async function mount(device: string): Promise<MountResult> {
    const c = await checkDevice(device, env)
    if (!c.ok) throw new MountError(c.code, c.message)
    if (c.mounts.length) throw new MountError("EXISTS", `${device} ya está montado en ${c.mounts[0].mountPoint}.`)
    if (!(await o.exec.isBlockDevice(device))) throw new MountError("NOT_FOUND", `No existe ${device} (¿se ha quitado el pendrive?).`)
    const info = await o.exec.blkid(device).catch(() => ({} as Record<string, string>))
    const type = (info.TYPE ?? "").toLowerCase()
    if (!type) throw new MountError("DEVICE", `${device} no tiene un sistema de ficheros reconocible (¿sin formatear o cifrado?).`)
    if (!isSupportedFs(type)) throw new MountError("DEVICE", `${device} tiene un sistema de ficheros que no se monta desde aquí (${type}).`)
    const who = await ids()
    // /media/<user>: root-owned, created when missing; the service must be able to traverse it to write directly.
    await rootDir(mediaRoot, true)
    const userDir = path.join(mediaRoot, o.config.sudoUser)
    const ust = await rootDir(userDir, true)
    if ((ust.mode & 0o001) === 0) await o.exec.allowGroup(userDir, o.config.filesGroup).catch(() => undefined)
    const base = mountDirName(info.LABEL ?? null, info.UUID ?? null, path.basename(device))
    let dir: string | null = null
    for (let n = 1; n <= 50 && !dir; n++) {
      const cand = path.join(userDir, n === 1 ? base : `${base}-${n}`)
      try {
        await fs.promises.mkdir(cand, { mode: 0o755 })
        dir = cand
      } catch (e) {
        if (errno(e) !== "EEXIST") throw new MountError("IO", `No se puede crear ${cand} (${errno(e) || String(e)}).`)
      }
    }
    if (!dir) throw new MountError("EXISTS", `Demasiadas carpetas ${base}-N en ${userDir}.`)
    const list = await created()
    await saveCreated([...list.filter((x) => x !== dir), dir])
    const options = mountOptions(type, who)
    // NTFS with the kernel driver (ntfs3): a FUSE driver (ntfs-3g) would live in this unit's cgroup and die with it.
    const tries = type === "ntfs" || type === "ntfs3" ? ["ntfs3"] : [type]
    let lastErr: unknown = null
    for (const t of tries) {
      try {
        await o.exec.mount({ type: t, options, device, dir })
        log(`montado ${device} (${t}) en ${dir} [${options}]`)
        return { type: "result", op: "mount", device, mountPoint: dir, fsType: t, options }
      } catch (e) {
        lastErr = e
      }
    }
    await fs.promises.rmdir(dir).catch(() => undefined)
    await saveCreated((await created()).filter((x) => x !== dir))
    const why = lastErr instanceof Error ? firstLine(lastErr.message) : String(lastErr)
    throw new MountError("IO", `No se pudo montar ${device}${READ_ONLY_FS.has(type) ? "" : ` (${type})`}: ${why}`)
  }

  async function unmount(raw: string): Promise<UnmountResult> {
    const mp = normalizeAbs(raw)
    if (!mp || !([mediaRoot, runMediaRoot].some((r) => within(mp, r) && mp !== r))) {
      throw new MountError("DEVICE", "Solo se expulsan pendrives montados en /media o /run/media.")
    }
    const mounts = parseMountinfo(await env.mountinfo().catch(() => ""))
    const here = mounts.filter((m) => m.mountPoint === mp)
    const top = here.at(-1)
    if (!top) throw new MountError("NOT_FOUND", `${mp} no está montado.`)
    // The device behind it must be a removable one (never unmount a system disk mounted under /media).
    const name = await deviceNameOf(top.majorMinor)
    const dev = name ? await readBlockDevice(sysRoot, name) : null
    if (!dev) throw new MountError("DEVICE", `${mp} no es un pendrive ni un disco extraíble.`)
    const swaps = parseSwaps(await env.swaps().catch(() => "")).map((s) => path.basename(s))
    const family = await familyOf(sysRoot, dev)
    // The mount being removed is under /media, so it does not count against the device itself.
    const why = deviceProblem(dev, { mounts, swaps, family, mediaPrefixes: env.mediaPrefixes }, env.testLoop)
    if (why) throw new MountError("DEVICE", why)
    await o.exec.sync(mp).catch(() => undefined)
    try {
      await o.exec.umount(mp)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/busy|ocupad/i.test(msg)) throw new MountError("IN_USE", "El pendrive está en uso: cierra lo que tengas abierto en él (también terminales en esa carpeta) y vuelve a intentarlo.")
      throw new MountError("IO", `No se pudo expulsar ${mp}: ${firstLine(msg)}`)
    }
    log(`desmontado ${mp} (${dev.device})`)
    let removedDir = false
    const list = await created()
    const ours = list.includes(mp)
    // Only an empty folder (rmdir), and only ours or a /media/<user>/<name> one (what udisks makes).
    const depth2 = [mediaRoot, runMediaRoot].some((r) => within(mp, r) && mp.slice(r.length + 1).split("/").length === 2)
    if (ours || depth2) {
      const still = parseMountinfo(await env.mountinfo().catch(() => "")).some((m) => m.mountPoint === mp)
      if (!still) removedDir = await fs.promises.rmdir(mp).then(() => true, () => false)
    }
    if (ours) await saveCreated(list.filter((x) => x !== mp))
    return { type: "result", op: "unmount", mountPoint: mp, removedDir }
  }

  /** major:minor → block device name through sysfs (<sysRoot>/dev/block/<maj:min>). */
  async function deviceNameOf(majorMinor: string): Promise<string | null> {
    if (!/^\d+:\d+$/.test(majorMinor) || majorMinor.startsWith("0:")) return null
    return fs.promises.realpath(path.join(sysRoot, "dev", "block", majorMinor)).then((r) => path.basename(r), () => null)
  }

  async function handle(sock: net.Socket): Promise<void> {
    const reader = new LineReader(16 * 1024)
    const line = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000)
      sock.on("data", (c: Buffer) => {
        let lines: string[]
        try {
          lines = reader.push(c)
        } catch {
          clearTimeout(timer)
          return resolve(null)
        }
        if (lines.length) {
          clearTimeout(timer)
          resolve(lines[0])
        }
      })
      sock.on("close", () => resolve(null))
    })
    const reply = (m: MountMessage) => {
      if (!sock.destroyed) sock.end(`${JSON.stringify(m)}\n`)
    }
    if (line === null) return reply({ type: "error", code: "PROTOCOL", message: "Petición no válida." })
    const p = parseMountRequest(line)
    if (!p.ok) return reply({ type: "error", code: "PROTOCOL", message: p.message })
    try {
      if (p.req.op === "ping") return reply({ type: "result", op: "ping", version: o.version })
      if (!o.config.enabled) throw new MountError("DISABLED", "Montar pendrives está desactivado en este servidor (RM_COPY_ENABLED=0).")
      const req = p.req
      reply(await serialized<MountResult | UnmountResult>(() => (req.op === "mount" ? mount(req.device) : unmount(req.mountPoint))))
    } catch (e) {
      const err = e instanceof MountError ? e : new MountError("IO", "Error interno del ayudante de montaje.")
      if (!(e instanceof MountError)) log(`error interno: ${e instanceof Error ? e.message : String(e)}`)
      reply({ type: "error", code: err.code, message: err.message })
    }
  }

  const server = net.createServer({ allowHalfOpen: false }, (sock) => {
    sock.on("error", () => undefined)
    void handle(sock)
  })
  server.maxConnections = 4
  return server
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? "error"
}

// --- the real programs ---------------------------------------------------------------------------------------------

function findBin(names: readonly string[]): string | null {
  for (const n of names) {
    try {
      fs.accessSync(n, fs.constants.X_OK)
      return n
    } catch {
      // next
    }
  }
  return null
}

function run(bin: string | null, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error(`no se encuentra ${args[0] ?? "el programa"}`))
    execFile(bin, args, { timeout: timeoutMs, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "production" }, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(new Error(String(stderr).trim() || err.message), { exitCode: err.code }))
        else resolve(String(stdout))
      })
  })
}

export function systemMountExec(): MountExec {
  const blkid = findBin(["/usr/sbin/blkid", "/sbin/blkid", "/usr/bin/blkid"])
  const mountBin = findBin(["/usr/bin/mount", "/bin/mount"])
  const umountBin = findBin(["/usr/bin/umount", "/bin/umount"])
  const syncBin = findBin(["/usr/bin/sync", "/bin/sync"])
  const setfacl = findBin(["/usr/bin/setfacl", "/bin/setfacl"])
  return {
    async blkid(device) {
      let out: string
      try {
        out = await run(blkid, ["-p", "-o", "export", "--", device], 20_000)
      } catch {
        return {}
      }
      const r: Record<string, string> = {}
      for (const line of out.split("\n")) {
        const i = line.indexOf("=")
        if (i > 0) r[line.slice(0, i)] = line.slice(i + 1)
      }
      return r
    },
    async mount(a) {
      // -i: never the /sbin/mount.<type> helpers (exfat-fuse, ntfs-3g): the kernel drivers only.
      await run(mountBin, ["-i", "-t", a.type, "-o", a.options, "--", a.device, a.dir], 60_000)
    },
    async umount(dir) {
      await run(umountBin, ["-i", "--", dir], 10 * 60_000)
    },
    async sync(dir) {
      await run(syncBin, ["-f", "--", dir], 10 * 60_000)
    },
    async allowGroup(dir, group) {
      if (setfacl) await run(setfacl, ["-m", `g:${group}:rx`, "--", dir], 10_000)
    },
    async isBlockDevice(device) {
      return fs.promises.stat(device).then((s) => s.isBlockDevice(), () => false)
    },
  }
}
