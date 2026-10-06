// Applies a planned list of 802.1Q operations to a switch session one at a time, verifying each one by reading the
// switch again, and rolls back to the starting state when a step fails. Also finds which switch port this server is
// plugged into from the per-port packet counters (read-only), so a wrong "uplink" never locks the server out.
import {
  applyOp, keepsManagement, planSwitchOps, sameMembers, type Dot1qState, type SwitchOp,
} from "@/lib/equipnet/switch-layout"
import { SwitchError, type SwitchSession } from "./drivers/types"

export interface RunProgress { index: number; total: number; op: SwitchOp }
export interface RunResult { state: Dot1qState; warnings: string[] }

export class SwitchStepError extends Error {
  readonly op: SwitchOp
  readonly index: number
  constructor(index: number, op: SwitchOp, message: string) {
    super(message)
    this.name = "SwitchStepError"
    this.op = op
    this.index = index
  }
}

/** Does the switch now show what `op` should have done? (null = yes; else what differs, in Spanish). */
export function verifyOp(op: SwitchOp, actual: Dot1qState): string | null {
  switch (op.op) {
    case "enable":
      return actual.enabled === op.on ? null : op.on ? "802.1Q sigue desactivado" : "802.1Q sigue activado"
    case "vlan": {
      const v = actual.vlans.find((x) => x.vid === op.vlan.vid)
      if (!v) return `la VLAN ${op.vlan.vid} no aparece`
      return sameMembers(v, op.vlan) ? null : `la VLAN ${op.vlan.vid} no tiene los puertos esperados`
    }
    case "pvid": {
      const bad = op.ports.filter((p) => actual.pvids[p - 1] !== op.pvid)
      return bad.length ? `el PVID de ${bad.length === 1 ? `el puerto ${bad[0]}` : `los puertos ${bad.join(", ")}`} no es ${op.pvid}` : null
    }
    case "delete": {
      const left = op.vids.filter((vid) => actual.vlans.some((v) => v.vid === vid))
      return left.length ? `siguen las VLAN ${left.join(", ")}` : null
    }
    case "save":
      return null
  }
}

async function exec(sess: SwitchSession, op: SwitchOp): Promise<void> {
  switch (op.op) {
    case "enable": return sess.enableDot1q(op.on)
    case "vlan": return sess.setVlan(op.vlan)
    case "pvid": return sess.setPvid(op.ports, op.pvid)
    case "delete": return sess.deleteVlans(op.vids)
    case "save": return sess.save()
  }
}

/**
 * Runs `ops` from `start`. `optionalVlan1Prune`: some firmware does not let VLAN 1 be edited; removing the equipment
 * ports from VLAN 1 is then skipped with a warning (the equipment are still isolated from each other: their frames
 * enter their own VLAN), instead of failing the whole setup.
 */
export async function runSwitchOps(sess: SwitchSession, start: Dot1qState, ops: readonly SwitchOp[], o: {
  uplinkPort: number
  optionalVlan1Prune?: boolean
  vlan1PruneWarning?: string
  onStep?: (p: RunProgress) => void
}): Promise<RunResult> {
  const warnings: string[] = []
  let state = start
  for (const [index, op] of ops.entries()) {
    o.onStep?.({ index, total: ops.length, op })
    try {
      await exec(sess, op)
    } catch (err) {
      throw new SwitchStepError(index, op, err instanceof Error ? err.message : String(err))
    }
    if (op.op === "save") continue
    let actual: Dot1qState
    try {
      actual = await sess.dot1q()
    } catch (err) {
      const lost = err instanceof SwitchError && err.code === "unreachable"
      throw new SwitchStepError(index, op, lost ? "el switch ha dejado de responder" : err instanceof Error ? err.message : String(err))
    }
    const problem = verifyOp(op, actual)
    if (problem) {
      const prune = op.op === "vlan" && op.vlan.vid === 1 && op.phase === "final" && o.optionalVlan1Prune
      if (!prune) throw new SwitchStepError(index, op, problem)
      warnings.push(o.vlan1PruneWarning ?? problem)
    }
    if (!keepsManagement(actual, o.uplinkPort)) throw new SwitchStepError(index, op, "la gestión del switch quedaría inaccesible")
    state = actual
  }
  return { state, warnings }
}

/** Best effort: brings the switch back to `snapshot` (after a failed run). Returns an error message or null. */
export async function rollback(sess: SwitchSession, snapshot: Dot1qState, uplinkPort: number): Promise<string | null> {
  try {
    const now = await sess.dot1q()
    const ops = planSwitchOps(now, snapshot)
    await runSwitchOps(sess, now, ops, { uplinkPort })
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** The state the switch should end in (for the preview), from the ops. */
export function expectedAfter(start: Dot1qState, ops: readonly SwitchOp[]): Dot1qState {
  return ops.reduce(applyOp, start)
}

/**
 * Which switch port is this server plugged into? Reads the received-packet counters, makes a few requests, reads them
 * again: the port whose counter grew the most (and clearly more than any other) is ours. null = not conclusive.
 */
export async function detectServerPort(sess: SwitchSession, o: { probes?: number } = {}): Promise<{ port: number | null; deltas: number[] }> {
  const before = await sess.rxCounters()
  for (let i = 0; i < (o.probes ?? 4); i++) await sess.info()
  const after = await sess.rxCounters()
  const deltas = after.map((a, i) => Math.max(0, a - (before[i] ?? 0)))
  const order = deltas.map((d, i) => ({ d, port: i + 1 })).sort((a, b) => b.d - a.d)
  const best = order[0]
  const second = order[1]?.d ?? 0
  if (!best || best.d < 5 || best.d < second * 2) return { port: null, deltas }
  return { port: best.port, deltas }
}
