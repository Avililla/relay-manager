import type { LogLevel } from "@/server/log"
export type AppMode = "native" | "portable" | "docker" | "dev"
export interface AppConfig {
  mode: AppMode; dev: boolean
  appDir: string; bundleRoot: string | null; configFile: string | null
  dataDir: string; dbFile: string; backupDir: string; captureDir: string
  pidFile: string                   // informational only (D37)
  lockFile: string                  // <dataDir>/.instance-lock
  host: string; port: number
  tls: { certFile: string; keyFile: string } | null
  sessionMaxAgeHours: number
  logLevel: LogLevel
  authSecret: string | null         // null only when loaded with ensureSecret: false and none exists (§2.4)
  setupTokenOverride: string | null
  allowUnknownMigrations: boolean
  allowRoot: boolean                // RM_ALLOW_ROOT
  serial: {
    devRoot: string; sysRoot: string; extraGlobs: string[]; includeBuiltin: boolean; hideJtag: boolean
    scanIntervalMs: number; settleMs: number; allowPoke: boolean; historyBytes: number
  }
  capture: { enabled: boolean }
  /** "Archivos" (RM_FILES_*): the shared folders for file exchange with the engineers' PCs. */
  files: {
    enabled: boolean                  // RM_FILES_ENABLED
    dir: string                       // RM_FILES_DIR (absolute)
    maxUploadBytes: number            // RM_FILES_MAX_UPLOAD_MB
    deleteAdminOnly: boolean          // RM_FILES_DELETE=admins
    extraEnabled: boolean             // the second root ("extra"): RM_FILES_EXTRA_NAME set and RM_FILES_EXTRA_ENABLED not 0
    extraDir: string                  // RM_FILES_EXTRA_DIR (absolute)
    extraName: string                 // RM_FILES_EXTRA_NAME: its label in Archivos
    extraHint: string                 // RM_FILES_EXTRA_HINT: its one-line description
  }
  /** «Descargas» (RM_EXPORT_*): runs the profile's download script into a root of Archivos. */
  exports: {
    enabled: boolean                  // RM_EXPORT_ENABLED (off by default)
    script: string | null             // RM_EXPORT_DOWNLOADER (absolute; relative to the profile dir in perfil.env)
    timeoutMs: number                 // RM_EXPORT_TIMEOUT_MIN (60)
    root: "tftp" | "extra"            // RM_EXPORT_ROOT: where the zip lands (extra when that folder is on, else tftp)
    name: string                      // RM_EXPORT_NAME («Descargas»)
    title: string                     // RM_EXPORT_TITLE («Ejecutar script de descarga…»)
    description: string               // RM_EXPORT_DESCRIPTION
    appLabel: string                  // RM_EXPORT_APP_LABEL («Aplicación»)
    versionLabel: string              // RM_EXPORT_VERSION_LABEL («Versión»)
    extractLabel: string | null       // RM_EXPORT_EXTRACT_LABEL: label of the optional -x checkbox; null = hidden
    user: string | null               // RM_EXPORT_USER → the script's envUser variable
    password: string | null           // RM_EXPORT_PASSWORD → envPassword (never sent to the browser; redacted from the log)
    url: string | null                // RM_EXPORT_URL: repository URL → envUrl; health checks its reachability
    envUser: string                   // RM_EXPORT_ENV_USER (EXPORT_USER): name of the variable with the user
    envPassword: string               // RM_EXPORT_ENV_PASSWORD (EXPORT_PASSWORD): name of the variable with the password
    envUrl: string                    // RM_EXPORT_ENV_URL (EXPORT_URL): name of the variable with the URL
    envExtra: Record<string, string>  // RM_EXPORT_ENV_EXTRA ("NAME=value …"): fixed extra variables for the script's tools
  }
  /** «Copiar a una carpeta del servidor» (RM_COPY_*, RM_SUDO_USER): administrators copy files of the folder to any
   *  allowed folder of the host, as the service or as root through the root helper (relay-manager-rootcopy). */
  copy: {
    enabled: boolean                  // RM_COPY_ENABLED
    roots: string[]                   // RM_COPY_ROOTS: browsable and writable roots ("/")
    deny: string[]                    // RM_COPY_DENY: denied folders on top of the built-in ones
    rootPaths: string[]               // RM_COPY_ROOT_PATHS: where the root helper writes (/media, /run/media, /mnt)
    sudoUser: string | null           // RM_SUDO_USER: shown in the dialog (the helper uses its own copy)
    helperSocket: string | null       // RM_COPY_HELPER_SOCKET; native: /run/relay-manager-rootcopy/rootcopy.sock
    testRemovable: string | null      // RM_COPY_TEST_REMOVABLE: TESTS ONLY, a /dev/loopN listed as a removable device
  }
  /** Network accesses (RM_ACCESS_*): the fixed-port range, the bind address, hw_server and the JTAG sysfs root. */
  accesses: {
    range: { from: number; to: number }
    bind: string
    hwServer: string | null           // RM_HW_SERVER; null = autodetect (XILINX_* env, PATH, /tools/Xilinx, /opt/Xilinx…)
    jtagSysRoot: string               // RM_JTAG_SYS_ROOT, default RM_SERIAL_SYS_ROOT
    maxConnections: number            // per access (serial and TCP forwards)
    hwServerFilter: string            // RM_HW_SERVER_FILTER_FORMAT: jtag-port-filter value, "{serial}" ({vendor} = Digilent|Xilinx)
  }
  /** "Red de equipos" (RM_NET_*): the server side of the equipment network (VLAN interfaces, policy routing, switch). */
  net: {
    hostMode: "apply" | "off"         // RM_NET_HOST: off = never change the server's network (only show the commands)
    sysRoot: string                   // RM_NET_SYS_ROOT, default RM_SERIAL_SYS_ROOT (/sys)
    ipBin: string | null              // RM_NET_IP_BIN; null = /usr/sbin/ip, /sbin/ip…
    allowNonUsb: boolean              // RM_NET_ALLOW_NON_USB: allow a non-USB adapter (tests, special hardware)
    switchHttpPort: number            // RM_NET_SWITCH_HTTP_PORT (80; simulators)
    pollMs: number                    // RM_NET_POLL_MS: switch link poll
  }
  relays: {
    pollMs: number; offlinePollMs: number; timeoutMs: number
    passiveDiscovery: boolean; discoveryPort: number
    broadcastTargets: string[] | null; scanCidrs: string[] | null; scanPorts: number[]
    simulate: boolean
  }
  /** The profile («perfil»): project defaults (perfil.env) and equipment templates (plantillas/*.json). */
  profile: {
    dir: string | null                // the profile directory, when it exists
    path: string                      // where it was looked for (RM_PROFILE_DIR or the mode default)
    explicit: boolean                 // RM_PROFILE_DIR was set
    envFile: string | null            // <dir>/perfil.env, when present
    warnings: string[]                // perfil.env lines that were ignored (Spanish)
  }
  /** Project defaults, usually from the profile. */
  defaults: {
    labName: string                   // RM_LAB_NAME: Settings.labName of a new database («Relay Manager»)
    equipmentIp: string | null        // RM_EQUIPNET_EQUIPMENT_IP: «IP de los equipos» of a new Red de equipos row
    equipmentPort: number             // RM_EQUIPNET_EQUIPMENT_PORT (22): new Ethernet accesses, «Enviar a equipo»
  }
  build: { version: string; buildId: string; rev: string; builtAt: string | null }
}
