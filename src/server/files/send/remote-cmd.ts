// Commands run on the equipment over SSH exec («Enviar a equipo»). Every path goes through shq() (one single-quoted
// shell word: nothing inside is expanded) and every path is absolute, so none can be taken for an option. Only POSIX
// sh and busybox applets (test, echo, chmod, mv, rm, wc, df, sha256sum/md5sum, scp) are used.

/** One single-quoted POSIX shell word: 'it'\''s' for it's. */
export function shq(s: string): string {
  if (s.includes("\0")) throw new Error("NUL en un argumento")
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function abs(p: string): string {
  if (!p.startsWith("/")) throw new Error(`Ruta no absoluta: ${p}`)
  return shq(p)
}

export const remoteCmd = {
  /** The login's home folder (when SFTP realpath is not available). */
  home: () => `echo "$HOME"`,
  /** dir | file | missing (the parent is a folder) | noparent. */
  probe: (p: string, parent: string) =>
    `if [ -d ${abs(p)} ]; then echo dir; elif [ -e ${abs(p)} ]; then echo file; elif [ -d ${abs(parent)} ]; then echo missing; else echo noparent; fi`,
  /** Is `p` a folder (final target taken by a folder)? */
  isDir: (p: string) => `if [ -d ${abs(p)} ]; then echo dir; elif [ -e ${abs(p)} ]; then echo file; else echo none; fi`,
  /** The scp sink writing into `dir`. */
  scpSink: (dir: string) => `scp -t ${abs(dir)}`,
  /** Mode and atomic move into place (mv over an existing file replaces it). */
  commit: (tmp: string, final: string, mode: number) => `chmod ${(mode & 0o777).toString(8)} ${abs(tmp)} && mv -f ${abs(tmp)} ${abs(final)}`,
  remove: (p: string) => `rm -f ${abs(p)}`,
  size: (p: string) => `wc -c < ${abs(p)}`,
  /** Free space of the filesystem of `dir` in KiB (POSIX output: the 4th field of the 2nd line). */
  freeKb: (dir: string) => `df -Pk ${abs(dir)}`,
  checksum: (algo: "sha256" | "md5", p: string) => `${algo}sum ${abs(p)}`,
}

/** `df -Pk` → free bytes, or null. */
export function parseDfFree(out: string): number | null {
  const lines = out.trim().split("\n")
  const last = lines[lines.length - 1]?.trim().split(/\s+/) ?? []
  // Filesystem 1024-blocks Used Available Capacity Mounted-on (a long device name may wrap: then the line has 5).
  const avail = last.length >= 6 ? last[3] : last.length === 5 ? last[2] : undefined
  const n = avail !== undefined ? Number(avail) : NaN
  return Number.isFinite(n) && n >= 0 ? n * 1024 : null
}

/** "<hex>  <file>" → hex, or null. */
export function parseChecksum(out: string, algo: "sha256" | "md5"): string | null {
  const m = (algo === "sha256" ? /^\s*\\?([0-9a-fA-F]{64})\b/ : /^\s*\\?([0-9a-fA-F]{32})\b/).exec(out)
  return m ? m[1].toLowerCase() : null
}
