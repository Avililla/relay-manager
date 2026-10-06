"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { MenuIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { nav } from "@/lib/i18n/shell"
import { RailBrand, RailNav } from "./app-rail"
import { useShell } from "./shell-context"

/** Below 1024 px the rail becomes a sheet opened by this visible menu button (§8.1). */
export function MobileNavTrigger() {
  const [open, setOpen] = React.useState(false)
  const { shell } = useShell()
  const pathname = usePathname()
  const [lastPath, setLastPath] = React.useState(pathname)
  if (lastPath !== pathname) {
    // Close after any navigation (including Back): adjust state while rendering, no effect needed.
    setLastPath(pathname)
    setOpen(false)
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label={nav.openMenu}>
          <MenuIcon aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent aria-describedby={undefined}>
        <SheetTitle className="sr-only">{shell.labName}</SheetTitle>
        <SheetDescription className="sr-only">{nav.mainNav}</SheetDescription>
        <RailBrand collapsible={false} />
        <nav aria-label={nav.mainNav} className="min-h-0 flex-1 overflow-y-auto border-t px-2 py-3">
          <RailNav mode="full" onNavigate={() => setOpen(false)} />
        </nav>
      </SheetContent>
    </Sheet>
  )
}
