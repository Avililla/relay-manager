// Capture retention (§4.6): gzip previous days, delete by age, cap the total size fairly, disk guard.
import { createReadStream, createWriteStream, promises as fs } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import zlib from "node:zlib"
import { IdSchema } from "@/lib/contracts/common"
import { CaptureFileNameSchema, type CaptureFileDTO } from "@/lib/contracts/serial"

export interface ParsedCaptureName { date: string; index: number; input: boolean; compressed: boolean }

export function parseCaptureName(name: string): ParsedCaptureName | null {
  if (!CaptureFileNameSchema.safeParse(name).success) return null
  const m = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?(\.input)?\.log(\.gz)?$/.exec(name)
  if (!m) return null
  return { date: m[1], index: m[2] ? Number(m[2]) : 0, input: !!m[3], compressed: !!m[4] }
}

/** Newest first: date, then rollover index, then the main file before its .input.log sibling. */
function newestFirst(a: { name: string; p: ParsedCaptureName }, b: { name: string; p: ParsedCaptureName }): number {
  return b.p.date.localeCompare(a.p.date) || b.p.index - a.p.index || Number(a.p.input) - Number(b.p.input) || a.name.localeCompare(b.name)
}

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10)

export async function listCaptureFiles(consoleDir: string, includeInput: boolean): Promise<CaptureFileDTO[]> {
  let names: string[]
  try {
    names = await fs.readdir(consoleDir)
  } catch {
    return []
  }
  const parsed = names.flatMap((name) => {
    const p = parseCaptureName(name)
    return p && (includeInput || !p.input) ? [{ name, p }] : []
  }).sort(newestFirst)
  const out: CaptureFileDTO[] = []
  for (const { name, p } of parsed) {
    try {
      const st = await fs.stat(path.join(consoleDir, name))
      if (!st.isFile()) continue
      out.push({ name, date: p.date, sizeBytes: st.size, compressed: p.compressed, modifiedAt: st.mtime.toISOString(), input: p.input })
    } catch {
      /* removed meanwhile */
    }
  }
  return out
}

export interface RetentionOptions {
  captureDir: string
  retentionDays: number
  maxTotalBytes: number
  /** Absolute paths of the files currently open for writing: never compressed or deleted. */
  activeFiles: ReadonlySet<string>
  now: Date
}
export interface RetentionResult { compressed: number; deletedByAge: number; deletedBySize: number; freedBytes: number; totalBytes: number }

interface FileEntry { consoleId: string; name: string; full: string; p: ParsedCaptureName; size: number }

async function scanAll(captureDir: string): Promise<FileEntry[]> {
  let dirs: string[]
  try {
    dirs = await fs.readdir(captureDir)
  } catch {
    return []
  }
  const out: FileEntry[] = []
  for (const consoleId of dirs) {
    if (!IdSchema.safeParse(consoleId).success) continue
    const dir = path.join(captureDir, consoleId)
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const p = parseCaptureName(name)
      if (!p) continue
      try {
        const st = await fs.stat(path.join(dir, name))
        if (st.isFile()) out.push({ consoleId, name, full: path.join(dir, name), p, size: st.size })
      } catch {
        /* gone */
      }
    }
  }
  return out
}

async function gzipFile(src: string): Promise<string> {
  const dst = `${src}.gz`
  const tmp = `${dst}.tmp`
  await pipeline(createReadStream(src), zlib.createGzip(), createWriteStream(tmp, { mode: 0o640 }))
  await fs.rename(tmp, dst)
  await fs.rm(src, { force: true })
  return dst
}

export async function runRetention(o: RetentionOptions): Promise<RetentionResult> {
  const today = utcDay(o.now)
  const cutoff = utcDay(new Date(o.now.getTime() - (Math.max(1, o.retentionDays) - 1) * 86_400_000))
  const r: RetentionResult = { compressed: 0, deletedByAge: 0, deletedBySize: 0, freedBytes: 0, totalBytes: 0 }

  // 1. Compress previous days' plain files.
  for (const f of await scanAll(o.captureDir)) {
    if (f.p.compressed || f.p.date >= today || o.activeFiles.has(f.full)) continue
    try {
      await gzipFile(f.full)
      r.compressed++
    } catch {
      /* retried next run */
    }
  }

  // 2. Age.
  let files = await scanAll(o.captureDir)
  for (const f of files) {
    if (f.p.date >= cutoff || o.activeFiles.has(f.full)) continue
    try {
      await fs.rm(f.full, { force: true })
      r.deletedByAge++
      r.freedBytes += f.size
    } catch {
      /* ignore */
    }
  }

  // 3. Total size: evict the oldest non-active file of the console that currently uses the most bytes.
  files = await scanAll(o.captureDir)
  let total = files.reduce((s, f) => s + f.size, 0)
  const byConsole = new Map<string, FileEntry[]>()
  for (const f of files) {
    const list = byConsole.get(f.consoleId) ?? []
    list.push(f)
    byConsole.set(f.consoleId, list)
  }
  for (const list of byConsole.values()) list.sort((a, b) => -newestFirst({ name: a.name, p: a.p }, { name: b.name, p: b.p }))
  const used = (id: string) => (byConsole.get(id) ?? []).reduce((s, f) => s + f.size, 0)
  while (total > o.maxTotalBytes) {
    const candidates = [...byConsole.keys()].sort((a, b) => used(b) - used(a))
    let victim: FileEntry | null = null
    for (const id of candidates) {
      victim = (byConsole.get(id) ?? []).find((f) => !o.activeFiles.has(f.full)) ?? null
      if (victim) break
    }
    if (!victim) break
    const list = byConsole.get(victim.consoleId) ?? []
    list.splice(list.indexOf(victim), 1)
    try {
      await fs.rm(victim.full, { force: true })
      r.deletedBySize++
      r.freedBytes += victim.size
    } catch {
      /* ignore */
    }
    total -= victim.size
  }
  r.totalBytes = Math.max(0, total)
  return r
}

export interface StatfsLike { bsize: number; bavail: number; blocks: number }
export interface DiskGuardResult { paused: boolean; freeBytes: number; pauseBelow: number; resumeAbove: number }

const MiB = 1024 * 1024
const GiB = 1024 * MiB

/** pauseBelow = max(512 MiB, 2 % of the filesystem); resume above pauseBelow + 1 GiB (hysteresis, no flapping). */
export function diskGuard(paused: boolean, s: StatfsLike): DiskGuardResult {
  const freeBytes = s.bavail * s.bsize
  const pauseBelow = Math.max(512 * MiB, 0.02 * s.blocks * s.bsize)
  const resumeAbove = pauseBelow + GiB
  const next = paused ? freeBytes <= resumeAbove : freeBytes < pauseBelow
  return { paused: next, freeBytes, pauseBelow, resumeAbove }
}
