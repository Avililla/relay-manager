"use server"
// Relay discovery actions (§7.2, W1-B). Admin only, explicit, audited by the discovery service (D20).
import { EmptyInputSchema } from "@/lib/contracts/common"
import { RelayScanInputSchema, type RelayDiscoveryResultDTO } from "@/lib/contracts/relays"
import { defineAction } from "@/server/actions/define-action"

/** "Buscar placas (UDP)": directed broadcasts on each LAN interface (or RM_RELAY_DISCOVERY_BROADCASTS), then read-only enrichment. */
export const runRelayUdpDiscovery = defineAction(EmptyInputSchema, { auth: "admin" },
  async function runRelayUdpDiscovery(_input, ctx): Promise<RelayDiscoveryResultDTO> {
    return ctx.rt.relays.discovery.discoverUdp(ctx.actor)
  })

/** "Escanear subred…": read-only HTTP/TCP probes of the given (or default /24) networks. */
export const runRelaySubnetScan = defineAction(RelayScanInputSchema, { auth: "admin" },
  async function runRelaySubnetScan(input, ctx): Promise<RelayDiscoveryResultDTO> {
    return ctx.rt.relays.discovery.scan(input, ctx.actor)
  })
