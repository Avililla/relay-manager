// Live WS/SSE session registry (§6.2, D40). Revalidates open sessions every 30 s and on viewer.changed / session.revoked.
import type { PrismaClient } from "@/generated/prisma/client"
import type { AppConfig } from "@/server/config/schema"
import type { Logger } from "@/server/log"
import type { AuthUser, EventBus, LiveSession, SessionRegistry } from "@/server/runtime/types"
import { absoluteCapMs } from "./callbacks"

export const SESSION_SWEEP_MS = 30_000

export function createSessionRegistry(deps: { prisma: PrismaClient; bus: EventBus; log: Logger; config: AppConfig }): SessionRegistry {
  const sessions = new Set<LiveSession>()
  const log = deps.log.child("auth")
  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let running: Promise<void> | null = null
  let again = false

  async function sweepOnce(): Promise<void> {
    if (!sessions.size) return
    const ids = [...new Set([...sessions].map((s) => s.userId))]
    const rows = await deps.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, name: true, isAdmin: true, disabled: true, mustChangePassword: true, sessionVersion: true, roles: { select: { id: true } } },
    })
    const byId = new Map(rows.map((r) => [r.id, r]))
    const cap = absoluteCapMs(deps.config.sessionMaxAgeHours * 3600)
    const now = Date.now()
    for (const s of [...sessions]) {
      if (!sessions.has(s)) continue
      const u = byId.get(s.userId)
      try {
        if (!u || u.disabled || u.sessionVersion !== s.sv) {
          sessions.delete(s)
          s.revoke("revoked")
        } else if (now - s.loginAt > cap) {
          sessions.delete(s)
          s.revoke("expired")
        } else {
          const user: AuthUser = {
            id: u.id, username: u.username, name: u.name, isAdmin: u.isAdmin, roleIds: u.roles.map((r) => r.id),
            mustChangePassword: u.mustChangePassword, sessionVersion: u.sessionVersion,
          }
          s.refresh(user)
        }
      } catch (err) {
        log.error("Error al revalidar una sesión abierta", { kind: s.kind, err })
      }
    }
  }

  /** Coalesces concurrent triggers: at most one sweep runs, plus one queued. */
  function sweep(): Promise<void> {
    if (running) { again = true; return running }
    running = (async () => {
      try {
        do { again = false; await sweepOnce() } while (again)
      } catch (err) {
        log.error("Error al revalidar las sesiones abiertas", { err })
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    register(s) {
      sessions.add(s)
      return () => { sessions.delete(s) }
    },
    sweep,
    count(filter) {
      let n = 0
      for (const s of sessions) if ((!filter?.userId || s.userId === filter.userId) && (!filter?.kind || s.kind === filter.kind)) n++
      return n
    },
    start() {
      if (timer) return
      timer = setInterval(() => { void sweep() }, SESSION_SWEEP_MS)
      timer.unref?.()
      unsubscribe = deps.bus.subscribe((e) => {
        if (e.type === "viewer.changed" || e.type === "session.revoked") void sweep()
      })
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
