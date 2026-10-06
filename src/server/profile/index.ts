// The profile («perfil»): project-specific configuration that lives outside the code (perfil.env, plantillas/*.json,
// herramientas/). See docs/INSTALACION.md and examples/perfil-ejemplo/.
import type { PrismaClient } from "@/generated/prisma/client"
import type { TemplateSyncReportDTO } from "@/lib/contracts/templates"
import type { AppConfig } from "@/server/config/schema"
import { syncProfileTemplates } from "./sync"
import { loadProfileTemplates, type ProfileTemplates, type TemplatesFs } from "./templates"

export { PROFILE_VARIABLES, PROFILE_ENV_FILE, PROFILE_TEMPLATES_DIR } from "./keys"
export { loadProfileTemplates, templateErrorLines, type ProfileTemplates } from "./templates"
export { syncProfileTemplates, syncChanged, syncReportLines } from "./sync"

export function readProfileTemplatesFor(config: Pick<AppConfig, "profile">, fsx?: TemplatesFs): ProfileTemplates {
  return loadProfileTemplates(config.profile.dir, fsx)
}

/** Reads the profile's template files and copies them into the database. */
export async function reloadProfileTemplates(prisma: PrismaClient, config: Pick<AppConfig, "profile">): Promise<TemplateSyncReportDTO> {
  return syncProfileTemplates(prisma, readProfileTemplatesFor(config))
}
