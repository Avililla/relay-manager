import { describe, expect, it } from "vitest"
import { canSendTo, pickAccess } from "./rules"

const ana = "u-ana"
const held = (holderId: string) => ({ holderId, holderName: holderId === ana ? "Ana" : "Bea" })

describe("quién puede enviar a un equipo", () => {
  it("el titular de la reserva, sí (con cualquier apertura)", () => {
    expect(canSendTo({ userId: ana, reservation: held(ana), policy: "reserved", enabled: true })).toEqual({ ok: true })
    expect(canSendTo({ userId: ana, reservation: held(ana), policy: "always", enabled: true })).toEqual({ ok: true })
  })

  it("sin reserva: solo si el acceso Ethernet es «Siempre»", () => {
    expect(canSendTo({ userId: ana, reservation: null, policy: "always", enabled: true })).toEqual({ ok: true })
    expect(canSendTo({ userId: ana, reservation: null, policy: "reserved", enabled: true }))
      .toEqual({ ok: false, code: "NOT_RESERVED", reason: "Reserva el equipo para enviarle archivos." })
  })

  it("reservado por otro: no (salvo «Siempre», como el propio acceso SSH)", () => {
    expect(canSendTo({ userId: ana, reservation: held("u-bea"), policy: "reserved", enabled: true }))
      .toEqual({ ok: false, code: "RESERVED_BY_OTHER", reason: "Reserva el equipo para enviarle archivos (ahora lo tiene Bea)." })
    expect(canSendTo({ userId: ana, reservation: held("u-bea"), policy: "always", enabled: true })).toEqual({ ok: true })
  })

  it("acceso desactivado: nunca, ni para el titular", () => {
    expect(canSendTo({ userId: ana, reservation: held(ana), policy: "always", enabled: false })).toMatchObject({ ok: false, code: "DISABLED" })
  })

  it("elige el acceso: activo, luego el del puerto 22, luego el primero", () => {
    const a = { id: "a", enabled: true, targetPort: 8080, position: 0 }
    const b = { id: "b", enabled: true, targetPort: 22, position: 1 }
    const c = { id: "c", enabled: false, targetPort: 22, position: 2 }
    expect(pickAccess([a, b, c])?.id).toBe("b")
    expect(pickAccess([a, c])?.id).toBe("a")
    expect(pickAccess([c])?.id).toBe("c")
    expect(pickAccess([])).toBeNull()
  })
})
