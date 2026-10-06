"use server"
// System actions (§7.2, W1-C): backups (W1-D services), config import, health checks. Admin only.
import { revalidatePath } from "next/cache"
import { EmptyInputSchema } from "@/lib/contracts/common"
import { ImportConfigInputSchema, type ImportReportDTO } from "@/lib/contracts/config-io"
import { BackupRefInputSchema, CreateBackupInputSchema, type BackupDTO, type HealthCheckDTO } from "@/lib/contracts/system"
import { defineAction } from "@/server/actions/define-action"
import { afterCommit } from "@/server/services/common"
import { importConfigDetailed } from "@/server/services/config-io"

function refresh(path: string, type?: "layout" | "page"): void {
  try {
    revalidatePath(path, type)
  } catch {
    // outside a request scope (tests): nothing to revalidate
  }
}

/** "Crear copia ahora": label `manual`; the backup service audits backup.create. */
export const createBackup = defineAction(CreateBackupInputSchema, { auth: "admin" },
  async function createBackup(_input, ctx): Promise<BackupDTO> {
    const b = await ctx.rt.ops.backups.create("manual", ctx.actor)
    refresh("/sistema/copias")
    return b
  })

/** The backup service validates the name and audits backup.delete. */
export const deleteBackup = defineAction(BackupRefInputSchema, { auth: "admin" },
  async function deleteBackup(input, ctx): Promise<null> {
    await ctx.rt.ops.backups.remove(input.name, ctx.actor)
    refresh("/sistema/copias")
    return null
  })

/** Dry run first in the UI (§8.9). A real import reloads consoles and relays and refreshes the settings cache. */
export const importConfig = defineAction(ImportConfigInputSchema, { auth: "admin" },
  async function importConfig(input, ctx): Promise<ImportReportDTO> {
    const { rt, actor } = ctx
    const result = await importConfigDetailed(rt.prisma, input.json, { dryRun: input.dryRun, accessPorts: rt.accesses.settings() }, actor)
    if (input.dryRun) return result.report
    for (const id of result.createdEquipmentIds) {
      await afterCommit(rt.log, "recargar consolas", () => rt.serial.consoles.reloadEquipment(id))
      await afterCommit(rt.log, "recargar accesos", () => rt.accesses.reloadEquipment(id))
      rt.bus.publish({ type: "equipment.changed", equipmentId: id, change: "created" }, { kind: "all" })
    }
    await afterCommit(rt.log, "recargar relés", () => rt.relays.controller.reload())
    await afterCommit(rt.log, "recargar etiquetas", () => rt.accesses.reloadLabels())
    if (result.settingsChanged) {
      await afterCommit(rt.log, "recargar ajustes", () => rt.settings.reload())
      const s = rt.settings.get()
      rt.bus.publish({ type: "settings.changed", labName: s.labName, bannerText: s.bannerText, reservationWarningMin: s.reservationWarningMin }, { kind: "all" })
    }
    rt.audit.record({
      actor, action: "config.import", target: { type: "config" },
      detail: { created: result.report.created, skipped: result.report.skipped.length, warnings: result.report.warnings.length },
    })
    refresh("/", "layout")
    return result.report
  })

export const runHealthChecks = defineAction(EmptyInputSchema, { auth: "admin" },
  async function runHealthChecks(_input, ctx): Promise<HealthCheckDTO[]> {
    return ctx.rt.ops.health.run({ runtimeChecks: true })
  })
