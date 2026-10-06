// Child processes of the service must not inherit its ambient capability (CAP_NET_ADMIN, for the equipment network):
// hw_server and the export downloader (a script that downloads and runs `jf`) get none. setpriv (util-linux) clears
// the inheritable and ambient sets before exec; the service has no CAP_SETPCAP, so the bounding set stays as it is.
import fs from "node:fs"

/** Does this process hold ambient capabilities (that its children would inherit)? */
export function hasAmbientCaps(statusText?: string): boolean {
  try {
    const m = /^CapAmb:\s*([0-9a-fA-F]+)/m.exec(statusText ?? fs.readFileSync("/proc/self/status", "utf8"))
    return !!m && BigInt(`0x${m[1]}`) !== 0n
  } catch {
    return false
  }
}

/** The setpriv binary, or null when there is none. */
export function findSetpriv(): string | null {
  for (const p of ["/usr/bin/setpriv", "/bin/setpriv"]) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch { /* next */ }
  }
  return null
}

/** setpriv, when this process has ambient capabilities to drop for its children; null otherwise. */
export function dropCaps(): string | null {
  return hasAmbientCaps() ? findSetpriv() : null
}

/** The arguments that run `file args…` through setpriv without capabilities. */
export const DROP_CAPS_ARGS: readonly string[] = ["--inh-caps=-all", "--ambient-caps=-all", "--"]
