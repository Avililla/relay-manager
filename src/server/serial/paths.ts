// Canonical device paths (§4.4): devNode/byId/byPath are stored and shown in the host view (/dev/...); they are
// mapped to <devRoot>/... only to open or stat them (Docker: /dev:/hostdev:ro + RM_SERIAL_DEV_ROOT=/hostdev).
import { promises as fs } from "node:fs"
import path from "node:path"

/** "<devRoot>/x" → "/dev/x"; any other path (virtual ports) stays literal. */
export function toCanonical(devRoot: string, p: string): string {
  const root = devRoot.replace(/\/+$/, "") || "/"
  if (root === "/dev") return p
  if (p === root) return "/dev"
  if (p.startsWith(root + "/")) return "/dev/" + p.slice(root.length + 1)
  return p
}

/** "/dev/x" → "<devRoot>/x"; any other path stays literal. */
export function toOpenPath(devRoot: string, canonical: string): string {
  const root = devRoot.replace(/\/+$/, "") || "/"
  if (root === "/dev") return canonical
  if (canonical.startsWith("/dev/")) return path.join(root, canonical.slice(5))
  return canonical
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
  return new RegExp(`^${esc}$`)
}

/** Expands a glob whose wildcards are in the last component only. A missing directory gives []. */
export async function expandGlob(glob: string): Promise<string[]> {
  const dir = path.dirname(glob)
  const re = globToRegExp(path.basename(glob))
  try {
    return (await fs.readdir(dir)).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n))
  } catch {
    return []
  }
}

/** The directories to watch for the extra globs (deduplicated). */
export function extraGlobDirs(globs: readonly string[], devRoot: string): string[] {
  return [...new Set(globs.map((g) => path.dirname(toOpenPath(devRoot, g))))]
}
