/**
 * The pure packed-storage codec: header layout, strict JSON, pack (threshold,
 * smaller-only), unpack (stored-form dispatch), errors, and the shape rule.
 *
 * Real compressors come from `node:zlib` here — the TEST may import it; the
 * schema package's source never does (see `node-free-guard.test.ts`).
 */

import * as zlib from "node:zlib"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import * as Compression from "../src/Compression.js"
import * as DynamoModel from "../src/DynamoModel.js"
import { CompressorNotRegistered, ValidationError } from "../src/Errors.js"
import * as PackedCodec from "../src/internal/PackedCodec.js"

/**
 * A missing compressor is a `ValidationError` whose `cause` is a
 * `CompressorNotRegistered` (#147) — never a new member of an error channel.
 */
const missingCompressor = (error: unknown): CompressorNotRegistered => {
  expect(error).toBeInstanceOf(ValidationError)
  const validation = error as ValidationError
  expect(validation.cause).toBeInstanceOf(CompressorNotRegistered)
  const cause = validation.cause as CompressorNotRegistered
  expect(validation.entityType).toBe(cause.entityType)
  expect(validation.operation).toBe(cause.operation)
  return cause
}

const gzip: Compression.Compressor = {
  codec: "gzip",
  compress: (b) => zlib.gzipSync(b),
  decompress: (b) => zlib.gunzipSync(b),
}
const brotli: Compression.Compressor = {
  codec: "brotli",
  compress: (b) => zlib.brotliCompressSync(b),
  decompress: (b) => zlib.brotliDecompressSync(b),
}
const hasZstd = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function"
const zstd: Compression.Compressor | undefined = hasZstd
  ? {
      codec: "zstd",
      compress: (b) =>
        (zlib as unknown as { zstdCompressSync: (b: Uint8Array) => Uint8Array }).zstdCompressSync(
          b,
        ),
      decompress: (b) =>
        (
          zlib as unknown as { zstdDecompressSync: (b: Uint8Array) => Uint8Array }
        ).zstdDecompressSync(b),
    }
  : undefined

const all = Compression.make([gzip, brotli, ...(zstd ? [zstd] : [])])
const none = Compression.empty

const ctx: PackedCodec.PackedContext = {
  entityType: "Order",
  attribute: "lines",
  operation: "put.packed",
}
const readCtx: PackedCodec.PackedContext = { ...ctx, operation: "decode" }

const encoder = new TextEncoder()
const utf8 = (s: string) => encoder.encode(s).length

const json = DynamoModel.Packed({ format: "json" })
const withCodec = (codec: DynamoModel.CompressionCodec, threshold?: number) =>
  DynamoModel.Packed({
    format: "json",
    compression: threshold === undefined ? { codec } : { codec, threshold },
  })

/** A compressible payload whose JSON is exactly `bytes` UTF-8 bytes long. */
const payloadOfBytes = (bytes: number): { readonly s: string } => {
  // `{"s":""}` is 8 bytes.
  const value = { s: "a".repeat(bytes - 8) }
  expect(utf8(JSON.stringify(value))).toBe(bytes)
  return value
}

const pack = (config: DynamoModel.PackedConfig, wire: unknown, registry = all) =>
  PackedCodec.packValue(config, wire, registry, ctx)
const unpack = (stored: unknown, registry = all) =>
  PackedCodec.unpackValue(stored, registry, readCtx)

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (error === undefined || error._tag !== "Fail") throw new Error("expected a Fail reason")
  return error.error
}

const causeMessage = (error: unknown): string => ((error as ValidationError).cause as Error).message

describe("header layout", () => {
  it("v1 writers emit 0x21 / 0x22 / 0x23", () => {
    expect(PackedCodec.headerByte("gzip")).toBe(0x21)
    expect(PackedCodec.headerByte("brotli")).toBe(0x22)
    expect(PackedCodec.headerByte("zstd")).toBe(0x23)
    expect(PackedCodec.headerByte("none")).toBe(0x20)
    expect(PackedCodec.headerByte("none", PackedCodec.FORMAT_BINARY)).toBe(0x28)
  })

  it("parses every readable v1 header", () => {
    expect(PackedCodec.parseHeader(0x20)).toEqual({ version: 1, format: "json", codec: "none" })
    expect(PackedCodec.parseHeader(0x21)).toEqual({ version: 1, format: "json", codec: "gzip" })
    expect(PackedCodec.parseHeader(0x22)).toEqual({ version: 1, format: "json", codec: "brotli" })
    expect(PackedCodec.parseHeader(0x23)).toEqual({ version: 1, format: "json", codec: "zstd" })
  })

  it("refuses every other byte with a reason", () => {
    const readable = new Set([0x20, 0x21, 0x22, 0x23])
    for (let byte = 0; byte < 256; byte++) {
      if (readable.has(byte)) continue
      expect(typeof PackedCodec.parseHeader(byte)).toBe("string")
    }
    expect(PackedCodec.parseHeader(0x01)).toContain("layout version 0")
    expect(PackedCodec.parseHeader(0x41)).toContain("layout version 2")
    expect(PackedCodec.parseHeader(0x41)).toContain("newer effect-dynamodb")
    expect(PackedCodec.parseHeader(0xe3)).toContain("layout version 7")
    expect(PackedCodec.parseHeader(0x28)).toContain('format "binary"')
    expect(PackedCodec.parseHeader(0x28)).toContain("reserved")
    expect(PackedCodec.parseHeader(0x30)).toContain("unknown format code 2")
    expect(PackedCodec.parseHeader(0x38)).toContain("unknown format code 3")
    for (const code of [4, 5, 6, 7]) {
      expect(PackedCodec.parseHeader(0x20 | code)).toContain(`unknown codec code ${code}`)
    }
  })

  it("the base64 of every v1 header byte starts with I..P; JSON text never does", () => {
    for (let byte = 0x20; byte <= 0x3f; byte++) {
      for (const tail of [[], [0], [255, 255], [1, 2, 3, 4]]) {
        const text = Buffer.from([byte, ...tail]).toString("base64")
        expect(PackedCodec.isBase64PackedText(text)).toBe(true)
        expect("IJKLMNOP").toContain(text[0])
      }
    }
    for (const value of [{}, [], "x", 0, -1, 12.5, true, false, null, { I: 1 }, ["P"]]) {
      expect(PackedCodec.isBase64PackedText(JSON.stringify(value))).toBe(false)
    }
  })
})

describe("stringifyStrict", () => {
  it("serialises JSON values and omits undefined properties", () => {
    expect(
      PackedCodec.stringifyStrict({ a: 1, b: undefined, c: [1, "x", null, { d: true }] }),
    ).toBe('{"a":1,"c":[1,"x",null,{"d":true}]}')
    expect(PackedCodec.stringifyStrict(Object.create(null))).toBe("{}")
  })

  const refusals: ReadonlyArray<readonly [string, unknown, string, string]> = [
    ["bigint", { a: 1n }, "lines.a", "a bigint"],
    ["Uint8Array", { a: new Uint8Array([1]) }, "lines.a", "binary data (Uint8Array)"],
    ["ArrayBuffer", { a: new ArrayBuffer(1) }, "lines.a", "binary data"],
    ["Set", { a: new Set(["x"]) }, "lines.a", "a Set"],
    ["Map", { a: new Map() }, "lines.a", "a Map"],
    ["Date", { a: new Date(0) }, "lines.a", "a Date"],
    ["class instance", { a: new (class Foo {})() }, "lines.a", "an instance of Foo"],
    ["toJSON object", { a: { toJSON: () => "x" } }, "lines.a", "an instance of Object"],
    ["NaN", { a: Number.NaN }, "lines.a", "the non-finite number NaN"],
    ["Infinity", [Number.POSITIVE_INFINITY], "lines[0]", "the non-finite number Infinity"],
    ["undefined array element", [1, undefined], "lines[1]", "undefined"],
    ["symbol", { a: Symbol("s") }, "lines.a", "a symbol"],
    ["function", { a: () => 1 }, "lines.a", "a function"],
    ["nested path", { a: [{ "b-c": { d: 1n } }] }, 'lines.a[0]["b-c"].d', "a bigint"],
  ]

  for (const [name, value, path, what] of refusals) {
    it(`refuses ${name}, naming the path and type`, () => {
      expect(() => PackedCodec.stringifyStrict(value, "lines")).toThrow(
        `value at ${path} is ${what}`,
      )
    })
  }

  it("refuses a cycle", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => PackedCodec.stringifyStrict(cyclic, "lines")).toThrow("circular reference")
  })

  it("accepts the same object twice when not cyclic", () => {
    const shared = { x: 1 }
    expect(PackedCodec.stringifyStrict({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}')
  })
})

describe("packValue", () => {
  it.effect("absent and null pass through", () =>
    Effect.gen(function* () {
      expect(yield* pack(json, undefined)).toBeUndefined()
      expect(yield* pack(json, null)).toBeNull()
      expect(yield* pack(withCodec("gzip", 0), null, none)).toBeNull()
    }),
  )

  it.effect("without compression stores JSON (S), however large", () =>
    Effect.gen(function* () {
      const value = { s: "x".repeat(100_000) }
      expect(yield* pack(json, value, none)).toBe(JSON.stringify(value))
    }),
  )

  it.effect("threshold boundary: just below stores S, at and above store B", () =>
    Effect.gen(function* () {
      const config = withCodec("gzip", 1024)
      expect(typeof (yield* pack(config, payloadOfBytes(1023)))).toBe("string")
      const at = yield* pack(config, payloadOfBytes(1024))
      expect(at).toBeInstanceOf(Uint8Array)
      expect((at as Uint8Array)[0]).toBe(0x21)
      const above = yield* pack(config, payloadOfBytes(1025))
      expect(above).toBeInstanceOf(Uint8Array)
    }),
  )

  it.effect("the threshold counts UTF-8 bytes, not UTF-16 code units", () =>
    Effect.gen(function* () {
      // 340 × "€" is 340 code units but 1020 UTF-8 bytes; with `{"s":""}` → 1028 bytes.
      const value = { s: "€".repeat(340) }
      expect(JSON.stringify(value).length).toBe(348)
      expect(utf8(JSON.stringify(value))).toBe(1028)
      expect(yield* pack(withCodec("gzip", 1024), value)).toBeInstanceOf(Uint8Array)
      expect(typeof (yield* pack(withCodec("gzip", 1029), value))).toBe("string")
    }),
  )

  it.effect("threshold 0 always tries, and keeps S when compression does not pay", () =>
    Effect.gen(function* () {
      // A tiny value grows under gzip (≈20 bytes of framing).
      expect(yield* pack(withCodec("gzip", 0), { a: 1 })).toBe('{"a":1}')
    }),
  )

  it.effect("smaller-only: an incompressible payload stays S over the threshold", () =>
    Effect.gen(function* () {
      const identity: Compression.Compressor = {
        codec: "zstd",
        compress: (b) => b,
        decompress: (b) => b,
      }
      const value = payloadOfBytes(5000)
      expect(yield* pack(withCodec("zstd", 0), value, Compression.make([identity]))).toBe(
        JSON.stringify(value),
      )
      // One byte smaller than the JSON still loses to the header byte: equal size → S.
      const minusOne: Compression.Compressor = {
        codec: "zstd",
        compress: (b) => b.subarray(1),
        decompress: (b) => b,
      }
      expect(typeof (yield* pack(withCodec("zstd", 0), value, Compression.make([minusOne])))).toBe(
        "string",
      )
      const minusTwo: Compression.Compressor = {
        codec: "zstd",
        compress: (b) => b.subarray(2),
        decompress: (b) => b,
      }
      const stored = yield* pack(withCodec("zstd", 0), value, Compression.make([minusTwo]))
      expect(stored).toBeInstanceOf(Uint8Array)
      expect((stored as Uint8Array).length).toBe(utf8(JSON.stringify(value)) - 1)
    }),
  )

  it.effect("a registered compressor is never called under the threshold", () =>
    Effect.gen(function* () {
      let calls = 0
      const counting: Compression.Compressor = {
        codec: "gzip",
        compress: (b) => {
          calls++
          return zlib.gzipSync(b)
        },
        decompress: (b) => zlib.gunzipSync(b),
      }
      yield* pack(withCodec("gzip"), payloadOfBytes(1000), Compression.make([counting]))
      expect(calls).toBe(0)
    }),
  )

  it.effect("an unregistered codec fails only when a value crosses the threshold", () =>
    Effect.gen(function* () {
      expect(typeof (yield* pack(withCodec("brotli"), payloadOfBytes(500), none))).toBe("string")
      const error = failure(
        yield* Effect.exit(pack(withCodec("brotli"), payloadOfBytes(2000), none)),
      )
      expect(missingCompressor(error)).toMatchObject({
        _tag: "CompressorNotRegistered",
        codec: "brotli",
        direction: "compress",
        entityType: "Order",
        attribute: "lines",
        operation: "put.packed",
      })
      expect(missingCompressor(error).message).toContain('"brotli" compressor')
    }),
  )

  it.effect("a non-JSON value fails with ValidationError naming the path", () =>
    Effect.gen(function* () {
      const error = failure(yield* Effect.exit(pack(json, { at: new Date(0) })))
      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ entityType: "Order", operation: "put.packed" })
      expect(causeMessage(error)).toContain('Packed attribute "lines"')
      expect(causeMessage(error)).toContain("value at lines.at is a Date")
    }),
  )

  it.effect("a throwing compressor fails with ValidationError", () =>
    Effect.gen(function* () {
      const broken: Compression.Compressor = {
        codec: "gzip",
        compress: () => {
          throw new Error("boom")
        },
        decompress: (b) => b,
      }
      const error = failure(
        yield* Effect.exit(
          pack(withCodec("gzip", 0), payloadOfBytes(2000), Compression.make([broken])),
        ),
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect(causeMessage(error)).toContain('"gzip" compressor failed')
    }),
  )

  it.effect("a compressor returning a non-Uint8Array fails with ValidationError", () =>
    Effect.gen(function* () {
      const wrong = {
        codec: "gzip",
        compress: () => "nope" as unknown as Uint8Array,
        decompress: (b: Uint8Array) => b,
      } satisfies Compression.Compressor
      const error = failure(
        yield* Effect.exit(
          pack(withCodec("gzip", 0), payloadOfBytes(2000), Compression.make([wrong])),
        ),
      )
      expect(causeMessage(error)).toContain("did not return a Uint8Array")
    }),
  )

  it.effect("a decompressor returning a non-Uint8Array fails with ValidationError", () =>
    Effect.gen(function* () {
      const wrong = {
        codec: "gzip",
        compress: (b: Uint8Array) => b,
        decompress: () => "nope" as unknown as Uint8Array,
      } satisfies Compression.Compressor
      const error = failure(
        yield* Effect.exit(unpack(new Uint8Array([0x21, 1, 2, 3]), Compression.make([wrong]))),
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect(causeMessage(error)).toContain('"gzip" decompressor did not return a Uint8Array')
    }),
  )
})

describe("round trips", () => {
  const values: ReadonlyArray<readonly [string, unknown]> = [
    ["empty object", {}],
    ["empty array", []],
    ["nested", { a: [1, 2, { b: "c" }], d: { e: null, f: false, g: -0.5 } }],
    ["unicode", { emoji: "🦆💾", cjk: "漢字かな", rtl: "مرحبا", combining: "é", nul: "\u0000" }],
    [
      "DynamoDB-reserved characters",
      {
        "#name": "#v",
        ":value": ":x",
        "a.b": "c.d",
        "x[0]": "[1]",
        $schema: "$v1#entity#id",
        quote: "\"'`\\",
        newline: "a\nb\tc",
      },
    ],
    [
      "large repetitive",
      { lines: Array.from({ length: 500 }, (_, i) => ({ sku: `S-${i % 7}`, qty: i })) },
    ],
  ]

  const configs: ReadonlyArray<readonly [string, DynamoModel.PackedConfig]> = [
    ["json", json],
    ["gzip", withCodec("gzip", 0)],
    ["brotli", withCodec("brotli", 0)],
    ...(zstd ? ([["zstd", withCodec("zstd", 0)]] as const) : []),
  ]

  for (const [configName, config] of configs) {
    for (const [valueName, value] of values) {
      it.effect(`${configName}: ${valueName}`, () =>
        Effect.gen(function* () {
          const stored = yield* pack(config, value)
          expect(yield* unpack(stored)).toEqual(value)
        }),
      )
    }
  }

  it.effect("every codec produces B with its own header for a large value", () =>
    Effect.gen(function* () {
      const value = payloadOfBytes(10_000)
      for (const [codec, header] of [
        ["gzip", 0x21],
        ["brotli", 0x22],
        ...(zstd ? [["zstd", 0x23] as const] : []),
      ] as const) {
        const stored = yield* pack(withCodec(codec), value)
        expect(stored).toBeInstanceOf(Uint8Array)
        expect((stored as Uint8Array)[0]).toBe(header)
        expect((stored as Uint8Array).length).toBeLessThan(utf8(JSON.stringify(value)))
        expect(yield* unpack(stored)).toEqual(value)
      }
    }),
  )

  it.effect("decoding needs only the codec in the header, not the writer's config", () =>
    Effect.gen(function* () {
      const value = payloadOfBytes(4000)
      const stored = yield* pack(withCodec("brotli", 100), value)
      // A reader whose registry has only brotli decodes it, whatever it is configured with.
      expect(yield* unpack(stored, Compression.make([brotli]))).toEqual(value)
    }),
  )
})

describe("unpackValue dispatch", () => {
  it.effect("absent, null and legacy native values pass through unchanged", () =>
    Effect.gen(function* () {
      expect(yield* unpack(undefined)).toBeUndefined()
      expect(yield* unpack(null)).toBeNull()
      const map = { a: 1, b: ["x"], c: { d: true } }
      expect(yield* unpack(map)).toBe(map)
      const list = [1, 2]
      expect(yield* unpack(list)).toBe(list)
      expect(yield* unpack(42)).toBe(42)
      expect(yield* unpack(true)).toBe(true)
      const set = new Set(["a"])
      expect(yield* unpack(set)).toBe(set)
    }),
  )

  it.effect("S is JSON.parse", () =>
    Effect.gen(function* () {
      expect(yield* unpack('{"a":[1,"x"]}')).toEqual({ a: [1, "x"] })
      expect(yield* unpack("[]")).toEqual([])
    }),
  )

  it.effect("B with 0x20 is uncompressed UTF-8 JSON", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([0x20, ...encoder.encode('{"é":"€"}')])
      expect(yield* unpack(bytes, none)).toEqual({ é: "€" })
    }),
  )

  it.effect("accepts a Node Buffer (a Uint8Array subclass) as B", () =>
    Effect.gen(function* () {
      const stored = (yield* pack(withCodec("gzip", 0), payloadOfBytes(3000))) as Uint8Array
      expect(yield* unpack(Buffer.from(stored))).toEqual(payloadOfBytes(3000))
    }),
  )

  it.effect(
    "an unregistered codec on read fails with a ValidationError caused by CompressorNotRegistered",
    () =>
      Effect.gen(function* () {
        const stored = yield* pack(withCodec("gzip"), payloadOfBytes(3000))
        const error = failure(yield* Effect.exit(unpack(stored, Compression.make([brotli]))))
        expect(missingCompressor(error)).toMatchObject({
          _tag: "CompressorNotRegistered",
          codec: "gzip",
          direction: "decompress",
          entityType: "Order",
          attribute: "lines",
          operation: "decode",
        })
      }),
  )

  it.effect("B whose JSON legitimately holds U+FFFD reads (only invalid UTF-8 fails)", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([0x20, ...encoder.encode('{"r":"\uFFFD"}')])
      expect(yield* unpack(bytes, none)).toEqual({ r: "\uFFFD" })
    }),
  )

  it("the sync core returns the value, or the ValidationError it fails with (never throws)", () => {
    const readOp = { entityType: "Order", operation: "decode" }
    expect(PackedCodec.unpackStoredSync('{"a":1}', all, readOp, "lines")).toEqual({ a: 1 })
    const bad = PackedCodec.unpackStoredSync("{nope", all, readOp, "lines")
    expect(bad).toBeInstanceOf(ValidationError)
    expect(causeMessage(bad)).toContain('Packed attribute "lines"')
    const stored = PackedCodec.packValueSync(
      withCodec("gzip", 0),
      payloadOfBytes(3000),
      all,
      ctx,
      "lines",
    )
    expect(stored).toBeInstanceOf(Uint8Array)
    expect(PackedCodec.unpackStoredSync(stored as Uint8Array, all, readOp, "lines")).toEqual(
      payloadOfBytes(3000),
    )
    const missing = PackedCodec.unpackBytesSync(stored as Uint8Array, none, readOp, "lines")
    expect(missing).toBeInstanceOf(ValidationError)
    expect((missing as ValidationError).cause).toMatchObject({
      _tag: "CompressorNotRegistered",
      codec: "gzip",
      direction: "decompress",
      attribute: "lines",
    })
    const notJson = PackedCodec.packValueSync(json, { at: new Date(0) }, all, ctx, "lines")
    expect(notJson).toBeInstanceOf(ValidationError)
  })

  const invalidStored: ReadonlyArray<readonly [string, unknown, string]> = [
    ["empty B", new Uint8Array(0), "stored binary value is empty"],
    ["layout version 0", new Uint8Array([0x01, 1]), "layout version 0"],
    ["unknown layout version", new Uint8Array([0x41, 1]), "newer effect-dynamodb"],
    ["reserved binary format", new Uint8Array([0x28, 1]), 'format "binary"'],
    ["unknown format code", new Uint8Array([0x30, 1]), "unknown format code"],
    ["unknown codec code", new Uint8Array([0x27, 1]), "unknown codec code 7"],
    ["corrupt gzip payload", new Uint8Array([0x21, 1, 2, 3]), '"gzip" decompressor failed'],
    ["invalid UTF-8", new Uint8Array([0x20, 0xff, 0xfe]), "not valid UTF-8"],
    ["invalid JSON in B", new Uint8Array([0x20, ...encoder.encode("{nope")]), "not valid JSON"],
    ["invalid JSON in S", "{nope", "not valid JSON"],
  ]

  for (const [name, stored, fragment] of invalidStored) {
    it.effect(`${name} fails with ValidationError`, () =>
      Effect.gen(function* () {
        const error = failure(yield* Effect.exit(unpack(stored)))
        expect(error).toBeInstanceOf(ValidationError)
        expect(error).toMatchObject({ entityType: "Order", operation: "decode" })
        expect(causeMessage(error)).toContain('Packed attribute "lines"')
        expect(causeMessage(error)).toContain(fragment)
      }),
    )
  }
})

describe("packedShape (EDD-9073 shape rule)", () => {
  class Line extends Schema.Class<Line>("Line")({ sku: Schema.String }) {}
  interface Tree {
    readonly children: ReadonlyArray<Tree>
  }
  const Tree: Schema.Codec<Tree> = Schema.Struct({
    children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree)),
  })

  const structured: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["Struct", Schema.Struct({ a: Schema.String })],
    ["Class", Line],
    ["Record", Schema.Record(Schema.String, Schema.Number)],
    ["Array", Schema.Array(Schema.Number)],
    ["Tuple", Schema.Tuple([Schema.String, Schema.Number])],
    ["TupleWithRest", Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Number])],
    ["Union of structs", Schema.Union([Schema.Struct({ a: Schema.String }), Line])],
    ["NullOr", Schema.NullOr(Line)],
    ["optional", Schema.optional(Line)],
    ["optionalKey", Schema.optionalKey(Line)],
    ["UndefinedOr", Schema.UndefinedOr(Schema.Array(Schema.String))],
    [
      "decoding default",
      Schema.Struct({ a: Schema.String }).pipe(
        Schema.withDecodingDefault(Effect.succeed({ a: "x" })),
      ),
    ],
    ["suspend", Schema.suspend(() => Line)],
    ["recursive", Tree],
    [
      "struct with date fields inside",
      Schema.Struct({ at: Schema.DateTimeUtcFromString, n: Schema.BigInt }),
    ],
  ]
  for (const [name, schema] of structured) {
    it(`accepts ${name} as Structured (dispatch-eligible)`, () => {
      expect(PackedCodec.packedShape(schema)).toEqual({ _tag: "Structured" })
      expect(PackedCodec.isPackedShape(schema)).toBe(true)
      expect(PackedCodec.isDispatchEligible(schema)).toBe(true)
    })
  }

  const opaque: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["Unknown", Schema.Unknown],
    ["Any", Schema.Any],
    ["Json", Schema.Json],
    ["MutableJson", Schema.MutableJson],
    ["ObjectKeyword", Schema.ObjectKeyword],
    ["NullOr(Unknown)", Schema.NullOr(Schema.Unknown)],
    ["Union of struct and Json", Schema.Union([Line, Schema.Json])],
  ]
  for (const [name, schema] of opaque) {
    it(`accepts ${name} as Opaque (packable, not dispatch-eligible)`, () => {
      expect(PackedCodec.packedShape(schema)).toEqual({ _tag: "Opaque" })
      expect(PackedCodec.isPackedShape(schema)).toBe(true)
      expect(PackedCodec.isDispatchEligible(schema)).toBe(false)
    })
  }

  const refusedSchemas: ReadonlyArray<readonly [string, Schema.Top, string]> = [
    ["String", Schema.String, "a string"],
    ["Number", Schema.Number, "a number"],
    ["Boolean", Schema.Boolean, "a boolean"],
    ["Literal", Schema.Literal("a"), "a literal"],
    ["Literals", Schema.Literals(["a", "b"]), "a literal"],
    ["Enum", Schema.Enum({ A: "a" }), "an enum"],
    ["TemplateLiteral", Schema.TemplateLiteral(["a-", Schema.String]), "a template literal"],
    ["BigInt", Schema.BigInt, "a bigint"],
    ["Symbol", Schema.Symbol, "a symbol"],
    ["DateTimeUtc", Schema.DateTimeUtc, "DateTimeUtc"],
    ["DateTimeUtcFromString", Schema.DateTimeUtcFromString, "a string"],
    ["epoch-seconds TTL date", DynamoModel.TTL, "a number"],
    ["DateString", DynamoModel.DateString, "a string"],
    ["Uint8Array", Schema.Uint8Array, "Uint8Array"],
    ["ReadonlySet", Schema.ReadonlySet(Schema.String), "ReadonlySet"],
    ["ReadonlyMap", Schema.ReadonlyMap(Schema.String, Schema.Number), "ReadonlyMap"],
    ["NullOr(String)", Schema.NullOr(Schema.String), "a member of its union"],
    ["mixed union", Schema.Union([Line, Schema.String]), "a member of its union"],
    ["Null", Schema.Null, "its encoded side is null"],
    ["NullOr(Null)", Schema.NullOr(Schema.Undefined), "only null / undefined"],
    ["Never", Schema.Never, "never"],
  ]
  for (const [name, schema, fragment] of refusedSchemas) {
    it(`refuses ${name}`, () => {
      const shape = PackedCodec.packedShape(schema)
      expect(shape._tag).toBe("Refused")
      expect(shape._tag === "Refused" ? shape.reason : "").toContain(fragment)
      expect(PackedCodec.isPackedShape(schema)).toBe(false)
      expect(PackedCodec.isDispatchEligible(schema)).toBe(false)
    })
  }

  it("accepts a raw AST as well as a schema", () => {
    expect(PackedCodec.packedShape(Line.ast)).toEqual({ _tag: "Structured" })
    expect(PackedCodec.packedShape(Schema.String.ast)._tag).toBe("Refused")
  })
})
