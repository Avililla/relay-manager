// Copy to the clipboard over plain HTTP too (§8.10, §8.12): navigator.clipboard needs a secure context.

export interface CopyEnv {
  isSecureContext: boolean
  writeText?: (text: string) => Promise<void>
  /** Hidden <textarea> + document.execCommand("copy"). */
  execCopy: (text: string) => boolean
}

export type CopyStrategy = "clipboard-api" | "exec-command"

export function pickCopyStrategy(e: { isSecureContext: boolean; hasClipboardApi: boolean }): CopyStrategy {
  return e.isSecureContext && e.hasClipboardApi ? "clipboard-api" : "exec-command"
}

function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined") return false
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.setAttribute("aria-hidden", "true")
  ta.style.position = "fixed"
  ta.style.top = "0"
  ta.style.left = "-9999px"
  ta.style.opacity = "0"
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.appendChild(ta)
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    return document.execCommand("copy")
  } finally {
    ta.remove()
    active?.focus({ preventScroll: true })
  }
}

export function browserCopyEnv(): CopyEnv {
  const secure = typeof window !== "undefined" && window.isSecureContext
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined
  return {
    isSecureContext: secure,
    writeText: clip ? (t) => clip.writeText(t) : undefined,
    execCopy: execCommandCopy,
  }
}

/** Returns true when the text reached the clipboard; the caller toasts on false. */
export async function copyText(text: string, env: CopyEnv = browserCopyEnv()): Promise<boolean> {
  if (!text) return false
  if (pickCopyStrategy({ isSecureContext: env.isSecureContext, hasClipboardApi: !!env.writeText }) === "clipboard-api" && env.writeText) {
    try {
      await env.writeText(text)
      return true
    } catch {
      // Permission denied or document not focused: try the legacy path.
    }
  }
  try {
    return env.execCopy(text)
  } catch {
    return false
  }
}
