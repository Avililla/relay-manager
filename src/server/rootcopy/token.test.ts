import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ELEVATION_TTL_MS } from "@/server/files/copy/protocol"
import { TokenStore } from "./token"

const S = { sid: "a".repeat(64), webUser: "u-admin" }

describe("elevation tokens", () => {
  let tmp: string
  let t = 1_000_000
  const now = () => t
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rm-token-"))
    t = 1_000_000
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("valid for 5 minutes, for that session and web user only", () => {
    const st = new TokenStore({ keyFile: null, revokedFile: null, now })
    const tok = st.issue(S)
    expect(tok.expiresAt).toBe(t + ELEVATION_TTL_MS)
    expect(st.verify(tok.value, S)).toMatchObject({ ok: true })
    expect(st.verify(tok.value, { ...S, sid: "b".repeat(64) })).toMatchObject({ ok: false, message: expect.stringMatching(/otra sesión/) })
    expect(st.verify(tok.value, { ...S, webUser: "u-otro" })).toMatchObject({ ok: false })
    expect(st.verify(tok.value, undefined)).toMatchObject({ ok: false })
    t += ELEVATION_TTL_MS - 1
    expect(st.verify(tok.value, S).ok).toBe(true)
    t += 1
    expect(st.verify(tok.value, S)).toMatchObject({ ok: false, message: expect.stringMatching(/caducado/) })
  })

  it("bound to the sudo account that issued it (RM_SUDO_USER changed → refused)", () => {
    const st = new TokenStore({ keyFile: null, revokedFile: null, now })
    const tok = st.issue({ ...S, rootUser: "ana" }).value
    expect(st.verify(tok, { ...S, rootUser: "ana" }).ok).toBe(true)
    expect(st.verify(tok, { ...S, rootUser: "bea" })).toMatchObject({ ok: false, message: expect.stringMatching(/otra cuenta/) })
    expect(st.verify(tok, S).ok).toBe(false)
  })

  it("forged, tampered or foreign-key tokens are refused", () => {
    const st = new TokenStore({ keyFile: null, revokedFile: null, now })
    const tok = st.issue(S).value
    const [body, sig] = tok.split(".")
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>
    const longer = Buffer.from(JSON.stringify({ ...payload, exp: t + 24 * 3600_000 })).toString("base64url")
    expect(st.verify(`${longer}.${sig}`, S).ok).toBe(false)
    expect(st.verify(`${body}.${sig.slice(0, -2)}AA`, S).ok).toBe(false)
    expect(st.verify(`${body}`, S).ok).toBe(false)
    const other = new TokenStore({ keyFile: null, revokedFile: null, now })
    expect(other.verify(tok, S).ok).toBe(false)
  })

  it("the key and the revocations survive a restart of the helper (files 0600)", () => {
    const o = { keyFile: path.join(tmp, "token.key"), revokedFile: path.join(tmp, "revoked.json"), now }
    const a = new TokenStore(o)
    const t1 = a.issue(S).value
    const t2 = a.issue(S).value
    expect(fs.statSync(o.keyFile).mode & 0o777).toBe(0o600)
    expect(a.revoke(t1)).toBe(true)
    expect(a.revoke("garbage.x")).toBe(false)
    const b = new TokenStore(o)
    expect(b.verify(t1, S)).toMatchObject({ ok: false, message: expect.stringMatching(/olvidado/) })
    expect(b.verify(t2, S).ok).toBe(true)
    expect(fs.statSync(o.revokedFile).mode & 0o777).toBe(0o600)
    // Expired revocations are pruned.
    t += ELEVATION_TTL_MS + 1
    b.revoke(b.issue(S).value)
    expect(Object.keys(JSON.parse(fs.readFileSync(o.revokedFile, "utf8")) as object)).toHaveLength(1)
  })
})
