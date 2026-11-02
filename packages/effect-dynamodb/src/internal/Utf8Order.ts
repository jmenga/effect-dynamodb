/**
 * @internal UTF-8 byte order: the order DynamoDB sorts (and evaluates
 * `BETWEEN` on) string and binary key values, and the order S3 lists object
 * keys in. JavaScript's `<` compares UTF-16 code units, which disagrees for
 * characters outside the Basic Multilingual Plane, so it is never used for
 * keys.
 *
 * Runtime-neutral (no Node builtin, no AWS SDK): the range planner, write
 * diagnosis and condition evaluation share it with the in-memory blob store
 * and blob GC, whose import graphs must stay free of both. Not part of the
 * public API.
 */

const encoder = new TextEncoder()

/** Order two byte strings as DynamoDB orders binary values: bytewise, a prefix first. */
export const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * Order two key values by their UTF-8 bytes. Text is compared by code point,
 * which is its UTF-8 order, without encoding it; a byte string is compared
 * bytewise, against text's UTF-8 encoding when one side is text.
 */
export const compareUtf8 = (a: string | Uint8Array, b: string | Uint8Array): number => {
  if (typeof a !== "string" || typeof b !== "string") {
    return compareBytes(
      typeof a === "string" ? encoder.encode(a) : a,
      typeof b === "string" ? encoder.encode(b) : b,
    )
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!
    const y = b.codePointAt(j)!
    if (x !== y) return x < y ? -1 : 1
    i += x > 0xffff ? 2 : 1
    j += y > 0xffff ? 2 : 1
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0
}
