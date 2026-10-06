import * as React from "react"
import { CopyButton } from "@/components/common/copy-button"
import { cn } from "@/lib/client/cn"

/** A shell command the operator types on the bench host, in mono on a sunken well, with a copy button. */
export function CommandLine({ command, copyLabel, className }: { command: string; copyLabel: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1 rounded-md border bg-muted py-0.5 pr-0.5 pl-2.5", className)}>
      {/* Lines break only between words: a break after "relay-" would read as part of the command. */}
      <code className="min-w-0 flex-1 py-1 font-mono text-data text-foreground">
        <span aria-hidden className="mr-2 text-faint-foreground select-none">$</span>
        {command.split(" ").map((word, i) => (
          <React.Fragment key={i}>
            {i ? " " : null}
            <span className="whitespace-nowrap">{word}</span>
          </React.Fragment>
        ))}
      </code>
      <CopyButton value={command} label={copyLabel} />
    </div>
  )
}
