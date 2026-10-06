// "Archivos": plain file exchange between the engineers' PCs and the shared folders of the bench host («raíces»):
// "tftp" (RM_FILES_DIR, ~/tftp) and "extra" (RM_FILES_EXTRA_DIR: the optional second folder named by the profile,
// RM_FILES_EXTRA_NAME). Paths on the wire are RELATIVE to the chosen root,
// "/"-separated, without a leading or trailing slash ("" = the root folder). A missing root means "tftp".
import { z } from "zod"
import type { IsoDate } from "./common"
import { SshUserSchema } from "./accesses"

/** Upper bound of one upload request (PUT chunk). The client adapts the chunk size to the link speed. */
export const FILES_CHUNK_MAX_BYTES = 64 * 1024 * 1024
/** At most this many entries are listed per folder (the listing says it was cut). */
export const FILES_LIST_LIMIT = 10_000
export { COPY_TEMP_PREFIX, UPLOAD_TEMP_PREFIX } from "@/lib/files/temp-names"

/** The shared folders of Archivos: every operation names one (query `root=`, body `root`, page `?raiz=`). */
export const FILES_ROOTS = ["tftp", "extra"] as const
export type FilesRootId = (typeof FILES_ROOTS)[number]
export const FilesRootSchema = z.enum(FILES_ROOTS)
export const DEFAULT_FILES_ROOT: FilesRootId = "tftp"
/** `?raiz=` / `root=` → a root id (anything else, or nothing, is the default "tftp"); null when it is not a known id. */
export function parseFilesRoot(raw: unknown): FilesRootId | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_FILES_ROOT
  return typeof raw === "string" && (FILES_ROOTS as readonly string[]).includes(raw) ? (raw as FilesRootId) : null
}
/** Reserved name at the top of the root the download script writes to (its work folder in early 2.4.0 builds; it now
 * works in the service's data dir): never listed nor touched by users. */
export const EXPORT_WORK_DIR = ".descargas"

/** Graph A endpoints (served by the custom server before Next; §ARQUITECTURA "Archivos"). */
export const FILES_API = {
  list: "/api/files/list",
  download: "/api/files/download",
  archive: "/api/files/archive",
  upload: "/api/files/upload",
  /** «Enviar a equipo»: GET the caller's sends, POST to start, DELETE to clear the finished ones; /<id> cancels one. */
  send: "/api/files/send",
  /** GET: the equipment the caller can send to (with an Ethernet access), with what the bench remembers of each. */
  sendTargets: "/api/files/send/targets",
  /** DELETE /api/files/send/profile/<equipmentId>: forget the remembered login of an equipment. */
  sendProfile: "/api/files/send/profile",
  /** «Copiar a una carpeta del servidor» (administrators): GET the caller's copies, POST to start, DELETE to clear the
   * finished ones; /<id> cancels one. */
  copy: "/api/files/copy",
  /** GET: the drives (USB sticks, disks), the browsable roots and whether «Copiar como administrador (sudo)» works. */
  copyInfo: "/api/files/copy/info",
  /** GET ?path=/abs&hidden=1: the folders of a server folder (as the service); POST {path, hidden, password}: as root. */
  copyBrowse: "/api/files/copy/browse",
  /** POST {dir, name, asRoot, password}: a new folder in a server folder. */
  copyMkdir: "/api/files/copy/mkdir",
  /** POST {device, password}: mount an unmounted removable device (root helper) under /media/<sudo user>/<label>. */
  copyMount: "/api/files/copy/mount",
  /** POST {mountPoint, password}: sync, unmount and remove the empty mount folder («Expulsar»). */
  copyUnmount: "/api/files/copy/unmount",
  /** DELETE: «Olvidar permisos» (drops this browser session's elevation and revokes its token in the helper). */
  copyElevation: "/api/files/copy/elevation",
  /** «Descargas» (the profile's download script): GET the jobs (own; all for admins), POST to start one,
   * DELETE /<id> to cancel (its owner or an administrator). */
  exports: "/api/files/export",
} as const

export type FileKind = "file" | "dir" | "other"
export interface FileEntryDTO {
  name: string
  /** "other": FIFO, socket, device, or a symbolic link that is broken or leads outside the folder. */
  kind: FileKind
  size: number | null
  mtime: IsoDate | null
  /** A symbolic link (to something inside the folder when kind is file/dir). */
  link: boolean
}
export interface DiskSpaceDTO { freeBytes: number; totalBytes: number }
export interface FilesListingDTO {
  root: FilesRootId
  path: string
  entries: FileEntryDTO[]
  /** More than FILES_LIST_LIMIT entries: only the first ones are listed. */
  truncated: boolean
  disk: DiskSpaceDTO | null
}
export interface FilesSettingsDTO {
  maxUploadBytes: number
  chunkMaxBytes: number
  /** RM_FILES_DELETE=admins: only administrators delete. */
  deleteAdminOnly: boolean
}
export type FilesPageErrorKind = "not-found" | "not-dir" | "unavailable" | "invalid"
export interface FilesRootDTO {
  id: FilesRootId
  /** «tftp», or the second folder's name (RM_FILES_EXTRA_NAME). */
  label: string
  /** One-line description shown in the root switcher. */
  hint: string
  enabled: boolean
  /** Absolute path on the server: administrators only. */
  path: string | null
}
export interface FilesPageDTO {
  /** The root shown (`?raiz=`). */
  root: FilesRootId
  /** The roots offered by the selector (enabled ones only). */
  roots: FilesRootDTO[]
  /** The root «Descargas» writes to; null when the download script is off (RM_EXPORT_ENABLED). */
  exportRoot: FilesRootId | null
  /** «Descargas»: shown in the root the download script writes to (any signed-in user; audited). */
  exports: ExportInfoDTO | null
  settings: FilesSettingsDTO
  canDelete: boolean
  /** «Copiar a una carpeta del servidor…»: administrators, with RM_COPY_ENABLED (the server enforces it again). */
  canCopy: boolean
  /** Absolute path of the shown root folder on the server: administrators only. */
  rootPath: string | null
  path: string
  listing: FilesListingDTO | null
  error: { kind: FilesPageErrorKind; message: string } | null
}

/** Error kinds of the files API (JSON `{ error, message }` bodies and DomainError details.files). */
export const FILES_ERRORS = [
  "UNAUTHENTICATED", "PASSWORD_CHANGE_REQUIRED", "FORBIDDEN", "DISABLED", "NOT_FOUND", "INVALID", "EXISTS", "OFFSET",
  "BUSY", "TOO_LARGE", "NO_SPACE", "UNAVAILABLE", "RANGE", "INTERNAL",
] as const
export type FilesErrorKind = (typeof FILES_ERRORS)[number]

export const ConflictModeSchema = z.enum(["fail", "overwrite", "rename"])
export type ConflictMode = z.infer<typeof ConflictModeSchema>

/** Loose shape checks: the server validates paths and names itself (src/server/files/paths.ts). */
export const RelPathSchema = z.string().max(4096)
export const EntryNameSchema = z.string().max(1024)

export const UploadStartSchema = z.strictObject({
  root: FilesRootSchema.default(DEFAULT_FILES_ROOT),
  dir: RelPathSchema,
  name: EntryNameSchema,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  conflict: ConflictModeSchema.default("fail"),
})
export type UploadStartInput = z.infer<typeof UploadStartSchema>
export interface UploadStartDTO { id: string; chunkMaxBytes: number }
export interface UploadChunkDTO { received: number; done: boolean; name: string | null; path: string | null }

const RootField = FilesRootSchema.default(DEFAULT_FILES_ROOT)
export const CreateFolderInputSchema = z.strictObject({ root: RootField, dir: RelPathSchema, name: EntryNameSchema })
export const RenameEntryInputSchema = z.strictObject({ root: RootField, path: RelPathSchema, newName: EntryNameSchema })
export const MoveEntriesInputSchema = z.strictObject({ root: RootField, paths: z.array(RelPathSchema).min(1).max(1000), toDir: RelPathSchema })
export const DeleteEntriesInputSchema = z.strictObject({ root: RootField, paths: z.array(RelPathSchema).min(1).max(1000) })
export type CreateFolderInput = z.input<typeof CreateFolderInputSchema>
export type RenameEntryInput = z.input<typeof RenameEntryInputSchema>
export type MoveEntriesInput = z.input<typeof MoveEntriesInputSchema>
export type DeleteEntriesInput = z.input<typeof DeleteEntriesInputSchema>

export type FilesChange = "upload" | "mkdir" | "rename" | "move" | "delete"

/** "Descargar como": folders and selections are streamed as one archive. */
export const ARCHIVE_FORMATS = ["zip", "tar.gz"] as const
export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number]

// ---------------------------------------------------------------------------------------------------------------
// «Enviar a equipo»: copy a file of the folder to an equipment over SSH (SFTP, or the scp protocol), through the same
// route as its Ethernet access (the switch port's VLAN, or IP:port), never through the public access port.

export const SshPasswordSchema = z.string().max(256)
/** Checked by src/lib/files/remote-path.ts (the server checks again). */
export const RemotePathSchema = z.string().max(1024)

export const SendStartSchema = z.strictObject({
  root: FilesRootSchema.default(DEFAULT_FILES_ROOT),
  /** Relative paths of files of the folder (1 to SEND_MAX_FILES). */
  paths: z.array(RelPathSchema).min(1).max(20),
  equipmentId: z.string().min(1).max(64),
  /** Same rule as the access «Usuario SSH»: no shell metacharacters. */
  username: SshUserSchema,
  /** null = use the remembered password of this equipment. */
  password: SshPasswordSchema.nullable(),
  destPath: RemotePathSchema,
  /** «Recordar para este equipo»: store user, password and path (checked) or forget them (unchecked). */
  remember: z.boolean(),
})
export type SendStartInput = z.infer<typeof SendStartSchema>
export type SendStartRequest = z.input<typeof SendStartSchema>
export const SEND_MAX_FILES = 20

export type SendState = "queued" | "connecting" | "sending" | "verifying" | "done" | "error" | "canceled"
export type SendVerification = "verified" | "unverifiable"

/** How the bench reaches the equipment's Ethernet (the same as its Ethernet access). */
export type SendRouteDTO =
  | { mode: "switch"; switchPort: number; link: "up" | "down" | "unknown"; ready: boolean; host: string; port: number }
  | { mode: "ip"; host: string; port: number }

export interface SendTargetDTO {
  equipmentId: string
  equipmentName: string
  accessId: string
  accessLabel: string
  route: SendRouteDTO
  policy: "reserved" | "always"
  reservation: { holderName: string; mine: boolean } | null
  /** Can the caller send now (holder of the reservation, or the access is «Siempre»; network ready). */
  allowed: boolean
  /** Why not (Spanish), when not allowed. */
  blockedReason: string | null
  /** «Recordar para este equipo»: the password itself never leaves the server. */
  profile: { username: string | null; destPath: string | null; passwordSaved: boolean } | null
  /** The SSH host key seen the last time (fingerprint as OpenSSH prints it). */
  hostKey: { type: string | null; fingerprint: string; seenAt: IsoDate } | null
}

export interface SendJobDTO {
  id: string
  equipmentId: string
  equipmentName: string
  /** The root of the file. */
  root: FilesRootId
  /** File of the folder (relative path) and its name. */
  path: string
  name: string
  size: number
  sent: number
  /** Bytes per second (smoothed), 0 when unknown. */
  speed: number
  state: SendState
  /** "root@/root/BOOT.BIN" once known; before, the user and the typed path. */
  dest: string
  /** "Puerto 3 del switch" / "192.168.1.10:22". */
  via: string
  protocol: "sftp" | "scp" | null
  verification: SendVerification | null
  checksum: "sha256" | "md5" | null
  replaced: boolean
  /** The equipment presented another SSH host key than last time (not blocking). */
  hostKeyChanged: { previous: string; current: string } | null
  error: string | null
  createdAt: IsoDate
  finishedAt: IsoDate | null
}

// ---------------------------------------------------------------------------------------------------------------
// «Copiar a una carpeta del servidor» (administrators only): copy files of the folder to any folder of the bench host
// (a USB stick, another disk), as the service or, when it cannot write there, «como administrador (sudo)» through the
// root helper (relay-manager-rootcopy), authenticated with the password of the bench's sudo user.

/** Upper bound of one copy request. */
export const COPY_MAX_FILES = 20

export const CopyConflictSchema = z.enum(["replace", "keep", "skip"])
/** «Reemplazar», «Conservar ambos» (name (n).ext), «Omitir». */
export type CopyConflict = z.infer<typeof CopyConflictSchema>
/** Absolute server path (checked on the server: normalised, real path, allowed roots, deny-list). */
export const AbsPathSchema = z.string().min(1).max(4096)
/** The sudo password: never logged, never stored, forgotten when the request is over. */
export const SudoPasswordSchema = z.string().min(1).max(512)
/**
 * How long a sudo password elevates the browser session (the helper's signed token, kept by the service, bound to the
 * session and the web user; never sent to the browser). «Olvidar permisos» drops it before.
 */
export const COPY_ELEVATION_TTL_MS = 5 * 60_000

export const CopyStartSchema = z.strictObject({
  root: FilesRootSchema.default(DEFAULT_FILES_ROOT),
  paths: z.array(RelPathSchema).min(1).max(COPY_MAX_FILES),
  destDir: AbsPathSchema,
  conflict: CopyConflictSchema,
  asRoot: z.boolean(),
  /** With asRoot: the sudo password, or null to use this session's elevation (403 needsPassword when there is none). */
  password: SudoPasswordSchema.nullable(),
})
export type CopyStartInput = z.infer<typeof CopyStartSchema>
export type CopyStartRequest = z.input<typeof CopyStartSchema>

/** Browse as root: the password, or null to use this session's elevation. */
export const CopyBrowseRootSchema = z.strictObject({ path: AbsPathSchema, hidden: z.boolean(), password: SudoPasswordSchema.nullable() })
export const CopyMkdirSchema = z.strictObject({ dir: AbsPathSchema, name: EntryNameSchema, asRoot: z.boolean(), password: SudoPasswordSchema.nullable() })
export type CopyMkdirInput = z.infer<typeof CopyMkdirSchema>
/** /dev/sdb1, /dev/sdc, /dev/mmcblk0p1, /dev/nvme0n1p1 (the helper checks again: removable, never a system disk). */
export const BLOCK_DEVICE_RE = /^\/dev\/(sd[a-z]{1,2}\d{0,3}|mmcblk\d{1,2}(p\d{1,3})?|nvme\d{1,2}n\d{1,2}(p\d{1,3})?|loop\d{1,3}(p\d{1,3})?)$/
export const CopyMountSchema = z.strictObject({ device: z.string().regex(BLOCK_DEVICE_RE), password: SudoPasswordSchema.nullable() })
export type CopyMountInput = z.infer<typeof CopyMountSchema>
export const CopyUnmountSchema = z.strictObject({ mountPoint: AbsPathSchema, password: SudoPasswordSchema.nullable() })
export type CopyUnmountInput = z.infer<typeof CopyUnmountSchema>

/** This browser session can act «como administrador» without typing the password again until `until`. */
export interface CopyElevationDTO {
  until: IsoDate
  /** The sudo account that authenticated it. */
  user: string
}

/** A mounted removable drive or media mount (/media, /run/media, /mnt). */
export interface CopyDriveDTO {
  mountPoint: string
  /** The filesystem label (or the last part of the mount point). */
  label: string
  fsType: string
  /** /dev/sdb1… (empty when unknown). */
  device: string
  removable: boolean
  readOnly: boolean
  freeBytes: number | null
  totalBytes: number | null
  /** The service itself can write there (otherwise only «como administrador»). */
  writable: boolean
  /** The service can open the folder (a desktop automount is often only for its user). */
  readable: boolean
  /** «Expulsar» is offered: a removable/USB block device mounted under /media or /run/media (as root, by the helper). */
  ejectable: boolean
}

/**
 * A removable block device (USB stick, SD card…) that is NOT mounted: «Montar» asks the sudo password and the helper
 * mounts it under /media/<sudo user>/<label or uuid>. Listed from sysfs and the udev database (no root needed): the
 * label and the type may be unknown here (no udev) and the helper probes the device itself before mounting.
 */
export interface CopyDeviceDTO {
  /** /dev/sdb1, or the whole disk when it has no partition table. */
  device: string
  /** The disk it belongs to (/dev/sdb). */
  disk: string
  label: string | null
  uuid: string | null
  /** vfat, exfat, ntfs, ext4… (null when unknown here). */
  fsType: string | null
  sizeBytes: number | null
  /** Vendor and model of the disk, when sysfs says. */
  model: string | null
  usb: boolean
  /** Spanish reason when it cannot be mounted (unsupported filesystem, part of the system disk…); null = «Montar». */
  problem: string | null
}

/** Why «Copiar como administrador (sudo)» is not available, or who authenticates it. */
export interface CopyRootDTO {
  available: boolean
  /** The account whose password is asked (RM_SUDO_USER / the user that installed the app). */
  user: string | null
  /** Spanish explanation when not available, or a warning about the account. */
  problem: string | null
  /** What to run to make it available (install command, sudo passwd…). */
  hint: string | null
  /** Folders where the helper may write (RM_COPY_ROOT_PATHS). */
  writePaths: string[]
}

export interface CopyInfoDTO {
  roots: string[]
  drives: CopyDriveDTO[]
  /** Removable devices that are not mounted (empty when mounting is not available here). */
  devices: CopyDeviceDTO[]
  root: CopyRootDTO
  /** Mount / eject through the helper: available, or why not (Spanish). */
  mount: { available: boolean; problem: string | null }
  /** This browser session's elevation (null: the password will be asked). */
  elevation: CopyElevationDTO | null
}

export interface CopyFolderDTO {
  name: string
  hidden: boolean
  /** A symbolic link to a folder. */
  link: boolean
}

/** A file of a browsed server folder: metadata only (the dialog never reads contents). */
export interface CopyFileDTO {
  name: string
  hidden: boolean
  link: boolean
  size: number | null
  mtime: IsoDate | null
}

export interface CopyMountResultDTO {
  device: string
  mountPoint: string
  fsType: string
  /** The service itself can write there (vfat/exfat/ntfs mounted with the relay-files group); else «como administrador». */
  serviceWritable: boolean
  elevation: CopyElevationDTO | null
}
export interface CopyUnmountResultDTO { mountPoint: string; removedDir: boolean; elevation: CopyElevationDTO | null }

export interface CopyBrowseDTO {
  /** The real path shown (links resolved). */
  path: string
  parent: string | null
  /** The service could read the folder (when false, `folders` is empty: browse it «como administrador»). */
  readable: boolean
  /** The service can write there (the folder exists, is not read-only nor protected). */
  writable: boolean
  /** Writing is never allowed there (system folder, the app's own data…): Spanish reason. */
  denied: string | null
  /** As root: the helper may write there. */
  rootWritable: boolean
  readOnlyMount: boolean
  folders: CopyFolderDTO[]
  /** The files of the folder (metadata only), after the folders; bounded together with them. */
  files: CopyFileDTO[]
  truncated: boolean
  freeBytes: number | null
  totalBytes: number | null
  /** Listed by the root helper. */
  asRoot: boolean
  /** Not readable by the service and «como administrador» is available: the dialog asks the password
   * («Esta carpeta necesita permisos de administrador»), or lists it at once when the session is elevated. */
  needsElevation: boolean
  /** This browser session's elevation after this request (null: none). */
  elevation: CopyElevationDTO | null
}

export type CopyState = "queued" | "copying" | "verifying" | "done" | "skipped" | "error" | "canceled"

export interface CopyJobDTO {
  id: string
  /** The root of the source file. */
  root: FilesRootId
  /** File of the folder (relative path) and its name. */
  path: string
  name: string
  size: number
  copied: number
  speed: number
  state: CopyState
  destDir: string
  /** The final name in the destination (another one with «Conservar ambos»). */
  finalName: string | null
  conflict: CopyConflict
  asRoot: boolean
  /** The sudo user that authenticated a root copy. */
  rootUser: string | null
  replaced: boolean
  /** sha256 of the copy, equal to the source's (checked after writing). */
  sha256: string | null
  error: string | null
  createdAt: IsoDate
  finishedAt: IsoDate | null
}

// ---------------------------------------------------------------------------------------------------------------
// «Descargas»: runs the profile's download script (RM_EXPORT_DOWNLOADER) on the server: one job at a time per server
// (the rest wait in a queue), live log, cancel, the zip lands in the root RM_EXPORT_ROOT.

/** Application name/version charset (no shell is involved: the arguments go as an array; this keeps them sane anyway). */
export const EXPORT_NAME_RE = /^[A-Za-z0-9_.+-]{1,100}$/
const ExportNameSchema = z.string().regex(EXPORT_NAME_RE, "Solo letras, números y . _ + - (como mucho 100).")
  .refine((s) => !s.startsWith("-") && !s.startsWith("."), "No puede empezar por «-» ni por «.».")
export const ExportStartSchema = z.strictObject({
  app: ExportNameSchema,
  version: ExportNameSchema,
  /** -x: the script's optional switch (shown only when the profile names it: RM_EXPORT_EXTRACT_LABEL). */
  extract: z.boolean(),
  /** null/empty = "<app>-<version>_exports.zip"; ".zip" is added when missing. */
  zipName: EntryNameSchema.nullable(),
  /** Destination folder inside the destination root ("" = the root). */
  dir: RelPathSchema,
})
export type ExportStartInput = z.infer<typeof ExportStartSchema>

export type ExportState = "queued" | "running" | "done" | "error" | "canceled"

export interface ExportJobDTO {
  id: string
  app: string
  version: string
  extract: boolean
  /** Destination folder (relative to the destination root). */
  dir: string
  /** Requested zip name (the default one when none was given). */
  zipName: string
  /** The name it got in the destination ("x (2).zip" when the name was taken) and its relative path. */
  finalName: string | null
  finalPath: string | null
  sizeBytes: number | null
  state: ExportState
  /** Position in the queue (1 = next) while queued. */
  queuePosition: number | null
  exitCode: number | null
  error: string | null
  userId: string
  userName: string
  createdAt: IsoDate
  startedAt: IsoDate | null
  finishedAt: IsoDate | null
  /** Lines of the log kept (the last ones; `logDropped` earlier lines were left out). Empty in SSE events. */
  log: string[]
  logDropped: number
}

export interface ExportInfoDTO {
  /** The downloader can run here (script present, enabled). */
  available: boolean
  /** Spanish reason when not available. */
  problem: string | null
  timeoutMin: number
  /** Where the zip lands. */
  root: FilesRootId
  rootLabel: string
  /** Texts of the dialog and the panel (RM_EXPORT_*: the profile names them). */
  labels: {
    name: string
    title: string
    description: string
    app: string
    version: string
    /** The -x checkbox; null = not offered. */
    extract: string | null
  }
}
