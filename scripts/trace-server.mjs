// Copies the node_modules files that build/server.js needs at runtime (serialport and friends) into the bundle's
// app/ directory, keeping pnpm's relative symlinks (§9.1). Uses the nft copy shipped inside Next.
//   node scripts/trace-server.mjs build/server.js dist/relay-manager-<ver>-linux-x64/app
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft")

const root = process.cwd()
const entry = process.argv[2] ?? "build/server.js"
const dest = process.argv[3] ?? ".next/standalone"

function lexists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

const { fileList, warnings } = await nodeFileTrace([entry], {
  base: root,
  // Next itself is traced by `next build`; do not walk its internals twice.
  ignore: (p) => p.startsWith("node_modules/next/") || p.includes("/node_modules/next/"),
})

let copied = 0
for (const rel of [...fileList].sort()) {
  if (!rel.startsWith("node_modules/")) continue
  const src = path.join(root, rel)
  const dst = path.join(dest, rel)
  if (lexists(dst)) continue
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const st = fs.lstatSync(src)
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst)
  else if (st.isFile()) fs.copyFileSync(src, dst)
  else continue
  copied++
}
for (const w of warnings) {
  const msg = String(w?.message ?? w)
  if (!msg.includes("Failed to resolve dependency")) console.warn("[trace]", msg)
}
console.log(`[trace] ${fileList.size} ficheros trazados, ${copied} copiados en ${dest}`)

// Next 16.0.6 + Turbopack: the standalone trace omits the route-handler runtime
// (next/dist/compiled/next-server/app-route-turbo.runtime.prod.js), which Turbopack chunks load with
// externalRequire, so every route handler (/api/auth, /api/health, …) would fail with "Cannot find module".
// Copy every missing production runtime of the installed Next (a few hundred KB each).
const srcRuntimeDir = path.join(path.dirname(require.resolve("next/package.json")), "dist", "compiled", "next-server")
let destNext
try {
  destNext = fs.realpathSync(path.join(dest, "node_modules", "next"))
} catch {
  destNext = null
}
if (destNext) {
  const destRuntimeDir = path.join(destNext, "dist", "compiled", "next-server")
  let added = 0
  for (const f of fs.readdirSync(srcRuntimeDir)) {
    if (!f.endsWith(".runtime.prod.js")) continue
    const target = path.join(destRuntimeDir, f)
    if (lexists(target)) continue
    fs.mkdirSync(destRuntimeDir, { recursive: true })
    fs.copyFileSync(path.join(srcRuntimeDir, f), target)
    added++
  }
  console.log(`[trace] ${added} runtime(s) de Next añadidos en ${path.relative(process.cwd(), destRuntimeDir)}`)
} else {
  console.warn(`[trace] no se encuentra next en ${dest}/node_modules`)
}
