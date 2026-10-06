// Configuration export/import (§4.15, W1-C), used by the UI (system actions and /api/config/export) and by the W1-D CLI.
// Export carries no users and no board passwords. Import merges by name in one transaction; a dry run rolls it back.
import path from "node:path"
import type { Prisma, PrismaClient } from "@/generated/prisma/client"
import { ConfigExportV1Schema, type ConfigExportV1, type ImportReportDTO } from "@/lib/contracts/config-io"
import { DriverIdSchema } from "@/lib/contracts/enums"
import { AccessKindSchema, AccessPolicySchema, CableSerialSchema } from "@/lib/contracts/accesses"
import { portIssue, type PortRange } from "@/lib/accesses/ports"
import { accessErrors } from "@/lib/i18n/accesses"
import { BoardOptionsSchema } from "@/lib/contracts/relays"
import { domainFormat, domainText } from "@/lib/i18n/domain"
import { DEFAULT_LAB_NAME } from "@/lib/i18n/common"
import { errorMessage } from "@/lib/i18n/errors"
import { toFieldErrors } from "@/server/actions/field-errors"
import { DomainError } from "@/server/errors"
import type { ActorRef } from "@/server/runtime/types"
import { bindingRecordFromRow, byName, enterModeOf, lineFromRow, parseTemplateSpec, purposeOf, sameName } from "./dto"

type Tx = Prisma.TransactionClient
type Db = PrismaClient | Tx

const PATH_NOT_ALLOWED = "Ruta de dispositivo no permitida"

// ---------------------------------------------------------------------------------------------------------------------
// Export

export async function exportConfig(prisma: Db, opts: { appVersion?: string; now?: Date } = {}): Promise<ConfigExportV1> {
  const settings = await prisma.settings.findUnique({ where: { id: "global" }, select: { labName: true, bannerText: true } })
  const roles = await prisma.role.findMany({ select: { name: true, description: true } })
  const templates = await prisma.equipmentTemplate.findMany()
  const boards = await prisma.relayBoard.findMany()
  const labels = await prisma.cableLabel.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] })
  const equipment = await prisma.equipment.findMany({
    include: {
      accesses: { orderBy: { position: "asc" }, include: { console: { select: { key: true } } } },
      template: { select: { name: true } },
      roles: { select: { name: true } },
      consoles: { orderBy: { position: "asc" } },
      relays: { orderBy: { position: "asc" }, include: { board: { select: { name: true } } } },
    },
  })
  const cfg: ConfigExportV1 = {
    format: "relay-manager-config",
    version: 1,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    appVersion: opts.appVersion ?? "desconocida",
    settings: { labName: settings?.labName ?? DEFAULT_LAB_NAME, bannerText: settings?.bannerText ?? null },
    roles: roles.sort(byName).map((r) => ({ name: r.name, description: r.description })),
    templates: templates.sort(byName).map((t) => ({
      key: t.key, name: t.name, description: t.description, source: t.source === "file" ? "file" as const : "local" as const, sourceFile: t.sourceFile,
      needsReview: t.needsReview, spec: parseTemplateSpec(t.spec),
    })),
    boards: boards.sort(byName).flatMap((b) => {
      const driver = DriverIdSchema.safeParse(b.driver)
      if (!driver.success) return []
      const options = BoardOptionsSchema.safeParse(b.options ?? {})
      return [{
        name: b.name, driver: driver.data, host: b.host, httpPort: b.httpPort, tcpPort: b.tcpPort, model: b.model, moduleId: b.moduleId,
        mac: b.mac, relayCount: b.relayCount, options: options.success ? options.data : {}, username: b.username, enabled: b.enabled,
        hasPassword: !!b.password,
      }]
    }),
    equipment: equipment.sort(byName).map((e) => ({
      name: e.name, serialNumber: e.serialNumber, description: e.description,
      templateName: e.template?.name ?? e.templateName,
      roles: e.roles.map((r) => r.name).sort((a, b) => a.localeCompare(b, "es")),
      consoles: e.consoles.map((c) => ({
        key: c.key, label: c.label, line: lineFromRow(c), enterMode: enterModeOf(c.enterMode), localEcho: c.localEcho,
        hupcl: c.hupcl, captureToDisk: c.captureToDisk,
        identify: {
          ...(c.identifyHostnameRegex ? { hostnameRegex: c.identifyHostnameRegex } : {}),
          ...(c.identifyBannerRegex ? { bannerRegex: c.identifyBannerRegex } : {}),
        },
        binding: bindingRecordFromRow(c, { validate: true }),
      })),
      relays: e.relays.map((r) => ({
        key: r.key, label: r.label, purpose: purposeOf(r.purpose), requireConfirm: r.requireConfirm,
        defaultPulseMs: r.defaultPulseMs, boardName: r.board.name, channel: r.channel,
      })),
      accesses: e.accesses.flatMap((a) => {
        const kind = AccessKindSchema.safeParse(a.kind)
        const policy = AccessPolicySchema.safeParse(a.policy)
        if (!kind.success || a.port < 1) return []
        return [{
          key: a.key, label: a.label, kind: kind.data, port: a.port, enabled: a.enabled, policy: policy.success ? policy.data : "reserved" as const,
          cableSerial: a.jtagCableSerial, consoleKey: a.console?.key ?? null, targetHost: a.targetHost, targetPort: a.targetPort,
          targetMode: a.targetMode === "switch" ? "switch" as const : "ip" as const, switchPort: a.switchPort, sshUser: a.sshUser,
        }]
      }),
    })),
    cableLabels: labels.flatMap((l) => (l.kind === "jtag" || l.kind === "serial-adapter" || l.kind === "net-adapter"
      ? [{ kind: l.kind, identity: l.identity, name: l.name, notes: l.notes }] : [])),
  }
  return ConfigExportV1Schema.parse(cfg)
}

// ---------------------------------------------------------------------------------------------------------------------
// Import

class DryRunRollback extends Error {
  constructor() { super("dry run"); this.name = "DryRunRollback" }
}

/** Binding paths must not escape their allowed prefix (the contract only checks the prefix, §13.2). */
function unsafePath(p: string | null): boolean {
  if (!p) return false
  return p.split("/").includes("..") || path.posix.normalize(p) !== p
}

function parseImport(json: string | unknown): ConfigExportV1 {
  let raw: unknown = json
  if (typeof json === "string") {
    try {
      raw = JSON.parse(json)
    } catch {
      throw new DomainError("VALIDATION", domainText.importInvalidJson, { _form: [domainText.importInvalidJson] })
    }
  }
  const parsed = ConfigExportV1Schema.safeParse(raw)
  if (!parsed.success) {
    const fe = toFieldErrors(parsed.error)
    ;(fe._form ??= []).push(domainText.importInvalidFormat)
    throw new DomainError("VALIDATION", domainText.importInvalidFormat, fe)
  }
  const cfg = parsed.data
  const errors: Record<string, string[]> = {}
  cfg.equipment.forEach((e, i) => {
    const keys = new Set<string>()
    e.consoles.forEach((c, j) => {
      if (keys.has(c.key)) errors[`equipment.${i}.consoles.${j}.key`] = [`Clave repetida: ${c.key}`]
      keys.add(c.key)
      const b = c.binding
      if (!b) return
      for (const f of ["devicePath", "lastDevNode", "byId", "byPath"] as const) {
        if (unsafePath(b[f])) errors[`equipment.${i}.consoles.${j}.binding.${f}`] = [PATH_NOT_ALLOWED]
      }
    })
    const chans = new Set<string>()
    e.relays.forEach((r, j) => {
      const k = `${r.boardName}:${r.channel}`
      if (chans.has(k)) errors[`equipment.${i}.relays.${j}.channel`] = ["Canal repetido"]
      chans.add(k)
    })
  })
  if (Object.keys(errors).length) throw new DomainError("VALIDATION", errorMessage("VALIDATION"), errors)
  return cfg
}

export interface ImportResult { report: ImportReportDTO; createdEquipmentIds: string[]; settingsChanged: boolean }

/**
 * Merges a ConfigExportV1 by name (§4.15): existing roles, templates, boards and equipment with the same name are
 * skipped and reported. Equipment references roles, templates and boards by name. One transaction; `dryRun` rolls back.
 * Auditing `config.import` is the caller's job (the action, or the CLI with its own actor).
 */
export interface ImportOptions {
  dryRun: boolean
  /** RM_ACCESS_PORTS and RM_PORT of this server: accesses outside the range (or on the web port) are skipped. */
  accessPorts?: { range: PortRange; httpPort: number }
}

export async function importConfigDetailed(prisma: PrismaClient, json: string | unknown, opts: ImportOptions, actor: ActorRef): Promise<ImportResult> {
  const cfg = parseImport(json)
  const report: ImportReportDTO = { dryRun: opts.dryRun, created: { roles: 0, templates: 0, boards: 0, equipment: 0 }, skipped: [], warnings: [] }
  const createdEquipmentIds: string[] = []
  let settingsChanged = false

  const run = async (tx: Tx): Promise<void> => {
    // Settings: lab name and banner.
    const s = await tx.settings.upsert({ where: { id: "global" }, create: {}, update: {} })
    if (s.labName !== cfg.settings.labName || s.bannerText !== cfg.settings.bannerText) {
      if (s.labName !== cfg.settings.labName) report.warnings.push(domainFormat.importLabName(s.labName, cfg.settings.labName))
      if (s.bannerText !== cfg.settings.bannerText) report.warnings.push(domainFormat.importBanner(cfg.settings.bannerText))
      await tx.settings.update({
        where: { id: "global" },
        data: { labName: cfg.settings.labName, bannerText: cfg.settings.bannerText, updatedById: actor.kind === "user" ? actor.id : null },
      })
      settingsChanged = true
    }

    // Roles.
    const roles = await tx.role.findMany({ select: { id: true, name: true } })
    for (const r of cfg.roles) {
      if (roles.some((x) => sameName(x.name, r.name))) {
        report.skipped.push({ kind: "role", name: r.name, reason: domainText.importSkipRole })
        continue
      }
      roles.push(await tx.role.create({ data: { name: r.name, description: r.description }, select: { id: true, name: true } }))
      report.created.roles++
    }

    // Templates.
    const templates = await tx.equipmentTemplate.findMany({ select: { id: true, name: true, key: true } })
    let tplPos = ((await tx.equipmentTemplate.aggregate({ _max: { position: true } }))._max.position ?? -1) + 1
    for (const t of cfg.templates) {
      if (t.key && templates.some((x) => x.key === t.key)) {
        report.skipped.push({ kind: "template", name: t.name, reason: domainText.importSkipTemplateKey })
        continue
      }
      if (templates.some((x) => sameName(x.name, t.name))) {
        report.skipped.push({ kind: "template", name: t.name, reason: domainText.importSkipTemplate })
        continue
      }
      templates.push(await tx.equipmentTemplate.create({
        // Always a local template: only the profile's files make "file" templates (the next reload links a keyed one).
        data: { key: t.key, name: t.name, description: t.description, source: "local", needsReview: t.needsReview, spec: t.spec, position: tplPos++ },
        select: { id: true, name: true, key: true },
      }))
      report.created.templates++
    }

    // Boards.
    const boards = await tx.relayBoard.findMany({ select: { id: true, name: true, host: true, httpPort: true, mac: true, relayCount: true } })
    for (const b of cfg.boards) {
      if (boards.some((x) => sameName(x.name, b.name))) {
        report.skipped.push({ kind: "board", name: b.name, reason: domainText.importSkipBoard })
        continue
      }
      if (boards.some((x) => (x.host === b.host && x.httpPort === b.httpPort) || (!!b.mac && x.mac === b.mac))) {
        report.skipped.push({ kind: "board", name: b.name, reason: domainText.importSkipBoardAddress })
        continue
      }
      boards.push(await tx.relayBoard.create({
        data: {
          name: b.name, driver: b.driver, host: b.host, httpPort: b.httpPort, tcpPort: b.tcpPort, model: b.model, moduleId: b.moduleId,
          mac: b.mac, relayCount: b.relayCount, options: b.options, username: b.username, enabled: b.enabled,
        },
        select: { id: true, name: true, host: true, httpPort: true, mac: true, relayCount: true },
      }))
      report.created.boards++
      if (b.hasPassword) report.warnings.push(domainFormat.importBoardPassword(b.name))
    }

    // Cable labels (before the equipment: nothing references them by id).
    const knownLabels = await tx.cableLabel.findMany({ select: { kind: true, identity: true, name: true } })
    for (const l of cfg.cableLabels) {
      // A JTAG label's identity is the hw_server port filter: a plain serial only.
      const badSerial = l.kind === "jtag" && !CableSerialSchema.safeParse(l.identity).success
      if (badSerial || knownLabels.some((x) => x.kind === l.kind && (x.identity === l.identity || sameName(x.name, l.name)))) {
        report.warnings.push(accessErrors.importLabelSkipped(l.name))
        continue
      }
      await tx.cableLabel.create({ data: { kind: l.kind, identity: l.identity, name: l.name, notes: l.notes } })
      knownLabels.push({ kind: l.kind, identity: l.identity, name: l.name })
    }

    // Equipment.
    const existing = await tx.equipment.findMany({ select: { name: true } })
    const usedAccess = await tx.equipmentAccess.findMany({ select: { port: true, jtagCableSerial: true, targetMode: true, switchPort: true } })
    const usedSwitchPorts = new Set(usedAccess.flatMap((a) => (a.targetMode === "switch" && a.switchPort !== null ? [a.switchPort] : [])))
    const usedPorts = new Set(usedAccess.map((a) => a.port))
    const usedCables = new Set(usedAccess.flatMap((a) => (a.jtagCableSerial ? [a.jtagCableSerial] : [])))
    const maxPos = (await tx.equipment.aggregate({ _max: { position: true } }))._max.position ?? 0
    let eqPos = maxPos > 0 ? maxPos + 1 : 0
    for (const e of cfg.equipment) {
      if (existing.some((x) => sameName(x.name, e.name))) {
        report.skipped.push({ kind: "equipment", name: e.name, reason: domainText.importSkipEquipment })
        continue
      }
      const roleIds: string[] = []
      for (const rn of e.roles) {
        const r = roles.find((x) => sameName(x.name, rn))
        if (r) roleIds.push(r.id)
        else report.warnings.push(domainFormat.importRoleMissing(e.name, rn))
      }
      const template = e.templateName ? templates.find((x) => sameName(x.name, e.templateName ?? "")) : undefined
      if (e.templateName && !template) report.warnings.push(domainFormat.importTemplateMissing(e.name, e.templateName))

      const consoles: Prisma.SerialConsoleCreateWithoutEquipmentInput[] = []
      for (const [i, c] of e.consoles.entries()) {
        let binding = c.binding
        if (binding) {
          const taken = await tx.serialConsole.findUnique({ where: { bindingKey: binding.bindingKey }, select: { id: true } })
          if (taken) {
            report.warnings.push(domainFormat.importBindingTaken(e.name, c.key))
            binding = null
          }
        }
        consoles.push({
          position: i, key: c.key, label: c.label,
          baudRate: c.line.baudRate, dataBits: c.line.dataBits, parity: c.line.parity, stopBits: c.line.stopBits, flowControl: c.line.flowControl,
          enterMode: c.enterMode, localEcho: c.localEcho, hupcl: c.hupcl, captureToDisk: c.captureToDisk,
          identifyHostnameRegex: c.identify.hostnameRegex ?? null, identifyBannerRegex: c.identify.bannerRegex ?? null,
          ...(binding ? {
            matchBy: binding.matchBy, bindingKey: binding.bindingKey, byId: binding.byId, byPath: binding.byPath,
            usbVendorId: binding.usbVendorId, usbProductId: binding.usbProductId, usbSerial: binding.usbSerial,
            usbInterface: binding.usbInterface, usbPortNumber: binding.usbPortNumber, usbIdPath: binding.usbIdPath,
            devicePath: binding.devicePath, adapterLabel: binding.adapterLabel, lastDevNode: binding.lastDevNode,
          } : {}),
        })
      }

      const relays: Prisma.RelayChannelUncheckedCreateWithoutEquipmentInput[] = []
      for (const r of e.relays) {
        const b = boards.find((x) => sameName(x.name, r.boardName))
        if (!b) { report.warnings.push(domainFormat.importBoardMissing(e.name, r.boardName, r.channel)); continue }
        if (r.channel > b.relayCount) { report.warnings.push(domainFormat.importChannelOutOfRange(e.name, b.name, r.channel)); continue }
        const taken = await tx.relayChannel.findUnique({ where: { boardId_channel: { boardId: b.id, channel: r.channel } }, select: { id: true } })
        if (taken) { report.warnings.push(domainFormat.importChannelTaken(e.name, b.name, r.channel)); continue }
        relays.push({
          boardId: b.id, channel: r.channel, position: relays.length, key: r.key, label: r.label, purpose: r.purpose,
          requireConfirm: r.requireConfirm, defaultPulseMs: r.defaultPulseMs,
        })
      }

      const created = await tx.equipment.create({
        data: {
          name: e.name, serialNumber: e.serialNumber, description: e.description, position: eqPos ? eqPos++ : 0,
          templateId: template?.id ?? null, templateName: template?.name ?? e.templateName,
          roles: { connect: roleIds.map((id) => ({ id })) },
          consoles: { create: consoles },
          relays: { create: relays },
        },
        select: { id: true, name: true, consoles: { select: { id: true, key: true } } },
      })
      let accPos = 0
      for (const a of e.accesses) {
        const issue = opts.accessPorts ? portIssue(a.port, { ...opts.accessPorts, used: new Set() }) : null
        if (issue) {
          report.warnings.push(accessErrors.importPortInvalid(e.name, a.key, a.port))
          continue
        }
        if (usedPorts.has(a.port)) {
          report.warnings.push(accessErrors.importPortTaken(e.name, a.key, a.port))
          continue
        }
        let cableSerial = a.kind === "jtag" ? a.cableSerial : null
        if (cableSerial && usedCables.has(cableSerial)) {
          report.warnings.push(accessErrors.importCableTaken(e.name, a.key))
          cableSerial = null
        }
        let switchPort = a.kind === "tcp" && a.targetMode === "switch" ? a.switchPort : null
        if (switchPort !== null && usedSwitchPorts.has(switchPort)) {
          report.warnings.push(accessErrors.importSwitchPortTaken(e.name, a.key, switchPort))
          switchPort = null
        }
        await tx.equipmentAccess.create({
          data: {
            equipmentId: created.id, position: accPos++, key: a.key, label: a.label, kind: a.kind, port: a.port, enabled: a.enabled, policy: a.policy,
            jtagCableSerial: cableSerial, consoleId: a.kind === "serial" ? created.consoles.find((c) => c.key === a.consoleKey)?.id ?? null : null,
            targetHost: a.kind === "tcp" ? a.targetHost : null, targetPort: a.kind === "tcp" ? a.targetPort : null,
            targetMode: a.kind === "tcp" ? a.targetMode : "ip", switchPort,
            sshUser: a.kind === "tcp" ? a.sshUser : null,
          },
        })
        usedPorts.add(a.port)
        if (cableSerial) usedCables.add(cableSerial)
        if (switchPort !== null) usedSwitchPorts.add(switchPort)
      }
      existing.push({ name: created.name })
      createdEquipmentIds.push(created.id)
      report.created.equipment++
    }
    if (opts.dryRun) throw new DryRunRollback()
  }

  try {
    await prisma.$transaction(run, { timeout: 60_000, maxWait: 10_000 })
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err
  }
  return { report, createdEquipmentIds: opts.dryRun ? [] : createdEquipmentIds, settingsChanged: settingsChanged && !opts.dryRun }
}

export async function importConfig(prisma: PrismaClient, json: string | unknown, opts: ImportOptions, actor: ActorRef): Promise<ImportReportDTO> {
  return (await importConfigDetailed(prisma, json, opts, actor)).report
}
