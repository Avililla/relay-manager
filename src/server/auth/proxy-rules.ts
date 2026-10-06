// Pure decision table of the proxy (§6.5), kept apart from NextAuth so it is unit-tested.
import { safeNextPath } from "@/lib/safe-next"

export type ProxyDecision =
  | { kind: "next" }
  | { kind: "redirect"; to: string }
  | { kind: "unauthenticated" }

export interface ProxyInput {
  pathname: string
  search: string
  method: string
  setupPending: boolean
  user: { id: string; mustChangePassword: boolean } | null
}

export function proxyDecision(i: ProxyInput): ProxyDecision {
  const isApi = i.pathname.startsWith("/api/")
  // 1. Auth.js routes.
  if (i.pathname.startsWith("/api/auth/")) return { kind: "next" }
  // 2. Setup pending: /setup and /api/* only (the API still needs auth).
  if (i.setupPending) {
    if (i.pathname === "/setup") return { kind: "next" }
    if (!isApi) return { kind: "redirect", to: "/setup" }
  } else if (i.pathname === "/setup") {
    // 3. A POST is the setup form's server action (finished meanwhile in another tab): it passes, so the action
    // answers SETUP_DONE itself instead of the call failing on a redirect. The action re-checks setup state.
    if (i.method === "POST") return { kind: "next" }
    return { kind: "redirect", to: "/login" }
  }
  // 4. No session.
  if (!i.user) {
    if (i.pathname === "/login") return { kind: "next" }
    if (isApi) return { kind: "unauthenticated" }
    const next = safeNextPath(i.pathname + i.search)
    return { kind: "redirect", to: next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}` }
  }
  // 5. Session.
  if (i.pathname === "/login") return { kind: "redirect", to: "/" }
  if (i.user.mustChangePassword && i.method === "GET" && !isApi && i.pathname !== "/cuenta") {
    return { kind: "redirect", to: "/cuenta?cambiar=1" }
  }
  // 6.
  return { kind: "next" }
}
