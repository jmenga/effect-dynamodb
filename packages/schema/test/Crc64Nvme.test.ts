/**
 * The vendored CRC-64/NVME (#179 §5): the catalogue check value, the NVMe
 * specification's 4 KiB test cases, the empty input, and incremental updates
 * over arbitrary chunkings and views agreeing with the one-shot digest.
 *
 * The cross-check against the AWS SDK's implementation lives in the core
 * package (`packages/effect-dynamodb/test/Crc64Nvme.test.ts`), the only package
 * allowed to depend on it.
 */

import { describe, expect, it } from "@effect/vitest"
import * as Crc64Nvme from "../src/internal/Crc64Nvme.js"
import { ascii, chunk, hex, seeded } from "./helpers/Bytes.js"

describe("Crc64Nvme", () => {
  it("matches the CRC-64/NVME check value", () => {
    expect(hex(Crc64Nvme.crc64nvme(ascii("123456789")))).toBe("ae8b14860a799888")
  })

  it("is all zeros over the empty input, as 8 bytes", () => {
    const digest = Crc64Nvme.crc64nvme(new Uint8Array(0))
    expect(digest.length).toBe(Crc64Nvme.CRC64NVME_BYTES)
    expect(hex(digest)).toBe("0000000000000000")
    expect(hex(Crc64Nvme.make().digest())).toBe("0000000000000000")
    expect(hex(Crc64Nvme.make().update(new Uint8Array(0)).digest())).toBe("0000000000000000")
  })

  it("matches the NVMe specification's 4 KiB test cases", () => {
    const size = 4096
    const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
      ["all zeros", new Uint8Array(size), "6482d367eb22b64e"],
      ["all ones", new Uint8Array(size).fill(0xff), "c0ddba7302eca3ac"],
      ["incrementing", Uint8Array.from({ length: size }, (_, i) => i & 0xff), "3e729f5f6750449c"],
      [
        "decrementing",
        Uint8Array.from({ length: size }, (_, i) => 0xff - (i & 0xff)),
        "9a2df64b8e9e517e",
      ],
    ]
    for (const [name, bytes, expected] of cases) {
      expect(hex(Crc64Nvme.crc64nvme(bytes)), name).toBe(expected)
    }
  })

  it("gives the one-shot digest for any chunking", () => {
    const random = seeded(0x179)
    for (let run = 0; run < 200; run++) {
      const bytes = random.bytes(random.int(600))
      const expected = hex(Crc64Nvme.crc64nvme(bytes))
      for (const maxChunk of [1, 3, 7, 8, 9, 17, 64]) {
        const crc = Crc64Nvme.make()
        for (const piece of chunk(bytes, maxChunk, random)) crc.update(piece)
        expect(hex(crc.digest()), `run ${run}, chunks ≤ ${maxChunk}`).toBe(expected)
      }
    }
  })

  it("covers every length around the 8-byte word boundary", () => {
    // The word loop and the byte tail must agree: a byte-at-a-time update is
    // the reference for each length.
    const random = seeded(8)
    const bytes = random.bytes(40)
    for (let length = 0; length <= bytes.length; length++) {
      const prefix = bytes.subarray(0, length)
      const byByte = Crc64Nvme.make()
      for (let i = 0; i < length; i++) byByte.update(prefix.subarray(i, i + 1))
      expect(hex(Crc64Nvme.crc64nvme(prefix)), `length ${length}`).toBe(hex(byByte.digest()))
    }
  })

  it("reads only the view it is given", () => {
    const random = seeded(42)
    const buffer = random.bytes(256)
    const view = buffer.subarray(13, 13 + 101)
    expect(hex(Crc64Nvme.crc64nvme(view))).toBe(hex(Crc64Nvme.crc64nvme(Uint8Array.from(view))))
  })

  it("does not end the computation on digest, and returns a fresh array each time", () => {
    const random = seeded(7)
    const head = random.bytes(37)
    const rest = random.bytes(91)
    const crc = Crc64Nvme.make().update(head)
    const first = crc.digest()
    expect(hex(first)).toBe(hex(Crc64Nvme.crc64nvme(head)))
    first.fill(0)
    expect(hex(crc.digest())).toBe(hex(Crc64Nvme.crc64nvme(head)))
    crc.update(rest)
    const whole = new Uint8Array(head.length + rest.length)
    whole.set(head)
    whole.set(rest, head.length)
    expect(hex(crc.digest())).toBe(hex(Crc64Nvme.crc64nvme(whole)))
  })

  it("keeps hashers independent", () => {
    const a = Crc64Nvme.make().update(ascii("1234"))
    const b = Crc64Nvme.make().update(ascii("abcd"))
    a.update(ascii("56789"))
    expect(hex(a.digest())).toBe("ae8b14860a799888")
    expect(hex(b.digest())).toBe(hex(Crc64Nvme.crc64nvme(ascii("abcd"))))
  })
})
