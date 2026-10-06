// Settings service (§4.3): cached global row, validated partial updates, settings.changed events and an audited diff.
import type { PrismaClient } from "@/generated/prisma/client"
import type { JsonValue } from "@/lib/contracts/common"
import { InputCaptureSchema } from "@/lib/contracts/enums"
import { UpdateSettingsInputSchema, type SettingsDTO, type UpdateSettingsInput } from "@/lib/contracts/settings"
import { toFieldErrors } from "@/server/actions/field-errors"
import { DomainError } from "@/server/errors"
import { errorMessage } from "@/lib/i18n/errors"
import type { AuditService, EventBus, SettingsService } from "@/server/runtime/types"

type SettingsRow = Awaited<ReturnType<PrismaClient["settings"]["findUniqueOrThrow"]>>

export function toSettingsDTO(r: SettingsRow): SettingsDTO {
  const ic = InputCaptureSchema.safeParse(r.inputCapture)
  return {
    labName: r.labName,
    bannerText: r.bannerText,
    reservationTimeoutMin: r.reservationTimeoutMin,
    reservationWarningMin: r.reservationWarningMin,
    captureRetentionDays: r.captureRetentionDays,
    captureMaxTotalMb: r.captureMaxTotalMb,
    captureMaxFileMb: r.captureMaxFileMb,
    inputCapture: ic.success ? ic.data : "markers",
    auditRetentionDays: r.auditRetentionDays,
    backupDailyEnabled: r.backupDailyEnabled,
    backupDailyHour: r.backupDailyHour,
    backupRetentionCount: r.backupRetentionCount,
    setupCompletedAt: r.setupCompletedAt ? r.setupCompletedAt.toISOString() : null,
    updatedAt: r.updatedAt.toISOString(),
  }
}

const PUBLIC_FIELDS = ["labName", "bannerText", "reservationWarningMin"] as const

export async function createSettingsService(deps: { prisma: PrismaClient; bus: EventBus; audit: AuditService }): Promise<SettingsService> {
  const load = async () => toSettingsDTO(await deps.prisma.settings.upsert({ where: { id: "global" }, create: {}, update: {} }))
  let cache = await load()

  return {
    get: () => cache,
    async reload() { cache = await load() },
    async update(patch, actor) {
      const parsed = UpdateSettingsInputSchema.safeParse(patch)
      if (!parsed.success) throw new DomainError("VALIDATION", errorMessage("VALIDATION"), toFieldErrors(parsed.error))
      const data: UpdateSettingsInput = parsed.data
      const before = cache
      const merged = { ...before, ...data }
      if (merged.reservationWarningMin >= merged.reservationTimeoutMin) {
        throw new DomainError("VALIDATION", errorMessage("VALIDATION"), {
          reservationWarningMin: ["El aviso debe ser menor que la duración de la reserva"],
        })
      }
      const row = await deps.prisma.settings.update({
        where: { id: "global" },
        data: { ...data, updatedById: actor.kind === "user" ? actor.id : null },
      })
      cache = toSettingsDTO(row)
      const changed: Record<string, JsonValue> = {}
      for (const k of Object.keys(data) as Array<keyof UpdateSettingsInput>) {
        const a = before[k]
        const b = cache[k]
        if (a !== b) changed[k] = [a ?? null, b ?? null]
      }
      if (PUBLIC_FIELDS.some((k) => k in changed)) {
        deps.bus.publish(
          { type: "settings.changed", labName: cache.labName, bannerText: cache.bannerText, reservationWarningMin: cache.reservationWarningMin },
          { kind: "all" },
        )
      }
      if (Object.keys(changed).length) {
        deps.audit.record({ actor, action: "settings.update", target: { type: "settings", id: "global", name: "Ajustes" }, detail: { changed } })
      }
      return cache
    },
  }
}
