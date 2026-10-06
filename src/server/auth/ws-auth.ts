// Session-cookie authentication for WS upgrades (§5.1) and the SSE route (§4.13). Graph A and B; no "server-only".
import type { IncomingMessage } from "node:http"
import { getToken } from "next-auth/jwt"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthenticatedSession } from "@/server/runtime/types"
import { absoluteCapMs } from "./callbacks"

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Secure-authjs.session-token" : "authjs.session-token"
}

export async function authenticateCookieHeader(cookie: string): Promise<AuthenticatedSession | null> {
  try {
    const rt = getRuntime()
    const secret = rt.config.authSecret
    if (!secret || !cookie) return null
    const secure = rt.config.tls !== null
    const cookieName = sessionCookieName(secure)
    // Only the cookie header is passed: this disables the `Authorization: Bearer` fallback (which throws on "%").
    const token = await getToken({ req: { headers: { cookie } }, secret, secureCookie: secure, salt: cookieName, cookieName })
    if (!token) return null
    const { id, sv, loginAt } = token as { id?: unknown; sv?: unknown; loginAt?: unknown }
    if (typeof id !== "string" || typeof sv !== "number" || typeof loginAt !== "number") return null
    if (Date.now() - loginAt > absoluteCapMs(rt.config.sessionMaxAgeHours * 3600)) return null
    const user = await rt.prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, name: true, isAdmin: true, disabled: true, mustChangePassword: true, sessionVersion: true, roles: { select: { id: true } } },
    })
    if (!user || user.disabled || user.sessionVersion !== sv) return null
    return {
      user: {
        id: user.id, username: user.username, name: user.name, isAdmin: user.isAdmin, roleIds: user.roles.map((r) => r.id),
        mustChangePassword: user.mustChangePassword, sessionVersion: user.sessionVersion,
      },
      sv,
      loginAt,
    }
  } catch {
    return null
  }
}

export async function authenticateUpgrade(req: IncomingMessage): Promise<AuthenticatedSession | null> {
  const c = req.headers.cookie
  return authenticateCookieHeader(typeof c === "string" ? c : "")
}
