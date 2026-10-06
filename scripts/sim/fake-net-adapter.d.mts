// Types of scripts/sim/fake-net-adapter.mjs for the TypeScript tests.
export function plugAdapter(root: string, o?: { ifname?: string; mac?: string; carrier?: boolean; pci?: boolean; port?: string }): string
export function setCarrier(root: string, ifname: string, carrier: boolean): void
export function unplugAdapter(root: string, ifname: string): boolean
