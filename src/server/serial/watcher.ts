// Hot-plug watcher (§4.4, D2): a poll is authoritative; fs.watch only kicks an earlier scan. Adapters must keep
// the same signature for `settleMs` before they are announced, so an FT4232H gives one event, not four.
import { watch as fsWatch } from "node:fs"
import { serialChangeLabel } from "@/lib/i18n/serial"
import type { Logger } from "@/server/log"
import type { SerialDevice } from "./enumerate"
import { groupByAdapter, type UsbSerialAdapter } from "./group"

export type DiscoveryEventKind = "adapter-added" | "adapter-changed" | "adapter-removed" | "port-added" | "port-removed"
export interface DiscoveryEvent {
  kind: DiscoveryEventKind
  label: string
  adapter: UsbSerialAdapter | null
  port: SerialDevice | null
}

export interface WatchHandle { close(): void }
/** Injectable fs.watch: calls `onEvent(filename)`; throws when the directory cannot be watched. */
export type WatchFn = (dir: string, onEvent: (filename: string | null) => void, onError: () => void) => WatchHandle

export interface WatcherOptions {
  scan: () => Promise<SerialDevice[]>
  devRoot: string
  extraDirs: readonly string[]
  intervalMs: number
  settleMs: number
  debounceMs?: number
  watch?: WatchFn
  onChange: (events: DiscoveryEvent[]) => void
  log?: Logger
}

const INTERESTING = /^(tty(USB|ACM|XRUSB|WCHUSB|CH\d+USB)\d+|serial)$/

const defaultWatch: WatchFn = (dir, onEvent, onError) => {
  const w = fsWatch(dir, { persistent: false }, (_ev, f) => onEvent(f === null ? null : String(f)))
  w.on("error", () => { w.close(); onError() })
  return w
}

interface Tracked { adapter: UsbSerialAdapter; sig: string; since: number; announcedSig: string | null; announced: UsbSerialAdapter | null }

function signature(a: UsbSerialAdapter): string {
  return `${a.ports.map((p) => `${p.name}@${p.usb?.interfaceNumber ?? 0}.${p.usb?.portNumber ?? 0}`).join(",")}#${a.identityKey ?? ""}`
}

export class SerialDiscoveryImpl {
  private readonly o: WatcherOptions
  private pollTimer: NodeJS.Timeout | null = null
  private kickTimer: NodeJS.Timeout | null = null
  private kickAt = Number.POSITIVE_INFINITY
  private devWatch: WatchHandle | null = null
  private readonly extraWatches = new Map<string, WatchHandle>()
  private devWatchOk = false
  private tracked = new Map<string, Tracked>()
  private othersMap = new Map<string, SerialDevice>()
  private scanning: Promise<void> | null = null
  private again = false
  private stopped = true
  private lastScan = new Date(0)
  private waiters: Array<() => void> = []

  constructor(o: WatcherOptions) {
    this.o = o
  }

  /** Initial scan: everything already plugged is announced at once (no events), then polling starts. */
  async start(): Promise<void> {
    this.stopped = false
    const devs = await this.safeScan()
    const now = Date.now()
    for (const a of groupByAdapter(devs)) {
      const sig = signature(a)
      this.tracked.set(a.locationKey, { adapter: a, sig, since: now, announcedSig: sig, announced: a })
    }
    this.othersMap = new Map(devs.filter((d) => !d.usb).map((d) => [d.stableKey, d]))
    this.lastScan = new Date()
    this.startWatches()
    this.loop()
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.kickTimer) clearTimeout(this.kickTimer)
    this.pollTimer = null
    this.kickTimer = null
    this.devWatch?.close()
    this.devWatch = null
    for (const w of this.extraWatches.values()) w.close()
    this.extraWatches.clear()
    for (const w of this.waiters.splice(0)) w()
  }

  inotify(): boolean { return this.devWatchOk }
  scannedAt(): Date { return this.lastScan }

  /** Announced adapters (settled), in location order. */
  adapters(): UsbSerialAdapter[] {
    return [...this.tracked.values()].flatMap((t) => (t.announced ? [t.announced] : []))
      .sort((a, b) => a.locationKey.localeCompare(b.locationKey, "en", { numeric: true }))
  }
  /** Virtual and builtin ports. */
  others(): SerialDevice[] {
    return [...this.othersMap.values()].sort((a, b) => a.devNode.localeCompare(b.devNode, "en", { numeric: true }))
  }
  /** Every announced device (the snapshot the console manager resolves against). */
  devices(): SerialDevice[] {
    return [...this.adapters().flatMap((a) => a.ports), ...this.others()]
  }
  find(stableKey: string): SerialDevice | null {
    return this.devices().find((d) => d.stableKey === stableKey) ?? null
  }

  /** Runs a scan now (after any scan in progress) and resolves when it is done. */
  async scanNow(): Promise<void> {
    if (this.stopped) return
    const done = new Promise<void>((resolve) => this.waiters.push(resolve))
    if (this.scanning) this.again = true
    else this.schedule(0)
    await done
  }

  private startWatches(): void {
    const watch = this.o.watch ?? defaultWatch
    try {
      this.devWatch = watch(this.o.devRoot, (f) => {
        if (f !== null && INTERESTING.test(f)) this.schedule(this.o.debounceMs ?? 300)
      }, () => { this.devWatchOk = false; this.devWatch = null })
      this.devWatchOk = true
    } catch (err) {
      this.devWatchOk = false
      this.o.log?.warn("No se puede vigilar el directorio: solo sondeo", { dir: this.o.devRoot, code: (err as NodeJS.ErrnoException).code ?? "?" })
    }
    this.watchExtraDirs()
  }

  /** Extra-glob directories may appear later (the simulator creates them): retried on every poll. */
  private watchExtraDirs(): void {
    const watch = this.o.watch ?? defaultWatch
    for (const dir of this.o.extraDirs) {
      if (this.extraWatches.has(dir)) continue
      try {
        const h = watch(dir, () => this.schedule(this.o.debounceMs ?? 300), () => { this.extraWatches.delete(dir) })
        this.extraWatches.set(dir, h)
      } catch {
        /* missing for now: polling covers it */
      }
    }
  }

  private loop(): void {
    if (this.stopped) return
    this.pollTimer = setTimeout(() => {
      this.watchExtraDirs()
      this.schedule(0)
      this.loop()
    }, this.o.intervalMs)
    this.pollTimer.unref()
  }

  /** Schedules a scan in `ms`; an earlier pending scan is never postponed. */
  private schedule(ms: number): void {
    if (this.stopped) return
    const at = Date.now() + ms
    if (this.kickTimer && at >= this.kickAt) return
    if (this.kickTimer) clearTimeout(this.kickTimer)
    this.kickAt = at
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null
      this.kickAt = Number.POSITIVE_INFINITY
      void this.runScan()
    }, ms)
    this.kickTimer.unref()
  }

  private async safeScan(): Promise<SerialDevice[]> {
    try {
      return await this.o.scan()
    } catch (err) {
      this.o.log?.error("Error al enumerar los puertos serie", { err })
      return this.devices()
    }
  }

  private runScan(): Promise<void> {
    if (this.scanning) {
      this.again = true
      return this.scanning
    }
    this.scanning = (async () => {
      try {
        const devs = await this.safeScan()
        if (this.stopped) return
        const events = this.diff(devs)
        this.lastScan = new Date()
        if (events.length) {
          try {
            this.o.onChange(events)
          } catch (err) {
            this.o.log?.error("Error al procesar un cambio de puertos serie", { err })
          }
        }
      } finally {
        this.scanning = null
        if (this.again) {
          this.again = false
          this.schedule(0)
        } else {
          for (const w of this.waiters.splice(0)) w()
        }
      }
    })()
    return this.scanning
  }

  private diff(devs: SerialDevice[]): DiscoveryEvent[] {
    const events: DiscoveryEvent[] = []
    const now = Date.now()
    const settle = this.o.settleMs
    const seen = new Set<string>()
    for (const a of groupByAdapter(devs)) {
      seen.add(a.locationKey)
      const sig = signature(a)
      let t = this.tracked.get(a.locationKey)
      if (!t) {
        t = { adapter: a, sig, since: now, announcedSig: null, announced: null }
        this.tracked.set(a.locationKey, t)
      } else if (t.sig !== sig) {
        t.adapter = a
        t.sig = sig
        t.since = now
      } else {
        t.adapter = a
      }
      if (t.announcedSig === t.sig) {
        t.announced = a // same ports; attributes (access, links) may have changed
        continue
      }
      const elapsed = now - t.since
      if (elapsed < settle) {
        this.schedule(settle - elapsed + 20)
        continue
      }
      const kind: DiscoveryEventKind = t.announcedSig === null ? "adapter-added" : "adapter-changed"
      t.announcedSig = t.sig
      t.announced = a
      events.push({
        kind,
        label: kind === "adapter-added" ? serialChangeLabel.adapterAdded(a.label, a.ports.length) : serialChangeLabel.adapterChanged(a.label, a.ports.length),
        adapter: a,
        port: null,
      })
    }
    for (const [k, t] of this.tracked) {
      if (seen.has(k)) continue
      this.tracked.delete(k)
      if (t.announced) events.push({ kind: "adapter-removed", label: serialChangeLabel.adapterRemoved(t.announced.label), adapter: t.announced, port: null })
    }
    // Virtual and builtin ports: no grouping, no settle. A re-created link (new pty) is removed + added.
    const next = new Map(devs.filter((d) => !d.usb).map((d) => [d.stableKey, d]))
    for (const [k, prev] of this.othersMap) {
      const cur = next.get(k)
      if (!cur || cur.target !== prev.target) events.push({ kind: "port-removed", label: serialChangeLabel.portRemoved(prev.devNode), adapter: null, port: prev })
    }
    for (const [k, cur] of next) {
      const prev = this.othersMap.get(k)
      if (!prev || cur.target !== prev.target) events.push({ kind: "port-added", label: serialChangeLabel.portAdded(cur.devNode), adapter: null, port: cur })
    }
    this.othersMap = next
    return events
  }
}
