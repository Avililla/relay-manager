import type { RoleMember } from "@/components/admin/role-form"
import type { UserDTO } from "@/lib/contracts/users"

/** Member choices for the role editor: enabled users first, by name (disabled ones stay selectable). */
export function roleMembers(users: UserDTO[]): RoleMember[] {
  return [...users]
    .sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.name.localeCompare(b.name, "es"))
    .map((u) => ({ id: u.id, name: u.name, username: u.username, isAdmin: u.isAdmin, disabled: u.disabled, roleIds: u.roles.map((r) => r.id) }))
}
