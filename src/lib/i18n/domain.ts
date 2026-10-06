/** Spanish strings of the domain layer (W1-C): reservations, equipment, templates, users, roles, config, audit export. */

export const domainText = {
  // Equipment
  equipmentNameTaken: "Ya existe un equipo con ese nombre",
  equipmentNotFound: "El equipo ya no existe: recarga la página",
  roleMissing: "Uno de los roles ya no existe: recarga la página",
  templateMissing: "La plantilla ya no existe: recarga la página",
  templateUpdateNeedsTemplate: "Para guardar los cambios en una plantilla, elige primero una plantilla",
  confirmNameMismatch: "Escribe el nombre exacto del equipo para confirmar",
  consoleNotInEquipment: "Esta consola no pertenece al equipo: recarga la página",
  relayNotInEquipment: "Este relé no pertenece al equipo: recarga la página",
  keepNeedsBinding: "Esta consola no tenía un puerto asignado",
  boardMissing: "La placa de relés ya no existe: recarga la página",
  deviceNotFound: "El puerto ya no está conectado: vuelve a buscar adaptadores",
  // Templates
  templateNameTaken: "Ya existe una plantilla con ese nombre",
  templateFromFile: (file: string) => `Esta plantilla está definida en ${file} (perfil): duplícala para cambiarla`,
  templateFromFileNotDeletable: (file: string) => `Esta plantilla está definida en ${file} (perfil): quita el fichero y recarga las plantillas para retirarla`,
  // Users and roles
  usernameTaken: "Ese nombre de usuario ya existe",
  userNotFound: "El usuario ya no existe: recarga la página",
  cannotDisableSelf: "No puedes desactivar tu propio usuario",
  cannotDeleteSelf: "No puedes borrar tu propio usuario",
  roleNameTaken: "Ya existe un rol con ese nombre",
  roleNotFound: "El rol ya no existe: recarga la página",
  userMissing: "Uno de los usuarios ya no existe: recarga la página",
  equipmentMissing: "Uno de los equipos ya no existe: recarga la página",
  // Config import
  importInvalidJson: "El archivo no contiene JSON válido",
  importInvalidFormat: "El archivo no es una exportación de configuración válida (formato relay-manager-config, versión 1)",
  importSkipRole: "Ya existe un rol con ese nombre",
  importSkipTemplate: "Ya existe una plantilla con ese nombre",
  importSkipTemplateKey: "Ya existe una plantilla con esa clave",
  importSkipBoard: "Ya existe una placa con ese nombre",
  importSkipBoardAddress: "Ya existe una placa con esa dirección o MAC",
  importSkipEquipment: "Ya existe un equipo con ese nombre",
  // Backups
  backupNotFound: "La copia no existe",
} as const

export const domainFormat = {
  channelOutOfRange: (board: string, count: number): string => `La placa ${board} solo tiene ${count} ${count === 1 ? "relé" : "relés"}`,
  channelTaken: (channel: number, board: string): string => `El canal ${channel} de la placa ${board} ya está asignado`,
  channelTakenBy: (channel: number, board: string, equipment: string): string =>
    `El canal ${channel} de la placa ${board} ya está asignado a ${equipment}`,
  deviceAlreadyBound: (equipment: string, key: string): string => `Ese puerto ya está asignado a ${equipment} · ${key}`,
  deviceBoundToSibling: (key: string): string => `Ese puerto ya lo usa la consola ${key} de este equipo`,
  forceReleaseToast: (admin: string, equipment: string, reason: string): string =>
    `${admin} ha liberado tu reserva de ${equipment}: ${reason}`,
  importRoleMissing: (equipment: string, role: string): string => `${equipment}: el rol «${role}» no existe; se ha omitido`,
  importBoardMissing: (equipment: string, board: string, channel: number): string =>
    `${equipment}: la placa «${board}» no existe; se omite el relé del canal ${channel}`,
  importChannelTaken: (equipment: string, board: string, channel: number): string =>
    `${equipment}: el canal ${channel} de «${board}» ya está asignado; se omite`,
  importChannelOutOfRange: (equipment: string, board: string, channel: number): string =>
    `${equipment}: la placa «${board}» no tiene canal ${channel}; se omite`,
  importBindingTaken: (equipment: string, key: string): string =>
    `${equipment} · ${key}: ese puerto ya está asignado a otra consola; se importa sin asignar`,
  importTemplateMissing: (equipment: string, template: string): string =>
    `${equipment}: la plantilla «${template}» no existe; se guarda solo el nombre`,
  importBoardPassword: (board: string): string => `La placa «${board}» tenía contraseña: introdúcela en Placas de relés`,
  importLabName: (before: string, after: string): string => `Nombre del laboratorio: de «${before}» a «${after}»`,
  importBanner: (after: string | null): string => (after ? `Franja superior: «${after}»` : "Franja superior: sin texto"),
  auditExportFileName: (date: string): string => `auditoria-${date}.csv`,
  configExportFileName: (date: string): string => `relay-manager-config-${date}.json`,
} as const

/** Column header of the audit CSV export (§7.3). */
export const AUDIT_CSV_COLUMNS = ["fecha_utc", "usuario", "accion", "resultado", "equipo", "objetivo", "ip", "detalle"] as const
