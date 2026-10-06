// The service's side of the root helper protocol (protocol.ts): connect to the unix socket, send one header line,
// stream the file for a copy (with backpressure) and read the helper's progress and result lines. The password is
// only in the header written to the socket; the buffer is zeroed after the write.
import net from "node:net"
import {
  HEADER_MAX_BYTES, LineReader, type CopyResult, type HelperErrorCode, type HelperMsg, type HelperRequest, type IssuedToken,
  type ListResult, type MkdirResult, type MountResult, type PingResult, type ProbeResult, type RevokeResult, type UnmountResult,
} from "./protocol"
import { CopyError } from "./safe-dest"

export class HelperUnavailable extends Error {}

export interface CopyStream {
  size: number
  chunks: AsyncIterable<Buffer>
  signal: AbortSignal
  onProgress?(bytes: number): void
  onVerifying?(): void
  /** The helper accepted the password and the destination and waits for the bytes. */
  onReady?(): void
}

type Req<O extends HelperRequest["op"]> = Omit<Extract<HelperRequest, { op: O }>, "v" | "op">
/** A result with the elevation token the helper issued (password + `issue`). */
type T<R> = R & { token?: IssuedToken }

export interface HelperClient {
  readonly socketPath: string
  ping(timeoutMs?: number): Promise<PingResult>
  probe(req: Req<"probe">): Promise<T<ProbeResult>>
  list(req: Req<"list">): Promise<T<ListResult>>
  mkdir(req: Req<"mkdir">): Promise<T<MkdirResult>>
  copy(req: Req<"copy">, data: CopyStream): Promise<T<CopyResult>>
  mount(req: Req<"mount">): Promise<T<MountResult>>
  unmount(req: Req<"unmount">): Promise<T<UnmountResult>>
  revoke(token: string): Promise<RevokeResult>
}

const unavailableMessage = (code: string) =>
  code === "EACCES"
    ? "Sin permiso para usar el ayudante de copia como administrador (el socket es del grupo relay-manager)."
    : "El ayudante de copia como administrador no responde (relay-manager-rootcopy.socket)."

export function createHelperClient(socketPath: string, timeouts: { connectMs?: number; replyMs?: number } = {}): HelperClient {
  const connectMs = timeouts.connectMs ?? 5000
  /** Longest wait for the next line from the helper (authentication runs crypt: up to a few seconds). */
  const replyMs = timeouts.replyMs ?? 60_000

  function call<T extends HelperMsg>(req: HelperRequest, data: CopyStream | null, timeoutMs = replyMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const sock = net.createConnection({ path: socketPath })
      const reader = new LineReader(HEADER_MAX_BYTES * 64)
      let settled = false
      let streaming = false
      let timer: NodeJS.Timeout | null = null
      const arm = (ms: number) => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => finish(new CopyError("IO", "El ayudante de copia como administrador no contesta.")), ms)
      }
      const finish = (err: Error | null, value?: T) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        data?.signal.removeEventListener("abort", onAbort)
        sock.destroy()
        if (err) reject(err)
        else resolve(value as T)
      }
      const onAbort = () => finish(new CopyError("CANCELED", "Copia cancelada."))
      data?.signal.addEventListener("abort", onAbort, { once: true })
      if (data?.signal.aborted) return onAbort()

      arm(connectMs)
      sock.on("connect", () => {
        arm(timeoutMs)
        const head = Buffer.from(`${JSON.stringify(req)}\n`, "utf8")
        if ("password" in req && req.password !== undefined) req.password = ""
        sock.write(head, () => head.fill(0))
      })
      sock.on("error", (e: NodeJS.ErrnoException) => {
        if (!sock.connecting && (settled || streaming)) return finish(new CopyError("IO", "Se ha cortado la conexión con el ayudante de copia."))
        const code = e.code ?? ""
        if (["ENOENT", "ECONNREFUSED", "EACCES", "ENOTSOCK", "ECONNRESET"].includes(code)) finish(new HelperUnavailable(unavailableMessage(code)))
        else finish(new CopyError("IO", `Error con el ayudante de copia: ${e.message}`))
      })
      sock.on("close", () => finish(new CopyError("IO", "El ayudante de copia ha cerrado la conexión sin responder.")))
      sock.on("data", (chunk: Buffer) => {
        let lines: string[]
        try {
          lines = reader.push(chunk)
        } catch {
          return finish(new CopyError("IO", "Respuesta no válida del ayudante de copia."))
        }
        for (const line of lines) {
          let m: HelperMsg
          try {
            m = JSON.parse(line) as HelperMsg
          } catch {
            return finish(new CopyError("IO", "Respuesta no válida del ayudante de copia."))
          }
          arm(timeoutMs)
          if (m.type === "error") return finish(new CopyError(m.code as HelperErrorCode, m.message))
          if (m.type === "result") return finish(null, m as T)
          if (m.type === "progress") data?.onProgress?.(m.bytes)
          else if (m.type === "verifying") data?.onVerifying?.()
          else if (m.type === "ready" && data && !streaming) {
            streaming = true
            data.onReady?.()
            void pump(sock, data).catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))))
          }
        }
      })
    })
  }

  /** Writes the file to the socket, waiting for 'drain' (backpressure). */
  async function pump(sock: net.Socket, data: CopyStream): Promise<void> {
    for await (const chunk of data.chunks) {
      if (data.signal.aborted || sock.destroyed) return
      if (!sock.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            sock.off("drain", done)
            sock.off("close", done)
            resolve()
          }
          sock.on("drain", done)
          sock.on("close", done)
        })
      }
    }
  }

  return {
    socketPath,
    ping: (timeoutMs = 20_000) => call<PingResult>({ v: 1, op: "ping" }, null, timeoutMs),
    probe: (r) => call<T<ProbeResult>>({ v: 1, op: "probe", ...r }, null),
    list: (r) => call<T<ListResult>>({ v: 1, op: "list", ...r }, null),
    mkdir: (r) => call<T<MkdirResult>>({ v: 1, op: "mkdir", ...r }, null),
    copy: (r, data) => call<T<CopyResult>>({ v: 1, op: "copy", ...r }, data),
    // Mounting can wait for udev and the filesystem driver; unmounting flushes what was written (slow sticks).
    mount: (r) => call<T<MountResult>>({ v: 1, op: "mount", ...r }, null, 2 * 60_000),
    unmount: (r) => call<T<UnmountResult>>({ v: 1, op: "unmount", ...r }, null, 11 * 60_000),
    revoke: (token) => call<RevokeResult>({ v: 1, op: "revoke", token }, null, 10_000),
  }
}
