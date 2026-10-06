"use client"

import * as React from "react"
import { useShell, type Breadcrumb } from "./shell-context"

/**
 * Sets the TopBar breadcrumb for the current page (§8.8): `<PageMeta breadcrumbs={[{ label: "Banco", href: "/" },
 * { label: "Equipo A #07" }]} />`. Pages cannot pass props up to the layout, so this is the only way; it clears the
 * breadcrumb on unmount. Renders nothing.
 */
export function PageMeta({ breadcrumbs }: { breadcrumbs: Breadcrumb[] }) {
  const { setBreadcrumbs } = useShell()
  const key = JSON.stringify(breadcrumbs)
  React.useEffect(() => {
    setBreadcrumbs(JSON.parse(key) as Breadcrumb[])
    return () => setBreadcrumbs(null)
  }, [key, setBreadcrumbs])
  return null
}
