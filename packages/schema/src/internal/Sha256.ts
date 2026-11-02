/**
 * @internal SHA-256 (FIPS 180-4) — the digest behind offloaded objects' keys
 * (#179, design §4.5).
 *
 * Pure JS, synchronous and runtime-neutral. Object keys are a storage format
 * that garbage collection trusts to decide what to delete, so they are
 * computed here rather than through a service (`effect/crypto`'s `Digest`): a
 * deterministic or stubbed one given to the client for tests must never change
 * or collide keys, and write paths without a client (transactions, event
 * streams) have none in context. Web Crypto's `subtle.digest` is asynchronous
 * and one-shot, so it cannot serve either. `rekey`'s row digests
 * (`effect-dynamodb`'s `internal/Digest.ts`) are computed with it too.
 *
 * Inputs are bounded only by `Number.MAX_SAFE_INTEGER` bytes in total.
 *
 * Not part of the public API.
 */

/** Bytes in a SHA-256 digest. */
export const SHA256_BYTES = 32

/** The round constants (§4.2.2). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** The initial hash value (§5.3.3). */
const IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** Process the 64-byte block of `data` at `offset` into `state` (§6.2.2). */
const compress = (state: Uint32Array, w: Uint32Array, data: Uint8Array, offset: number): void => {
  for (let t = 0; t < 16; t++) {
    const j = offset + t * 4
    w[t] = (data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!
  }
  for (let t = 16; t < 64; t++) {
    const x = w[t - 15]!
    const y = w[t - 2]!
    const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
    const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
    w[t] = w[t - 16]! + s0 + w[t - 7]! + s1
  }
  let a = state[0]!
  let b = state[1]!
  let c = state[2]!
  let d = state[3]!
  let e = state[4]!
  let f = state[5]!
  let g = state[6]!
  let h = state[7]!
  for (let t = 0; t < 64; t++) {
    const t1 =
      (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) | 0
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
    h = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }
  state[0] = state[0]! + a
  state[1] = state[1]! + b
  state[2] = state[2]! + c
  state[3] = state[3]! + d
  state[4] = state[4]! + e
  state[5] = state[5]! + f
  state[6] = state[6]! + g
  state[7] = state[7]! + h
}

/** An incremental SHA-256. */
export type Sha256 = {
  /** Feed the next bytes (any view: offset and length are respected). */
  readonly update: (bytes: Uint8Array) => Sha256
  /**
   * The digest of every byte fed so far: a fresh 32-byte array. Does not end
   * the computation — `update` may continue afterwards.
   */
  readonly digest: () => Uint8Array
}

class Sha256Hasher implements Sha256 {
  private readonly state = Uint32Array.from(IV)
  private readonly w = new Uint32Array(64)
  /** Bytes fed but not yet compressed: fewer than 64. */
  private readonly pending = new Uint8Array(64)
  private pendingLength = 0
  private totalLength = 0

  readonly update = (bytes: Uint8Array): Sha256 => {
    const length = bytes.length
    this.totalLength += length
    let offset = 0
    if (this.pendingLength > 0) {
      offset = Math.min(64 - this.pendingLength, length)
      this.pending.set(bytes.subarray(0, offset), this.pendingLength)
      this.pendingLength += offset
      if (this.pendingLength < 64) return this
      compress(this.state, this.w, this.pending, 0)
      this.pendingLength = 0
    }
    while (length - offset >= 64) {
      compress(this.state, this.w, bytes, offset)
      offset += 64
    }
    if (offset < length) {
      this.pending.set(bytes.subarray(offset), 0)
      this.pendingLength = length - offset
    }
    return this
  }

  readonly digest = (): Uint8Array => {
    // Pad a copy (§5.1.1), so the running state is left as it was.
    const state = Uint32Array.from(this.state)
    const blocks = this.pendingLength < 56 ? 1 : 2
    const tail = new Uint8Array(blocks * 64)
    tail.set(this.pending.subarray(0, this.pendingLength))
    tail[this.pendingLength] = 0x80
    // The message length in bits, as a 64-bit big-endian integer.
    const bitsHi = Math.floor(this.totalLength / 0x20000000)
    const bitsLo = (this.totalLength % 0x20000000) * 8
    const end = tail.length
    tail[end - 8] = bitsHi >>> 24
    tail[end - 7] = (bitsHi >>> 16) & 0xff
    tail[end - 6] = (bitsHi >>> 8) & 0xff
    tail[end - 5] = bitsHi & 0xff
    tail[end - 4] = bitsLo >>> 24
    tail[end - 3] = (bitsLo >>> 16) & 0xff
    tail[end - 2] = (bitsLo >>> 8) & 0xff
    tail[end - 1] = bitsLo & 0xff
    for (let block = 0; block < blocks; block++) compress(state, this.w, tail, block * 64)
    const out = new Uint8Array(SHA256_BYTES)
    for (let i = 0; i < 8; i++) {
      const word = state[i]!
      out[i * 4] = word >>> 24
      out[i * 4 + 1] = (word >>> 16) & 0xff
      out[i * 4 + 2] = (word >>> 8) & 0xff
      out[i * 4 + 3] = word & 0xff
    }
    return out
  }
}

/** A new incremental SHA-256 over no bytes yet. */
export const make = (): Sha256 => new Sha256Hasher()

/** The SHA-256 digest of `bytes` (32 bytes). */
export const sha256 = (bytes: Uint8Array): Uint8Array => make().update(bytes).digest()
