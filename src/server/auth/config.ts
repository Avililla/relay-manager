// NextAuth configuration (§6.1). Graph B; stateful services only through getRuntime().
import type { NextAuthConfig } from "next-auth"
import { headers } from "next/headers"
import Credentials from "next-auth/providers/credentials"
import { clientIp } from "@/server/request-meta"
import { getRuntime, tryGetRuntime } from "@/server/runtime/registry"
import { authorizeCredentials } from "./authorize"
import { refreshJwt, sessionFromToken } from "./callbacks"

/**
 * Auth.js errors caused by the request (a wrong password, a stale form) are expected: a failed login is already
 * audited as `auth.login.fail`, so it is not logged, and the others become one warning line instead of a stack trace
 * on stderr (journald). Anything else is an error of the app logger, with its stack.
 */
const CLIENT_AUTH_ERRORS = new Set(["MissingCSRF", "InvalidCheck", "UnknownAction", "UnsupportedStrategy", "InvalidProvider"])

export function logAuthError(error: Error): void {
  const type = (error as Error & { type?: unknown }).type
  const kind = typeof type === "string" ? type : error.name
  if (kind === "CredentialsSignin") return
  const log = tryGetRuntime()?.log.child("auth")
  if (!log) return
  if (CLIENT_AUTH_ERRORS.has(kind)) log.warn("Petición de acceso rechazada", { tipo: kind })
  else log.error("Error de Auth.js", { err: error, tipo: kind })
}

function maxAgeSeconds(): number {
  const h = Number(process.env.RM_SESSION_MAX_AGE_H ?? "12")
  return (Number.isInteger(h) && h >= 1 && h <= 168 ? h : 12) * 3600
}

export function buildAuthConfig(): NextAuthConfig {
  const maxAge = maxAgeSeconds()
  return {
    trustHost: true,
    secret: process.env.AUTH_SECRET,
    session: { strategy: "jwt", maxAge, updateAge: 300 },
    pages: { signIn: "/login" },
    logger: { error: logAuthError, warn: (code) => tryGetRuntime()?.log.child("auth").warn("Aviso de Auth.js", { codigo: code }), debug: () => {} },
    providers: [
      Credentials({
        credentials: { username: {}, password: {} },
        authorize: async (raw, request) => {
          const rt = getRuntime()
          return authorizeCredentials(raw, clientIp(request.headers), { prisma: rt.prisma, throttle: rt.throttle, audit: rt.audit })
        },
      }),
    ],
    callbacks: {
      jwt: async ({ token, user }) => refreshJwt(token, user, { prisma: getRuntime().prisma, maxAgeSec: maxAge }),
      session: async ({ session, token }) => sessionFromToken(session, token),
    },
    events: {
      signOut: async (message) => {
        const token = "token" in message ? message.token : null
        const rt = getRuntime()
        if (!token?.id) return
        let ip: string | null = null
        try { ip = clientIp(await headers()) || null } catch { ip = null } // outside a request scope
        rt.audit.record({
          actor: { kind: "user", id: token.id, name: token.username ?? token.name ?? "?", ip },
          action: "auth.logout",
          target: { type: "session", id: token.id, name: token.username ?? null },
        })
      },
    },
  }
}
