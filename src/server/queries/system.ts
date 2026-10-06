import "server-only"
// System read side (§7.4, W1-C): delegates to the W1-D ops services, never re-implements them.
import type { BackupDTO, HealthCheckDTO, SystemInfoDTO } from "@/lib/contracts/system"
import { getRuntime } from "@/server/runtime/registry"

export async function getSystemInfo(): Promise<SystemInfoDTO> {
  return getRuntime().ops.info()
}

export async function listBackups(): Promise<BackupDTO[]> {
  const list = await getRuntime().ops.backups.list()
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getHealth(): Promise<HealthCheckDTO[]> {
  return getRuntime().ops.health.run({ runtimeChecks: true })
}
