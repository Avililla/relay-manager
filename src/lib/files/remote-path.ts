// «Enviar a equipo»: the destination typed by the user, checked here (browser and server) and resolved on the server
// against the home folder of the SSH user on the equipment. POSIX paths; nothing is expanded by a shell (the server
// quotes every path it puts in a command).
//
//   "~"            → the user's home (the default)
//   "~/sub/dir"    → under the home
//   "/abs/path"    → as typed
//   "sub/dir"      → under the home too (what scp does with a relative path)
// If the result is an existing folder the file keeps its name inside it; otherwise it is the file name on the equipment
// (its folder must exist). A trailing "/" says "this must be a folder".

export const DEFAULT_SSH_USER = "root"
export const DEFAULT_SSH_PASSWORD = "root"
export const DEFAULT_REMOTE_PATH = "~"
export const REMOTE_PATH_MAX = 1024

export type RemotePath =
  | { ok: true; base: "home" | "absolute"; rest: string; trailingSlash: boolean }
  | { ok: false; error: string }

const CONTROL = /[\u0000-\u001f\u007f]/

/** Checks a typed destination. `rest` has no leading/trailing "/" and no empty segments (for "absolute", "" = "/"). */
export function checkRemotePath(raw: string): RemotePath {
  const s = raw.trim()
  if (!s) return { ok: false, error: "Escribe la ruta de destino (~ es la carpeta personal del usuario en el equipo)." }
  if (s.length > REMOTE_PATH_MAX) return { ok: false, error: `La ruta es demasiado larga (máximo ${REMOTE_PATH_MAX} caracteres).` }
  if (CONTROL.test(s)) return { ok: false, error: "La ruta no puede tener saltos de línea ni caracteres de control." }
  let base: "home" | "absolute"
  let body: string
  if (s === "~" || s.startsWith("~/")) {
    base = "home"
    body = s.slice(1)
  } else if (s.startsWith("~")) {
    return { ok: false, error: "Usa ~ solo para la carpeta personal del usuario con el que entras (~ o ~/carpeta)." }
  } else if (s.startsWith("/")) {
    base = "absolute"
    body = s
  } else {
    base = "home"
    body = `/${s}`
  }
  const trailingSlash = body.length > 1 && body.endsWith("/")
  const rest = body.split("/").filter((seg) => seg !== "" && seg !== ".").join("/")
  return { ok: true, base, rest, trailingSlash }
}

/** The absolute path on the equipment. `home` must be absolute. */
export function resolveRemotePath(p: Extract<RemotePath, { ok: true }>, home: string): string {
  const start = p.base === "home" ? home : "/"
  return remoteJoin(start, p.rest)
}

/** "/a" + "b/c" → "/a/b/c" (never a double slash; "/" + "" → "/"). */
export function remoteJoin(dir: string, rest: string): string {
  const d = dir.replace(/\/+$/, "")
  if (!rest) return d || "/"
  return `${d}/${rest}`
}

/** Parent folder of an absolute path ("/a/b" → "/a", "/a" → "/"). */
export function remoteDirname(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/")
  return i <= 0 ? "/" : p.slice(0, i)
}

export function remoteBasename(p: string): string {
  const t = p.replace(/\/+$/, "")
  return t.slice(t.lastIndexOf("/") + 1)
}

/** A file name that can travel in an scp "C" line and a quoted shell word (no "/", no control characters). */
export function remoteNameProblem(name: string): string | null {
  if (!name || name === "." || name === "..") return "Nombre de archivo no válido."
  if (name.includes("/") || CONTROL.test(name)) return `«${name.replace(CONTROL, "?")}» tiene caracteres que no se pueden enviar (saltos de línea o de control): cámbiale el nombre antes.`
  return null
}
