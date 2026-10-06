// hw_server: where it is (like BITReader_Tool's launcher: RM_HW_SERVER, XSCT/VITIS/XILINX_VITIS/XILINX_VIVADO, PATH, then
// /tools/Xilinx, /opt/Xilinx, ~/Xilinx and the AMDDesignTools folders, newest version) and how it is started for one
// access: `hw_server -s tcp:<bind>:<port> -p0 -e "set jtag-port-filter <serial>"`.
import fs from "node:fs"
import path from "node:path"
import type { HwServerInfoDTO, JtagCableFamily } from "@/lib/contracts/accesses"

export interface HwServerFs {
  isExecutable(p: string): boolean
  exists(p: string): boolean
  readdir(dir: string): string[] | null
  realpath(p: string): string
}

export function nodeHwServerFs(): HwServerFs {
  return {
    isExecutable(p) {
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    },
    exists: (p) => fs.existsSync(p),
    readdir(dir) {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name)
      } catch {
        return null
      }
    },
    realpath(p) {
      try { return fs.realpathSync(p) } catch { return p }
    },
  }
}

const VERSION = /(\d{4}\.\d+(?:\.\d+)?)/

/** Numeric, part by part: "2024.10" > "2024.2". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** "****** Xilinx hw_server v2024.2" → "2024.2" (hw_server prints it on start). */
export function parseHwServerVersion(text: string): string | null {
  const m = /hw_server\s+v?(\d{4}\.\d+(?:\.\d+)?)/i.exec(text)
  return m ? m[1] : null
}

export const isNodeScript = (p: string) => /\.(mjs|cjs|js)$/.test(p)
const PRODUCTS = ["Vivado_Lab", "Vivado", "Vitis", "HWSRVR"] as const
export const MISSING_HW_SERVER = "No se encuentra hw_server. Instala Vivado Lab (o Vivado/Vitis) en /tools/Xilinx u /opt/Xilinx, o indica su ruta en RM_HW_SERVER."

export interface FindOptions {
  explicit: string | null
  env: Record<string, string | undefined>
  home: string | null
  fs: HwServerFs
  /** RM_HW_SERVER may be a Node script (the simulator): it only has to exist. */
  nodeScriptExists?: (p: string) => boolean
}

export function findHwServer(o: FindOptions): HwServerInfoDTO {
  const found = (p: string, source: HwServerInfoDTO["source"]): HwServerInfoDTO =>
    ({ path: p, version: VERSION.exec(p)?.[1] ?? null, source, problem: null })

  if (o.explicit) {
    const script = isNodeScript(o.explicit) && (o.nodeScriptExists ?? o.fs.exists)(o.explicit)
    if (script || o.fs.isExecutable(o.explicit)) return found(o.explicit, "config")
    return { path: null, version: null, source: null, problem: `RM_HW_SERVER apunta a ${o.explicit}, que no existe o no es ejecutable.` }
  }

  const xsct = o.env.XSCT
  if (xsct) {
    const p = path.join(path.dirname(o.fs.realpath(xsct)), "hw_server")
    if (o.fs.isExecutable(p)) return found(p, "env")
  }
  for (const v of ["VITIS", "XILINX_VITIS", "XILINX_VIVADO", "XILINX_HW_SERVER"]) {
    const dir = o.env[v]
    if (!dir) continue
    const p = path.join(dir, "bin", "hw_server")
    if (o.fs.isExecutable(p)) return found(p, "env")
  }
  for (const dir of (o.env.PATH ?? "").split(":").filter(Boolean)) {
    const p = path.join(dir, "hw_server")
    if (o.fs.isExecutable(p)) return found(p, "path")
  }

  const roots = ["/tools/Xilinx", "/opt/Xilinx", "/tools/AMDDesignTools", "/opt/AMDDesignTools"]
  if (o.home) roots.splice(2, 0, path.join(o.home, "Xilinx"))
  if (o.home) roots.push(path.join(o.home, "AMDDesignTools"))
  const best = { p: "", v: "" }
  const consider = (p: string, v: string) => {
    if (!VERSION.test(v) || !o.fs.isExecutable(p)) return
    if (!best.p || compareVersions(v, best.v) > 0) Object.assign(best, { p, v })
  }
  for (const root of roots) {
    for (const product of PRODUCTS) {
      for (const ver of o.fs.readdir(path.join(root, product)) ?? []) consider(path.join(root, product, ver, "bin", "hw_server"), ver)
    }
    // Since 2025: <root>/<version>/<product>/bin/hw_server
    for (const ver of o.fs.readdir(root) ?? []) {
      for (const product of PRODUCTS) consider(path.join(root, ver, product, "bin", "hw_server"), ver)
    }
  }
  if (best.p) return { path: best.p, version: best.v, source: "install", problem: null }
  return { path: null, version: null, source: null, problem: MISSING_HW_SERVER }
}

/**
 * The jtag-port-filter value (UG908 "Advanced Options": a comma separated list of complete or partial port identifiers;
 * hw_server names targets "Digilent/<serial>" and "Xilinx/<serial>"). RM_HW_SERVER_FILTER_FORMAT, default "{serial}":
 * the plain serial, a partial identifier (Digilent documents `set jtag-port-filter 210205,210249`). `{vendor}` is
 * "Xilinx" for Platform Cables (03fd) and "Digilent" otherwise.
 */
export function hwServerFilter(format: string, cable: { serial: string; family: JtagCableFamily | null }): string {
  const vendor = cable.family === "xilinx" ? "Xilinx" : "Digilent"
  return format.replaceAll("{serial}", cable.serial).replaceAll("{vendor}", vendor)
}

/** A filter format hw_server can take as one -e argument: must name the serial; no spaces, quotes or Tcl separators. */
export function isValidFilterFormat(format: string): boolean {
  if (!format.includes("{serial}")) return false
  const rest = format.replaceAll("{serial}", "").replaceAll("{vendor}", "")
  return /^[A-Za-z0-9/._:,*-]*$/.test(rest)
}

/** The command line of one JTAG access (argv, no shell): -p0 turns off the GDB server ports (3000-3005). */
export function hwServerArgs(o: { bind: string; port: number; cableSerial: string; filter?: string }): string[] {
  const host = o.bind === "0.0.0.0" || o.bind === "::" ? "" : o.bind
  return ["-s", `tcp:${host}:${o.port}`, "-p0", "-e", `set jtag-port-filter ${o.filter ?? o.cableSerial}`]
}
