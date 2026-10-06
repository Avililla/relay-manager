import { describe, expect, it } from "vitest"
import { UpdateSettingsInputSchema, type SettingsDTO } from "@/lib/contracts/settings"
import type { HealthCheckDTO } from "@/lib/contracts/system"
import {
  CONFIG_IMPORT_MAX_CHARS, activeSystemTab, backupLabel, systemTabLabel, groupHealth, healthCounts, inspectConfigFile, pickSettings, reservationWarningError, settingsDirty,
  formatUptime, hintSegments, onlyHealthIssues, prioritizeHealth, settingsPatch, worstLevel,
} from "./system-model"

const settings: SettingsDTO = {
  labName: "Laboratorio", bannerText: null, reservationTimeoutMin: 30, reservationWarningMin: 5,
  captureRetentionDays: 30, captureMaxTotalMb: 10240, captureMaxFileMb: 64, inputCapture: "markers", auditRetentionDays: 365,
  backupDailyEnabled: true, backupDailyHour: 2, backupRetentionCount: 14, setupCompletedAt: null, updatedAt: "2026-09-23T10:00:00.000Z",
}

describe("settingsPatch", () => {
  const keys = ["labName", "bannerText", "auditRetentionDays"] as const
  const base = pickSettings(settings, keys)

  it("is empty without changes, including whitespace-only edits", () => {
    expect(settingsPatch(base, { ...base, labName: " Laboratorio " }, keys)).toEqual({})
    expect(settingsDirty(base, base, keys)).toBe(false)
  })
  it("sends only the changed keys, trimmed", () => {
    const patch = settingsPatch(base, { ...base, labName: " Laboratorio norte ", auditRetentionDays: 90 }, keys)
    expect(patch).toEqual({ labName: "Laboratorio norte", auditRetentionDays: 90 })
    expect(UpdateSettingsInputSchema.safeParse(patch).success).toBe(true)
  })
  it("maps an emptied banner to null and ignores empty vs null", () => {
    expect(settingsPatch({ ...base, bannerText: "Mantenimiento" }, { ...base, bannerText: "  " }, keys)).toEqual({ bannerText: null })
    expect(settingsPatch(base, { ...base, bannerText: "" }, keys)).toEqual({})
  })
})

describe("reservationWarningError", () => {
  it("requires warning < timeout", () => {
    expect(reservationWarningError(30, 5)).toBeNull()
    expect(reservationWarningError(30, 30)).toMatch(/menor/)
    expect(reservationWarningError(10, 20)).toMatch(/menor/)
  })
})

describe("backupLabel", () => {
  it("names every label kind", () => {
    expect(backupLabel("daily")).toBe("Diaria")
    expect(backupLabel("manual")).toBe("Manual")
    expect(backupLabel("pre-migrate")).toBe("Antes de migrar")
    expect(backupLabel("pre-restore")).toBe("Antes de restaurar")
    expect(backupLabel("pre-upgrade-1.0.0-to-2.0.0")).toBe("Antes de actualizar de 1.0.0 a 2.0.0")
    expect(backupLabel("import")).toBe("Importada")
    expect(backupLabel("otra")).toBe("otra")
  })
})

describe("inspectConfigFile", () => {
  const valid = {
    format: "relay-manager-config", version: 1, exportedAt: "2026-09-23T10:00:00.000Z", appVersion: "2.0.0",
    settings: { labName: "Laboratorio", bannerText: null },
    roles: [{ name: "Integración", description: null }], templates: [], boards: [], equipment: [],
  }
  it("accepts a valid export and counts its parts", () => {
    const r = inspectConfigFile(JSON.stringify(valid))
    expect(r).toEqual({ ok: true, appVersion: "2.0.0", exportedAt: "2026-09-23T10:00:00.000Z", counts: { roles: 1, templates: 0, boards: 0, equipment: 0 } })
  })
  it("explains what is wrong", () => {
    expect(inspectConfigFile("{nope")).toMatchObject({ ok: false, reason: expect.stringMatching(/JSON/) })
    expect(inspectConfigFile(JSON.stringify({ hello: 1 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/exportación/) })
    expect(inspectConfigFile(JSON.stringify({ ...valid, version: 2 }))).toMatchObject({ ok: false })
    expect(inspectConfigFile("x".repeat(CONFIG_IMPORT_MAX_CHARS + 1))).toMatchObject({ ok: false, reason: expect.stringMatching(/2 MB/) })
  })
})

describe("health", () => {
  const mk = (id: string, group: HealthCheckDTO["group"], level: HealthCheckDTO["level"]): HealthCheckDTO => ({ id, group, level, label: id, message: "", hint: null })
  const checks = [mk("serial.dialout", "serial", "warn"), mk("runtime.node", "runtime", "ok"), mk("data.db", "data", "ok"), mk("data.backups", "data", "fail"), mk("clock.ntp", "clock", "info")]

  it("orders groups and keeps check order", () => {
    const g = groupHealth(checks)
    expect(g.map((x) => x.group)).toEqual(["runtime", "data", "serial", "clock"])
    expect(g[1].checks.map((c) => c.id)).toEqual(["data.db", "data.backups"])
    expect(g[1].worst).toBe("fail")
  })
  it("orders groups and checks for triage without losing any", () => {
    const g = prioritizeHealth(groupHealth(checks))
    expect(g.map((x) => x.group)).toEqual(["data", "serial", "runtime", "clock"])
    expect(g[0].checks.map((c) => c.id)).toEqual(["data.backups", "data.db"])
    const mixed = prioritizeHealth(groupHealth([mk("a", "data", "ok"), mk("b", "data", "info"), mk("c", "data", "warn"), mk("d", "data", "ok"), mk("e", "data", "warn")]))
    expect(mixed[0].checks.map((c) => c.id)).toEqual(["c", "e", "b", "a", "d"])
    expect(onlyHealthIssues(g).map((x) => [x.group, x.checks.map((c) => c.id)])).toEqual([["data", ["data.backups"]], ["serial", ["serial.dialout"]]])
  })
  it("counts levels and finds the worst", () => {
    expect(healthCounts(checks)).toEqual({ ok: 2, warn: 1, fail: 1, info: 1, worst: "fail" })
    expect(worstLevel([])).toBe("ok")
    expect(worstLevel(["ok", "info"])).toBe("info")
  })
})

describe("activeSystemTab", () => {
  it("matches General only on /sistema itself", () => {
    expect(activeSystemTab("/sistema")).toBe("/sistema")
    expect(activeSystemTab("/sistema/copias")).toBe("/sistema/copias")
    expect(activeSystemTab("/sistema/salud/x")).toBe("/sistema/salud")
    expect(activeSystemTab("/sistemas")).toBeNull()
    expect(systemTabLabel("/sistema/acerca")).toBe("Acerca de")
  })
})

describe("formatUptime", () => {
  it("uses the two largest units", () => {
    expect(formatUptime(20)).toBe("menos de 1 min")
    expect(formatUptime(5 * 60 + 9)).toBe("5 min")
    expect(formatUptime(2 * 3600 + 15 * 60)).toBe("2 h 15 min")
    expect(formatUptime(3600)).toBe("1 h")
    expect(formatUptime(3 * 86400 + 4 * 3600 + 59)).toBe("3 d 4 h")
    expect(formatUptime(-5)).toBe("menos de 1 min")
  })
})

describe("hintSegments", () => {
  const code = (h: string) => hintSegments(h).filter((x) => x.code).map((x) => x.text)
  const joined = (h: string) => hintSegments(h).map((x) => x.text).join("")
  it("finds whole-line commands", () => {
    expect(hintSegments("sudo chown -R relay-manager:relay-manager /var/lib/relay-manager")).toEqual([{ text: "sudo chown -R relay-manager:relay-manager /var/lib/relay-manager", code: true }])
    expect(code("sudo usermod -aG dialout relay-manager && sudo systemctl restart relay-manager")).toEqual(["sudo usermod -aG dialout relay-manager && sudo systemctl restart relay-manager"])
    expect(code("sudo ss -ltnp 'sport = :3000'")).toEqual(["sudo ss -ltnp 'sport = :3000'"])
  })
  it("separates prose before and after a command", () => {
    expect(hintSegments("Restaura la última copia: relay-manager restore <copia>")).toEqual([
      { text: "Restaura la última copia: ", code: false }, { text: "relay-manager restore <copia>", code: true },
    ])
    expect(code("relay-manager setup-token muestra el código de configuración")).toEqual(["relay-manager setup-token"])
    expect(code("sudo usermod -aG dialout ana y vuelve a iniciar sesión")).toEqual(["sudo usermod -aG dialout ana"])
    expect(code("Se instaló una versión más nueva: sudo relay-manager rollback, o restaura la copia pre-upgrade")).toEqual(["sudo relay-manager rollback"])
    expect(code("Comprueba el registro del servidor y el espacio libre; relay-manager backup crea una copia manual")).toEqual(["relay-manager backup"])
    expect(code("sudo apt remove brltty (sin conexión: sudo systemctl mask brltty-udev.service)")).toEqual(["sudo apt remove brltty", "sudo systemctl mask brltty-udev.service"])
    expect(code("Ajusta la hora (sudo date -s …) y revisa la pila del reloj (RTC)")).toEqual(["sudo date -s …"])
  })
  it("keeps prose-only hints whole and never loses text", () => {
    for (const h of ["Actívalas en Sistema > Copias de seguridad", "Instala la regla udev (install.sh) y ejecuta: sudo udevadm trigger --action=change", "Usa el Node 22 incluido en el paquete (node/bin/node)",
      "Se instaló una versión más nueva: sudo relay-manager rollback, o restaura la copia pre-upgrade", "sudo apt remove brltty (sin conexión: sudo systemctl mask brltty-udev.service)", "Ajusta la hora (sudo date -s …) y revisa"]) {
      expect(joined(h)).toBe(h)
    }
    expect(code("Actívalas en Sistema > Copias de seguridad")).toEqual([])
    expect(code("Usa el Node 22 incluido en el paquete (node/bin/node)")).toEqual([])
  })
})
