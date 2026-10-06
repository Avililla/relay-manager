import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  SETUP_TOKEN_ALPHABET, deleteSetupToken, ensureSetupTokenFile, generateSetupToken, isSetupPending, markSetupCompleted,
  normalizeSetupToken, readSetupToken, setupTokenPath, verifySetupToken,
} from "./setup-token"
import { createTestDb, makeUser, withTempDir, type TestDb } from "../../../test/helpers"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe("setup token format", () => {
  it("has 16 characters from the alphabet in groups of 4", () => {
    for (let i = 0; i < 50; i++) {
      const t = generateSetupToken()
      expect(t).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      for (const ch of t.replaceAll("-", "")) expect(SETUP_TOKEN_ALPHABET).toContain(ch)
    }
  })
  it("normalises case, spaces and dashes", () => {
    expect(normalizeSetupToken(" 7kqm-x2pd 9hva-rt4c ")).toBe("7KQMX2PD9HVART4C")
  })
})

describe("verifySetupToken", () => {
  it("accepts any formatting of the right token", () => {
    expect(verifySetupToken("7kqm x2pd 9hva rt4c", "7KQM-X2PD-9HVA-RT4C")).toBe(true)
    expect(verifySetupToken("7KQMX2PD9HVART4C", "7KQM-X2PD-9HVA-RT4C")).toBe(true)
  })
  it("rejects wrong tokens and never throws on different lengths", () => {
    expect(verifySetupToken("7KQM-X2PD-9HVA-RT4D", "7KQM-X2PD-9HVA-RT4C")).toBe(false)
    expect(verifySetupToken("A", "7KQM-X2PD-9HVA-RT4C")).toBe(false)
    expect(verifySetupToken("", "7KQM-X2PD-9HVA-RT4C")).toBe(false)
    expect(verifySetupToken("x".repeat(500), "7KQM-X2PD-9HVA-RT4C")).toBe(false)
  })
})

describe("setup token file", () => {
  it("creates <dataDir>/setup-token with mode 0600, reuses it, and deletes it", () => {
    const t = withTempDir(); cleanups.push(t.cleanup)
    const a = ensureSetupTokenFile(t.dir, null)
    expect(fs.statSync(setupTokenPath(t.dir)).mode & 0o777).toBe(0o600)
    expect(ensureSetupTokenFile(t.dir, null)).toBe(a)
    expect(readSetupToken(t.dir)).toBe(a)
    deleteSetupToken(t.dir)
    expect(readSetupToken(t.dir)).toBeNull()
    expect(fs.existsSync(path.join(t.dir, "setup-token"))).toBe(false)
  })
  it("uses the RM_SETUP_TOKEN override when given", () => {
    const t = withTempDir(); cleanups.push(t.cleanup)
    expect(ensureSetupTokenFile(t.dir, "E2E0-E2E0-E2E0-E2E0")).toBe("E2E0-E2E0-E2E0-E2E0")
    expect(readSetupToken(t.dir)).toBe("E2E0-E2E0-E2E0-E2E0")
  })
})

describe("setup state", () => {
  let db: TestDb
  it("a non-admin user never ends setup; markSetupCompleted does", async () => {
    db = await createTestDb(); cleanups.push(db.cleanup)
    await db.prisma.settings.upsert({ where: { id: "global" }, create: {}, update: {} })
    ensureSetupTokenFile(db.dir, null)
    expect(await isSetupPending(db.prisma)).toBe(true)
    await makeUser(db.prisma, { isAdmin: false })
    expect(await isSetupPending(db.prisma)).toBe(true)
    expect(readSetupToken(db.dir)).not.toBeNull()
    await markSetupCompleted(db.prisma, db.dir)
    expect(await isSetupPending(db.prisma)).toBe(false)
    expect(readSetupToken(db.dir)).toBeNull()
  })
})
