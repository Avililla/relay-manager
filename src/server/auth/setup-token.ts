// First-run setup token (§6.6, D23). Graph A creates the file; completeSetup verifies it.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { PrismaClient } from "@/generated/prisma/client"

export const SETUP_TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
export const SETUP_TOKEN_FILE = "setup-token"

export function setupTokenPath(dataDir: string): string {
  return path.join(dataDir, SETUP_TOKEN_FILE)
}

/** 16 characters from the alphabet in groups of 4 (about 78 bits), e.g. "7KQM-X2PD-9HVA-RT4C". */
export function generateSetupToken(): string {
  const chars: string[] = []
  for (let i = 0; i < 16; i++) chars.push(SETUP_TOKEN_ALPHABET[crypto.randomInt(SETUP_TOKEN_ALPHABET.length)])
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-")
}

/** Uppercase, without spaces or dashes. */
export function normalizeSetupToken(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, "")
}

/** sha256 of both normalised values + timingSafeEqual (equal lengths, so it never throws). */
export function verifySetupToken(input: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(normalizeSetupToken(input)).digest()
  const b = crypto.createHash("sha256").update(normalizeSetupToken(expected)).digest()
  return normalizeSetupToken(expected).length > 0 && crypto.timingSafeEqual(a, b)
}

export function readSetupToken(dataDir: string): string | null {
  try {
    const v = fs.readFileSync(setupTokenPath(dataDir), "utf8").trim()
    return v || null
  } catch {
    return null
  }
}

/** Makes sure <dataDir>/setup-token exists (mode 0600) and returns its value. */
export function ensureSetupTokenFile(dataDir: string, override: string | null): string {
  const file = setupTokenPath(dataDir)
  const existing = readSetupToken(dataDir)
  if (existing && (!override || existing === override)) {
    try { fs.chmodSync(file, 0o600) } catch { /* reported by doctor */ }
    return existing
  }
  const value = override ?? generateSetupToken()
  fs.rmSync(file, { force: true })
  fs.writeFileSync(file, value + "\n", { mode: 0o600, flag: "wx" })
  return value
}

export function deleteSetupToken(dataDir: string): void {
  fs.rmSync(setupTokenPath(dataDir), { force: true })
}

/** Setup pending means Settings.setupCompletedAt IS NULL (§6.6). Creating a non-admin never ends it. */
export async function isSetupPending(prisma: PrismaClient): Promise<boolean> {
  const s = await prisma.settings.findUnique({ where: { id: "global" }, select: { setupCompletedAt: true } })
  return !s?.setupCompletedAt
}

/** For every path that creates or promotes an admin outside completeSetup (CLI): ends setup and deletes the token file. */
export async function markSetupCompleted(prisma: PrismaClient, dataDir: string): Promise<void> {
  await prisma.settings.upsert({
    where: { id: "global" },
    create: { setupCompletedAt: new Date() },
    update: {},
  })
  await prisma.settings.updateMany({ where: { id: "global", setupCompletedAt: null }, data: { setupCompletedAt: new Date() } })
  deleteSetupToken(dataDir)
}
