// `relay-manager setup-token` (§6.6): shows the first-run token. Read-only.
import fs from "node:fs"
import { readSetupToken } from "@/server/auth/setup-token"
import { withReadOnlyDb } from "@/server/ops/db-readonly"
import { parseArgs } from "./args"
import type { CliContext } from "./context"

/**
 * Setup is pending while Settings.setupCompletedAt is null; a missing DB means pending too. Read-only, and it leaves no
 * -wal/-shm next to a stopped DB (db-readonly.ts).
 */
export function readSetupPending(dbFile: string): boolean {
  if (!fs.existsSync(dbFile)) return true
  return withReadOnlyDb(dbFile, (db) => {
    try {
      const row = db.prepare(`SELECT "setupCompletedAt" AS s FROM "Settings" WHERE "id" = 'global'`).get() as { s: string | null } | undefined
      return !row?.s
    } catch {
      return true // no Settings table yet
    }
  })
}

export async function setupTokenCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  parseArgs(args, { boolean: [], string: [] })
  if (!readSetupPending(ctx.config.dbFile)) {
    ctx.io.out("La configuración inicial ya está completada\n")
    return 0
  }
  const token = readSetupToken(ctx.config.dataDir)
  if (!token) {
    ctx.io.err("El servidor aún no ha generado el código: inícialo\n")
    return 1
  }
  ctx.io.out(`${token}\n`)
  return 0
}
