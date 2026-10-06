"use client"

import * as React from "react"
import {
  ArrowUpIcon, CheckIcon, CopyIcon, ArrowUpFromLineIcon, FileIcon, FolderIcon, FolderPlusIcon, HardDriveIcon, Link2Icon, LoaderCircleIcon, LockIcon,
  RefreshCwIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon, UsbIcon,
} from "lucide-react"
import { toast } from "sonner"
import { FormField } from "@/components/common/form-field"
import { InlineAlert } from "@/components/common/inline-alert"
import { StatusChip } from "@/components/common/status-chip"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { SimpleTooltip } from "@/components/ui/tooltip"
import {
  DEFAULT_FILES_ROOT, FILES_API, type CopyBrowseDTO, type CopyConflict, type CopyDeviceDTO, type CopyDriveDTO, type CopyElevationDTO,
  type CopyInfoDTO, type CopyJobDTO, type CopyMountResultDTO, type CopyUnmountResultDTO, type FilesRootId,
} from "@/lib/contracts/files"
import { copyStore } from "@/lib/files/copy-store"
import { validateNewName } from "@/lib/files/names"
import { copyUi as t } from "@/lib/i18n/copy"
import { formatBytes, formatTime } from "@/lib/i18n/format"
import { cn } from "@/lib/client/cn"

/** A file of a root of Archivos (`root` defaults to tftp). */
export interface CopyItem { path: string; name: string; root?: FilesRootId }

interface ApiError { status: number; message: string; field?: string; needsRoot?: boolean; needsPassword?: boolean; hint?: string }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response
  try {
    r = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init, headers: init?.body ? { "content-type": "application/json" } : undefined })
  } catch {
    throw { status: 0, message: "Sin conexión con el servidor." } satisfies ApiError
  }
  if (r.status === 204) return {} as T
  const body = (await r.json().catch(() => ({}))) as T & { message?: string; field?: string; needsRoot?: boolean; needsPassword?: boolean; hint?: string }
  if (!r.ok) {
    throw {
      status: r.status, message: body.message ?? t.loadError, field: body.field, needsRoot: body.needsRoot, needsPassword: body.needsPassword, hint: body.hint,
    } satisfies ApiError
  }
  return body
}
const isApiError = (e: unknown): e is ApiError => typeof e === "object" && e !== null && "status" in e && "message" in e
/** The server wants the sudo password (none given and no elevation, or it expired). */
const wantsPassword = (e: ApiError) => e.needsPassword === true || e.field === "password"

function crumbsOf(p: string): Array<{ name: string; path: string }> {
  const segs = p.split("/").filter(Boolean)
  return segs.map((s, i) => ({ name: s, path: `/${segs.slice(0, i + 1).join("/")}` }))
}
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`)
const within = (p: string, dir: string) => p === dir || p.startsWith(dir === "/" ? "/" : `${dir}/`)

function DriveCard({ d, current, onPick, onEject, ejecting }: { d: CopyDriveDTO; current: boolean; onPick: () => void; onEject: (() => void) | null; ejecting: boolean }) {
  const used = d.totalBytes && d.freeBytes !== null ? ((d.totalBytes - d.freeBytes) / d.totalBytes) * 100 : null
  const Icon = d.removable ? UsbIcon : HardDriveIcon
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-2.5 tint-transition hover:border-control-border",
        current && "border-brand bg-brand-tint",
      )}
      data-drive={d.mountPoint}
    >
      <button type="button" onClick={onPick} aria-pressed={current} className="flex min-w-0 flex-col gap-1.5 text-left">
        <span className="flex w-full min-w-0 items-center gap-2">
          <Icon aria-hidden className="size-4 shrink-0 text-brand" />
          <span className="min-w-0 flex-1 truncate text-body font-semibold text-foreground">{d.label}</span>
          <span className="shrink-0 font-mono text-meta text-muted-foreground">{d.fsType}</span>
        </span>
        <span className="truncate font-mono text-data text-muted-foreground" title={d.mountPoint}>{d.mountPoint}</span>
        {used !== null ? <Progress value={used} aria-label={t.freeOf(d.freeBytes, d.totalBytes)} /> : null}
      </button>
      <span className="flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
        <span className="tabular-nums">{t.freeOf(d.freeBytes, d.totalBytes)}</span>
        {d.removable ? <StatusChip tone="brand" quiet>{t.removable}</StatusChip> : null}
        {d.readOnly ? <StatusChip tone="warn" quiet>{t.readOnly}</StatusChip> : !d.writable ? <StatusChip tone="neutral" icon={LockIcon} quiet>{t.serviceNoAccess}</StatusChip> : null}
        <span className="flex-1" />
        {onEject ? (
          <Button type="button" size="sm" variant="ghost" onClick={onEject} pending={ejecting} aria-label={t.ejectLabel(d.label)} data-eject={d.mountPoint}>
            {ejecting ? null : <ArrowUpFromLineIcon aria-hidden />}{ejecting ? t.ejecting : t.eject}
          </Button>
        ) : null}
      </span>
    </div>
  )
}

function DeviceRow({ d, onMount, mounting, disabled }: { d: CopyDeviceDTO; onMount: () => void; mounting: boolean; disabled: boolean }) {
  const label = d.label ?? d.uuid ?? d.device
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md border bg-card px-2.5 py-1.5" data-device={d.device}>
      <UsbIcon aria-hidden className={cn("size-4 shrink-0", d.problem ? "text-faint-foreground" : "text-brand")} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate text-body font-medium", d.problem ? "text-muted-foreground" : "text-foreground")}>{label}</span>
          <span className="shrink-0 font-mono text-meta text-muted-foreground">{d.fsType ?? t.deviceUnknown}</span>
        </span>
        <span className="truncate text-meta text-muted-foreground">
          {[d.device, d.sizeBytes !== null ? formatBytes(d.sizeBytes) : null, d.model].filter(Boolean).join(" · ")}
        </span>
        {d.problem ? <span className="text-meta text-foreground">{d.problem}</span> : null}
      </span>
      {d.problem ? null : (
        <Button type="button" size="sm" variant="outline" onClick={onMount} pending={mounting} disabled={disabled} aria-label={t.mountLabel(label)}>
          {mounting ? t.mounting : t.mount}
        </Button>
      )}
    </li>
  )
}

type SudoAction = { kind: "mount"; device: string; label: string } | { kind: "unmount"; mountPoint: string; label: string }

/**
 * «Copiar a una carpeta del servidor…» (administrators): the drives first («Unidades USB y discos»: mounted ones with
 * «Expulsar», unmounted USB sticks with «Montar»), then a folder browser of the server (breadcrumb, editable path,
 * hidden folders, folders and files, writable or not), «Nueva carpeta», what to do with a name that exists, and —
 * when the service cannot read or write there — the password of the bench's sudo user. A right password elevates this
 * browser session for 5 minutes (the server keeps the helper's token; the browser only learns until when): meanwhile
 * protected folders open, and copies, new folders, mounting and ejecting go as administrator without asking again.
 * «Olvidar permisos» ends it. Progress goes to the «Copias» panel.
 */
export function CopyDialog({ items, onClose }: { items: CopyItem[] | null; onClose: () => void }) {
  const open = !!items?.length
  const [forItems, setForItems] = React.useState<CopyItem[] | null>(null)
  const [info, setInfo] = React.useState<CopyInfoDTO | null>(null)
  const [infoError, setInfoError] = React.useState<string | null>(null)
  const [listing, setListing] = React.useState<CopyBrowseDTO | null>(null)
  const [listError, setListError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [location, setLocation] = React.useState("/")
  const [hidden, setHidden] = React.useState(false)
  const [conflict, setConflict] = React.useState<CopyConflict>("keep")
  const [asRoot, setAsRoot] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [passwordError, setPasswordError] = React.useState<string | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [mkdirOpen, setMkdirOpen] = React.useState(false)
  const [folderName, setFolderName] = React.useState("")
  const [folderError, setFolderError] = React.useState<string | null>(null)
  const [elevation, setElevationState] = React.useState<CopyElevationDTO | null>(null)
  const [sudoAction, setSudoAction] = React.useState<SudoAction | null>(null)
  const [driveBusy, setDriveBusy] = React.useState<string | null>(null)
  const [driveError, setDriveError] = React.useState<string | null>(null)
  const seq = React.useRef(0)
  const passwordRef = React.useRef<HTMLInputElement>(null)
  const sudoRef = React.useRef<HTMLInputElement>(null)
  // A plain HTTP page sends the sudo password unencrypted. (Only shown inside the open dialog, never in the server
  // render, which has no window: no hydration difference.)
  const [insecure] = React.useState(() => typeof window !== "undefined" && window.location.protocol === "http:")

  /** Every answer says how the elevation stands now; once elevated, the typed password is not needed any more. */
  const setElevation = React.useCallback((e: CopyElevationDTO | null) => {
    setElevationState(e)
    if (e) {
      setPassword("")
      setPasswordError(null)
    }
  }, [])

  if (items !== forItems) {
    setForItems(items)
    setInfo(null)
    setInfoError(null)
    setListing(null)
    setListError(null)
    setAsRoot(false)
    setPassword("")
    setPasswordError(null)
    setFormError(null)
    setMkdirOpen(false)
    setSudoAction(null)
    setDriveError(null)
  }

  // The elevation ends at `until` (the server drops it then too): forget it here at that moment.
  React.useEffect(() => {
    if (!elevation) return
    const ms = Date.parse(elevation.until) - Date.now()
    if (!(ms > 0)) {
      setElevationState(null)
      return
    }
    const id = setTimeout(() => setElevationState(null), Math.min(ms, 2 ** 31 - 1))
    return () => clearTimeout(id)
  }, [elevation])
  const elevated = !!elevation

  const browse = React.useCallback(async (dir: string, opts: { hidden?: boolean; password?: string } = {}) => {
    const n = ++seq.current
    setLoading(true)
    setListError(null)
    setLocation(dir)
    try {
      const h = opts.hidden ?? hidden
      // With a password: as root (and this session is elevated afterwards). Without: as the service, and the server
      // itself lists through the helper when the folder is protected and the session is elevated.
      const l = opts.password
        ? await api<CopyBrowseDTO>(FILES_API.copyBrowse, { method: "POST", body: JSON.stringify({ path: dir, hidden: h, password: opts.password }) })
        : await api<CopyBrowseDTO>(`${FILES_API.copyBrowse}?path=${encodeURIComponent(dir)}${h ? "&hidden=1" : ""}`)
      if (n !== seq.current) return
      setListing(l)
      setLocation(l.path)
      setElevation(l.elevation)
      setMkdirOpen(false)
      if (opts.password) setPasswordError(null)
    } catch (e) {
      if (n !== seq.current) return
      const err = isApiError(e) ? e : { status: 0, message: t.loadError }
      if (wantsPassword(err)) {
        setElevationState(null)
        setPasswordError(err.message)
        passwordRef.current?.focus()
      } else setListError(err.message)
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }, [hidden, setElevation])

  const loadInfo = React.useCallback(async (): Promise<CopyInfoDTO | null> => {
    try {
      const i = await api<CopyInfoDTO>(FILES_API.copyInfo)
      setInfo(i)
      setInfoError(null)
      setElevationState(i.elevation)
      return i
    } catch (e) {
      setInfoError(isApiError(e) ? e.message : t.loadError)
      return null
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    let stop = false
    void loadInfo().then((i) => {
      if (stop || !i) return
      // The first USB stick (even one only root can open: the dialog then asks for the sudo password), else a disk.
      const start = i.drives.find((d) => d.removable)?.mountPoint ?? i.drives[0]?.mountPoint ?? i.roots[0] ?? "/"
      void browse(start)
    })
    return () => { stop = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open, forItems])

  if (!items?.length) return null
  const sourceRoot = items[0].root ?? DEFAULT_FILES_ROOT
  const multi = items.length > 1
  const root = info?.root ?? null
  const dest = listing?.path ?? location
  const rootPossible = !!root?.available && !!listing && !listing.denied && listing.rootWritable
  const needsRoot = !!listing && !listing.denied && !listing.writable
  const willUseRoot = rootPossible && (asRoot || needsRoot)
  const passwordOk = elevated || password.length > 0
  const canSubmit = !!listing && !listing.denied && !loading && (listing.writable || willUseRoot) && (!willUseRoot || passwordOk)
  const askElevation = !!listing && !listing.readable && !elevated && (listing.needsElevation || (!!root?.available && listing.rootWritable))
  const mountAvailable = !!info?.mount.available
  const sudoPw = (): string | null => (elevated ? null : password || null)

  /** A request that needs the sudo password failed for lack of it: the elevation is gone, ask again. */
  function passwordNeeded(err: ApiError, where: "copy" | "drive"): void {
    setElevationState(null)
    if (where === "drive") {
      setDriveError(err.message)
      sudoRef.current?.focus()
    } else {
      setPasswordError(err.message)
      passwordRef.current?.focus()
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!items || !listing || !canSubmit) return
    setBusy(true)
    setFormError(null)
    setPasswordError(null)
    try {
      const r = await api<{ jobs: CopyJobDTO[]; elevation?: CopyElevationDTO | null }>(FILES_API.copy, {
        method: "POST",
        body: JSON.stringify({
          root: sourceRoot, paths: items.map((i) => i.path), destDir: listing.path, conflict, asRoot: willUseRoot, password: willUseRoot ? sudoPw() : null,
        }),
      })
      for (const j of r.jobs) copyStore().apply(j)
      setPassword("")
      onClose()
    } catch (err) {
      const x = isApiError(err) ? err : { status: 0, message: "No se ha podido copiar." }
      if (wantsPassword(x)) passwordNeeded(x, "copy")
      else if (x.needsRoot) {
        setAsRoot(true)
        setFormError(x.message)
      } else setFormError(x.hint ? `${x.message} ${x.hint}` : x.message)
    } finally {
      setBusy(false)
    }
  }

  async function createFolder() {
    if (!listing) return
    const why = validateNewName(folderName)
    if (why) {
      setFolderError(why)
      return
    }
    const viaRoot = willUseRoot || (!listing.writable && rootPossible)
    if (viaRoot && !passwordOk) {
      setFolderError(null)
      setPasswordError(t.sudoPrompt(root?.user ?? null))
      passwordRef.current?.focus()
      return
    }
    try {
      const r = await api<{ path: string; elevation?: CopyElevationDTO | null }>(FILES_API.copyMkdir, {
        method: "POST",
        body: JSON.stringify({ dir: listing.path, name: folderName, asRoot: viaRoot, password: viaRoot ? sudoPw() : null }),
      })
      if (r.elevation !== undefined) setElevation(r.elevation)
      toast.success(t.created(folderName))
      setFolderName("")
      setFolderError(null)
      setMkdirOpen(false)
      void browse(r.path)
    } catch (err) {
      const x = isApiError(err) ? err : { status: 0, message: t.loadError }
      if (wantsPassword(x)) passwordNeeded(x, "copy")
      else setFolderError(x.message)
    }
  }

  /** «Montar» / «Expulsar»: at once while elevated, else after the password typed in the prompt. */
  async function runDrive(action: SudoAction, pw: string | null) {
    const key = action.kind === "mount" ? action.device : action.mountPoint
    setDriveBusy(key)
    setDriveError(null)
    try {
      if (action.kind === "mount") {
        const r = await api<CopyMountResultDTO>(FILES_API.copyMount, { method: "POST", body: JSON.stringify({ device: action.device, password: pw }) })
        setElevation(r.elevation)
        setSudoAction(null)
        toast.success(t.mounted(action.label, r.mountPoint), r.serviceWritable ? undefined : { description: t.mountedRootOnly })
        await loadInfo()
        void browse(r.mountPoint)
      } else {
        const r = await api<CopyUnmountResultDTO>(FILES_API.copyUnmount, { method: "POST", body: JSON.stringify({ mountPoint: action.mountPoint, password: pw }) })
        setElevation(r.elevation)
        setSudoAction(null)
        toast.success(t.ejected(r.mountPoint))
        const i = await loadInfo()
        if (within(dest, r.mountPoint)) {
          const next = i?.drives.find((d) => d.removable)?.mountPoint ?? i?.drives[0]?.mountPoint ?? i?.roots[0] ?? "/"
          void browse(next)
        }
      }
    } catch (err) {
      const x = isApiError(err) ? err : { status: 0, message: t.loadError }
      if (wantsPassword(x)) {
        setSudoAction(action)
        passwordNeeded(x, "drive")
      } else setDriveError(x.message)
    } finally {
      setDriveBusy(null)
    }
  }
  function askDrive(action: SudoAction) {
    setDriveError(null)
    if (elevated) void runDrive(action, null)
    else {
      setSudoAction(action)
      setTimeout(() => sudoRef.current?.focus(), 0)
    }
  }

  async function forget() {
    try {
      await api<Record<string, never>>(FILES_API.copyElevation, { method: "DELETE" })
      setElevationState(null)
      toast.success(t.forgotten)
      if (listing) void browse(listing.path)
    } catch (err) {
      toast.error(isApiError(err) ? err.message : t.loadError)
    }
  }

  const drives = info?.drives ?? []
  const devices = info?.devices ?? []

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) { setPassword(""); onClose() } }}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={submit} className="grid min-w-0 gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t.title(items.length, items[0].name)}</DialogTitle>
            <DialogDescription>{t.description}</DialogDescription>
          </DialogHeader>
          {multi ? (
            <ul className="max-h-20 overflow-y-auto rounded-md border px-3 py-2 font-mono text-data text-foreground">
              {items.map((i) => <li key={i.path} className="truncate">{i.name}</li>)}
            </ul>
          ) : null}

          {infoError ? <InlineAlert tone="danger">{infoError}</InlineAlert> : null}

          {elevation ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-warn/50 bg-warn-tint/40 px-3 py-2" role="status" data-testid="copy-elevation">
              <ShieldCheckIcon aria-hidden className="size-4 shrink-0 text-warn" />
              <span className="min-w-0 flex-1 text-meta text-foreground">
                <span className="font-medium">{t.elevatedUntil(formatTime(elevation.until))}</span>
                <span className="text-muted-foreground"> · {elevation.user}</span>
                <span className="block text-muted-foreground">{t.elevatedHelp}</span>
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => void forget()}><ShieldOffIcon aria-hidden />{t.forget}</Button>
            </div>
          ) : null}

          <section aria-labelledby="copy-drives" className="flex min-w-0 flex-col gap-2">
            <h3 id="copy-drives" className="text-body font-medium text-foreground">{t.drives}</h3>
            {info === null && !infoError ? (
              <p className="flex items-center gap-2 text-meta text-muted-foreground" role="status">
                <LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />{t.drivesLoading}
              </p>
            ) : info && drives.length === 0 && devices.length === 0 ? (
              <p className="text-meta text-muted-foreground">{t.drivesEmpty}</p>
            ) : info ? (
              <>
                {drives.length ? (
                  <div className="grid max-h-44 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                    {drives.map((d) => (
                      <DriveCard
                        key={d.mountPoint}
                        d={d}
                        current={within(dest, d.mountPoint)}
                        onPick={() => void browse(d.mountPoint)}
                        onEject={d.ejectable && mountAvailable ? () => askDrive({ kind: "unmount", mountPoint: d.mountPoint, label: d.label }) : null}
                        ejecting={driveBusy === d.mountPoint}
                      />
                    ))}
                  </div>
                ) : null}
                {devices.length ? (
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <p className="text-meta text-muted-foreground"><span className="font-medium text-foreground">{t.devices}</span> · {t.devicesHelp}</p>
                    <ul className="flex max-h-36 flex-col gap-1.5 overflow-y-auto" aria-label={t.devices}>
                      {devices.map((d) => (
                        <DeviceRow
                          key={d.device}
                          d={d}
                          mounting={driveBusy === d.device}
                          disabled={!mountAvailable || driveBusy !== null}
                          onMount={() => askDrive({ kind: "mount", device: d.device, label: d.label ?? d.uuid ?? d.device })}
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}
                {devices.length && !mountAvailable && info.mount.problem ? (
                  <InlineAlert tone="info" title={t.mountUnavailable}>{info.mount.problem}</InlineAlert>
                ) : null}
              </>
            ) : null}
            {sudoAction && !elevated ? (
              <div className="flex min-w-0 flex-wrap items-end gap-2 rounded-md border border-warn/50 bg-warn-tint/40 p-2.5" role="group" aria-label={t.sudoFor(sudoAction.label)}>
                <FormField
                  label={t.sudoFor(sudoAction.kind === "mount" ? `${t.mount.toLowerCase()} «${sudoAction.label}»` : `${t.eject.toLowerCase()} «${sudoAction.label}»`)}
                  error={driveError}
                  help={t.passwordHelp(root?.user ?? null)}
                  className="min-w-52 flex-1"
                >
                  <Input
                    ref={sudoRef}
                    type="password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setDriveError(null) }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        if (password) void runDrive(sudoAction, password)
                      }
                    }}
                    autoComplete="off"
                    maxLength={512}
                    data-testid="copy-sudo-password"
                  />
                </FormField>
                <Button type="button" variant="primary" disabled={!password} pending={driveBusy !== null} onClick={() => void runDrive(sudoAction, password)}>{t.confirm}</Button>
                <Button type="button" variant="ghost" onClick={() => { setSudoAction(null); setDriveError(null) }}>{t.cancel}</Button>
                {insecure ? (
                  <p className="flex w-full items-start gap-1.5 text-meta text-foreground" role="note">
                    <ShieldAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />{t.insecure}
                  </p>
                ) : null}
              </div>
            ) : driveError ? <InlineAlert tone="danger" role="alert">{driveError}</InlineAlert> : null}
          </section>

          <section aria-labelledby="copy-folders" className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="copy-folders" className="text-body font-medium text-foreground">{t.folders}</h3>
              <span className="flex-1" />
              <div className="flex items-center gap-2">
                <Switch
                  id="copy-hidden"
                  checked={hidden}
                  onCheckedChange={(v) => {
                    setHidden(v)
                    if (listing) void browse(listing.path, { hidden: v })
                  }}
                />
                <Label htmlFor="copy-hidden" className="text-meta font-normal">{t.showHidden}</Label>
              </div>
            </div>
            <nav aria-label={t.location} className="flex min-w-0 flex-wrap items-center gap-0.5 text-meta">
              <Button type="button" size="sm" variant="ghost" onClick={() => void browse("/")} aria-label={t.root}>/</Button>
              {crumbsOf(dest).map((c, i, all) => (
                <React.Fragment key={c.path}>
                  {i > 0 ? <span aria-hidden className="text-faint-foreground">/</span> : null}
                  <Button type="button" size="sm" variant="ghost" aria-current={i === all.length - 1 ? "location" : undefined} onClick={() => void browse(c.path)} className="max-w-40">
                    <span className="truncate">{c.name}</span>
                  </Button>
                </React.Fragment>
              ))}
            </nav>
            <div className="flex min-w-0 items-center gap-1.5">
              <Input
                aria-label={t.location}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void browse(location.trim() || "/")
                  }
                }}
                className="min-w-0 flex-1 font-mono"
                spellCheck={false}
                autoComplete="off"
                data-testid="copy-location"
              />
              <Button type="button" size="sm" variant="outline" onClick={() => void browse(location.trim() || "/")}>{t.go}</Button>
              <SimpleTooltip label={t.up}>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t.up} disabled={!listing?.parent} onClick={() => { if (listing?.parent) void browse(listing.parent) }}>
                  <ArrowUpIcon aria-hidden />
                </Button>
              </SimpleTooltip>
              <SimpleTooltip label={t.retry}>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t.retry} onClick={() => void browse(listing?.path ?? location)}>
                  <RefreshCwIcon aria-hidden className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />
                </Button>
              </SimpleTooltip>
            </div>

            <ul className="flex max-h-52 min-h-24 flex-col overflow-y-auto rounded-md border" aria-busy={loading} aria-label={t.listLabel}>
              {listError ? (
                <li className="px-3 py-2 text-meta text-foreground" role="alert">{listError}</li>
              ) : !listing ? (
                <li className="flex items-center gap-2 px-3 py-2 text-muted-foreground"><LoaderCircleIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />…</li>
              ) : !listing.readable ? (
                <li className="flex flex-col gap-2 px-3 py-2 text-meta text-foreground" data-testid="copy-needs-admin">
                  <span className="flex items-center gap-1.5 font-medium"><LockIcon aria-hidden className="size-3.5 text-warn" />{askElevation ? t.needsAdmin : t.cannotRead}</span>
                  {askElevation ? (
                    <>
                      <span className="text-muted-foreground">{t.needsAdminHelp(root?.user ?? null)}</span>
                      <div className="flex min-w-0 flex-wrap items-end gap-2">
                        <FormField label={t.password} error={passwordError} help={t.passwordHelp(root?.user ?? null)} className="min-w-52 flex-1">
                          <Input
                            ref={passwordRef}
                            type="password"
                            value={password}
                            onChange={(e) => { setPassword(e.target.value); setPasswordError(null) }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault()
                                if (password) void browse(listing.path, { password })
                              }
                            }}
                            autoComplete="off"
                            maxLength={512}
                            data-testid="copy-password"
                          />
                        </FormField>
                        <Button type="button" variant="outline" disabled={!password} pending={loading} onClick={() => void browse(listing.path, { password })}>
                          {t.browseAsRoot}
                        </Button>
                      </div>
                      {insecure ? (
                        <p className="flex items-start gap-1.5 text-meta text-foreground" role="note">
                          <ShieldAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />{t.insecure}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </li>
              ) : listing.folders.length === 0 && listing.files.length === 0 ? (
                <li className="px-3 py-2 text-meta text-muted-foreground">{t.emptyFolder}</li>
              ) : (
                <>
                  {listing.folders.map((f) => (
                    <li key={`d:${f.name}`}>
                      <button
                        type="button"
                        onClick={() => void browse(join(listing.path, f.name))}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body hover:bg-secondary focus-visible:bg-secondary"
                        data-folder={f.name}
                      >
                        <FolderIcon aria-hidden className={cn("size-4 shrink-0", f.hidden ? "text-faint-foreground" : "text-brand")} />
                        <span className="min-w-0 truncate">{f.name}</span>
                        {f.link ? <Link2Icon aria-label="Enlace simbólico" className="size-3.5 shrink-0 text-faint-foreground" /> : null}
                      </button>
                    </li>
                  ))}
                  {listing.files.map((f) => (
                    <li key={`f:${f.name}`} className="flex items-center gap-2 px-3 py-1 text-body text-muted-foreground" data-file={f.name} title={t.fileReadOnly}>
                      <FileIcon aria-hidden className="size-4 shrink-0 text-faint-foreground" />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      {f.link ? <Link2Icon aria-label="Enlace simbólico" className="size-3.5 shrink-0 text-faint-foreground" /> : null}
                      {f.size !== null ? <span className="shrink-0 font-mono text-data tabular-nums">{formatBytes(f.size)}</span> : null}
                    </li>
                  ))}
                </>
              )}
              {listing?.truncated ? <li className="px-3 py-2 text-meta text-muted-foreground">{t.truncated}</li> : null}
            </ul>

            {listing ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-meta">
                <span className="text-muted-foreground">{t.destination}:</span>
                <span className="min-w-0 truncate font-mono text-data text-foreground" data-testid="copy-dest">{listing.path}</span>
                {listing.asRoot ? <StatusChip tone="warn" icon={ShieldCheckIcon} quiet>{t.asRootBadge(elevation?.user ?? root?.user ?? null)}</StatusChip> : null}
                {listing.denied ? null : listing.writable ? (
                  <StatusChip tone="ok" icon={CheckIcon} quiet>{t.folderWritable}</StatusChip>
                ) : (
                  <StatusChip tone="warn" icon={ShieldAlertIcon} quiet>{t.folderNeedsRoot}</StatusChip>
                )}
                {listing.freeBytes !== null ? <span className="tabular-nums text-muted-foreground">{t.freeOf(listing.freeBytes, listing.totalBytes)}</span> : null}
                {listing.readable && listing.files.length ? <span className="text-muted-foreground">{t.files(listing.files.length)}</span> : null}
                <span className="flex-1" />
                {!listing.denied && (listing.writable || rootPossible) ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => { setMkdirOpen((o) => !o); setFolderError(null) }} aria-expanded={mkdirOpen}>
                    <FolderPlusIcon aria-hidden />{t.newFolder}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {listing?.denied ? <InlineAlert tone="warn">{t.denied(listing.denied)}</InlineAlert> : null}
            {mkdirOpen && listing ? (
              <div className="flex min-w-0 items-start gap-2 rounded-md border p-2.5">
                <FormField label={t.folderName} error={folderError} help={t.newFolderIn(listing.path)} className="min-w-0 flex-1">
                  <Input
                    value={folderName}
                    autoFocus
                    onChange={(e) => { setFolderName(e.target.value); setFolderError(null) }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void createFolder()
                      }
                    }}
                    maxLength={255}
                    autoComplete="off"
                  />
                </FormField>
                <Button type="button" size="md" variant="default" className="mt-6" onClick={() => void createFolder()}>{t.create}</Button>
              </div>
            ) : null}
          </section>

          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1.5 text-body font-medium text-foreground">{t.conflict}</legend>
            <RadioGroup value={conflict} onValueChange={(v) => setConflict(v as CopyConflict)} className="flex flex-wrap gap-x-5 gap-y-2" aria-describedby="copy-conflict-help">
              {(["replace", "keep", "skip"] as const).map((c) => (
                <div key={c} className="flex items-center gap-2">
                  <RadioGroupItem value={c} id={`copy-conflict-${c}`} />
                  <Label htmlFor={`copy-conflict-${c}`} className="font-normal">{t.conflicts[c]}</Label>
                </div>
              ))}
            </RadioGroup>
            <p id="copy-conflict-help" className="text-meta text-muted-foreground">{t.conflictHelp[conflict]}</p>
          </fieldset>

          {root && listing && listing.readable && !listing.denied && (needsRoot || asRoot || listing.asRoot) ? (
            root.available && listing.rootWritable ? (
              <section aria-labelledby="copy-root" className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-warn/50 bg-warn-tint/40 p-3">
                <div className="flex items-start gap-3">
                  <ShieldCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <h3 id="copy-root" className="text-body font-medium text-foreground">{t.asRootTitle(elevation?.user ?? root.user)}</h3>
                    <p className="text-meta text-muted-foreground">{needsRoot ? t.asRootNeeded : t.asRootChosen}</p>
                  </div>
                  {!needsRoot ? (
                    <Switch checked={asRoot} onCheckedChange={setAsRoot} aria-label={t.useRoot} />
                  ) : null}
                </div>
                {willUseRoot && !elevated ? (
                  <FormField label={t.password} error={passwordError} help={t.passwordHelp(root.user)} className="min-w-52">
                    <Input
                      ref={passwordRef}
                      type="password"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setPasswordError(null) }}
                      autoComplete="off"
                      maxLength={512}
                      data-testid="copy-password"
                    />
                  </FormField>
                ) : null}
                {willUseRoot && !elevated && insecure ? (
                  <p className="flex items-start gap-1.5 text-meta text-foreground" role="note">
                    <ShieldAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />{t.insecure}
                  </p>
                ) : null}
              </section>
            ) : needsRoot ? (
              <InlineAlert tone="info" title={t.asRootUnavailable}>
                {root.available ? t.asRootOutside(root.writePaths.join(", ")) : root.problem}
                {!root.available && root.hint ? <span className="mt-1 block font-mono text-data">{root.hint}</span> : null}
              </InlineAlert>
            ) : null
          ) : null}

          {formError ? <InlineAlert tone="danger" role="alert">{formError}</InlineAlert> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => { setPassword(""); onClose() }} disabled={busy}>{t.cancel}</Button>
            <Button type="submit" variant="primary" pending={busy} disabled={!canSubmit}>
              {willUseRoot ? <ShieldCheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              {willUseRoot ? t.copyAsRoot : t.copyHere}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
