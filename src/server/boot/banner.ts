import os from "node:os"
import type { AppConfig } from "@/server/config/schema"

/** Interfaces that never carry the lab LAN (same skip list as D21). */
const VIRTUAL_IF = /^(lo|docker|br-|veth|virbr|tailscale|zt|wg|tun|tap)/

/** Non-internal IPv4 addresses of LAN interfaces. */
export function lanIPv4s(): string[] {
  const ips: string[] = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IF.test(name)) continue
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) ips.push(a.address)
  }
  return ips
}

/** Browser URLs: every LAN IPv4 when bound to all interfaces, otherwise the bound host. */
export function serverUrls(cfg: Pick<AppConfig, "host" | "port" | "tls">, port: number = cfg.port): string[] {
  const scheme = cfg.tls ? "https" : "http"
  const fmt = (h: string) => `${scheme}://${h.includes(":") ? `[${h}]` : h}:${port}`
  if (cfg.host !== "0.0.0.0" && cfg.host !== "::") return [fmt(cfg.host)]
  const ips = lanIPv4s()
  return [...ips.map(fmt), fmt("localhost")]
}

/** Startup banner (§6.6). The banner is the only place the setup token is ever printed by the server. */
export function renderBanner(opts: { labName: string; urls: string[]; setupToken: string | null; version: string; mode: string }): string {
  const line = "=".repeat(72)
  const out = [line]
  if (opts.setupToken) {
    out.push(` ${opts.labName}: configuración inicial pendiente`)
    for (const u of opts.urls) out.push(` Abre   ${u}/setup`)
    out.push(` Código de configuración:   ${opts.setupToken}`)
    out.push(" (se puede volver a mostrar con: sudo relay-manager setup-token)")
  } else {
    out.push(` ${opts.labName} (Relay Manager ${opts.version}, modo ${opts.mode})`)
    for (const u of opts.urls) out.push(` Abre   ${u}`)
  }
  out.push(line)
  return out.join("\n") + "\n"
}
