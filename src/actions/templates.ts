"use server"
// Template actions (§7.2, W1-C). Admin only; the logic lives in src/server/services/templates.ts.
import { revalidatePath } from "next/cache"
import {
  DuplicateTemplateInputSchema, TemplateInputSchema, TemplatePropagationInputSchema, TemplateRefInputSchema,
  UpdateTemplateInputSchema, type PropagationPreviewDTO, type TemplateSyncReportDTO,
} from "@/lib/contracts/templates"
import { EmptyInputSchema } from "@/lib/contracts/common"
import { defineAction } from "@/server/actions/define-action"
import * as svc from "@/server/services/templates"

function refresh(): void {
  try {
    revalidatePath("/plantillas", "layout")
    revalidatePath("/equipos/nuevo")
  } catch {
    // outside a request scope (tests): nothing to revalidate
  }
}

export const createTemplate = defineAction(TemplateInputSchema, { auth: "admin" },
  async function createTemplate(input, ctx): Promise<{ id: string }> {
    const r = await svc.createTemplate(input, ctx)
    refresh()
    return r
  })

export const updateTemplate = defineAction(UpdateTemplateInputSchema, { auth: "admin" },
  async function updateTemplate(input, ctx): Promise<{ id: string }> {
    const r = await svc.updateTemplate(input, ctx)
    refresh()
    return r
  })

export const duplicateTemplate = defineAction(DuplicateTemplateInputSchema, { auth: "admin" },
  async function duplicateTemplate(input, ctx): Promise<{ id: string }> {
    const r = await svc.duplicateTemplate(input, ctx)
    refresh()
    return r
  })

export const deleteTemplate = defineAction(TemplateRefInputSchema, { auth: "admin" },
  async function deleteTemplate(input, ctx): Promise<null> {
    await svc.deleteTemplate(input, ctx)
    refresh()
    return null
  })

/** «Recargar plantillas»: the profile's template files (<perfil>/plantillas/*.json) into the database. */
export const reloadTemplates = defineAction(EmptyInputSchema, { auth: "admin" },
  async function reloadTemplates(_input, ctx): Promise<TemplateSyncReportDTO> {
    const r = await svc.reloadTemplates(ctx, ctx.rt.config)
    refresh()
    return r
  })

/** P2: preview of "Aplicar a equipos existentes". */
export const previewTemplatePropagation = defineAction(TemplatePropagationInputSchema, { auth: "admin" },
  async function previewTemplatePropagation(input, ctx): Promise<PropagationPreviewDTO> {
    return svc.previewPropagation(input, ctx)
  })

/** P2: applies label/line changes and adds missing consoles; never deletes consoles or bindings, never touches relays. */
export const applyTemplatePropagation = defineAction(TemplatePropagationInputSchema, { auth: "admin" },
  async function applyTemplatePropagation(input, ctx): Promise<{ updated: number }> {
    const r = await svc.applyPropagation(input, ctx)
    refresh()
    try {
      revalidatePath("/")
    } catch {
      // outside a request scope
    }
    return r
  })
