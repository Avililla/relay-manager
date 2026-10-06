import { renderToString } from "react-dom/server"
import { jsx } from "react/jsx-runtime"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AuditEventDTO } from "@/lib/contracts/audit"
import { ServerClockProvider } from "@/components/providers/server-clock-provider"
import { formatDateTime } from "@/lib/i18n/format"
import { AuditTable } from "./audit-table"
import { RelativeTime } from "./relative-time"

// Absolute timestamps are rendered on the server and hydrated as-is (React does not patch mismatched text or
// attributes), so the server markup must not depend on the server's time zone: it is a stable UTC text, and the
// browser formats in its own zone after mount.
const AT = "2026-09-23T21:58:53.000Z"
const UTC_TEXT = `${formatDateTime(AT, "UTC")} UTC`
const NY_TEXT = formatDateTime(AT, "America/New_York")
let tz: string | undefined
beforeEach(() => { tz = process.env.TZ; process.env.TZ = "America/New_York" }) // a server far from UTC
afterEach(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz })

describe("server markup of absolute times", () => {
  it("the test runs in a zone whose local text differs from UTC", () => {
    expect(formatDateTime(AT)).toBe(NY_TEXT)
    expect(NY_TEXT).not.toBe(formatDateTime(AT, "UTC"))
  })

  it("RelativeTime: text and title are the UTC placeholder, never the server's local time", () => {
    const html = renderToString(jsx(ServerClockProvider, { serverNow: AT, children: jsx(RelativeTime, { value: AT }) }))
    expect(html).toContain(`title="${UTC_TEXT}"`)
    expect(html).toContain(`>${UTC_TEXT}</time>`)
    expect(html).not.toContain(NY_TEXT)
  })

  it("AuditTable: the time column is the UTC placeholder, never the server's local time", () => {
    const ev: AuditEventDTO = {
      id: 1, at: AT, actorKind: "user", actorId: "u1", actorName: "admin", ip: null, action: "auth.login.ok", outcome: "ok",
      equipmentId: null, equipmentName: null, targetType: null, targetId: null, targetName: null, detail: null,
    }
    const html = renderToString(jsx(AuditTable, { events: [ev] }))
    expect(html).toContain(UTC_TEXT)
    expect(html).not.toContain(NY_TEXT)
  })
})
