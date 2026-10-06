// NetworkManager's view of the interfaces (only to show it in «Elige la interfaz del switch»): `nmcli -t -f
// DEVICE,STATE,CONNECTION device status`, read-only, no privileges. Empty when nmcli is not installed or fails.
import { execFile } from "node:child_process"
import fs from "node:fs"

export interface NmDevice { state: string; connection: string | null }

const NMCLI = ["/usr/bin/nmcli", "/bin/nmcli", "/usr/sbin/nmcli"]

/** Splits one terse nmcli line: fields separated by ":", with "\:" and "\\" escaped inside values. */
export function splitTerse(line: string): string[] {
  const out: string[] = []
  let cur = ""
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i]
      continue
    }
    if (ch === ":") {
      out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

export function parseNmDevices(text: string): Record<string, NmDevice> {
  const out: Record<string, NmDevice> = {}
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const [dev, state, conn] = splitTerse(line)
    if (!dev || !state) continue
    out[dev] = { state: state.trim(), connection: conn && conn !== "--" ? conn : null }
  }
  return out
}

export function readNmDevices(): Promise<Record<string, NmDevice>> {
  const bin = NMCLI.find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false }
  })
  if (!bin) return Promise.resolve({})
  return new Promise((resolve) => {
    execFile(bin, ["-t", "-f", "DEVICE,STATE,CONNECTION", "device", "status"], { timeout: 3000, encoding: "utf8", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "production" } }, (err: Error | null, stdout: string) => {
      resolve(err ? {} : parseNmDevices(stdout))
    })
  })
}
