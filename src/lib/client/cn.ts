// `cn` that knows the design tokens (§8.3): without this, tailwind-merge reads `text-meta` (a font size) as a text
// colour and drops it next to `text-muted-foreground`. Pure; usable from server and client components.
import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

export const TEXT_SIZES = ["title", "section", "body", "meta", "micro", "data"] as const

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [...TEXT_SIZES],
      shadow: ["overlay"],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
