"use client"

import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { SimpleTooltip } from "@/components/ui/tooltip"
import { copyText } from "@/lib/client/clipboard"
import { actions } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

/** Icon button that copies `value`; works over plain HTTP (clipboard fallback, §8.10). Failure → toast. */
export function CopyButton({ value, label, className, size = "icon-sm" }: { value: string; label?: string; className?: string; size?: "icon-sm" | "icon" }) {
  const [done, setDone] = React.useState(false)
  React.useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(t)
  }, [done])
  const name = label ?? actions.copy
  return (
    <SimpleTooltip label={done ? actions.copied : name}>
      <Button
        variant="ghost"
        size={size}
        aria-label={name}
        className={cn("text-muted-foreground hover:text-foreground", className)}
        onClick={async () => {
          if (await copyText(value)) setDone(true)
          else toast.error(actions.copyFailed)
        }}
      >
        {done ? <CheckIcon aria-hidden className="text-ok" /> : <CopyIcon aria-hidden />}
        <span className="sr-only" aria-live="polite">{done ? actions.copied : ""}</span>
      </Button>
    </SimpleTooltip>
  )
}
