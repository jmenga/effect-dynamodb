/**
 * Byte helpers shared by the checksum and hashing tests (#179): hex output,
 * ASCII input, a seeded generator so every run sees the same "random" bytes,
 * and a random chunker for incremental-update tests.
 *
 * The core package's cross-checks import this module by relative path rather
 * than copying it.
 */

/** Lower-case hex of `bytes`. */
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** The UTF-8 (here: ASCII) bytes of `text`. */
export const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)

/** A seeded generator (mulberry32), so every run sees the same "random" inputs. */
export const seeded = (seed: number) => {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  /** An integer in `0 … bound - 1`. */
  const int = (bound: number): number => Math.floor(next() * bound)
  /** `length` random bytes. */
  const bytes = (length: number): Uint8Array => Uint8Array.from({ length }, () => int(256))
  return { int, bytes }
}

/** A generator made by `seeded`. */
export type Random = ReturnType<typeof seeded>

/** Split `bytes` into consecutive chunks (views, not copies) of random sizes in `1 … maxChunk`. */
export const chunk = (bytes: Uint8Array, maxChunk: number, random: Random): Array<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  let offset = 0
  while (offset < bytes.length) {
    const size = 1 + random.int(maxChunk)
    chunks.push(bytes.subarray(offset, offset + size))
    offset += size
  }
  return chunks
}
