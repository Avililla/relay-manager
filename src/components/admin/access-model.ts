// Pure access model for the Usuarios and Roles editors. Same rule as the server's canSeeEquipment (§6.8):
// admin → everything; an equipment without roles → everyone; otherwise → members of one of its roles.
import type { RoleInputSchema } from "@/lib/contracts/users"
import type { z } from "zod"

export interface EquipmentAccess { id: string; name: string; roleIds: string[] }
export interface Member { id: string; isAdmin: boolean }

export function canSee(viewer: { isAdmin: boolean; roleIds: readonly string[] }, e: EquipmentAccess): boolean {
  return viewer.isAdmin || e.roleIds.length === 0 || e.roleIds.some((r) => viewer.roleIds.includes(r))
}

/** Usuarios context panel: what a user with these settings would see. */
export function visibleEquipment(equipment: readonly EquipmentAccess[], viewer: { isAdmin: boolean; roleIds: readonly string[] }) {
  const visible = equipment.filter((e) => canSee(viewer, e))
  return { visible, hidden: equipment.length - visible.length, open: visible.filter((e) => e.roleIds.length === 0).length }
}

/**
 * Roles editor context panel. `roleId` is null for a new role. Returns:
 * - restricted: equipment that will carry this role after saving
 * - newlyRestricted: selected equipment that has no role today, so saving makes it invisible to non-members
 * - adminMembers: selected members that are admins (they already see everything)
 */
export function roleEffect<E extends EquipmentAccess>(
  equipment: readonly E[], roleId: string | null, selectedEquipmentIds: readonly string[],
  members: readonly Member[], selectedUserIds: readonly string[],
) {
  const selected = new Set(selectedEquipmentIds)
  const restricted = equipment.filter((e) => selected.has(e.id))
  const newlyRestricted = restricted.filter((e) => e.roleIds.filter((r) => r !== roleId).length === 0 && !(roleId && e.roleIds.includes(roleId)))
  const chosen = new Set(selectedUserIds)
  const adminMembers = members.filter((m) => chosen.has(m.id) && m.isAdmin).length
  return { restricted, newlyRestricted, adminMembers }
}

/** Deleting a role: equipment whose only role is this one becomes visible to everybody. */
export function equipmentOpenedByDelete<E extends EquipmentAccess>(equipment: readonly E[], roleId: string): E[] {
  return equipment.filter((e) => e.roleIds.length === 1 && e.roleIds[0] === roleId)
}

/**
 * Editing a role: saved equipment taken out of the role whose only role is this one. After saving it has no
 * roles, so it becomes visible to everybody (the edit-path twin of equipmentOpenedByDelete).
 */
export function equipmentOpenedByEdit<E extends EquipmentAccess>(
  equipment: readonly E[], roleId: string, baseIds: readonly string[], draftIds: readonly string[],
): E[] {
  const base = new Set(baseIds)
  const draft = new Set(draftIds)
  return equipment.filter((e) => base.has(e.id) && !draft.has(e.id) && e.roleIds.length === 1 && e.roleIds[0] === roleId)
}

export interface ReservedEquipment extends EquipmentAccess { reservation: { holderId: string; holderName: string } | null }
export interface MemberWithRoles extends Member { roleIds: readonly string[] }

/** Stand-in id for the role being created, so the same rules apply to a new role. */
const NEW_ROLE = "\u0000new-role"

/**
 * Active reservations the reservation service will release (cause access-lost) once the draft is saved: the holder
 * is not an admin, sees the equipment today and will not see it with the draft's members and equipment.
 * `roleId` is null for a new role. Holders not in `members` are skipped (unknown access).
 */
export function reservationsLostByEdit<E extends ReservedEquipment>(
  equipment: readonly E[], members: readonly MemberWithRoles[], roleId: string | null,
  draftUserIds: readonly string[], draftEquipmentIds: readonly string[],
): E[] {
  const id = roleId ?? NEW_ROLE
  const users = new Set(draftUserIds)
  const equip = new Set(draftEquipmentIds)
  const byId = new Map(members.map((m) => [m.id, m]))
  return equipment.filter((e) => {
    const holder = e.reservation ? byId.get(e.reservation.holderId) : undefined
    if (!holder || holder.isAdmin || !canSee(holder, e)) return false
    const roleIds = [...holder.roleIds.filter((r) => r !== id), ...(users.has(holder.id) ? [id] : [])]
    const after = { ...e, roleIds: [...e.roleIds.filter((r) => r !== id), ...(equip.has(e.id) ? [id] : [])] }
    return !canSee({ isAdmin: false, roleIds }, after)
  })
}

/** User editor: reservations this user holds on equipment the draft (admin flag, roles) would no longer show. */
export function reservationsLostByUserEdit<E extends ReservedEquipment>(
  equipment: readonly E[], userId: string, draft: { isAdmin: boolean; roleIds: readonly string[] },
): E[] {
  return equipment.filter((e) => e.reservation?.holderId === userId && !canSee(draft, e))
}

export interface RoleDraft { name: string; description: string; userIds: string[]; equipmentIds: string[] }
export const EMPTY_ROLE_DRAFT: RoleDraft = { name: "", description: "", userIds: [], equipmentIds: [] }

export function toRoleInput(d: RoleDraft): z.input<typeof RoleInputSchema> {
  const description = d.description.trim()
  return { name: d.name.trim(), description: description === "" ? null : description, userIds: [...new Set(d.userIds)], equipmentIds: [...new Set(d.equipmentIds)] }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n")

export function roleDirty(base: RoleDraft, d: RoleDraft): boolean {
  return base.name.trim() !== d.name.trim() || base.description.trim() !== d.description.trim()
    || !sameSet(base.userIds, d.userIds) || !sameSet(base.equipmentIds, d.equipmentIds)
}
