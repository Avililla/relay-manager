// The variables a profile («perfil») may set in <perfil>/perfil.env: project defaults only (names, the second shared
// folder, the download script, the equipment network defaults). Anything else there is ignored with a warning.
// Precedence (src/server/config/load.ts): process env > config.env > perfil.env > code defaults.

export const PROFILE_VARIABLES = [
  "RM_LAB_NAME",
  "RM_FILES_EXTRA_ENABLED", "RM_FILES_EXTRA_NAME", "RM_FILES_EXTRA_DIR", "RM_FILES_EXTRA_HINT",
  "RM_EXPORT_ENABLED", "RM_EXPORT_DOWNLOADER", "RM_EXPORT_TIMEOUT_MIN", "RM_EXPORT_ROOT", "RM_EXPORT_NAME", "RM_EXPORT_TITLE",
  "RM_EXPORT_DESCRIPTION", "RM_EXPORT_APP_LABEL", "RM_EXPORT_VERSION_LABEL", "RM_EXPORT_EXTRACT_LABEL",
  "RM_EXPORT_URL", "RM_EXPORT_USER", "RM_EXPORT_PASSWORD", "RM_EXPORT_ENV_USER", "RM_EXPORT_ENV_PASSWORD", "RM_EXPORT_ENV_URL",
  "RM_EXPORT_ENV_EXTRA",
  "RM_EQUIPNET_EQUIPMENT_IP", "RM_EQUIPNET_EQUIPMENT_PORT",
] as const
export type ProfileVariable = (typeof PROFILE_VARIABLES)[number]

export const PROFILE_ENV_FILE = "perfil.env"
export const PROFILE_TEMPLATES_DIR = "plantillas"
