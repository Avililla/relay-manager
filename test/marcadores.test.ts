// Safety net: the repository is generic and project data lives in a profile outside it (docs/PERFIL.md). This test
// fails when a file that git would commit (tracked, or new and not ignored) contains a project marker.
//
// Markers = a short generic default list + the gitignored `.marcadores-proyecto` at the repo root, which each checkout
// fills with its own project's names: one case-insensitive regular expression per line, `#` starts a comment, and a
// line `!<ruta>` skips that file or folder (path relative to the repo, prefix match).
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const REPO = path.resolve(__dirname, "..")
const LOCAL_FILE = path.join(REPO, ".marcadores-proyecto")
// Written so that the list never matches itself.
// Generic leftovers of the lab where this was born (a company name and its networks); project names, people and
// tools go in the local, git-ignored .marcadores-proyecto (one regular expression per line, «!<ruta>» to skip a path).
const DEFAULT_MARKERS = [
  String.raw`tecno[b]it`, String.raw`\b172\.17\.230\.\d`, String.raw`\b172\.100\.1\.\d`, String.raw`\b192\.168\.30\.\d`,
]
const MAX_BYTES = 4 * 1024 * 1024

interface Markers { patterns: RegExp[]; skip: string[] }

function readMarkers(): Markers {
  const patterns = DEFAULT_MARKERS.map((p) => new RegExp(p, "i"))
  const skip: string[] = []
  let text = ""
  try {
    text = fs.readFileSync(LOCAL_FILE, "utf8")
  } catch {
    // no local list: only the defaults
  }
  try { text = fs.readFileSync(LOCAL_FILE, "utf8") } catch { /* no local list */ }
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("!")) skip.push(line.slice(1).trim().replace(/^\/+/, ""))
    else patterns.push(new RegExp(line, "i"))
  }
  return { patterns, skip }
}

function committableFiles(): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    return [...new Set(out.toString("utf8").split("\0").filter(Boolean))]
  } catch {
    return null
  }
}

describe("marcadores del proyecto", () => {
  it("ningún fichero que se pueda subir contiene marcadores del proyecto", (ctx) => {
    const files = committableFiles()
    if (files === null) return ctx.skip() // not a git checkout (e.g. a copy without .git)
    const { patterns, skip } = readMarkers()
    const hits: string[] = []
    for (const rel of files) {
      if (skip.some((s) => rel === s || rel.startsWith(s.endsWith("/") ? s : `${s}/`))) continue
      let buf: Buffer
      try {
        const st = fs.lstatSync(path.join(REPO, rel))
        if (!st.isFile() || st.size > MAX_BYTES) continue
        buf = fs.readFileSync(path.join(REPO, rel))
      } catch {
        continue // deleted in the working tree
      }
      if (buf.includes(0)) continue // binary
      const lines = buf.toString("utf8").split("\n")
      lines.forEach((line, i) => {
        const p = patterns.find((re) => re.test(line))
        if (p) hits.push(`${rel}:${i + 1}: /${p.source}/ → ${line.trim().slice(0, 120)}`)
      })
    }
    expect(hits.slice(0, 50), `Marcadores del proyecto en ficheros que se pueden subir (${hits.length}). ` +
      "Mueve esos datos al perfil (docs/PERFIL.md) o añade una excepción «!<ruta>» en .marcadores-proyecto.").toEqual([])
  })
})
