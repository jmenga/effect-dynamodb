/**
 * The vendored CRC-64/NVME of `@effect-dynamodb/schema` (#179 §5) against the
 * AWS SDK's own implementation — the one the S3 client uses for
 * `ChecksumCRC64NVME` — over random inputs, lengths and chunkings on both
 * sides. The schema package keeps its own vectors (check value, NVMe test
 * cases); this package is the only one allowed the SDK as a dev dependency.
 * The byte helpers are the schema package's test helpers, imported by path.
 */

import { Crc64Nvme as SdkCrc64Nvme } from "@aws-sdk/crc64-nvme"
import { describe, expect, it } from "@effect/vitest"
import * as Crc64Nvme from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Effect } from "effect"
import { chunk, hex, seeded } from "../../schema/test/helpers/Bytes.js"

/** The SDK's checksum of `chunks`, fed one by one. */
const sdkDigest = (chunks: ReadonlyArray<Uint8Array>): Effect.Effect<string, unknown> =>
  Effect.tryPromise({
    try: () => {
      const crc = new SdkCrc64Nvme()
      for (const piece of chunks) crc.update(piece)
      return crc.digest()
    },
    catch: (cause) => cause,
  }).pipe(Effect.map((digest) => hex(digest)))

/** The vendored checksum of `chunks`, fed one by one. */
const vendoredDigest = (chunks: ReadonlyArray<Uint8Array>): string => {
  const crc = Crc64Nvme.make()
  for (const piece of chunks) crc.update(piece)
  return hex(crc.digest())
}

describe("Crc64Nvme (vendored) against the AWS SDK", () => {
  it.effect("agrees on the check value and the empty input", () =>
    Effect.gen(function* () {
      const check = new TextEncoder().encode("123456789")
      expect(hex(Crc64Nvme.crc64nvme(check))).toBe(yield* sdkDigest([check]))
      expect(hex(Crc64Nvme.crc64nvme(new Uint8Array(0)))).toBe(yield* sdkDigest([]))
    }),
  )

  it.effect("agrees over random inputs and independent chunkings", () =>
    Effect.gen(function* () {
      const random = seeded(0x179)
      for (let run = 0; run < 300; run++) {
        const bytes = random.bytes(random.int(3000))
        const expected = yield* sdkDigest(chunk(bytes, 1 + random.int(256), random))
        expect(hex(Crc64Nvme.crc64nvme(bytes)), `run ${run} (one-shot)`).toBe(expected)
        expect(vendoredDigest(chunk(bytes, 1 + random.int(64), random)), `run ${run}`).toBe(
          expected,
        )
      }
    }),
  )

  it.effect("agrees over a multi-megabyte input in part-sized pieces", () =>
    Effect.gen(function* () {
      // Large enough to exercise long word-loop runs; pieces of uneven sizes
      // stand in for streamed body chunks and multipart parts.
      const random = seeded(0x5e)
      const bytes = random.bytes(3 * 1024 * 1024 + 5)
      const expected = yield* sdkDigest([bytes])
      expect(hex(Crc64Nvme.crc64nvme(bytes))).toBe(expected)
      expect(vendoredDigest(chunk(bytes, 1024 * 1024, random))).toBe(expected)
      expect(vendoredDigest(chunk(bytes, 4097, random))).toBe(expected)
    }),
  )
})
