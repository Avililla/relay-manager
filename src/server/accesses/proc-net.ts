// Who is connected to a JTAG access? hw_server owns that socket, so the kernel's table is read instead
// (/proc/net/tcp and tcp6, ESTABLISHED = 01). Addresses are little-endian hex words.
import { promises as fs } from "node:fs"

function ipv4(hex: string): string {
  const n = Number.parseInt(hex, 16)
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".")
}

function ipv6(hex: string): string {
  // Four 32-bit little-endian words.
  const words = hex.match(/.{8}/g) ?? []
  const bytes: number[] = []
  for (const w of words) {
    const n = Number.parseInt(w, 16)
    bytes.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255)
  }
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12).join(".")
  const parts: string[] = []
  for (let i = 0; i < 16; i += 2) parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  return parts.join(":").replace(/(^|:)0(:0)+(:|$)/, "::")
}

/** Remote "addr:port" of every ESTABLISHED connection to local `port`. */
export function establishedTo(port: number, tcp4: string, tcp6: string): string[] {
  const out: string[] = []
  const scan = (text: string, v6: boolean) => {
    for (const line of text.split("\n")) {
      const f = line.trim().split(/\s+/)
      if (f.length < 4 || !/^\d+:$/.test(f[0])) continue
      const [local, remote, st] = [f[1], f[2], f[3]]
      if (st !== "01") continue
      const [, lport] = local.split(":")
      if (Number.parseInt(lport ?? "", 16) !== port) continue
      const [raddr, rport] = remote.split(":")
      if (!raddr || !rport) continue
      const addr = v6 ? ipv6(raddr) : ipv4(raddr)
      out.push(addr.includes(":") ? `[${addr}]:${Number.parseInt(rport, 16)}` : `${addr}:${Number.parseInt(rport, 16)}`)
    }
  }
  scan(tcp4, false)
  scan(tcp6, true)
  return out
}

export async function readProcNetTcp(): Promise<{ tcp4: string; tcp6: string }> {
  const read = (p: string) => fs.readFile(p, "utf8").catch(() => "")
  const [tcp4, tcp6] = await Promise.all([read("/proc/net/tcp"), read("/proc/net/tcp6")])
  return { tcp4, tcp6 }
}
