// «Copias» of this tab: the copies to server folders of the signed-in administrator (see job-store.ts).
import { FILES_API, type CopyJobDTO } from "@/lib/contracts/files"
import { createJobStore, type JobStore } from "./job-store"

const FINISHED = new Set<CopyJobDTO["state"]>(["done", "skipped", "error", "canceled"])
export const isCopyFinished = (j: CopyJobDTO) => FINISHED.has(j.state)

export function createCopyStore(fetcher?: typeof fetch): JobStore<CopyJobDTO> {
  return createJobStore<CopyJobDTO>(FILES_API.copy, FINISHED, { cancelError: "No se ha podido cancelar.", offline: "No se ha podido cancelar: sin conexión con el servidor." }, fetcher)
}

let store: JobStore<CopyJobDTO> | null = null
export function copyStore(): JobStore<CopyJobDTO> {
  store ??= createCopyStore()
  return store
}
