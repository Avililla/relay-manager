// Session secret resolution (§2.4): RM_AUTH_SECRET, else <dataDir>/auth-secret, else generated (only with ensureSecret).
import crypto from "node:crypto"
import path from "node:path"
import type { ConfigFs } from "@/server/config/load"

export const AUTH_SECRET_FILE = "auth-secret"

export interface SecretLog { info(msg: string): void; warn(msg: string): void }

export function resolveAuthSecret(opts: {
  envSecret: string | null
  dataDir: string
  ensureSecret: boolean
  fs: ConfigFs
  log: SecretLog
}): string | null {
  if (opts.envSecret) return opts.envSecret
  const file = path.join(opts.dataDir, AUTH_SECRET_FILE)
  const existing = opts.fs.readText(file)
  if (existing !== null && existing.trim()) {
    const mode = opts.fs.fileMode(file)
    if (mode !== null && mode !== 0o600 && opts.ensureSecret) {
      opts.log.warn(`El fichero del secreto ${file} tiene permisos ${mode.toString(8)}: se corrigen a 600`)
      if (opts.fs.isOwnedByProcess(file)) opts.fs.chmod(file, 0o600)
    }
    return existing.trim()
  }
  if (!opts.ensureSecret) return null
  const secret = crypto.randomBytes(32).toString("base64url")
  opts.fs.writeFileExclusive(file, secret + "\n", 0o600)
  opts.log.info(`Generado nuevo secreto de sesión en ${file}`)
  return secret
}
