"use client"

import * as React from "react"
import { LogOutIcon, UserRoundIcon } from "lucide-react"
import { signOut } from "next-auth/react"
import { AppLink } from "@/components/common/app-link"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tag } from "@/components/ui/tag"
import { shell } from "@/lib/i18n/shell"
import { ThemeRadioItems } from "./theme-toggle"
import { useViewer } from "./shell-context"

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const a = parts[0]?.[0] ?? "?"
  const b = parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? ""
  return `${a}${b}`.toUpperCase()
}

/** §6.4: client signOut without redirect, then a full navigation to /login (works on any LAN host). */
async function logout(): Promise<void> {
  try {
    await signOut({ redirect: false })
  } finally {
    window.location.assign("/login")
  }
}

/** Name, "Mi cuenta", "Cerrar sesión"; below 640 px it also holds the theme choice. Initials in a span (no avatar). */
export function UserMenu({ themeInMenu = false }: { themeInMenu?: boolean }) {
  const viewer = useViewer()
  const [leaving, setLeaving] = React.useState(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 gap-2 px-1.5" aria-label={`${shell.userMenu}: ${viewer.name}`}>
          <span aria-hidden className="grid size-6 place-items-center rounded-full bg-secondary text-micro text-foreground ring-1 ring-border">
            {initials(viewer.name)}
          </span>
          <span className="hidden max-w-40 truncate text-body md:inline">{viewer.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
          <span className="truncate text-body font-medium text-foreground">{viewer.name}</span>
          <span className="flex items-center gap-2">
            <span className="truncate font-mono text-data text-muted-foreground">{viewer.username}</span>
            {viewer.isAdmin ? <Tag tone="outline">{shell.admin}</Tag> : null}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <AppLink href="/cuenta">
              <UserRoundIcon aria-hidden />
              {shell.account}
            </AppLink>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {themeInMenu ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{shell.theme}</DropdownMenuLabel>
            <ThemeRadioItems />
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={leaving}
          onSelect={(e) => {
            e.preventDefault()
            setLeaving(true)
            void logout()
          }}
        >
          <LogOutIcon aria-hidden />
          {leaving ? shell.loggingOut : shell.logout}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
