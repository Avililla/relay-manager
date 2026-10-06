// Mount helper entry (`node app/rootcopy.js mount`, run by relay-manager-rootmount.service through socket activation).
// As root: configuration from /etc/relay-manager/rootcopy.env (RM_SUDO_USER, RM_COPY_ENABLED), accounts from
// /etc/passwd and /etc/group, state in $STATE_DIRECTORY; exits after 2 minutes without connections. The RM_ROOTMOUNT_*
// variables point elsewhere only when NOT running as root (tests, development) — except RM_ROOTMOUNT_TEST_LOOP: the
// bundle tests set it in the unit's environment (only root can) so one /dev/loopN stands in for a USB stick.
import fs from "node:fs"
import path from "node:path"
import util from "node:util"
import { ROOTCOPY_CONFIG_DEFAULT, ROOTMOUNT_SOCKET_DEFAULT } from "@/server/files/copy/protocol"
import { TEST_LOOP_RE } from "./devices"
import { createRootMountServer, systemMountExec } from "./server"

const VERSION = process.env.RM_BUILD_VERSION ?? "dev"
const IDLE_MS = 120_000
/** The group the service and the desktop user share (install.sh). */
export const FILES_GROUP = "relay-files"

function log(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

export function runMountHelper(): void {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0
  const env = (k: string) => (isRoot ? undefined : process.env[k])
  const configFile = env("RM_ROOTMOUNT_CONFIG") ?? ROOTCOPY_CONFIG_DEFAULT
  let text: string | null = null
  try {
    text = fs.readFileSync(configFile, "utf8")
  } catch {
    log(`Sin configuración (${configFile}): montar pendrives queda desactivado. Reinstala con install.sh.`)
  }
  const v = text ? (util.parseEnv(text) as Record<string, string | undefined>) : {}
  const enabledRaw = (v.RM_COPY_ENABLED ?? "").trim()
  const enabled = text !== null && enabledRaw !== "0" && enabledRaw !== "false"
  const sudoUser = (v.RM_SUDO_USER ?? "").trim() || "root"
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(sudoUser)) {
    log(`RM_SUDO_USER no válido en ${configFile}`)
    process.exit(2)
  }
  const testRaw = (process.env.RM_ROOTMOUNT_TEST_LOOP ?? "").trim()
  const testLoop = testRaw && TEST_LOOP_RE.test(testRaw) ? testRaw : null
  if (testLoop) log(`MODO PRUEBA: ${testLoop} se trata como un pendrive (RM_ROOTMOUNT_TEST_LOOP). No lo uses en producción.`)
  const stateDir = env("RM_ROOTMOUNT_STATE_DIR") ?? process.env.STATE_DIRECTORY?.split(":")[0] ?? null
  const server = createRootMountServer({
    config: { enabled, sudoUser, filesGroup: FILES_GROUP }, exec: systemMountExec(), version: VERSION, log, testLoop,
    stateDir, sysRoot: env("RM_ROOTMOUNT_SYS_ROOT") ?? "/sys", mediaRoot: env("RM_ROOTMOUNT_MEDIA_ROOT") ?? "/media",
    passwdFile: env("RM_ROOTMOUNT_PASSWD") ?? "/etc/passwd", groupFile: env("RM_ROOTMOUNT_GROUP") ?? "/etc/group",
    rootUid: isRoot ? 0 : process.getuid?.() ?? 0,
  })
  const activated = process.env.LISTEN_PID === String(process.pid) && Number(process.env.LISTEN_FDS ?? "0") >= 1
  if (activated) {
    server.listen({ fd: 3 })
  } else {
    const sockPath = env("RM_ROOTMOUNT_SOCKET")
    if (!sockPath) {
      log("relay-manager-rootmount solo arranca por activación de socket (relay-manager-rootmount.socket).")
      process.exit(2)
    }
    fs.rmSync(sockPath, { force: true })
    fs.mkdirSync(path.dirname(sockPath), { recursive: true })
    server.listen(sockPath, () => fs.chmodSync(sockPath, 0o600))
  }
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
  log(`relay-manager-rootmount ${VERSION}: ${enabled ? `listo (pendrives en /media/${sudoUser}, grupo ${FILES_GROUP})` : "desactivado"}`)
}

export { ROOTMOUNT_SOCKET_DEFAULT }
