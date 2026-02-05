/**
 * Relay Manager
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useSession } from "next-auth/react"
import { cn } from "@/lib/utils"
import {
  LayoutDashboard,
  Server,
  Cpu,
  Settings,
  Users,
  Shield,
  CircuitBoard,
} from "lucide-react"

const adminNavigation = [
  { name: "Placas", href: "/boards", icon: Server },
  { name: "Equipos", href: "/equipments", icon: Cpu },
  { name: "Tipos de Equipo", href: "/equipment-types", icon: CircuitBoard },
  { name: "Usuarios", href: "/users", icon: Users },
  { name: "Roles", href: "/roles", icon: Shield },
]

export function Sidebar() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const isAdmin = session?.user?.isAdmin

  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-sidebar">
      <div className="flex h-14 items-center border-b px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Server className="h-6 w-6" />
          <span>Relay Manager</span>
        </Link>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        <div className="space-y-1">
          <Link
            href="/"
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              pathname === "/"
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            )}
          >
            <LayoutDashboard className="h-4 w-4" />
            {isAdmin ? "Dashboard" : "Control de Equipos"}
          </Link>
        </div>

        {isAdmin && (
          <>
            <div className="my-4 border-t" />
            <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Administración
            </p>
            <div className="mt-2 space-y-1">
              {adminNavigation.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + "/")
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.name}
                  </Link>
                )
              })}
            </div>
          </>
        )}
      </nav>
    </aside>
  )
}
