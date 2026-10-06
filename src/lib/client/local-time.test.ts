import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { formatDateTime } from "@/lib/i18n/format"
import { viewerDateTime } from "./local-time"

const AT = "2026-09-23T21:58:53.000Z"
let tz: string | undefined
beforeEach(() => { tz = process.env.TZ; process.env.TZ = "Asia/Tokyo" })
afterEach(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz })

describe("viewerDateTime", () => {
  it("before mount (server render and hydration): a stable UTC text, whatever the zone", () => {
    expect(viewerDateTime(AT, false)).toBe(`${formatDateTime(AT, "UTC")} UTC`)
  })
  it("after mount: the viewer's (browser's) local time", () => {
    expect(viewerDateTime(AT, true)).toBe(formatDateTime(AT, "Asia/Tokyo"))
    expect(viewerDateTime(AT, true)).not.toBe(viewerDateTime(AT, false))
  })
})
