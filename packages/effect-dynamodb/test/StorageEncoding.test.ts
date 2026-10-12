/**
 * `StorageEncoding` — public encode / decode / valueBytes / limits.
 */
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { CompressorNotRegistered, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { DateTime, Effect, Exit, Schema } from "effect"
import * as NodeCompression from "../src/compression/node.js"
import { attributeBytes } from "../src/internal/ItemSize.js"
import { toAttributeValue } from "../src/Marshaller.js"
import * as StorageEncoding from "../src/StorageEncoding.js"

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

  it.effect("decode accepts an AttributeValue, an unmarshalled value, and base64 B", () =>
    Effect.gen(function* () {
      const s = yield* StorageEncoding.encode(json, wire)
      const b = yield* StorageEncoding.encode(brotli, wire)
      expect(yield* StorageEncoding.decode(s)).toEqual(wire)
      expect(yield* StorageEncoding.decode(b)).toEqual(wire)
      expect(yield* StorageEncoding.decode(s?.S)).toEqual(wire)
      expect(yield* StorageEncoding.decode(b?.B)).toEqual(wire)
      const text = Buffer.from(b!.B!).toString("base64")
      expect(yield* StorageEncoding.decode(text)).toEqual(wire)
      expect(yield* StorageEncoding.decode({ B: text })).toEqual(wire)
    }).pipe(Effect.provide(compression)),
  )

  it.effect("decode returns legacy native values unchanged", () =>
    Effect.gen(function* () {
      expect(yield* StorageEncoding.decode({ M: { a: { N: "1" } } })).toEqual({ a: 1 })
      expect(yield* StorageEncoding.decode({ a: 1 })).toEqual({ a: 1 })
      expect(yield* StorageEncoding.decode(null)).toBeNull()
      expect(yield* StorageEncoding.decode(undefined)).toBeUndefined()
    }),
  )

  it.effect("without a registry: S works, a codec fails with CompressorNotRegistered", () =>
    Effect.gen(function* () {
      expect(yield* StorageEncoding.encode(zstd, { a: 1 })).toEqual({ S: '{"a":1}' })
      const writeError = failure(yield* Effect.exit(StorageEncoding.encode(zstd, wire)))
      expect(writeError).toBeInstanceOf(CompressorNotRegistered)
      const stored = yield* StorageEncoding.encode(zstd, wire).pipe(Effect.provide(compression))
      const readError = failure(yield* Effect.exit(StorageEncoding.decode(stored)))
      expect(readError).toMatchObject({ codec: "zstd", direction: "decompress" })
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
      expect(error).toBeInstanceOf(CompressorNotRegistered)
    }),
  )
})
