/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { relayEvents } from "@/lib/relay-events"
import { getSettings } from "./settings"

// Bloquear un equipo - usa transacción atómica para evitar condiciones de carrera
export async function lockEquipment(equipmentId: string) {
  const session = await auth()
  if (!session?.user?.id) {
    throw new Error("No autenticado")
  }

  const settings = await getSettings()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + settings.lockTimeoutMins * 60 * 1000)
  const userId = session.user.id
  const isAdmin = session.user.isAdmin

  // Transacción atómica: verificar y bloquear en una sola operación
  const result = await prisma.$transaction(async (tx) => {
    // Obtener equipo con bloqueo pesimista (FOR UPDATE en SQL)
    const equipment = await tx.equipment.findUnique({
      where: { id: equipmentId },
      include: { lockedBy: true },
    })

    if (!equipment) {
      throw new Error("Equipo no encontrado")
    }

    // Verificar si ya está bloqueado por otro usuario (y no ha expirado)
    const isCurrentlyLocked = equipment.lockedById !== null &&
                              equipment.lockExpiresAt !== null &&
                              equipment.lockExpiresAt > now

    if (isCurrentlyLocked && equipment.lockedById !== userId && !isAdmin) {
      throw new Error(`Equipo bloqueado por ${equipment.lockedBy?.email}`)
    }

    // Actualizar con condición WHERE para doble verificación
    const updated = await tx.equipment.update({
      where: {
        id: equipmentId,
        // Condición atómica: solo actualizar si no está bloqueado por otro
        // o si el bloqueo ya expiró o si somos el owner/admin
        OR: [
          { lockedById: null },
          { lockedById: userId },
          { lockExpiresAt: { lt: now } },
          ...(isAdmin ? [{ lockedById: { not: null } }] : []),
        ],
      },
      data: {
        lockedById: userId,
        lockedAt: now,
        lockExpiresAt: expiresAt,
      },
      include: {
        lockedBy: {
          select: { id: true, email: true, name: true },
        },
      },
    })

    return updated
  })

  // Emitir evento SSE para sincronizar todos los clientes
  relayEvents.emitLock(equipmentId, {
    lockedById: result.lockedById,
    lockedBy: result.lockedBy,
    lockExpiresAt: result.lockExpiresAt,
  })

  revalidatePath("/")

  return {
    lockedBy: result.lockedBy,
    lockedAt: result.lockedAt,
    lockExpiresAt: result.lockExpiresAt,
  }
}

// Desbloquear un equipo - usa updateMany con condición atómica
export async function unlockEquipment(equipmentId: string) {
  const session = await auth()
  if (!session?.user?.id) {
    throw new Error("No autenticado")
  }

  const userId = session.user.id
  const isAdmin = session.user.isAdmin

  // Actualización atómica: solo desbloquear si somos el owner o admin
  const result = await prisma.equipment.updateMany({
    where: {
      id: equipmentId,
      OR: [
        { lockedById: userId },
        ...(isAdmin ? [{ lockedById: { not: null } }] : []),
      ],
    },
    data: {
      lockedById: null,
      lockedAt: null,
      lockExpiresAt: null,
    },
  })

  if (result.count === 0) {
    throw new Error("No tienes permiso para desbloquear este equipo")
  }

  // Emitir evento SSE para sincronizar todos los clientes
  relayEvents.emitLock(equipmentId, {
    lockedById: null,
    lockedBy: null,
    lockExpiresAt: null,
  })

  revalidatePath("/")

  return { success: true }
}

// Renovar el bloqueo - actualización atómica solo si somos el owner
export async function renewLock(equipmentId: string) {
  const session = await auth()
  if (!session?.user?.id) {
    throw new Error("No autenticado")
  }

  const settings = await getSettings()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + settings.lockTimeoutMins * 60 * 1000)
  const userId = session.user.id

  // Actualización atómica: solo renovar si somos el owner actual
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.equipment.updateMany({
      where: {
        id: equipmentId,
        lockedById: userId,
      },
      data: {
        lockExpiresAt: expiresAt,
      },
    })

    if (updated.count === 0) {
      return { renewed: false, equipment: null }
    }

    const equipment = await tx.equipment.findUnique({
      where: { id: equipmentId },
      include: {
        lockedBy: {
          select: { id: true, email: true, name: true },
        },
      },
    })

    return { renewed: true, equipment }
  })

  if (!result.renewed || !result.equipment) {
    return { renewed: false }
  }

  // Emitir evento SSE para sincronizar todos los clientes
  relayEvents.emitLock(equipmentId, {
    lockedById: result.equipment.lockedById,
    lockedBy: result.equipment.lockedBy,
    lockExpiresAt: expiresAt,
  })

  return {
    renewed: true,
    lockExpiresAt: expiresAt,
  }
}

// Obtener estado de bloqueo de un equipo
export async function getLockStatus(equipmentId: string) {
  const session = await auth()
  const settings = await getSettings()
  const now = new Date()

  const equipment = await prisma.equipment.findUnique({
    where: { id: equipmentId },
    include: {
      lockedBy: {
        select: { id: true, email: true, name: true },
      },
    },
  })

  if (!equipment) {
    throw new Error("Equipo no encontrado")
  }

  // Verificar si el bloqueo ha expirado
  const isLocked = equipment.lockedById !== null &&
                   equipment.lockExpiresAt !== null &&
                   equipment.lockExpiresAt > now

  // Si el bloqueo expiró, limpiarlo atómicamente
  if (equipment.lockedById && !isLocked) {
    await prisma.equipment.updateMany({
      where: {
        id: equipmentId,
        lockExpiresAt: { lt: now },
      },
      data: {
        lockedById: null,
        lockedAt: null,
        lockExpiresAt: null,
      },
    })

    // Emitir evento SSE
    relayEvents.emitLock(equipmentId, {
      lockedById: null,
      lockedBy: null,
      lockExpiresAt: null,
    })

    return {
      isLocked: false,
      lockedBy: null,
      lockExpiresAt: null,
      canControl: true,
      isOwner: false,
      warningBeforeMins: settings.warningBeforeMins,
    }
  }

  const isOwner = equipment.lockedById === session?.user?.id
  const isAdmin = session?.user?.isAdmin ?? false
  const canControl = !isLocked || isOwner || isAdmin

  return {
    isLocked,
    lockedBy: isLocked ? equipment.lockedBy : null,
    lockExpiresAt: isLocked ? equipment.lockExpiresAt : null,
    canControl,
    isOwner,
    warningBeforeMins: settings.warningBeforeMins,
  }
}

// Desbloqueo forzado por admin - actualización atómica
export async function forceUnlockEquipment(equipmentId: string) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo los administradores pueden forzar el desbloqueo")
  }

  await prisma.equipment.update({
    where: { id: equipmentId },
    data: {
      lockedById: null,
      lockedAt: null,
      lockExpiresAt: null,
    },
  })

  // Emitir evento SSE para sincronizar todos los clientes
  relayEvents.emitLock(equipmentId, {
    lockedById: null,
    lockedBy: null,
    lockExpiresAt: null,
  })

  revalidatePath("/")

  return { success: true }
}
