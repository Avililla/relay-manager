// «Copiar como administrador (sudo)»: is it available here, and if not, why and what to do. Shared by the copy service
// (the dialog) and the health checks (Sistema › Salud, doctor).
import type { CopyRootDTO } from "@/lib/contracts/files"
import type { AppConfig } from "@/server/config/schema"
import type { PingResult } from "./protocol"

export const ROOT_HELPER_HINT = "sudo systemctl enable --now relay-manager-rootcopy.socket (o vuelve a ejecutar sudo ./install.sh)"

const REINSTALL_HINT = "sudo /opt/relay-manager/current/install.sh --sudo-user <usuario con sudo> --yes"

/** What to do when the helper's account cannot authenticate; for an account without sudo, the exact commands. */
export function accountHint(account: PingResult["account"], user: string | null): string {
  if (account === "not-sudo" && user && /^[a-z_][a-z0-9_-]*\$?$/i.test(user)) {
    return `Da permisos de administrador a ${user}: su -c "usermod -aG sudo ${user}" (con la contraseña de root) y vuelve a iniciar sesión con ${user}; ` +
      `o, si root tiene contraseña, sudo /opt/relay-manager/current/install.sh --sudo-user root --yes (o --sudo-user <otro usuario con sudo>)`
  }
  return REINSTALL_HINT
}

/** `ping`: the helper's answer, the error of trying, or null when there is no helper socket configured. */
export function describeRootStatus(config: Pick<AppConfig, "mode" | "copy">, ping: PingResult | Error | null): CopyRootDTO {
  const cfg = config.copy
  const base = { user: cfg.sudoUser, writePaths: cfg.rootPaths }
  const no = (problem: string, hint: string | null): CopyRootDTO => ({ ...base, available: false, problem, hint })
  if (!cfg.enabled) return no("Desactivado (RM_COPY_ENABLED=0).", null)
  if (config.mode === "docker") {
    return no("No disponible en Docker: el contenedor no tiene el root del equipo anfitrión.", "Monta la carpeta de destino en el contenedor con permiso de escritura para el servicio (compose.yaml).")
  }
  if (ping === null) {
    return no("Solo con la instalación como servicio: en modo portátil o de desarrollo no hay ayudante de root.", "sudo ./install.sh (instala relay-manager-rootcopy.socket)")
  }
  if (ping instanceof Error) return no(ping.message, ROOT_HELPER_HINT)
  const withUser = { user: ping.user, writePaths: ping.writePaths }
  if (!ping.enabled) return { ...withUser, available: false, problem: "Desactivado en la configuración del ayudante (RM_COPY_ENABLED=0 en /etc/relay-manager/rootcopy.env).", hint: null }
  if (ping.account !== "ok") {
    return { ...withUser, available: false, problem: ping.accountMessage ?? "La cuenta de administrador no sirve para autenticar.", hint: accountHint(ping.account, ping.user) }
  }
  if (!ping.method) return { ...withUser, available: false, problem: ping.methodError ?? "No se pueden comprobar contraseñas.", hint: "sudo apt install python3" }
  return { ...withUser, available: true, problem: null, hint: null }
}

/** «Montar» / «Expulsar»: available when «como administrador» is, and the mount helper answers. */
export function describeMountStatus(root: CopyRootDTO, ping: PingResult | Error | null): { available: boolean; problem: string | null } {
  if (!root.available) return { available: false, problem: root.problem ?? "La copia como administrador no está disponible." }
  if (!ping || ping instanceof Error) return { available: false, problem: "El ayudante de copia como administrador no responde." }
  // A helper of a previous version answers without `mount`.
  if (!ping.mount) return { available: false, problem: "Actualiza Relay Manager: el ayudante instalado no sabe montar pendrives." }
  return ping.mount
}
