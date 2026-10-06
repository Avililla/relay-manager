import fs from "node:fs"
import type { Server } from "node:http"
import type { Runtime } from "@/server/runtime/types"

export interface ShutdownDeps {
  rt: Runtime
  server: Server
  releaseLock: () => void
  cleanup?: Array<() => void>
  exit?: (code: number) => void
}

/**
 * Graceful shutdown (§2.10). Idempotent: a second signal is ignored. A hard exit after 8 s backs it up.
 */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let started = false
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  const log = deps.rt.log.child("process")

  async function step(name: string, fn: () => unknown): Promise<void> {
    try {
      await fn()
    } catch (err) {
      log.error(`Error al detener: ${name}`, { err })
    }
  }

  return async (signal) => {
    if (started) return
    started = true
    setTimeout(() => exit(0), 8000).unref()
    const { rt, server } = deps
    log.info("Deteniendo el servidor", { señal: signal })
    // 1. Stop accepting connections.
    server.close()
    for (const fn of deps.cleanup ?? []) await step("temporizador", fn)
    // 2-3. WS clients are closed with 1001 "Servidor detenido" by rt.serial.stop().
    await step("ops", () => rt.ops.stop())
    await step("relays", () => rt.relays.stop())
    await step("accesos", () => rt.accesses.stop())
    await step("red de equipos", () => rt.equipnet.stop())
    await step("archivos", () => rt.files.stop())
    await step("serial", () => rt.serial.stop())
    await step("reservas", () => rt.reservations.stop())
    await step("sesiones", () => rt.sessions.stop())
    // 4. Audit.
    rt.audit.record({ actor: { kind: "system", id: null, name: "sistema" }, action: "system.stop", detail: { signal } })
    rt.audit.stop()
    await step("auditoría", () => rt.audit.flush())
    // 5. SSE, keep-alive.
    server.closeAllConnections()
    // 6. DB, pid file, lock.
    await step("base de datos", () => rt.prisma.$disconnect())
    await step("pid", () => fs.rmSync(rt.config.pidFile, { force: true }))
    await step("bloqueo", () => deps.releaseLock())
    log.info("Servidor detenido")
    exit(0)
  }
}
