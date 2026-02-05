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

export async function getEquipments() {
  const session = await auth()
  if (!session?.user) {
    throw new Error("No autorizado")
  }

  // Admins see all, others see:
  // - Equipment with no roles (visible to all)
  // - Equipment where user has at least one matching role
  const whereClause = session.user.isAdmin
    ? {}
    : {
        OR: [
          { roles: { none: {} } }, // No roles = visible to all
          { roles: { some: { id: { in: session.user.roleIds } } } }, // User has matching role
        ],
      }

  return prisma.equipment.findMany({
    where: whereClause,
    include: {
      type: true,
      roles: true,
      board: {
        select: {
          id: true,
          name: true,
          ipAddress: true,
          totalRelays: true,
          relayState: true,
        },
      },
    },
    orderBy: [{ name: "asc" }],
  })
}

export async function getEquipment(id: string) {
  const session = await auth()
  if (!session?.user) {
    throw new Error("No autorizado")
  }

  const equipment = await prisma.equipment.findUnique({
    where: { id },
    include: {
      type: true,
      roles: true,
      board: true,
    },
  })

  // Check role access
  if (equipment && !session.user.isAdmin) {
    // No roles = visible to all
    if (equipment.roles.length === 0) {
      return equipment
    }
    // Check if user has at least one matching role
    const hasAccess = equipment.roles.some((role) =>
      session.user.roleIds.includes(role.id)
    )
    if (!hasAccess) {
      return null
    }
  }

  return equipment
}

// Find available relay slots on a board
export async function findAvailableSlots(boardId: string, relayCount: number) {
  const board = await prisma.relayBoard.findUnique({
    where: { id: boardId },
    include: {
      equipments: {
        select: {
          startRelay: true,
          type: {
            select: { relayCount: true },
          },
        },
        orderBy: { startRelay: "asc" },
      },
    },
  })

  if (!board) {
    return []
  }

  const totalRelays = board.totalRelays
  const occupiedRanges: Array<{ start: number; end: number }> = []

  // Build occupied ranges
  for (const eq of board.equipments) {
    occupiedRanges.push({
      start: eq.startRelay,
      end: eq.startRelay + eq.type.relayCount - 1,
    })
  }

  // Find available slots
  const availableSlots: number[] = []

  for (let start = 1; start <= totalRelays - relayCount + 1; start++) {
    const end = start + relayCount - 1
    let isAvailable = true

    for (const range of occupiedRanges) {
      // Check if ranges overlap
      if (start <= range.end && end >= range.start) {
        isAvailable = false
        break
      }
    }

    if (isAvailable) {
      availableSlots.push(start)
    }
  }

  return availableSlots
}

export async function createEquipment(data: {
  name: string
  description?: string | null
  serialNumber?: string | null
  typeId: string
  boardId: string
  roleIds: string[]
  startRelay?: number
}) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden crear equipos")
  }

  // Get equipment type to know relay count
  const equipmentType = await prisma.equipmentType.findUnique({
    where: { id: data.typeId },
  })

  if (!equipmentType) {
    throw new Error("Tipo de equipo no encontrado")
  }

  // Get board info
  const board = await prisma.relayBoard.findUnique({
    where: { id: data.boardId },
    include: {
      equipments: {
        select: {
          startRelay: true,
          type: { select: { relayCount: true } },
        },
      },
    },
  })

  if (!board) {
    throw new Error("Placa no encontrada")
  }

  // Determine start relay
  let startRelay = data.startRelay

  if (!startRelay) {
    // Find first available slot
    const availableSlots = await findAvailableSlots(
      data.boardId,
      equipmentType.relayCount
    )
    if (availableSlots.length === 0) {
      throw new Error(
        `No hay espacio disponible para ${equipmentType.relayCount} relé(s) en esta placa`
      )
    }
    startRelay = availableSlots[0]
  } else {
    // Validate the chosen slot is available
    const availableSlots = await findAvailableSlots(
      data.boardId,
      equipmentType.relayCount
    )
    if (!availableSlots.includes(startRelay)) {
      throw new Error("El relé seleccionado no está disponible")
    }
  }

  // Get max order for this board
  const maxOrder = await prisma.equipment.aggregate({
    where: { boardId: data.boardId },
    _max: { order: true },
  })

  const equipment = await prisma.equipment.create({
    data: {
      name: data.name,
      description: data.description || null,
      serialNumber: data.serialNumber || null,
      typeId: data.typeId,
      boardId: data.boardId,
      roles: data.roleIds.length > 0 ? { connect: data.roleIds.map((id) => ({ id })) } : undefined,
      startRelay,
      order: (maxOrder._max.order ?? 0) + 1,
    },
  })

  revalidatePath("/equipments")
  revalidatePath(`/boards/${data.boardId}`)
  revalidatePath("/")
  return equipment
}

export async function updateEquipment(
  id: string,
  data: {
    name: string
    description?: string | null
    serialNumber?: string | null
    roleIds?: string[]
    startRelay?: number
  }
) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden editar equipos")
  }

  const existing = await prisma.equipment.findUnique({
    where: { id },
    include: { type: true },
  })

  if (!existing) {
    throw new Error("Equipo no encontrado")
  }

  // If changing startRelay, validate it's available
  if (data.startRelay && data.startRelay !== existing.startRelay) {
    // Get available slots excluding this equipment
    const board = await prisma.relayBoard.findUnique({
      where: { id: existing.boardId },
      include: {
        equipments: {
          where: { NOT: { id } },
          select: {
            startRelay: true,
            type: { select: { relayCount: true } },
          },
        },
      },
    })

    if (!board) {
      throw new Error("Placa no encontrada")
    }

    const totalRelays = board.totalRelays
    const occupiedRanges = board.equipments.map((eq) => ({
      start: eq.startRelay,
      end: eq.startRelay + eq.type.relayCount - 1,
    }))

    const newEnd = data.startRelay + existing.type.relayCount - 1

    // Check if new position is valid
    if (newEnd > totalRelays) {
      throw new Error("El equipo no cabe en esa posición")
    }

    for (const range of occupiedRanges) {
      if (data.startRelay <= range.end && newEnd >= range.start) {
        throw new Error("El relé seleccionado está ocupado por otro equipo")
      }
    }
  }

  const equipment = await prisma.equipment.update({
    where: { id },
    data: {
      name: data.name,
      description: data.description,
      serialNumber: data.serialNumber,
      ...(data.roleIds !== undefined && {
        roles: {
          set: data.roleIds.map((roleId) => ({ id: roleId })),
        },
      }),
      ...(data.startRelay && { startRelay: data.startRelay }),
    },
  })

  revalidatePath("/equipments")
  revalidatePath(`/equipments/${id}`)
  revalidatePath(`/boards/${existing.boardId}`)
  revalidatePath("/")
  return equipment
}

export async function deleteEquipment(id: string) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden eliminar equipos")
  }

  const equipment = await prisma.equipment.findUnique({
    where: { id },
  })

  if (!equipment) {
    throw new Error("Equipo no encontrado")
  }

  await prisma.equipment.delete({
    where: { id },
  })

  revalidatePath("/equipments")
  revalidatePath(`/boards/${equipment.boardId}`)
  revalidatePath("/")
}

// Get all boards with available relay info (admin only, for equipment assignment)
export async function getBoardsForEquipment(requiredRelays?: number) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("No autorizado")
  }

  const boards = await prisma.relayBoard.findMany({
    include: {
      equipments: {
        select: {
          startRelay: true,
          type: { select: { relayCount: true } },
        },
      },
    },
    orderBy: { name: "asc" },
  })

  // Calcular relés disponibles para cada placa
  return boards.map((board) => {
    const usedRelays = board.equipments.reduce(
      (sum, eq) => sum + eq.type.relayCount,
      0
    )
    const availableRelays = board.totalRelays - usedRelays

    // Calcular si hay espacio contiguo para el número requerido de relés
    let hasSpaceFor = availableRelays
    if (requiredRelays) {
      const occupiedRanges = board.equipments
        .map((eq) => ({
          start: eq.startRelay,
          end: eq.startRelay + eq.type.relayCount - 1,
        }))
        .sort((a, b) => a.start - b.start)

      let maxContiguous = 0
      let currentStart = 1

      for (const range of occupiedRanges) {
        const gap = range.start - currentStart
        if (gap > maxContiguous) maxContiguous = gap
        currentStart = range.end + 1
      }
      // Check space after last equipment
      const endGap = board.totalRelays - currentStart + 1
      if (endGap > maxContiguous) maxContiguous = endGap

      hasSpaceFor = maxContiguous
    }

    return {
      id: board.id,
      name: board.name,
      ipAddress: board.ipAddress,
      totalRelays: board.totalRelays,
      availableRelays,
      hasSpaceFor,
    }
  })
}
