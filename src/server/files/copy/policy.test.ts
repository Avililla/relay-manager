import { describe, expect, it } from "vitest"
import { buildPolicy, DEFAULT_COPY_DENY, denyReason, denyReasonWithAliases, inRoots, normalizeAbs, parsePathList, rootWriteReason, within } from "./policy"

describe("normalizeAbs", () => {
  it("accepts absolute paths and drops repeated and trailing slashes", () => {
    expect(normalizeAbs("/")).toBe("/")
    expect(normalizeAbs("/media/ana/USB DISK/")).toBe("/media/ana/USB DISK")
    expect(normalizeAbs("//mnt///x")).toBe("/mnt/x")
  })
  it.each([["relative"], [""], ["/a/../etc"], ["/a/./b"], ["/a\u0000b"], ["/a\nb"], [`/${"x".repeat(256)}`], [42], [null]])("refuses %j", (p) => {
    expect(normalizeAbs(p)).toBeNull()
  })
})

describe("deny-list and roots (on real paths)", () => {
  const policy = buildPolicy(["/"], ["/srv/privado"], ["/var/lib/relay-manager", "/home/ana/datos-rm", "/opt/relay-manager/releases/2.3.0/app"])

  it("refuses system folders, the app's folders and everything inside them", () => {
    for (const p of ["/etc", "/etc/relay-manager", "/usr/local/bin", "/proc/1", "/sys/class", "/dev/shm", "/boot/efi", "/bin", "/sbin", "/lib64", "/lib/x86_64-linux-gnu",
      "/run", "/run/user/1000", "/var/lib/relay-manager/backups", "/opt/relay-manager/current", "/home/ana/datos-rm/x", "/srv/privado/a"]) {
      expect(denyReason(p, policy), p).not.toBeNull()
    }
    expect(denyReason("/", policy)).toMatch(/raíz/)
    expect(denyReason("/etc/x", policy)).toBe("«/etc» es una carpeta del sistema o de Relay Manager: no se copia ahí.")
  })

  it("allows removable media, manual mounts and ordinary folders", () => {
    for (const p of ["/media/ana/USB", "/run/media/ana/USB", "/mnt", "/mnt/disco", "/srv/compartido", "/home/ana", "/tmp/x", "/var/tmp", "/opt/Xilinx"]) {
      expect(denyReason(p, policy), p).toBeNull()
    }
  })

  it("does not confuse a prefix with a parent folder", () => {
    expect(denyReason("/etcetera", policy)).toBeNull()
    expect(denyReason("/usrdata", policy)).toBeNull()
    expect(denyReason("/run-media", policy)).toBeNull()
    expect(within("/libros", "/lib")).toBe(false)
  })

  it("an explicit denied folder inside /run/media still applies", () => {
    const p = buildPolicy(["/"], ["/run/media/ana/SECRETO"], [])
    expect(denyReason("/run/media/ana/USB", p)).toBeNull()
    expect(denyReason("/run/media/ana/SECRETO/x", p)).not.toBeNull()
  })

  it("RM_COPY_ROOTS limits browsing and writing", () => {
    const p = buildPolicy(["/media", "/srv/banco"], [], [])
    expect(inRoots("/media/ana", p)).toBe(true)
    expect(inRoots("/srv/banco/x", p)).toBe(true)
    expect(inRoots("/home/ana", p)).toBe(false)
    expect(denyReason("/home/ana", p)).toMatch(/RM_COPY_ROOTS/)
    expect(denyReason("/srv/banco/x", p)).toBeNull()
  })

  it("the built-in list cannot be removed and includes the helper's own state", () => {
    expect(DEFAULT_COPY_DENY).toContain("/var/lib/relay-manager-rootcopy")
    expect(buildPolicy([], [], []).roots).toEqual(["/"])
  })

  it("the root helper only writes inside RM_COPY_ROOT_PATHS", () => {
    const paths = ["/media", "/run/media", "/mnt"]
    expect(rootWriteReason("/media/ana/USB", paths)).toBeNull()
    expect(rootWriteReason("/mnt", paths)).toBeNull()
    expect(rootWriteReason("/srv/x", paths)).toBe("Como administrador solo se copia dentro de /media, /run/media o /mnt (RM_COPY_ROOT_PATHS).")
    expect(rootWriteReason("/mediateca", paths)).not.toBeNull()
  })
})

describe("parsePathList", () => {
  it("parses a comma-separated list, deduplicated and normalised", () => {
    expect(parsePathList(" /media, /mnt/ ,/media ", "X")).toEqual(["/media", "/mnt"])
    expect(parsePathList("", "X")).toEqual([])
  })
  it("names the bad entry", () => {
    expect(() => parsePathList("/media,mnt", "RM_COPY_ROOT_PATHS")).toThrow("RM_COPY_ROOT_PATHS: «mnt» no es una ruta absoluta válida")
    expect(() => parsePathList("/a/../etc", "X")).toThrow(/no es una ruta/)
  })
})

describe("root status", () => {
  it("explains each case in Spanish with what to do", async () => {
    const { describeRootStatus } = await import("./root-status")
    const cfg = (mode: "native" | "portable" | "docker" | "dev", enabled = true) => ({ mode, copy: { enabled, roots: ["/"], deny: [], rootPaths: ["/media"], sudoUser: "ana", helperSocket: "/s", testRemovable: null } })
    expect(describeRootStatus(cfg("native", false), null)).toMatchObject({ available: false, problem: expect.stringMatching(/RM_COPY_ENABLED=0/) })
    expect(describeRootStatus(cfg("docker"), null)).toMatchObject({ available: false, problem: expect.stringMatching(/Docker/) })
    expect(describeRootStatus(cfg("portable"), null)).toMatchObject({ available: false, hint: expect.stringMatching(/install\.sh/) })
    expect(describeRootStatus(cfg("native"), new Error("no responde"))).toMatchObject({ available: false, problem: "no responde", hint: expect.stringMatching(/rootcopy\.socket/) })
    const ping = { type: "result" as const, op: "ping" as const, version: "x", enabled: true, mount: { available: true, problem: null }, user: "ingeniero", account: "ok" as const, accountMessage: null, method: "python3", methodError: null, writePaths: ["/media", "/mnt"] }
    expect(describeRootStatus(cfg("native"), ping)).toEqual({ available: true, user: "ingeniero", problem: null, hint: null, writePaths: ["/media", "/mnt"] })
    expect(describeRootStatus(cfg("native"), { ...ping, account: "locked", accountMessage: "La cuenta root no tiene contraseña: …" })).toMatchObject({ available: false, problem: "La cuenta root no tiene contraseña: …", hint: expect.stringMatching(/--sudo-user/) })
    expect(describeRootStatus(cfg("native"), { ...ping, user: "ana", account: "not-sudo", accountMessage: "«ana» no es administrador" }).hint)
      .toBe('Da permisos de administrador a ana: su -c "usermod -aG sudo ana" (con la contraseña de root) y vuelve a iniciar sesión con ana; o, si root tiene contraseña, sudo /opt/relay-manager/current/install.sh --sudo-user root --yes (o --sudo-user <otro usuario con sudo>)')
    expect(describeRootStatus(cfg("native"), { ...ping, user: "a b;x", account: "not-sudo", accountMessage: "x" }).hint).toMatch(/--sudo-user <usuario con sudo>/)
    expect(describeRootStatus(cfg("native"), { ...ping, method: null, methodError: "sin python3 ni perl" })).toMatchObject({ available: false, problem: "sin python3 ni perl" })
  })
  it("mounting: needs «como administrador» and the mount helper", async () => {
    const { describeMountStatus, describeRootStatus } = await import("./root-status")
    const cfg = { mode: "native" as const, copy: { enabled: true, roots: ["/"], deny: [], rootPaths: ["/media"], sudoUser: "ana", helperSocket: "/s", testRemovable: null } }
    const ping = { type: "result" as const, op: "ping" as const, version: "x", enabled: true, mount: { available: true, problem: null }, user: "ana", account: "ok" as const, accountMessage: null, method: "python3", methodError: null, writePaths: ["/media"] }
    expect(describeMountStatus(describeRootStatus(cfg, ping), ping)).toEqual({ available: true, problem: null })
    const off = { ...ping, mount: { available: false, problem: "El ayudante de montaje no responde" } }
    expect(describeMountStatus(describeRootStatus(cfg, off), off)).toEqual({ available: false, problem: "El ayudante de montaje no responde" })
    expect(describeMountStatus(describeRootStatus(cfg, new Error("x")), new Error("x"))).toMatchObject({ available: false, problem: "x" })
    const old = { ...ping, mount: undefined } as unknown as typeof ping
    expect(describeMountStatus(describeRootStatus(cfg, old), old).problem).toMatch(/Actualiza/)
  })
})

describe("denyReasonWithAliases", () => {
  const p = buildPolicy(["/"], [], [])
  it("a folder that is a system folder under another name is refused", () => {
    expect(denyReasonWithAliases("/mnt/etc-bind/ssh", ["/etc/ssh"], p)).toBe("«/etc» es una carpeta del sistema o de Relay Manager: no se copia ahí. (/mnt/etc-bind/ssh es la misma carpeta, montada en otro sitio)")
    expect(denyReasonWithAliases("/mnt/raiz", ["/"], p)).toMatch(/raíz/)
    expect(denyReasonWithAliases("/media/ana/USB", [], p)).toBeNull()
  })
  it("RM_COPY_ROOTS applies only to the real path", () => {
    const r = buildPolicy(["/mnt"], [], [])
    expect(denyReasonWithAliases("/mnt/datos", ["/srv/datos"], r)).toBeNull()
    expect(denyReasonWithAliases("/srv/datos", [], r)).toMatch(/RM_COPY_ROOTS/)
  })
})
