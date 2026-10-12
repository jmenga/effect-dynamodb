/**
 * `effect-dynamodb/compression/node` — the node:zlib compressors.
 */
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as NodeCompression from "../src/compression/node.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const text = JSON.stringify({
  lines: Array.from({ length: 400 }, (_, i) => ({ sku: `SKU-${i % 9}`, qty: i, note: "état ✓" })),
})
const bytes = encoder.encode(text)

describe("Node compressors", () => {
  const factories = [
    ["gzip", () => NodeCompression.gzip()],
    ["brotli", () => NodeCompression.brotli()],
    ["zstd", () => NodeCompression.zstd()],
  ] as const

  for (const [codec, factory] of factories) {
    it(`${codec} round-trips and compresses`, () => {
      const compressor = factory()
      expect(compressor.codec).toBe(codec)
      const compressed = compressor.compress(bytes)
      expect(compressed).toBeInstanceOf(Uint8Array)
      expect(compressed.length).toBeLessThan(bytes.length / 4)
      expect(decoder.decode(compressor.decompress(compressed))).toBe(text)
    })

    it(`${codec} round-trips an empty payload`, () => {
      const compressor = factory()
      expect(compressor.decompress(compressor.compress(new Uint8Array(0))).length).toBe(0)
    })

    it(`${codec} enforces maxOutputLength on decompress`, () => {
      const compressor =
        codec === "gzip"
          ? NodeCompression.gzip({ maxOutputLength: 1000 })
          : codec === "brotli"
            ? NodeCompression.brotli({ maxOutputLength: 1000 })
            : NodeCompression.zstd({ maxOutputLength: 1000 })
      const compressed = compressor.compress(bytes)
      expect(() => compressor.decompress(compressed)).toThrow()
    })

    it(`${codec} throws on a corrupt payload`, () => {
      expect(() => factory().decompress(new Uint8Array([1, 2, 3, 4, 5]))).toThrow()
    })
  }

  it("level / quality options change the output but stay readable by defaults", () => {
    const fast = NodeCompression.gzip({ level: 1 }).compress(bytes)
    expect(decoder.decode(NodeCompression.gzip().decompress(fast))).toBe(text)
    const brotliFast = NodeCompression.brotli({ quality: 1 }).compress(bytes)
    expect(decoder.decode(NodeCompression.brotli().decompress(brotliFast))).toBe(text)
    const zstdMax = NodeCompression.zstd({ level: 19 }).compress(bytes)
    expect(decoder.decode(NodeCompression.zstd().decompress(zstdMax))).toBe(text)
  })

  it("hasZstd is true on this runtime (Node >= 22.15)", () => {
    expect(NodeCompression.hasZstd()).toBe(true)
  })

  it("available() returns gzip, brotli and zstd, and builds a valid registry", () => {
    const compressors = NodeCompression.available()
    expect(compressors.map((c) => c.codec)).toEqual(["gzip", "brotli", "zstd"])
    expect(Compression.make(compressors).codecs).toEqual(["gzip", "brotli", "zstd"])
  })

  it("available() passes maxOutputLength through", () => {
    for (const compressor of NodeCompression.available({ maxOutputLength: 10 })) {
      expect(() => compressor.decompress(compressor.compress(bytes))).toThrow()
    }
  })
})
