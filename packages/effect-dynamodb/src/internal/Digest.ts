/**
 * A text's 128-bit digest: the first 16 bytes of the SHA-256 of its UTF-16 code units, each as two
 * bytes, high byte first (an injective encoding of any string, lone surrogates included). `rekey`
 * keeps what it needs to remember of a key or a row as one of these (#240), a fixed 16 bytes
 * whatever the key or the row, with no key text and no image.
 *
 * SHA-256, not a faster non-cryptographic hash, since key text and row content can come from
 * anyone who writes to the table: two different keys or rows that share a digest are as hard to
 * find as a SHA-256 collision on 128 bits. It must be synchronous and run on every runtime (Web
 * Crypto's `digest` returns a promise, and `node:crypto` is Node's), so it is the schema package's
 * vendored SHA-256 (`internal/Sha256.ts`, which also names offloaded objects, #179), fed the code
 * units a block of bytes at a time. Checked against `node:crypto` in `Digest.test.ts`.
 */

import * as Sha256 from "@effect-dynamodb/schema/internal/Sha256.js"

/** Code units fed to the hash at a time: a fixed buffer, whatever the text's length. */
const CHUNK_UNITS = 2048

/** The full 32-byte SHA-256 of `text`'s UTF-16 code units, high byte first, as eight words. */
export const sha256Words = (text: string): Int32Array => {
  const hash = Sha256.make()
  const chunk = new Uint8Array(Math.min(text.length, CHUNK_UNITS) * 2)
  for (let from = 0; from < text.length; from += CHUNK_UNITS) {
    const units = Math.min(CHUNK_UNITS, text.length - from)
    for (let i = 0; i < units; i++) {
      const unit = text.charCodeAt(from + i)
      chunk[i * 2] = unit >>> 8
      chunk[i * 2 + 1] = unit & 0xff
    }
    hash.update(chunk.subarray(0, units * 2))
  }
  const bytes = hash.digest()
  const words = new Int32Array(8)
  for (let i = 0; i < 8; i++) {
    words[i] =
      (bytes[i * 4]! << 24) |
      (bytes[i * 4 + 1]! << 16) |
      (bytes[i * 4 + 2]! << 8) |
      bytes[i * 4 + 3]!
  }
  return words
}

/**
 * `text`'s digest: the first 128 bits of {@link sha256Words}, as eight UTF-16 code units, the most
 * compact text a `Map` keys on (16 bytes of content).
 */
export const digest = (text: string): string => {
  const h = sha256Words(text)
  return String.fromCharCode(
    h[0]! >>> 16,
    h[0]! & 0xffff,
    h[1]! >>> 16,
    h[1]! & 0xffff,
    h[2]! >>> 16,
    h[2]! & 0xffff,
    h[3]! >>> 16,
    h[3]! & 0xffff,
  )
}
