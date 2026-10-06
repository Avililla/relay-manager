// devantech-ds-http (§4.8 driver 1): dS stock app over HTTP. Toggle only; absolute set is read-compare-toggle,
// and the controller verifies. Pulse is emulated (toggle, wait, toggle).
import type { DetectResultDTO } from "@/lib/contracts/relays"
import { RELAY_TEXT } from "@/lib/i18n/relays"
import { driverLabel } from "@/lib/i18n/status"
import { driverCapabilities } from "@/lib/relays/capabilities"
import { fingerprintDsModel, modelByModuleId, modelByName } from "../pure/models"
import { extractTitle, extractToggleVar, isDsIndexXml, parseIndexXml, xmlTags } from "../pure/ds"
import { RelayDriverError, type BoardRef, type DriverDeps, type ProbeContext, type RelayDriver } from "../types"
import { channelCheck, detectFailure, driverRuntime, probeTimeout } from "./common"

const PERMISSION_PAGE = /do not have permission|_pw\.htm/i

/** Resolves the model from the fingerprint candidates and an optional hint (UDP module id, ST model). */
export function resolveDsModel(candidates: string[], hint?: Partial<DetectResultDTO>): string | null {
  const hinted = hint?.model ? modelByName(hint.model)?.model : hint?.moduleId != null ? modelByModuleId(hint.moduleId)?.model : undefined
  if (hinted && (candidates.length === 0 || candidates.includes(hinted))) return hinted
  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

export function createDsHttpDriver(deps: DriverDeps): RelayDriver {
  const rt = driverRuntime(deps)
  const log = deps.log.child("relays")

  async function readXml(board: BoardRef, signal: AbortSignal): Promise<string> {
    const r = await rt.t.httpGet({ host: board.host, port: board.httpPort, path: "/index.xml", timeoutMs: rt.timeoutMs, signal })
    if (r.status === 401 || r.status === 403) throw new RelayDriverError(RELAY_TEXT.hintAuthRequired, "auth")
    if (r.status !== 200) throw new RelayDriverError(RELAY_TEXT.errUnrecognised, "protocol")
    if (PERMISSION_PAGE.test(r.body)) throw new RelayDriverError(RELAY_TEXT.hintAuthRequired, "auth")
    return r.body
  }

  /** D5: the toggle variable is learned per board from /index.htm and persisted; there is no default. */
  async function toggleVarFor(board: BoardRef, signal: AbortSignal): Promise<string> {
    if (board.options.toggleVar) return board.options.toggleVar
    const r = await rt.t.httpGet({ host: board.host, port: board.httpPort, path: "/index.htm", timeoutMs: rt.timeoutMs, signal })
    const v = r.status === 200 ? extractToggleVar(r.body) : null
    if (!v) throw new RelayDriverError(RELAY_TEXT.errToggleVarMissing, "config")
    board.options = { ...board.options, toggleVar: v }
    log.info(RELAY_TEXT.logToggleVarLearned, { placa: board.name, variable: v })
    await deps.persistOptions?.(board.id, board.options)
    return v
  }

  async function toggle(board: BoardRef, channel: number, signal: AbortSignal): Promise<void> {
    const v = await toggleVarFor(board, signal)
    const r = await rt.t.httpGet({ host: board.host, port: board.httpPort, path: `/dscript.cgi?${v}=${channel}`, timeoutMs: rt.timeoutMs, signal })
    if (r.status !== 200) throw new RelayDriverError(RELAY_TEXT.errHttpStatus(r.status), "nack")
  }

  return {
    id: "devantech-ds-http",
    label: driverLabel("devantech-ds-http"),
    capabilities: (b) => driverCapabilities("devantech-ds-http", b),

    async detect(host, ports, ctx: ProbeContext) {
      if (!ports.httpPort) return null
      const timeoutMs = probeTimeout(rt, ctx)
      try {
        const xml = await rt.probe.httpGet({ host, port: ports.httpPort, path: "/index.xml", timeoutMs, signal: ctx.signal })
        const base: DetectResultDTO = {
          driver: "devantech-ds-http", confidence: "low", host, httpPort: ports.httpPort, tcpPort: null,
          model: null, moduleId: null, relayCount: null, hostname: null, mac: ctx.hint?.mac ?? null, firmware: null,
          authRequired: false, options: {}, evidence: [],
        }
        if (xml.status !== 200) return null
        if (!isDsIndexXml(xml.body)) {
          if (!PERMISSION_PAGE.test(xml.body)) return null
          return { ...base, authRequired: true, evidence: ["GET /index.xml -> página de permiso (contraseña web)", RELAY_TEXT.hintAuthRequired] }
        }
        const tags = xmlTags(xml.body)
        const rly = [...tags].filter((t) => /^Rly\d+$/.test(t)).length
        const candidates = fingerprintDsModel(tags)
        const model = resolveDsModel(candidates, ctx.hint)
        const info = modelByName(model)
        const evidence = [`GET /index.xml -> ${rly} <RlyN>`]
        if (candidates.length) evidence.push(`Etiquetas -> ${candidates.join(" / ")}`)
        let toggleVar: string | null = null
        let hostname: string | null = null
        const htm = await rt.probe.httpGet({ host, port: ports.httpPort, path: "/index.htm", timeoutMs, signal: ctx.signal }).catch(detectFailure)
        if (htm?.status === 200) {
          toggleVar = extractToggleVar(htm.body)
          hostname = extractTitle(htm.body)
          evidence.push(`GET /index.htm -> ${toggleVar ?? "sin variable dScript"}`)
        }
        return {
          ...base,
          confidence: model && toggleVar ? "high" : "medium",
          model, moduleId: info?.moduleId ?? null, relayCount: info?.relays ?? ctx.hint?.relayCount ?? null,
          hostname: hostname ?? ctx.hint?.hostname ?? null,
          options: toggleVar ? { toggleVar } : {},
          evidence,
        }
      } catch (e) {
        return detectFailure(e)
      }
    },

    async readState(board, signal) {
      return parseIndexXml(await readXml(board, signal), board.relayCount)
    },

    async setRelay(board, channel, on, signal) {
      channelCheck(channel, board.relayCount)
      await toggleVarFor(board, signal)
      const states = parseIndexXml(await readXml(board, signal), board.relayCount)
      if (states[channel - 1] === on) return
      await toggle(board, channel, signal)
    },

    async pulse(board, channel, ms, signal) {
      channelCheck(channel, board.relayCount)
      await toggle(board, channel, signal)
      try {
        await rt.sleep(ms, signal)
      } catch {
        // shutting down mid-pulse: still try to restore the relay below
      }
      try {
        await toggle(board, channel, AbortSignal.timeout(rt.timeoutMs * 2))
      } catch {
        throw new RelayDriverError(RELAY_TEXT.errPulseIncomplete, "protocol")
      }
    },
  }
}
