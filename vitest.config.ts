import { defineConfig } from "vitest/config"
import path from "node:path"
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "server-only": path.resolve(__dirname, "test/stubs/server-only.ts") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "test/**/*.test.ts"],
    pool: "forks",              // native modules (better-sqlite3, serialport)
    testTimeout: 15000,
    setupFiles: ["test/setup.ts"],
    // next-auth (ESM) imports "next/server" without an extension, which Node's ESM resolver rejects: let Vite resolve it.
    server: { deps: { inline: ["next-auth"] } },
  },
})
