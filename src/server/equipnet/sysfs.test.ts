import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { plugAdapter, setCarrier, unplugAdapter } from "../../../scripts/sim/fake-net-adapter.mjs"
import { scanNetInterfaces } from "./sysfs"

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "rm-net-")); dirs.push(d); return d }

describe("scanNetInterfaces", () => {
  it("USB adapter with its descriptors, a PCI NIC, no virtual interfaces", async () => {
    const root = tmp()
    plugAdapter(root, { ifname: "enxfake0", mac: "02:00:00:00:00:01" })
    plugAdapter(root, { ifname: "enp3s0", mac: "2c:58:b9:d1:c6:57", pci: true })
    fs.mkdirSync(path.join(root, "devices", "virtual", "net", "docker0"), { recursive: true })
    fs.writeFileSync(path.join(root, "devices", "virtual", "net", "docker0", "address"), "02:42:ad:7d:17:ab\n")
    fs.symlinkSync(path.join(root, "devices", "virtual", "net", "docker0"), path.join(root, "class", "net", "docker0"))
    const list = await scanNetInterfaces(root)
    expect(list.map((x) => x.ifname)).toEqual(["enxfake0", "enp3s0"])
    expect(list[0]).toMatchObject({ usb: true, bus: "usb", driver: "cdc_ncm", vendorId: "0b95", productId: "1790", manufacturer: "ASIX", product: "AX88179A", location: "USB 2-7", carrier: true, speedMbps: 1000 })
    expect(list[1]).toMatchObject({ usb: false, bus: "pci", driver: "r8169", vendorId: null })
    setCarrier(root, "enxfake0", false)
    expect((await scanNetInterfaces(root))[0]).toMatchObject({ carrier: false, operUp: false })
    unplugAdapter(root, "enxfake0")
    expect((await scanNetInterfaces(root)).map((x) => x.ifname)).toEqual(["enp3s0"])
  })
  it("reads the real /sys/class/net without failing", async () => {
    const list = await scanNetInterfaces("/sys")
    expect(Array.isArray(list)).toBe(true)
  })
})
