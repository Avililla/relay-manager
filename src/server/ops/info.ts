// System info (§4.14): the one implementation behind getSystemInfo() (W1-C) and /sistema/acerca.
import fs from "node:fs"
import os from "node:os"
import type { SystemInfoDTO } from "@/lib/contracts/system"
import type { AppConfig } from "@/server/config/schema"
import { serverUrls } from "@/server/boot/banner"
import { nodeHealthFs } from "./health"

function fileSize(p: string): number {
  try { return fs.statSync(p).size } catch { return 0 }
}

/** DB size including its -wal and -shm files. */
export function dbSizeBytes(dbFile: string): number {
  return fileSize(dbFile) + fileSize(`${dbFile}-wal`) + fileSize(`${dbFile}-shm`)
}

export function computeSystemInfo(opts: {
  config: AppConfig
  startedAt: Date
  captureBytes?: number | null
  now?: () => Date
}): SystemInfoDTO {
  const c = opts.config
  const now = opts.now?.() ?? new Date()
  return {
    version: c.build.version,
    rev: c.build.rev,
    buildId: c.build.buildId,
    builtAt: c.build.builtAt,
    node: process.versions.node,
    mode: c.mode,
    host: c.host,
    port: c.port,
    tls: c.tls !== null,
    dataDir: c.dataDir,
    dbFile: c.dbFile,
    dbSizeBytes: dbSizeBytes(c.dbFile),
    captureDir: c.captureDir,
    captureSizeBytes: opts.captureBytes ?? nodeHealthFs().dirSize(c.captureDir),
    backupDir: c.backupDir,
    configFile: c.configFile,
    urls: serverUrls(c),
    startedAt: opts.startedAt.toISOString(),
    uptimeSec: Math.max(0, Math.round((now.getTime() - opts.startedAt.getTime()) / 1000)),
    platform: `${os.type()} ${os.release()} ${process.arch}`,
  }
}
