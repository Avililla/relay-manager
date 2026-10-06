// Types of the fake TP-Link Easy Smart switch (fake-tplink-switch.mjs) for the TypeScript tests.
export interface FakeVlan { vid: number; name: string; untagged: number[]; tagged: number[] }
export interface FakeSwitchState {
  model: string
  portCount: number
  dot1q: { enabled: boolean; vlans: FakeVlan[]; pvids: number[] }
  portBased: boolean
  mtu: boolean
  links: boolean[]
  rx: number[]
  tx: number[]
  saved: { enabled: boolean; vlans: FakeVlan[]; pvids: number[] } | null
  saves: number
}
export interface FakeSwitchOptions {
  port?: number
  host?: string
  ports?: number
  clientPort?: number
  links?: number[]
  vlan1Editable?: boolean
  lockout?: boolean
  username?: string
  password?: string
  model?: string
}
export interface FakeSwitch {
  port: number
  host: string
  state(): FakeSwitchState
  log: Array<{ method: string; path: string; query: string; ip: string }>
  setLink(port: number, up: boolean): void
  setClientPort(port: number): void
  failNext(pathPrefix: string, n?: number): void
  reset(): void
  close(): Promise<void>
}
export function createFakeSwitch(opts?: FakeSwitchOptions): Promise<FakeSwitch>
