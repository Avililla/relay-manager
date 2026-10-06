"use client"

import * as React from "react"
import { useServerEvents } from "@/components/providers/events-provider"
import type { FilesListingDTO, FilesPageDTO, FilesPageErrorKind, FilesRootId } from "@/lib/contracts/files"
import { loginRedirect } from "@/lib/client/action-result"
import { onUploadFinished } from "@/lib/files/upload-store"
import { affectsFolder, listUrl } from "@/lib/files/view"
import { filesUi as t } from "@/lib/i18n/files"

export type ListingError = { kind: FilesPageErrorKind; message: string }
type Fetched = { kind: "ok"; listing: FilesListingDTO } | { kind: "error"; error: ListingError; network: boolean } | { kind: "redirect"; to: string }

async function fetchListing(root: FilesRootId, path: string): Promise<Fetched> {
  let res: Response
  try {
    res = await fetch(listUrl(path, root), { credentials: "same-origin", cache: "no-store" })
  } catch {
    return { kind: "error", network: true, error: { kind: "unavailable", message: t.loadError } }
  }
  if (res.status === 401) return { kind: "redirect", to: loginRedirect(window.location.pathname + window.location.search) }
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // not JSON (server restarting)
  }
  if (res.ok) return { kind: "ok", listing: body as unknown as FilesListingDTO }
  if (res.status === 403 && body.error === "PASSWORD_CHANGE_REQUIRED") return { kind: "redirect", to: "/cuenta?cambiar=1" }
  const message = typeof body.message === "string" ? body.message : t.loadError
  const kind: FilesPageErrorKind = res.status === 404 && body.error === "NOT_FOUND" ? "not-found"
    : body.notDir === true ? "not-dir"
    : res.status === 400 ? "invalid"
    : "unavailable"
  return { kind: "error", network: res.status >= 500 && res.status !== 503 && res.status !== 507, error: { kind, message } }
}

const REFRESH_DEBOUNCE_MS = 250
const POLL_MS = 30_000

/** "extra\0a/b": the root and the folder shown, as one key. */
const keyOf = (root: FilesRootId, path: string) => `${root}\0${path}`

/**
 * The listing of the folder in the address (`?raiz=`, `?ruta=`). Starts from the server-rendered listing; afterwards it is read
 * from /api/files/list: on navigation, on `files.changed` for this folder (someone else uploaded, renamed…), when an
 * upload of ours finishes, when the window gets focus, after an SSE reconnection and every 30 s while visible (files
 * copied to the folder by other means).
 */
export function useFilesListing(initial: FilesPageDTO, root: FilesRootId, path: string) {
  const [state, setState] = React.useState<{ key: string; root: FilesRootId; path: string; listing: FilesListingDTO | null; error: ListingError | null }>(
    () => ({ key: keyOf(initial.root, initial.path), root: initial.root, path: initial.path, listing: initial.listing, error: initial.error }),
  )
  const key = keyOf(root, path)
  const pathRef = React.useRef(path)
  const rootRef = React.useRef(root)
  const errorRef = React.useRef<ListingError | null>(state.error)
  const seq = React.useRef(0)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = React.useCallback(async (rt: FilesRootId, p: string, quiet: boolean) => {
    // Background refreshes leave a missing folder alone (only the button or a navigation reads it again).
    if (quiet && errorRef.current && errorRef.current.kind !== "unavailable") return
    const my = ++seq.current
    const r = await fetchListing(rt, p)
    if (my !== seq.current) return
    if (r.kind === "redirect") {
      window.location.assign(r.to)
      return
    }
    if (r.kind === "error" && quiet && r.network) return // keep what is shown; the next refresh will tell
    const k = keyOf(rt, p)
    setState(r.kind === "ok" ? { key: k, root: rt, path: p, listing: r.listing, error: null } : { key: k, root: rt, path: p, listing: null, error: r.error })
  }, [])

  React.useEffect(() => {
    pathRef.current = path
    rootRef.current = root
    errorRef.current = state.error
    if (state.key !== key) void load(root, path, false)
  }, [root, path, key, state.key, state.error, load])

  const schedule = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void load(rootRef.current, pathRef.current, true) }, REFRESH_DEBOUNCE_MS)
  }, [load])

  useServerEvents(["files.changed", "hello"], (e) => {
    if (e.type === "hello" || (e.type === "files.changed" && affectsFolder(e, pathRef.current, rootRef.current))) schedule()
  })

  React.useEffect(() => {
    const off = onUploadFinished((item) => { if (item.root === rootRef.current && item.dir === pathRef.current) schedule() })
    const onFocus = () => schedule()
    const onVisible = () => { if (document.visibilityState === "visible") schedule() }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)
    const poll = setInterval(() => { if (document.visibilityState === "visible") void load(rootRef.current, pathRef.current, true) }, POLL_MS)
    return () => {
      off()
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
      clearInterval(poll)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [schedule, load])

  const refresh = React.useCallback(() => load(rootRef.current, pathRef.current, false), [load])
  return { ...state, loading: state.key !== key, refresh }
}
