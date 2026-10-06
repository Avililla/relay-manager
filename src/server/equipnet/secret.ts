// Passwords at rest (the switch's; the equipment SSH logins of «Enviar a equipo»): AES-256-GCM with a key derived
// (HKDF-SHA256) from the app secret (RM_AUTH_SECRET or <datos>/auth-secret), so a copy of the database alone does not
// reveal them. Each use has its own HKDF `info`, so a value sealed for one cannot be opened as the other. Never sent to
// the browser.
import crypto from "node:crypto"

const INFO = "relay-manager equipnet switch credentials v1"
/** «Archivos › Enviar a equipo»: the remembered SSH password of an equipment. */
export const SSH_SECRET_INFO = "relay-manager equipment ssh credentials v1"

function key(appSecret: string, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(appSecret, "utf8"), Buffer.from("relay-manager"), Buffer.from(info), 32))
}

export function sealSecret(plain: string, appSecret: string, info: string = INFO): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", key(appSecret, info), iv)
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${data.toString("base64")}`
}

/** null when it cannot be opened (another app secret, damaged value). */
export function openSecret(sealed: string, appSecret: string, info: string = INFO): string | null {
  const m = /^v1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]*)$/.exec(sealed)
  if (!m) return null
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key(appSecret, info), Buffer.from(m[1], "base64"))
    d.setAuthTag(Buffer.from(m[2], "base64"))
    return Buffer.concat([d.update(Buffer.from(m[3], "base64")), d.final()]).toString("utf8")
  } catch {
    return null
  }
}
