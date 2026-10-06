// Relay services (§4.8–§4.10): controller (drivers, poll loop, set/pulse) and discovery (passive UDP listener,
// active UDP, subnet scan). Created once by boot/start.ts and reached only through the runtime registry.
import type { RelayDeps, RelayServices } from "@/server/runtime/types"
import { createRelayController, type RelayControllerImpl, type TimerApi } from "./controller"
import { createRelayDiscovery, type DiscoveryTiming, type RelayDiscoveryImpl } from "./discovery"
import type { OsInterfaces } from "./discovery/net"
import type { UdpSocketFactory } from "./discovery/udp"
import { createDriverRegistry } from "./registry"
import { defaultTransports } from "./transport"
import type { RelayTransports } from "./types"

/** Test seams; production passes none. */
export interface RelayServicesOptions {
  transports?: RelayTransports
  timers?: TimerApi
  now?: () => Date
  networkInterfaces?: () => OsInterfaces
  createSocket?: UdpSocketFactory
  discoveryTiming?: Partial<DiscoveryTiming>
}

export interface RelayServicesImpl extends RelayServices {
  internals: { controller: RelayControllerImpl; discovery: RelayDiscoveryImpl }
}

export function createRelayServices(deps: RelayDeps, opts: RelayServicesOptions = {}): RelayServicesImpl {
  const transports = opts.transports ?? defaultTransports
  const controller = createRelayController({
    prisma: deps.prisma, bus: deps.bus, audit: deps.audit, reservations: deps.reservations, log: deps.log, config: deps.config,
    transports, timers: opts.timers, now: opts.now,
  })
  // Discovery probes use their own registry (no persistence callback: detection never writes).
  const registry = createDriverRegistry({ transports, timeoutMs: deps.config.relays.timeoutMs, log: deps.log })
  const discovery = createRelayDiscovery({
    config: deps.config, log: deps.log, bus: deps.bus, audit: deps.audit, registry, transports,
    boards: () => controller.knownBoards(),
    networkInterfaces: opts.networkInterfaces, now: opts.now, createSocket: opts.createSocket, timing: opts.discoveryTiming,
  })
  let started = false

  return {
    controller,
    discovery,
    simulatedAllowed: () => deps.config.relays.simulate,
    internals: { controller, discovery },
    async start() {
      if (started) return
      started = true
      await controller.reload() // no timer at all with 0 enabled boards
      await discovery.start()   // passive listener only when RM_RELAY_PASSIVE_DISCOVERY=1
    },
    async stop() {
      await discovery.stop()    // closes UDP, aborts a running scan
      await controller.stop()   // waits for in-flight relay commands (at most 2 s)
    },
  }
}
