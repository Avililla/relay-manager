import { PrismaClient } from "@/generated/prisma/client"
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3"
export function createPrismaClient(dbFile: string): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: dbFile })
  return new PrismaClient({ adapter })
}

/**
 * Verifies the connection settings after the client is created (§3.1): WAL (left by the migration runner)
 * and foreign keys on (better-sqlite3 default). PRAGMAs that return rows go through $queryRawUnsafe.
 */
export async function verifyDbPragmas(prisma: PrismaClient): Promise<{ journalMode: string; foreignKeys: boolean }> {
  const jm = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode")
  const fk = await prisma.$queryRawUnsafe<Array<{ foreign_keys: number | bigint }>>("PRAGMA foreign_keys")
  return { journalMode: String(jm[0]?.journal_mode ?? ""), foreignKeys: Number(fk[0]?.foreign_keys ?? 0) === 1 }
}
