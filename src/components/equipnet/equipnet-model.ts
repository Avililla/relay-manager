// Pure view model of "Red de equipos" (Banco card, the Sistema steps, «Preparar switch», access editors). Unit-tested.
import type { ChipTone } from "@/components/common/status-chip"
import type {
  EquipnetEditDTO, EquipnetStatusDTO, HostNetState, LinkState, NetAdapterDTO, SwitchPortDTO, SwitchState,
} from "@/lib/contracts/equipnet"
import type { ServerEvent } from "@/lib/contracts/events"
import { portList } from "@/lib/equipnet/switch-layout"
import { equipnetUi as t, LINK_LABEL } from "@/lib/i18n/equipnet"

export const HOST_TONE: Record<HostNetState, ChipTone> = {
  off: "neutral", ok: "ok", pending: "brand", "no-permission": "warn", "no-adapter": "danger", "no-ip-tool": "danger", blocked: "danger", error: "danger",
}
export const SWITCH_TONE: Record<SwitchState, ChipTone> = {
  unconfigured: "neutral", manual: "neutral", checking: "brand", ok: "ok", unreachable: "danger", "auth-failed": "danger", error: "danger",
}
export const LINK_TONE: Record<LinkState, ChipTone> = { up: "ok", down: "neutral", unknown: "neutral" }

export const reduceEquipnet = (s: EquipnetStatusDTO, e: ServerEvent): EquipnetStatusDTO => (e.type === "equipnet.changed" ? e.status : s)
export const reduceEquipnetMaybe = (s: EquipnetStatusDTO | null, e: ServerEvent): EquipnetStatusDTO | null => (e.type === "equipnet.changed" ? e.status : s)

/** The plan of «Preparar switch» in plain words. */
export function planLines(s: { uplinkPort: number; portCount: number; equipmentIp: string | null }): string[] {
  const eq = Array.from({ length: s.portCount }, (_, i) => i + 1).filter((p) => p !== s.uplinkPort)
  const contiguous = eq.length > 0 && eq[eq.length - 1] - eq[0] === eq.length - 1
  return [
    t.planUplink(s.uplinkPort),
    contiguous ? t.planPorts(eq[0], eq[eq.length - 1]) : t.planPortsList(portList(eq)),
    s.equipmentIp ? t.planIp(s.equipmentIp) : t.planIpMissing,
    t.planSave,
  ]
}

/** "Puerto 3 del switch · enlace activo · libre" / "· Equipo A #02". */
export function portOptionText(p: SwitchPortDTO, suggested: number | null): { title: string; detail: string } {
  const who = p.usedBy.length ? p.usedBy.map((u) => t.portUsedBy(u.equipmentName)).join(", ") : t.portFree
  const parts = [LINK_LABEL[p.link].toLowerCase(), who]
  if (p.port === suggested) parts.push(t.portJustLinked)
  return { title: t.portOption(p.port), detail: parts.join(" · ") }
}

/** Ports to offer for one Ethernet access: equipment ports, free first; a port another equipment has is not offered. */
export function portChoices(net: EquipnetEditDTO | null, current: number | null): Array<{ port: SwitchPortDTO; taken: boolean }> {
  if (!net) return []
  return net.ports.filter((p) => p.role === "equipment").map((p) => ({ port: p, taken: p.usedBy.length > 0 && p.port !== current }))
}

/** Is the passive card to be shown (interfaces not configured yet, or leftovers, and no interface chosen)? */
export function showOffer(s: EquipnetStatusDTO | null): boolean {
  return !!s && s.offerSetup && !s.settings.adapterMac
}

/** Where the Sistema › Red de equipos flow is: the first step not done yet (4 = everything in place). */
export function currentStep(s: EquipnetStatusDTO): 1 | 2 | 3 | 4 {
  const chosen = s.adapters.find((a) => a.chosen)
  if (!s.settings.adapterMac || !chosen) return 1
  if (s.settings.driver === "tplink-easy-smart" && !s.settings.switchHost) return 2
  if (!s.settings.enabled || (s.settings.driver === "tplink-easy-smart" && !s.appliedAt)) return 3
  return 4
}

/** "USB · ASIX AX88179A · USB 2-3", "PCI (tarjeta del equipo) · r8169"… */
export function adapterTypeText(a: NetAdapterDTO): string {
  const kind = a.wireless ? t.typeWireless : a.bus === "usb" ? t.typeUsb : a.bus === "pci" ? t.typePci : t.typeOther
  const what = [a.manufacturer, a.product].filter(Boolean).join(" ") || a.driver
  return [kind, what, a.bus === "usb" ? a.location : null].filter(Boolean).join(" · ")
}

const RECENT_LINK_MS = 10 * 60_000

/** The editors' switch ports, recomputed from a live equipnet.changed status (the edited equipment's ports are free). */
export function editFromStatus(s: EquipnetStatusDTO, equipmentId: string | null, now: number, equipmentPort = 22): EquipnetEditDTO {
  const ports = s.ports.filter((p) => p.role === "equipment").map((p) => ({ ...p, usedBy: p.usedBy.filter((u) => u.equipmentId !== equipmentId) }))
  const recent = ports.filter((p) => p.link === "up" && p.linkUpAt && now - Date.parse(p.linkUpAt) < RECENT_LINK_MS && !p.usedBy.length)
    .sort((a, b) => Date.parse(b.linkUpAt ?? "") - Date.parse(a.linkUpAt ?? ""))
  return {
    configured: s.settings.enabled && !!s.settings.adapterMac, equipmentIp: s.settings.equipmentIp, equipmentPort, portCount: s.settings.portCount,
    uplinkPort: s.settings.uplinkPort, ports, suggestedPort: recent[0]?.port ?? null,
  }
}
