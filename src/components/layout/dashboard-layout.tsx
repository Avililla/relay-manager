/**
 * Relay Manager - Dashboard Layout
 *
 * @author Alejandro Avila Marcos
 * Made with ❤️ for dev team Valdepeñas
 */

"use client"

import { AppSidebar } from "./app-sidebar"
import { Footer } from "./footer"
import { RelayStateProvider } from "@/components/providers/relay-state-provider"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
import { useSession } from "next-auth/react"

function HeaderBar() {
  const { data: session } = useSession()

  return (
    <header className="flex h-12 shrink-0 items-center justify-end gap-2 border-b px-4">
      <div className="flex items-center gap-2">
        {session?.user?.roleNames && session.user.roleNames.length > 0 && (
          <div className="flex gap-1">
            {session.user.roleNames.map((name) => (
              <Badge key={name} variant="outline" className="text-xs">
                {name}
              </Badge>
            ))}
          </div>
        )}
        {session?.user?.isAdmin && (
          <Badge variant="default" className="text-xs">Admin</Badge>
        )}
      </div>
    </header>
  )
}

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RelayStateProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <HeaderBar />
          <main className="flex-1 overflow-hidden p-6">{children}</main>
          <Footer />
        </SidebarInset>
      </SidebarProvider>
    </RelayStateProvider>
  )
}
