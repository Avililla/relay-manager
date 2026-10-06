/** The "(Expira m:ss) " prefix the reservation chip puts in front of the page title (§8.1). */
export const TITLE_PREFIX_RE = /^\(Expira [\d:]+\) /

/** The part of `Document` this helper touches: only the document's existing first <title>. */
export interface TitleDocument {
  querySelector(selector: "title"): { textContent: string | null } | null
}

/**
 * Sets (`prefix`) or clears (`null`) the reservation prefix on the page's existing `<title>`, in place: the document's
 * first one, which is the one `document.title` reads. That is usually in <head>, but Next's streamed metadata can
 * leave it in <body> on a first load. It never creates a <title>: `document.title = …` appends one when there is
 * none (for example while Next swaps the title during a navigation), and that stray element then shadows the page's
 * own title. Whatever the page title is now, only our prefix is added or removed.
 */
export function setTitlePrefix(doc: TitleDocument, prefix: string | null): void {
  const el = doc.querySelector("title")
  if (!el) return
  const current = el.textContent ?? ""
  const base = current.replace(TITLE_PREFIX_RE, "")
  const next = prefix ? prefix + base : base
  if (next !== current) el.textContent = next
}
