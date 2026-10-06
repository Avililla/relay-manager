// The source side of the scp protocol against scripted sinks (no SSH): the exact bytes, the acks, the sink's warnings
// and fatal errors (before the header, after the header, after the data), a sink that dies, and cancel.
import { Duplex, PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { ScpAborted, ScpError, scpSend } from "./scp"

/** A channel: what we write goes to `toSink`, what the sink replies comes from `fromSink`. */
function channel() {
  const toSink = new PassThrough()
  const fromSink = new PassThrough()
  let ended = false
  const ch = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      toSink.write(chunk)
      cb()
    },
    final(cb) {
      ended = true
      toSink.end()
      cb()
    },
  })
  fromSink.on("data", (d: Buffer) => ch.push(d))
  fromSink.on("end", () => ch.push(null))
  return { ch, toSink, fromSink, ended: () => ended }
}

/** A well-behaved sink: records the header and the data, acks everything (or fails where told). */
function sink(c: ReturnType<typeof channel>, o: { failStart?: string; failHeader?: string; failData?: string; fatal?: boolean; dieAfter?: number } = {}) {
  let buf = Buffer.alloc(0)
  const got = { header: "", data: Buffer.alloc(0), trailer: false }
  let state: "header" | "data" | "trailer" | "done" = "header"
  let size = 0
  const reply = (msg?: string) => c.fromSink.write(msg === undefined ? Buffer.from([0]) : Buffer.from(`${o.fatal ? "\x02" : "\x01"}scp: ${msg}\n`))
  if (o.failStart) {
    reply(o.failStart)
    return got
  }
  reply()
  c.toSink.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (state === "header") {
        const nl = buf.indexOf(0x0a)
        if (nl < 0) return
        got.header = buf.subarray(0, nl).toString()
        buf = buf.subarray(nl + 1)
        size = Number(got.header.split(" ")[1])
        if (o.failHeader) {
          reply(o.failHeader)
          state = "done"
          return
        }
        reply()
        state = "data"
      } else if (state === "data") {
        const n = Math.min(size - got.data.length, buf.length)
        got.data = Buffer.concat([got.data, buf.subarray(0, n)])
        buf = buf.subarray(n)
        if (o.dieAfter !== undefined && got.data.length >= o.dieAfter) {
          c.fromSink.end()
          state = "done"
          return
        }
        if (got.data.length < size) return
        state = "trailer"
      } else if (state === "trailer") {
        if (!buf.length) return
        got.trailer = buf[0] === 0
        buf = buf.subarray(1)
        reply(o.failData)
        state = "done"
      } else return
    }
  })
  return got
}

async function* chunks(data: Buffer, n = 1000): AsyncGenerator<Buffer> {
  for (let i = 0; i < data.length; i += n) yield data.subarray(i, i + n)
}

describe("scp: protocolo del lado que envía", () => {
  it("cabecera C0644 <tamaño> <nombre>, los datos, el \\0 final y fin de la entrada", async () => {
    const c = channel()
    const got = sink(c)
    const data = Buffer.from("x".repeat(25_000))
    const progress: number[] = []
    await scpSend(c.ch, { name: ".rm-send-abc.part", size: data.length, mode: 0o644, data: chunks(data), onProgress: (n) => progress.push(n) })
    expect(got.header).toBe(`C0644 ${data.length} .rm-send-abc.part`)
    expect(got.data.equals(data)).toBe(true)
    expect(got.trailer).toBe(true)
    expect(progress.at(-1)).toBe(data.length)
    expect(c.ended()).toBe(true)
  })

  it("ejecutables: C0755; archivo vacío: sin datos", async () => {
    const c = channel()
    const got = sink(c)
    await scpSend(c.ch, { name: "run.sh", size: 0, mode: 0o755, data: chunks(Buffer.alloc(0)) })
    expect(got.header).toBe("C0755 0 run.sh")
    expect(got.trailer).toBe(true)
  })

  it("errores del receptor: al empezar (carpeta que no existe), tras la cabecera (permiso) y tras los datos (disco lleno)", async () => {
    for (const [where, opt] of [["start", { failStart: "/nope: No such file or directory", fatal: true }], ["header", { failHeader: "/ro/x: Permission denied" }],
      ["data", { failData: "/tmp/x: No space left on device" }]] as const) {
      const c = channel()
      sink(c, opt)
      const err = await scpSend(c.ch, { name: "x", size: 3, mode: 0o644, data: chunks(Buffer.from("abc")) }).then(() => null, (e: unknown) => e)
      expect(err, where).toBeInstanceOf(ScpError)
      expect((err as ScpError).remote).toMatch(where === "start" ? /No such file/ : where === "header" ? /Permission denied/ : /No space left/)
      expect((err as ScpError).fatal).toBe(where === "start")
    }
  })

  it("el receptor se cierra a mitad: error, sin colgarse", async () => {
    const c = channel()
    sink(c, { dieAfter: 5000 })
    const err = await scpSend(c.ch, { name: "x", size: 20_000, mode: 0o644, data: chunks(Buffer.alloc(20_000)) }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ScpError)
  })

  it("una respuesta que no es de scp (un mensaje del shell): error con el texto", async () => {
    const c = channel()
    c.fromSink.write("sh: scp: not found\n")
    const err = await scpSend(c.ch, { name: "x", size: 1, mode: 0o644, data: chunks(Buffer.from("a")) }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ScpError)
    expect((err as Error).message).toContain("sh: scp: not found")
  })

  it("cancelar a mitad: ScpAborted y se corta el canal", async () => {
    const c = channel()
    sink(c)
    const ac = new AbortController()
    async function* slow(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 100; i++) {
        if (i === 3) ac.abort()
        yield Buffer.alloc(1000)
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    await expect(scpSend(c.ch, { name: "x", size: 100_000, mode: 0o644, data: slow(), signal: ac.signal })).rejects.toBeInstanceOf(ScpAborted)
    expect(c.ch.destroyed).toBe(true)
  })

  it("nombres imposibles para una línea C (salto de línea, /): rechazados antes de enviar nada", async () => {
    const c = channel()
    await expect(scpSend(c.ch, { name: "a\nC0644 1 b", size: 1, mode: 0o644, data: chunks(Buffer.from("a")) })).rejects.toBeInstanceOf(ScpError)
    await expect(scpSend(c.ch, { name: "../x", size: 1, mode: 0o644, data: chunks(Buffer.from("a")) })).rejects.toBeInstanceOf(ScpError)
  })

  it("el archivo crece o encoge mientras se envía: error", async () => {
    const c = channel()
    sink(c)
    await expect(scpSend(c.ch, { name: "x", size: 2, mode: 0o644, data: chunks(Buffer.from("abc")) })).rejects.toThrow(/crecido/)
    const c2 = channel()
    sink(c2)
    await expect(scpSend(c2.ch, { name: "x", size: 5, mode: 0o644, data: chunks(Buffer.from("abc")) })).rejects.toThrow(/tamaño/)
  })
})
