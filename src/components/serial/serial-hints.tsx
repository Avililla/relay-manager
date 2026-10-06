import * as React from "react"
import { CopyButton } from "@/components/common/copy-button"
import { InlineAlert } from "@/components/common/inline-alert"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import { serial } from "@/lib/i18n/shell"
import { cn } from "@/lib/client/cn"

const COMMAND = /^(sudo|docker|relay-manager|systemctl|usermod|udevadm|apt|ls|groups)\b/

/**
 * Why a serial picker is empty (§8.8): the SERIAL_HINT_CHECKS results (dialout, devices, ModemManager, brltty).
 * Only checks that are not "ok" are shown. A hint that is a shell command is shown in mono with a copy button;
 * any other hint is plain text.
 */
export function SerialHints({ checks, className }: { checks: HealthCheckDTO[]; className?: string }) {
  const shown = checks.filter((c) => c.level !== "ok")
  if (!shown.length) return null
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} aria-label={serial.hintsTitle} role="group">
      {shown.map((c) => (
        <InlineAlert key={c.id} tone={c.level === "fail" ? "danger" : c.level === "warn" ? "warn" : "info"} title={c.label}>
          <p>{c.message}</p>
          {c.hint && COMMAND.test(c.hint) ? (
            <span className="mt-1.5 flex items-center gap-1 rounded-sm bg-muted py-0.5 pr-0.5 pl-2">
              {/* It scrolls sideways when long, so it must be reachable by keyboard (axe scrollable-region-focusable). */}
              <span tabIndex={0} role="group" aria-label={serial.commandLabel(c.hint)} className="min-w-0 flex-1 overflow-x-auto rounded-sm py-1">
                <code className="font-mono text-data whitespace-nowrap text-foreground">{c.hint}</code>
              </span>
              <CopyButton value={c.hint} />
            </span>
          ) : c.hint ? (
            <p className="mt-1">{c.hint}</p>
          ) : null}
        </InlineAlert>
      ))}
    </div>
  )
}
