import { describe, expect, it } from "vitest"
import { DEFAULT_LINE } from "@/lib/contracts/enums"
import { TemplateInputSchema, type TemplateDTO } from "@/lib/contracts/templates"
import {
  blankTemplateForm, buildTemplateInput, isTemplateDirty, namePreview, templateFormFrom, toggleInterface, validateTemplateForm,
} from "./template-form"

const dto: TemplateDTO = {
  id: "t1", key: "equipo-a", name: "Equipo A", description: "Valores provisionales", source: "file", sourceFile: "plantillas/equipo-a.json", retired: false, needsReview: true, position: 0,
  equipmentCount: 3, updatedAt: "2026-09-23T10:00:00.000Z",
  spec: {
    version: 1, namePattern: "Equipo A #{nn}", skipInterfaces: [2, 0],
    consoles: [{ key: "UART0", label: "UART0", line: { ...DEFAULT_LINE }, enterMode: "cr", localEcho: false, identify: { hostnameRegex: "uart0" } }],
    relays: [{ key: "POWER", label: "Alimentación", purpose: "power", requireConfirm: true, defaultPulseMs: null }],
    accesses: [],
  },
}

describe("template form", () => {
  it("round-trips a template into a valid input", () => {
    const f = templateFormFrom(dto)
    expect(f.skipInterfaces).toEqual([0, 2])
    const input = buildTemplateInput(f)
    expect(TemplateInputSchema.safeParse(input).success).toBe(true)
    expect(input.spec.consoles[0].identify).toEqual({ hostnameRegex: "uart0" })
    expect(input.description).toBe("Valores provisionales")
  })

  it("trims text, drops empty identify expressions and turns an empty description into null", () => {
    const f = { ...templateFormFrom(dto), name: "  Rack  ", description: "  ", namePattern: " " }
    f.consoles[0] = { ...f.consoles[0], label: " SEC ", identify: { hostnameRegex: " ", bannerRegex: "U-Boot" } }
    const input = buildTemplateInput(f)
    expect(input.name).toBe("Rack")
    expect(input.description).toBeNull()
    expect(input.spec.namePattern).toBe("{template} #{nn}")
    expect(input.spec.consoles[0]).toMatchObject({ label: "SEC", identify: { bannerRegex: "U-Boot" } })
  })

  it("validates with dotted keys under spec", () => {
    const f = templateFormFrom(dto)
    f.name = ""
    f.consoles.push({ ...f.consoles[0] })
    f.relays[0] = { ...f.relays[0], key: null }
    const fe = validateTemplateForm(f)
    expect(fe.name).toBeDefined()
    expect(fe["spec.consoles.1.key"]).toEqual(["Clave repetida: UART0"])
    expect(fe["spec.relays.0.key"]?.[0]).toMatch(/mayúsculas/)
    expect(validateTemplateForm(templateFormFrom(dto))).toEqual({})
  })

  it("starts a new template with one console and no relays", () => {
    const f = blankTemplateForm()
    expect(f.consoles).toHaveLength(1)
    expect(f.relays).toEqual([])
    expect(validateTemplateForm({ ...f, name: "Rack" })).toEqual({})
  })

  it("previews the next equipment name", () => {
    expect(namePreview("Equipo A #{nn}", "Equipo A", ["Equipo A #01", "Equipo A #02"])).toBe("Equipo A #03")
    expect(namePreview("{template}-{nnn}", "Equipo C", [])).toBe("Equipo C-001")
    expect(namePreview("", "Rack", [])).toBe("Rack #01")
  })

  it("is dirty only for real changes", () => {
    const f = templateFormFrom(dto)
    expect(isTemplateDirty({ ...f, name: "Equipo A " }, f)).toBe(false)
    expect(isTemplateDirty({ ...f, name: "Equipo A2" }, f)).toBe(true)
    expect(isTemplateDirty({ ...f, markReviewed: true }, f)).toBe(true)
  })

  it("toggles skipped interfaces keeping them sorted", () => {
    expect(toggleInterface([2], 0)).toEqual([0, 2])
    expect(toggleInterface([0, 2], 2)).toEqual([0])
  })
})
