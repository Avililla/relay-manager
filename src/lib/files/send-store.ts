// «Envíos» of this tab: the sends of the signed-in user, kept by the server (they go on without the browser) and mirrored
// here from GET /api/files/send and the `files.send` events (see job-store.ts).
import { FILES_API, type SendJobDTO } from "@/lib/contracts/files"
import { createJobStore, type JobStore } from "./job-store"

export type SendStore = JobStore<SendJobDTO>

const FINISHED = new Set<SendJobDTO["state"]>(["done", "error", "canceled"])
export const isFinished = (j: SendJobDTO) => FINISHED.has(j.state)

export function createSendStore(fetcher?: typeof fetch): SendStore {
  return createJobStore<SendJobDTO>(FILES_API.send, FINISHED, { cancelError: "No se ha podido cancelar.", offline: "No se ha podido cancelar: sin conexión con el servidor." }, fetcher)
}

let store: SendStore | null = null
export function sendStore(): SendStore {
  store ??= createSendStore()
  return store
}
