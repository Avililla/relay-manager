// Capture service (§4.6): one writer per console, retention (hourly, at start, after every size rollover),
// disk guard every 60 s, listing and download paths.
import fs from "node:fs"
import path from "node:path"
import { IdSchema } from "@/lib/contracts/common"
import { CaptureFileNameSchema, type CaptureFileDTO, type CaptureState } from "@/lib/contracts/serial"
import { SERIAL_LOG } from "@/lib/i18n/serial"
import type { Logger } from "@/server/log"
import { SYSTEM_ACTOR, type AuditService, type SettingsService } from "@/server/runtime/types"
import { diskGuard, listCaptureFiles, runRetention, type StatfsLike } from "./retention"
import { CaptureWriter, type CaptureMeta } from "./writer"

export interface ConsoleCapture {
  writeRx(chunk: Buffer): void
  writeInput(user: string, bytes: Buffer): void
  marker(text: string): void
  openMarker(devNode: string, line: string): void
  updateMeta(meta: CaptureMeta): void
  flush(): Promise<void>
}

const NOOP: ConsoleCapture = {
  writeRx() {}, writeInput() {}, marker() {}, openMarker() {}, updateMeta() {}, flush: async () => {},
}

export interface CaptureServiceDeps {
  captureDir: string
  enabled: boolean
  settings: SettingsService
  audit: AuditService
  log: Logger
  now?: () => Date
  statfs?: (dir: string) => Promise<StatfsLike>
  maxFileBytes?: () => number
  maxTotalBytes?: () => number
  diskCheckMs?: number
  retentionMs?: number
}

export interface CaptureService {
  start(): Promise<void>
  stop(): Promise<void>
  /** The console's writer (a no-op when capture is off or the console has captureToDisk=false). */
  writer(meta: CaptureMeta, captureToDisk: boolean): ConsoleCapture
  /** Closes and forgets the console's writer (console deleted, or captureToDisk turned off). */
  release(consoleId: string): Promise<void>
  state(): "on" | "off" | "paused-disk"
  consoleState(captureToDisk: boolean): CaptureState
  totalBytes(): number
  lastPurgeAt(): string | null
  list(consoleId: string, includeInput: boolean): Promise<CaptureFileDTO[]>
  filePath(consoleId: string, name: string): string | null
  runRetention(): Promise<void>
  checkDisk(): Promise<void>
  /** Resolves when no retention run is pending (tests, shutdown). */
  idle(): Promise<void>
  onStateChange(cb: (state: "on" | "paused-disk") => void): () => void
}

const MiB = 1024 * 1024

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  const log = deps.log.child("capture")
  const now = deps.now ?? (() => new Date())
  const statfs = deps.statfs ?? ((dir: string) => fs.promises.statfs(dir))
  const maxFileBytes = deps.maxFileBytes ?? (() => deps.settings.get().captureMaxFileMb * MiB)
  const maxTotalBytes = deps.maxTotalBytes ?? (() => deps.settings.get().captureMaxTotalMb * MiB)
  const writers = new Map<string, CaptureWriter>()
  const marks = new Map<CaptureWriter, number>()
  const listeners = new Set<(s: "on" | "paused-disk") => void>()
  let paused = false
  let baseline = 0
  let lastPurge: Date | null = null
  let running: Promise<void> | null = null
  let again = false
  let rolloverTimer: NodeJS.Timeout | null = null
  let diskTimer: NodeJS.Timeout | null = null
  let retentionTimer: NodeJS.Timeout | null = null
  let lastWriteErrorAt = 0

  const onWriteError = (err: unknown) => {
    // One line per minute at most: a full or read-only disk would otherwise flood the log.
    if (Date.now() - lastWriteErrorAt < 60_000) return
    lastWriteErrorAt = Date.now()
    log.error(SERIAL_LOG.captureWriteError, { err })
  }

  function scheduleRetention(delay = 100): void {
    if (rolloverTimer) return
    rolloverTimer = setTimeout(() => {
      rolloverTimer = null
      void runRetentionNow()
    }, delay)
    rolloverTimer.unref()
  }

  async function retentionOnce(): Promise<void> {
    const active = new Set([...writers.values()].flatMap((w) => w.activeFiles()))
    const s = deps.settings.get()
    const r = await runRetention({ captureDir: deps.captureDir, retentionDays: s.captureRetentionDays, maxTotalBytes: maxTotalBytes(), activeFiles: active, now: now() })
    baseline = r.totalBytes
    for (const w of writers.values()) marks.set(w, w.bytesWritten)
    lastPurge = now()
    const deleted = r.deletedByAge + r.deletedBySize
    if (deleted || r.compressed) {
      log.info(SERIAL_LOG.retention, { comprimidos: r.compressed, borradosPorEdad: r.deletedByAge, borradosPorTamano: r.deletedBySize, liberados: r.freedBytes, total: r.totalBytes })
    }
    if (deleted) {
      deps.audit.record({
        actor: SYSTEM_ACTOR, action: "console.capture.purge",
        detail: { deletedByAge: r.deletedByAge, deletedBySize: r.deletedBySize, compressed: r.compressed, freedBytes: r.freedBytes, totalBytes: r.totalBytes },
      })
    }
  }

  function runRetentionNow(): Promise<void> {
    if (!deps.enabled) return Promise.resolve()
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await retentionOnce()
        } while (again)
      } catch (err) {
        log.error("Error en la retención de capturas", { err })
      } finally {
        running = null
      }
    })()
    return running
  }

  async function checkDisk(): Promise<void> {
    if (!deps.enabled) return
    let s: StatfsLike
    try {
      s = await statfs(deps.captureDir)
    } catch {
      return
    }
    const g = diskGuard(paused, s)
    if (g.paused === paused) return
    paused = g.paused
    if (paused) log.warn(SERIAL_LOG.capturePaused, { libre: g.freeBytes, umbral: Math.round(g.pauseBelow) })
    else log.info(SERIAL_LOG.captureResumed, { libre: g.freeBytes })
    for (const l of [...listeners]) {
      try { l(paused ? "paused-disk" : "on") } catch (err) { log.error("Error al notificar el estado de la captura", { err }) }
    }
  }

  return {
    async start() {
      if (!deps.enabled) return
      try {
        fs.mkdirSync(deps.captureDir, { recursive: true, mode: 0o750 })
      } catch (err) {
        log.error("No se puede crear el directorio de capturas", { dir: deps.captureDir, err })
      }
      await checkDisk()
      void runRetentionNow()
      diskTimer = setInterval(() => { void checkDisk() }, deps.diskCheckMs ?? 60_000)
      diskTimer.unref()
      retentionTimer = setInterval(() => { void runRetentionNow() }, deps.retentionMs ?? 3_600_000)
      retentionTimer.unref()
    },
    async stop() {
      if (diskTimer) clearInterval(diskTimer)
      if (retentionTimer) clearInterval(retentionTimer)
      if (rolloverTimer) clearTimeout(rolloverTimer)
      diskTimer = retentionTimer = rolloverTimer = null
      const all = [...writers.values()]
      writers.clear()
      await Promise.all(all.map((w) => w.close()))
      if (running) await running
    },
    writer(meta, captureToDisk) {
      if (!deps.enabled || !captureToDisk || !IdSchema.safeParse(meta.consoleId).success) return NOOP
      const existing = writers.get(meta.consoleId)
      if (existing) {
        existing.updateMeta(meta)
        return existing
      }
      const w = new CaptureWriter({
        dir: path.join(deps.captureDir, meta.consoleId),
        meta,
        now,
        maxFileBytes,
        inputMode: () => deps.settings.get().inputCapture,
        paused: () => paused,
        onRollover: () => scheduleRetention(),
        onError: onWriteError,
      })
      writers.set(meta.consoleId, w)
      marks.set(w, 0)
      return w
    },
    async release(consoleId) {
      const w = writers.get(consoleId)
      if (!w) return
      writers.delete(consoleId)
      baseline += w.bytesWritten - (marks.get(w) ?? 0)
      marks.delete(w)
      await w.close()
    },
    state: () => (!deps.enabled ? "off" : paused ? "paused-disk" : "on"),
    consoleState: (captureToDisk) => (!deps.enabled ? "off" : !captureToDisk ? "disabled" : paused ? "paused-disk" : "active"),
    totalBytes: () => baseline + [...writers.values()].reduce((s, w) => s + w.bytesWritten - (marks.get(w) ?? 0), 0),
    lastPurgeAt: () => lastPurge?.toISOString() ?? null,
    async list(consoleId, includeInput) {
      if (!IdSchema.safeParse(consoleId).success) return []
      return listCaptureFiles(path.join(deps.captureDir, consoleId), includeInput)
    },
    filePath(consoleId, name) {
      if (!IdSchema.safeParse(consoleId).success || !CaptureFileNameSchema.safeParse(name).success) return null
      const p = path.join(deps.captureDir, consoleId, name)
      try {
        return fs.statSync(p).isFile() ? p : null
      } catch {
        return null
      }
    },
    runRetention: runRetentionNow,
    checkDisk,
    async idle() {
      while (running || rolloverTimer) {
        if (running) await running
        else await new Promise((r) => setTimeout(r, 20))
      }
    },
    onStateChange(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  }
}
