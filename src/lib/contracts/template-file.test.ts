import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { formatIssuePath, jsonErrorMessage, parseTemplateFile } from "./template-file"
import { templateFileJsonSchema } from "./template-file-schema"

const SCHEMA_FILE = path.join(process.cwd(), "docs", "plantilla.schema.json")
const LINE = { baudRate: 115200, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none" }
const base = {
  key: "equipo-a", name: "Equipo A", namePattern: "Equipo A #{nn}",
  consoles: [{ key: "UART0", label: "UART0", line: LINE }, { key: "UART1", label: "UART1", line: LINE }],
}

describe("parseTemplateFile", () => {
  it("accepts a minimal file and fills the defaults", () => {
    const r = parseTemplateFile(JSON.stringify(base))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.template).toMatchObject({ key: "equipo-a", name: "Equipo A", description: null, needsReview: false, position: null })
    expect(r.template.spec).toMatchObject({ version: 1, skipInterfaces: [], relays: [], accesses: [] })
    expect(r.template.spec.consoles[0]).toMatchObject({ enterMode: "cr", localEcho: false, identify: {} })
  })

  it("defaults an Ethernet access without a host to the switch", () => {
    const r = parseTemplateFile(JSON.stringify({ ...base, accesses: [{ key: "ETH", label: "Ethernet", kind: "tcp", targetPort: 22, sshUser: "root" }] }))
    expect(r.ok && r.template.spec.accesses[0].targetMode).toBe("switch")
  })

  it("reports Spanish errors with the JSON path", () => {
    const r = parseTemplateFile(JSON.stringify({ ...base, key: "Equipo A", consoles: [{ ...base.consoles[0], key: "uart0" }], color: "rojo" }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.key).toBeNull()
    expect(r.errors.some((e) => e.startsWith("key: Usa minúsculas"))).toBe(true)
    expect(r.errors.some((e) => e.startsWith("consoles[0].key: Usa mayúsculas"))).toBe(true)
    expect(r.errors.some((e) => /color/.test(e))).toBe(true)
  })

  it("checks the cross-field rules (repeated keys, serial access console)", () => {
    const r = parseTemplateFile(JSON.stringify({
      ...base, consoles: [base.consoles[0], base.consoles[0]],
      accesses: [{ key: "SERIE", label: "Serie", kind: "serial", consoleKey: "NOPE" }],
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.key).toBe("equipo-a")
    expect(r.errors).toContain("consoles[1].key: Clave repetida: UART0")
    expect(r.errors.some((e) => e.startsWith("accesses[0]"))).toBe(true)
  })

  it("says where invalid JSON breaks", () => {
    const r = parseTemplateFile('{\n  "key": "a"\n  "name": "b"\n}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatch(/^JSON no válido \(línea 3, columna \d+\)$/)
    expect(jsonErrorMessage("{}", new Error("Unexpected end of JSON input"))).toBe("JSON no válido")
    expect(formatIssuePath(["consoles", 1, "line", "baudRate"])).toBe("consoles[1].line.baudRate")
  })
})

describe("docs/plantilla.schema.json", () => {
  it("is in sync with the Zod schema", () => {
    const json = JSON.stringify(templateFileJsonSchema(), null, 2) + "\n"
    if (process.env.RM_UPDATE_SCHEMA === "1") fs.writeFileSync(SCHEMA_FILE, json)
    expect(fs.readFileSync(SCHEMA_FILE, "utf8")).toBe(json)
  })

  it("accepts the example profile's templates", () => {
    const dir = path.join(process.cwd(), "examples", "perfil-ejemplo", "plantillas")
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const f of files) {
      const r = parseTemplateFile(fs.readFileSync(path.join(dir, f), "utf8"))
      expect(r.ok ? [] : r.errors, f).toEqual([])
    }
  })
})
