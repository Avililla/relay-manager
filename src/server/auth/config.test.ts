import { afterEach, describe, expect, it } from "vitest"
import type { Logger } from "@/server/log"
import { setRuntime } from "@/server/runtime/registry"
import type { Runtime } from "@/server/runtime/types"
import { fakeRuntime } from "../../../test/helpers"
import { logAuthError } from "./config"

function recordingLogger(lines: string[]): Logger {
  const log: Logger = {
    debug: (m) => lines.push(`debug ${m}`),
    info: (m) => lines.push(`info ${m}`),
    warn: (m, meta) => lines.push(`warn ${m} ${JSON.stringify(meta)}`),
    error: (m, meta) => lines.push(`error ${m} ${meta && "tipo" in meta ? String(meta.tipo) : ""}`),
    child: () => log,
  }
  return log
}

function authError(type: string): Error {
  const e = new Error(`${type}: detalle`)
  Object.assign(e, { type })
  return e
}

describe("logAuthError (Auth.js logger)", () => {
  const G = globalThis as typeof globalThis & { [k: symbol]: Runtime | undefined }
  afterEach(() => { G[Symbol.for("relay-manager.runtime")] = undefined })

  it("drops failed logins (already audited), warns on client errors and logs anything else as an error", () => {
    const lines: string[] = []
    setRuntime(fakeRuntime({ log: recordingLogger(lines) }))
    logAuthError(authError("CredentialsSignin"))
    expect(lines).toEqual([])
    logAuthError(authError("MissingCSRF"))
    expect(lines).toEqual(['warn Petición de acceso rechazada {"tipo":"MissingCSRF"}'])
    logAuthError(authError("CallbackRouteError"))
    expect(lines[1]).toBe("error Error de Auth.js CallbackRouteError")
  })

  it("never throws without a runtime", () => {
    expect(() => logAuthError(new Error("x"))).not.toThrow()
  })
})
