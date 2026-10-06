// Types of the fake equipment SSH server (fake-ssh-server.mjs) for the TypeScript tests.
export interface FakeSshOptions {
  host?: string
  port?: number
  /** The login's home folder (SFTP realpath ".", $HOME of exec). */
  home: string
  users?: Record<string, string>
  /** false: no SFTP subsystem (dropbear without sftp-server). */
  sftp?: boolean
  /** false: `scp` is "not found" (exit 127). */
  scp?: boolean
  /** false: sha256sum and md5sum are "not found". */
  checksum?: boolean
  /** An SFTP-only account: exec refused. */
  noExec?: boolean
  writeDelayMs?: number
  /** After this many bytes written, writes fail as with a full disk. */
  diskFullAfter?: number | null
  /** What `df -Pk` reports as available (bytes); null: the real df (or what diskFullAfter leaves). */
  reportFree?: number | null
  /** PEM private host key (the same one → the same fingerprint). */
  hostKey?: string
}
export interface FakeSshServer {
  host: string
  port: number
  home: string
  hostKey: string
  logins: Array<{ user: string; ok: boolean; method: string }>
  commands: string[]
  set(patch: Partial<FakeSshOptions>): void
  written(): number
  close(): Promise<void>
}
export function generateHostKey(): string
export function parseShellWords(s: string): string[]
export function createFakeSshServer(opts: FakeSshOptions): Promise<FakeSshServer>
