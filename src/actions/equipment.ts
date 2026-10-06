"use server"
// Equipment actions (§7.2, W1-C). Admin only; the logic lives in src/server/services/equipment.ts.
import { revalidatePath } from "next/cache"
import {
  CreateEquipmentInputSchema, DeleteEquipmentInputSchema, ReorderEquipmentInputSchema, UpdateEquipmentBindingsInputSchema,
  UpdateEquipmentInputSchema,
} from "@/lib/contracts/equipment"
import { defineAction } from "@/server/actions/define-action"
import * as svc from "@/server/services/equipment"

function refresh(equipmentId?: string): void {
  try {
    revalidatePath("/")
    revalidatePath("/descubrimiento")
    if (equipmentId) revalidatePath(`/equipos/${equipmentId}`, "layout")
  } catch {
    // outside a request scope (tests): nothing to revalidate
  }
}

export const createEquipment = defineAction(
  CreateEquipmentInputSchema,
  { auth: "admin" },
  async function createEquipment(input, ctx): Promise<{ id: string }> {
    const r = await svc.createEquipment(input, ctx)
    refresh(r.id)
    if (input.templateUpdate) revalidateTemplates()
    return r
  },
)

export const updateEquipment = defineAction(
  UpdateEquipmentInputSchema,
  { auth: "admin" },
  async function updateEquipment(input, ctx): Promise<{ id: string }> {
    const r = await svc.updateEquipment(input, ctx)
    refresh(r.id)
    return r
  },
)

export const updateEquipmentBindings = defineAction(
  UpdateEquipmentBindingsInputSchema,
  { auth: "admin" },
  async function updateEquipmentBindings(input, ctx): Promise<{ id: string }> {
    const r = await svc.updateEquipmentBindings(input, ctx)
    refresh(r.id)
    return r
  },
)

export const deleteEquipment = defineAction(
  DeleteEquipmentInputSchema,
  { auth: "admin", auditDenied: "equipment.delete" },
  async function deleteEquipment(input, ctx): Promise<null> {
    await svc.deleteEquipment(input, ctx)
    refresh()
    return null
  },
)

export const reorderEquipment = defineAction(
  ReorderEquipmentInputSchema,
  { auth: "admin" },
  async function reorderEquipment(input, ctx): Promise<null> {
    await svc.reorderEquipment(input, ctx)
    refresh()
    return null
  },
)

function revalidateTemplates(): void {
  try {
    revalidatePath("/plantillas", "layout")
  } catch {
    // outside a request scope
  }
}
