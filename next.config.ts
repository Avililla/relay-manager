import type { NextConfig } from "next"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")) as { version: string }
// Dev mode is selected only by RM_DEV=1 (D13); `next build` never sets it, so the CSP is always in the build.
const production = process.env.RM_DEV !== "1"

// A custom distDir lets parallel agents run dev servers; honoured only in dev (RM_DEV=1).
const distDir = process.env.RM_DEV === "1" && process.env.RM_NEXT_DIST_DIR ? process.env.RM_NEXT_DIST_DIR : ".next"

// Dev only: the bench is used from other LAN machines; let them load /_next/* dev resources.
const devOrigins = process.env.RM_DEV === "1"
  ? ["127.0.0.1", ...Object.values(os.networkInterfaces()).flatMap((l) => (l ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address))]
  : []

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ")

const nextConfig: NextConfig = {
  output: "standalone",
  distDir,
  allowedDevOrigins: devOrigins,
  // Native / hardware packages are never bundled by Turbopack/webpack.
  serverExternalPackages: ["serialport", "@serialport/bindings-cpp", "better-sqlite3", "@prisma/adapter-better-sqlite3"],
  poweredByHeader: false,
  images: { unoptimized: true },
  generateBuildId: async () => process.env.RM_BUILD_ID ?? null,
  env: { NEXT_PUBLIC_RM_VERSION: pkg.version },
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  // nft must never copy a dev DB, a secret or another agent's build into .next/standalone.
  outputFileTracingExcludes: { "*": [".data*/**", ".next-*/**", "dist/**", "build/**", "test-results/**", "config.env", "prisma/*.db*"] },
  async headers() {
    const headers = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ]
    if (production) headers.push({ key: "Content-Security-Policy", value: CSP })
    return [{ source: "/:path*", headers }]
  },
  async redirects() {
    const r = (source: string, destination: string) => ({ source, destination, permanent: false })
    return [
      r("/equipments", "/"),
      r("/equipments/:id", "/equipos/:id"),
      r("/equipments/:id/serial", "/equipos/:id"),
      r("/boards", "/placas"),
      r("/boards/:id", "/placas/:id"),
      r("/equipment-types", "/plantillas"),
      r("/users", "/usuarios"),
      r("/settings", "/sistema"),
      r("/equipos", "/"),
    ]
  },
}

export default nextConfig
