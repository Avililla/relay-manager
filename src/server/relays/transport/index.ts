import type { RelayTransports } from "../types"
import { httpGet } from "./http"
import { tcpConnect, tcpProbe } from "./tcp"

export { httpGet } from "./http"
export { tcpConnect, tcpProbe, tcpRequest, TCP_MAX_BYTES } from "./tcp"

/** Real network transports. Stateless: safe to share. */
export const defaultTransports: RelayTransports = { httpGet, tcpConnect, tcpProbe }
