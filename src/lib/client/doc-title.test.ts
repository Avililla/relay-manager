import { describe, expect, it } from "vitest"
import { setTitlePrefix, type TitleDocument } from "./doc-title"

/** A document with zero or more <title> elements; appending anything throws (the helper must never create nodes). */
function fakeDoc(titles: string[]) {
  const els = titles.map((t) => ({ textContent: t as string | null }))
  const doc: TitleDocument & { els: typeof els; appendChild(): never } = {
    els,
    querySelector: (sel: string) => (sel === "title" ? els[0] ?? null : null),
    appendChild: () => { throw new Error("no se deben crear elementos <title>") },
  }
  return doc
}

describe("reservation prefix on the page title (ReservationExpiryChip)", () => {
  it("updates the existing <title> in place and restores it on clear", () => {
    const d = fakeDoc(["Banco · Lab"])
    setTitlePrefix(d, "(Expira 4:59) ")
    expect(d.els[0]?.textContent).toBe("(Expira 4:59) Banco · Lab")
    setTitlePrefix(d, "(Expira 4:58) ")
    expect(d.els[0]?.textContent).toBe("(Expira 4:58) Banco · Lab")
    setTitlePrefix(d, null)
    expect(d.els[0]?.textContent).toBe("Banco · Lab")
  })

  it("never creates a <title> when the page has none (e.g. mid-navigation)", () => {
    const d = fakeDoc([])
    expect(() => setTitlePrefix(d, "(Expira 0:30) ")).not.toThrow()
    expect(() => setTitlePrefix(d, null)).not.toThrow()
    expect(d.els).toHaveLength(0)
  })

  it("a page title that changed meanwhile keeps its new text: clearing only strips the prefix", () => {
    const d = fakeDoc(["Banco · Lab"])
    setTitlePrefix(d, "(Expira 1:00) ")
    const el = d.els[0]
    if (el) el.textContent = "Plantillas · Lab" // Next rendered the next page's title
    setTitlePrefix(d, "(Expira 0:59) ")
    expect(el?.textContent).toBe("(Expira 0:59) Plantillas · Lab")
    setTitlePrefix(d, null)
    expect(el?.textContent).toBe("Plantillas · Lab")
  })

  it("uses the document's first <title> wherever it is: streamed metadata can put it in <body> (document.title reads that one)", () => {
    const title = { textContent: "Equipo A #02 · Laboratorio" as string | null }
    const doc: TitleDocument = { querySelector: (sel) => (sel === "title" ? title : null) }
    setTitlePrefix(doc, "(Expira 1:58) ")
    expect(title.textContent).toBe("(Expira 1:58) Equipo A #02 · Laboratorio")
  })
})
