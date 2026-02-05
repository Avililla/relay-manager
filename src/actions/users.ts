/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use server"

import { revalidatePath } from "next/cache"
import { hash } from "bcryptjs"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

export async function getUsers() {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden ver usuarios")
  }

  return prisma.user.findMany({
    include: {
      roles: true,
    },
    orderBy: { name: "asc" },
  })
}

export async function getUser(id: string) {
  const session = await auth()
  if (!session?.user?.isAdmin && session?.user?.id !== id) {
    throw new Error("No autorizado")
  }

  return prisma.user.findUnique({
    where: { id },
    include: { roles: true },
  })
}

export async function createUser(data: {
  email: string
  password: string
  name: string
  isAdmin: boolean
  roleIds: string[]
}) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden crear usuarios")
  }

  const existing = await prisma.user.findUnique({
    where: { email: data.email },
  })

  if (existing) {
    throw new Error("Ya existe un usuario con ese email")
  }

  const hashedPassword = await hash(data.password, 12)

  const user = await prisma.user.create({
    data: {
      email: data.email,
      password: hashedPassword,
      name: data.name,
      isAdmin: data.isAdmin,
      roles: data.roleIds.length > 0 ? { connect: data.roleIds.map((id) => ({ id })) } : undefined,
    },
  })

  revalidatePath("/users")
  return user
}

export async function updateUser(
  id: string,
  data: {
    email: string
    name: string
    isAdmin: boolean
    roleIds: string[]
    password?: string
  }
) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden editar usuarios")
  }

  const existing = await prisma.user.findFirst({
    where: {
      email: data.email,
      NOT: { id },
    },
  })

  if (existing) {
    throw new Error("Ya existe otro usuario con ese email")
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      email: data.email,
      name: data.name,
      isAdmin: data.isAdmin,
      roles: { set: data.roleIds.map((roleId) => ({ id: roleId })) },
      ...(data.password && { password: await hash(data.password, 12) }),
    },
  })

  revalidatePath("/users")
  revalidatePath(`/users/${id}`)
  return user
}

export async function deleteUser(id: string) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("Solo administradores pueden eliminar usuarios")
  }

  if (session.user.id === id) {
    throw new Error("No puedes eliminarte a ti mismo")
  }

  await prisma.user.delete({
    where: { id },
  })

  revalidatePath("/users")
}
