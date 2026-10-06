/**
 * Spanish copy for "Red de equipos" (the equipment switch, its VLANs and the server's VLAN interfaces). Sentence case,
 * full accents, no em dashes.
 */
import type { HostNetState, LinkState, SwitchDriverId, SwitchJobKind, SwitchState } from "@/lib/contracts/equipnet"
import { portList, type SwitchOp } from "@/lib/equipnet/switch-layout"
import { plural } from "./format"

export const SWITCH_DRIVER_LABEL: Record<SwitchDriverId, string> = {
  "tplink-easy-smart": "TP-Link Easy Smart (TL-SG105E, TL-SG108E, TL-SG116E…)",
  manual: "Manual (configuro yo el switch)",
}
export const HOST_STATE_LABEL: Record<HostNetState, string> = {
  off: "Desactivada",
  ok: "Lista",
  pending: "Aplicando cambios",
  "no-permission": "Sin permiso para cambiar la red",
  "no-adapter": "Adaptador no conectado",
  "no-ip-tool": "Falta la orden ip",
  blocked: "Adaptador no válido",
  error: "Error",
}
export const SWITCH_STATE_LABEL: Record<SwitchState, string> = {
  unconfigured: "Sin configurar",
  manual: "Configuración manual",
  checking: "Comprobando",
  ok: "Conectado",
  unreachable: "Sin respuesta",
  "auth-failed": "Usuario o contraseña incorrectos",
  error: "Error",
}
export const LINK_LABEL: Record<LinkState, string> = { up: "Enlace activo", down: "Sin enlace", unknown: "Enlace desconocido" }
export const JOB_KIND_LABEL: Record<SwitchJobKind, string> = {
  apply: "Preparar el switch para los equipos",
  restore: "Restaurar la configuración anterior",
  remove: "Quitar las VLAN del switch",
}

/** NetworkManager device states (nmcli), in Spanish. */
const NM_STATE: Record<string, string> = {
  connected: "Conectada", connecting: "Conectando", disconnected: "Desconectada", unavailable: "Sin cable", unmanaged: "No gestionada",
  deactivating: "Desconectando", disconnecting: "Desconectando", failed: "Fallo",
}

/** Why an interface cannot be (or needs a confirmation to be) the equipment network interface. */
export const adapterProblem = {
  defaultRoute: "Tiene la ruta por defecto (la red del laboratorio): la aplicación no la toca nunca.",
  wireless: "Es una tarjeta inalámbrica: las VLAN no pasan por wifi.",
  notUsb: "No es un adaptador USB: comprueba que es la tarjeta conectada al puerto 1 del switch.",
  otherAddress: (addrs: string) => `Ya está conectada a otra red (${addrs}). Esas direcciones no se tocan, pero la aplicación le añadirá las VLAN de los equipos y, si hace falta, su dirección de gestión.`,
} as const

/** Host network status details (server → UI). */
export const hostDetail = {
  off: "Elige la interfaz del switch (paso 1). Hasta entonces la aplicación no cambia nada en la red del servidor.",
  chosenOnly: (label: string) => `Interfaz ${label} elegida: la red de equipos aún no está activa (paso 3).`,
  leftovers: "Hay restos de una versión anterior en la red del servidor: revísalos en «Restos de una versión anterior».",
  hostModeOff: "RM_NET_HOST=off: la aplicación no cambia la red del servidor. Ejecuta tú las órdenes pendientes como root.",
  noAdapter: (label: string) => `La interfaz ${label} no está conectada. Conéctala al servidor: la red se prepara sola.`,
  noCarrier: (label: string) => `La interfaz ${label} no tiene enlace: comprueba el cable al puerto del switch.`,
  noIpTool: "No se encuentra la orden ip (iproute2) en el servidor. Instala el paquete iproute2.",
  noPermission: "El servicio no tiene permiso para cambiar la red (falta CAP_NET_ADMIN). Instalación nativa: la unidad relay-manager.service lo incluye (AmbientCapabilities=CAP_NET_ADMIN); reinstala la versión actual. Docker: usa el compose.yaml incluido (cap_add: [NET_ADMIN, SETUID, SETGID, KILL] y network_mode: host). Mientras tanto, ejecuta como root las órdenes pendientes.",
  blocked: (why: string) => `No se usa esta interfaz: ${why}`,
  failed: (why: string) => `No se pudo preparar la red del servidor: ${why}`,
  pending: (n: number) => plural(n, { one: "Falta # cambio en la red del servidor", other: "Faltan # cambios en la red del servidor" }),
  ok: (n: number, label: string) => `${plural(n, { one: "# VLAN lista", other: "# VLAN listas" })} en ${label}.`,
  shadowed: (n: number) => plural(n, { one: "# VLAN no pasa la comprobación de rutas (ver los puertos)", other: "# VLAN no pasan la comprobación de rutas (ver los puertos)" }),
  nmHint: (mac: string) => `NetworkManager podría quitar las direcciones del adaptador. Ejecuta una vez en el servidor: sudo relay-manager red-equipos ${mac}`,
} as const

/** Warnings: it works, but the admin should know. */
export const netWarning = {
  equipmentOverlap: (subnet: string, ifname: string, addr: string) => `La red de los equipos (${subnet}) también está en ${ifname} (${addr}). Funciona igual: la aplicación llega a cada equipo solo por su VLAN, con reglas propias por dirección de origen, y el resto del tráfico del servidor a esa red sigue saliendo por ${ifname}.`,
  mgmtOverlap: (subnet: string, ifname: string, addr: string) => `La red de gestión del switch (${subnet}) también está en ${ifname} (${addr}). Funciona igual: la aplicación habla con el switch solo desde su dirección de gestión, con su propia regla.`,
  arp: (ifnames: string) => `Con los valores de Linux por defecto (arp_ignore=0), este servidor puede contestar por ${ifnames} a las direcciones de las VLAN (ARP) si otro aparato de esa red las pregunta. Para evitarlo, reinstala con «sudo ./install.sh --red-equipos-arp-estricto» (arp_ignore=1 y arp_announce=2).`,
} as const

export const switchDetail = {
  unconfigured: "Indica la IP del switch o búscalo en el adaptador.",
  manual: "El switch se configura a mano: sigue las instrucciones por puerto.",
  noPassword: "Falta la contraseña del switch.",
  badPassword: "La contraseña guardada no se puede leer (¿ha cambiado el secreto de la aplicación?). Escríbela otra vez.",
  noAdapter: "Elige el adaptador conectado al switch.",
  noRoute: "El servidor aún no tiene dirección de gestión en el adaptador.",
  drift: (n: number) => plural(n, { one: "El switch tiene # diferencia con la configuración de la aplicación", other: "El switch tiene # diferencias con la configuración de la aplicación" }),
  lag: (ports: string) => `Los puertos ${ports} están en un grupo de enlaces (LAG): quítalo en el switch antes de continuar.`,
} as const

/** Drift entries (layoutDrift). */
export const driftText = {
  disabled: "La VLAN 802.1Q está desactivada en el switch",
  vlanMissing: (vid: number) => `Falta la VLAN ${vid}`,
  vlanMembers: (vid: number) => `La VLAN ${vid} tiene otros puertos`,
  vlanExtra: (vid: number) => `Hay una VLAN ${vid} que la aplicación no creó`,
  pvid: (port: number, expected: number, actual: number) => `Puerto ${port}: PVID ${actual} (se esperaba ${expected})`,
} as const

/** "Se va a cambiar…": one sentence per switch operation. */
export function describeSwitchOp(op: SwitchOp, o: { existed?: boolean } = {}): string {
  switch (op.op) {
    case "enable":
      return op.on ? "Activar la VLAN 802.1Q (el switch desactiva la VLAN por puertos y la VLAN MTU)" : "Desactivar la VLAN 802.1Q: el switch vuelve a ser plano (todos los puertos se ven)"
    case "vlan": {
      const u = op.vlan.untagged.length ? `sin etiqueta ${portList(op.vlan.untagged)}` : null
      const t = op.vlan.tagged.length ? `con etiqueta ${portList(op.vlan.tagged)}` : null
      const members = [u, t].filter(Boolean).join("; ")
      if (op.vlan.vid === 1) return `VLAN 1 (gestión del switch): puertos ${members}`
      return `${op.existed || o.existed ? "Cambiar" : "Crear"} la VLAN ${op.vlan.vid}${op.vlan.name ? ` «${op.vlan.name}»` : ""}: puertos ${members}`
    }
    case "pvid":
      return `${op.ports.length === 1 ? `Puerto ${op.ports[0]}` : `Puertos ${portList(op.ports)}`}: PVID ${op.pvid}`
    case "delete":
      return `Borrar ${op.vids.length === 1 ? `la VLAN ${op.vids[0]}` : `las VLAN ${op.vids.join(", ")}`}`
    case "save":
      return "Guardar la configuración en la memoria del switch (se mantiene al apagarlo)"
  }
}

export const switchJob = {
  backup: "Copia de la configuración del switch",
  step: (i: number, n: number, what: string) => `Paso ${i} de ${n}: ${what}`,
  done: {
    apply: "Switch preparado: cada puerto lleva a su equipo.",
    restore: "Configuración anterior restaurada.",
    remove: "VLAN quitadas: el switch vuelve a ser plano.",
  } as Record<SwitchJobKind, string>,
  failed: (what: string, why: string) => `Falló «${what}»: ${why}`,
  rolledBack: "Se ha vuelto a la configuración que tenía el switch.",
  rollbackFailed: (why: string) => `No se pudo volver a la configuración anterior (${why}). Usa «Restaurar configuración anterior» o la copia descargada.`,
  vlan1Warning: "Este firmware no deja quitar puertos de la VLAN 1: los equipos siguen aislados entre sí (cada puerto entra en su propia VLAN), pero reciben las difusiones de la red de gestión del switch.",
  changed: "La configuración del switch ha cambiado desde la vista previa: revísala otra vez.",
  expired: "La vista previa ha caducado: ábrela otra vez.",
  busy: "Ya hay un cambio del switch en curso.",
  noPrevious: "No hay una configuración anterior guardada.",
  portBasedNotRestored: "La VLAN por puertos que tenía el switch no se restaura automáticamente: si la usabas, recupérala con la copia descargada (Configuración › Copia de seguridad del switch).",
  uplinkMismatch: (detected: number, expected: number) => `Este servidor está conectado al puerto ${detected} del switch, no al ${expected}. Cambia el puerto de subida o el cable antes de continuar.`,
  uplinkUnknown: (expected: number) => `No se ha podido comprobar a qué puerto del switch está conectado este servidor. Continúa solo si el cable del servidor está en el puerto ${expected}.`,
  uplinkOk: (port: number) => `Este servidor está conectado al puerto ${port} del switch (comprobado con los contadores de paquetes).`,
  lockout: "Esta configuración dejaría el switch inaccesible desde el servidor.",
  nothing: "El switch ya está así: no hay nada que cambiar.",
} as const

export const equipnetErrors = {
  portOutOfRange: (n: number) => `Elige un puerto del switch entre 1 y ${n}.`,
  portIsUplink: (p: number) => `El puerto ${p} es el del servidor (subida): elige otro.`,
  portTaken: (equipment: string) => `Ese puerto del switch ya es de ${equipment}.`,
  notAutomatic: "Con el controlador «manual» la aplicación no cambia el switch.",
  noSwitch: "Configura primero el switch (IP, usuario y contraseña).",
  adapterMissing: "Ese adaptador ya no está conectado.",
  adapterNotAllowed: (why: string) => `No se puede usar ese adaptador: ${why}`,
  noDetection: "Busca primero el switch (paso 2).",
  chooseFirst: "Elige primero la interfaz del switch (paso 1).",
  needsConfirm: (why: string) => `Esta interfaz necesita una confirmación: ${why}`,
  switchIpOnHost: (ip: string, ifname: string, prefixlen: number) => `La IP del switch (${ip}) la tiene este servidor en ${ifname}: así el switch no se puede alcanzar. Quítasela («sudo ip addr del ${ip}/${prefixlen} dev ${ifname}»; si vuelve a aparecer, revisa la conexión de NetworkManager de ${ifname}) o corrige la IP del switch.`,
  mgmtOnOther: (addr: string, ifname: string, leftover: boolean) => `La dirección de gestión ${addr} ya la tiene ${ifname}${leftover ? " (la dejó una versión anterior: pulsa «Quitar restos»)" : ""}: usa otra en Ajustes › Direcciones.`,
  mgmtIsSwitch: (addr: string) => `La dirección de gestión del servidor (${addr}) es la IP del switch: usa otra en Ajustes › Direcciones.`,
  equipmentIpMissing: "Falta la IP de los equipos (Sistema › Red de equipos › Ajustes).",
  equipmentIpOnHost: (ip: string, ifname: string) => `El servidor tiene la IP de los equipos (${ip}) en ${ifname}: el tráfico a los equipos se quedaría en el propio servidor. Quítala de ${ifname} o cambia la IP de los equipos.`,
  noMgmtSource: (ifname: string) => `${ifname} aún no tiene dirección en la red de gestión del switch (mira las órdenes pendientes). Mientras tanto, escribe la IP del switch y pulsa «Probar esta IP».`,
  enableNeedsAdapter: "Elige primero la interfaz del switch (paso 1) para activar la red de equipos.",
  vlanShadowed: (vid: number, dev: string | null) => `La VLAN ${vid} no pasa la comprobación: el tráfico a los equipos desde su dirección saldría por ${dev ?? "ninguna interfaz"}, no por rmv${vid}. Otra regla de enrutamiento del servidor se adelanta a la de la aplicación (revísalo con «ip rule»).`,
  mgmtShadowed: (dev: string | null, ifname: string) => `El tráfico al switch saldría por ${dev ?? "ninguna interfaz"}, no por ${ifname}. Otra regla de enrutamiento del servidor se adelanta a la de la aplicación (revísalo con «ip rule»).`,
  vlanNotReady: (port: number) => `La VLAN del puerto ${port} no está lista en el servidor.`,
} as const

export const equipnetLog = {
  hostApplied: "Red de equipos: red del servidor actualizada",
  hostFailed: "Red de equipos: no se pudo actualizar la red del servidor",
  switchFound: "Red de equipos: switch encontrado",
  linkChanged: "Red de equipos: cambio de enlace en un puerto del switch",
} as const

/** Interface copy: Banco card, «Preparar switch», Sistema › Red de equipos, access editors, Cables, Descubrimiento. */
export const equipnetUi = {
  title: "Red de equipos",
  tab: "Red de equipos",
  intro: "Todos los equipos tienen la misma IP en su Ethernet. Cada uno va a un puerto del switch, y el switch separa los puertos: así llegas a cada equipo por su propio acceso Ethernet.",
  // Passive card (Banco, Descubrimiento): no side effects, only a link
  offerTitle: "Hay adaptadores de red sin configurar",
  offerBody: "La red de equipos aún no tiene interfaz. Elige en Sistema › Red de equipos la que va al switch: hasta entonces no se toca ninguna.",
  offerLeftovers: "Además hay restos de una versión anterior en la red del servidor.",
  offerAction: "Configurar red de equipos",
  // Prepare dialog
  prepareTitle: "Preparar el switch para los equipos",
  planIntro: "Se va a dejar así:",
  planUplink: (p: number) => `Puerto ${p}: este servidor (el cable del adaptador USB).`,
  planPorts: (from: number, to: number) => `Puertos ${from} a ${to}: un equipo cada uno, aislados entre sí.`,
  planPortsList: (ports: string) => `Puertos ${ports}: un equipo cada uno, aislados entre sí.`,
  planIpMissing: "Falta la IP de los equipos: indícala en Ajustes › Direcciones antes de preparar el switch.",
  planIp: (ip: string) => `Todos los equipos con la IP ${ip}; se entra a cada uno por SSH (puerto 22) desde su acceso Ethernet.`,
  planSave: "El switch guarda la configuración y la aplicación hace una copia antes de cambiar nada.",
  password: "Contraseña del switch",
  passwordHelpDefault: "De fábrica es «admin». Si la cambiaste, escríbela aquí.",
  passwordHelpStored: "Déjala vacía para usar la guardada.",
  username: "Usuario del switch",
  details: "Detalles",
  detailsLoading: "Leyendo el switch…",
  detailsChanges: "Se va a cambiar:",
  detailsPorts: "Puerto por puerto",
  detailsBefore: "Ahora",
  detailsAfter: "Después",
  pvid: "PVID",
  vlans: "VLAN",
  confirmUplink: (p: number) => `El cable de este servidor está en el puerto ${p} del switch`,
  prepare: "Preparar switch",
  preparing: "Preparando…",
  done: "Listo",
  close: "Cerrar",
  retry: "Reintentar",
  warnings: "Avisos",
  nothingToDo: "El switch ya está preparado.",
  // Sistema page: steps
  step1Title: "1. Elige la interfaz del switch",
  step1Help: "Todas las interfaces de red del servidor. La aplicación no cambia ninguna hasta que eliges la que va al puerto 1 del switch, y después solo cambia esa.",
  step2Title: "2. Busca el switch",
  step2Help: (ifname: string, subnet: string | null) => subnet ? `Solo por ${ifname}, en ${subnet} (su red de gestión). También puedes escribir su IP.` : `Solo por ${ifname}. También puedes escribir su IP.`,
  step3Title: "3. Prepara el switch",
  step3Help: "Crea una VLAN por puerto en el switch (con vista previa y copia de seguridad) y las interfaces VLAN del servidor en la interfaz elegida.",
  step4Title: "4. Estado",
  chooseFirst: "Primero elige la interfaz del switch (paso 1).",
  stepDone: "Hecho",
  stepPending: "Pendiente",
  colIface: "Interfaz",
  colMac: "MAC",
  colType: "Tipo",
  colLink: "Enlace",
  colAddresses: "IPv4",
  colDefault: "Ruta por defecto",
  colNm: "NetworkManager",
  colAction: "Acción",
  typeUsb: "USB",
  typePci: "PCI (tarjeta del equipo)",
  typeOther: "Otra",
  typeWireless: "Inalámbrica",
  yes: "Sí",
  no: "No",
  nmUnknown: "-",
  nmState: (state: string, conn: string | null) => `${NM_STATE[state.split(" ")[0] ?? ""] ?? state}${conn ? ` (${conn})` : ""}`,
  useThis: "Usar esta",
  inUse: "En uso",
  stopUsing: "Dejar de usar",
  notSelectable: "No se puede elegir",
  noInterfaces: "No se ha encontrado ninguna tarjeta de red física.",
  otherIfaces: (n: number) => plural(n, { one: "# interfaz virtual más (solo lectura)", other: "# interfaces virtuales más (solo lectura)" }),
  chooseTitle: (ifname: string) => `¿Usar ${ifname} para la red de equipos?`,
  chooseWill: "Qué va a pasar:",
  chooseWillOwn: (addr: string, ifname: string) => `Se añade ${addr} a ${ifname} (sin ruta de red y con su propia regla) para hablar con el switch.`,
  chooseWillReuse: (addr: string) => `Se usa la dirección ${addr} que ya tiene para hablar con el switch: no se le añade nada.`,
  chooseWillVlans: "Al preparar el switch (paso 3) se crean sobre ella las interfaces VLAN rmv102, rmv103… con sus reglas propias.",
  chooseWillNothingElse: "No se toca ninguna otra interfaz, ni la ruta por defecto, ni la tabla de rutas principal.",
  chooseRiskTitle: "Atención",
  chooseConfirmRisk: "Entiendo el aviso: esta es la interfaz conectada al puerto 1 del switch",
  chooseAction: "Usar esta interfaz",
  stopTitle: (ifname: string) => `¿Dejar de usar ${ifname}?`,
  stopBody: "Se quitan de ella la dirección de gestión y las VLAN de la aplicación (rmv*) con sus reglas y tablas. Sus demás direcciones no se tocan. Los accesos Ethernet por el switch dejan de funcionar.",
  stopAction: "Dejar de usar",
  mgmtOwn: (addr: string, ifname: string) => `Dirección de gestión: ${addr} en ${ifname} (de la aplicación)`,
  mgmtReuse: (addr: string, ifname: string) => `Dirección de gestión: ${addr}, la que ya tenía ${ifname}`,
  mgmtPending: "aún no está puesta (mira las órdenes pendientes)",
  mgmtNone: "Con el switch manual no hace falta dirección de gestión.",
  typeIp: "O escribe la IP del switch",
  testIp: "Probar esta IP",
  foundLine: (model: string | null, host: string) => `Switch ${model ?? "TP-Link"} en ${host}`,
  loginOk: "el usuario y la contraseña funcionan",
  loginBad: "el usuario o la contraseña no funcionan: escríbela al prepararlo",
  switchKnown: (host: string) => `Switch en ${host}`,
  prepareOpen: "Preparar el switch…",
  preparedAt: (when: string) => `Preparado el ${when}.`,
  warningsTitle: "Avisos",
  leftoversTitle: "Restos de una versión anterior",
  leftoversHelp: "La aplicación no los quita sola porque están en interfaces que no has elegido. Quítalos con el botón, o como root con estas órdenes.",
  leftoversAction: "Quitar restos",
  leftoversDone: "Restos quitados",
  settingsWarnings: "Guardado, con avisos",
  // Sistema page
  statusTitle: "Estado",
  serverSide: "Servidor",
  switchSide: "Switch",
  portsTitle: "Puertos del switch",
  portsEmpty: "Configura el switch para ver sus puertos.",
  port: "Puerto",
  role: "Uso",
  roleUplink: "Este servidor",
  roleEquipment: "Equipo",
  vlan: "VLAN",
  link: "Enlace",
  usedBy: "Equipo asignado",
  free: "Libre",
  hostAddress: "Dirección del servidor",
  hostReady: "Servidor",
  ready: "Lista",
  notReady: "Pendiente",
  pendingTitle: "Órdenes pendientes en el servidor",
  pendingHelp: "Ejecútalas como root en el servidor (o da al servicio el permiso CAP_NET_ADMIN y pulsa «Comprobar ahora»).",
  checkNow: "Comprobar ahora",
  settingsTitle: "Ajustes",
  adapterTitle: "Adaptador de red",
  adapterHelp: "Las tarjetas de red del servidor. La de la red de equipos se elige en Sistema › Red de equipos; la del laboratorio (ruta por defecto) no se toca nunca.",
  adapterNone: "No hay adaptadores de red USB conectados.",
  adapterChoose: "Elige un adaptador",
  adapterCarrier: { true: "Con enlace", false: "Sin enlace", null: "Enlace desconocido" } as Record<string, string>,
  adapterReadOnly: "No seleccionable",
  switchTitle: "Switch",
  driver: "Tipo de switch",
  switchHost: "IP del switch",
  switchHostHelp: "La dirección de gestión del switch (de fábrica 192.168.0.1).",
  find: "Buscar el switch",
  finding: "Buscando…",
  found: (host: string) => `Switch encontrado en ${host}`,
  notFound: "No se ha encontrado ningún switch por esa interfaz.",
  test: "Probar conexión",
  switchUser: "Usuario",
  switchPassword: "Contraseña",
  switchPasswordStored: "Guardada (escribe otra para cambiarla)",
  switchPasswordClear: "Borrar la contraseña guardada",
  portCount: "Número de puertos",
  uplinkPort: "Puerto de este servidor (subida)",
  addressesTitle: "Direcciones",
  addressesHelp: "La IP de los equipos es la que tienen todos (por ejemplo 192.168.1.10); cambia lo demás solo si el switch no está en 192.168.0.0/24. Otra tarjeta del servidor en la misma red no es un problema: la aplicación llega a cada equipo solo por su VLAN.",
  equipmentIp: "IP de los equipos",
  equipmentPrefix: "Prefijo",
  mgmtAddress: "Dirección del servidor para la gestión del switch",
  vlanBase: "Base de VLAN (puerto n = VLAN base + n)",
  hostOffset: "Dirección del servidor en cada VLAN (red + desplazamiento + puerto)",
  enabled: "Red de equipos activa en el servidor",
  enabledHelp: "Crea en la interfaz elegida una interfaz VLAN por puerto (rmv102, rmv103…) con su dirección y su ruta propia; nada más de la red cambia.",
  save: "Guardar",
  saved: "Red de equipos guardada",
  actionsTitle: "Configuración del switch",
  actionsHelp: "Cada cambio se muestra antes de aplicarse, se hace paso a paso comprobando el switch y se puede deshacer.",
  applyAction: "Configurar el switch",
  restoreAction: "Restaurar configuración anterior",
  removeAction: "Quitar VLAN",
  downloadBackup: "Descargar la copia del switch",
  previousAt: (when: string) => `Configuración anterior guardada el ${when}`,
  appliedAt: (when: string) => `Configurado por la aplicación el ${when}`,
  drift: "El switch no coincide con lo que configuró la aplicación",
  confirmTitle: { apply: "¿Configurar el switch?", restore: "¿Restaurar la configuración anterior?", remove: "¿Quitar las VLAN del switch?" } as Record<SwitchJobKind, string>,
  confirmCheck: "He revisado los cambios",
  apply: "Aplicar",
  manualTitle: "Instrucciones para configurarlo a mano",
  manualHelp: "En la web del switch: VLAN › 802.1Q VLAN (actívala, crea cada VLAN) y VLAN › 802.1Q PVID. Luego guarda la configuración.",
  manualPort: "Puerto",
  manualPvid: "PVID",
  manualUntagged: "Sin etiqueta en VLAN",
  manualTagged: "Con etiqueta en VLAN",
  manualVlans: "VLAN que crear",
  job: (label: string) => label,
  nmTitle: "NetworkManager",
  // Access editors
  targetModeSwitch: "Puerto del switch",
  targetModeIp: "Sin switch: dirección IP",
  choosePort: "Elige el puerto del switch",
  portOption: (port: number) => `Puerto ${port} del switch`,
  portFree: "libre",
  portUsedBy: (name: string) => name,
  portJustLinked: "acabas de conectar algo",
  suggest: (port: number) => `Acabas de conectar algo al puerto ${port}.`,
  usePort: (port: number) => `Usar el puerto ${port}`,
  advanced: "Avanzado",
  equipmentIpDefault: (ip: string) => `${ip} (la de los equipos)`,
  sshUser: "Usuario SSH",
  notConfigured: "La red de equipos aún no está preparada: elige el puerto igualmente y se abrirá cuando lo esté.",
  configureLink: "Preparar la red de equipos",
  // Workspace
  viaSwitch: (port: number) => `Puerto ${port} del switch`,
  reachable: (target: string) => `${target} alcanzable`,
  unreachable: (target: string) => `${target} no responde`,
  // Cables / Descubrimiento
  tabAdapters: "Adaptadores de red",
  adaptersEmpty: "No hay adaptadores de red etiquetados.",
  adaptersConnected: "Adaptadores conectados",
  equipmentNetwork: "Red de equipos",
  mac: "MAC",
  iface: "Interfaz",
  speed: (mbps: number) => `${mbps} Mb/s`,
} as const
