/**
 * A text's 128-bit digest: the first 16 bytes of the SHA-256 of its UTF-16 code units, each as two
 * bytes, high byte first (an injective encoding of any string, lone surrogates included). `rekey`
 * keeps what it needs to remember of a key or a row as one of these (#240), a fixed 16 bytes
 * whatever the key or the row, with no key text and no image.
 *
 * SHA-256, not a faster non-cryptographic hash, since key text and row content can come from
 * anyone who writes to the table: two different keys or rows that share a digest are as hard to
 * find as a SHA-256 collision on 128 bits. Written out here because it must be synchronous and
 * run on every runtime: Web Crypto's `digest` returns a promise, and `node:crypto` is Node's.
 * Checked against `node:crypto` in `Digest.test.ts`.
 */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** One 64-byte block, as 16 big-endian words in `w[0..15]`, folded into `h`. */
const compress = (h: Int32Array, w: Int32Array): void => {
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15]!
    const y = w[i - 2]!
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0
  }
  let a = h[0]!
  let b = h[1]!
  let c = h[2]!
  let d = h[3]!
  let e = h[4]!
  let f = h[5]!
  let g = h[6]!
  let k = h[7]!
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
    const ch = (e & f) ^ (~e & g)
    const t1 = (k + S1 + ch + K[i]! + w[i]!) | 0
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
    const maj = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (S0 + maj) | 0
    k = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }
  h[0] = (h[0]! + a) | 0
  h[1] = (h[1]! + b) | 0
  h[2] = (h[2]! + c) | 0
  h[3] = (h[3]! + d) | 0
  h[4] = (h[4]! + e) | 0
  h[5] = (h[5]! + f) | 0
  h[6] = (h[6]! + g) | 0
  h[7] = (h[7]! + k) | 0
}

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

/** The full 32-byte SHA-256 of `text`'s UTF-16 code units, high byte first, as eight words. */
export const sha256Words = (text: string): Int32Array => {
  const h = Int32Array.from(INITIAL)
  const w = new Int32Array(64)
  // Two code units a word, sixteen words a block.
  let word = 0
  for (let i = 0; i + 1 < text.length; i += 2) {
    w[word++] = (text.charCodeAt(i) << 16) | text.charCodeAt(i + 1)
    if (word === 16) {
      compress(h, w)
      word = 0
    }
  }
  // The last code unit, if the length is odd, then the 0x80 byte that ends the message.
  w[word++] = text.length % 2 === 1 ? (text.charCodeAt(text.length - 1) << 16) | 0x8000 : 0x80000000
  if (word > 14) {
    while (word < 16) w[word++] = 0
    compress(h, w)
    word = 0
  }
  while (word < 14) w[word++] = 0
  // The message length in bits, as 64 bits: two bytes a code unit.
  const bits = text.length * 16
  w[14] = Math.floor(bits / 0x100000000)
  w[15] = bits >>> 0
  compress(h, w)
  return h
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
