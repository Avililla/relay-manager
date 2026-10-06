// `relay-manager plantillas recargar` / `plantillas comprobar`: the profile's template files (<perfil>/plantillas/*.json).
// `recargar` copies them into the database (works with the server running or stopped: the web reads templates from the
// database on every page); `comprobar` only validates them. Exit 1 when a file has errors.
import { reloadProfileTemplates, readProfileTemplatesFor, syncChanged, syncReportLines, templateErrorLines } from "@/server/profile"
import { UsageError } from "./args"
import { cliAudit, openDatabase, type CliContext } from "./context"

const USAGE = "Uso: relay-manager plantillas recargar | relay-manager plantillas comprobar"

export async function templatesCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  const [sub, ...rest] = args
  if (rest.length || (sub !== "recargar" && sub !== "comprobar")) throw new UsageError(USAGE)
  const cfg = ctx.config
  if (!cfg.profile.dir) {
    ctx.io.out(`Sin perfil: ${cfg.profile.path} no existe (define RM_PROFILE_DIR o instala uno con install.sh --perfil).\n`)
    if (sub === "comprobar") return 0
  } else {
    ctx.io.out(`Perfil: ${cfg.profile.dir}\n`)
  }
  for (const w of cfg.profile.warnings) ctx.io.out(`Aviso: ${w}\n`)
  if (sub === "comprobar") {
    const loaded = readProfileTemplatesFor(cfg)
    if (!loaded.found) ctx.io.out("No hay carpeta plantillas/ en el perfil.\n")
    for (const t of loaded.templates) ctx.io.out(`  Correcta: ${t.file} → «${t.name}» (${t.key})\n`)
    const errors = templateErrorLines(loaded)
    for (const e of errors) ctx.io.out(`  Error: ${e}\n`)
    ctx.io.out(errors.length ? `${errors.length} error(es) en las plantillas.\n` : `${loaded.templates.length} plantilla(s) correcta(s).\n`)
    return errors.length ? 1 : 0
  }
  const prisma = await openDatabase(ctx)
  try {
    const report = await reloadProfileTemplates(prisma, cfg)
    if (syncChanged(report)) {
      cliAudit(ctx, {
        action: "template.reload", target: { type: "template", id: null, name: "plantillas" },
        detail: { created: report.created, updated: report.updated, linked: report.linked, retired: report.retired, errors: report.errors.length },
      })
    }
    const lines = syncReportLines(report)
    for (const l of lines) ctx.io.out(`  ${l}\n`)
    if (!lines.length) ctx.io.out("  No hay plantillas en el perfil.\n")
    return report.errors.length ? 1 : 0
  } finally {
    await prisma.$disconnect()
  }
}
