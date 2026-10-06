import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

// §2.2 rule 7: UI code never reaches Graph A modules; serial/relay helpers come from @/lib/serial/** and @/lib/relays/**.
const GRAPH_A_ONLY = ["serial", "relays", "ops", "boot", "http", "db", "cli", "equipnet"].flatMap((d) => [`@/server/${d}`, `@/server/${d}/**`])

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".next-*/**", "out/**", "build/**", "dist/**", ".data*/**", "src/generated/**", "test-results/**", "next-env.d.ts",
    // The switch's own minified scripts, kept verbatim as test fixtures.
    "test/fixtures/**/*.js"]),
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-ignore": true, "ts-expect-error": "allow-with-description" }],
      "react/no-danger": "error",
    },
  },
  {
    files: ["src/app/**", "src/actions/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: GRAPH_A_ONLY, message: "Graph B no importa módulos de Graph A (§2.2): usa getRuntime() o @/lib/**." }],
      }],
    },
  },
  {
    files: ["src/components/**", "src/hooks/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: GRAPH_A_ONLY, message: "Graph B no importa módulos de Graph A (§2.2): usa @/lib/serial/** o @/lib/relays/**." },
          { group: ["@/server/**", "@/server/*"], allowTypeImports: true, message: "Los componentes solo importan tipos de @/server (import type)." },
        ],
      }],
    },
  },
])

export default eslintConfig
