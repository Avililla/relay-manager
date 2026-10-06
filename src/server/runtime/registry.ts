import type { Runtime } from "./types"

const KEY = Symbol.for("relay-manager.runtime")
type G = typeof globalThis & { [KEY]?: Runtime }

export function setRuntime(rt: Runtime): void {
  ;(globalThis as G)[KEY] = rt
}

export function tryGetRuntime(): Runtime | undefined {
  return (globalThis as G)[KEY]
}

export function getRuntime(): Runtime {
  const rt = (globalThis as G)[KEY]
  if (!rt) {
    const err = new Error("Los servicios del servidor no están iniciados")
    err.name = "RuntimeNotReady"
    throw err
  }
  return rt
}
