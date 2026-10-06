import { describe, expect, it } from "vitest"
import { settingsText, templateText } from "./wizard"

describe("Ajustes · Zona peligrosa", () => {
  it("deleteBody only mentions what the equipment has", () => {
    expect(settingsText.deleteBody(2, 3)).toBe("Borra el equipo con sus consolas y la asignación de sus relés. Las placas de relés y los archivos de captura no se borran.")
    expect(settingsText.deleteBody(1, 0)).toBe("Borra el equipo con su consola. Los archivos de captura no se borran.")
    expect(settingsText.deleteBody(0, 1)).toBe("Borra el equipo y la asignación de su relé. Las placas de relés no se borran.")
    expect(settingsText.deleteBody(0, 0)).toBe("Borra el equipo y su configuración.")
  })
})

describe("§8.7 avoided terms", () => {
  it("template copy never says «tipo de equipo»", () => {
    const all = JSON.stringify(templateText, (_k, v) => (typeof v === "function" ? String(v) : v))
    expect(all).not.toMatch(/tipos? de equipo/i)
  })
})
