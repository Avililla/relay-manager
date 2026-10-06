import "server-only"
// Users and roles read side (§7.4, W1-C). Admin pages call requireAdmin() first.
import type { RoleDTO, UserDTO } from "@/lib/contracts/users"
import { getRuntime } from "@/server/runtime/registry"
import type { Runtime } from "@/server/runtime/types"

const userInclude = { roles: { select: { id: true, name: true }, orderBy: { name: "asc" } } } as const
async function loadUsers(rt: Runtime) {
  return rt.prisma.user.findMany({ include: userInclude })
}
type UserRow = Awaited<ReturnType<typeof loadUsers>>[number]

function toUserDTO(u: UserRow, enabledAdmins: number, reservations: Map<string, number>): UserDTO {
  return {
    id: u.id, username: u.username, name: u.name, email: u.email,
    isAdmin: u.isAdmin, disabled: u.disabled, mustChangePassword: u.mustChangePassword,
    isLastEnabledAdmin: u.isAdmin && !u.disabled && enabledAdmins === 1,
    roles: u.roles.map((r) => ({ id: r.id, name: r.name })),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    activeReservations: reservations.get(u.id) ?? 0,
  }
}

function reservationCounts(rt: Runtime): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rt.reservations.list()) m.set(r.holderId, (m.get(r.holderId) ?? 0) + 1)
  return m
}

/** Ordered by name. `isLastEnabledAdmin` lets the UI explain why delete, disable and demote are blocked. */
export async function listUsers(): Promise<UserDTO[]> {
  const rt = getRuntime()
  const [rows, enabledAdmins] = await Promise.all([
    loadUsers(rt),
    rt.prisma.user.count({ where: { isAdmin: true, disabled: false } }),
  ])
  const counts = reservationCounts(rt)
  return rows
    .sort((a, b) => a.name.localeCompare(b.name, "es") || a.username.localeCompare(b.username))
    .map((u) => toUserDTO(u, enabledAdmins, counts))
}

export async function getUser(id: string): Promise<UserDTO | null> {
  const rt = getRuntime()
  const u = await rt.prisma.user.findUnique({ where: { id }, include: userInclude })
  if (!u) return null
  const enabledAdmins = await rt.prisma.user.count({ where: { isAdmin: true, disabled: false } })
  return toUserDTO(u, enabledAdmins, reservationCounts(rt))
}

const roleInclude = {
  users: { select: { id: true, username: true, name: true }, orderBy: { name: "asc" } },
  equipments: { select: { id: true, name: true }, orderBy: { name: "asc" } },
} as const

type RoleRow = NonNullable<Awaited<ReturnType<typeof loadRole>>>
async function loadRole(rt: Runtime, id: string) {
  return rt.prisma.role.findUnique({ where: { id }, include: roleInclude })
}

function toRoleDTO(r: RoleRow): RoleDTO {
  return {
    id: r.id, name: r.name, description: r.description,
    userCount: r.users.length, equipmentCount: r.equipments.length,
    users: r.users.map((u) => ({ id: u.id, username: u.username, name: u.name })),
    equipments: r.equipments.map((e) => ({ id: e.id, name: e.name })),
  }
}

export async function listRoles(): Promise<RoleDTO[]> {
  const rows = await getRuntime().prisma.role.findMany({ include: roleInclude })
  return rows.sort((a, b) => a.name.localeCompare(b.name, "es")).map(toRoleDTO)
}

export async function getRole(id: string): Promise<RoleDTO | null> {
  const r = await loadRole(getRuntime(), id)
  return r ? toRoleDTO(r) : null
}
