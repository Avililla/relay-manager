// Devantech model table (§4.8): module id → model and PHYSICAL relay count (D4). UI-safe, pure data.

export interface RelayModelInfo {
  model: string
  family: "ds" | "eth"
  moduleId: number
  /** Physical relays. dS apps always expose 32 <RlyN> tags; never count them. */
  relays: number
}

export const RELAY_MODELS: readonly RelayModelInfo[] = [
  { model: "dS1242", family: "ds", moduleId: 31, relays: 2 },
  { model: "dS2242", family: "ds", moduleId: 32, relays: 2 },
  { model: "dS3484", family: "ds", moduleId: 30, relays: 4 },
  { model: "TCP184", family: "ds", moduleId: 36, relays: 4 },
  { model: "dS378", family: "ds", moduleId: 35, relays: 8 },
  { model: "dS2408", family: "ds", moduleId: 47, relays: 8 },
  { model: "dS2824", family: "ds", moduleId: 34, relays: 24 },
  { model: "dS2832", family: "ds", moduleId: 42, relays: 32 },
  { model: "ETH002", family: "eth", moduleId: 18, relays: 2 },
  { model: "ETH008", family: "eth", moduleId: 19, relays: 8 },
  { model: "ETH484", family: "eth", moduleId: 20, relays: 4 },
  { model: "ETH8020", family: "eth", moduleId: 21, relays: 20 },
]

export function modelByModuleId(id: number): RelayModelInfo | null {
  return RELAY_MODELS.find((m) => m.moduleId === id) ?? null
}

/** Case-insensitive; tolerates the "-B" suffix of ETH boards ("ETH008-B"). */
export function modelByName(name: string | null | undefined): RelayModelInfo | null {
  if (!name) return null
  const n = name.trim().toLowerCase().replace(/-b$/, "")
  return RELAY_MODELS.find((m) => m.model.toLowerCase() === n) ?? null
}

/** Physical relay count for a model name, or null when the model is unknown (the form then asks for it). */
export function modelRelayCount(name: string | null | undefined): number | null {
  return modelByName(name)?.relays ?? null
}
