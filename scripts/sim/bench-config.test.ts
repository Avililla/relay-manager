import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigExportV1Schema } from "@/lib/contracts/config-io"

const dir = path.resolve(__dirname)
const template = fs.readFileSync(path.join(dir, "bench-config.template.json"), "utf8")
const render = (simDir: string) => template.replaceAll("${SIM_DIR}", simDir)

describe("scripts/sim/bench-config.template.json (shared seed, §10.3)", () => {
  it.each([
    ["XDG_RUNTIME_DIR", "/run/user/1000/relay-manager-sim"],
    ["repo fallback", "/home/dev/relay-manager/.data/sim"],
    ["systemd service", "/run/relay-manager/sim"],
  ])("renders into a valid ConfigExportV1 (%s)", (_label, simDir) => {
    const cfg = ConfigExportV1Schema.parse(JSON.parse(render(simDir)))
    expect(cfg.format).toBe("relay-manager-config")
    expect(JSON.stringify(cfg)).not.toContain("${")
    const paths = cfg.equipment.flatMap((e) => e.consoles.flatMap((c) => (c.binding ? [c.binding.devicePath] : [])))
    expect(paths).toEqual(["ttyV0", "ttyV1", "ttyV2", "ttyV3"].map((n) => `${simDir}/${n}`))
  })

  it("labels each binding the way the app does when it binds a virtual port (\"ttyV0 (virtual)\")", () => {
    const cfg = ConfigExportV1Schema.parse(JSON.parse(render("/run/user/1000/relay-manager-sim")))
    const labels = cfg.equipment.flatMap((e) => e.consoles.flatMap((c) => (c.binding ? [c.binding.adapterLabel] : [])))
    expect(labels).toEqual(["ttyV0", "ttyV1", "ttyV2", "ttyV3"].map((n) => `${n} (virtual)`))
  })

  it("has 2 «Equipo A» units bound by path, 1 «Equipo C» with an unbound console and 0 relays, and the dS378 POWER relay", () => {
    const cfg = ConfigExportV1Schema.parse(JSON.parse(render("/run/user/1000/relay-manager-sim")))
    expect(cfg.equipment.map((e) => e.name)).toEqual(["Equipo A #01", "Equipo A #02", "Equipo C #01"])
    const [a1, a2, c1] = cfg.equipment
    expect(a1?.templateName).toBe("Equipo con 2 consolas")
    expect(a1?.consoles.map((c) => [c.key, c.binding?.matchBy])).toEqual([["UART0", "path"], ["UART1", "path"]])
    expect(a2?.consoles.map((c) => c.key)).toEqual(["UART0", "UART1"])
    expect(a2?.relays).toEqual([])
    expect(c1).toMatchObject({ templateName: null, relays: [] })
    expect(c1?.consoles).toHaveLength(1)
    expect(c1?.consoles[0]?.binding).toBeNull()
    expect(cfg.boards).toEqual([expect.objectContaining({ name: "dS378 banco", driver: "devantech-ds-ascii", host: "127.0.0.2", tcpPort: 17123,
      model: "dS378", relayCount: 8, hasPassword: false })])
    expect(a1?.relays).toEqual([expect.objectContaining({ key: "POWER", purpose: "power", requireConfirm: true, boardName: "dS378 banco", channel: 1 })])
    for (const e of cfg.equipment) for (const r of e.relays) {
      const b = cfg.boards.find((x) => x.name === r.boardName)
      expect(b, r.boardName).toBeTruthy()
      expect(r.channel).toBeLessThanOrEqual(b?.relayCount ?? 0)
    }
  })

  it("matches bench.json: the seeded board is the dS378 simulator entry", () => {
    const bench = JSON.parse(fs.readFileSync(path.join(dir, "bench.json"), "utf8")) as {
      consoles: Array<{ link: string }>; relays: Array<{ model: string; host: string; ascii?: number; http: number; mac: string }>
    }
    const cfg = ConfigExportV1Schema.parse(JSON.parse(render("/run/user/1000/relay-manager-sim")))
    const ds = bench.relays.find((r) => r.model === "dS378")
    expect(ds).toMatchObject({ host: cfg.boards[0]?.host, ascii: cfg.boards[0]?.tcpPort, http: cfg.boards[0]?.httpPort, mac: cfg.boards[0]?.mac })
    expect(bench.consoles.map((c) => c.link)).toEqual(["ttyV0", "ttyV1", "ttyV2", "ttyV3"])
  })
})
