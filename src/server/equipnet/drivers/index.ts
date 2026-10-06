// Switch driver registry of "Red de equipos".
import type { SwitchDriverId } from "@/lib/contracts/equipnet"
import type { HttpFn } from "../http-client"
import { tplinkEasySmart } from "./tplink-easy-smart"
import { SwitchError, type SwitchDriver } from "./types"

/** "manual": the app configures nothing on the switch; it shows what to set by hand (ManualInstructionsDTO). */
export const manualDriver: SwitchDriver = {
  id: "manual",
  automatic: false,
  open() {
    return Promise.reject(new SwitchError("rejected", "Con el controlador «manual» el switch se configura a mano"))
  },
  fingerprint() {
    return Promise.resolve(false)
  },
}

export function switchDrivers(http?: HttpFn): Record<SwitchDriverId, SwitchDriver> {
  return { "tplink-easy-smart": tplinkEasySmart(http), manual: manualDriver }
}

export { SwitchError } from "./types"
export type { SwitchDriver, SwitchSession, SwitchTarget, SwitchInfo, SwitchPortLink } from "./types"
