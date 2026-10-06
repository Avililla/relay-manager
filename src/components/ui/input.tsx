import * as React from "react"
import { cn } from "@/lib/client/cn"

/** Text input: 32 px, sunken surface, control border. `aria-invalid` turns the border to danger. */
export const inputClass = [
  "h-8 w-full min-w-0 rounded-md border border-input bg-muted px-2.5 text-body text-foreground",
  "placeholder:text-faint-foreground",
  "hover:border-control-border focus-visible:border-brand focus-visible:outline-offset-0",
  "disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-secondary",
  "aria-invalid:border-danger",
  "file:mr-2 file:border-0 file:bg-transparent file:text-meta file:font-medium file:text-foreground",
].join(" ")

function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(inputClass, className)} {...props} />
}

export { Input }
