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

export async function getRoles() {
  const session = await auth()
  if (!session?.user) {
    throw new Error("No autorizado")
  }

  return prisma.role.findMany({
    include: {
      _count: {
        select: {
          users: true,
          equipments: true,
        },
      },
    },
    orderBy: { name: "asc" },
  })
}

export async function getRole(id: string) {
  const session = await auth()
  if (!session?.user) {
    throw new Error("No autorizado")
  }

  return prisma.role.findUnique({
    where: { id },
    include: {
      users: {
        select: {
          id: true,
          name: true,
          email: true,
          isAdmin: true,
        },
      },
      equipments: {
        select: {
          id: true,
          name: true,
          board: {
            select: {
              name: true,
            },
          },
          type: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  })
}

export async function createRole(data: {
  name: string
  description: string | null
}) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden crear roles")
  }

  const existing = await prisma.role.findUnique({
    where: { name: data.name },
  })

  if (existing) {
    throw new Error("Ya existe un rol con ese nombre")
  }

  const role = await prisma.role.create({
    data,
  })

  revalidatePath("/roles")
  return role
}

export async function updateRole(
  id: string,
  data: {
    name: string
    description: string | null
  }
) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden editar roles")
  }

  const existing = await prisma.role.findFirst({
    where: {
      name: data.name,
      NOT: { id },
    },
  })

  if (existing) {
    throw new Error("Ya existe otro rol con ese nombre")
  }

  const role = await prisma.role.update({
    where: { id },
    data,
  })

  revalidatePath("/roles")
  revalidatePath(`/roles/${id}`)
  return role
}

export async function deleteRole(id: string) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden eliminar roles")
  }

  const role = await prisma.role.findUnique({
    where: { id },
  })

  if (!role) {
    throw new Error("Rol no encontrado")
  }

  // Desconectar el rol de todos los usuarios y equipos, luego eliminar
  await prisma.$transaction([
    // Quitar rol de todos los usuarios
    prisma.role.update({
      where: { id },
      data: {
        users: { set: [] },
        equipments: { set: [] },
      },
    }),
    // Eliminar el rol
    prisma.role.delete({
      where: { id },
    }),
  ])

  revalidatePath("/roles")
  revalidatePath("/users")
  revalidatePath("/equipments")
}
