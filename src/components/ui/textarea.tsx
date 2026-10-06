import * as React from "react"
import { cn } from "@/lib/client/cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-sizing-content min-h-16 w-full rounded-md border border-input bg-muted px-2.5 py-1.5 text-body text-foreground",
        "placeholder:text-faint-foreground hover:border-control-border focus-visible:border-brand focus-visible:outline-offset-0",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
