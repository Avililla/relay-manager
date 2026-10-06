import { z } from "zod"
import { IdSchema, type IsoDate } from "./common"
import { ThemePrefSchema, type ThemePref } from "./enums"

export const UsernameSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,31}$/, "De 2 a 32 caracteres: minúsculas, números, punto, guion o guion bajo")
/** bcrypt silently truncates at 72 bytes, so longer passwords are refused. TextEncoder works on client and server. */
export const PasswordSchema = z.string().min(10, "Mínimo 10 caracteres")
  .refine((v) => new TextEncoder().encode(v).length <= 72, "Máximo 72 bytes")
/** NextAuth `authorize` input (§6.3). */
export const CredentialsSchema = z.object({ username: UsernameSchema, password: z.string().min(1).max(128) })

export const CreateUserInputSchema = z.object({
  username: UsernameSchema,
  name: z.string().trim().min(1).max(60),
  email: z.email().nullable().default(null),
  password: PasswordSchema,
  isAdmin: z.boolean().default(false),
  roleIds: z.array(IdSchema).max(50).default([]),
  mustChangePassword: z.boolean().default(true),
}).refine((v) => v.password.toLowerCase() !== v.username, { path: ["password"], message: "La contraseña no puede ser el nombre de usuario" })
export const UpdateUserInputSchema = z.object({
  userId: IdSchema, name: z.string().trim().min(1).max(60), email: z.email().nullable(),
  isAdmin: z.boolean(), roleIds: z.array(IdSchema).max(50),
})
export const UserRefInputSchema = z.object({ userId: IdSchema })
export const ResetUserPasswordInputSchema = z.object({ userId: IdSchema, password: PasswordSchema, mustChangePassword: z.boolean().default(true) })
export const SetUserDisabledInputSchema = z.object({ userId: IdSchema, disabled: z.boolean() })
export const ChangeOwnPasswordInputSchema = z.object({
  currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema, confirmPassword: z.string(),
}).refine((v) => v.newPassword === v.confirmPassword, { path: ["confirmPassword"], message: "Las contraseñas no coinciden" })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ["newPassword"], message: "Debe ser distinta de la actual" })
export const SetupInputSchema = z.object({
  token: z.string().trim().min(8).max(64),
  username: UsernameSchema, name: z.string().trim().min(1).max(60),
  password: PasswordSchema, passwordConfirm: z.string(),
}).refine((v) => v.password === v.passwordConfirm, { path: ["passwordConfirm"], message: "Las contraseñas no coinciden" })
  .refine((v) => v.password.toLowerCase() !== v.username, { path: ["password"], message: "La contraseña no puede ser el nombre de usuario" })
export const RoleInputSchema = z.object({
  name: z.string().trim().min(1).max(40), description: z.string().trim().max(200).nullable(),
  userIds: z.array(IdSchema).max(500), equipmentIds: z.array(IdSchema).max(500),
})
export const UpdateRoleInputSchema = RoleInputSchema.extend({ roleId: IdSchema })
export const RoleRefInputSchema = z.object({ roleId: IdSchema })

/** Mi cuenta › Preferencias and the TopBar theme menu: the theme is saved in the account (D39). */
export const SetMyThemeInputSchema = z.object({ theme: ThemePrefSchema })

/** `theme`: the account's colour theme, null when the user never picked one (dark, or a browser choice being adopted). */
export interface ViewerDTO { id: string; username: string; name: string; isAdmin: boolean; mustChangePassword: boolean; theme: ThemePref | null }
export interface UserDTO {
  id: string; username: string; name: string; email: string | null
  isAdmin: boolean; disabled: boolean; mustChangePassword: boolean
  isLastEnabledAdmin: boolean               // UI explains why delete/disable/demote are blocked
  roles: Array<{ id: string; name: string }>
  lastLoginAt: IsoDate | null; createdAt: IsoDate; activeReservations: number
}
export interface RoleDTO {
  id: string; name: string; description: string | null
  userCount: number; equipmentCount: number
  users: Array<{ id: string; username: string; name: string }>
  equipments: Array<{ id: string; name: string }>
}
