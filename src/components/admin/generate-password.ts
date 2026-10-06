// Temporary passwords an admin reads out or pastes to a colleague ("Generar" in Usuarios).
// crypto.getRandomValues works in insecure contexts (plain HTTP on the lab LAN, §8.12); randomUUID does not.

/** No 0/O, 1/l/I: the password is often read aloud or copied from a screen. */
export const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export type RandomBytes = (n: number) => Uint8Array

export function cryptoRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

/**
 * Four groups of four characters joined by "-" (19 characters, about 92 bits), e.g. "k7Qm-X2pD-9hVa-Rt4c".
 * Rejection sampling keeps every character equally likely.
 */
export function generatePassword(random: RandomBytes = cryptoRandomBytes, groups = 4, size = 4): string {
  const n = PASSWORD_ALPHABET.length
  const limit = 256 - (256 % n)
  const chars: string[] = []
  while (chars.length < groups * size) {
    for (const b of random(groups * size * 2)) {
      if (b >= limit) continue
      chars.push(PASSWORD_ALPHABET[b % n])
      if (chars.length === groups * size) break
    }
  }
  const out: string[] = []
  for (let g = 0; g < groups; g++) out.push(chars.slice(g * size, (g + 1) * size).join(""))
  return out.join("-")
}
