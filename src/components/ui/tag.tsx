import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/client/cn"

/**
 * Tag (was Badge): a 4 px chip for categories and short facts ("Equipo A", "Fichero", "UDP pasivo").
 * Status tones follow §8.2: text stays --foreground on the tint; the hue is only the 2 px edge (and the icon).
 * Status tones are for state, never for categories: use `neutral`/`outline` for categories.
 */
const tagVariants = cva(
  "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-sm px-1.5 text-micro whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-secondary text-muted-foreground",
        outline: "border border-input text-muted-foreground",
        brand: "bg-brand-tint text-foreground shadow-[inset_2px_0_0_var(--brand)] [&_svg]:text-brand",
        ok: "bg-ok-tint text-foreground shadow-[inset_2px_0_0_var(--ok)] [&_svg]:text-ok",
        warn: "bg-warn-tint text-foreground shadow-[inset_2px_0_0_var(--warn)] [&_svg]:text-warn",
        danger: "bg-danger-tint text-foreground shadow-[inset_2px_0_0_var(--danger)] [&_svg]:text-danger",
      },
      mono: { true: "font-mono tabular-nums", false: "" },
    },
    defaultVariants: { tone: "neutral", mono: false },
  },
)

function Tag({ className, tone, mono, ...props }: React.ComponentProps<"span"> & VariantProps<typeof tagVariants>) {
  return <span data-slot="tag" className={cn(tagVariants({ tone, mono }), className)} {...props} />
}

export { Tag, tagVariants }
