// «Archivos › Enviar a equipo» (Graph A, part of rt.files): the equipment a user can send to, the sends (a queue with
// per-user and global limits, progress on the SSE bus to that user only), cancel, the remembered login per equipment
// (password sealed with the app-secret key, never returned) and the host key fingerprints. The transfer itself is
// transfer.ts; the route is the one of the equipment's Ethernet access (rt.equipnet for a switch port).
import crypto from "node:crypto"
import type { PrismaClient } from "@/generated/prisma/client"
import type { FilesRootId, SendJobDTO, SendRouteDTO, SendStartInput, SendTargetDTO } from "@/lib/contracts/files"
import { checkRemotePath, remoteNameProblem, type RemotePath } from "@/lib/files/remote-path"
import { accessDetail } from "@/lib/i18n/accesses"
import { sendErrors as E, sendUi } from "@/lib/i18n/send"
import { equipmentForUser, visibleEquipmentIdsFor } from "@/server/access"
import type { AppConfig } from "@/server/config/schema"
import { openSecret, sealSecret, SSH_SECRET_INFO } from "@/server/equipnet/secret"
import type { Logger } from "@/server/log"
import type { AuditService, AuthUser, EquipnetServices, EventBus, ReservationService } from "@/server/runtime/types"
import type { DownloadSource } from "../core"
import { filesError, filesErrorKind } from "../paths"
import { canSendTo, pickAccess } from "./rules"
import { sendFile, SendError, type TransferOptions, type TransferResult, type TransferRoute } from "./transfer"

export interface SendDeps {
  config: Pick<AppConfig, "authSecret"> & Partial<Pick<AppConfig, "defaults">>
  log: Logger
  prisma: PrismaClient
  bus: EventBus
  audit: AuditService
  reservations: ReservationService
  equipnet: EquipnetServices
  /** A file of the folder, opened through the files core (path rules, descriptor checks). */
  openSource(root: FilesRootId, rel: string): Promise<DownloadSource>
}

/** Test seams and limits. */
export interface SendInternals {
  transfer?: (o: TransferOptions) => Promise<TransferResult>
  timeouts?: TransferOptions["timeouts"]
  maxActivePerUser?: number
  maxActive?: number
  maxPendingPerUser?: number
  progressMs?: number
  keepFinishedMs?: number
  touchEveryMs?: number
  now?: () => number
}

export interface SendService {
  targets(user: AuthUser): Promise<SendTargetDTO[]>
  start(user: AuthUser, ip: string | null, input: SendStartInput): Promise<{ jobs: SendJobDTO[] }>
  jobs(userId: string): SendJobDTO[]
  cancel(userId: string, id: string): boolean
  clearFinished(userId: string): void
  forget(user: AuthUser, ip: string | null, equipmentId: string): Promise<void>
  stats(): { active: number; queued: number }
  begin(): void
  stop(): Promise<void>
}

interface AccessRow {
  id: string; label: string; enabled: boolean; policy: string; position: number
  targetMode: string; targetHost: string | null; targetPort: number | null; switchPort: number | null
  equipment: { id: string; name: string; position: number }
}

interface Batch {
  userId: string
  equipmentId: string
  remember: boolean
  username: string
  password: string
  /** A password was typed (not the remembered one): remembering replaces the stored one. */
  typed: boolean
  destPath: string
  saved: boolean
}

interface Job {
  dto: SendJobDTO
  user: { id: string; username: string; name: string; ip: string | null }
  equipmentId: string
  equipmentName: string
  policy: "reserved" | "always"
  root: FilesRootId
  rel: string
  dest: Extract<RemotePath, { ok: true }>
  multi: boolean
  route: TransferRoute
  batch: Batch
  ac: AbortController
  abortReason: string | null
  lastPublish: number
  sample: { t: number; bytes: number } | null
  hostKey: { type: string; fingerprint: string } | null
  previousKey: string | null
  done: Promise<void> | null
}

const ACTIVE: ReadonlySet<SendJobDTO["state"]> = new Set(["connecting", "sending", "verifying"])
const FINISHED: ReadonlySet<SendJobDTO["state"]> = new Set(["done", "error", "canceled"])

export function createSendService(deps: SendDeps, internals: SendInternals = {}): SendService {
  const log = deps.log.child("envios")
  const transfer = internals.transfer ?? sendFile
  const maxPerUser = internals.maxActivePerUser ?? 3
  const maxActive = internals.maxActive ?? 8
  const maxPending = internals.maxPendingPerUser ?? 40
  const progressMs = internals.progressMs ?? 500
  const keepMs = internals.keepFinishedMs ?? 3600_000
  const touchEvery = internals.touchEveryMs ?? 30_000
  const now = internals.now ?? (() => Date.now())
  const jobs = new Map<string, Job>()
  const secret = () => deps.config.authSecret ?? ""
  let stopped = false
  let unsubscribe: (() => void) | null = null

  // --- equipment and their Ethernet access -------------------------------------------------------------------

  async function accessRows(user: AuthUser, equipmentId?: string): Promise<Map<string, AccessRow>> {
    const visible = await visibleEquipmentIdsFor(deps.prisma, user)
    if (equipmentId && visible !== "all" && !visible.includes(equipmentId)) return new Map()
    const rows = await deps.prisma.equipmentAccess.findMany({
      where: {
        kind: "tcp",
        ...(equipmentId ? { equipmentId } : visible === "all" ? {} : { equipmentId: { in: visible } }),
      },
      select: {
        id: true, label: true, enabled: true, policy: true, position: true, targetMode: true, targetHost: true, targetPort: true, switchPort: true,
        equipment: { select: { id: true, name: true, position: true } },
      },
    })
    const by = new Map<string, AccessRow[]>()
    for (const r of rows) by.set(r.equipment.id, [...(by.get(r.equipment.id) ?? []), r])
    const out = new Map<string, AccessRow>()
    for (const [id, list] of by) {
      const a = pickAccess(list)
      if (a) out.set(id, a)
    }
    return out
  }

  function routeOf(a: AccessRow): { dto: SendRouteDTO; route: TransferRoute | null; problem: string | null } {
    const port = a.targetPort ?? deps.config.defaults?.equipmentPort ?? 22
    if (a.targetMode === "switch") {
      if (a.switchPort === null) {
        return { dto: { mode: "switch", switchPort: 0, link: "unknown", ready: false, host: a.targetHost ?? "", port }, route: null, problem: accessDetail.noSwitchPort }
      }
      const r = deps.equipnet.route(a.switchPort)
      const host = a.targetHost ?? r.equipmentIp ?? ""
      const ready = r.configured && r.ready && !!r.localAddress && !!host
      return {
        dto: { mode: "switch", switchPort: a.switchPort, link: r.link, ready, host, port },
        route: ready ? { host, port, localAddress: r.localAddress, switchPort: a.switchPort, link: r.link, bindError: accessDetail.vlanGone(a.switchPort, r.localAddress ?? "") } : null,
        problem: ready ? null : E.network(r.problem ?? "la VLAN de este puerto no está preparada en el servidor."),
      }
    }
    if (!a.targetHost) return { dto: { mode: "ip", host: "", port }, route: null, problem: accessDetail.noTarget }
    return {
      dto: { mode: "ip", host: a.targetHost, port },
      route: { host: a.targetHost, port, localAddress: null, switchPort: null, link: null, bindError: null },
      problem: null,
    }
  }

  const viaText = (d: SendRouteDTO) => (d.mode === "switch" ? `Puerto ${d.switchPort} del switch` : sendUi.viaIp(d.host, d.port))
  const policyOf = (p: string): "reserved" | "always" => (p === "always" ? "always" : "reserved")

  function reservationOf(equipmentId: string): { holderId: string; holderName: string } | null {
    const r = deps.reservations.get(equipmentId)
    return r ? { holderId: r.holderId, holderName: r.holderName } : null
  }

  async function profiles(ids: string[]) {
    const rows = await deps.prisma.equipmentSshProfile.findMany({ where: { equipmentId: { in: ids } } })
    return new Map(rows.map((r) => [r.equipmentId, r]))
  }

  // --- jobs ------------------------------------------------------------------------------------------------------

  function publish(job: Job, force = false): void {
    const t = now()
    if (!force && t - job.lastPublish < progressMs) return
    job.lastPublish = t
    deps.bus.publish({ type: "files.send", job: { ...job.dto } }, { kind: "user", userId: job.user.id })
  }

  function setState(job: Job, state: SendJobDTO["state"]): void {
    job.dto.state = state
    if (FINISHED.has(state)) job.dto.finishedAt = new Date(now()).toISOString()
    publish(job, true)
  }

  function progress(job: Job, sent: number): void {
    const t = now()
    job.dto.sent = sent
    const s = job.sample
    if (!s) job.sample = { t, bytes: sent }
    else if (t - s.t >= 250) {
      const inst = ((sent - s.bytes) / (t - s.t)) * 1000
      job.dto.speed = job.dto.speed > 0 ? Math.round(job.dto.speed * 0.7 + inst * 0.3) : Math.round(inst)
      job.sample = { t, bytes: sent }
    }
    publish(job)
  }

  const activeOf = (userId?: string) => [...jobs.values()].filter((j) => ACTIVE.has(j.dto.state) && (!userId || j.user.id === userId))

  function prune(): void {
    const t = now()
    const perUser = new Map<string, Job[]>()
    for (const j of jobs.values()) {
      if (!FINISHED.has(j.dto.state)) continue
      if (j.dto.finishedAt && t - Date.parse(j.dto.finishedAt) > keepMs) {
        jobs.delete(j.dto.id)
        continue
      }
      perUser.set(j.user.id, [...(perUser.get(j.user.id) ?? []), j])
    }
    for (const list of perUser.values()) for (const j of list.slice(0, Math.max(0, list.length - 50))) jobs.delete(j.dto.id)
  }

  function pump(): void {
    if (stopped) return
    for (const j of jobs.values()) {
      if (j.dto.state !== "queued") continue
      if (activeOf().length >= maxActive) return
      if (activeOf(j.user.id).length >= maxPerUser) continue
      j.dto.state = "connecting"
      j.done = run(j).catch((err: unknown) => log.error("Error inesperado en un envío", { err })).finally(() => {
        prune()
        pump()
      })
    }
  }

  async function saveProfile(job: Job): Promise<void> {
    const b = job.batch
    if (!b.remember || b.saved) return
    b.saved = true
    const data = {
      remembered: true, username: b.username, destPath: b.destPath, updatedById: b.userId,
      ...(b.typed ? { password: sealSecret(b.password, secret(), SSH_SECRET_INFO) } : {}),
    }
    await deps.prisma.equipmentSshProfile.upsert({ where: { equipmentId: b.equipmentId }, create: { equipmentId: b.equipmentId, ...data }, update: data })
    deps.audit.record({
      actor: { kind: "user", id: job.user.id, name: job.user.username, ip: job.user.ip }, action: "files.send.login",
      equipment: { id: job.equipmentId, name: job.equipmentName }, target: { type: "equipment", id: job.equipmentId, name: job.equipmentName },
      detail: { credencial: b.typed ? "guardada" : "conservada", usuario: b.username, ruta: b.destPath },
    })
  }

  async function recordHostKey(job: Job): Promise<void> {
    const k = job.hostKey
    if (!k) return
    const data = { hostKeyType: k.type, hostKeyFingerprint: k.fingerprint, hostKeySeenAt: new Date(now()) }
    await deps.prisma.equipmentSshProfile.upsert({ where: { equipmentId: job.equipmentId }, create: { equipmentId: job.equipmentId, ...data }, update: data })
  }

  async function run(job: Job): Promise<void> {
    publish(job, true)
    let src: DownloadSource | null = null
    let touchTimer: NodeJS.Timeout | null = null
    let result: TransferResult | null = null
    let failure: SendError | null = null
    try {
      // The reservation may have changed while it waited in the queue.
      const rule = canSendTo({ userId: job.user.id, reservation: reservationOf(job.equipmentId), policy: job.policy, enabled: true })
      if (!rule.ok) throw new SendError("canceled", rule.reason)
      src = await deps.openSource(job.root, job.rel).catch((e: unknown) => {
        throw new SendError("source", e instanceof Error ? e.message : String(e))
      })
      if (src.size !== job.dto.size) job.dto.size = src.size
      const handle = src.handle
      const size = src.size
      touchTimer = setInterval(() => {
        if (deps.reservations.get(job.equipmentId)?.holderId === job.user.id) deps.reservations.touch(job.equipmentId, job.user.id, "access")
      }, touchEvery)
      touchTimer.unref()
      result = await transfer({
        route: job.route, username: job.batch.username, password: job.batch.password, dest: job.dest, multi: job.multi,
        signal: job.ac.signal, timeouts: internals.timeouts,
        source: {
          name: src.name, size, mode: (src.mode & 0o111) !== 0 ? 0o755 : 0o644,
          async *chunks(n: number) {
            let pos = 0
            while (pos < size) {
              const buf = Buffer.allocUnsafe(Math.min(n, size - pos))
              const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
              if (bytesRead === 0) break // shrank: transfer.ts reports "cambiado mientras se enviaba"
              pos += bytesRead
              yield bytesRead === buf.length ? buf : buf.subarray(0, bytesRead)
            }
          },
        },
        onPhase: (p) => { if (p !== "connecting") setState(job, p) },
        onProgress: (n) => progress(job, n),
        onHostKey: (k) => {
          job.hostKey = k
          job.dto.hostKeyChanged = job.previousKey && job.previousKey !== k.fingerprint ? { previous: job.previousKey, current: k.fingerprint } : null
        },
        onAuthenticated: () => {
          void recordHostKey(job).catch((err: unknown) => log.warn("No se pudo guardar la huella SSH", { error: String(err) }))
          void saveProfile(job).catch((err: unknown) => log.warn("No se pudo guardar el acceso recordado", { error: String(err) }))
        },
      })
      job.dto.sent = size
      job.dto.dest = `${job.batch.username}@${result.finalPath}`
      job.dto.protocol = result.protocol
      job.dto.verification = result.verification
      job.dto.checksum = result.checksum
      job.dto.replaced = result.replaced
      setState(job, "done")
    } catch (e) {
      failure = e instanceof SendError ? e : new SendError("remote", E.internal(crypto.randomBytes(4).toString("hex")))
      if (!(e instanceof SendError)) log.error("Error interno en un envío", { err: e })
      const canceled = failure.kind === "canceled" || job.ac.signal.aborted
      job.dto.error = job.abortReason ?? failure.message
      setState(job, canceled ? "canceled" : "error")
    } finally {
      if (touchTimer) clearInterval(touchTimer)
      await src?.handle.close().catch(() => undefined)
      // The password stays in memory only while a send of its batch is pending.
      if (![...jobs.values()].some((j) => j.batch === job.batch && !FINISHED.has(j.dto.state))) job.batch.password = ""
      const d = job.dto
      deps.audit.record({
        actor: { kind: "user", id: job.user.id, name: job.user.username, ip: job.user.ip },
        action: "files.send",
        outcome: d.state === "done" ? "ok" : "error",
        equipment: { id: job.equipmentId, name: job.equipmentName },
        target: { type: "file", id: null, name: job.rel },
        detail: {
          root: job.root, path: job.rel, sizeBytes: d.size, dest: d.dest, via: d.via,
          result: d.state === "done" ? "enviado" : d.state === "canceled" ? "cancelado" : "error",
          ...(result ? { protocol: result.protocol, checksum: result.verification === "verified" ? `verificado (${result.checksum})` : "no verificable", replaced: result.replaced } : {}),
          ...(job.hostKey ? { hostKey: job.hostKey.fingerprint } : {}),
          ...(d.hostKeyChanged ? { hostKeyChanged: true, previousHostKey: d.hostKeyChanged.previous } : {}),
          ...(failure ? { error: d.error, kind: failure.kind } : {}),
        },
      })
      log.info(d.state === "done" ? "Archivo enviado a un equipo" : "Envío a un equipo sin terminar", {
        usuario: job.user.username, equipo: job.equipmentName, archivo: job.rel, destino: d.dest, estado: d.state,
        ...(d.error ? { causa: d.error } : {}),
      })
    }
  }

  function dtoFor(userId: string): SendJobDTO[] {
    return [...jobs.values()].filter((j) => j.user.id === userId).map((j) => ({ ...j.dto }))
  }

  return {
    async targets(user) {
      const rows = await accessRows(user)
      const prof = await profiles([...rows.keys()])
      const out: SendTargetDTO[] = []
      for (const a of rows.values()) {
        const r = routeOf(a)
        const res = reservationOf(a.equipment.id)
        const policy = policyOf(a.policy)
        const rule = canSendTo({ userId: user.id, reservation: res, policy, enabled: a.enabled })
        const p = prof.get(a.equipment.id)
        const blocked = !rule.ok ? rule.reason : r.problem
        out.push({
          equipmentId: a.equipment.id, equipmentName: a.equipment.name, accessId: a.id, accessLabel: a.label, route: r.dto, policy,
          reservation: res ? { holderName: res.holderName, mine: res.holderId === user.id } : null,
          allowed: !blocked, blockedReason: blocked,
          profile: p?.remembered ? { username: p.username, destPath: p.destPath, passwordSaved: !!p.password } : null,
          hostKey: p?.hostKeyFingerprint && p.hostKeySeenAt ? { type: p.hostKeyType, fingerprint: p.hostKeyFingerprint, seenAt: p.hostKeySeenAt.toISOString() } : null,
        })
      }
      const pos = new Map([...rows.values()].map((a) => [a.equipment.id, a.equipment.position]))
      return out.sort((x, y) => (pos.get(x.equipmentId) ?? 0) - (pos.get(y.equipmentId) ?? 0) || x.equipmentName.localeCompare(y.equipmentName, "es", { numeric: true }))
    },

    async start(user, ip, input) {
      if (stopped) throw filesError("UNAVAILABLE", "El servidor se está deteniendo.")
      const actor = { kind: "user" as const, id: user.id, name: user.username, ip }
      const dest = checkRemotePath(input.destPath)
      if (!dest.ok) throw filesError("INVALID", dest.error, { field: "destPath" })
      const a = (await accessRows(user, input.equipmentId)).get(input.equipmentId)
      if (!a) throw filesError("NOT_FOUND", (await equipmentForUser(deps.prisma, user, input.equipmentId)) ? E.noEthernet : E.notFound)
      const eq = a.equipment
      const policy = policyOf(a.policy)
      const rule = canSendTo({ userId: user.id, reservation: reservationOf(eq.id), policy, enabled: a.enabled })
      if (!rule.ok) {
        deps.audit.record({ actor, action: "files.send", outcome: "denied", equipment: { id: eq.id, name: eq.name }, target: { type: "equipment", id: eq.id, name: eq.name }, detail: { code: rule.code, files: input.paths.length } })
        throw filesError("FORBIDDEN", rule.reason)
      }
      const r = routeOf(a)
      if (!r.route) throw filesError("UNAVAILABLE", r.problem ?? E.noEthernet)
      const pending = [...jobs.values()].filter((j) => j.user.id === user.id && !FINISHED.has(j.dto.state)).length
      if (pending + input.paths.length > maxPending) throw filesError("BUSY", E.tooManyQueued(pending))

      // The files: each one must be a regular file of the folder with a name that can travel.
      const files: Array<{ rel: string; name: string; size: number }> = []
      for (const rel of [...new Set(input.paths)]) {
        const src = await deps.openSource(input.root, rel).catch((e: unknown) => {
          // A folder: the core's message talks about downloading it as .zip; here only files can be sent.
          if (filesErrorKind(e) === "INVALID" && (e as { details?: { isDir?: unknown } }).details?.isDir === true) throw filesError("INVALID", E.notAFile(rel.split("/").pop() ?? rel))
          throw e
        })
        await src.handle.close().catch(() => undefined)
        const why = remoteNameProblem(src.name)
        if (why) throw filesError("INVALID", why)
        files.push({ rel: src.path, name: src.name, size: src.size })
      }

      // The login: typed, or the remembered one (null password).
      const prof = await deps.prisma.equipmentSshProfile.findUnique({ where: { equipmentId: eq.id } })
      let password: string
      let typed = true
      if (input.password === null) {
        const opened = prof?.remembered && prof.password ? openSecret(prof.password, secret(), SSH_SECRET_INFO) : null
        if (opened === null) throw filesError("INVALID", "No hay contraseña guardada para este equipo: escríbela.", { field: "password" })
        password = opened
        typed = false
      } else password = input.password
      if (!input.remember && prof?.remembered) {
        await deps.prisma.equipmentSshProfile.update({ where: { equipmentId: eq.id }, data: { remembered: false, username: null, password: null, destPath: null, updatedById: user.id } })
        deps.audit.record({ actor, action: "files.send.login", equipment: { id: eq.id, name: eq.name }, target: { type: "equipment", id: eq.id, name: eq.name }, detail: { credencial: "olvidada" } })
      }
      const batch: Batch = { userId: user.id, equipmentId: eq.id, remember: input.remember, username: input.username, password, typed, destPath: input.destPath.trim(), saved: false }
      const created: Job[] = []
      for (const f of files) {
        const id = crypto.randomBytes(16).toString("hex")
        const job: Job = {
          dto: {
            id, equipmentId: eq.id, equipmentName: eq.name, root: input.root, path: f.rel, name: f.name, size: f.size, sent: 0, speed: 0, state: "queued",
            dest: `${input.username}@${input.destPath.trim()}`, via: viaText(r.dto), protocol: null, verification: null, checksum: null,
            replaced: false, hostKeyChanged: null, error: null, createdAt: new Date(now()).toISOString(), finishedAt: null,
          },
          user: { id: user.id, username: user.username, name: user.name, ip },
          equipmentId: eq.id, equipmentName: eq.name, policy, root: input.root, rel: f.rel, dest, multi: files.length > 1, route: r.route, batch,
          ac: new AbortController(), abortReason: null, lastPublish: 0, sample: null, hostKey: null, previousKey: prof?.hostKeyFingerprint ?? null, done: null,
        }
        jobs.set(id, job)
        created.push(job)
        publish(job, true)
      }
      pump()
      return { jobs: created.map((j) => ({ ...j.dto })) }
    },

    jobs: (userId) => dtoFor(userId),

    cancel(userId, id) {
      const j = jobs.get(id)
      if (!j || j.user.id !== userId) return false
      if (FINISHED.has(j.dto.state)) return true
      if (j.dto.state === "queued") {
        j.dto.error = E.canceled
        setState(j, "canceled")
        deps.audit.record({
          actor: { kind: "user", id: j.user.id, name: j.user.username, ip: j.user.ip }, action: "files.send", outcome: "error",
          equipment: { id: j.equipmentId, name: j.equipmentName }, target: { type: "file", id: null, name: j.rel },
          detail: { root: j.root, path: j.rel, sizeBytes: j.dto.size, dest: j.dto.dest, via: j.dto.via, result: "cancelado" },
        })
        prune()
        return true
      }
      j.ac.abort()
      return true
    },

    clearFinished(userId) {
      for (const j of [...jobs.values()]) if (j.user.id === userId && FINISHED.has(j.dto.state)) jobs.delete(j.dto.id)
    },

    async forget(user, ip, equipmentId) {
      const a = (await accessRows(user, equipmentId)).get(equipmentId)
      if (!a) throw filesError("NOT_FOUND", E.notFound)
      const rule = canSendTo({ userId: user.id, reservation: reservationOf(equipmentId), policy: policyOf(a.policy), enabled: true })
      if (!rule.ok && !user.isAdmin) throw filesError("FORBIDDEN", rule.reason)
      const n = await deps.prisma.equipmentSshProfile.updateMany({ where: { equipmentId, remembered: true }, data: { remembered: false, username: null, password: null, destPath: null, updatedById: user.id } })
      if (n.count) {
        deps.audit.record({
          actor: { kind: "user", id: user.id, name: user.username, ip }, action: "files.send.login",
          equipment: { id: a.equipment.id, name: a.equipment.name }, target: { type: "equipment", id: a.equipment.id, name: a.equipment.name }, detail: { credencial: "olvidada" },
        })
      }
    },

    stats: () => ({ active: activeOf().length, queued: [...jobs.values()].filter((j) => j.dto.state === "queued").length }),

    begin() {
      stopped = false
      // Losing the reservation stops the sends that needed it (as the Ethernet access closes its connections).
      unsubscribe = deps.reservations.onChange((c) => {
        const holder = deps.reservations.get(c.equipmentId)?.holderId ?? null
        for (const j of jobs.values()) {
          if (j.equipmentId !== c.equipmentId || FINISHED.has(j.dto.state) || j.policy === "always" || holder === j.user.id) continue
          j.abortReason = E.released
          if (j.dto.state === "queued") {
            j.dto.error = E.released
            setState(j, "canceled")
          } else j.ac.abort()
        }
      })
    },

    async stop() {
      stopped = true
      unsubscribe?.()
      unsubscribe = null
      const running = [...jobs.values()].filter((j) => !FINISHED.has(j.dto.state))
      for (const j of running) {
        j.abortReason = "El servidor se ha detenido: envío cancelado."
        if (j.dto.state === "queued") {
          j.dto.error = j.abortReason
          setState(j, "canceled")
        } else j.ac.abort()
      }
      await Promise.race([Promise.all(running.map((j) => j.done)), new Promise((r) => setTimeout(r, 3000).unref())])
    },
  }
}
