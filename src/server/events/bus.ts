import type { Audience, ServerEvent } from "@/lib/contracts/events"
import type { EventBus } from "@/server/runtime/types"
import type { Logger } from "@/server/log"

type Listener = (event: ServerEvent, audience: Audience) => void

/** Typed in-process pub/sub (§4.1). Synchronous delivery; a throwing listener is logged and isolated. */
export function createEventBus(opts: { log?: Logger } = {}): EventBus {
  const listeners = new Set<Listener>()
  return {
    publish(event, audience) {
      for (const l of [...listeners]) {
        if (!listeners.has(l)) continue
        try {
          l(event, audience)
        } catch (err) {
          opts.log?.error("Error en un suscriptor de eventos", { event: event.type, err })
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    listenerCount: () => listeners.size,
  }
}
