"use client"

import { toast } from "sonner"
import { useServerEvents } from "@/components/providers/events-provider"
import { serverToastView } from "@/lib/client/events-runtime"

/**
 * Shows the server's `toast` events (§4.13, audience user) on every authenticated page, e.g. "<admin> ha liberado
 * tu reserva de <equipo>: <motivo>" after a forced release (§8.9). AppShell mounts it once: pages must not
 * subscribe to "toast" again, or the toast shows twice.
 */
export function useServerToasts(): void {
  useServerEvents(["toast"], (e) => {
    const v = serverToastView(e)
    if (!v) return
    if (v.tone === "warning") toast.warning(v.message, { duration: v.duration })
    else toast.info(v.message, { duration: v.duration })
  })
}
