// Model tables and the dS /index.xml tag fingerprint (§4.8). Server-only pure code.
export { modelByModuleId, modelByName, RELAY_MODELS, type RelayModelInfo } from "@/lib/relays/models"

/**
 * dS model candidates from the tag set of `/index.xml` (every app exposes Rly1..Rly32, so the relay tags say nothing).
 * `IO8_s` is ambiguous (dS2824, dS2832 or TCP184): resolve it with `ST` or the UDP module id.
 */
export function fingerprintDsModel(tags: ReadonlySet<string>): string[] {
  if (tags.has("IO40")) return ["dS2408"]
  if (tags.has("IO8_s")) return ["dS2824", "dS2832", "TCP184"]
  if (tags.has("IO7_s")) return ["dS378"]
  if (tags.has("AD4") && tags.has("IO8")) return ["dS3484"]
  if (tags.has("AD4")) return ["dS2242"]
  if (tags.has("AD1")) return ["dS1242"]
  return []
}
