import { describe, expect, it } from "vitest"
import { compareVersions, findHwServer, hwServerArgs, hwServerFilter, isValidFilterFormat, parseHwServerVersion, type HwServerFs } from "./hw-server"

function memFs(files: string[], links: Record<string, string> = {}): HwServerFs {
  const set = new Set(files)
  return {
    isExecutable: (p) => set.has(p),
    exists: (p) => set.has(p),
    readdir: (dir) => {
      const out = new Set<string>()
      for (const f of set) if (f.startsWith(dir + "/")) out.add(f.slice(dir.length + 1).split("/")[0])
      return out.size ? [...out] : null
    },
    realpath: (p) => links[p] ?? p,
  }
}

describe("findHwServer", () => {
  it("RM_HW_SERVER wins and is reported as config; a missing one is a clear problem", () => {
    expect(findHwServer({ explicit: "/x/hw_server", env: {}, home: null, fs: memFs(["/x/hw_server"]) })).toEqual({
      path: "/x/hw_server", version: null, source: "config", problem: null,
    })
    const r = findHwServer({ explicit: "/x/hw_server", env: {}, home: null, fs: memFs(["/tools/Xilinx/Vivado/2024.2/bin/hw_server"]) })
    expect(r.path).toBeNull()
    expect(r.problem).toMatch(/RM_HW_SERVER.*\/x\/hw_server/)
  })
  it("accepts a Node script as RM_HW_SERVER (the simulator)", () => {
    const r = findHwServer({ explicit: "/repo/scripts/sim/fake-hw-server.mjs", env: {}, home: null, fs: memFs([]) , nodeScriptExists: (p) => p.endsWith(".mjs") })
    expect(r).toMatchObject({ path: "/repo/scripts/sim/fake-hw-server.mjs", source: "config", problem: null })
  })
  it("looks at XSCT, VITIS, XILINX_VITIS and XILINX_VIVADO before PATH", () => {
    const fs = memFs(["/v/2023.2/bin/hw_server", "/usr/local/bin/hw_server", "/xs/bin/hw_server"])
    expect(findHwServer({ explicit: null, env: { XILINX_VIVADO: "/v/2023.2", PATH: "/usr/local/bin" }, home: null, fs }).path).toBe("/v/2023.2/bin/hw_server")
    expect(findHwServer({ explicit: null, env: { XSCT: "/xs/bin/xsct" }, home: null, fs }).path).toBe("/xs/bin/hw_server")
    expect(findHwServer({ explicit: null, env: { PATH: "/usr/bin:/usr/local/bin" }, home: null, fs })).toMatchObject({ path: "/usr/local/bin/hw_server", source: "path" })
  })
  it("scans the usual install folders (both layouts) and keeps the newest version", () => {
    const fs = memFs([
      "/tools/Xilinx/Vivado/2022.1/bin/hw_server",
      "/opt/Xilinx/Vivado_Lab/2023.2/bin/hw_server",
      "/opt/Xilinx/2025.1/Vitis/bin/hw_server",
      "/home/u/Xilinx/HWSRVR/2024.2/bin/hw_server",
    ])
    const r = findHwServer({ explicit: null, env: {}, home: "/home/u", fs })
    expect(r).toEqual({ path: "/opt/Xilinx/2025.1/Vitis/bin/hw_server", version: "2025.1", source: "install", problem: null })
  })
  it("nothing found: a problem that says what to install or set", () => {
    const r = findHwServer({ explicit: null, env: {}, home: null, fs: memFs([]) })
    expect(r.path).toBeNull()
    expect(r.problem).toMatch(/Vivado Lab|RM_HW_SERVER/)
  })
})

describe("versions", () => {
  it("compares and parses", () => {
    expect(compareVersions("2024.2", "2024.10")).toBeLessThan(0)
    expect(compareVersions("2025.1", "2024.2")).toBeGreaterThan(0)
    expect(parseHwServerVersion("****** Xilinx hw_server v2024.2\n  **** Build date")).toBe("2024.2")
    expect(parseHwServerVersion("****** AMD hw_server v2025.1.0")).toBe("2025.1.0")
    expect(parseHwServerVersion("nada")).toBeNull()
  })
})

describe("hwServerArgs", () => {
  it("listens on the access port, disables the GDB ports and filters the cable by serial", () => {
    expect(hwServerArgs({ bind: "0.0.0.0", port: 3201, cableSerial: "210299A1B2C3" })).toEqual(["-s", "tcp::3201", "-p0", "-e", "set jtag-port-filter 210299A1B2C3"])
    expect(hwServerArgs({ bind: "192.0.2.97", port: 3202, cableSerial: "000013ca3a2001" })).toEqual(["-s", "tcp:192.0.2.97:3202", "-p0", "-e", "set jtag-port-filter 000013ca3a2001"])
  })
  it("RM_HW_SERVER_FILTER_FORMAT: {serial} and {vendor} (the hw_server target prefix: Digilent or Xilinx)", () => {
    expect(hwServerFilter("{serial}", { serial: "210299A1B2C3", family: "digilent" })).toBe("210299A1B2C3")
    expect(hwServerFilter("{vendor}/{serial}", { serial: "210299A1B2C3", family: "digilent" })).toBe("Digilent/210299A1B2C3")
    expect(hwServerFilter("{vendor}/{serial}", { serial: "000013ca3a2001", family: "xilinx" })).toBe("Xilinx/000013ca3a2001")
    expect(hwServerFilter("{vendor}/{serial}", { serial: "210251A0B1C2", family: "ftdi" })).toBe("Digilent/210251A0B1C2")
    expect(hwServerFilter("{serial},{vendor}/{serial}", { serial: "210299A1B2C3", family: null })).toBe("210299A1B2C3,Digilent/210299A1B2C3")
    expect(hwServerArgs({ bind: "0.0.0.0", port: 3201, cableSerial: "210299A1B2C3", filter: "Digilent/210299A1B2C3" })).toEqual(["-s", "tcp::3201", "-p0", "-e", "set jtag-port-filter Digilent/210299A1B2C3"])
    expect(isValidFilterFormat("{serial}")).toBe(true)
    expect(isValidFilterFormat("Xilinx/DLC10/{serial}")).toBe(true)
    expect(isValidFilterFormat("Digilent/")).toBe(false)
    expect(isValidFilterFormat("{serial};exit")).toBe(false)
  })
})
