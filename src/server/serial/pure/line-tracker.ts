// Last printable line of a console (ANSI stripped, ≤ 160 chars) for `lastLine` and `console.activity` (§4.5).
import { StringDecoder } from "node:string_decoder"

const MAX = 160
type State = "text" | "esc" | "csi" | "osc" | "osc-esc"

export class LineTracker {
  private readonly decoder = new StringDecoder("utf8")
  private state: State = "text"
  private current = ""
  private lastComplete: string | null = null

  push(chunk: Buffer): void {
    const s = this.decoder.write(chunk)
    for (const ch of s) this.feed(ch)
  }

  /** The current partial line when it has text (a prompt), otherwise the last complete non-empty line. */
  lastLine(): string | null {
    const cur = this.current.trim()
    return cur ? cur.slice(-MAX) : this.lastComplete
  }

  reset(): void {
    this.current = ""
    this.lastComplete = null
    this.state = "text"
  }

  private feed(ch: string): void {
    const c = ch.codePointAt(0) ?? 0
    switch (this.state) {
      case "esc":
        this.state = ch === "[" ? "csi" : ch === "]" ? "osc" : "text"
        return
      case "csi":
        if (c >= 0x40 && c <= 0x7e) this.state = "text"
        return
      case "osc":
        if (c === 0x07) this.state = "text"
        else if (c === 0x1b) this.state = "osc-esc"
        return
      case "osc-esc":
        this.state = ch === "\\" ? "text" : "osc"
        return
      default:
        break
    }
    if (c === 0x1b) { this.state = "esc"; return }
    if (ch === "\n") {
      const done = this.current.trim()
      if (done) this.lastComplete = done.slice(-MAX)
      this.current = ""
      return
    }
    if (ch === "\r") {
      // CR returns to the start of the line: what follows overwrites it (countdowns, spinners).
      const done = this.current.trim()
      if (done) this.lastComplete = done.slice(-MAX)
      this.current = ""
      return
    }
    if (ch === "\t") { this.current += " "; return }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) return
    if (ch === "\b") return
    this.current += ch
    if (this.current.length > 4 * MAX) this.current = this.current.slice(-2 * MAX)
  }
}
