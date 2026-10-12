/**
 * `effect-dynamodb/compression/node` on a runtime without zstd (Node < 22.15),
 * simulated by mocking `node:zlib` without `zstdCompressSync`.
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("node:zlib", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  // Present-but-undefined, as on Node < 22.15 (vitest's mock proxy throws on absent keys).
  const rest = { ...original, zstdCompressSync: undefined, zstdDecompressSync: undefined }
  return { ...rest, default: rest }
})

const NodeCompression = await import("../src/compression/node.js")

describe("Node compressors without zstd", () => {
  it("hasZstd is false", () => {
    expect(NodeCompression.hasZstd()).toBe(false)
  })

  it("zstd() throws at construction, naming the Node requirement", () => {
    expect(() => NodeCompression.zstd()).toThrow("zstd needs Node >= 22.15")
  })

  it("available() omits zstd", () => {
    expect(NodeCompression.available().map((c) => c.codec)).toEqual(["gzip", "brotli"])
  })

  it("gzip and brotli still work", () => {
    const input = new TextEncoder().encode("x".repeat(1000))
    for (const compressor of NodeCompression.available()) {
      expect(compressor.decompress(compressor.compress(input))).toEqual(input)
    }
  })
})
