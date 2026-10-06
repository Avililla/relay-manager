// Cable labels ("Cables"): name suggestions, identities and how a cable is shown (pure).
import type { CableKind } from "@/lib/contracts/accesses"

const PREFIX: Record<CableKind, string> = { jtag: "JTAG", "serial-adapter": "USB", "net-adapter": "ETH" }

/** "JTAG-01", or one more than the highest "JTAG-NN" already used (case-insensitive). */
export function nextCableName(kind: CableKind, existing: readonly string[]): string {
  const prefix = PREFIX[kind]
  const re = new RegExp(`^${prefix}-(\\d+)$`, "i")
  let max = 0
  for (const n of existing) {
    const m = re.exec(n.trim())
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}-${String(max + 1).padStart(2, "0")}`
}

/** The label identity of a USB-serial adapter: "vid:pid:serial" when the serial is unique, else its USB location. */
export function adapterIdentity(a: { identityKey: string | null; locationKey: string }): string {
  return a.identityKey ?? `loc:${a.locationKey}`
}

/** Label first, serial second; without a label the serial is the title. */
export function cableTitle(name: string | null, serial: string | null): { primary: string; secondary: string | null } {
  if (name) return { primary: name, secondary: serial }
  return { primary: serial ?? "Sin número de serie", secondary: null }
}

/** Identities present `now` that were not there at `baseline` ("conecta el cable que quieres etiquetar"). */
export function newArrivals(baseline: readonly string[], now: readonly string[]): string[] {
  const before = new Set(baseline)
  return now.filter((id) => !before.has(id))
}

/** "Digilent USB Device" (not "Digilent Digilent USB Device"): the maker only when the product does not start with it. */
export function cableProduct(maker: string | null, product: string | null, fallback: string): string {
  if (maker && product) return product.toLowerCase().startsWith(maker.toLowerCase()) ? product : `${maker} ${product}`
  return product ?? maker ?? fallback
}
