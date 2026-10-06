// Root helper entry point (bundled to app/rootcopy.js, run by relay-manager-rootcopy.service with the bundled node;
// with the argument "mount", by relay-manager-rootmount.service: the mount helper, src/server/rootmount/main.ts).
//
// As root (the service): socket activation only (the listening socket comes from relay-manager-rootcopy.socket,
// root:relay-manager 0660), configuration from /etc/relay-manager/rootcopy.env, accounts from /etc/passwd, /etc/group
// and /etc/shadow, state in $STATE_DIRECTORY. Exits after 2 minutes without connections (systemd starts it again on the
// next one). As another user (tests, development) the RM_ROOTCOPY_* variables may point elsewhere; they are ignored
// when running as root, so the unit's environment is the only thing that matters there.
import fs from "node:fs"
import path from "node:path"
import { ROOTCOPY_CONFIG_DEFAULT, ROOTMOUNT_SOCKET_DEFAULT } from "@/server/files/copy/protocol"
import { runMountHelper } from "@/server/rootmount/main"
import { AttemptLimiter, createCrypter, SYSTEM_ACCOUNT_FILES, type AccountFiles } from "./auth"
import { createRootCopyServer, loadHelperConfig } from "./server"
import { TokenStore } from "./token"

const VERSION = process.env.RM_BUILD_VERSION ?? "dev"
const IDLE_MS = 120_000

function log(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

function main(): void {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0
  const env = (k: string) => (isRoot ? undefined : process.env[k])
  const configFile = env("RM_ROOTCOPY_CONFIG") ?? ROOTCOPY_CONFIG_DEFAULT
  const files: AccountFiles = {
    passwd: env("RM_ROOTCOPY_PASSWD") ?? SYSTEM_ACCOUNT_FILES.passwd,
    group: env("RM_ROOTCOPY_GROUP") ?? SYSTEM_ACCOUNT_FILES.group,
    shadow: env("RM_ROOTCOPY_SHADOW") ?? SYSTEM_ACCOUNT_FILES.shadow,
  }
  const stateDir = env("RM_ROOTCOPY_STATE_DIR") ?? process.env.STATE_DIRECTORY?.split(":")[0] ?? "/var/lib/relay-manager-rootcopy"
  let text: string | null = null
  try {
    text = fs.readFileSync(configFile, "utf8")
  } catch {
    log(`Sin configuración (${configFile}): la copia como administrador queda desactivada. Reinstala con install.sh.`)
  }
  let config
  try {
    config = loadHelperConfig(text)
  } catch (e) {
    log(`Configuración no válida en ${configFile}: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }
  const server = createRootCopyServer({
    config, files, crypter: createCrypter(), version: VERSION, log,
    limiter: new AttemptLimiter({ file: path.join(stateDir, "intentos.json") }),
    // Elevation tokens: the key survives the idle exit (5-minute elevations outlive a 2-minute idle helper).
    tokens: new TokenStore({ keyFile: path.join(stateDir, "token.key"), revokedFile: path.join(stateDir, "revoked.json") }),
    mountSocket: env("RM_ROOTCOPY_MOUNT_SOCKET") ?? ROOTMOUNT_SOCKET_DEFAULT,
    listDeny: [stateDir],
  })

  const activated = process.env.LISTEN_PID === String(process.pid) && Number(process.env.LISTEN_FDS ?? "0") >= 1
  if (activated) {
    server.listen({ fd: 3 })
  } else {
    const sockPath = env("RM_ROOTCOPY_SOCKET")
    if (!sockPath) {
      log("relay-manager-rootcopy solo arranca por activación de socket (relay-manager-rootcopy.socket).")
      process.exit(2)
    }
    fs.rmSync(sockPath, { force: true })
    server.listen(sockPath, () => fs.chmodSync(sockPath, 0o600))
  }

  // Idle exit (socket activation only): systemd keeps listening and starts the helper again on the next connection.
  let connections = 0
  let timer: NodeJS.Timeout | null = null
  const arm = () => {
    if (!activated) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (connections === 0) server.close(() => process.exit(0))
    }, IDLE_MS)
  }
  server.on("connection", (s) => {
    connections++
    if (timer) clearTimeout(timer)
    s.on("close", () => {
      connections--
      if (connections === 0) arm()
    })
  })
  arm()
  const stop = () => server.close(() => process.exit(0))
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  log(`relay-manager-rootcopy ${VERSION}: ${config.enabled ? `listo (usuario ${config.sudoUser}; escribe en ${config.writePaths.join(", ")})` : "desactivado"}`)
}

// `rootcopy.js mount`: the mount helper (relay-manager-rootmount.service), bundled in the same file.
if (process.argv[2] === "mount") runMountHelper()
else main()
