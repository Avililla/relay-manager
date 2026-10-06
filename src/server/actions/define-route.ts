// Route handler wrapper (§7.1): fresh user, admin check, zod params/query, status mapping, auth.denied audit.
import crypto from "node:crypto"
import type { NextRequest } from "next/server"
import type { z } from "zod"
import type { ErrorCode } from "@/lib/contracts/common"
import { getAuthUser } from "@/server/authz"
import { isDomainError } from "@/server/errors"
import { clientIp } from "@/server/request-meta"
import { getRuntime } from "@/server/runtime/registry"
import type { AuthUser, Runtime, UserActor } from "@/server/runtime/types"

const STATUS: Partial<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401, FORBIDDEN: 403, PASSWORD_CHANGE_REQUIRED: 403, VALIDATION: 400, NOT_FOUND: 404, RATE_LIMITED: 429,
}

function withNoStore(res: Response): Response {
  if (!res.headers.has("cache-control")) {
    try {
      res.headers.set("cache-control", "no-store")
    } catch {
      // immutable headers (e.g. Response.redirect): rebuild
      const h = new Headers(res.headers)
      h.set("cache-control", "no-store")
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
    }
  }
  return res
}

function errorResponse(code: ErrorCode, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: code, ...extra }), {
    status: STATUS[code] ?? 500,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

export interface RouteContext<P, Q> { req: NextRequest; user: AuthUser; actor: UserActor; ip: string; rt: Runtime; params: P; query: Q }

export function defineRoute<P extends z.ZodType, Q extends z.ZodType>(
  opts: { auth: "user" | "admin"; params?: P; query?: Q; allowMustChangePassword?: boolean; operation: string },
  handler: (ctx: { req: NextRequest; user: AuthUser; actor: UserActor; ip: string; rt: Runtime
                   params: z.infer<P>; query: z.infer<Q> }) => Promise<Response>,
): (req: NextRequest, rc: { params: Promise<Record<string, string | string[]>> }) => Promise<Response> {
  return async (req, rc) => {
    let rt: Runtime | null = null
    let actor: UserActor | null = null
    const deny = (code: "FORBIDDEN" | "PASSWORD_CHANGE_REQUIRED") => {
      if (rt && actor) rt.audit.record({ actor, action: "auth.denied", outcome: "denied", detail: { operation: opts.operation, code } })
      return errorResponse(code)
    }
    try {
      rt = getRuntime()
      const ip = clientIp(req.headers)
      const user = await getAuthUser()
      if (!user) return errorResponse("UNAUTHENTICATED")
      actor = { kind: "user", id: user.id, name: user.username, ip }
      if (user.mustChangePassword && !opts.allowMustChangePassword) return deny("PASSWORD_CHANGE_REQUIRED")
      if (opts.auth === "admin" && !user.isAdmin) return deny("FORBIDDEN")
      const rawParams = rc?.params ? await rc.params : {}
      const params = opts.params ? opts.params.safeParse(rawParams) : { success: true as const, data: rawParams }
      if (!params.success) return errorResponse("VALIDATION")
      const rawQuery = Object.fromEntries(req.nextUrl.searchParams.entries())
      const query = opts.query ? opts.query.safeParse(rawQuery) : { success: true as const, data: rawQuery }
      if (!query.success) return errorResponse("VALIDATION")
      const res = await handler({ req, user, actor, ip, rt, params: params.data as z.infer<P>, query: query.data as z.infer<Q> })
      return withNoStore(res)
    } catch (e) {
      if (isDomainError(e)) {
        if (e.code === "FORBIDDEN" || e.code === "PASSWORD_CHANGE_REQUIRED") return deny(e.code)
        if (STATUS[e.code]) return errorResponse(e.code)
      }
      const ref = crypto.randomBytes(4).toString("hex")
      rt?.log.child("http").error("Error interno en una ruta", { ref, operation: opts.operation, err: e })
      return errorResponse("INTERNAL", { ref })
    }
  }
}
