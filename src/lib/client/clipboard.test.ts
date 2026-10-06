import { describe, expect, it, vi } from "vitest"
import { copyText, pickCopyStrategy, type CopyEnv } from "./clipboard"

function env(over: Partial<CopyEnv> = {}): CopyEnv & { execCopy: ReturnType<typeof vi.fn> } {
  const execCopy = vi.fn((text: string) => text.length >= 0)
  return { isSecureContext: true, writeText: vi.fn(async () => undefined), execCopy, ...over } as CopyEnv & { execCopy: typeof execCopy }
}

describe("pickCopyStrategy", () => {
  it("uses the Clipboard API only in a secure context that has it", () => {
    expect(pickCopyStrategy({ isSecureContext: true, hasClipboardApi: true })).toBe("clipboard-api")
    expect(pickCopyStrategy({ isSecureContext: false, hasClipboardApi: true })).toBe("exec-command")
    expect(pickCopyStrategy({ isSecureContext: true, hasClipboardApi: false })).toBe("exec-command")
    expect(pickCopyStrategy({ isSecureContext: false, hasClipboardApi: false })).toBe("exec-command")
  })
})

describe("copyText", () => {
  it("writes through navigator.clipboard over HTTPS", async () => {
    const e = env()
    await expect(copyText("hola", e)).resolves.toBe(true)
    expect(e.writeText).toHaveBeenCalledWith("hola")
    expect(e.execCopy).not.toHaveBeenCalled()
  })

  it("falls back to execCommand over plain HTTP", async () => {
    const e = env({ isSecureContext: false })
    await expect(copyText("192.168.1.40", e)).resolves.toBe(true)
    expect(e.writeText).not.toHaveBeenCalled()
    expect(e.execCopy).toHaveBeenCalledWith("192.168.1.40")
  })

  it("falls back when the Clipboard API rejects (permission denied)", async () => {
    const e = env({ writeText: vi.fn(async () => { throw new Error("NotAllowedError") }) })
    await expect(copyText("x", e)).resolves.toBe(true)
    expect(e.execCopy).toHaveBeenCalledWith("x")
  })

  it("returns false when every strategy fails", async () => {
    const e = env({ isSecureContext: false, execCopy: vi.fn(() => false) })
    await expect(copyText("x", e)).resolves.toBe(false)
    const t = env({ isSecureContext: false, execCopy: vi.fn(() => { throw new Error("boom") }) })
    await expect(copyText("x", t)).resolves.toBe(false)
  })

  it("an empty string copies nothing", async () => {
    const e = env()
    await expect(copyText("", e)).resolves.toBe(false)
    expect(e.writeText).not.toHaveBeenCalled()
  })
})
