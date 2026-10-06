// Bundles server.ts (Graph A) into build/server.js with esbuild (§9.1). Native and Next packages stay external.
//   node scripts/esbuild.server.mjs            (rev from RM_BUILD_REV or `git rev-parse --short HEAD`)
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function gitRev() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return "nogit"
  }
}
const rev = process.env.RM_BUILD_REV || gitRev()

/** Resolves `import "server-only"` to an empty module. */
const serverOnlyStub = {
  name: "server-only-stub",
  setup(b) {
    b.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "server-only-stub" }))
    b.onLoad({ filter: /.*/, namespace: "server-only-stub" }, () => ({ contents: "module.exports = {}", loader: "js" }))
  },
}

/**
 * ssh2 («Enviar a equipo») is pure JavaScript with two optional native speed-ups, each required inside a try/catch:
 * the `cpu-features` package and its own `sshcrypto.node` binding. Neither is built (pnpm-workspace.yaml) nor shipped:
 * both become a module that throws when required, so ssh2 always takes its JavaScript path, in development and in the
 * offline bundle alike.
 */
const ssh2NativeStub = {
  name: "ssh2-native-stub",
  setup(b) {
    b.onResolve({ filter: /^cpu-features$|sshcrypto\.node$/ }, (a) => ({ path: a.path, namespace: "ssh2-native-stub" }))
    b.onLoad({ filter: /.*/, namespace: "ssh2-native-stub" }, (a) => ({
      contents: `throw new Error(${JSON.stringify(`${a.path}: no incluido (ssh2 usa JavaScript)`)})`, loader: "js",
    }))
  },
}

const result = await build({
  absWorkingDir: root,
  entryPoints: ["server.ts"],
  outfile: "build/server.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  legalComments: "none",
  tsconfig: "tsconfig.json",
  external: ["next", "better-sqlite3", "serialport", "@serialport/*", "@prisma/client", "@prisma/adapter-better-sqlite3", "bufferutil", "utf-8-validate"],
  // "server-only" is a marker package for Graph B; Graph A never needs it, so it becomes an empty module. (An inline
  // plugin instead of the spec's alias to scripts/empty.cjs: a .cjs file makes W0's ESLint config crash, see w1d.md.)
  plugins: [serverOnlyStub, ssh2NativeStub],
  define: { "process.env.RM_BUILD_REV": JSON.stringify(rev) },
  logLevel: "warning",
  metafile: true,
})

const out = result.metafile.outputs["build/server.js"]
console.log(`[esbuild] build/server.js ${(out.bytes / 1024 / 1024).toFixed(1)} MB (rev ${rev})`)

// The root helper of «Copiar como administrador (sudo)» (relay-manager-rootcopy.service): a separate, small,
// self-contained program (only node: modules) that the service never loads.
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version
const helper = await build({
  absWorkingDir: root,
  entryPoints: ["src/server/rootcopy/main.ts"],
  outfile: "build/rootcopy.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  tsconfig: "tsconfig.json",
  plugins: [serverOnlyStub],
  define: { "process.env.RM_BUILD_VERSION": JSON.stringify(version) },
  logLevel: "warning",
  metafile: true,
})
const external = Object.keys(helper.metafile.inputs).filter((f) => f.includes("node_modules"))
if (external.length) throw new Error(`build/rootcopy.js no debe incluir paquetes: ${external.join(", ")}`)
console.log(`[esbuild] build/rootcopy.js ${(helper.metafile.outputs["build/rootcopy.js"].bytes / 1024).toFixed(0)} KB`)
