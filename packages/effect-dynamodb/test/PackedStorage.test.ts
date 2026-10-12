/**
 * Packed storage at the Marshaller boundary (`internal/Packed.ts`): item-level
 * pack/unpack through real marshalling, the registry in scope, and the
 * DynamoDB Streams image primitive (DynamoDB JSON or unmarshalled; `B` as bytes
 * or base64).
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Exit } from "effect"
import * as NodeCompression from "../src/compression/node.js"
import {
  currentRegistry,
  decodeImage,
  isAttributeValueImage,
  normalizeImage,
  packAttributeValue,
  packItem,
  unpackImageItem,
  unpackItem,
} from "../src/internal/Packed.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import { missingCompressor } from "./helpers/MissingCompressor.js"

const registry = Compression.make(NodeCompression.available())
const ctx = { entityType: "Order", operation: "put.packed" }
const readCtx = { entityType: "Order", operation: "decode" }

const json = DynamoModel.Packed({ format: "json" })
const zstd = DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } })
const gzip0 = DynamoModel.Packed({ format: "json", compression: { codec: "gzip", threshold: 0 } })

const big = {
  lines: Array.from({ length: 200 }, (_, i) => ({ sku: `SKU-${i % 5}`, qty: i, note: "état" })),
}
const small = { lines: [{ sku: "A", qty: 1 }] }

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined || reason._tag !== "Fail") throw new Error("expected a Fail reason")
  return reason.error
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

describe("currentRegistry", () => {
  it.effect("is empty without a Compression service", () =>
    Effect.gen(function* () {
      expect((yield* currentRegistry).codecs).toEqual([])
    }),
  )

  it.effect("is the provided registry", () =>
    Effect.gen(function* () {
      expect((yield* currentRegistry).codecs).toEqual(["gzip"])
    }).pipe(Effect.provide(Compression.layer([NodeCompression.gzip()]))),
  )
})

describe("packItem / unpackItem through marshalling", () => {
  it.effect("packs to S and B, marshals, and unpacks back to the wire form", () =>
    Effect.gen(function* () {
      const item: Record<string, unknown> = {
        pk: "$app#v1#order#o-1",
        small: small,
        d: big,
        native: { a: 1 },
      }
      yield* packItem(item, { small: json, d: zstd }, registry, ctx)
      expect(item.small).toBe(JSON.stringify(small))
      expect(item.d).toBeInstanceOf(Uint8Array)
      expect((item.d as Uint8Array)[0]).toBe(0x23)
      expect(item.native).toEqual({ a: 1 })

      const marshalled = toAttributeMap(item)
      expect(marshalled.small).toEqual({ S: JSON.stringify(small) })
      expect(marshalled.d?.B).toBeInstanceOf(Uint8Array)
      expect(marshalled.native?.M).toBeDefined()

      const raw = fromAttributeMap(marshalled)
      yield* unpackItem(raw, ["small", "d", "native", "absent"], registry, readCtx)
      expect(raw).toEqual({ pk: "$app#v1#order#o-1", small, d: big, native: { a: 1 } })
    }),
  )

  it.effect("absent attributes stay absent; undefined removes; null stores NULL", () =>
    Effect.gen(function* () {
      const item: Record<string, unknown> = { a: undefined, b: null }
      yield* packItem(item, { a: json, b: json, c: json }, registry, ctx)
      expect("a" in item).toBe(false)
      expect(item.b).toBeNull()
      expect("c" in item).toBe(false)
      expect(toAttributeMap(item)).toEqual({ b: { NULL: true } })
    }),
  )

  it.effect("legacy native maps pass through unpack unchanged (mixed items)", () =>
    Effect.gen(function* () {
      const raw: Record<string, unknown> = { d: { lines: [] }, e: null }
      yield* unpackItem(raw, ["d", "e"], registry, readCtx)
      expect(raw).toEqual({ d: { lines: [] }, e: null })
    }),
  )

  it.effect("packAttributeValue builds the SET value directly", () =>
    Effect.gen(function* () {
      const attributeCtx = { ...ctx, attribute: "d" }
      expect(yield* packAttributeValue(json, small, registry, attributeCtx)).toEqual({
        S: JSON.stringify(small),
      })
      const b = (yield* packAttributeValue(gzip0, big, registry, attributeCtx)) as AttributeValue
      expect(b.B?.[0]).toBe(0x21)
      expect(yield* packAttributeValue(json, null, registry, attributeCtx)).toEqual({ NULL: true })
      expect(yield* packAttributeValue(json, undefined, registry, attributeCtx)).toBeUndefined()
    }),
  )

  it.effect("errors name the stored attribute", () =>
    Effect.gen(function* () {
      const writeError = failure(
        yield* Effect.exit(packItem({ d: big }, { d: zstd }, Compression.empty, ctx)),
      )
      expect(missingCompressor(writeError)).toMatchObject({
        attribute: "d",
        direction: "compress",
        operation: ctx.operation,
      })

      const stored: Record<string, unknown> = { d: big }
      yield* packItem(stored, { d: zstd }, registry, ctx)
      const readError = failure(
        yield* Effect.exit(unpackItem(stored, ["d"], Compression.empty, readCtx)),
      )
      expect(missingCompressor(readError)).toMatchObject({
        _tag: "CompressorNotRegistered",
        codec: "zstd",
        attribute: "d",
        direction: "decompress",
        operation: "decode",
      })

      const invalidError = failure(
        yield* Effect.exit(unpackItem({ d: "{not json" }, ["d"], registry, readCtx)),
      )
      expect(invalidError).toBeInstanceOf(ValidationError)
    }),
  )
})

describe("stream images", () => {
  const packedImage = Effect.gen(function* () {
    const item: Record<string, unknown> = {
      pk: "$app#v1#order#o-1",
      sk: "$app#v1#order",
      s: small,
      b: big,
      native: { m: { n: 1 } },
      blob: new Uint8Array([1, 2, 3]),
      blobs: new Set([new Uint8Array([4]), new Uint8Array([5, 6])]),
    }
    yield* packItem(item, { s: json, b: gzip0 }, registry, ctx)
    return toAttributeMap(item)
  })

  /** Lambda / EventBridge Pipes DynamoDB JSON: every B / BS as base64 text, at any depth. */
  const toLambdaJson = (av: AttributeValue): unknown => {
    if (av.B !== undefined) return { B: base64(av.B) }
    if (av.BS !== undefined) return { BS: av.BS.map(base64) }
    if (av.M !== undefined) {
      return { M: Object.fromEntries(Object.entries(av.M).map(([k, v]) => [k, toLambdaJson(v)])) }
    }
    if (av.L !== undefined) return { L: av.L.map(toLambdaJson) }
    return av
  }

  const expected = {
    pk: "$app#v1#order#o-1",
    sk: "$app#v1#order",
    s: small,
    b: big,
    native: { m: { n: 1 } },
    blob: new Uint8Array([1, 2, 3]),
    blobs: new Set([new Uint8Array([4]), new Uint8Array([5, 6])]),
  }

  it("detects DynamoDB JSON by the pk probe, or by shape", () => {
    expect(isAttributeValueImage({ pk: { S: "x" }, a: { N: "1" } })).toBe(true)
    expect(isAttributeValueImage({ pk: "x", a: { S: "1" } })).toBe(false)
    expect(isAttributeValueImage({ id: { S: "x" }, a: { M: {} } })).toBe(true)
    expect(isAttributeValueImage({ id: "x" })).toBe(false)
    expect(isAttributeValueImage({ key: { S: "x" } }, "key")).toBe(true)
  })

  it.effect("DynamoDB JSON with B as Uint8Array", () =>
    Effect.gen(function* () {
      const image = yield* packedImage
      expect(yield* decodeImage(image, ["s", "b", "native"], readCtx)).toEqual(expected)
    }).pipe(Effect.provide(Compression.layer(NodeCompression.available()))),
  )

  it.effect("DynamoDB JSON with B / BS as base64 at any depth (Lambda, Pipes)", () =>
    Effect.gen(function* () {
      const image = yield* packedImage
      const lambda = Object.fromEntries(
        Object.entries({
          ...image,
          nested: { M: { inner: { L: [{ B: new Uint8Array([9, 9]) }] } } },
        }).map(([k, v]) => [k, toLambdaJson(v as AttributeValue)]),
      )
      expect(JSON.parse(JSON.stringify(lambda))).toEqual(lambda) // pure JSON, as delivered
      const decoded = yield* decodeImage(lambda, ["s", "b", "native"], readCtx)
      expect(decoded).toEqual({ ...expected, nested: { inner: [new Uint8Array([9, 9])] } })
    }).pipe(Effect.provide(Compression.layer(NodeCompression.available()))),
  )

  it.effect("unmarshalled image with packed B as Uint8Array or as base64 text", () =>
    Effect.gen(function* () {
      const raw = fromAttributeMap(yield* packedImage)
      expect(yield* decodeImage({ ...raw }, ["s", "b", "native"], readCtx)).toEqual(expected)
      const withBase64 = { ...raw, b: base64(raw.b as Uint8Array) }
      expect(String(withBase64.b)[0]).toMatch(/[I-P]/)
      expect(yield* decodeImage(withBase64, ["s", "b", "native"], readCtx)).toEqual(expected)
    }).pipe(Effect.provide(Compression.layer(NodeCompression.available()))),
  )

  it.effect('an S whose JSON would look like base64 never does (JSON starts with { [ " …)', () =>
    Effect.gen(function* () {
      const raw: Record<string, unknown> = { s: JSON.stringify(["IJKLMNOP"]) }
      yield* unpackImageItem(raw, ["s"], registry, readCtx)
      expect(raw.s).toEqual(["IJKLMNOP"])
    }),
  )

  it.effect("DynamoDB JSON S values are never sniffed as base64", () =>
    Effect.gen(function* () {
      // A legacy opaque native string starting with I..P is S in DynamoDB JSON; only listed
      // attributes are unpacked, and S is read as JSON — so a non-listed attribute is untouched.
      const decoded = yield* decodeImage({ pk: { S: "Item#1" }, note: { S: "Plain" } }, [], readCtx)
      expect(decoded).toEqual({ pk: "Item#1", note: "Plain" })
    }),
  )

  it.effect("invalid base64 B fails with ValidationError naming the attribute path", () =>
    Effect.gen(function* () {
      const error = failure(
        yield* Effect.exit(
          normalizeImage({ pk: { S: "x" }, m: { M: { bad: { B: "!!!not base64!!!" } } } }, readCtx),
        ),
      )
      expect(error).toBeInstanceOf(ValidationError)
      expect(((error as ValidationError).cause as Error).message).toContain('"m.bad"')
    }),
  )

  it.effect("a non-object image fails with ValidationError", () =>
    Effect.gen(function* () {
      const error = failure(yield* Effect.exit(normalizeImage(null as never, readCtx)))
      expect(error).toBeInstanceOf(ValidationError)
    }),
  )

  it.effect(
    "an unregistered codec in an image fails with a ValidationError caused by CompressorNotRegistered",
    () =>
      Effect.gen(function* () {
        const image = yield* packedImage
        const error = failure(yield* Effect.exit(decodeImage(image, ["b"], readCtx)))
        expect(missingCompressor(error)).toMatchObject({
          _tag: "CompressorNotRegistered",
          codec: "gzip",
          attribute: "b",
        })
      }),
  )
})
