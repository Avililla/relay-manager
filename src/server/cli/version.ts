// `relay-manager version` (§9.2): never calls loadConfig and never creates a file.
import fs from "node:fs"
import path from "node:path"

export interface VersionInput {
  env: Record<string, string | undefined>
  argv1: string | undefined
  cwd: string
  nodeVersion: string
}

function readText(p: string): string | null {
  try { return fs.readFileSync(p, "utf8") } catch { return null }
}

/** "relay-manager 2.0.0 (rev abc1234, 2026-09-23T10:00:00Z) node 22.23.2" */
export function versionLine(i: VersionInput): string {
  const dev = i.env.RM_DEV === "1"
  const appDir = i.env.RM_APP_DIR ? path.resolve(i.cwd, i.env.RM_APP_DIR) : dev ? i.cwd : path.dirname(path.resolve(i.cwd, i.argv1 ?? "server.js"))
  let version = "0.0.0"
  try {
    const v = (JSON.parse(readText(path.join(appDir, "package.json")) ?? "{}") as { version?: unknown }).version
    if (typeof v === "string") version = v
  } catch { /* keep default */ }
  let rev = process.env.RM_BUILD_REV || "dev"
  let built: string | null = null
  const info = dev ? null : readText(path.join(path.dirname(appDir), "BUILDINFO"))
  for (const line of (info ?? "").split(/\r?\n/)) {
    const m = /^([a-z]+)=(.+)$/.exec(line.trim())
    if (m?.[1] === "rev") rev = m[2]
    if (m?.[1] === "built") built = m[2]
  }
  return `relay-manager ${version} (rev ${rev}${built ? `, ${built}` : ""}) node ${i.nodeVersion}`
}
