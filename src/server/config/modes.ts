import path from "node:path"
import type { AppMode } from "./schema"

export const NATIVE_RELEASES_PREFIX = "/opt/relay-manager/releases/"

export interface ModeFs { exists(p: string): boolean; realpath(p: string): string }

/**
 * Mode selection (§2.4): RM_MODE, else RM_DEV=1 → dev, /.dockerenv → docker,
 * realpath(appDir) under /opt/relay-manager/releases/ → native, otherwise portable. The config file never decides.
 */
export function detectMode(rmMode: AppMode | undefined, dev: boolean, appDir: string, fs: ModeFs): AppMode {
  if (rmMode) return rmMode
  if (dev) return "dev"
  if (fs.exists("/.dockerenv")) return "docker"
  let real = appDir
  try { real = fs.realpath(appDir) } catch { real = appDir }
  if ((real + "/").startsWith(NATIVE_RELEASES_PREFIX)) return "native"
  return "portable"
}

export interface ModeDefaults { bundleRoot: string | null; configFile: string; dataDir: string; profileDir: string }

export function modeDefaults(mode: AppMode, appDir: string): ModeDefaults {
  switch (mode) {
    case "dev":
      return { bundleRoot: null, configFile: path.join(appDir, "config.env"), dataDir: path.join(appDir, ".data"), profileDir: path.join(appDir, "perfil") }
    case "native":
      return { bundleRoot: path.dirname(appDir), configFile: "/etc/relay-manager/config.env", dataDir: "/var/lib/relay-manager", profileDir: "/etc/relay-manager/perfil" }
    case "docker":
      return { bundleRoot: path.dirname(appDir), configFile: "/data/config.env", dataDir: "/data", profileDir: "/perfil" }
    case "portable": {
      const root = path.dirname(appDir)
      return { bundleRoot: root, configFile: path.join(root, "config.env"), dataDir: path.join(root, "data"), profileDir: path.join(root, "perfil") }
    }
  }
}
