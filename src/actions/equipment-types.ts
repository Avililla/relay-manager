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

export async function getEquipmentTypes() {
  const session = await auth()
  if (!session?.user) {
    throw new Error("No autorizado")
  }

  return prisma.equipmentType.findMany({
    include: {
      _count: {
        select: { equipments: true },
      },
    },
    orderBy: { name: "asc" },
  })
}

export async function getEquipmentType(id: string) {
  const session = await auth()
  if (!session?.user) {
    throw new Error("No autorizado")
  }

  return prisma.equipmentType.findUnique({
    where: { id },
    include: {
      equipments: {
        select: {
          id: true,
          name: true,
          startRelay: true,
          board: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  })
}

export async function createEquipmentType(data: {
  name: string
  description: string | null
  relayCount: number
  relayConfig: string
  serialPortCount?: number
}) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden crear tipos de equipo")
  }

  const existing = await prisma.equipmentType.findUnique({
    where: { name: data.name },
  })

  if (existing) {
    throw new Error("Ya existe un tipo de equipo con ese nombre")
  }

  const equipmentType = await prisma.equipmentType.create({
    data,
  })

  revalidatePath("/equipment-types")
  return equipmentType
}

export async function updateEquipmentType(
  id: string,
  data: {
    name: string
    description: string | null
    relayCount: number
    relayConfig: string
    serialPortCount?: number
  }
) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden editar tipos de equipo")
  }

  const existing = await prisma.equipmentType.findFirst({
    where: {
      name: data.name,
      NOT: { id },
    },
  })

  if (existing) {
    throw new Error("Ya existe otro tipo de equipo con ese nombre")
  }

  const equipmentType = await prisma.equipmentType.update({
    where: { id },
    data,
  })

  revalidatePath("/equipment-types")
  revalidatePath(`/equipment-types/${id}`)
  return equipmentType
}

export async function deleteEquipmentType(id: string) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden eliminar tipos de equipo")
  }

  const equipmentType = await prisma.equipmentType.findUnique({
    where: { id },
    include: {
      _count: {
        select: { equipments: true },
      },
    },
  })

  if (!equipmentType) {
    throw new Error("Tipo de equipo no encontrado")
  }

  if (equipmentType._count.equipments > 0) {
    throw new Error(
      `No se puede eliminar: hay ${equipmentType._count.equipments} equipo(s) de este tipo`
    )
  }

  await prisma.equipmentType.delete({
    where: { id },
  })

  revalidatePath("/equipment-types")
}
