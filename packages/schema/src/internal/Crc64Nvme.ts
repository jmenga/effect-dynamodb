/**
 * @internal CRC-64/NVME, the NVMe CRC-64 — the content checksum of offloaded
 * values and the trailer of a blob pointer (#179, design §4.2 and §5).
 *
 * Parameters (the CRC catalogue's "CRC-64/NVME", identical to S3's full-object
 * `CRC64NVME`): width 64, polynomial `0xad93d23594c93659` (reflected
 * `0x9a6c9329ac4bc9b5`), init all ones, input and output reflected, final XOR
 * all ones. Check value: `"123456789"` → `ae8b14860a799888`.
 *
 * A digest is 8 bytes, most significant first — the bytes whose base64 S3
 * sends and returns as `ChecksumCRC64NVME`.
 *
 * Pure JS, synchronous and runtime-neutral: slice-by-8 over 32-bit halves held
 * in `Uint32Array` tables, so the hot loop needs no `BigInt`. Vendored rather
 * than taken as a dependency because the schema package's pointer codec needs
 * it and the package stays free of the AWS SDK and of Node builtins
 * (`aws-free-guard.test.ts`, `node-free-guard.test.ts`).
 *
 * Not tamper evidence: a CRC is linear, so content with a chosen checksum is
 * easy to craft. Callers use a match only where a false match is harmless or
 * is backed by a real comparison (§5).
 *
 * Not part of the public API.
 */

/** Bytes in a CRC-64/NVME digest. */
export const CRC64NVME_BYTES = 8

/** The reflected polynomial, as two 32-bit halves. */
const POLY_HI = 0x9a6c9329
const POLY_LO = 0xac4bc9b5

/**
 * Slice tables: entry `slice * 256 + i` is the CRC register after byte `i`
 * followed by `slice` zero bytes. Built on first use, so importing the module
 * computes nothing.
 */
let tableHi: Uint32Array | undefined
let tableLo: Uint32Array | undefined

const buildTables = (): void => {
  const hi = new Uint32Array(8 * 256)
  const lo = new Uint32Array(8 * 256)
  for (let i = 0; i < 256; i++) {
    let h = 0
    let l = i
    for (let bit = 0; bit < 8; bit++) {
      const carry = l & 1
      l = (l >>> 1) | (h << 31)
      h >>>= 1
      if (carry !== 0) {
        h ^= POLY_HI
        l ^= POLY_LO
      }
    }
    hi[i] = h
    lo[i] = l
  }
  for (let slice = 1; slice < 8; slice++) {
    for (let i = 0; i < 256; i++) {
      const h = hi[(slice - 1) * 256 + i]!
      const l = lo[(slice - 1) * 256 + i]!
      const index = l & 0xff
      hi[slice * 256 + i] = (h >>> 8) ^ hi[index]!
      lo[slice * 256 + i] = ((l >>> 8) | (h << 24)) ^ lo[index]!
    }
  }
  tableHi = hi
  tableLo = lo
}

/** An incremental CRC-64/NVME. */
export type Crc64Nvme = {
  /** Feed the next bytes (any view: offset and length are respected). */
  readonly update: (bytes: Uint8Array) => Crc64Nvme
  /**
   * The checksum of every byte fed so far: a fresh 8-byte array, most
   * significant byte first. Does not end the computation — `update` may
   * continue afterwards.
   */
  readonly digest: () => Uint8Array
}

class Crc64NvmeHasher implements Crc64Nvme {
  // The register before the final XOR, as two 32-bit halves (init: all ones).
  private hi = 0xffffffff
  private lo = 0xffffffff

  readonly update = (bytes: Uint8Array): Crc64Nvme => {
    if (tableHi === undefined || tableLo === undefined) buildTables()
    const th = tableHi!
    const tl = tableLo!
    const length = bytes.length
    let hi = this.hi
    let lo = this.lo
    let i = 0
    // Eight bytes at a time: XOR them into the register (little-endian, as
    // the CRC is reflected), then look each register byte up in the table
    // for its distance from the end of the word.
    while (length - i >= 8) {
      const l =
        lo ^ (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24))
      const h =
        hi ^ (bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | (bytes[i + 7]! << 24))
      const i7 = 0x700 | (l & 0xff)
      const i6 = 0x600 | ((l >>> 8) & 0xff)
      const i5 = 0x500 | ((l >>> 16) & 0xff)
      const i4 = 0x400 | (l >>> 24)
      const i3 = 0x300 | (h & 0xff)
      const i2 = 0x200 | ((h >>> 8) & 0xff)
      const i1 = 0x100 | ((h >>> 16) & 0xff)
      const i0 = h >>> 24
      hi = th[i7]! ^ th[i6]! ^ th[i5]! ^ th[i4]! ^ th[i3]! ^ th[i2]! ^ th[i1]! ^ th[i0]!
      lo = tl[i7]! ^ tl[i6]! ^ tl[i5]! ^ tl[i4]! ^ tl[i3]! ^ tl[i2]! ^ tl[i1]! ^ tl[i0]!
      i += 8
    }
    // The tail, a byte at a time.
    while (i < length) {
      const index = (lo ^ bytes[i]!) & 0xff
      lo = ((lo >>> 8) | (hi << 24)) ^ tl[index]!
      hi = (hi >>> 8) ^ th[index]!
      i++
    }
    this.hi = hi
    this.lo = lo
    return this
  }

  readonly digest = (): Uint8Array => {
    const hi = ~this.hi
    const lo = ~this.lo
    return new Uint8Array([
      hi >>> 24,
      (hi >>> 16) & 0xff,
      (hi >>> 8) & 0xff,
      hi & 0xff,
      lo >>> 24,
      (lo >>> 16) & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff,
    ])
  }
}

/** A new incremental CRC-64/NVME over no bytes yet. */
export const make = (): Crc64Nvme => new Crc64NvmeHasher()

/** The CRC-64/NVME of `bytes`: 8 bytes, most significant first. */
export const crc64nvme = (bytes: Uint8Array): Uint8Array => make().update(bytes).digest()
