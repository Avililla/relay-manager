import { describe, expect, it } from "vitest"
import { accessCommands, accessAddress } from "./commands"

describe("accessAddress", () => {
  it("joins host and port, with brackets for IPv6", () => {
    expect(accessAddress("192.0.2.97", 3201)).toBe("192.0.2.97:3201")
    expect(accessAddress("fe80::1", 3201)).toBe("[fe80::1]:3201")
  })
})

describe("accessCommands", () => {
  it("JTAG: xsdb/xsct connect first, then the Vivado remote server", () => {
    const c = accessCommands({ kind: "jtag", port: 3201, targetPort: null }, "192.0.2.97")
    expect(c[0]).toEqual({ id: "xsdb", command: "connect -host 192.0.2.97 -port 3201" })
    // Vivado Tcl console (the GUI "Open New Target > Remote server" takes the address shown above).
    expect(c[1]).toEqual({ id: "vivado", command: "connect_hw_server -url 192.0.2.97:3201" })
  })
  it("serial: nc first, telnet second", () => {
    const c = accessCommands({ kind: "serial", port: 3203, targetPort: null }, "banco")
    expect(c.map((x) => x.command)).toEqual(["nc banco 3203", "telnet banco 3203"])
  })
  it("Ethernet to port 22: ssh and scp", () => {
    const c = accessCommands({ kind: "tcp", port: 3205, targetPort: 22 }, "192.0.2.97", "root")
    expect(c.map((x) => x.command)).toEqual(["ssh -p 3205 root@192.0.2.97", "scp -P 3205 <fichero> root@192.0.2.97:"])
  })
  it("Ethernet: the SSH user of the access (root when unset)", () => {
    expect(accessCommands({ kind: "tcp", port: 3206, targetPort: 22, sshUser: "petalinux" }, "banco")[0].command).toBe("ssh -p 3206 petalinux@banco")
    expect(accessCommands({ kind: "tcp", port: 3206, targetPort: 22, sshUser: null }, "banco")[0].command).toBe("ssh -p 3206 root@banco")
  })
  it("Ethernet to another port: the address", () => {
    const c = accessCommands({ kind: "tcp", port: 3205, targetPort: 80 }, "192.0.2.97")
    expect(c.map((x) => x.command)).toEqual(["192.0.2.97:3205"])
  })
})
