import "server-only"
// Settings read side (§7.4, W1-C). getPublicSettings works without a runtime (§2.2 rule 6).
import packageJson from "../../../package.json"
import type { PublicSettingsDTO, SettingsDTO } from "@/lib/contracts/settings"
import { DEFAULT_LAB_NAME } from "@/lib/i18n/common"
import { getRuntime, tryGetRuntime } from "@/server/runtime/registry"

export async function getSettings(): Promise<SettingsDTO> {
  return getRuntime().settings.get()
}

/** Lab name, banner and version for public pages (login, setup, titles). Defaults when the runtime is absent. */
export async function getPublicSettings(): Promise<PublicSettingsDTO> {
  const rt = tryGetRuntime()
  if (!rt) return { labName: DEFAULT_LAB_NAME, bannerText: null, version: packageJson.version, rev: "dev" }
  const s = rt.settings.get()
  return { labName: s.labName, bannerText: s.bannerText, version: rt.config.build.version, rev: rt.config.build.rev }
}
