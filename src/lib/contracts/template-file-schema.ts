// The JSON Schema of a template file (docs/plantilla.schema.json), generated from TemplateFileJsonSchema.
// Regenerate: RM_UPDATE_SCHEMA=1 pnpm vitest run src/lib/contracts/template-file.test.ts
import { z } from "zod"
import { TemplateFileJsonSchema } from "./template-file"

export function templateFileJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(TemplateFileJsonSchema, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as Record<string, unknown>
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://relay-manager.local/plantilla.schema.json",
    title: "Plantilla de equipo de Relay Manager (<perfil>/plantillas/*.json)",
    description: "Una plantilla por fichero. «key» es su identidad estable; el resto se copia al crear cada equipo. Generado desde src/lib/contracts/template-file.ts.",
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema")),
  }
}
