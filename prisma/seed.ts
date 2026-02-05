/**
 * Relay Manager - Database Seed
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import { PrismaClient } from "@prisma/client"
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3"
import { hash } from "bcryptjs"
import path from "path"

const dbPath = path.join(__dirname, "dev.db")
const adapter = new PrismaBetterSqlite3({ url: dbPath })
const prisma = new PrismaClient({ adapter })

async function main() {
  // Crear roles de ejemplo
  const labRole = await prisma.role.upsert({
    where: { name: "Laboratorio" },
    update: {},
    create: {
      name: "Laboratorio",
      description: "Acceso a equipos del laboratorio",
    },
  })
  console.log("Rol creado:", labRole.name)

  const prodRole = await prisma.role.upsert({
    where: { name: "Producción" },
    update: {},
    create: {
      name: "Producción",
      description: "Acceso a equipos de producción",
    },
  })
  console.log("Rol creado:", prodRole.name)

  // Crear usuario admin (sin roles, ve todo por ser admin)
  const hashedPassword = await hash("admin123", 12)
  const admin = await prisma.user.upsert({
    where: { email: "admin@example.com" },
    update: {},
    create: {
      email: "admin@example.com",
      password: hashedPassword,
      name: "Administrador",
      isAdmin: true,
    },
  })
  console.log("Usuario admin creado:", admin.email)

  // Crear usuario de laboratorio (con rol Laboratorio)
  const labUser = await prisma.user.upsert({
    where: { email: "lab@example.com" },
    update: {
      roles: { set: [{ id: labRole.id }] },
    },
    create: {
      email: "lab@example.com",
      password: hashedPassword,
      name: "Usuario Laboratorio",
      isAdmin: false,
      roles: { connect: [{ id: labRole.id }] },
    },
  })
  console.log("Usuario creado:", labUser.email)

  // Crear usuario con múltiples roles
  const multiUser = await prisma.user.upsert({
    where: { email: "multi@example.com" },
    update: {
      roles: { set: [{ id: labRole.id }, { id: prodRole.id }] },
    },
    create: {
      email: "multi@example.com",
      password: hashedPassword,
      name: "Usuario Multi-rol",
      isAdmin: false,
      roles: { connect: [{ id: labRole.id }, { id: prodRole.id }] },
    },
  })
  console.log("Usuario creado:", multiUser.email)

  // Crear tipo de equipo genérico con 4 relés
  const type4Relays = await prisma.equipmentType.upsert({
    where: { name: "Equipo 4 Relés" },
    update: {
      relayConfig: JSON.stringify([
        { index: 0, purpose: "power", label: "ON/OFF" },
        { index: 1, purpose: "mode", label: "Modo A" },
        { index: 2, purpose: "mode", label: "Modo B" },
        { index: 3, purpose: "mode", label: "Reset" },
      ]),
    },
    create: {
      name: "Equipo 4 Relés",
      description: "Equipo genérico con 4 relés configurables",
      relayCount: 4,
      relayConfig: JSON.stringify([
        { index: 0, purpose: "power", label: "ON/OFF" },
        { index: 1, purpose: "mode", label: "Modo A" },
        { index: 2, purpose: "mode", label: "Modo B" },
        { index: 3, purpose: "mode", label: "Reset" },
      ]),
    },
  })
  console.log("Tipo de equipo creado:", type4Relays.name)

  // Crear tipo de equipo genérico con 2 relés
  const type2Relays = await prisma.equipmentType.upsert({
    where: { name: "Equipo 2 Relés" },
    update: {
      relayConfig: JSON.stringify([
        { index: 0, purpose: "power", label: "ON/OFF" },
        { index: 1, purpose: "mode", label: "Modo" },
      ]),
    },
    create: {
      name: "Equipo 2 Relés",
      description: "Equipo genérico con 2 relés",
      relayCount: 2,
      relayConfig: JSON.stringify([
        { index: 0, purpose: "power", label: "ON/OFF" },
        { index: 1, purpose: "mode", label: "Modo" },
      ]),
    },
  })
  console.log("Tipo de equipo creado:", type2Relays.name)

  console.log("Seed completado!")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
