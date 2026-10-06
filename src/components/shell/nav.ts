import {
  CableIcon, CircuitBoardIcon, FolderIcon, LayoutGridIcon, LayoutTemplateIcon, RadarIcon, ScrollTextIcon, Settings2Icon, ShieldCheckIcon, UsersIcon,
  type LucideIcon,
} from "lucide-react"
import { nav } from "@/lib/i18n/shell"

export interface NavItem { href: string; label: string; icon: LucideIcon }
export interface NavGroup { id: string; label: string | null; adminOnly: boolean; items: NavItem[] }

/** Rail grouping (§8.1). Non-admins see Banco and Archivos only. */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "main", label: null, adminOnly: false, items: [
      { href: "/", label: nav.banco, icon: LayoutGridIcon },
      { href: "/archivos", label: nav.archivos, icon: FolderIcon },
    ],
  },
  {
    id: "hardware", label: nav.groupHardware, adminOnly: true, items: [
      { href: "/descubrimiento", label: nav.descubrimiento, icon: RadarIcon },
      { href: "/cables", label: nav.cables, icon: CableIcon },
      { href: "/placas", label: nav.placas, icon: CircuitBoardIcon },
      { href: "/plantillas", label: nav.plantillas, icon: LayoutTemplateIcon },
    ],
  },
  {
    id: "acceso", label: nav.groupAcceso, adminOnly: true, items: [
      { href: "/usuarios", label: nav.usuarios, icon: UsersIcon },
      { href: "/roles", label: nav.roles, icon: ShieldCheckIcon },
    ],
  },
  {
    id: "admin", label: nav.groupAdmin, adminOnly: true, items: [
      { href: "/auditoria", label: nav.auditoria, icon: ScrollTextIcon },
      { href: "/sistema", label: nav.sistema, icon: Settings2Icon },
    ],
  },
]

export function navGroupsFor(isAdmin: boolean, opts: { filesEnabled?: boolean } = {}): NavGroup[] {
  const groups = NAV_GROUPS.filter((g) => isAdmin || !g.adminOnly)
  if (opts.filesEnabled !== false) return groups
  return groups.map((g) => ({ ...g, items: g.items.filter((i) => i.href !== "/archivos") }))
}

/** The rail item a path belongs to. `/equipos/**` belongs to Banco. */
export function activeNavItem(pathname: string): NavItem | null {
  const all = NAV_GROUPS.flatMap((g) => g.items)
  const hit = all
    .filter((i) => i.href !== "/" && (pathname === i.href || pathname.startsWith(`${i.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]
  if (hit) return hit
  return pathname === "/" || pathname.startsWith("/equipos") ? all[0] : null
}
