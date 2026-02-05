/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

import Link from "next/link"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Server, Cpu, CircuitBoard, Users, Plus, Zap } from "lucide-react"
import { EquipmentControlCard } from "@/components/equipments/equipment-control-card"
import { getSettings } from "@/actions/settings"

async function getData(isAdmin: boolean, roleIds: string[]) {
  // Admins see all, others see:
  // - Equipment with no roles (visible to all)
  // - Equipment where user has at least one matching role
  const equipmentWhereClause = isAdmin
    ? {}
    : {
        OR: [
          { roles: { none: {} } },
          { roles: { some: { id: { in: roleIds } } } },
        ],
      }

  const [equipments, stats, settings] = await Promise.all([
    prisma.equipment.findMany({
      where: equipmentWhereClause,
      include: {
        type: true,
        board: true,
        lockedBy: {
          select: { id: true, email: true, name: true },
        },
      },
      orderBy: [
        { board: { name: "asc" } },
        { name: "asc" },
      ],
    }),
    // Solo cargar stats si es admin
    isAdmin
      ? Promise.all([
          prisma.relayBoard.count(),
          prisma.equipment.count(),
          prisma.equipmentType.count(),
          prisma.user.count(),
        ]).then(([boards, equipments, types, users]) => ({
          boards,
          equipments,
          types,
          users,
        }))
      : null,
    getSettings(),
  ])

  return { equipments, stats, settings }
}

export default async function DashboardPage() {
  const session = await auth()
  const isAdmin = session?.user?.isAdmin ?? false
  const data = await getData(isAdmin, session?.user?.roleIds ?? [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">
          {isAdmin ? "Panel de Control" : "Control de Equipos"}
        </h1>
        <p className="text-muted-foreground">
          Bienvenido, {session?.user?.name}
          {session?.user?.roleNames && session.user.roleNames.length > 0 && (
            <span className="ml-2 text-sm">({session.user.roleNames.join(", ")})</span>
          )}
        </p>
      </div>

      {/* Stats cards - Solo para admin */}
      {isAdmin && data.stats && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Placas</CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{data.stats.boards}</div>
              <CardDescription>Placas de reles</CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Equipos</CardTitle>
              <Cpu className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{data.stats.equipments}</div>
              <CardDescription>Equipos controlables</CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Tipos</CardTitle>
              <CircuitBoard className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{data.stats.types}</div>
              <CardDescription>Tipos de equipo</CardDescription>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Usuarios</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{data.stats.users}</div>
              <CardDescription>Usuarios registrados</CardDescription>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Equipment controls */}
      <div className="space-y-4">
        {isAdmin && (
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Control de Equipos
              </h2>
              <p className="text-sm text-muted-foreground">
                Controla los reles de cada equipo
              </p>
            </div>
            <Link href="/equipments/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Nuevo Equipo
              </Button>
            </Link>
          </div>
        )}

        {data.equipments.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Cpu className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground text-center">
                No hay equipos disponibles
                {!isAdmin && session?.user?.roleIds && session.user.roleIds.length > 0 && (
                  <span className="block text-sm mt-1">
                    (segun tus roles asignados)
                  </span>
                )}
              </p>
              {isAdmin && (
                <Link href="/equipments/new" className="mt-4">
                  <Button variant="outline">Crear primer equipo</Button>
                </Link>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="max-h-[65vh] overflow-auto custom-scrollbar pr-2">
            <div className="flex flex-wrap gap-4">
              {data.equipments.map((equipment) => (
                <EquipmentControlCard
                  key={equipment.id}
                  equipment={equipment}
                  settings={data.settings}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
