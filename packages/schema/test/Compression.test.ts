/**
 * `Compression` — the registry (`make`, EDD-9078) and the `Compression` service.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { Compression, type Compressor, empty, make } from "../src/Compression.js"

const fake = (codec: string): Compressor =>
  ({ codec, compress: (b: Uint8Array) => b, decompress: (b: Uint8Array) => b }) as Compressor

describe("Compression.make", () => {
  it("indexes compressors by codec", () => {
    const gzip = fake("gzip")
    const zstd = fake("zstd")
    const registry = make([zstd, gzip])
    expect(registry.get("gzip")).toBe(gzip)
    expect(registry.get("zstd")).toBe(zstd)
    expect(registry.get("brotli")).toBeUndefined()
    expect(registry.codecs).toEqual(["zstd", "gzip"])
  })

  it("the empty registry has no codecs", () => {
    expect(empty.codecs).toEqual([])
    expect(empty.get("gzip")).toBeUndefined()
    expect(Compression.empty).toBe(empty)
    expect(Compression.make).toBe(make)
  })

  it("refuses two compressors for one codec (EDD-9078)", () => {
    const thunk = () => make([fake("gzip"), fake("gzip")])
    expect(thunk).toThrow(/\[EDD-9078\]/)
    expect(thunk).toThrow('two compressors are registered for codec "gzip"')
  })

  it("refuses an unknown codec (EDD-9078)", () => {
    const thunk = () => make([fake("lz4")])
    expect(thunk).toThrow(/\[EDD-9078\]/)
    expect(thunk).toThrow('codec "lz4"')
  })

  it("refuses a compressor without functions (EDD-9078)", () => {
    const thunk = () => make([{ codec: "gzip" } as unknown as Compressor])
    expect(thunk).toThrow(/\[EDD-9078\]/)
    expect(thunk).toThrow("compress and decompress functions")
  })
})

describe("Compression service", () => {
  it.effect("layer provides a registry", () =>
    Effect.gen(function* () {
      const registry = yield* Compression
      expect(registry.codecs).toEqual(["brotli"])
    }).pipe(Effect.provide(Compression.layer([fake("brotli")]))),
  )

  it.effect("is absent unless provided — serviceOption adds no requirement", () =>
    Effect.gen(function* () {
      const registry = yield* Effect.serviceOption(Compression)
      expect(Option.isNone(registry)).toBe(true)
    }),
  )

  it("layer validates eagerly (EDD-9078)", () => {
    expect(() => Compression.layer([fake("gzip"), fake("gzip")])).toThrow(/\[EDD-9078\]/)
  })
})
