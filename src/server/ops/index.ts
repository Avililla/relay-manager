// Ops services (§4.14): backups with the daily scheduler, health checks and system info. Created once by boot/start.ts.
import fs from "node:fs"
import path from "node:path"
import type { HealthService, OpsDeps, OpsServices } from "@/server/runtime/types"
import { createBackupStore, createDailyBackupScheduler } from "./backup"
import { nodeHealthContext, runHealthChecks } from "./health"
import { computeSystemInfo, dbSizeBytes } from "./info"

/** Free bytes on the filesystem of `dir` (or of its nearest existing parent). */
export function freeBytesFor(dir: string): number | null {
  let p = dir
  for (;;) {
    try {
      const s = fs.statfsSync(p)
      return s.bavail * s.bsize
    } catch {
      const parent = path.dirname(p)
      if (parent === p) return null
      p = parent
    }
  }
}

export function createOpsServices(deps: OpsDeps): OpsServices {
  const cfg = deps.config
  const log = deps.log.child("backup")
  const startedAt = new Date()

  const backups = createBackupStore({
    dbFile: cfg.dbFile,
    backupDir: cfg.backupDir,
    appVersion: cfg.build.version,
    audit: (input) => deps.audit.record(input),
    retention: () => ({ daily: deps.settings.get().backupRetentionCount }),
  })

  const scheduler = createDailyBackupScheduler({
    store: backups,
    settings: () => deps.settings.get(),
    captureState: () => deps.getRuntime()?.serial.stats().capture.state ?? null,
    freeBytes: () => freeBytesFor(cfg.backupDir),
    dbBytes: () => dbSizeBytes(cfg.dbFile),
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
  })

  const health: HealthService = {
    run: (opts) => runHealthChecks(nodeHealthContext({
      config: cfg,
      doctor: false,
      rt: deps.getRuntime() ?? null,
      backups: () => backups.list(),
      dailySkip: () => scheduler.lastSkip(),
    }), opts),
  }

  return {
    backups,
    health,
    async info() {
      const rt = deps.getRuntime()
      const capture = rt?.serial.stats().capture
      return computeSystemInfo({
        config: cfg,
        startedAt: rt?.state.startedAt ?? startedAt,
        captureBytes: capture && capture.state !== "off" ? capture.totalBytes : null,
      })
    },
    async start() { scheduler.start() },
    async stop() { scheduler.stop() },
  }
}
