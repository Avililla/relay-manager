import { RELAY_TEXT } from "@/lib/i18n/relays"
import { RelayDriverError } from "../types"

/** An aborted request: a timeout signal reads as a timeout, anything else as the server stopping. */
export function abortError(signal: AbortSignal | undefined, host: string): RelayDriverError {
  const reason: unknown = signal?.reason
  const isTimeout = typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "TimeoutError"
  return isTimeout ? new RelayDriverError(RELAY_TEXT.errTimeout(host), "timeout") : new RelayDriverError(RELAY_TEXT.errAborted, "timeout")
}
