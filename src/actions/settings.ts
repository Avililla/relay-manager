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

const GLOBAL_SETTINGS_ID = "global"

export async function getSettings() {
  let settings = await prisma.settings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
  })

  // Crear configuración por defecto si no existe
  if (!settings) {
    settings = await prisma.settings.create({
      data: {
        id: GLOBAL_SETTINGS_ID,
        lockTimeoutMins: 30,
        warningBeforeMins: 5,
      },
    })
  }

  return settings
}

export async function updateSettings(data: {
  lockTimeoutMins: number
  warningBeforeMins: number
}) {
  const session = await auth()
  if (!session?.user?.isAdmin) {
    throw new Error("No autorizado")
  }

  // Validaciones
  if (data.lockTimeoutMins < 5) {
    throw new Error("El tiempo de bloqueo mínimo es 5 minutos")
  }
  if (data.warningBeforeMins < 1) {
    throw new Error("El tiempo de aviso mínimo es 1 minuto")
  }
  if (data.warningBeforeMins >= data.lockTimeoutMins) {
    throw new Error("El tiempo de aviso debe ser menor al tiempo de bloqueo")
  }

  const settings = await prisma.settings.upsert({
    where: { id: GLOBAL_SETTINGS_ID },
    update: {
      lockTimeoutMins: data.lockTimeoutMins,
      warningBeforeMins: data.warningBeforeMins,
    },
    create: {
      id: GLOBAL_SETTINGS_ID,
      lockTimeoutMins: data.lockTimeoutMins,
      warningBeforeMins: data.warningBeforeMins,
    },
  })

  revalidatePath("/settings")
  revalidatePath("/")

  return settings
}
