// Pure model of the Usuarios screens: status, last-admin/self protections and the form draft ↔ action inputs.
import type { z } from "zod"
import type { CreateUserInputSchema, UpdateUserInputSchema, UserDTO } from "@/lib/contracts/users"
import { users as t } from "@/lib/i18n/admin"

export type UserStatus = "active" | "disabled" | "mustChange"

/** Disabled wins over "must change the password" (a disabled user cannot sign in at all). */
export function userStatus(u: Pick<UserDTO, "disabled" | "mustChangePassword">): UserStatus {
  if (u.disabled) return "disabled"
  if (u.mustChangePassword) return "mustChange"
  return "active"
}

export const USER_STATUS_ORDER: Record<UserStatus, number> = { active: 0, mustChange: 1, disabled: 2 }

export interface UserProtections {
  canDisable: boolean
  canDelete: boolean
  /** Removing admin rights would leave no enabled admin. */
  canDemote: boolean
  /** Spanish explanation for the blocked disable/delete, or null. */
  blockedReason: string | null
}

/** §8.9 "Blocked with an explanation for yourself and for the last admin (UserDTO.isLastEnabledAdmin)". */
export function userProtections(u: Pick<UserDTO, "id" | "isLastEnabledAdmin">, viewerId: string): UserProtections {
  const self = u.id === viewerId
  const last = u.isLastEnabledAdmin
  return {
    canDisable: !self && !last,
    canDelete: !self && !last,
    canDemote: !last,
    blockedReason: self ? t.selfBlocked : last ? t.lastAdminBlocked : null,
  }
}

export interface UserDraft {
  username: string
  name: string
  email: string
  password: string
  isAdmin: boolean
  roleIds: string[]
  mustChangePassword: boolean
}

export const EMPTY_USER_DRAFT: UserDraft = {
  username: "", name: "", email: "", password: "", isAdmin: false, roleIds: [], mustChangePassword: true,
}

export function userDraftFrom(u: UserDTO): UserDraft {
  return {
    username: u.username, name: u.name, email: u.email ?? "", password: "", isAdmin: u.isAdmin,
    roleIds: u.roles.map((r) => r.id), mustChangePassword: u.mustChangePassword,
  }
}

const emailOrNull = (s: string): string | null => (s.trim() === "" ? null : s.trim())

export function toCreateUserInput(d: UserDraft): z.input<typeof CreateUserInputSchema> {
  return {
    username: d.username.trim().toLowerCase(), name: d.name.trim(), email: emailOrNull(d.email), password: d.password,
    isAdmin: d.isAdmin, roleIds: [...new Set(d.roleIds)], mustChangePassword: d.mustChangePassword,
  }
}

export function toUpdateUserInput(userId: string, d: UserDraft): z.input<typeof UpdateUserInputSchema> {
  return { userId, name: d.name.trim(), email: emailOrNull(d.email), isAdmin: d.isAdmin, roleIds: [...new Set(d.roleIds)] }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n")

/** Only the fields `updateUser` saves count for the edit form's dirty state. */
export function userEditDirty(base: UserDraft, d: UserDraft): boolean {
  return base.name.trim() !== d.name.trim() || (base.email.trim()) !== d.email.trim() || base.isAdmin !== d.isAdmin
    || !sameSet(base.roleIds, d.roleIds)
}

/** Anything typed in the create form (guards navigation away). */
export function userCreateDirty(d: UserDraft): boolean {
  return d.username !== "" || d.name !== "" || d.email !== "" || d.password !== "" || d.isAdmin || d.roleIds.length > 0 || !d.mustChangePassword
}
