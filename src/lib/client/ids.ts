// Client-side ids without crypto.randomUUID (missing in insecure contexts, §8.12): a counter + Math.random base36.
// Not for security; only for DOM ids, React keys of new rows and message correlation. Browser-only state.
const seq = { n: 0 }

export function clientId(prefix = "rm"): string {
  seq.n = (seq.n + 1) % Number.MAX_SAFE_INTEGER
  return `${prefix}-${seq.n.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
