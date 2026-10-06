// Pure helpers of the Archivos page: URLs, breadcrumbs, sorting, filtering and live-refresh relevance.
import { DEFAULT_FILES_ROOT, FILES_API, type ArchiveFormat, type FileEntryDTO, type FilesChange, type FilesRootId } from "@/lib/contracts/files"
import { joinRel } from "./names"

export type SortKey = "name" | "size" | "mtime"
export interface SortState { key: SortKey; dir: "asc" | "desc" }

/** `root=<id>&` for the API (nothing for the default root: a missing root is "tftp"). */
const rootParam = (root: FilesRootId) => (root === DEFAULT_FILES_ROOT ? "" : `root=${encodeURIComponent(root)}&`)

/** The page address: `/archivos?raiz=extra&ruta=…` (no `raiz` for the default root, no `ruta` for its top folder). */
export function pageUrl(path: string, root: FilesRootId = DEFAULT_FILES_ROOT): string {
  const q = [root === DEFAULT_FILES_ROOT ? null : `raiz=${encodeURIComponent(root)}`, path ? `ruta=${encodeURIComponent(path)}` : null].filter(Boolean)
  return q.length ? `/archivos?${q.join("&")}` : "/archivos"
}
export const listUrl = (path: string, root: FilesRootId = DEFAULT_FILES_ROOT) => `${FILES_API.list}?${rootParam(root)}path=${encodeURIComponent(path)}`
export const downloadUrl = (path: string, root: FilesRootId = DEFAULT_FILES_ROOT) => `${FILES_API.download}?${rootParam(root)}path=${encodeURIComponent(path)}`
/** A folder (one name) or a selection of the folder `dir` as one archive. */
export function archiveUrl(dir: string, names: readonly string[], format: ArchiveFormat, root: FilesRootId = DEFAULT_FILES_ROOT): string {
  return `${FILES_API.archive}?${rootParam(root)}format=${encodeURIComponent(format)}&dir=${encodeURIComponent(dir)}${names.map((n) => `&name=${encodeURIComponent(n)}`).join("")}`
}

/** "a/b/c" → [{a, "a"}, {b, "a/b"}, {c, "a/b/c"}] */
export function crumbs(path: string): Array<{ name: string; path: string }> {
  if (!path) return []
  const out: Array<{ name: string; path: string }> = []
  let acc = ""
  for (const seg of path.split("/")) {
    acc = joinRel(acc, seg)
    out.push({ name: seg, path: acc })
  }
  return out
}

const collator = new Intl.Collator("es", { numeric: true, sensitivity: "base" })
const fold = (s: string) => s.toLocaleLowerCase("es").normalize("NFD").replace(/\p{M}/gu, "")

/** Folders first (always), then the chosen column; names break ties. */
export function sortEntries(entries: readonly FileEntryDTO[], sort: SortState): FileEntryDTO[] {
  const sign = sort.dir === "asc" ? 1 : -1
  const rank = (e: FileEntryDTO) => (e.kind === "dir" ? 0 : 1)
  return [...entries].sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r !== 0) return r
    const byName = collator.compare(a.name, b.name)
    if (sort.key === "name") return byName * sign
    const d = sort.key === "size" ? (a.size ?? -1) - (b.size ?? -1) : (Date.parse(a.mtime ?? "") || 0) - (Date.parse(b.mtime ?? "") || 0)
    return d !== 0 ? d * sign : byName
  })
}

export function filterEntries(entries: readonly FileEntryDTO[], query: string): FileEntryDTO[] {
  const q = fold(query.trim())
  return q ? entries.filter((e) => fold(e.name).includes(q)) : [...entries]
}

/**
 * Does a files.changed event touch the folder being shown (or one of its ancestors, for moves and deletes)? Only
 * events of the root being shown count (an event without a root is of the default one).
 */
export function affectsFolder(ev: { root?: FilesRootId; dirs: readonly string[]; change: FilesChange }, current: string, currentRoot: FilesRootId = DEFAULT_FILES_ROOT): boolean {
  if ((ev.root ?? DEFAULT_FILES_ROOT) !== currentRoot) return false
  return ev.dirs.some((d) => d === current || ((ev.change === "rename" || ev.change === "move" || ev.change === "delete") && (d === "" ? current !== "" : current.startsWith(`${d}/`))))
}

export function totals(entries: readonly FileEntryDTO[]): { dirs: number; files: number; bytes: number } {
  let dirs = 0
  let files = 0
  let bytes = 0
  for (const e of entries) {
    if (e.kind === "dir") dirs++
    else if (e.kind === "file") {
      files++
      bytes += e.size ?? 0
    }
  }
  return { dirs, files, bytes }
}
