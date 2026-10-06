// A server-side job list mirrored in this tab («Envíos», «Copias»): the jobs of the signed-in user, kept by the server
// (they go on without the browser) and mirrored here from GET <url> and the SSE events. Outside React, like the upload
// queue.

export interface JobLike { id: string; state: string; createdAt: string }

export interface JobStore<T extends JobLike> {
  snapshot(): readonly T[]
  subscribe(fn: () => void): () => void
  /** Reads the list from the server (on mount, after a reconnection). */
  sync(): Promise<void>
  /** An SSE event, or the answer of a start. */
  apply(job: T): void
  cancel(id: string): Promise<string | null>
  clearFinished(): Promise<void>
}

export function createJobStore<T extends JobLike>(url: string, finished: ReadonlySet<string>, what: { cancelError: string; offline: string }, fetcher: typeof fetch = (...a) => fetch(...a)): JobStore<T> {
  let jobs = new Map<string, T>()
  let snap: readonly T[] = []
  const listeners = new Set<() => void>()
  const isDone = (j: T) => finished.has(j.state)
  const emit = () => {
    snap = [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const l of [...listeners]) l()
  }
  const opts: RequestInit = { credentials: "same-origin", cache: "no-store" }
  return {
    snapshot: () => snap,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async sync() {
      try {
        const r = await fetcher(url, opts)
        if (!r.ok) return
        const body = (await r.json()) as { jobs?: T[] }
        jobs = new Map((body.jobs ?? []).map((j) => [j.id, j]))
        emit()
      } catch {
        // offline: keep what is shown; the next reconnection syncs again
      }
    },
    apply(job) {
      const cur = jobs.get(job.id)
      // Events can arrive out of order with the start answer: never go back from a finished state.
      if (cur && isDone(cur) && !isDone(job)) return
      jobs.set(job.id, job)
      emit()
    },
    async cancel(id) {
      try {
        const r = await fetcher(`${url}/${id}`, { ...opts, method: "DELETE" })
        if (r.ok || r.status === 404) return null
        const body = (await r.json().catch(() => ({}))) as { message?: string }
        return body.message ?? what.cancelError
      } catch {
        return what.offline
      }
    },
    async clearFinished() {
      for (const [id, j] of jobs) if (isDone(j)) jobs.delete(id)
      emit()
      await fetcher(url, { ...opts, method: "DELETE" }).catch(() => undefined)
    },
  }
}
