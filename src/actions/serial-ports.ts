/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

export async function getSerialPorts(equipmentId: string) {
  const session = await auth()
  if (!session?.user) {
    throw new Error("No autenticado")
  }

  return prisma.serialPort.findMany({
    where: { equipmentId },
    orderBy: { boardIndex: "asc" },
  })
}

export async function updateSerialPort(
  equipmentId: string,
  boardIndex: number,
  data: {
    serialId?: string | null
    label?: string | null
    baudRate?: number
  }
) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden configurar puertos serial")
  }

  // Upsert: crear si no existe, actualizar si existe
  const serialPort = await prisma.serialPort.upsert({
    where: {
      equipmentId_boardIndex: {
        equipmentId,
        boardIndex,
      },
    },
    create: {
      equipmentId,
      boardIndex,
      serialId: data.serialId || null,
      label: data.label || null,
      baudRate: data.baudRate || 115200,
    },
    update: {
      serialId: data.serialId,
      label: data.label,
      baudRate: data.baudRate,
    },
  })

  revalidatePath(`/equipments/${equipmentId}`)
  revalidatePath(`/equipments/${equipmentId}/edit`)
  revalidatePath(`/equipments/${equipmentId}/serial`)

  return serialPort
}

export async function updateAllSerialPorts(
  equipmentId: string,
  ports: Array<{
    boardIndex: number
    serialId?: string | null
    label?: string | null
    baudRate?: number
  }>
) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden configurar puertos serial")
  }

  // Actualizar todos los puertos en una transacción
  await prisma.$transaction(
    ports.map((port) =>
      prisma.serialPort.upsert({
        where: {
          equipmentId_boardIndex: {
            equipmentId,
            boardIndex: port.boardIndex,
          },
        },
        create: {
          equipmentId,
          boardIndex: port.boardIndex,
          serialId: port.serialId || null,
          label: port.label || null,
          baudRate: port.baudRate || 115200,
        },
        update: {
          serialId: port.serialId,
          label: port.label,
          baudRate: port.baudRate,
        },
      })
    )
  )

  revalidatePath(`/equipments/${equipmentId}`)
  revalidatePath(`/equipments/${equipmentId}/edit`)
  revalidatePath(`/equipments/${equipmentId}/serial`)

  return { success: true }
}

export async function deleteSerialPort(equipmentId: string, boardIndex: number) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden eliminar puertos serial")
  }

  await prisma.serialPort.delete({
    where: {
      equipmentId_boardIndex: {
        equipmentId,
        boardIndex,
      },
    },
  })

  revalidatePath(`/equipments/${equipmentId}`)
  revalidatePath(`/equipments/${equipmentId}/edit`)
  revalidatePath(`/equipments/${equipmentId}/serial`)

  return { success: true }
}
