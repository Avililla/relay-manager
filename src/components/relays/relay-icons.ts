import { PowerIcon, RotateCcwIcon, ToggleRightIcon, ZapIcon, type LucideIcon } from "lucide-react"
import type { RelayPurpose } from "@/lib/contracts/enums"

/** One icon per relay purpose (§8.9 relay rows): ⏻ power, ↻ reset, mode toggle, generic. */
export const PURPOSE_ICON: Record<RelayPurpose, LucideIcon> = {
  power: PowerIcon,
  reset: RotateCcwIcon,
  mode: ToggleRightIcon,
  generic: ZapIcon,
}
