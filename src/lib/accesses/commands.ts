// What an engineer types on their own PC to use an access (pure; shown with a copy button).
import type { AccessKind } from "@/lib/contracts/accesses"

export interface AccessCommand {
  /** "xsdb" (xsdb/xsct `connect`), "vivado" (Hardware Manager remote server), "nc", "telnet", "ssh", "scp", "address". */
  id: "xsdb" | "vivado" | "nc" | "telnet" | "ssh" | "scp" | "address"
  command: string
}

/** "192.0.2.97:3201" ("[fe80::1]:3201" for IPv6). */
export function accessAddress(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
}

/** The commands for one access, most useful first. `host` is the address the browser used to reach the server. */
export function accessCommands(a: { kind: AccessKind; port: number; targetPort: number | null; sshUser?: string | null }, host: string, fallbackUser = "root"): AccessCommand[] {
  const user = a.sshUser?.trim() || fallbackUser
  switch (a.kind) {
    case "jtag":
      return [
        { id: "xsdb", command: `connect -host ${host} -port ${a.port}` },
        { id: "vivado", command: `connect_hw_server -url ${accessAddress(host, a.port)}` },
      ]
    case "serial":
      return [
        { id: "nc", command: `nc ${host} ${a.port}` },
        { id: "telnet", command: `telnet ${host} ${a.port}` },
      ]
    case "tcp":
      if (a.targetPort === 22) {
        return [
          { id: "ssh", command: `ssh -p ${a.port} ${user}@${host}` },
          { id: "scp", command: `scp -P ${a.port} <fichero> ${user}@${host}:` },
        ]
      }
      return [{ id: "address", command: accessAddress(host, a.port) }]
  }
}
