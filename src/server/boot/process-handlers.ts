import type { Runtime } from "@/server/runtime/types"

/**
 * Installed after app.prepare() (§2.9): Next's own handlers only console.error. Ours log through the logger and
 * count the errors for health (`runtime.errors`).
 */
export function installProcessHandlers(rt: Pick<Runtime, "log" | "state">): () => void {
  const log = rt.log.child("process")
  const onException = (err: unknown) => {
    rt.state.uncaughtErrors += 1
    log.error("Excepción no capturada", { err })
  }
  const onRejection = (reason: unknown) => {
    rt.state.uncaughtErrors += 1
    log.error("Promesa rechazada sin gestionar", { err: reason })
  }
  process.on("uncaughtException", onException)
  process.on("unhandledRejection", onRejection)
  return () => {
    process.off("uncaughtException", onException)
    process.off("unhandledRejection", onRejection)
  }
}
