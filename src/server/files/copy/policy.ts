// «Copiar a una carpeta del servidor»: where a copy may go. Pure (no I/O): shared by the service (Graph A) and the
// root helper (rootcopy.js). Every check runs on the REAL path of the destination (links resolved), never on what the
// client typed, and the helper repeats it on its own.

/** System folders and the app's own folders: never a destination (RM_COPY_DENY adds more; these always apply). */
export const DEFAULT_COPY_DENY: readonly string[] = [
  "/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32",
  "/var/lib/relay-manager", "/var/lib/relay-manager-rootcopy", "/opt/relay-manager",
]
/** Inside a denied folder but allowed: where udisks mounts removable media on some desktops. */
export const DENY_EXCEPTIONS: readonly string[] = ["/run/media"]
/** Where the root helper may write by default (RM_COPY_ROOT_PATHS): removable media and manual mounts. */
export const DEFAULT_ROOT_WRITE_PATHS: readonly string[] = ["/media", "/run/media", "/mnt"]
/** Groups whose members may authenticate a copy as root (RM_COPY_SUDO_GROUPS). */
export const DEFAULT_SUDO_GROUPS: readonly string[] = ["sudo", "wheel", "admin"]

export interface CopyPolicy {
  /** Browsable and writable roots (RM_COPY_ROOTS, "/" by default). */
  roots: readonly string[]
  /** Denied folders: DEFAULT_COPY_DENY + RM_COPY_DENY + the app's data, backups, captures, application. */
  deny: readonly string[]
}

const CONTROL = /[\u0000-\u001f\u007f]/

/** child is parent or inside it (both normalised absolute paths). */
export function within(child: string, parent: string): boolean {
  if (parent === "/") return child.startsWith("/")
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * A server path typed or picked in the dialog: absolute, "/"-separated, without "." or ".." segments, NUL or control
 * characters; repeated and trailing slashes are dropped. null when not acceptable.
 */
export function normalizeAbs(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || !raw.startsWith("/") || CONTROL.test(raw)) return null
  const segs = raw.split("/").filter((s) => s !== "")
  if (segs.some((s) => s === "." || s === ".." || new TextEncoder().encode(s).length > 255)) return null
  return `/${segs.join("/")}`
}

/** A comma-separated list of absolute paths (config); throws a Spanish message naming the bad entry. */
export function parsePathList(raw: string, name: string): string[] {
  const out: string[] = []
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const p = normalizeAbs(part)
    if (!p) throw new Error(`${name}: «${part}» no es una ruta absoluta válida`)
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/** The policy for the app: the defaults plus the extra denied folders and the app's own folders. */
export function buildPolicy(roots: readonly string[], extraDeny: readonly string[], appDirs: readonly (string | null | undefined)[]): CopyPolicy {
  const deny = [...DEFAULT_COPY_DENY, ...extraDeny]
  for (const d of appDirs) {
    const n = d ? normalizeAbs(d) : null
    if (n && n !== "/" && !deny.includes(n)) deny.push(n)
  }
  return { roots: roots.length ? [...roots] : ["/"], deny }
}

/** Inside the allowed roots (or one of them): browsing is allowed there. */
export function inRoots(real: string, policy: CopyPolicy): boolean {
  return policy.roots.some((r) => within(real, r))
}

/** Why nothing may be written in `real` (a real, normalised path), in Spanish; null when it is allowed. */
export function denyReason(real: string, policy: CopyPolicy): string | null {
  if (!inRoots(real, policy)) return `Fuera de las carpetas permitidas (${policy.roots.join(", ")}; RM_COPY_ROOTS).`
  return protectedReason(real, policy)
}

/**
 * Like denyReason, also for the other names of the folder on its filesystem (aliasesOf in mounts.ts: a bind mount of
 * /etc under /mnt is still /etc). Only the protected folders apply to the aliases, not RM_COPY_ROOTS.
 */
export function denyReasonWithAliases(real: string, aliases: readonly string[], policy: CopyPolicy): string | null {
  const direct = denyReason(real, policy)
  if (direct) return direct
  for (const a of aliases) {
    const why = protectedReason(a, policy)
    if (why) return `${why} (${real} es la misma carpeta, montada en otro sitio)`
  }
  return null
}

/** The deny-list alone: the root of the system and the protected folders. */
function protectedReason(real: string, policy: CopyPolicy): string | null {
  if (real === "/") return "No se copia en la raíz del sistema («/»): elige una carpeta."
  if (DENY_EXCEPTIONS.some((e) => within(real, e))) {
    // Still refused when an explicit denied folder is inside the exception (RM_COPY_DENY=/run/media/x).
    const inner = policy.deny.find((d) => DENY_EXCEPTIONS.some((e) => within(d, e)) && within(real, d))
    return inner ? protectedMessage(inner) : null
  }
  const hit = policy.deny.find((d) => within(real, d))
  return hit ? protectedMessage(hit) : null
}

function protectedMessage(folder: string): string {
  return `«${folder}» es una carpeta del sistema o de Relay Manager: no se copia ahí.`
}

/** Why the root helper may not write in `real` (outside RM_COPY_ROOT_PATHS); null when it may. */
export function rootWriteReason(real: string, writePaths: readonly string[]): string | null {
  if (writePaths.some((p) => within(real, p))) return null
  return `Como administrador solo se copia dentro de ${listEs(writePaths)} (RM_COPY_ROOT_PATHS).`
}

function listEs(items: readonly string[]): string {
  if (items.length === 0) return "(ninguna carpeta)"
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(", ")} o ${items[items.length - 1]}`
}
