import { describe, expect, it } from "vitest"
import { AUDIT_ACTIONS, AUDIT_CATEGORIES } from "@/lib/contracts/audit"
import { ERROR_CODES } from "@/lib/contracts/common"
import { CONSOLE_STATUSES, DRIVER_IDS, RELAY_PURPOSES } from "@/lib/contracts/enums"
import { PROBE_STATES } from "@/lib/contracts/serial"
import { RESERVATION_CAUSES } from "@/lib/contracts/reservations"
import { auditActionLabel, auditCategoryLabel, auditOutcomeLabel } from "./audit"
import { errorMessage } from "./errors"
import { formatBytes, formatDuration, formatDateTime, formatTime, plural } from "./format"
import {
  captureStateLabel, consoleStatusLabel, driverLabel, healthGroupLabel, healthLevelLabel, probeStateLabel, relayPurposeLabel, reservationCauseLabel,
} from "./status"

describe("i18n labels cover every frozen enum", () => {
  it("audit actions, categories and outcomes", () => {
    for (const a of AUDIT_ACTIONS) expect(auditActionLabel(a), a).not.toBe(a)
    for (const c of AUDIT_CATEGORIES) expect(auditCategoryLabel(c).length).toBeGreaterThan(0)
    expect(auditOutcomeLabel("denied")).toBe("Denegado")
  })
  it("error codes", () => {
    for (const c of ERROR_CODES) expect(errorMessage(c).length, c).toBeGreaterThan(3)
    expect(errorMessage("RESERVED_BY_OTHER", { holderName: "Luis" })).toContain("Luis")
  })
  it("statuses", () => {
    for (const s of CONSOLE_STATUSES) expect(consoleStatusLabel(s).length).toBeGreaterThan(0)
    for (const s of PROBE_STATES) expect(probeStateLabel(s).length).toBeGreaterThan(0)
    for (const s of RESERVATION_CAUSES) expect(reservationCauseLabel(s).length).toBeGreaterThan(0)
    for (const s of RELAY_PURPOSES) expect(relayPurposeLabel(s).length).toBeGreaterThan(0)
    for (const s of DRIVER_IDS) expect(driverLabel(s).length).toBeGreaterThan(0)
    for (const s of ["active", "paused-disk", "disabled", "off"] as const) expect(captureStateLabel(s).length).toBeGreaterThan(0)
    for (const s of ["ok", "warn", "fail", "info"] as const) expect(healthLevelLabel(s).length).toBeGreaterThan(0)
    for (const s of ["runtime", "data", "serial", "relays", "network", "clock", "service"] as const) expect(healthGroupLabel(s).length).toBeGreaterThan(0)
    expect(consoleStatusLabel("missing")).toBe("Adaptador desconectado")
    expect(captureStateLabel("paused-disk")).toBe("Captura en pausa: poco espacio en disco")
  })
})

describe("format", () => {
  it("plural uses Intl.PluralRules('es')", () => {
    expect(plural(1, { one: "1 consola", other: "# consolas" })).toBe("1 consola")
    expect(plural(3, { one: "# consola", other: "# consolas" })).toBe("3 consolas")
    expect(plural(0, { one: "# consola", other: "# consolas" })).toBe("0 consolas")
  })
  it("bytes and durations", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1536)).toBe("1,5 KiB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MiB")
    expect(formatDuration(48_000)).toBe("0:48")
    expect(formatDuration(24 * 60_000 + 13_000)).toBe("24:13")
    expect(formatDuration(2 * 3600_000 + 5 * 60_000)).toBe("2:05:00")
    expect(formatDuration(-5)).toBe("0:00")
  })
  it("dates use es-ES in the given zone", () => {
    expect(formatTime("2026-09-23T11:42:00.000Z", "Europe/Madrid")).toBe("13:42")
    expect(formatDateTime("2026-09-23T11:42:00.000Z", "Europe/Madrid")).toMatch(/23\/9\/2026|23\/09\/2026/)
  })
})
