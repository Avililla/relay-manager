/** The only way to build or honour `?next=` (proxy and login page): same-site relative paths only, never `/api/`. */
export function safeNextPath(v: unknown): string {
  return typeof v === "string" && /^\/(?![\/\\])[^\s]*$/.test(v) && !v.startsWith("/api/") ? v : "/"
}
