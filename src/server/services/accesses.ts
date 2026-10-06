// Access and cable-label domain logic (stateless; W1-C style): validates and resolves the accesses of an equipment
// (ports, cable labels, consoles), writes them inside the equipment transaction, and the "Cables" label CRUD.
import type { z } from "zod"
import type { Prisma, PrismaClient } from "@/generated/prisma/client"
import type { AccessInput, AccessKind, AccessPolicy, CableLabelRefInputSchema, CreateCableLabelInputSchema, TargetMode, UpdateCableLabelInputSchema } from "@/lib/contracts/accesses"
import { allocatePorts, portIssue } from "@/lib/accesses/ports"
import { adapterIdentity } from "@/lib/accesses/labels"
import { accessErrors } from "@/lib/i18n/accesses"
import { equipnetErrors } from "@/lib/i18n/equipnet"
import { errorMessage } from "@/lib/i18n/errors"
import { DomainError } from "@/server/errors"
import type { DomainDeps } from "@/server/runtime/types"
import { afterCommit, conflictError, notFound, validationError } from "./common"
import type { DomainContext } from "./context"
import { sameName } from "./dto"

type Tx = Prisma.TransactionClient
export type AccessIn = Omit<AccessInput, "id"> & { id?: string }

/** One access ready to be written (consoleKey is turned into the console id inside the transaction). */
export interface ResolvedAccess {
  id?: string
  key: string; label: string; kind: AccessKind; port: number; enabled: boolean; policy: AccessPolicy
  jtagCableSerial: string | null; consoleKey: string | null; targetHost: string | null; targetPort: number | null
  targetMode: TargetMode; switchPort: number | null; sshUser: string | null
}

function normalize(a: AccessIn): AccessIn {
  return {
    ...a,
    cableSerial: a.kind === "jtag" ? a.cableSerial : null,
    cableName: a.kind === "jtag" ? a.cableName : null,
    consoleKey: a.kind === "serial" ? a.consoleKey : null,
    targetHost: a.kind === "tcp" ? a.targetHost : null,
    targetPort: a.kind === "tcp" ? a.targetPort : null,
    targetMode: a.kind === "tcp" ? a.targetMode : "ip",
    switchPort: a.kind === "tcp" && a.targetMode === "switch" ? a.switchPort : null,
    sshUser: a.kind === "tcp" ? a.sshUser : null,
  }
}

/**
 * Checks and resolves the accesses of one equipment (`equipmentId` null on create). Field errors use `accesses.<i>.<field>`.
 * - cable labels → serials; a cable is used by one JTAG access at most (two hw_server on one cable fight for it);
 * - consoles by key among `consoleKeys`;
 * - ports: fixed ones must be in RM_ACCESS_PORTS, not the web port, not used by another equipment and free on the
 *   server; `null` gets the lowest free port.
 */
export async function resolveAccesses(
  rt: Pick<DomainDeps, "prisma" | "accesses" | "equipnet">,
  equipmentId: string | null,
  inputs: readonly AccessIn[],
  consoleKeys: readonly string[],
): Promise<ResolvedAccess[]> {
  const prisma = rt.prisma
  const settings = rt.accesses.settings()
  const rows = inputs.map(normalize)
  const errors: Record<string, string[]> = {}
  const add = (path: string, msg: string) => { (errors[path] ??= []).push(msg) }

  // Cable labels.
  const labels = rows.some((r) => r.kind === "jtag" && !r.cableSerial && r.cableName)
    ? await prisma.cableLabel.findMany({ where: { kind: "jtag" }, select: { name: true, identity: true } })
    : []
  const serials = rows.map((r, i) => {
    if (r.kind !== "jtag") return null
    if (r.cableSerial) return r.cableSerial
    if (!r.cableName) return null
    const l = labels.find((x) => sameName(x.name, r.cableName ?? ""))
    if (!l) add(`accesses.${i}.cableName`, accessErrors.unknownCableName(r.cableName))
    return l?.identity ?? null
  })

  // Consoles.
  const keys = new Set(consoleKeys)
  rows.forEach((r, i) => {
    if (r.kind === "serial" && r.consoleKey && !keys.has(r.consoleKey)) add(`accesses.${i}.consoleKey`, accessErrors.unknownConsole(r.consoleKey))
  })

  // Other equipment's accesses: ports and cables.
  const others = await prisma.equipmentAccess.findMany({
    where: equipmentId ? { equipmentId: { not: equipmentId } } : {},
    select: { port: true, key: true, kind: true, jtagCableSerial: true, targetMode: true, switchPort: true, equipment: { select: { name: true } } },
  })
  // Switch ports ("Red de equipos"): one equipment per port (several accesses of the same equipment may share it).
  const net = rt.equipnet.settings()
  rows.forEach((r, i) => {
    if (r.kind !== "tcp" || r.targetMode !== "switch" || r.switchPort === null) return
    if (net.adapterMac && r.switchPort > net.portCount) add(`accesses.${i}.switchPort`, equipnetErrors.portOutOfRange(net.portCount))
    else if (net.adapterMac && r.switchPort === net.uplinkPort) add(`accesses.${i}.switchPort`, equipnetErrors.portIsUplink(r.switchPort))
    const o = others.find((x) => x.kind === "tcp" && x.targetMode === "switch" && x.switchPort === r.switchPort)
    if (o) add(`accesses.${i}.switchPort`, equipnetErrors.portTaken(o.equipment.name))
  })
  const seenSerial = new Map<string, number>()
  serials.forEach((s, i) => {
    if (!s) return
    const other = others.find((o) => o.kind === "jtag" && o.jtagCableSerial === s)
    if (other) add(`accesses.${i}.cableSerial`, accessErrors.cableElsewhere(other.equipment.name, other.key))
    const j = seenSerial.get(s)
    if (j !== undefined) add(`accesses.${i}.cableSerial`, accessErrors.cableTakenHere(rows[j].key))
    seenSerial.set(s, i)
  })

  const used = new Set(others.map((o) => o.port))
  rows.forEach((r, i) => {
    if (r.port === null) return
    const issue = portIssue(r.port, { range: settings.range, httpPort: settings.httpPort, used })
    if (issue === "out-of-range") add(`accesses.${i}.port`, accessErrors.portOutOfRange(settings.range.from, settings.range.to))
    else if (issue === "http-port") add(`accesses.${i}.port`, accessErrors.portIsHttp(r.port))
    else if (issue === "taken") {
      const o = others.find((x) => x.port === r.port)
      add(`accesses.${i}.port`, accessErrors.portTaken(o?.equipment.name ?? "?", o?.key ?? "?"))
    }
  })
  if (Object.keys(errors).length) {
    const conflict = Object.values(errors).flat().some((m) => m.startsWith("Puerto ya usado") || m.startsWith("Ese cable ya") || m.startsWith("Ese puerto del switch"))
    throw conflict ? conflictError(errors) : validationError(errors)
  }

  // Ports another program holds right now: a fixed one is an error; an automatic one is skipped. Ports this equipment
  // already listens on (kept, or swapped between its own accesses in this save) are not checked.
  const existing = equipmentId
    ? new Map((await prisma.equipmentAccess.findMany({ where: { equipmentId }, select: { id: true, port: true } })).map((a) => [a.id, a.port]))
    : new Map<string, number>()
  const ownPorts = new Set(existing.values())
  const needsCheck = (port: number) => !ownPorts.has(port)
  for (const [i, r] of rows.entries()) {
    if (r.port === null || !needsCheck(r.port)) continue
    if ((await rt.accesses.portState(r.port, r.id ?? null)) === "busy") add(`accesses.${i}.port`, accessErrors.portBusy(r.port))
  }
  if (Object.keys(errors).length) throw new DomainError("CONFLICT", errorMessage("CONFLICT"), errors)
  let ports: number[] = []
  for (let attempt = 0; ; attempt++) {
    const alloc = allocatePorts(rows.map((r) => r.port), { range: settings.range, httpPort: settings.httpPort, used })
    if (!alloc.ok) throw validationError({ [`accesses.${alloc.index}.port`]: [accessErrors.rangeExhausted(settings.range.from, settings.range.to)] })
    let skipped = false
    for (const [i, port] of alloc.ports.entries()) {
      if (rows[i].port !== null || !needsCheck(port)) continue
      if ((await rt.accesses.portState(port, rows[i].id ?? null)) === "busy") {
        used.add(port)
        skipped = true
      }
    }
    if (!skipped || attempt > 50) {
      ports = alloc.ports
      break
    }
  }

  return rows.map((r, i) => ({
    id: r.id, key: r.key, label: r.label.trim(), kind: r.kind, port: ports[i], enabled: r.enabled, policy: r.policy,
    jtagCableSerial: serials[i], consoleKey: r.consoleKey, targetHost: r.targetHost, targetPort: r.targetPort,
    targetMode: r.targetMode, switchPort: r.switchPort, sshUser: r.sshUser,
  }))
}

/**
 * Writes the accesses of `equipmentId` inside the caller's transaction: deletes the ones not kept, moves the kept ones
 * to temporary keys/ports (unique columns), then writes the final values and creates the new ones.
 */
export async function writeAccesses(tx: Tx, equipmentId: string, accesses: readonly ResolvedAccess[]): Promise<void> {
  const consoles = await tx.serialConsole.findMany({ where: { equipmentId }, select: { id: true, key: true } })
  const consoleId = new Map(consoles.map((c) => [c.key, c.id]))
  const kept = accesses.flatMap((a) => (a.id ? [a.id] : []))
  await tx.equipmentAccess.deleteMany({ where: { equipmentId, id: { notIn: kept } } })
  for (const [i, a] of accesses.entries()) {
    if (a.id) await tx.equipmentAccess.update({ where: { id: a.id }, data: { key: `~${a.id}`, port: -(i + 1) } })
  }
  for (const [i, a] of accesses.entries()) {
    const data = {
      position: i, key: a.key, label: a.label, kind: a.kind, port: a.port, enabled: a.enabled, policy: a.policy,
      jtagCableSerial: a.jtagCableSerial, consoleId: a.consoleKey ? consoleId.get(a.consoleKey) ?? null : null,
      targetHost: a.targetHost, targetPort: a.targetPort, targetMode: a.targetMode, switchPort: a.switchPort, sshUser: a.sshUser,
    }
    if (a.id) await tx.equipmentAccess.update({ where: { id: a.id }, data })
    else await tx.equipmentAccess.create({ data: { equipmentId, ...data } })
  }
}

/** Access ids of the input that do not belong to the equipment → field errors. */
export async function assertAccessIds(prisma: PrismaClient, equipmentId: string, inputs: readonly AccessIn[]): Promise<void> {
  const own = new Set((await prisma.equipmentAccess.findMany({ where: { equipmentId }, select: { id: true } })).map((a) => a.id))
  const errors: Record<string, string[]> = {}
  const seen = new Set<string>()
  inputs.forEach((a, i) => {
    if (!a.id) return
    if (!own.has(a.id) || seen.has(a.id)) errors[`accesses.${i}.id`] = [accessErrors.accessMissing]
    seen.add(a.id)
  })
  if (Object.keys(errors).length) throw validationError(errors)
}

// ---------------------------------------------------------------------------------------------------------------------
// Cable labels ("Cables")

type CreateLabel = z.infer<typeof CreateCableLabelInputSchema>
type UpdateLabel = z.infer<typeof UpdateCableLabelInputSchema>

async function assertLabelNameFree(prisma: PrismaClient, kind: string, name: string, exceptId: string | null): Promise<void> {
  const rows = await prisma.cableLabel.findMany({ where: { kind }, select: { id: true, name: true } })
  if (rows.some((r) => r.id !== exceptId && sameName(r.name, name))) throw conflictError({ name: [accessErrors.labelNameTaken] })
}

/** Labels a cable that is connected now (its description is taken from the detection, never from the client). */
export async function createCableLabel(input: CreateLabel, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  const identity = input.kind === "net-adapter" ? input.identity.trim().toLowerCase() : input.identity.trim()
  let desc: { vendorId: string | null; productId: string | null; product: string | null; serial: string | null } | null = null
  if (input.kind === "jtag") {
    const c = rt.accesses.jtag().cables.find((x) => x.serial === identity)
    if (c) desc = { vendorId: c.vendorId, productId: c.productId, product: c.product, serial: c.serial }
  } else if (input.kind === "net-adapter") {
    const a = rt.equipnet.adapters().find((x) => x.mac === identity.toLowerCase())
    if (a) desc = { vendorId: a.vendorId, productId: a.productId, product: a.product ?? a.driver, serial: a.mac }
  } else {
    const a = rt.serial.discovery.toDTO().adapters.find((x) => adapterIdentity(x) === identity)
    if (a) desc = { vendorId: a.vendorId, productId: a.productId, product: a.product, serial: a.serial }
  }
  if (!desc) throw validationError({ identity: [accessErrors.labelNotConnected] })
  const existing = await rt.prisma.cableLabel.findUnique({ where: { kind_identity: { kind: input.kind, identity } } })
  if (existing) throw conflictError({ identity: [accessErrors.labelIdentityTaken(existing.name)] })
  await assertLabelNameFree(rt.prisma, input.kind, input.name, null)
  const now = new Date()
  const row = await rt.prisma.cableLabel.create({
    data: { kind: input.kind, identity, name: input.name.trim(), notes: input.notes || null, vendorId: desc.vendorId, productId: desc.productId, product: desc.product, firstSeenAt: now, lastSeenAt: now },
  })
  await afterCommit(rt.log, "recargar etiquetas", () => rt.accesses.reloadLabels())
  await afterCommit(rt.log, "recargar etiquetas de red", () => rt.equipnet.reloadLabels())
  rt.audit.record({
    actor, action: "cable.label.create", target: { type: "cable", id: row.id, name: row.name },
    detail: { kind: input.kind, identity, serial: desc.serial, product: desc.product },
  })
  return { id: row.id }
}

export async function updateCableLabel(input: UpdateLabel, ctx: DomainContext): Promise<{ id: string }> {
  const { rt, actor } = ctx
  const row = await rt.prisma.cableLabel.findUnique({ where: { id: input.labelId } })
  if (!row) throw notFound(accessErrors.labelMissing)
  await assertLabelNameFree(rt.prisma, row.kind, input.name, row.id)
  await rt.prisma.cableLabel.update({ where: { id: row.id }, data: { name: input.name.trim(), notes: input.notes || null } })
  await afterCommit(rt.log, "recargar etiquetas", () => rt.accesses.reloadLabels())
  await afterCommit(rt.log, "recargar etiquetas de red", () => rt.equipnet.reloadLabels())
  rt.audit.record({
    actor, action: "cable.label.update", target: { type: "cable", id: row.id, name: input.name.trim() },
    detail: { kind: row.kind, identity: row.identity, name: [row.name, input.name.trim()], notes: [row.notes, input.notes || null] },
  })
  return { id: row.id }
}

export async function deleteCableLabel(input: z.infer<typeof CableLabelRefInputSchema>, ctx: DomainContext): Promise<null> {
  const { rt, actor } = ctx
  const row = await rt.prisma.cableLabel.findUnique({ where: { id: input.labelId } })
  if (!row) throw notFound(accessErrors.labelMissing)
  await rt.prisma.cableLabel.delete({ where: { id: row.id } })
  await afterCommit(rt.log, "recargar etiquetas", () => rt.accesses.reloadLabels())
  await afterCommit(rt.log, "recargar etiquetas de red", () => rt.equipnet.reloadLabels())
  rt.audit.record({ actor, action: "cable.label.delete", target: { type: "cable", id: row.id, name: row.name }, detail: { kind: row.kind, identity: row.identity } })
  return null
}
