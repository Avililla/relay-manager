import path from "node:path"
import type { PrismaClient } from "@/generated/prisma/client"
import { createPrismaClient } from "@/server/db/client"
import { ensureDbInvariants } from "@/server/db/invariants"
import { migrateDatabase } from "@/server/db/migrate"
import { hashPassword } from "@/server/auth/passwords"
import { withTempDir } from "./temp"

export const MIGRATIONS_DIR = path.resolve(__dirname, "../../prisma/migrations")

export interface TestDb { prisma: PrismaClient; dbFile: string; dir: string; cleanup: () => Promise<void> }

/** Temp dir → real migrations → Prisma client → invariants. */
export async function createTestDb(): Promise<TestDb> {
  const { dir, cleanup } = withTempDir("rm-db-")
  const dbFile = path.join(dir, "relay-manager.db")
  await migrateDatabase({ dbFile, migrationsDir: MIGRATIONS_DIR, backupDir: null, appVersion: "test", log: () => {} })
  const prisma = createPrismaClient(dbFile)
  await ensureDbInvariants(prisma)
  return {
    prisma, dbFile, dir,
    cleanup: async () => { await prisma.$disconnect(); cleanup() },
  }
}

export interface MakeUserOverrides {
  username?: string; name?: string; password?: string; isAdmin?: boolean; disabled?: boolean
  mustChangePassword?: boolean; sessionVersion?: number; roleIds?: string[]
}
let seq = 0
/** Creates a user (bcrypt cost 4 for speed). Default password: "password-123". */
export async function makeUser(prisma: PrismaClient, o: MakeUserOverrides = {}) {
  seq += 1
  const username = o.username ?? `user${seq}`
  return prisma.user.create({
    data: {
      username,
      name: o.name ?? `Usuario ${seq}`,
      passwordHash: await hashPassword(o.password ?? "password-123", 4),
      isAdmin: o.isAdmin ?? false,
      disabled: o.disabled ?? false,
      mustChangePassword: o.mustChangePassword ?? false,
      sessionVersion: o.sessionVersion ?? 1,
      roles: o.roleIds?.length ? { connect: o.roleIds.map((id) => ({ id })) } : undefined,
    },
    include: { roles: { select: { id: true } } },
  })
}
