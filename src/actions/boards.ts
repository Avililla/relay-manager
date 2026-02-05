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

export async function getBoards() {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden ver placas")
  }

  return prisma.relayBoard.findMany({
    include: {
      equipments: {
        include: { type: true },
        orderBy: { startRelay: "asc" },
      },
    },
    orderBy: { name: "asc" },
  })
}

export async function getBoard(id: string) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden ver placas")
  }

  return prisma.relayBoard.findUnique({
    where: { id },
    include: {
      equipments: {
        include: {
          type: true,
          roles: true,
        },
        orderBy: { startRelay: "asc" },
      },
    },
  })
}

export async function createBoard(data: {
  name: string
  ipAddress: string
  totalRelays?: number
}) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("No autorizado")
  }

  // Verificar si ya existe una placa con esa IP
  const existingBoard = await prisma.relayBoard.findUnique({
    where: { ipAddress: data.ipAddress },
  })

  if (existingBoard) {
    throw new Error(`Ya existe una placa con la IP ${data.ipAddress}`)
  }

  const board = await prisma.relayBoard.create({
    data: {
      name: data.name,
      ipAddress: data.ipAddress,
      totalRelays: data.totalRelays ?? 8,
    },
  })

  revalidatePath("/boards")
  return board
}

export async function updateBoard(
  id: string,
  data: {
    name: string
    ipAddress: string
    totalRelays?: number
  }
) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("No autorizado")
  }

  const board = await prisma.relayBoard.update({
    where: { id },
    data: {
      name: data.name,
      ipAddress: data.ipAddress,
      totalRelays: data.totalRelays,
    },
  })

  revalidatePath("/boards")
  revalidatePath(`/boards/${id}`)
  return board
}

export async function deleteBoard(id: string) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("No autorizado")
  }

  // Eliminar equipos asociados primero
  await prisma.equipment.deleteMany({
    where: { boardId: id },
  })

  await prisma.relayBoard.delete({
    where: { id },
  })

  revalidatePath("/boards")
}

export async function getRoles() {
  return prisma.role.findMany({
    orderBy: { name: "asc" },
  })
}
