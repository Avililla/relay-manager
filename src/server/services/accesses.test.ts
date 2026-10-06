import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { CreateEquipmentInputSchema, UpdateEquipmentInputSchema, type CreateEquipmentInput } from "@/lib/contracts/equipment"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import type { JtagCableDTO } from "@/lib/contracts/accesses"
import { isDomainError } from "@/server/errors"
import type { AuthUser } from "@/server/runtime/types"
import { createTestDb, makeUser, type TestDb } from "../../../test/helpers"
import { createCableLabel, deleteCableLabel, updateCableLabel } from "./accesses"
import { createEquipment, deleteEquipment, updateEquipment } from "./equipment"
import { ctxFor, fakeDomain, resetDomainTables, toAuthUser, type FakeDomain } from "./test-fixtures"

let db: TestDb
let fx: FakeDomain
let admin: AuthUser
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetDomainTables(db.prisma)
  fx = fakeDomain(db.prisma)
  admin = toAuthUser(await makeUser(db.prisma, { name: "Admin", isAdmin: true }))
})

const cable = (serial: string): JtagCableDTO => ({
  serial, vendorId: "0403", productId: "6014", manufacturer: "Digilent", product: "Digilent USB Device", family: "digilent",
  location: "USB 1-2", labelId: null, labelName: null, assignedTo: [],
})
const consoleIn = (key: string) => ({ key, label: key, line: { ...DEFAULT_LINE }, enterMode: "cr" as const, localEcho: false, hupcl: false, captureToDisk: true, identify: {}, binding: null })
const equipoAccesses = [
  { key: "JTAG0", label: "JTAG 0", kind: "jtag" },
  { key: "JTAG1", label: "JTAG 1", kind: "jtag" },
  { key: "SERIE0", label: "Serie 0", kind: "serial", consoleKey: "UART0" },
  { key: "SERIE1", label: "Serie 1", kind: "serial", consoleKey: "UART1" },
  { key: "ETH", label: "Ethernet", kind: "tcp", targetHost: "192.168.1.10", targetPort: 22 },
]
function input(name: string, accesses: unknown[] = equipoAccesses): CreateEquipmentInput {
  return CreateEquipmentInputSchema.parse({
    name, serialNumber: null, description: null, roleIds: [], templateId: null,
    consoles: [consoleIn("UART0"), consoleIn("UART1")], relays: [], templateUpdate: null, accesses,
  })
}
async function fails(p: Promise<unknown>): Promise<{ code: string; fieldErrors: Record<string, string[]> }> {
  try {
    await p
  } catch (e) {
    if (isDomainError(e)) return { code: e.code, fieldErrors: e.fieldErrors ?? {} }
    throw e
  }
  throw new Error("no ha fallado")
}

describe("accesses on createEquipment", () => {
  it("gives the lowest free ports in order, links consoles by key, and reloads, audits", async () => {
    const r = await createEquipment(input("Equipo A #01"), ctxFor(fx.deps, admin))
    const rows = await db.prisma.equipmentAccess.findMany({ where: { equipmentId: r.id }, orderBy: { position: "asc" }, include: { console: true } })
    expect(rows.map((a) => [a.key, a.kind, a.port, a.policy, a.enabled, a.console?.key ?? null, a.targetHost, a.targetPort])).toEqual([
      ["JTAG0", "jtag", 3201, "reserved", true, null, null, null],
      ["JTAG1", "jtag", 3202, "reserved", true, null, null, null],
      ["SERIE0", "serial", 3203, "reserved", true, "UART0", null, null],
      ["SERIE1", "serial", 3204, "reserved", true, "UART1", null, null],
      ["ETH", "tcp", 3205, "reserved", true, null, "192.168.1.10", 22],
    ])
    expect(fx.accessReloads).toEqual([r.id])
    expect(fx.audit.inputs.find((i) => i.action === "equipment.create")?.detail?.accesses).toEqual(["JTAG0:3201", "JTAG1:3202", "SERIE0:3203", "SERIE1:3204", "ETH:3205"])
    const r2 = await createEquipment(input("Equipo A #02"), ctxFor(fx.deps, admin))
    const ports2 = (await db.prisma.equipmentAccess.findMany({ where: { equipmentId: r2.id }, orderBy: { position: "asc" } })).map((a) => a.port)
    expect(ports2).toEqual([3206, 3207, 3208, 3209, 3210])
  })

  it("resolves a cable label to its serial; an unknown label is a field error", async () => {
    await db.prisma.cableLabel.create({ data: { kind: "jtag", identity: "210299AAAA01", name: "JTAG-07" } })
    const acc = [{ key: "JTAG", label: "JTAG", kind: "jtag", cableName: "jtag-07" }]
    const r = await createEquipment(input("Equipo C #01", acc), ctxFor(fx.deps, admin))
    expect((await db.prisma.equipmentAccess.findFirstOrThrow({ where: { equipmentId: r.id } })).jtagCableSerial).toBe("210299AAAA01")
    const e = await fails(createEquipment(input("Equipo C #02", [{ key: "JTAG", label: "JTAG", kind: "jtag", cableName: "JTAG-99" }]), ctxFor(fx.deps, admin)))
    expect(e.fieldErrors["accesses.0.cableName"]?.[0]).toMatch(/JTAG-99/)
  })

  it("a cable already used by another equipment is a conflict on that row", async () => {
    await createEquipment(input("A", [{ key: "JTAG", label: "JTAG", kind: "jtag", cableSerial: "210299AAAA01" }]), ctxFor(fx.deps, admin))
    const e = await fails(createEquipment(input("B", [{ key: "J", label: "J", kind: "jtag", cableSerial: "210299AAAA01" }]), ctxFor(fx.deps, admin)))
    expect(e.code).toBe("CONFLICT")
    expect(e.fieldErrors["accesses.0.cableSerial"]?.[0]).toMatch(/JTAG de A/)
  })

  it("validates fixed ports: range, web port, another equipment, another program; and a full range", async () => {
    await createEquipment(input("A", [{ key: "ETH", label: "Ethernet", kind: "tcp", port: 3210 }]), ctxFor(fx.deps, admin))
    const ctx = ctxFor(fx.deps, admin)
    expect((await fails(createEquipment(input("B", [{ key: "X", label: "X", kind: "tcp", port: 4000 }]), ctx))).fieldErrors["accesses.0.port"]?.[0]).toMatch(/entre 3201 y 3230/)
    expect((await fails(createEquipment(input("B", [{ key: "X", label: "X", kind: "tcp", port: 3210 }]), ctx))).fieldErrors["accesses.0.port"]?.[0]).toMatch(/ETH de A/)
    fx.busyPorts.add(3211)
    expect((await fails(createEquipment(input("B", [{ key: "X", label: "X", kind: "tcp", port: 3211 }]), ctx))).fieldErrors["accesses.0.port"]?.[0]).toMatch(/otro programa/)
    const many = Array.from({ length: 16 }, (_, i) => ({ key: `T${i}`, label: `T${i}`, kind: "tcp" }))
    await createEquipment(input("C", many), ctx)
    const e = await fails(createEquipment(input("D", many), ctx))
    expect(Object.entries(e.fieldErrors).find(([k]) => k.endsWith(".port"))?.[1][0]).toMatch(/No quedan puertos libres/)
  })
})

describe("accesses on updateEquipment", () => {
  it("omitted accesses stay; given ones replace: keep by id, swap ports, remove and add", async () => {
    const r = await createEquipment(input("Equipo A #01"), ctxFor(fx.deps, admin))
    const eq = await db.prisma.equipment.findUniqueOrThrow({ where: { id: r.id }, include: { consoles: { orderBy: { position: "asc" } }, accesses: { orderBy: { position: "asc" } } } })
    const consoles = eq.consoles.map((c) => ({ ...consoleIn(c.key), id: c.id, binding: "keep" as const }))
    const base = { equipmentId: r.id, name: eq.name, serialNumber: null, description: null, roleIds: [], consoles, relays: [] }
    await updateEquipment(UpdateEquipmentInputSchema.parse(base), ctxFor(fx.deps, admin))
    expect(await db.prisma.equipmentAccess.count({ where: { equipmentId: r.id } })).toBe(5)
    const [j1, j2, , s2] = eq.accesses
    await updateEquipment(UpdateEquipmentInputSchema.parse({
      ...base,
      accesses: [
        { id: j1.id, key: "JTAG0", label: "JTAG 0", kind: "jtag", port: j2.port },
        { id: j2.id, key: "JTAG1", label: "JTAG 1", kind: "jtag", port: j1.port, policy: "always" },
        { id: s2.id, key: "SERIE1", label: "Serie 1", kind: "serial", consoleKey: "UART1", port: s2.port, enabled: false },
        { key: "HTTP", label: "Web", kind: "tcp", targetHost: "10.0.0.5", targetPort: 80 },
      ],
    }), ctxFor(fx.deps, admin))
    const after = await db.prisma.equipmentAccess.findMany({ where: { equipmentId: r.id }, orderBy: { position: "asc" } })
    expect(after.map((a) => [a.key, a.port, a.policy, a.enabled])).toEqual([
      ["JTAG0", 3202, "reserved", true], ["JTAG1", 3201, "always", true], ["SERIE1", 3204, "reserved", false], ["HTTP", 3203, "reserved", true],
    ])
    const audit = fx.audit.inputs.filter((i) => i.action === "equipment.update").at(-1)
    expect(audit?.detail?.accesses).toEqual({ added: ["HTTP:3203"], removed: ["SERIE0:3203", "ETH:3205"], changed: ["JTAG0:3201→3202", "JTAG1:3202→3201", "SERIE1"] })
    expect(fx.accessReloads.filter((id) => id === r.id).length).toBe(3)
  })

  it("deleting the equipment deletes its accesses and reloads them", async () => {
    const r = await createEquipment(input("Equipo A #01"), ctxFor(fx.deps, admin))
    await deleteEquipment({ equipmentId: r.id, confirmName: "Equipo A #01" }, ctxFor(fx.deps, admin))
    expect(await db.prisma.equipmentAccess.count()).toBe(0)
    expect(fx.accessReloads.at(-1)).toBe(r.id)
  })
})

describe("cable labels", () => {
  it("labels a connected JTAG cable, renames it, refuses duplicates and absent cables, deletes it; all audited", async () => {
    fx.jtagCables.push(cable("210299AAAA01"), cable("210299AAAA02"))
    const ctx = ctxFor(fx.deps, admin)
    const { id } = await createCableLabel({ kind: "jtag", identity: "210299AAAA01", name: "JTAG-01", notes: "Banco 2" }, ctx)
    const row = await db.prisma.cableLabel.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ kind: "jtag", identity: "210299AAAA01", name: "JTAG-01", notes: "Banco 2", vendorId: "0403", product: "Digilent USB Device" })
    expect(fx.labelReloads.count).toBe(1)
    expect((await fails(createCableLabel({ kind: "jtag", identity: "210299AAAA02", name: "jtag-01", notes: null }, ctx))).fieldErrors.name).toBeDefined()
    expect((await fails(createCableLabel({ kind: "jtag", identity: "210299AAAA01", name: "JTAG-09", notes: null }, ctx))).fieldErrors.identity?.[0]).toMatch(/JTAG-01/)
    expect((await fails(createCableLabel({ kind: "jtag", identity: "NOESTA", name: "JTAG-09", notes: null }, ctx))).fieldErrors.identity?.[0]).toMatch(/no está conectado/)
    await updateCableLabel({ labelId: id, name: "JTAG-07", notes: null }, ctx)
    expect((await db.prisma.cableLabel.findUniqueOrThrow({ where: { id } })).name).toBe("JTAG-07")
    await deleteCableLabel({ labelId: id }, ctx)
    expect(await db.prisma.cableLabel.count()).toBe(0)
    expect(fx.audit.inputs.map((i) => i.action)).toEqual(["cable.label.create", "cable.label.update", "cable.label.delete"])
    expect(fx.audit.inputs[1].detail?.name).toEqual(["JTAG-01", "JTAG-07"])
  })
})
