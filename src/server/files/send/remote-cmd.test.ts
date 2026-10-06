import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { withTempDir } from "../../../../test/helpers"
import { parseChecksum, parseDfFree, remoteCmd, shq } from "./remote-cmd"

const sh = (cmd: string, cwd?: string) => execFileSync("sh", ["-c", cmd], { encoding: "utf8", cwd })

describe("órdenes en el equipo: sin inyección", () => {
  it("shq: una sola palabra, nada se expande (probado con sh)", () => {
    for (const s of ["/tmp/x", "/tmp/it's", "/tmp/$(touch pwned)", "/tmp/`id`", "/tmp/a b\tc", "/tmp/;rm -rf ~", "/tmp/\"q\"", "/tmp/ñandú", "/tmp/\\n"]) {
      expect(sh(`printf '%s' ${shq(s)}`)).toBe(s)
    }
    expect(() => shq("a\0b")).toThrow()
  })

  it("las órdenes solo aceptan rutas absolutas (nunca se toman por opciones)", () => {
    expect(() => remoteCmd.remove("-rf /")).toThrow()
    expect(() => remoteCmd.scpSink("tmp")).toThrow()
    expect(remoteCmd.scpSink("/root/my dir")).toBe("scp -t '/root/my dir'")
    expect(remoteCmd.commit("/r/.t", "/r/it's", 0o755)).toBe("chmod 755 '/r/.t' && mv -f '/r/.t' '/r/it'\\''s'")
    expect(remoteCmd.checksum("sha256", "/x")).toBe("sha256sum '/x'")
  })

  it("probe con sh real: dir, file, missing, noparent; y una ruta maliciosa no ejecuta nada", () => {
    const t = withTempDir("rm-cmd-")
    try {
      fs.mkdirSync(path.join(t.dir, "d"))
      fs.writeFileSync(path.join(t.dir, "f"), "x")
      const probe = (p: string) => sh(remoteCmd.probe(p, path.dirname(p))).trim()
      expect(probe(path.join(t.dir, "d"))).toBe("dir")
      expect(probe(path.join(t.dir, "f"))).toBe("file")
      expect(probe(path.join(t.dir, "nuevo"))).toBe("missing")
      expect(probe(path.join(t.dir, "no", "x"))).toBe("noparent")
      const evil = path.join(t.dir, "$(touch pwned)'; touch pwned2; '")
      expect(probe(evil)).toBe("missing")
      sh(remoteCmd.remove(evil), t.dir)
      expect(fs.existsSync(path.join(t.dir, "pwned")) || fs.existsSync(path.join(t.dir, "pwned2"))).toBe(false)
      fs.writeFileSync(path.join(t.dir, ".tmp"), "abc")
      sh(remoteCmd.commit(path.join(t.dir, ".tmp"), evil, 0o644))
      expect(fs.readFileSync(evil, "utf8")).toBe("abc")
      expect(sh(remoteCmd.size(evil)).trim()).toBe("3")
      expect(parseChecksum(sh(remoteCmd.checksum("sha256", evil)), "sha256")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    } finally {
      t.cleanup()
    }
  })

  it("df -Pk y las sumas", () => {
    expect(parseDfFree("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /\n")).toBe(60 * 1024)
    expect(parseDfFree("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/mapper/very-long-name\n 100 40 60 40% /\n")).toBe(60 * 1024)
    expect(parseDfFree("basura")).toBeNull()
    expect(parseChecksum("d41d8cd98f00b204e9800998ecf8427e  /x\n", "md5")).toBe("d41d8cd98f00b204e9800998ecf8427e")
    expect(parseChecksum("sha256sum: /x: No such file", "sha256")).toBeNull()
  })
})
