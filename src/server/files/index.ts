// "Archivos" service (Graph A, rt.files): one core per shared folder («raíz»: tftp and the optional second folder of
// the profile, "extra") plus its HTTP API under /api/files/, «Enviar a equipo», «Copiar a una carpeta del servidor» and
// «Descargas» (the profile's download script).
import { EXPORT_WORK_DIR, FILES_ROOTS, type FilesRootDTO, type FilesRootId } from "@/lib/contracts/files"
import { filesRootLabel } from "./roots"
import type { ActorRef, FilesDeps, FilesService } from "@/server/runtime/types"
import { createFilesCore, type FilesCore, type FilesInternals } from "./core"
import { createFilesHttp } from "./http"
import { filesError } from "./paths"
import { createSendService, type SendInternals } from "./send/service"
import { createCopyService, type CopyInternals } from "./copy/service"
import { createExportService, type ExportInternals } from "./export/service"

export type FilesCores = Record<FilesRootId, FilesCore | null>

export function createFilesServices(
  deps: FilesDeps,
  internals: FilesInternals & { send?: SendInternals; copy?: CopyInternals; exports?: ExportInternals } = {},
): FilesService {
  const fc = deps.config.files
  const base = { config: deps.config, log: deps.log, bus: deps.bus, audit: deps.audit }
  const exportRoot = deps.config.exports.root
  const reservedIn = (root: FilesRootId) => (deps.config.exports.enabled && exportRoot === root ? [EXPORT_WORK_DIR] : [])
  const cores: FilesCores = {
    tftp: createFilesCore({ ...base, root: { id: "tftp", dir: fc.dir, reserved: reservedIn("tftp") } }, internals),
    extra: fc.extraEnabled ? createFilesCore({ ...base, root: { id: "extra", dir: fc.extraDir, reserved: reservedIn("extra") } }, internals) : null,
  }
  const labelOf = (root: FilesRootId) => filesRootLabel(fc, root)
  const coreOf = (root: FilesRootId): FilesCore => {
    const c = cores[root]
    if (!c) throw filesError("NOT_FOUND", `La carpeta ${labelOf(root).label} no está disponible en este servidor.`)
    return c
  }
  const openSource = (root: FilesRootId, rel: string) => coreOf(root).openDownload(rel)
  // «Enviar a equipo»: needs the reservations and the equipment network (the routes of the Ethernet accesses).
  const send = deps.reservations && deps.equipnet
    ? createSendService({
      config: deps.config, log: deps.log, prisma: deps.prisma, bus: deps.bus, audit: deps.audit, reservations: deps.reservations, equipnet: deps.equipnet,
      openSource,
    }, internals.send)
    : null
  // «Copiar a una carpeta del servidor» (administrators; the root helper for «como administrador»).
  const copy = createCopyService({ ...base, openSource }, internals.copy)
  // «Descargas»: the profile's download script, into RM_EXPORT_ROOT.
  const exports = createExportService({ ...base, core: cores[exportRoot], rootLabel: labelOf(exportRoot).label }, internals.exports)
  const handle = createFilesHttp({
    cores, rootLabels: { tftp: labelOf("tftp").label, extra: labelOf("extra").label }, send, copy, exports, enabled: fc.enabled, log: deps.log, audit: deps.audit, authenticate: deps.authenticate,
  })
  const on = () => {
    if (!fc.enabled) throw filesError("DISABLED", "Archivos está desactivado en este servidor.")
  }
  const by = (actor: ActorRef) => actor.name
  const enabledCores = () => FILES_ROOTS.map((id) => cores[id]).filter((c): c is FilesCore => c !== null)
  return {
    settings: () => cores.tftp!.settings(),
    roots: (): FilesRootDTO[] => enabledCores().map((c) => ({ id: c.rootId, ...labelOf(c.rootId), enabled: true, path: c.spec.dir })),
    status: () => cores.tftp!.status(),
    statusOf: (root) => coreOf(root).status(),
    async list(root, rel) { on(); return coreOf(root).list(rel) },
    async mkdir(root, dir, name, actor) { on(); return coreOf(root).mkdir(dir, name, actor, by(actor)) },
    async rename(root, rel, newName, actor) { on(); return coreOf(root).rename(rel, newName, actor, by(actor)) },
    async move(root, rels, toDir, actor) { on(); return coreOf(root).move(rels, toDir, actor, by(actor)) },
    async remove(root, rels, actor) { on(); return coreOf(root).remove(rels, actor, by(actor)) },
    exportInfo: () => exports.info(),
    handleRequest: (req, res) => handle(req, res),
    stats: () => ({
      uploads: enabledCores().reduce((n, c) => n + c.sessions(), 0),
      sends: send?.stats() ?? { active: 0, queued: 0 },
      copies: copy.stats(),
      exports: exports.stats(),
    }),
    copyRootStatus: () => copy.rootStatus(),
    async start() {
      for (const c of enabledCores()) await c.start()
      send?.begin()
      await exports.begin()
    },
    async stop() {
      await exports.stop()
      await copy.stop()
      await send?.stop()
      for (const c of enabledCores()) await c.stop()
    },
  }
}
