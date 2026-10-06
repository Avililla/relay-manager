// Supervises one child process (hw_server of one JTAG access): start, wait until its port answers, restart with backoff
// after a crash, stop (SIGTERM to its process group, SIGKILL after a grace period). Output goes line by line to onOutput.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import readline from "node:readline"

export type SupervisorPhase = "starting" | "running" | "backoff" | "stopped"
export interface SupervisorState { state: SupervisorPhase; pid: number | null; detail: string | null; retryInMs: number | null }

export interface SupervisorOptions {
  command: { file: string; args: string[]; env: Record<string, string>; cwd: string }
  /** True once the child is usable (hw_server: its TCP port accepts connections). */
  readiness: () => Promise<boolean>
  onState: (s: SupervisorState) => void
  onOutput: (line: string, stream: "stdout" | "stderr") => void
  startTimeoutMs?: number
  backoffMs?: readonly number[]
  /** Running this long resets the backoff. */
  stableMs?: number
  killGraceMs?: number
  pollMs?: number
  spawn?: typeof nodeSpawn
}

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10_000, 30_000] as const

/** Resolves true when something accepts a TCP connection on host:port within timeoutMs. */
export function tcpReady(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (ok: boolean) => {
      s.removeAllListeners()
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.once("connect", () => done(true))
    s.once("error", () => done(false))
  })
}

export class ProcessSupervisor {
  private readonly o: SupervisorOptions
  private child: ChildProcess | null = null
  private wanted = false
  private backoffIdx = 0
  private retryTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private lastLines: string[] = []
  private exited: Promise<void> = Promise.resolve()
  private phase: SupervisorPhase = "stopped"

  constructor(o: SupervisorOptions) {
    this.o = o
  }

  get pid(): number | null { return this.child?.pid ?? null }
  get state(): SupervisorPhase { return this.phase }
  /** The last lines of output (stdout and stderr), newest last. */
  get output(): readonly string[] { return this.lastLines }

  start(): void {
    if (this.wanted) return
    this.wanted = true
    this.backoffIdx = 0
    this.launch()
  }

  async stop(): Promise<void> {
    this.wanted = false
    this.clearTimers()
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      this.kill(child, "SIGTERM")
      const t = setTimeout(() => this.kill(child, "SIGKILL"), this.o.killGraceMs ?? 3000)
      t.unref()
      await this.exited
      clearTimeout(t)
    }
    this.child = null
    this.set("stopped", null, null)
  }

  private set(state: SupervisorPhase, detail: string | null, retryInMs: number | null): void {
    this.phase = state
    this.o.onState({ state, pid: this.child?.pid ?? null, detail, retryInMs })
  }

  private kill(child: ChildProcess, sig: NodeJS.Signals): void {
    if (!child.pid) return
    try {
      process.kill(-child.pid, sig) // the whole group: the Xilinx wrapper script and the real binary
    } catch {
      try { child.kill(sig) } catch { /* already gone */ }
    }
  }

  private remember(line: string, stream: "stdout" | "stderr"): void {
    const l = line.replace(/\s+$/, "")
    if (!l) return
    this.lastLines.push(l)
    if (this.lastLines.length > 50) this.lastLines.shift()
    this.o.onOutput(l, stream)
  }

  private clearTimers(): void {
    for (const t of [this.retryTimer, this.stableTimer, this.readyTimer]) if (t) clearTimeout(t)
    this.retryTimer = this.stableTimer = this.readyTimer = null
  }

  private launch(): void {
    if (!this.wanted) return
    this.clearTimers()
    this.lastLines = []
    let child: ChildProcess
    const spawn = this.o.spawn ?? nodeSpawn
    try {
      child = spawn(this.o.command.file, this.o.command.args, {
        // Next's type augmentation makes NODE_ENV required in ProcessEnv; the child's minimal env deliberately has none.
        cwd: this.o.command.cwd, env: this.o.command.env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      this.failed(`No se puede arrancar: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    this.child = child
    let resolveExit: () => void = () => {}
    this.exited = new Promise((r) => { resolveExit = r })
    let spawnError: Error | null = null
    child.once("error", (err) => { spawnError = err })
    if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", (l) => this.remember(l, "stdout"))
    if (child.stderr) readline.createInterface({ input: child.stderr }).on("line", (l) => this.remember(l, "stderr"))
    child.once("close", (code, signal) => {
      resolveExit()
      if (this.child !== child) return
      this.child = null
      this.clearTimers()
      if (!this.wanted) return
      const e = spawnError as (Error & { code?: string }) | null
      const cause = e
        ? e.code === "ENOENT" ? `no existe ${this.o.command.file} (ENOENT)` : `${e.code ?? ""} ${e.message}`.trim()
        : `terminó (${signal ? `señal ${signal}` : `código ${code ?? "?"}`})`
      const last = this.lastLines.at(-1)
      this.failed(last && !e ? `${cause}: ${last}` : cause)
    })
    this.set("starting", null, null)
    const started = Date.now()
    const poll = () => {
      this.readyTimer = null
      if (this.child !== child || !this.wanted) return
      void this.o.readiness().then((ok) => {
        if (this.child !== child || !this.wanted) return
        if (ok) {
          this.set("running", null, null)
          this.stableTimer = setTimeout(() => { this.backoffIdx = 0 }, this.o.stableMs ?? 60_000)
          this.stableTimer.unref()
          return
        }
        if (Date.now() - started > (this.o.startTimeoutMs ?? 60_000)) {
          this.remember(`no escucha tras ${Math.round((this.o.startTimeoutMs ?? 60_000) / 1000)} s`, "stderr")
          this.kill(child, "SIGKILL")
          return
        }
        this.readyTimer = setTimeout(poll, this.o.pollMs ?? 250)
        this.readyTimer.unref()
      })
    }
    this.readyTimer = setTimeout(poll, this.o.pollMs ?? 250)
    this.readyTimer.unref()
  }

  private failed(detail: string): void {
    const backoff = this.o.backoffMs ?? DEFAULT_BACKOFF
    const delay = backoff[Math.min(this.backoffIdx, backoff.length - 1)]
    this.backoffIdx++
    this.set("backoff", detail, delay)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.launch()
    }, delay)
    this.retryTimer.unref()
  }
}
