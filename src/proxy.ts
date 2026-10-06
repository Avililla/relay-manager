// Next 16 proxy (§6.5). Node runtime; stateful services only through the runtime registry.
import { NextResponse } from "next/server"
import { auth } from "@/server/auth"
import { absoluteUrl } from "@/server/auth/host-origin"
import { proxyDecision } from "@/server/auth/proxy-rules"
import { tryGetRuntime } from "@/server/runtime/registry"

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|fonts/|events-worker.js|api/health|ws/).*)"] }

export default auth((req) => {
  const u = req.auth?.user
  const d = proxyDecision({
    pathname: req.nextUrl.pathname,
    search: req.nextUrl.search,
    method: req.method,
    // The flag lives in the runtime (a boot timer re-checks the DB every 1 s while pending). Without a runtime
    // nothing can be served anyway: treat setup as done (fail closed to /login).
    setupPending: tryGetRuntime()?.state.setupPending ?? false,
    user: u?.id ? { id: u.id, mustChangePassword: u.mustChangePassword } : null,
  })
  if (d.kind === "redirect") return NextResponse.redirect(absoluteUrl(req, d.to))
  if (d.kind === "unauthenticated") {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401, headers: { "cache-control": "no-store" } })
  }
  return NextResponse.next()
})
