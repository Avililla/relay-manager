// W0 (§5.8, §11.3): in dev, Next's HMR socket still upgrades next to our /ws/* router, and /ws/console/x without a
// cookie is accepted and closed with 4001. Slow (starts a real dev server): runs only with RM_TEST_DEV=1.
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"

const ROOT = path.resolve(__dirname, "../..")
const enabled = process.env.RM_TEST_DEV === "1"

describe.skipIf(!enabled)("dev server: HMR and /ws/* coexist", () => {
  let child: ChildProcess
  let port = 0
  let dataDir = ""
  let output = ""

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rm-hmr-"))
    child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      cwd: ROOT,
      env: { ...process.env, RM_DEV: "1", RM_PORT: "0", RM_HOST: "127.0.0.1", RM_DATA_DIR: dataDir, RM_FILES_DIR: path.join(dataDir, "..", "tftp"), RM_NEXT_DIST_DIR: ".next-hmrtest", RM_LOG_LEVEL: "info" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    port = await new Promise<number>((resolve, reject) => {
      const onData = (c: Buffer) => {
        output += c.toString()
        const m = /Servidor escuchando .*puerto=(\d+)/.exec(output)
        if (m) resolve(Number(m[1]))
      }
      child.stdout?.on("data", onData)
      child.stderr?.on("data", onData)
      child.on("exit", (code) => reject(new Error(`dev server exited ${code}\n${output}`)))
    })
    // Compile a page once so the HMR server is fully up.
    await fetch(`http://127.0.0.1:${port}/login`).then((r) => r.text())
  }, 180_000)

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.on("exit", resolve))
      child.kill("SIGTERM")
      await exited
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }, 30_000)

  it("the HMR socket upgrades and reports turbopack-connected", async () => {
    const types: string[] = []
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/_next/webpack-hmr?id=vitest`, { headers: { origin: `http://127.0.0.1:${port}` } })
      ws.on("message", (m) => {
        try { types.push(String((JSON.parse(String(m)) as { type?: unknown }).type)) } catch { types.push("?") }
        if (types.includes("turbopack-connected")) { ws.close(); resolve(true) }
      })
      ws.on("error", () => resolve(false))
      setTimeout(() => { ws.terminate(); resolve(false) }, 30_000)
    })
    expect(opened, `HMR messages: ${types.join(",")}`).toBe(true)
  }, 60_000)

  it("/ws/console/x without a cookie closes with 4001", async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/console/x`, { headers: { origin: `http://127.0.0.1:${port}` } })
      ws.on("close", (c) => resolve(c))
      ws.on("error", () => {})
    })
    expect(code).toBe(4001)
  }, 30_000)
})
