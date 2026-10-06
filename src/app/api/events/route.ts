// GET /api/events: the SSE stream (§4.13, W1-C). One per browser (SharedWorker); at most 8 per user.
import { authenticateCookieHeader } from "@/server/auth/ws-auth"
import { defineRoute } from "@/server/actions/define-route"
import { openEventStream, SSE_HEADERS } from "@/server/services/sse"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export const GET = defineRoute(
  { auth: "user", allowMustChangePassword: true, operation: "events.stream" },
  async ({ req, rt, user }) => {
    // The live-session entry needs the token's sv and loginAt, so the cookie is decoded here too (§4.13).
    const session = await authenticateCookieHeader(req.headers.get("cookie") ?? "")
    if (!session || session.user.id !== user.id) {
      return Response.json({ error: "UNAUTHENTICATED" }, { status: 401, headers: { "cache-control": "no-store" } })
    }
    const opened = openEventStream(rt, { session, signal: req.signal })
    if (!opened.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "cache-control": "no-store" } })
    return new Response(opened.stream, { status: 200, headers: SSE_HEADERS })
  },
)
