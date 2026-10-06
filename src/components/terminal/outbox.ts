// Ordered, paced terminal input (§8.10). Pure helper; the timer lives in Terminal.

/**
 * Removes and returns up to `max` bytes from the front of `pending` (a FIFO of writes), joining small writes and
 * splitting a large one, so bytes leave in the order they were typed or pasted. Null when nothing is pending.
 * Mutates `pending`.
 */
export function takeFrame(pending: Uint8Array[], max: number): Uint8Array | null {
  let size = 0
  for (const p of pending) {
    size += p.length
    if (size >= max) break
  }
  size = Math.min(size, max)
  if (size === 0) {
    pending.length = 0
    return null
  }
  if (pending[0].length === size) return pending.shift() ?? null
  const frame = new Uint8Array(size)
  let at = 0
  while (at < size) {
    const head = pending[0]
    const take = Math.min(head.length, size - at)
    frame.set(head.subarray(0, take), at)
    at += take
    if (take === head.length) pending.shift()
    else pending[0] = head.subarray(take)
  }
  return frame
}
