import { describe, expect, it } from "vitest"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import type { TemplateSpec } from "@/lib/contracts/templates"
import { diffAgainstTemplate } from "./template-diff"

const spec: Pick<TemplateSpec, "consoles" | "relays"> = {
  consoles: [
    { key: "UART0", label: "UART0", line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: { hostnameRegex: "uart0" } },
    { key: "UART1", label: "UART1", line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: { hostnameRegex: "uart1" } },
  ],
  relays: [
    { key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true, defaultPulseMs: null },
  ],
}

/** A wizard draft copied from the spec, with equipment-only fields, a binding and a board assignment on top. */
function draftFromSpec() {
  return {
    consoles: spec.consoles.map((c, i) => ({ ...structuredClone(c), uid: `c${i}`, hupcl: true, captureToDisk: false, binding: { stableKey: `virtual:/x/ttyV${i}`, matchBy: "path" } })),
    relays: spec.relays.map((r, i) => ({ ...structuredClone(r), uid: `r${i}`, target: null, skipped: true })),
  }
}

describe("diffAgainstTemplate", () => {
  it("reports no change for a copy of the template", () => {
    const d = diffAgainstTemplate(draftFromSpec(), spec)
    expect(d.changed).toBe(false)
    expect(d.consoles).toEqual({ added: [], removed: [], modified: [], reordered: false })
    expect(d.relays).toEqual({ added: [], removed: [], modified: [], reordered: false })
  })

  it("ignores bindings, board assignments, skipped relays and equipment-only fields", () => {
    const draft = draftFromSpec()
    draft.consoles[0].binding = { stableKey: "usb:0403:6011:FT4ABCDE:if01:p0", matchBy: "adapter" }
    draft.consoles[1].hupcl = false
    draft.relays[0] = { ...draft.relays[0], skipped: false, target: null }
    expect(diffAgainstTemplate(draft, spec).changed).toBe(false)
  })

  it("detects an added console", () => {
    const draft = draftFromSpec()
    draft.consoles.push({ ...structuredClone(spec.consoles[1]), key: "AUX", label: "Auxiliar", uid: "c9", hupcl: false, captureToDisk: true, binding: { stableKey: "k", matchBy: "path" } })
    const d = diffAgainstTemplate(draft, spec)
    expect(d.changed).toBe(true)
    expect(d.consoles.added).toEqual(["AUX"])
  })

  it("detects a removed console", () => {
    const draft = draftFromSpec()
    draft.consoles.pop()
    const d = diffAgainstTemplate(draft, spec)
    expect(d.consoles.removed).toEqual(["UART1"])
    expect(d.changed).toBe(true)
  })

  it("detects label, line, Enter mode, echo and identify changes", () => {
    const cases: Array<(c: ReturnType<typeof draftFromSpec>["consoles"][number]) => void> = [
      (c) => { c.label = "Seguridad" },
      (c) => { c.line = { ...c.line, baudRate: 9600 } },
      (c) => { c.line = { ...c.line, parity: "even" } },
      (c) => { c.enterMode = "crlf" },
      (c) => { c.localEcho = true },
      (c) => { c.identify = { hostnameRegex: "seguridad" } },
      (c) => { c.identify = { ...c.identify, bannerRegex: "U-Boot" } },
    ]
    for (const mutate of cases) {
      const draft = draftFromSpec()
      mutate(draft.consoles[0])
      const d = diffAgainstTemplate(draft, spec)
      expect(d.consoles.modified).toEqual(["UART0"])
      expect(d.changed).toBe(true)
    }
  })

  it("treats a missing, undefined or empty identify expression as the same", () => {
    const base = { ...spec, consoles: [{ ...spec.consoles[0], identify: {} }] }
    const draft = { consoles: [{ ...structuredClone(spec.consoles[0]), identify: { hostnameRegex: undefined, bannerRegex: "" } }], relays: draftFromSpec().relays }
    expect(diffAgainstTemplate(draft, base).changed).toBe(false)
  })

  it("detects a reorder of the same keys", () => {
    const draft = draftFromSpec()
    draft.consoles.reverse()
    const d = diffAgainstTemplate(draft, spec)
    expect(d.consoles).toEqual({ added: [], removed: [], modified: [], reordered: true })
    expect(d.changed).toBe(true)
  })

  it("compares relay slot fields only", () => {
    const draft = draftFromSpec()
    draft.relays[0].purpose = "reset"
    expect(diffAgainstTemplate(draft, spec).relays.modified).toEqual(["POWER"])
    const pulse = draftFromSpec()
    pulse.relays[0].defaultPulseMs = 800
    expect(diffAgainstTemplate(pulse, spec).relays.modified).toEqual(["POWER"])
    const confirm = draftFromSpec()
    confirm.relays[0].requireConfirm = false
    expect(diffAgainstTemplate(confirm, spec).relays.modified).toEqual(["POWER"])
  })

  it("treats an undefined default pulse like null", () => {
    const draft = { consoles: draftFromSpec().consoles, relays: [{ key: "POWER", label: "Alimentación", purpose: "power" as const, requireConfirm: true, defaultPulseMs: undefined }] }
    expect(diffAgainstTemplate(draft, spec).changed).toBe(false)
  })

  it("detects added and removed relays, and a template with no relays", () => {
    const none = diffAgainstTemplate({ consoles: draftFromSpec().consoles, relays: [] }, spec)
    expect(none.relays.removed).toEqual(["POWER"])
    const added = diffAgainstTemplate(draftFromSpec(), { ...spec, relays: [] })
    expect(added.relays.added).toEqual(["POWER"])
    expect(diffAgainstTemplate({ consoles: draftFromSpec().consoles, relays: [] }, { ...spec, relays: [] }).changed).toBe(false)
  })

  it("counts a renamed key as one removal plus one addition", () => {
    const draft = draftFromSpec()
    draft.consoles[1].key = "UART1_2"
    const d = diffAgainstTemplate(draft, spec)
    expect(d.consoles.added).toEqual(["UART1_2"])
    expect(d.consoles.removed).toEqual(["UART1"])
  })
})
