"use client"

import * as React from "react"
import type { IsoDate } from "@/lib/contracts/common"
import { addClockSample, clockOffset } from "@/lib/client/countdown"

/**
 * Server clock (§2.7): offset = median of the last 5 `serverNow - Date.now()` samples, seeded from
 * ShellDTO.serverNow at first render, then from SSE hello/heartbeat/reservation.changed.
 */
export interface ServerClock {
  /** Server time in ms. */
  now(): number
  offset(): number
  addSample(serverNow: IsoDate): void
  /** 1 Hz tick shared by every subscriber. */
  subscribeTick(cb: () => void): () => void
  /** The seed, used for the server render and hydration. */
  seedMs: number
}

function createServerClock(seed: IsoDate): ServerClock {
  const seedMs = Date.parse(seed)
  let samples = addClockSample([], seed, Date.now())
  const tickers = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | null = null
  return {
    seedMs: Number.isFinite(seedMs) ? seedMs : 0,
    now: () => Date.now() + clockOffset(samples),
    offset: () => clockOffset(samples),
    addSample(serverNow) {
      samples = addClockSample(samples, serverNow, Date.now())
    },
    subscribeTick(cb) {
      tickers.add(cb)
      if (!timer) timer = setInterval(() => tickers.forEach((t) => t()), 1000)
      return () => {
        tickers.delete(cb)
        if (!tickers.size && timer) {
          clearInterval(timer)
          timer = null
        }
      }
    },
  }
}

const ClockContext = React.createContext<ServerClock | null>(null)

export function ServerClockProvider({ serverNow, children }: { serverNow: IsoDate; children: React.ReactNode }) {
  const [clock] = React.useState(() => createServerClock(serverNow))
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
}

export function useServerClock(): ServerClock {
  const c = React.useContext(ClockContext)
  if (!c) throw new Error("useServerClock needs <ServerClockProvider>")
  return c
}

/**
 * Server time, ticking once per second (floored to the second, so equal renders are skipped).
 * During the server render and hydration it returns the seed: never branch markup on it before mount.
 */
export function useServerNow(): number {
  const clock = useServerClock()
  return React.useSyncExternalStore(
    clock.subscribeTick,
    () => Math.floor(clock.now() / 1000) * 1000,
    () => clock.seedMs,
  )
}
