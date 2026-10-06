// CLI input/output: the process streams in production, an in-memory buffer in tests.

export interface CliIO {
  out(text: string): void
  err(text: string): void
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  /** Whole stdin as text (for --password-stdin and piped answers). */
  readStdin(): Promise<string>
  /** Asks on the terminal; `hidden` disables the echo (passwords). */
  prompt(question: string, hidden: boolean): Promise<string>
}

export function processIO(): CliIO {
  return {
    out: (t) => { process.stdout.write(t) },
    err: (t) => { process.stderr.write(t) },
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    readStdin: () => new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      process.stdin.on("data", (c: Buffer) => chunks.push(c))
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      process.stdin.on("error", reject)
    }),
    prompt: (question, hidden) => new Promise((resolve, reject) => {
      const stdin = process.stdin
      process.stderr.write(question)
      const raw = stdin.isTTY === true && hidden
      if (raw) stdin.setRawMode(true)
      stdin.setEncoding("utf8")
      stdin.resume()
      let buf = ""
      const done = (err: Error | null) => {
        stdin.off("data", onData)
        if (raw) stdin.setRawMode(false)
        stdin.pause()
        if (hidden) process.stderr.write("\n")
        if (err) reject(err)
        else resolve(buf)
      }
      const onData = (s: string) => {
        for (const ch of s) {
          if (ch === "\r" || ch === "\n") return done(null)
          if (ch === "\u0003" || ch === "\u0004") return done(new Error("Cancelado"))
          if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1)
          else buf += ch
        }
      }
      stdin.on("data", onData)
    }),
  }
}

export interface BufferIO extends CliIO {
  readonly stdout: string
  readonly stderr: string
  readonly prompts: Array<{ q: string; hidden: boolean }>
}

/** For tests: captures output; `answers` are returned by prompt() in order. */
export function bufferIO(opts: { stdin?: string; tty?: boolean; answers?: string[] } = {}): BufferIO {
  let stdout = ""
  let stderr = ""
  const prompts: Array<{ q: string; hidden: boolean }> = []
  const answers = [...(opts.answers ?? [])]
  return {
    get stdout() { return stdout },
    get stderr() { return stderr },
    prompts,
    out: (t) => { stdout += t },
    err: (t) => { stderr += t },
    stdinIsTTY: opts.tty === true,
    stdoutIsTTY: false,
    readStdin: async () => opts.stdin ?? "",
    prompt: async (q, hidden) => {
      prompts.push({ q, hidden })
      return answers.shift() ?? ""
    },
  }
}
