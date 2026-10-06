// The one in-app configuration loader (§2.4, D12). Precedence: process env > config file > profile (perfil.env) > defaults.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import util from "node:util"
import { z } from "zod"
import { createLogger, isUnderJournald, type LogLevel } from "@/server/log"
import { resolveAuthSecret } from "@/server/auth/secret"
import { parsePortRange } from "@/lib/accesses/ports"
import { isValidFilterFormat } from "@/server/accesses/hw-server"
import type { AppConfig, AppMode } from "./schema"
import { detectMode, modeDefaults } from "./modes"
import { DEFAULT_ROOT_WRITE_PATHS, parsePathList } from "@/server/files/copy/policy"
import { ROOTCOPY_SOCKET_DEFAULT } from "@/server/files/copy/protocol"
import { PROFILE_ENV_FILE, PROFILE_VARIABLES } from "@/server/profile/keys"
import { DEFAULT_LAB_NAME } from "@/lib/i18n/common"

export interface LoadConfigOptions { ensureDirs: boolean; ensureSecret: boolean }

export class ConfigError extends Error {
  readonly variable: string | null
  constructor(variable: string | null, message: string) {
    super(message)
    this.name = "ConfigError"
    this.variable = variable
  }
}

/** The file-system operations the loader needs (injectable for tests). */
export interface ConfigFs {
  readText(p: string): string | null
  exists(p: string): boolean
  realpath(p: string): string
  canRead(p: string): boolean
  mkdirp(p: string, mode: number): void
  writeFileExclusive(p: string, data: string, mode: number): void
  fileMode(p: string): number | null
  chmod(p: string, mode: number): void
  isOwnedByProcess(p: string): boolean
}

export interface ConfigContext {
  env: Record<string, string | undefined>
  argv1?: string
  cwd: string
  fs: ConfigFs
  log: { info(msg: string): void; warn(msg: string): void }
  /** Home of the process user from the passwd entry (fallback when HOME is unset); null = unknown. */
  home?: string | null
}

export function nodeConfigFs(): ConfigFs {
  return {
    readText(p) {
      try { return fs.readFileSync(p, "utf8") } catch { return null }
    },
    exists: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
    canRead(p) {
      try {
        fs.accessSync(p, fs.constants.R_OK)
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    },
    mkdirp: (p, mode) => { fs.mkdirSync(p, { recursive: true, mode }) },
    writeFileExclusive: (p, data, mode) => { fs.writeFileSync(p, data, { flag: "wx", mode }) },
    fileMode(p) {
      try { return fs.statSync(p).mode & 0o777 } catch { return null }
    },
    chmod: (p, mode) => { fs.chmodSync(p, mode) },
    isOwnedByProcess(p) {
      try { return typeof process.getuid !== "function" || fs.statSync(p).uid === process.getuid() } catch { return false }
    },
  }
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------
export const KNOWN_VARIABLES = [
  "RM_MODE", "RM_DEV", "RM_CONFIG", "RM_APP_DIR", "RM_HOST", "RM_PORT", "RM_DATA_DIR", "RM_DB_FILE", "RM_BACKUP_DIR", "RM_CAPTURE_DIR",
  "RM_AUTH_SECRET", "RM_SESSION_MAX_AGE_H", "RM_TLS_CERT", "RM_TLS_KEY", "RM_LOG_LEVEL", "RM_SETUP_TOKEN", "RM_ALLOW_ROOT",
  "RM_SERIAL_DEV_ROOT", "RM_SERIAL_SYS_ROOT", "RM_SERIAL_EXTRA_GLOBS", "RM_SERIAL_INCLUDE_BUILTIN", "RM_SERIAL_HIDE_JTAG",
  "RM_SERIAL_SCAN_INTERVAL_MS", "RM_SERIAL_SETTLE_MS", "RM_SERIAL_ALLOW_POKE", "RM_SERIAL_HISTORY_KB", "RM_CAPTURE_ENABLED",
  "RM_RELAY_POLL_MS", "RM_RELAY_OFFLINE_POLL_MS", "RM_RELAY_TIMEOUT_MS", "RM_RELAY_PASSIVE_DISCOVERY", "RM_RELAY_DISCOVERY_PORT",
  "RM_RELAY_DISCOVERY_BROADCASTS", "RM_RELAY_SCAN_CIDRS", "RM_RELAY_SCAN_PORTS", "RM_RELAY_SIMULATE", "RM_ALLOW_UNKNOWN_MIGRATIONS",
  "RM_ACCESS_PORTS", "RM_ACCESS_BIND", "RM_ACCESS_MAX_CONNECTIONS", "RM_HW_SERVER", "RM_JTAG_SYS_ROOT",
  "RM_HW_SERVER_FILTER_FORMAT",
  "RM_FILES_ENABLED", "RM_FILES_DIR", "RM_FILES_MAX_UPLOAD_MB", "RM_FILES_DELETE",
  "RM_PROFILE_DIR", ...PROFILE_VARIABLES,
  "RM_COPY_ENABLED", "RM_COPY_ROOTS", "RM_COPY_DENY", "RM_COPY_ROOT_PATHS", "RM_COPY_SUDO_GROUPS", "RM_COPY_HELPER_SOCKET", "RM_SUDO_USER",
  "RM_COPY_TEST_REMOVABLE",
  "RM_NET_HOST", "RM_NET_SYS_ROOT", "RM_NET_IP_BIN", "RM_NET_ALLOW_NON_USB", "RM_NET_SWITCH_HTTP_PORT", "RM_NET_POLL_MS",
] as const
/** Decided before the file is read, so the file cannot set them. */
const PROCESS_ONLY = new Set(["RM_MODE", "RM_DEV", "RM_CONFIG", "RM_APP_DIR"])
const PROFILE_ALLOWED = new Set<string>(PROFILE_VARIABLES)
/** Variables the download script may not get under a configured name: its fixed environment and the loader's/shell's. */
const RESERVED_SCRIPT_ENV = /^(PATH|HOME|TMPDIR|LANG|LC_[A-Z_]*|CI|PWD|OLDPWD|SHELL|SHELLOPTS|BASHOPTS|BASH_ENV|ENV|IFS|CDPATH|PS4|GLOBIGNORE|LD_[A-Z0-9_]*|BASH_FUNC_[A-Z0-9_]*|RM_[A-Z0-9_]*)$/
export const EXPORT_DEFAULTS = {
  name: "Descargas",
  title: "Ejecutar script de descarga…",
  description: "El servidor ejecuta el script de descarga configurado y guarda el resultado (un .zip) en la carpeta elegida. Puede tardar varios minutos: sigue aquí o vuelve más tarde.",
  appLabel: "Aplicación",
  versionLabel: "Versión",
} as const
const SECRET_PLACEHOLDERS = new Set(["tu-secreto-super-seguro-aqui", "changeme", "secret"])
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

const invalid = (name: string, rule: string) => new ConfigError(name, `Valor no válido en ${name}: ${rule}`)

function intIn(name: string, v: string, min: number, max: number): number {
  const r = z.coerce.number().int().min(min).max(max).safeParse(v.trim())
  if (!/^-?\d+$/.test(v.trim()) || !r.success) throw invalid(name, `debe ser un número entero entre ${min} y ${max}`)
  return r.data
}
function bool(name: string, v: string): boolean {
  const s = v.trim().toLowerCase()
  if (s === "1" || s === "true") return true
  if (s === "0" || s === "false") return false
  throw invalid(name, "usa 0 o 1")
}
function oneOf<T extends string>(name: string, v: string, values: readonly T[]): T {
  const s = v.trim() as T
  if (!values.includes(s)) throw invalid(name, `usa uno de: ${values.join(", ")}`)
  return s
}
function list(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------
export function resolveConfig(opts: LoadConfigOptions, ctx: ConfigContext): AppConfig {
  const pe = (k: string): string | undefined => {
    const v = ctx.env[k]
    return v === undefined || v === "" ? undefined : v
  }
  const abs = (p: string) => path.resolve(ctx.cwd, p)

  // 1. Mode and app dir: process env only.
  const rmModeRaw = pe("RM_MODE")
  const rmMode = rmModeRaw ? oneOf<AppMode>("RM_MODE", rmModeRaw, ["native", "portable", "docker", "dev"]) : undefined
  const devFlag = pe("RM_DEV") !== undefined ? bool("RM_DEV", pe("RM_DEV") ?? "0") : false
  const dev = devFlag || rmMode === "dev"
  const appDirRaw = pe("RM_APP_DIR")
  const appDir = appDirRaw ? abs(appDirRaw) : dev ? ctx.cwd : path.dirname(abs(ctx.argv1 ?? path.join(ctx.cwd, "server.js")))
  const mode = detectMode(rmMode, dev, appDir, ctx.fs)
  const defaults = modeDefaults(mode, appDir)

  // 2. Config file (optional in every mode; never overrides process env).
  const configPath = pe("RM_CONFIG") ? abs(pe("RM_CONFIG") ?? "") : defaults.configFile
  const text = ctx.fs.readText(configPath)
  let fileVars: Record<string, string> = {}
  let configFile: string | null = null
  if (text !== null) {
    configFile = configPath
    try {
      fileVars = util.parseEnv(text) as Record<string, string>
    } catch (err) {
      throw new ConfigError(null, `No se puede leer el fichero de configuración ${configPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const k of Object.keys(fileVars)) {
      if (!k.startsWith("RM_")) continue
      if (PROCESS_ONLY.has(k)) {
        ctx.log.warn(`${k} se ignora en ${configPath}: defínelo en el entorno del proceso`)
        delete fileVars[k]
      } else if (!(KNOWN_VARIABLES as readonly string[]).includes(k)) {
        ctx.log.warn(`Variable desconocida en ${configPath}: ${k}`)
      }
    }
  } else if (pe("RM_CONFIG")) {
    ctx.log.warn(`No existe el fichero de configuración ${configPath}: se usan los valores por defecto`)
  }
  // 2b. Profile: RM_PROFILE_DIR (process env or config file) or the mode default; perfil.env sets project defaults only.
  const profileRaw = pe("RM_PROFILE_DIR") ?? (fileVars.RM_PROFILE_DIR || undefined)
  const profilePath = profileRaw ? abs(profileRaw) : defaults.profileDir
  const profileDir = ctx.fs.exists(profilePath) ? profilePath : null
  const profileWarnings: string[] = []
  let profileVars: Record<string, string> = {}
  let profileEnvFile: string | null = null
  if (profileDir) {
    const envPath = path.join(profileDir, PROFILE_ENV_FILE)
    const ptext = ctx.fs.readText(envPath)
    if (ptext !== null) {
      profileEnvFile = envPath
      try {
        profileVars = util.parseEnv(ptext) as Record<string, string>
      } catch (err) {
        throw new ConfigError(null, `No se puede leer el perfil ${envPath}: ${err instanceof Error ? err.message : String(err)}`)
      }
      for (const k of Object.keys(profileVars)) {
        if (!PROFILE_ALLOWED.has(k)) {
          profileWarnings.push(`Variable no permitida en ${PROFILE_ENV_FILE}: ${k} (se ignora; defínela en config.env)`)
          delete profileVars[k]
        }
      }
      for (const w of profileWarnings) ctx.log.warn(w)
    }
  } else if (profileRaw) {
    ctx.log.warn(`No existe la carpeta del perfil ${profilePath} (RM_PROFILE_DIR): se usan los valores genéricos`)
  }
  const fromProfile = (k: string): boolean => pe(k) === undefined && !fileVars[k] && profileVars[k] !== undefined && profileVars[k] !== ""
  const get = (k: string): string | undefined => {
    const v = pe(k) ?? (fileVars[k] || undefined) ?? profileVars[k]
    return v === undefined || v === "" ? undefined : v
  }
  /** "RM_X" or "RM_X (…/perfil.env)" for messages about a value that came from the profile. */
  const nameOf = (k: string): string => (fromProfile(k) && profileEnvFile ? `${k} (${profileEnvFile})` : k)

  // 3. Values.
  const host = get("RM_HOST")?.trim() ?? "0.0.0.0"
  if (!(net.isIP(host) || HOSTNAME.test(host))) throw invalid("RM_HOST", "usa una dirección IPv4/IPv6 o un nombre de host")
  const port = get("RM_PORT") ? intIn("RM_PORT", get("RM_PORT") ?? "", 0, 65535) : 3200

  const dataDir = get("RM_DATA_DIR") ? abs(get("RM_DATA_DIR") ?? "") : defaults.dataDir
  const dbFile = get("RM_DB_FILE") ? abs(get("RM_DB_FILE") ?? "") : path.join(dataDir, "relay-manager.db")
  const backupDir = get("RM_BACKUP_DIR") ? abs(get("RM_BACKUP_DIR") ?? "") : path.join(dataDir, "backups")
  const captureDir = get("RM_CAPTURE_DIR") ? abs(get("RM_CAPTURE_DIR") ?? "") : path.join(dataDir, "consoles")

  const envSecret = get("RM_AUTH_SECRET") ?? null
  if (envSecret !== null) {
    if (SECRET_PLACEHOLDERS.has(envSecret.trim())) throw invalid("RM_AUTH_SECRET", "es un valor de ejemplo: genera uno propio (openssl rand -base64 32)")
    if (envSecret.length < 32) throw invalid("RM_AUTH_SECRET", "debe tener al menos 32 caracteres")
  }

  const sessionMaxAgeHours = get("RM_SESSION_MAX_AGE_H") ? intIn("RM_SESSION_MAX_AGE_H", get("RM_SESSION_MAX_AGE_H") ?? "", 1, 168) : 12

  const cert = get("RM_TLS_CERT")
  const key = get("RM_TLS_KEY")
  let tls: AppConfig["tls"] = null
  if (cert || key) {
    if (!cert || !key) throw new ConfigError(cert ? "RM_TLS_KEY" : "RM_TLS_CERT", "Define RM_TLS_CERT y RM_TLS_KEY a la vez, o ninguna de las dos")
    const certFile = abs(cert)
    const keyFile = abs(key)
    if (!ctx.fs.canRead(certFile)) throw invalid("RM_TLS_CERT", `no se puede leer ${certFile}`)
    if (!ctx.fs.canRead(keyFile)) throw invalid("RM_TLS_KEY", `no se puede leer ${keyFile}`)
    tls = { certFile, keyFile }
  }

  const logLevel: LogLevel = get("RM_LOG_LEVEL") ? oneOf<LogLevel>("RM_LOG_LEVEL", get("RM_LOG_LEVEL") ?? "", ["debug", "info", "warn", "error"]) : "info"

  const setupTokenOverride = get("RM_SETUP_TOKEN")?.trim() ?? null
  if (setupTokenOverride !== null) {
    const min = dev ? 8 : 16
    if (setupTokenOverride.replace(/[\s-]+/g, "").length < min) {
      throw invalid("RM_SETUP_TOKEN", `debe tener al menos ${min} caracteres sin contar espacios ni guiones`)
    }
  }

  const flag = (k: string, def: boolean) => (get(k) !== undefined ? bool(k, get(k) ?? "") : def)
  const num = (k: string, def: number, min: number, max: number) => (get(k) !== undefined ? intIn(k, get(k) ?? "", min, max) : def)

  // Serial extra globs: only the last component may contain * or ?; the directory must be on the allow-list.
  const extraGlobs = list(get("RM_SERIAL_EXTRA_GLOBS") ?? "").map((g) => {
    const full = abs(g)
    const dir = path.dirname(full)
    if (/[*?[\]]/.test(dir)) throw invalid("RM_SERIAL_EXTRA_GLOBS", `solo el último componente puede tener comodines (${g})`)
    const allowed = ["/run/relay-manager/", "/run/user/", "/dev/", path.join(dataDir, "sim") + "/"]
    if (dev) allowed.push(path.join(appDir, ".data", "sim") + "/")
    if (!allowed.some((p) => (dir + "/").startsWith(p))) {
      throw invalid("RM_SERIAL_EXTRA_GLOBS", `el directorio de ${g} no está permitido (usa /dev/, /run/relay-manager/, /run/user/ o <datos>/sim/)`)
    }
    return full
  })

  const broadcastsRaw = get("RM_RELAY_DISCOVERY_BROADCASTS")
  const broadcastTargets = broadcastsRaw !== undefined ? list(broadcastsRaw) : null
  if (broadcastTargets?.some((b) => !IPV4.test(b))) throw invalid("RM_RELAY_DISCOVERY_BROADCASTS", "lista de direcciones IPv4 separadas por comas")

  const cidrsRaw = get("RM_RELAY_SCAN_CIDRS")
  const scanCidrs = cidrsRaw !== undefined ? list(cidrsRaw) : null
  for (const c of scanCidrs ?? []) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(c)
    if (!m || !IPV4.test(m[1]) || Number(m[2]) < 22 || Number(m[2]) > 32) throw invalid("RM_RELAY_SCAN_CIDRS", `usa redes /22 o más pequeñas (${c})`)
  }

  const portsRaw = get("RM_RELAY_SCAN_PORTS")
  const scanPorts = portsRaw !== undefined ? list(portsRaw).map((p) => intIn("RM_RELAY_SCAN_PORTS", p, 1, 65535)) : [80]
  if (scanPorts.length < 1 || scanPorts.length > 4) throw invalid("RM_RELAY_SCAN_PORTS", "entre 1 y 4 puertos separados por comas")

  const rangeRaw = get("RM_ACCESS_PORTS") ?? "3201-3230"
  const accessRange = parsePortRange(rangeRaw)
  if (!accessRange) throw invalid("RM_ACCESS_PORTS", "usa un rango como 3201-3230 (puertos 1024 a 65535, como mucho 1000)")
  const accessBind = get("RM_ACCESS_BIND")?.trim() ?? "0.0.0.0"
  if (!(net.isIP(accessBind) || HOSTNAME.test(accessBind))) throw invalid("RM_ACCESS_BIND", "usa una dirección IPv4/IPv6 o un nombre de host")
  const hwServerFilter = get("RM_HW_SERVER_FILTER_FORMAT")?.trim() || "{serial}"
  if (!isValidFilterFormat(hwServerFilter)) throw invalid("RM_HW_SERVER_FILTER_FORMAT", "debe contener {serial} (y opcionalmente {vendor}); solo letras, números y / . _ : , * -")
  const serialSysRoot = get("RM_SERIAL_SYS_ROOT") ? abs(get("RM_SERIAL_SYS_ROOT") ?? "") : "/sys"

  const home = pe("HOME") ?? ctx.home ?? null
  const filesDir = get("RM_FILES_DIR")
    ? abs(get("RM_FILES_DIR") ?? "")
    : defaultFilesDir(mode, dataDir, home && path.isAbsolute(home) ? home : null)
  checkFilesDir(filesDir, { dataDir, backupDir, captureDir, dbDir: path.dirname(dbFile), appDir })
  const text1 = (k: string, max: number): string | null => {
    const v = get(k)?.trim()
    if (!v) return null
    if (v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw invalid(nameOf(k), `como mucho ${max} caracteres y sin caracteres de control`)
    return v
  }
  // The second shared folder («extra»): only when the profile (or config.env) names it.
  const extraName = text1("RM_FILES_EXTRA_NAME", 40)
  if (extraName !== null && /[/\\]/.test(extraName)) throw invalid(nameOf("RM_FILES_EXTRA_NAME"), "sin «/» ni «\\»")
  const extraEnabled = extraName !== null && flag("RM_FILES_EXTRA_ENABLED", true)
  const homeDir = home && path.isAbsolute(home) ? home : null
  const extraDirRaw = get("RM_FILES_EXTRA_DIR")?.trim()
  let extraDir: string
  if (extraDirRaw && (extraDirRaw === "~" || extraDirRaw.startsWith("~/"))) {
    const rest = extraDirRaw.slice(2) || extraName || "extra"
    // Native: install.sh writes the absolute folder of the installing user into config.env.
    extraDir = mode === "docker" ? "/extra" : mode === "native" || !homeDir ? path.join(dataDir, path.basename(rest)) : path.join(homeDir, rest)
  } else if (extraDirRaw) {
    extraDir = fromProfile("RM_FILES_EXTRA_DIR") && profileDir ? path.resolve(profileDir, extraDirRaw) : abs(extraDirRaw)
  } else {
    extraDir = defaultExtraDir(mode, dataDir, homeDir, extraName ?? "extra")
  }
  if (extraEnabled) {
    checkFilesDir(extraDir, { dataDir, backupDir, captureDir, dbDir: path.dirname(dbFile), appDir }, "RM_FILES_EXTRA_DIR")
    if (within(extraDir, filesDir) || within(filesDir, extraDir)) {
      throw invalid("RM_FILES_EXTRA_DIR", `${extraDir} no puede ser ${filesDir} (RM_FILES_DIR) ni estar una carpeta dentro de la otra`)
    }
  }
  const deleteRaw = get("RM_FILES_DELETE")
  const files: AppConfig["files"] = {
    enabled: flag("RM_FILES_ENABLED", true),
    dir: filesDir,
    maxUploadBytes: num("RM_FILES_MAX_UPLOAD_MB", 4096, 1, 1024 * 1024) * 1024 * 1024,
    deleteAdminOnly: deleteRaw ? oneOf("RM_FILES_DELETE", deleteRaw, ["users", "admins"]) === "admins" : false,
    extraEnabled,
    extraDir,
    extraName: extraName ?? "extra",
    extraHint: text1("RM_FILES_EXTRA_HINT", 120) ?? "Segunda carpeta compartida",
  }
  const exportUser = get("RM_EXPORT_USER")?.trim() || null
  if (exportUser !== null && !/^[A-Za-z0-9_.@+-]{1,128}$/.test(exportUser)) throw invalid(nameOf("RM_EXPORT_USER"), "solo letras, números y . _ @ + - (como mucho 128)")
  const exportPassword = get("RM_EXPORT_PASSWORD") ?? null
  if (exportPassword !== null && (exportPassword.length > 512 || /[\u0000-\u001f\u007f]/.test(exportPassword))) throw invalid(nameOf("RM_EXPORT_PASSWORD"), "sin caracteres de control y como mucho 512")
  const exportUrl = get("RM_EXPORT_URL")?.trim() || null
  if (exportUrl !== null && !/^https?:\/\/[A-Za-z0-9.:\[\]_-]+(\/[A-Za-z0-9._~%/-]*)?$/.test(exportUrl)) throw invalid(nameOf("RM_EXPORT_URL"), "usa una URL http(s)://servidor[:puerto]/ruta")
  // Names of the variables the script gets them in (the profile adapts them to its script) and fixed extra variables.
  const envName = (k: string, def: string): string => {
    const v = get(k)?.trim() || def
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(v) || RESERVED_SCRIPT_ENV.test(v)) throw invalid(nameOf(k), "usa un nombre de variable en mayúsculas (A-Z, 0-9, _) que no sea del sistema (PATH, HOME, LD_*…)")
    return v
  }
  const envUser = envName("RM_EXPORT_ENV_USER", "EXPORT_USER")
  const envPassword = envName("RM_EXPORT_ENV_PASSWORD", "EXPORT_PASSWORD")
  const envUrl = envName("RM_EXPORT_ENV_URL", "EXPORT_URL")
  if (new Set([envUser, envPassword, envUrl]).size !== 3) throw invalid(nameOf("RM_EXPORT_ENV_USER"), "RM_EXPORT_ENV_USER, RM_EXPORT_ENV_PASSWORD y RM_EXPORT_ENV_URL deben ser distintas")
  const envExtra: Record<string, string> = {}
  for (const item of (get("RM_EXPORT_ENV_EXTRA") ?? "").split(/\s+/).filter(Boolean)) {
    const m = /^([A-Z_][A-Z0-9_]{0,63})=([A-Za-z0-9_.:/@+-]{0,200})$/.exec(item)
    if (!m || RESERVED_SCRIPT_ENV.test(m[1]) || [envUser, envPassword, envUrl].includes(m[1])) {
      throw invalid(nameOf("RM_EXPORT_ENV_EXTRA"), `«${item}»: usa NOMBRE=valor separados por espacios (nombres en mayúsculas que no sean del sistema ni los de usuario, contraseña o URL; valores con letras, números y . _ : / @ + -)`)
    }
    envExtra[m[1]] = m[2]
  }
  if (Object.keys(envExtra).length > 16) throw invalid(nameOf("RM_EXPORT_ENV_EXTRA"), "como mucho 16 variables")
  const scriptRaw = get("RM_EXPORT_DOWNLOADER")?.trim()
  const exportRootRaw = get("RM_EXPORT_ROOT")
  const exportsCfg: AppConfig["exports"] = {
    enabled: flag("RM_EXPORT_ENABLED", false),
    script: scriptRaw ? (fromProfile("RM_EXPORT_DOWNLOADER") && profileDir ? path.resolve(profileDir, scriptRaw) : abs(scriptRaw)) : null,
    timeoutMs: num("RM_EXPORT_TIMEOUT_MIN", 60, 1, 24 * 60) * 60_000,
    root: exportRootRaw ? oneOf(nameOf("RM_EXPORT_ROOT"), exportRootRaw, ["tftp", "extra"] as const) : extraEnabled ? "extra" : "tftp",
    name: text1("RM_EXPORT_NAME", 40) ?? EXPORT_DEFAULTS.name,
    title: text1("RM_EXPORT_TITLE", 80) ?? EXPORT_DEFAULTS.title,
    description: text1("RM_EXPORT_DESCRIPTION", 600) ?? EXPORT_DEFAULTS.description,
    appLabel: text1("RM_EXPORT_APP_LABEL", 40) ?? EXPORT_DEFAULTS.appLabel,
    versionLabel: text1("RM_EXPORT_VERSION_LABEL", 40) ?? EXPORT_DEFAULTS.versionLabel,
    extractLabel: text1("RM_EXPORT_EXTRACT_LABEL", 80),
    user: exportUser,
    password: exportPassword === "" ? null : exportPassword,
    url: exportUrl,
    envUser,
    envPassword,
    envUrl,
    envExtra,
  }
  const equipmentIpRaw = get("RM_EQUIPNET_EQUIPMENT_IP")?.trim() ?? null
  if (equipmentIpRaw !== null && !IPV4.test(equipmentIpRaw)) throw invalid(nameOf("RM_EQUIPNET_EQUIPMENT_IP"), "usa una dirección IPv4 (p. ej. 192.168.1.10)")
  const defaultsCfg: AppConfig["defaults"] = {
    labName: text1("RM_LAB_NAME", 40) ?? DEFAULT_LAB_NAME,
    equipmentIp: equipmentIpRaw,
    equipmentPort: get("RM_EQUIPNET_EQUIPMENT_PORT") ? intIn(nameOf("RM_EQUIPNET_EQUIPMENT_PORT"), get("RM_EQUIPNET_EQUIPMENT_PORT") ?? "", 1, 65535) : 22,
  }

  const pathList = (k: string, def: readonly string[]) => {
    const raw = get(k)
    if (raw === undefined) return [...def]
    try {
      return parsePathList(raw, k)
    } catch (e) {
      throw invalid(k, `${e instanceof Error ? e.message : String(e)} (lista de rutas absolutas separadas por comas)`)
    }
  }
  const sudoUserRaw = get("RM_SUDO_USER")?.trim()
  if (sudoUserRaw !== undefined && !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(sudoUserRaw)) throw invalid("RM_SUDO_USER", "nombre de usuario no válido")
  const helperSocketRaw = get("RM_COPY_HELPER_SOCKET")
  const copy: AppConfig["copy"] = {
    enabled: flag("RM_COPY_ENABLED", true),
    roots: pathList("RM_COPY_ROOTS", ["/"]),
    deny: pathList("RM_COPY_DENY", []),
    rootPaths: pathList("RM_COPY_ROOT_PATHS", DEFAULT_ROOT_WRITE_PATHS),
    // Native: install.sh writes the user that ran it; elsewhere, the user running the app.
    sudoUser: sudoUserRaw ?? (mode === "native" || mode === "docker" ? null : pe("USER") ?? pe("LOGNAME") ?? null),
    helperSocket: helperSocketRaw ? abs(helperSocketRaw) : mode === "native" ? ROOTCOPY_SOCKET_DEFAULT : null,
    testRemovable: null,
  }
  const testRemovable = get("RM_COPY_TEST_REMOVABLE")?.trim()
  if (testRemovable) {
    // Tests only (the systemd test containers): a loop device stands in for a USB stick in the drive list.
    if (!/^\/dev\/loop\d{1,3}$/.test(testRemovable)) throw invalid("RM_COPY_TEST_REMOVABLE", "solo para pruebas: /dev/loopN")
    copy.testRemovable = testRemovable
  }
  if (copy.roots.length === 0) throw invalid("RM_COPY_ROOTS", "indica al menos una carpeta (por defecto /)")
  if (copy.rootPaths.includes("/")) throw invalid("RM_COPY_ROOT_PATHS", "no puede incluir «/»: indica carpetas concretas (por defecto /media,/run/media,/mnt)")

  const config: AppConfig = {
    mode, dev,
    appDir, bundleRoot: defaults.bundleRoot, configFile,
    dataDir, dbFile, backupDir, captureDir,
    pidFile: path.join(dataDir, "server.pid"),
    lockFile: path.join(dataDir, ".instance-lock"),
    host, port, tls, sessionMaxAgeHours, logLevel,
    authSecret: null,
    setupTokenOverride,
    allowUnknownMigrations: flag("RM_ALLOW_UNKNOWN_MIGRATIONS", false),
    allowRoot: flag("RM_ALLOW_ROOT", false),
    serial: {
      devRoot: get("RM_SERIAL_DEV_ROOT") ? abs(get("RM_SERIAL_DEV_ROOT") ?? "") : "/dev",
      sysRoot: serialSysRoot,
      extraGlobs,
      includeBuiltin: flag("RM_SERIAL_INCLUDE_BUILTIN", false),
      hideJtag: flag("RM_SERIAL_HIDE_JTAG", true),
      scanIntervalMs: num("RM_SERIAL_SCAN_INTERVAL_MS", 2000, 500, 60000),
      settleMs: num("RM_SERIAL_SETTLE_MS", 800, 0, 10000),
      allowPoke: flag("RM_SERIAL_ALLOW_POKE", true),
      historyBytes: num("RM_SERIAL_HISTORY_KB", 256, 16, 4096) * 1024,
    },
    capture: { enabled: flag("RM_CAPTURE_ENABLED", true) },
    files,
    exports: exportsCfg,
    copy,
    accesses: {
      range: accessRange,
      bind: accessBind,
      hwServer: get("RM_HW_SERVER") ? abs(get("RM_HW_SERVER") ?? "") : null,
      jtagSysRoot: get("RM_JTAG_SYS_ROOT") ? abs(get("RM_JTAG_SYS_ROOT") ?? "") : serialSysRoot,
      maxConnections: num("RM_ACCESS_MAX_CONNECTIONS", 8, 1, 64),
      hwServerFilter,
    },
    net: {
      hostMode: get("RM_NET_HOST") ? oneOf("RM_NET_HOST", get("RM_NET_HOST") ?? "", ["apply", "off"]) as "apply" | "off" : "apply",
      sysRoot: get("RM_NET_SYS_ROOT") ? abs(get("RM_NET_SYS_ROOT") ?? "") : serialSysRoot,
      ipBin: get("RM_NET_IP_BIN") ? abs(get("RM_NET_IP_BIN") ?? "") : null,
      allowNonUsb: flag("RM_NET_ALLOW_NON_USB", false),
      switchHttpPort: num("RM_NET_SWITCH_HTTP_PORT", 80, 1, 65535),
      pollMs: num("RM_NET_POLL_MS", 10000, 2000, 300000),
    },
    relays: {
      pollMs: num("RM_RELAY_POLL_MS", 5000, 1000, 60000),
      offlinePollMs: num("RM_RELAY_OFFLINE_POLL_MS", 15000, 5000, 300000),
      timeoutMs: num("RM_RELAY_TIMEOUT_MS", 1500, 200, 10000),
      passiveDiscovery: flag("RM_RELAY_PASSIVE_DISCOVERY", true),
      discoveryPort: num("RM_RELAY_DISCOVERY_PORT", 30303, 1, 65535),
      broadcastTargets,
      scanCidrs,
      scanPorts,
      simulate: flag("RM_RELAY_SIMULATE", dev),
    },
    profile: { dir: profileDir, path: profilePath, explicit: !!profileRaw, envFile: profileEnvFile, warnings: profileWarnings },
    defaults: defaultsCfg,
    build: readBuildInfo(ctx.fs, appDir, defaults.bundleRoot, dev),
  }

  // 4. Side effects, only when asked (doctor, setup-token and ping create nothing).
  if (opts.ensureDirs) {
    for (const d of [dataDir, backupDir, captureDir]) ctx.fs.mkdirp(d, 0o750)
  }
  config.authSecret = resolveAuthSecret({ envSecret, dataDir, ensureSecret: opts.ensureSecret, fs: ctx.fs, log: ctx.log })
  return config
}

/**
 * "Archivos" default folder: the "tftp" folder in the home of the user running the app (dev, portable), the data dir
 * of the service (native: install.sh normally writes the home folder of the admin who installed it), /files in Docker
 * (a bind mount of the host folder).
 */
export function defaultFilesDir(mode: AppMode, dataDir: string, home: string | null): string {
  if (mode === "docker") return "/files"
  if (mode === "native" || !home) return path.join(dataDir, "tftp")
  return path.join(home, "tftp")
}

/** The second root («extra»): ~/<name> of the user running the app (dev, portable), <datos>/<name> in native (install.sh
 * normally writes the folder of the installing user), /extra in Docker (a bind mount of the host folder). */
export function defaultExtraDir(mode: AppMode, dataDir: string, home: string | null, name: string): string {
  if (mode === "docker") return "/extra"
  if (mode === "native" || !home) return path.join(dataDir, name)
  return path.join(home, name)
}

const SYSTEM_DIRS = new Set(["/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt", "/proc", "/root", "/run",
  "/sbin", "/srv", "/sys", "/tmp", "/usr", "/var", "/var/lib", "/var/tmp", "/media", "/mnt"])
const within = (child: string, parent: string) => child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`)

/**
 * Every logged-in user can read and write the files folder: it must never expose the data (database, secret,
 * backups, captures) nor the application, and it cannot be a system folder. A dedicated subfolder of the data dir
 * (the native fallback <datos>/tftp) is fine. Lexical check; the service re-checks the real paths at run time.
 */
function checkFilesDir(dir: string, p: { dataDir: string; backupDir: string; captureDir: string; dbDir: string; appDir: string }, name = "RM_FILES_DIR"): void {
  const bad = (why: string) => invalid(name, `${dir} ${why}: usa una carpeta propia, por ejemplo ${name === "RM_FILES_DIR" ? "~/tftp" : "~/compartida"}`)
  if (SYSTEM_DIRS.has(dir) || within(dir, "/etc") || within(dir, "/proc") || within(dir, "/sys") || within(dir, "/dev")) throw bad("es una carpeta del sistema")
  for (const d of [p.dataDir, p.backupDir, p.captureDir, p.dbDir, p.appDir]) {
    if (within(d, dir)) throw bad(`contiene ${d}`)
  }
  for (const d of [p.backupDir, p.captureDir]) {
    if (within(dir, d)) throw bad(`está dentro de ${d}`)
  }
}

function readBuildInfo(fsx: ConfigFs, appDir: string, bundleRoot: string | null, dev: boolean): AppConfig["build"] {
  let version = "0.0.0"
  const pkg = fsx.readText(path.join(appDir, "package.json"))
  if (pkg) {
    try {
      const v = (JSON.parse(pkg) as { version?: unknown }).version
      if (typeof v === "string") version = v
    } catch { /* keep default */ }
  }
  const buildId = dev ? "dev" : fsx.readText(path.join(appDir, ".next", "BUILD_ID"))?.trim() || "dev"
  let rev = "dev"
  let builtAt: string | null = null
  const info = bundleRoot ? fsx.readText(path.join(bundleRoot, "BUILDINFO")) : null
  if (info) {
    for (const line of info.split(/\r?\n/)) {
      const m = /^([a-z]+)=(.*)$/.exec(line.trim())
      if (m?.[1] === "rev" && m[2]) rev = m[2]
      if (m?.[1] === "built" && m[2]) builtAt = m[2]
    }
  }
  return { version, buildId, rev, builtAt }
}

function passwdHome(): string | null {
  try {
    return os.userInfo().homedir || null
  } catch {
    return null // no passwd entry (containers with an arbitrary uid)
  }
}

/** Loads the configuration for this process. Throws ConfigError (exit 2). */
export function loadConfig(opts: LoadConfigOptions): AppConfig {
  const lvl = process.env.RM_LOG_LEVEL
  const level: LogLevel = lvl === "debug" || lvl === "warn" || lvl === "error" ? lvl : "info"
  const log = createLogger({ level, journald: isUnderJournald() }).child("config")
  return resolveConfig(opts, {
    env: process.env,
    argv1: process.argv[1],
    cwd: process.cwd(),
    fs: nodeConfigFs(),
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
    home: passwdHome(),
  })
}

/**
 * Before import("next"): exports the resolved secret and Auth.js/Next settings into process.env (§2.4).
 * AUTH_URL and NEXTAUTH_URL are always deleted (trustHost + Host header, D28).
 */
export function applyConfigEnv(cfg: AppConfig): void {
  const vars: Record<string, string> = {
    AUTH_TRUST_HOST: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    RM_SESSION_MAX_AGE_H: String(cfg.sessionMaxAgeHours),
    NODE_ENV: cfg.dev ? "development" : "production",
  }
  if (cfg.authSecret) vars.AUTH_SECRET = cfg.authSecret
  Object.assign(process.env, vars)
  delete process.env.AUTH_URL
  delete process.env.NEXTAUTH_URL
}
