import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Creates a temp dir; `cleanup()` removes it. */
export function withTempDir(prefix = "rm-test-"): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
