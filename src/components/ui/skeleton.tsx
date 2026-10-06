import * as React from "react"
import { cn } from "@/lib/client/cn"

/** Static placeholder block (no pulse: steady states never animate, §8.5). Screen readers skip it. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" aria-hidden className={cn("rounded-md bg-secondary", className)} {...props} />
}

export { Skeleton }
