// `relay-manager user list|create|reset-password|enable|disable|set-admin` (§6.7).
import crypto from "node:crypto"
import type { PrismaClient } from "@/generated/prisma/client"
import { PasswordSchema, UsernameSchema } from "@/lib/contracts/users"
import { formatDateTime } from "@/lib/i18n/format"
import { hashPassword } from "@/server/auth/passwords"
import { isSetupPending, markSetupCompleted } from "@/server/auth/setup-token"
import { flagBool, flagString, parseArgs, UsageError } from "./args"
import { cliAudit, CliExit, openDatabase, type CliContext } from "./context"

export const USER_USAGE = `Uso:
  relay-manager user list
  relay-manager user create <usuario> [--name <nombre>] [--admin] [--password-stdin]
  relay-manager user reset-password <usuario> [--password-stdin | --generate]
  relay-manager user enable <usuario>
  relay-manager user disable <usuario>
  relay-manager user set-admin <usuario> on|off
`

const GEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"

/** 16 random characters (about 93 bits) from an alphabet without look-alikes. */
export function generatePassword(): string {
  let s = ""
  for (let i = 0; i < 16; i++) s += GEN_ALPHABET[crypto.randomInt(GEN_ALPHABET.length)]
  return s
}

function parseUsername(raw: string | undefined): string {
  if (!raw) throw new UsageError("Falta el nombre de usuario")
  const r = UsernameSchema.safeParse(raw)
  if (!r.success) throw new UsageError(`Nombre de usuario no válido «${raw}»: ${r.error.issues[0]?.message ?? "formato incorrecto"}`)
  return r.data
}

function validatePassword(password: string, username: string): string {
  const r = PasswordSchema.safeParse(password)
  if (!r.success) throw new UsageError(`Contraseña no válida: ${r.error.issues[0]?.message ?? "formato incorrecto"}`)
  if (password.toLowerCase() === username) throw new UsageError("La contraseña no puede ser el nombre de usuario")
  return password
}

/** --password-stdin (first line) or two hidden prompts on a TTY. */
async function readPassword(ctx: CliContext, username: string, fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const line = (await ctx.io.readStdin()).split(/\r?\n/)[0] ?? ""
    return validatePassword(line, username)
  }
  if (!ctx.io.stdinIsTTY) throw new UsageError("Sin terminal: pasa la contraseña con --password-stdin")
  const a = await ctx.io.prompt("Contraseña: ", true)
  validatePassword(a, username)
  const b = await ctx.io.prompt("Repite la contraseña: ", true)
  if (a !== b) throw new CliExit(1, "Las contraseñas no coinciden: no se ha cambiado nada")
  return a
}

async function findUser(prisma: PrismaClient, username: string) {
  const u = await prisma.user.findUnique({ where: { username } })
  if (!u) throw new CliExit(1, `No existe el usuario «${username}»`)
  return u
}

async function isLastEnabledAdmin(prisma: PrismaClient, u: { isAdmin: boolean; disabled: boolean }): Promise<boolean> {
  if (!u.isAdmin || u.disabled) return false
  return (await prisma.user.count({ where: { isAdmin: true, disabled: false } })) <= 1
}

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + " ".repeat(n - s.length))

export async function userCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = args
  if (!sub || sub === "help" || sub === "--help") {
    ctx.io[sub ? "out" : "err"](USER_USAGE)
    return sub ? 0 : 2
  }
  const target = (u: { id: string; username: string }) => ({ type: "user" as const, id: u.id, name: u.username })

  switch (sub) {
    case "list": {
      parseArgs(rest, { boolean: [], string: [] })
      const prisma = await openDatabase(ctx)
      try {
        const users = await prisma.user.findMany({ orderBy: { username: "asc" } })
        if (!users.length) {
          ctx.io.out("No hay usuarios. Crea el primer administrador con: relay-manager user create <usuario> --admin\n")
          return 0
        }
        const w = { u: Math.max(8, ...users.map((u) => u.username.length + 2)), n: Math.max(8, ...users.map((u) => u.name.length + 2)) }
        ctx.io.out(`${pad("USUARIO", w.u)}${pad("NOMBRE", w.n)}${pad("ADMIN", 7)}${pad("ESTADO", 30)}ÚLTIMO ACCESO\n`)
        for (const u of users) {
          const state = u.disabled ? "desactivado" : u.mustChangePassword ? "activo (cambiar contraseña)" : "activo"
          ctx.io.out(`${pad(u.username, w.u)}${pad(u.name, w.n)}${pad(u.isAdmin ? "sí" : "no", 7)}${pad(state, 30)}${u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "nunca"}\n`)
        }
        return 0
      } finally {
        await prisma.$disconnect()
      }
    }

    case "create": {
      const p = parseArgs(rest, { boolean: ["admin", "password-stdin"], string: ["name"] })
      if (p.positionals.length !== 1) throw new UsageError("Indica un único nombre de usuario")
      const username = parseUsername(p.positionals[0])
      const name = (flagString(p, "name") ?? username).trim()
      if (!name || name.length > 60) throw new UsageError("El nombre debe tener entre 1 y 60 caracteres")
      const admin = flagBool(p, "admin")
      const password = await readPassword(ctx, username, flagBool(p, "password-stdin"))
      const prisma = await openDatabase(ctx)
      try {
        if (await prisma.user.findUnique({ where: { username }, select: { id: true } })) throw new CliExit(1, `Ya existe un usuario «${username}»`)
        const pending = await isSetupPending(prisma)
        // The first admin (setup pending) does not have to change the password; everyone else does (§6.7).
        const mustChangePassword = !(admin && pending)
        const u = await prisma.user.create({
          data: { username, name, passwordHash: await hashPassword(password, ctx.bcryptRounds), isAdmin: admin, mustChangePassword },
        })
        const endsSetup = admin && pending
        if (admin) await markSetupCompleted(prisma, ctx.config.dataDir)
        cliAudit(ctx, { action: "user.create", target: target(u), detail: { isAdmin: admin, setupCompleted: endsSetup } })
        ctx.io.out(`Usuario «${username}» creado${admin ? " (administrador)" : ""}.\n`)
        if (endsSetup) ctx.io.out("La configuración inicial queda completada.\n")
        if (mustChangePassword) ctx.io.out("Deberá cambiar la contraseña al entrar.\n")
        return 0
      } finally {
        await prisma.$disconnect()
      }
    }

    case "reset-password": {
      const p = parseArgs(rest, { boolean: ["password-stdin", "generate"], string: [] })
      if (p.positionals.length !== 1) throw new UsageError("Indica un único nombre de usuario")
      const username = parseUsername(p.positionals[0])
      const generate = flagBool(p, "generate")
      if (generate && flagBool(p, "password-stdin")) throw new UsageError("Usa --password-stdin o --generate, no las dos")
      const password = generate ? generatePassword() : await readPassword(ctx, username, flagBool(p, "password-stdin"))
      const prisma = await openDatabase(ctx)
      try {
        const u = await findUser(prisma, username)
        await prisma.user.update({
          where: { id: u.id },
          data: { passwordHash: await hashPassword(password, ctx.bcryptRounds), mustChangePassword: true, sessionVersion: { increment: 1 } },
        })
        cliAudit(ctx, { action: "user.password.reset", target: target(u), detail: { generated: generate } })
        ctx.io.out(`Contraseña de «${username}» restablecida: deberá cambiarla al entrar. Sus sesiones abiertas se cerrarán.\n`)
        if (generate) ctx.io.out(`Nueva contraseña: ${password}\n(no se volverá a mostrar)\n`)
        return 0
      } finally {
        await prisma.$disconnect()
      }
    }

    case "enable":
    case "disable": {
      const p = parseArgs(rest, { boolean: [], string: [] })
      if (p.positionals.length !== 1) throw new UsageError("Indica un único nombre de usuario")
      const username = parseUsername(p.positionals[0])
      const prisma = await openDatabase(ctx)
      try {
        const u = await findUser(prisma, username)
        const disable = sub === "disable"
        if (u.disabled === disable) {
          ctx.io.out(`«${username}» ya estaba ${disable ? "desactivado" : "activado"}.\n`)
          return 0
        }
        if (disable && (await isLastEnabledAdmin(prisma, u))) throw new CliExit(1, `No se puede desactivar a «${username}»: es el último administrador activo`)
        // Only disable bumps sessionVersion; enable does not (§6.7).
        await prisma.user.update({ where: { id: u.id }, data: disable ? { disabled: true, sessionVersion: { increment: 1 } } : { disabled: false } })
        cliAudit(ctx, { action: disable ? "user.disable" : "user.enable", target: target(u) })
        ctx.io.out(disable
          ? `Usuario «${username}» desactivado: sus sesiones y reservas se cerrarán en menos de 30 s.\n`
          : `Usuario «${username}» activado.\n`)
        return 0
      } finally {
        await prisma.$disconnect()
      }
    }

    case "set-admin": {
      const p = parseArgs(rest, { boolean: [], string: [] })
      if (p.positionals.length !== 2) throw new UsageError("Uso: relay-manager user set-admin <usuario> on|off")
      const username = parseUsername(p.positionals[0])
      const value = p.positionals[1]
      if (value !== "on" && value !== "off") throw new UsageError(`Valor no válido «${value}»: usa on u off`)
      const isAdmin = value === "on"
      const prisma = await openDatabase(ctx)
      try {
        const u = await findUser(prisma, username)
        if (u.isAdmin === isAdmin) {
          ctx.io.out(`«${username}» ${isAdmin ? "ya era" : "no era"} administrador.\n`)
          return 0
        }
        if (!isAdmin && (await isLastEnabledAdmin(prisma, u))) {
          throw new CliExit(1, `No se puede quitar el rol de administrador a «${username}»: es el último administrador activo`)
        }
        const pending = isAdmin && (await isSetupPending(prisma))
        await prisma.user.update({ where: { id: u.id }, data: { isAdmin } })
        if (isAdmin) await markSetupCompleted(prisma, ctx.config.dataDir)
        cliAudit(ctx, { action: "user.update", target: target(u), detail: { isAdmin, setupCompleted: pending } })
        ctx.io.out(`«${username}» ${isAdmin ? "ahora es administrador" : "ya no es administrador"}.\n`)
        if (pending) ctx.io.out("La configuración inicial queda completada.\n")
        return 0
      } finally {
        await prisma.$disconnect()
      }
    }

    default:
      throw new UsageError(`Suborden desconocida: user ${sub}\n${USER_USAGE}`)
  }
}
