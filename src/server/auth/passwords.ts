import bcrypt from "bcryptjs"

export const BCRYPT_COST = 12

/** bcrypt hash of a password that nobody knows (cost 12): compared against when the user does not exist (same timing). */
export const DUMMY_HASH = "$2b$12$2QYGhO5rqxLU7F4vQHq7QezqG6o3YRWUwbI7LTb/B4LU.e.BUH2Ma"

export async function hashPassword(password: string, rounds: number = BCRYPT_COST): Promise<string> {
  return bcrypt.hash(password, rounds)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash)
  } catch {
    return false
  }
}
