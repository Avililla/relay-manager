import { describe, expect, it } from "vitest"
import { classify, printableSample } from "./classify"

const FSBL = "\r\nXilinx First Stage Boot Loader\r\nRelease 2022.2   Jan  1 2024-00:00:00\r\nBoot mode is QSPI\r\n"
const UBOOT = "\r\n\r\nU-Boot 2022.01 (Jan 01 2024 - 00:00:00 +0000)\r\n\r\nCPU:   Zynq 7z020\r\n"

describe("classify", () => {
  it("no bytes → silent", () => {
    expect(classify("")).toEqual({ state: "silent", hostname: null })
  })

  it("fsbl banner", () => {
    expect(classify(FSBL).state).toBe("fsbl")
  })

  it("U-Boot banner without prompt → uboot-prompt (banner rule)", () => {
    expect(classify(FSBL + UBOOT).state).toBe("uboot-prompt")
  })

  it("autoboot countdown with N ≥ 1 → uboot-autoboot", () => {
    expect(classify(FSBL + UBOOT + "\rHit any key to stop autoboot: 3 ").state).toBe("uboot-autoboot")
  })

  it("countdown reaching 0 then kernel → linux-booting (latest banner wins)", () => {
    const t = FSBL + UBOOT + "\rHit any key to stop autoboot: 1 \rHit any key to stop autoboot: 0 \r\nStarting kernel ...\r\n\r\n[    0.000000] Booting Linux on physical CPU 0x0\r\n"
    expect(classify(t).state).toBe("linux-booting")
  })

  it("kernel timestamps alone → linux-booting", () => {
    expect(classify("[    2.104512] Freeing unused kernel memory: 1024K\r\n").state).toBe("linux-booting")
  })

  it("U-Boot prompt", () => {
    expect(classify(UBOOT + "Hit any key to stop autoboot: 0 \r\nZynq> ").state).toBe("uboot-prompt")
    expect(classify("\r\nZynqMP> ").state).toBe("uboot-prompt")
    expect(classify("\r\n=> ").state).toBe("uboot-prompt")
  })

  it("login prompt with hostname", () => {
    expect(classify("\r\nPetaLinux 2022.2 equipo-uart1 ttyPS0\r\n\r\nequipo-uart1 login: ")).toEqual({ state: "login", hostname: "equipo-uart1" })
  })

  it("login prompt without hostname", () => {
    expect(classify("\r\nlogin: ")).toEqual({ state: "login", hostname: null })
  })

  it("shell prompt with hostname", () => {
    expect(classify("\r\nroot@equipo-uart0:~# ")).toEqual({ state: "shell", hostname: "equipo-uart0" })
  })

  it("shell prompt without user@host", () => {
    expect(classify("\r\n# ").state).toBe("shell")
    expect(classify("sh-5.1$ ").state).toBe("shell")
  })

  it("bitreader", () => {
    expect(classify("BITReader_Tool v1.0\r\n---------- BEGIN eMMC0\r\n").state).toBe("bitreader")
    expect(classify("...\r\nRESULTADO: ERROR\r\n").state).toBe("bitreader")
  })

  it("≥16 bytes with < 70 % printable → unreadable", () => {
    const garbage = String.fromCharCode(...Array.from({ length: 40 }, (_, i) => (i * 37 + 129) % 256))
    expect(classify(garbage).state).toBe("unreadable")
  })

  it("short noise is not unreadable", () => {
    expect(classify("\x00\x01").state).toBe("silent")
  })

  it("ANSI escapes are stripped before matching prompts", () => {
    expect(classify("\x1b[1;32mroot@equipo-uart1\x1b[0m:~# ")).toEqual({ state: "shell", hostname: "equipo-uart1" })
  })

  it("only the last 400 characters decide the prompt", () => {
    const old = "equipo-old login: \r\n"
    const tail = "x".repeat(500) + "\r\n[    1.000000] random: crng init done\r\n"
    expect(classify(old + tail).state).toBe("linux-booting")
  })

  it("printableSample keeps the last lines and replaces control characters", () => {
    const s = printableSample("line1\r\nline2\r\n\x07bell\x1b[0m\r\nlast")
    expect(s).toBe("line1\nline2\n·bell\nlast")
    expect(printableSample("a\nb\nc\nd\ne\nf\ng\nh").split("\n")).toHaveLength(6)
  })
})
