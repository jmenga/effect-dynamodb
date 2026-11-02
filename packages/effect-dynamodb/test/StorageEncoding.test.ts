/**
 * `StorageEncoding` — public encode / decode / valueBytes / limits.
 */
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { DateTime, Effect, Exit, Layer, Option, Schema } from "effect"
import { BlobStore } from "../src/BlobStore.js"
import * as ZlibCompression from "../src/compression/zlib.js"
import { attributeBytes } from "../src/internal/ItemSize.js"
import { toAttributeValue } from "../src/Marshaller.js"
import * as StorageEncoding from "../src/StorageEncoding.js"
import {
  bytesPointer,
  bytesPointerText,
  expectPointerStoreFailure,
  expectUnresolvedPointer,
  jsonPointer,
  jsonPointerBytes,
  storeObject,
} from "./helpers/BlobPointers.js"
import { missingCompressor } from "./helpers/MissingCompressor.js"

const compression = Compression.layer(ZlibCompression.available())

const json = DynamoModel.Packed({ format: "json" })
const zstd = DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } })
const brotli = DynamoModel.Packed({ format: "json", compression: { codec: "brotli" } })

class Line extends Schema.Class<Line>("Line")({
  sku: Schema.String,
  qty: Schema.Number,
  at: Schema.DateTimeUtcFromString,
}) {}
const State = Schema.Struct({ lines: Schema.Array(Line), note: Schema.optional(Schema.String) })

const at = DateTime.makeUnsafe(0)
const state = {
  lines: Array.from({ length: 300 }, (_, i) => new Line({ sku: `SKU-${i % 4}`, qty: i, at })),
}
const wire = {
  lines: state.lines.map((l) => ({ sku: l.sku, qty: l.qty, at: "1970-01-01T00:00:00.000Z" })),
}

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined || reason._tag !== "Fail") throw new Error("expected a Fail reason")
  return reason.error
}

describe("StorageEncoding.limits", () => {
  it("are DynamoDB's item, transaction and request body limits", () => {
    expect(StorageEncoding.limits).toEqual({
      item: 409_600,
      transaction: 4_194_304,
      request: 16_777_216,
    })
  })
})

describe("StorageEncoding.encode / decode", () => {
  it.effect("S under the threshold, B over it, NULL for null, undefined for undefined", () =>
    Effect.gen(function* () {
      expect(yield* StorageEncoding.encode(json, { a: 1 })).toEqual({ S: '{"a":1}' })
      const b = yield* StorageEncoding.encode(zstd, wire)
      expect(b?.B?.[0]).toBe(0x23)
      expect(yield* StorageEncoding.encode(zstd, null)).toEqual({ NULL: true })
      expect(yield* StorageEncoding.encode(zstd, undefined)).toBeUndefined()
    }).pipe(Effect.provide(compression)),
  )

  it.effect("decode reads an AttributeValue, with B as bytes or base64", () =>
    Effect.gen(function* () {
      const s = yield* StorageEncoding.encode(json, wire)
      const b = yield* StorageEncoding.encode(brotli, wire)
      expect(yield* StorageEncoding.decode(s)).toEqual(wire)
      expect(yield* StorageEncoding.decode(b)).toEqual(wire)
      const text = Buffer.from(b!.B!).toString("base64")
      expect(yield* StorageEncoding.decode({ B: text })).toEqual(wire)
    }).pipe(Effect.provide(compression)),
  )

  it.effect("decodeUnmarshalled reads a JSON string, bytes, and base64 B", () =>
    Effect.gen(function* () {
      const s = yield* StorageEncoding.encode(json, wire)
      const b = yield* StorageEncoding.encode(brotli, wire)
      expect(yield* StorageEncoding.decodeUnmarshalled(s?.S)).toEqual(wire)
      expect(yield* StorageEncoding.decodeUnmarshalled(b?.B)).toEqual(wire)
      const text = Buffer.from(b!.B!).toString("base64")
      expect(yield* StorageEncoding.decodeUnmarshalled(text)).toEqual(wire)
    }).pipe(Effect.provide(compression)),
  )

  it.effect("decode returns legacy native AttributeValues unmarshalled", () =>
    Effect.gen(function* () {
      expect(yield* StorageEncoding.decode({ M: { a: { N: "1" } } })).toEqual({ a: 1 })
      expect(yield* StorageEncoding.decode({ NULL: true })).toBeNull()
      expect(yield* StorageEncoding.decode(undefined)).toBeUndefined()
    }),
  )

  it.effect("decodeUnmarshalled returns legacy native values unchanged", () =>
    Effect.gen(function* () {
      expect(yield* StorageEncoding.decodeUnmarshalled({ a: 1 })).toEqual({ a: 1 })
      // One-key maps named like an AttributeValue tag are values, not DynamoDB JSON.
      expect(yield* StorageEncoding.decodeUnmarshalled({ L: [1, 2] })).toEqual({ L: [1, 2] })
      expect(yield* StorageEncoding.decodeUnmarshalled({ N: "5" })).toEqual({ N: "5" })
      expect(yield* StorageEncoding.decodeUnmarshalled(null)).toBeNull()
      expect(yield* StorageEncoding.decodeUnmarshalled(undefined)).toBeUndefined()
    }),
  )

  it.effect(
    "without a registry: S works, a codec fails with a ValidationError caused by CompressorNotRegistered",
    () =>
      Effect.gen(function* () {
        expect(yield* StorageEncoding.encode(zstd, { a: 1 })).toEqual({ S: '{"a":1}' })
        const writeError = failure(yield* Effect.exit(StorageEncoding.encode(zstd, wire)))
        missingCompressor(writeError)
        const stored = yield* StorageEncoding.encode(zstd, wire).pipe(Effect.provide(compression))
        const readError = failure(yield* Effect.exit(StorageEncoding.decode(stored)))
        expect(missingCompressor(readError)).toMatchObject({
          codec: "zstd",
          direction: "decompress",
        })
      }),
  )

  it.effect("encode refuses non-JSON wire values", () =>
    Effect.gen(function* () {
      const error = failure(yield* Effect.exit(StorageEncoding.encode(json, { at: new Date(0) })))
      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ operation: "StorageEncoding.encode" })
    }),
  )
})

describe("StorageEncoding sync twins", () => {
  const compressors = ZlibCompression.available()

  it.effect("encodeSync / decodeSync / decodeUnmarshalledSync match the Effect forms", () =>
    Effect.gen(function* () {
      for (const config of [json, zstd, brotli]) {
        const stored = yield* StorageEncoding.encode(config, wire)
        expect(StorageEncoding.encodeSync(config, wire, { compressors })).toEqual(stored)
        expect(StorageEncoding.decodeSync(stored, { compressors })).toEqual(
          yield* StorageEncoding.decode(stored),
        )
        const unmarshalled = stored?.S ?? stored?.B
        expect(StorageEncoding.decodeUnmarshalledSync(unmarshalled, { compressors })).toEqual(
          yield* StorageEncoding.decodeUnmarshalled(unmarshalled),
        )
      }
      // Native values pass through, as the Effect forms return them.
      expect(StorageEncoding.decodeSync({ M: { a: { N: "1" } } })).toEqual({ a: 1 })
      expect(StorageEncoding.decodeUnmarshalledSync({ N: "5" })).toEqual({ N: "5" })
      expect(StorageEncoding.decodeSync(undefined)).toBeUndefined()
      // A registry works as well as a list of compressors.
      const b = StorageEncoding.encodeSync(brotli, wire, { compressors })
      expect(
        StorageEncoding.decodeSync(b, {
          compressors: Compression.make([ZlibCompression.brotli()]),
        }),
      ).toEqual(wire)
    }).pipe(Effect.provide(compression)),
  )

  it("without compressors: S works, a codec throws a ValidationError caused by CompressorNotRegistered", () => {
    expect(StorageEncoding.encodeSync(zstd, { a: 1 })).toEqual({ S: '{"a":1}' })
    expect(() => StorageEncoding.encodeSync(zstd, wire)).toThrow(ValidationError)
    try {
      StorageEncoding.encodeSync(zstd, wire)
    } catch (error) {
      expect(missingCompressor(error)).toMatchObject({ codec: "zstd", direction: "compress" })
    }
    const stored = StorageEncoding.encodeSync(zstd, wire, { compressors })
    try {
      StorageEncoding.decodeUnmarshalledSync(stored?.B)
      throw new Error("expected a failure")
    } catch (error) {
      expect(missingCompressor(error)).toMatchObject({ codec: "zstd", direction: "decompress" })
    }
    expect(() => StorageEncoding.decodeSync({ S: "{nope" })).toThrow(ValidationError)
  })

  it.effect("the Effect decoders need no Compression service for S and native values", () =>
    Effect.gen(function* () {
      expect(yield* StorageEncoding.decode({ S: '{"a":1}' })).toEqual({ a: 1 })
      expect(yield* StorageEncoding.decodeUnmarshalled('{"a":1}')).toEqual({ a: 1 })
      const error = failure(yield* Effect.exit(StorageEncoding.decodeUnmarshalled("{nope")))
      expect(error).toMatchObject({
        _tag: "ValidationError",
        operation: "StorageEncoding.decodeUnmarshalled",
      })
    }),
  )
})

describe("StorageEncoding — blob pointers (#179)", () => {
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
  const thrown = (f: () => unknown): unknown => {
    try {
      f()
    } catch (error) {
      return error
    }
    throw new Error("expected a throw")
  }
  const value = { lines: [{ sku: "A", qty: 1 }], note: "x".repeat(200) }
  const content = new TextEncoder().encode(JSON.stringify(value))

  it("pointer reads both stored forms, and nothing else", () => {
    const B = jsonPointerBytes()
    // A bare string is read as decodeUnmarshalled reads it: base64 of a `B`
    // value (an unmarshalled Lambda / Pipes image's) is that value.
    for (const stored of [{ B }, { B: base64(B) }, B, base64(B)]) {
      const read = StorageEncoding.pointer(stored)
      expect(Option.isSome(read)).toBe(true)
      expect(Option.getOrThrow(read)).toMatchObject({
        kind: "json",
        codec: "zstd",
        ref: jsonPointer.ref,
        objectSize: jsonPointer.objectSize,
        contentSize: jsonPointer.contentSize,
        checksum: jsonPointer.checksum,
        contentType: Option.none(),
      })
    }
    for (const stored of [{ S: bytesPointerText }, bytesPointerText]) {
      expect(Option.getOrThrow(StorageEncoding.pointer(stored))).toMatchObject({
        kind: "bytes",
        codec: "none",
        ref: bytesPointer.ref,
        contentType: Option.some("application/pdf"),
      })
    }
    const inlineB = StorageEncodingFixtures.inlineB()
    const notPointers: ReadonlyArray<Parameters<typeof StorageEncoding.pointer>[0]> = [
      { S: '{"a":1}' },
      '{"a":1}',
      { B: inlineB },
      inlineB,
      base64(inlineB),
      { M: { a: { N: "1" } } },
      { N: "1" },
      { NULL: true },
      new Uint8Array([1, 2, 3]),
      new Uint8Array(0),
      // The other kind than its form stores: malformed.
      { B: BlobPointer.encode(bytesPointer) },
      base64(BlobPointer.encode(bytesPointer)),
      { S: BlobPointer.encodeText(jsonPointer) },
      BlobPointer.encodeText(jsonPointer),
      // Truncated, corrupt, not base64.
      B.subarray(0, B.length - 1),
      base64(B.subarray(0, B.length - 1)),
      `${bytesPointerText}A`,
      "~edbp:!!",
      { B: "not base64 at all!" },
    ]
    for (const stored of notPointers) {
      expect(Option.isNone(StorageEncoding.pointer(stored))).toBe(true)
    }
  })

  it.effect("decode / decodeUnmarshalled resolve a pointer through the BlobStore in scope", () =>
    Effect.gen(function* () {
      const store = BlobStore.memory()
      const plain = yield* storeObject(store, { key: "p/f/plain", kind: "json", content })
      const gzip = ZlibCompression.gzip()
      const packed = yield* storeObject(store, {
        key: "p/f/gzip",
        kind: "json",
        content,
        object: gzip.compress(content),
        codec: "gzip",
      })
      const run = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.provide(effect, Layer.mergeAll(BlobStore.layer(store), compression))
      for (const pointer of [plain, packed]) {
        const B = BlobPointer.encode(pointer)
        expect(yield* run(StorageEncoding.decode({ B }))).toEqual(value)
        expect(yield* run(StorageEncoding.decode({ B: base64(B) }))).toEqual(value)
        expect(yield* run(StorageEncoding.decodeUnmarshalled(B))).toEqual(value)
        expect(yield* run(StorageEncoding.decodeUnmarshalled(base64(B)))).toEqual(value)
      }
      expect(store.inspect().calls.get).toBe(8)
    }),
  )

  it.effect("a store failure is the cause of the ValidationError", () =>
    Effect.gen(function* () {
      // No store in scope: NotProvided.
      for (const stored of [{ B: jsonPointerBytes() }, { B: base64(jsonPointerBytes()) }]) {
        expectPointerStoreFailure(
          failure(yield* Effect.exit(StorageEncoding.decode(stored))),
          "value",
          { entityType: "StorageEncoding", operation: "StorageEncoding.decode" },
        )
      }
      expectPointerStoreFailure(
        failure(yield* Effect.exit(StorageEncoding.decodeUnmarshalled(jsonPointerBytes()))),
        "value",
        { operation: "StorageEncoding.decodeUnmarshalled" },
      )
      // A version that is gone, and an object that does not match its pointer.
      const store = BlobStore.memory()
      const gone = yield* storeObject(store, { key: "p/f/gone", kind: "json", content })
      yield* Effect.orDie(store.delete([gone.ref]))
      const corrupt = yield* storeObject(store, {
        key: "p/f/corrupt",
        kind: "json",
        content,
        overrides: { checksum: { algorithm: "crc64nvme", value: new Uint8Array(8) } },
      })
      for (const [pointer, reason] of [
        [gone, "NotFound"],
        [corrupt, "ChecksumMismatch"],
      ] as const) {
        const error = failure(
          yield* Effect.exit(
            Effect.provide(
              StorageEncoding.decode({ B: BlobPointer.encode(pointer) }),
              BlobStore.layer(store),
            ),
          ),
        )
        expect(error).toBeInstanceOf(ValidationError)
        expect(error.cause).toBeInstanceOf(BlobStoreError)
        expect(error.cause).toMatchObject({ reason, ref: pointer.ref, attribute: "value" })
      }
    }),
  )

  it("the sync twins refuse a pointer, naming it and what resolves it", () => {
    const hint = ["StorageEncoding.decode", "StorageEncoding.pointer"]
    expectUnresolvedPointer(
      thrown(() => StorageEncoding.decodeSync({ B: jsonPointerBytes() })),
      "value",
      { operation: "StorageEncoding.decode", hint },
    )
    expectUnresolvedPointer(
      thrown(() => StorageEncoding.decodeSync({ B: base64(jsonPointerBytes()) })),
      "value",
      { operation: "StorageEncoding.decode", hint },
    )
    for (const stored of [jsonPointerBytes(), base64(jsonPointerBytes())]) {
      expectUnresolvedPointer(
        thrown(() => StorageEncoding.decodeUnmarshalledSync(stored)),
        "value",
        { operation: "StorageEncoding.decodeUnmarshalled", hint },
      )
    }
  })

  it.effect("a binary field's ~edbp: text is not a packed value: read it with pointer", () =>
    Effect.gen(function* () {
      const expectRefused = (error: unknown, operation: string) => {
        expect(error).toBeInstanceOf(ValidationError)
        expect((error as ValidationError).operation).toBe(operation)
        const message = ((error as ValidationError).cause as Error).message
        expect(message).toContain("binary field's blob pointer")
        expect(message).toContain("StorageEncoding.pointer")
      }
      expectRefused(
        failure(yield* Effect.exit(StorageEncoding.decode({ S: bytesPointerText }))),
        "StorageEncoding.decode",
      )
      expectRefused(
        failure(yield* Effect.exit(StorageEncoding.decodeUnmarshalled(bytesPointerText))),
        "StorageEncoding.decodeUnmarshalled",
      )
      expectRefused(
        thrown(() => StorageEncoding.decodeSync({ S: bytesPointerText })),
        "StorageEncoding.decode",
      )
      expectRefused(
        thrown(() => StorageEncoding.decodeUnmarshalledSync(bytesPointerText)),
        "StorageEncoding.decodeUnmarshalled",
      )
    }),
  )
})

const StorageEncodingFixtures = {
  /** An inline v1 `B` value: gzip-packed JSON. */
  inlineB: (): Uint8Array =>
    (
      StorageEncoding.encodeSync(
        DynamoModel.Packed({ format: "json", compression: { codec: "gzip", threshold: 0 } }),
        { a: "x".repeat(400) },
        { compressors: [ZlibCompression.gzip()] },
      ) as { readonly B: Uint8Array }
    ).B,
}

describe("StorageEncoding.valueBytes", () => {
  it.effect("native: the marshalled map's size", () =>
    Effect.gen(function* () {
      const bytes = yield* StorageEncoding.valueBytes({ schema: State, value: state })
      expect(bytes).toBe(attributeBytes(toAttributeValue(wire)))
    }),
  )

  it.effect("json: the UTF-8 bytes of the JSON (larger than the map for this data)", () =>
    Effect.gen(function* () {
      const bytes = yield* StorageEncoding.valueBytes({
        schema: State,
        value: state,
        storedAs: json,
      })
      expect(bytes).toBe(new TextEncoder().encode(JSON.stringify(wire)).length)
      const native = yield* StorageEncoding.valueBytes({ schema: State, value: state })
      expect(bytes).toBeGreaterThan(native)
    }),
  )

  it.effect("compressed: the B bytes, header included, much smaller", () =>
    Effect.gen(function* () {
      const bytes = yield* StorageEncoding.valueBytes({
        schema: State,
        value: state,
        storedAs: zstd,
      })
      const stored = yield* StorageEncoding.encode(zstd, wire)
      expect(bytes).toBe(stored!.B!.byteLength)
      const asJson = yield* StorageEncoding.valueBytes({
        schema: State,
        value: state,
        storedAs: json,
      })
      expect(bytes * 5).toBeLessThan(asJson)
    }).pipe(Effect.provide(compression)),
  )

  it.effect("accepts the value in its encoded form too (decode → encode fallback)", () =>
    Effect.gen(function* () {
      const fromDomain = yield* StorageEncoding.valueBytes({
        schema: State,
        value: state,
        storedAs: json,
      })
      const fromWire = yield* StorageEncoding.valueBytes({
        schema: State,
        value: wire as never,
        storedAs: json,
      })
      expect(fromWire).toBe(fromDomain)
    }),
  )

  it.effect("an invalid value fails with ValidationError", () =>
    Effect.gen(function* () {
      const error = failure(
        yield* Effect.exit(
          StorageEncoding.valueBytes({
            schema: State,
            value: { lines: 1 } as never,
            storedAs: json,
          }),
        ),
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ operation: "StorageEncoding.valueBytes" })
    }),
  )

  it.effect("needs the codec only when the value crosses the threshold", () =>
    Effect.gen(function* () {
      const small = { lines: [new Line({ sku: "A", qty: 1, at })] }
      const bytes = yield* StorageEncoding.valueBytes({
        schema: State,
        value: small,
        storedAs: zstd,
      })
      expect(bytes).toBeGreaterThan(0)
      const error = failure(
        yield* Effect.exit(
          StorageEncoding.valueBytes({ schema: State, value: state, storedAs: zstd }),
        ),
      )
      missingCompressor(error)
    }),
  )
})

describe("StorageEncoding.valueBytesSync", () => {
  const compressors = ZlibCompression.available()
  const gzip0 = DynamoModel.Packed({ format: "json", compression: { codec: "gzip", threshold: 0 } })
  const small = { lines: [new Line({ sku: "A", qty: 1, at })] }
  const empty = { lines: [] }

  it.effect("equals valueBytes for every config, value and form", () =>
    Effect.gen(function* () {
      for (const storedAs of [undefined, json, zstd, brotli, gzip0]) {
        for (const value of [state, small, empty, wire as never, { ...state, note: "n" }]) {
          const expected = yield* StorageEncoding.valueBytes({ schema: State, value, storedAs })
          expect(
            StorageEncoding.valueBytesSync({ schema: State, value, storedAs, compressors }),
          ).toBe(expected)
          // A registry works as well as a list.
          expect(
            StorageEncoding.valueBytesSync({
              schema: State,
              value,
              storedAs,
              compressors: Compression.make(compressors),
            }),
          ).toBe(expected)
        }
      }
    }).pipe(Effect.provide(compression)),
  )

  it.effect("without compressors: uncompressed configs and values under the threshold", () =>
    Effect.gen(function* () {
      expect(StorageEncoding.valueBytesSync({ schema: State, value: state })).toBe(
        yield* StorageEncoding.valueBytes({ schema: State, value: state }),
      )
      expect(StorageEncoding.valueBytesSync({ schema: State, value: state, storedAs: json })).toBe(
        yield* StorageEncoding.valueBytes({ schema: State, value: state, storedAs: json }),
      )
      expect(StorageEncoding.valueBytesSync({ schema: State, value: small, storedAs: zstd })).toBe(
        yield* StorageEncoding.valueBytes({ schema: State, value: small, storedAs: zstd }),
      )
    }),
  )

  it("throws the ValidationError valueBytes fails with", () => {
    const thrown = (run: () => unknown): ValidationError => {
      try {
        run()
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError)
        return error as ValidationError
      }
      throw new Error("expected a throw")
    }
    // A codec the value needs, not given.
    const missing = thrown(() =>
      StorageEncoding.valueBytesSync({ schema: State, value: state, storedAs: zstd }),
    )
    expect(missingCompressor(missing)).toMatchObject({ codec: "zstd", direction: "compress" })
    // An invalid value.
    const invalid = thrown(() =>
      StorageEncoding.valueBytesSync({
        schema: State,
        value: { lines: 1 } as never,
        storedAs: json,
      }),
    )
    expect(invalid).toMatchObject({ operation: "StorageEncoding.valueBytes" })
  })
})
