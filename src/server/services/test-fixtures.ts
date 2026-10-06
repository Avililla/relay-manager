// Shared fixtures for the W1-C service tests (not a test file itself). Never imported by production code.
import type { PrismaClient } from "@/generated/prisma/client"
import type { ConsoleBindingRecord } from "@/lib/contracts/serial"
import type { MatchBy } from "@/lib/contracts/enums"
import type { BoardRuntimeDTO } from "@/lib/contracts/relays"
import { createNullLogger } from "@/server/log"
import type { AuthUser, DomainDeps, ReservationService, UserActor } from "@/server/runtime/types"
import type { JtagCableDTO } from "@/lib/contracts/accesses"
import { fakeAudit, fakeBus, fakeReservations, fakeRuntime, fakeSettings } from "../../../test/helpers"
import type { DomainContext } from "./context"

export function usbBinding(stableKey: string, iface: number, matchBy: MatchBy = "adapter"): ConsoleBindingRecord {
  const letter = String.fromCharCode(65 + iface)
  return {
    matchBy, bindingKey: stableKey,
    byId: `/dev/serial/by-id/usb-FTDI_Quad_RS232-HS_FT4ABCDE-if0${iface}-port0`,
    byPath: `/dev/serial/by-path/pci-0000:00:14.0-usb-0:3.1:1.${iface}-port0`,
    usbVendorId: "0403", usbProductId: "6011", usbSerial: "FT4ABCDE", usbInterface: iface, usbPortNumber: 0,
    usbIdPath: `pci-0000:00:14.0-usb-0:3.1:1.${iface}`, devicePath: null,
    adapterLabel: `FTDI Quad RS232-HS (FT4ABCDE) · ${letter}`, lastDevNode: `/dev/ttyUSB${iface}`,
  }
}

export function pathBinding(devicePath: string): ConsoleBindingRecord {
  return {
    matchBy: "path", bindingKey: `virtual:${devicePath}`, byId: null, byPath: null, usbVendorId: null, usbProductId: null,
    usbSerial: null, usbInterface: null, usbPortNumber: null, usbIdPath: null, devicePath,
    adapterLabel: devicePath.split("/").pop() ?? devicePath, lastDevNode: devicePath,
  }
}

export interface FakeDomain {
  deps: DomainDeps
  bus: ReturnType<typeof fakeBus>
  audit: ReturnType<typeof fakeAudit>
  settings: ReturnType<typeof fakeSettings>
  /** stableKey → binding record returned by discovery.bindingFor (absent key → null = device not present). */
  devices: Map<string, ConsoleBindingRecord>
  reloadedEquipment: string[]
  relayReloads: { count: number }
  boardRuntimes: Map<string, BoardRuntimeDTO>
  /** Equipment ids passed to rt.accesses.reloadEquipment. */
  accessReloads: string[]
  /** JTAG cables rt.accesses.jtag() reports (by serial). */
  jtagCables: JtagCableDTO[]
  /** Ports another program holds (rt.accesses.portState → "busy"). */
  busyPorts: Set<number>
  labelReloads: { count: number }
}

export function fakeDomain(prisma: PrismaClient, opts: { reservations?: ReservationService } = {}): FakeDomain {
  const base = fakeRuntime({ prisma })
  const bus = fakeBus()
  const audit = fakeAudit()
  const settings = fakeSettings()
  const devices = new Map<string, ConsoleBindingRecord>()
  const reloadedEquipment: string[] = []
  const relayReloads = { count: 0 }
  const boardRuntimes = new Map<string, BoardRuntimeDTO>()
  const accessReloads: string[] = []
  const jtagCables: JtagCableDTO[] = []
  const busyPorts = new Set<number>()
  const labelReloads = { count: 0 }
  const deps: DomainDeps = {
    prisma, bus, audit, settings, log: createNullLogger(),
    equipnet: base.equipnet,
    reservations: opts.reservations ?? fakeReservations(),
    serial: {
      ...base.serial,
      discovery: {
        ...base.serial.discovery,
        bindingFor: (stableKey, matchBy) => {
          const d = devices.get(stableKey)
          return d ? { ...d, matchBy: matchBy ?? d.matchBy } : null
        },
      },
      consoles: { ...base.serial.consoles, reloadEquipment: async (id) => { reloadedEquipment.push(id) } },
    },
    relays: {
      ...base.relays,
      controller: {
        ...base.relays.controller,
        reload: async () => { relayReloads.count++ },
        boardRuntime: (id) => boardRuntimes.get(id) ?? null,
      },
    },
    accesses: {
      ...base.accesses,
      reloadEquipment: async (id) => { accessReloads.push(id) },
      jtag: () => ({ scannedAt: new Date().toISOString(), cables: jtagCables }),
      portState: async (port) => (busyPorts.has(port) ? "busy" : "free"),
      reloadLabels: async () => { labelReloads.count++ },
    },
  }
  return { deps, bus, audit, settings, devices, reloadedEquipment, relayReloads, boardRuntimes, accessReloads, jtagCables, busyPorts, labelReloads }
}

export function toAuthUser(u: { id: string; username: string; name: string; isAdmin: boolean; roles?: Array<{ id: string }> }): AuthUser {
  return { id: u.id, username: u.username, name: u.name, isAdmin: u.isAdmin, roleIds: (u.roles ?? []).map((r) => r.id), mustChangePassword: false, sessionVersion: 1 }
}

export function ctxFor(deps: DomainDeps, user: AuthUser, ip = "10.0.0.7"): DomainContext {
  const actor: UserActor = { kind: "user", id: user.id, name: user.username, ip }
  return { rt: deps, user, actor }
}

/** Deletes every domain row (keeps settings and audit). */
export async function resetDomainTables(prisma: PrismaClient): Promise<void> {
  await prisma.equipmentAccess.deleteMany({})
  await prisma.cableLabel.deleteMany({})
  await prisma.relayChannel.deleteMany({})
  await prisma.serialConsole.deleteMany({})
  await prisma.equipment.deleteMany({})
  await prisma.relayBoard.deleteMany({})
  await prisma.equipmentTemplate.deleteMany({})
  await prisma.role.deleteMany({})
  await prisma.user.deleteMany({})
}
