/**
 * `StorageEncoding` — public encode / decode / valueBytes / limits.
 */
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { DateTime, Effect, Exit, Schema } from "effect"
import * as NodeCompression from "../src/compression/node.js"
import { attributeBytes } from "../src/internal/ItemSize.js"
import { toAttributeValue } from "../src/Marshaller.js"
import * as StorageEncoding from "../src/StorageEncoding.js"
import { missingCompressor } from "./helpers/MissingCompressor.js"

const compression = Compression.layer(NodeCompression.available())

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
  it("are DynamoDB's item and transaction limits", () => {
    expect(StorageEncoding.limits).toEqual({ item: 409_600, transaction: 4_194_304 })
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
  const compressors = NodeCompression.available()

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
          compressors: Compression.make([NodeCompression.brotli()]),
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
  const compressors = NodeCompression.available()
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
