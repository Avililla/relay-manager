// `relay-manager ping` (§9.2): GET /api/health with the configured scheme and host. Exit 0 when ok, 1 otherwise.
import type { AppConfig } from "@/server/config/schema"
import { healthUrl, probeHealth, type ProbeResult } from "@/server/ops/health-probe"
import { parseArgs } from "./args"
import type { CliContext } from "./context"

export { healthUrl }

export function ping(cfg: Pick<AppConfig, "host" | "port" | "tls">, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  return probeHealth(cfg, opts)
}

export async function pingCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const p = parseArgs(args, { boolean: ["quiet"], string: [] })
  const r = await ping(ctx.config)
  if (p.flags.quiet !== true) {
    if (r.ok) ctx.io.out(`Relay Manager ${r.version ?? ""} responde en ${r.url}\n`.replace("  ", " "))
    else ctx.io.err(`Sin respuesta correcta de ${r.url}: ${r.error ?? "error desconocido"}\n`)
  }
  return r.ok ? 0 : 1
}
