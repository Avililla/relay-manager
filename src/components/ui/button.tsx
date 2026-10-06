import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/client/cn"
import { pendingButtonProps } from "@/lib/client/pending-focus"

/**
 * Buttons (§8.4, §8.5): sizes sm 28 / md 32 / lg 36 / icon; 6 px radius; `:active` scale 0.98 in 100 ms.
 * The cobalt primary is reserved for the main action of a view. Destructive actions stay quiet
 * (`danger-outline`) until the confirm step, where `danger` is the filled confirm button.
 * Use `<Button asChild><AppLink … /></Button>` for links, never <a><button>.
 */
const buttonVariants = cva(
  [
    "press relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium select-none",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "border-input bg-secondary text-foreground hover:border-control-border hover:bg-accent",
        primary: "border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
        outline: "border-input bg-transparent text-foreground hover:border-control-border hover:bg-secondary",
        ghost: "border-transparent bg-transparent text-foreground hover:bg-secondary",
        "danger-outline": "border-danger/60 bg-transparent text-danger hover:border-danger hover:bg-danger-tint",
        danger: "border-transparent bg-danger-fill text-danger-fill-foreground hover:bg-danger-fill/90",
        link: "h-auto border-transparent p-0 text-brand underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 text-meta [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-8 px-3 text-body",
        lg: "h-9 px-4 text-body",
        icon: "size-8 p-0",
        "icon-sm": "size-7 p-0 [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    compoundVariants: [{ variant: "link", className: "h-auto px-0" }],
    defaultVariants: { variant: "default", size: "md" },
  },
)

type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & {
  asChild?: boolean
  /**
   * The button's action is running: `aria-disabled` + `aria-busy` and clicks/submits ignored, but it stays focusable
   * (a real `disabled` would drop focus to <body>). Use `disabled` only for rule-based states.
   */
  pending?: boolean
}

function Button({ className, variant, size, asChild = false, type, pending = false, onClick, "aria-disabled": ariaDisabled, "aria-busy": ariaBusy, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "default"}
      className={cn(buttonVariants({ variant, size }), className)}
      type={asChild ? undefined : (type ?? "button")}
      {...props}
      {...pendingButtonProps(pending, { onClick, "aria-disabled": ariaDisabled, "aria-busy": ariaBusy })}
    />
  )
}

export { Button, buttonVariants, type ButtonProps }
