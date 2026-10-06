import "server-only"
// Read side of "Archivos": the first listing of the page (the client refreshes it through /api/files/list).
import { parseFilesRoot, type FilesPageDTO, type FilesPageErrorKind } from "@/lib/contracts/files"
import { parseRelPath } from "@/lib/files/names"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser } from "@/server/runtime/types"
import { isDomainError } from "@/server/errors"
import { filesRootLabel } from "@/server/files/roots"

/** `raiz`: the root of the page (`?raiz=`, "tftp" when absent); `ruta`: the folder inside it. */
export async function getFilesPage(user: AuthUser, raiz: string | undefined, ruta: string): Promise<FilesPageDTO> {
  const rt = getRuntime()
  const settings = rt.files.settings()
  const parsed = parseRelPath(ruta)
  const roots = rt.files.roots().map((r) => ({ ...r, path: user.isAdmin ? r.path : null }))
  const asked = parseFilesRoot(raiz)
  const root = asked ?? "tftp"
  const shown = roots.find((r) => r.id === root)
  // «Descargas» lives in one root (RM_EXPORT_ROOT) and only when the profile turns it on (RM_EXPORT_ENABLED).
  const exportRoot = rt.config.exports.enabled && roots.some((r) => r.id === rt.config.exports.root) ? rt.config.exports.root : null
  const base: FilesPageDTO = {
    root,
    roots,
    exportRoot,
    exports: root === exportRoot && shown ? await rt.files.exportInfo() : null,
    settings,
    canDelete: user.isAdmin || !settings.deleteAdminOnly,
    canCopy: user.isAdmin && rt.config.copy.enabled,
    rootPath: user.isAdmin ? shown?.path ?? null : null,
    path: parsed.ok ? parsed.path : "",
    listing: null,
    error: null,
  }
  if (!rt.config.files.enabled) {
    return { ...base, error: { kind: "unavailable", message: "Archivos está desactivado en este servidor (RM_FILES_ENABLED=0)." } }
  }
  if (!asked) return { ...base, error: { kind: "invalid", message: "La carpeta de la dirección no es válida." } }
  if (!shown) return { ...base, error: { kind: "unavailable", message: `La carpeta ${filesRootLabel(rt.config.files, root).label} no está disponible en este servidor.` } }
  if (!parsed.ok) return { ...base, error: { kind: "invalid", message: "La ruta de la dirección no es válida." } }
  try {
    return { ...base, listing: await rt.files.list(root, parsed.path) }
  } catch (e) {
    if (!isDomainError(e)) throw e
    const files = e.details?.files
    const kind: FilesPageErrorKind = files === "NOT_FOUND" ? "not-found"
      : files === "INVALID" && e.details?.notDir === true ? "not-dir"
      : files === "INVALID" ? "invalid"
      : "unavailable"
    return { ...base, error: { kind, message: e.message } }
  }
}
