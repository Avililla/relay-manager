// Board-supplied text (UDP announcements, ST replies, /index.htm): printable ASCII only, trimmed and capped, so a
// hostile or broken board cannot push control characters or unbounded strings into the UI, the audit or the DB.

/** Printable ASCII only, trimmed, at most `max` characters (64 by default). */
export function sanitizeText(s: string, max = 64): string {
  return s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, max)
}

/** Board model names are short ("dS378", "ETH8020"): 40 characters at most. */
export const MODEL_TEXT_MAX = 40
