import net from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { ProcessSupervisor, type SupervisorState, tcpReady } from "./supervisor"

const sups: ProcessSupervisor[] = []
afterEach(async () => { for (const s of sups.splice(0)) await s.stop() })

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}
const listenScript = (port: number, delayMs = 0) =>
  `setTimeout(() => { require("net").createServer((c) => c.end("hola\\n")).listen(${port}, "127.0.0.1", () => console.log("escuchando ${port}")) }, ${delayMs})`

function make(args: string[], opts: Partial<ConstructorParameters<typeof ProcessSupervisor>[0]> & { port?: number } = {}) {
  const states: SupervisorState[] = []
  const lines: string[] = []
  const s = new ProcessSupervisor({
    command: { file: process.execPath, args, env: { PATH: process.env.PATH ?? "" }, cwd: process.cwd() },
    readiness: opts.port ? () => tcpReady("127.0.0.1", opts.port ?? 0) : async () => true,
    startTimeoutMs: 5000, backoffMs: [100, 200], killGraceMs: 500, pollMs: 50,
    onState: (st) => states.push(st),
    onOutput: (line) => lines.push(line),
    ...opts,
  })
  sups.push(s)
  return { s, states, lines }
}
const waitUntil = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout")
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("ProcessSupervisor", () => {
  it("starting → running once the port answers; captures output; stop kills it", async () => {
    const port = await freePort()
    const { s, states, lines } = make(["-e", listenScript(port, 150)], { port })
    s.start()
    await waitUntil(() => states.some((x) => x.state === "running"))
    expect(states[0].state).toBe("starting")
    expect(states.find((x) => x.state === "running")?.pid).toBeGreaterThan(0)
    await waitUntil(() => lines.includes(`escuchando ${port}`))
    await s.stop()
    expect(states.at(-1)?.state).toBe("stopped")
    expect(await tcpReady("127.0.0.1", port)).toBe(false)
  })

  it("restarts with backoff after a crash and reports the exit and the last line", async () => {
    const { s, states } = make(["-e", "console.error('se acabó'); process.exit(3)"])
    s.start()
    await waitUntil(() => states.filter((x) => x.state === "backoff").length >= 2)
    const b = states.find((x) => x.state === "backoff")
    expect(b?.detail).toMatch(/3/)
    expect(b?.detail).toMatch(/se acabó/)
    await s.stop()
    expect(states.at(-1)?.state).toBe("stopped")
  })

  it("a spawn failure (missing file) goes to backoff with the cause", async () => {
    const states: SupervisorState[] = []
    const s = new ProcessSupervisor({
      command: { file: "/no/existe/hw_server", args: [], env: {}, cwd: "/" },
      readiness: async () => true, backoffMs: [5000], onState: (x) => states.push(x), onOutput: () => {},
    })
    sups.push(s)
    s.start()
    await waitUntil(() => states.some((x) => x.state === "backoff"))
    expect(states.find((x) => x.state === "backoff")?.detail).toMatch(/ENOENT|no existe/)
  })

  it("never listening within the start timeout counts as a failure", async () => {
    const port = await freePort()
    const { s, states } = make(["-e", "setInterval(() => {}, 1000)"], { port, startTimeoutMs: 300 })
    s.start()
    await waitUntil(() => states.some((x) => x.state === "backoff"))
    expect(states.find((x) => x.state === "backoff")?.detail).toMatch(/no escucha/)
  })
})
