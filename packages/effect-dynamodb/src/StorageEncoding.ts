/**
 * StorageEncoding — public helpers for packed storage
 * (`DynamoModel.Packed({ format: "json", compression? })`).
 *
 * - {@link encode} / {@link decode}: one value ↔ its stored `AttributeValue`,
 *   by the same codec entity fields and EventStore `data` / `state` use. `decode`
 *   dispatches on the stored form, so it reads native, `S` and `B` values alike,
 *   and accepts `B` as bytes or base64 text (DynamoDB Streams via Lambda or
 *   EventBridge Pipes). {@link decodeUnmarshalled} does the same for a value
 *   already unmarshalled.
 * - {@link valueBytes}: the DynamoDB size of a value as it would be stored —
 *   packed under a config, or native — for caller-side planning against
 *   {@link limits}. An item's size is the sum, over its attributes, of the
 *   attribute name's UTF-8 bytes plus its value's bytes.
 *
 * Compressors come from the `Compression` service in scope (read with
 * `Effect.serviceOption`, so `R = never`). Without one, uncompressed values
 * work and a value that needs a codec fails with `CompressorNotRegistered`.
 *
 * Nothing here is a pre-check: the library never refuses a write by its
 * measured size — DynamoDB enforces its limits, and the failure diagnosis
 * names the item at fault. These helpers are for callers planning chunks.
 *
 * See `DESIGN.md §7 "Packed Storage"`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { PackedConfig } from "@effect-dynamodb/schema/DynamoModel.js"
import { type CompressorNotRegistered, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { packValue, unpackValue } from "@effect-dynamodb/schema/internal/PackedCodec.js"
import { Effect, Schema } from "effect"
import { attributeBytes, ITEM_MAX_BYTES, TRANSACT_WRITE_MAX_BYTES } from "./internal/ItemSize.js"
import {
  currentRegistry,
  normalizeImage,
  type StreamImage,
  storedToAttributeValue,
  unpackImageItem,
} from "./internal/Packed.js"
import { toAttributeValue } from "./Marshaller.js"

const ENTITY_TYPE = "StorageEncoding"

/**
 * DynamoDB's size limits, in bytes: one item (400 KB = 409,600 bytes) and one
 * `TransactWriteItems` request (4 MB = 4,194,304 bytes).
 */
export const limits: { readonly item: number; readonly transaction: number } = Object.freeze({
  item: ITEM_MAX_BYTES,
  transaction: TRANSACT_WRITE_MAX_BYTES,
})

/**
 * The `AttributeValue` a value is stored as under `storedAs`: `S` (JSON), `B`
 * (header + compressed JSON, when compression is configured, the JSON is at
 * least `threshold` bytes, and it is smaller), `NULL` for `null`, or
 * `undefined` for `undefined` (no attribute).
 *
 * `wire` is the attribute's **wire (encoded) form** — plain JSON. Encode a
 * domain value through its schema first, or use {@link valueBytes}.
 */
export const encode = (
  storedAs: PackedConfig,
  wire: unknown,
): Effect.Effect<AttributeValue | undefined, ValidationError | CompressorNotRegistered> =>
  Effect.flatMap(currentRegistry, (registry) =>
    Effect.map(
      packValue(storedAs, wire, registry, {
        entityType: ENTITY_TYPE,
        attribute: "value",
        operation: "StorageEncoding.encode",
      }),
      storedToAttributeValue,
    ),
  )

/**
 * Read a stored `AttributeValue` (DynamoDB JSON) by its form, returning its wire
 * (encoded) form as plain JSON — not schema-decoded: `S` is JSON, `B` (bytes, or
 * base64 text as Lambda and EventBridge Pipes deliver it) is a header plus a
 * payload, and any other type (a legacy native `M`, say) is unmarshalled
 * unchanged. `undefined` (no attribute) returns `undefined`.
 *
 * For a value already unmarshalled (`@aws-sdk/util-dynamodb`'s `unmarshall`, or
 * a `DocumentClient` row), use {@link decodeUnmarshalled}: the two forms cannot
 * be told apart by shape (`{ N: "5" }` is both a number and a one-key map).
 */
export const decode = (
  stored: AttributeValue | { readonly B: string } | undefined,
): Effect.Effect<unknown, ValidationError | CompressorNotRegistered> =>
  Effect.gen(function* () {
    if (stored === undefined) return undefined
    const ctx = { entityType: ENTITY_TYPE, operation: "StorageEncoding.decode" }
    const registry = yield* currentRegistry
    // DynamoDB JSON: the S / B tag is unambiguous, so no base64 sniffing.
    const raw = yield* normalizeImage({ value: stored } as StreamImage, ctx, {
      form: "attributeValues",
    })
    return yield* unpackValue(raw.value, registry, { ...ctx, attribute: "value" })
  })

/**
 * Read an already-unmarshalled stored value by its form, returning its wire
 * (encoded) form as plain JSON — not schema-decoded: a string is JSON unless it
 * is base64 of a `B` value (it then starts with `I`–`P`, which JSON text never
 * does), bytes are `B`, and anything else is a native value returned unchanged.
 *
 * For an `AttributeValue` (DynamoDB JSON), use {@link decode}.
 */
export const decodeUnmarshalled = (
  stored: unknown,
): Effect.Effect<unknown, ValidationError | CompressorNotRegistered> =>
  Effect.gen(function* () {
    const ctx = { entityType: ENTITY_TYPE, operation: "StorageEncoding.decodeUnmarshalled" }
    const registry = yield* currentRegistry
    const raw: Record<string, unknown> = { value: stored }
    yield* unpackImageItem(raw, ["value"], registry, ctx)
    return raw.value
  })

/**
 * The DynamoDB size, in bytes, of a value's attribute **value** as stored
 * (excluding the attribute name): encoded through `schema`, then packed under
 * `storedAs` — or, when `storedAs` is omitted, marshalled natively (a map).
 *
 * Measured by the same rules the library's write-failure diagnosis uses, so the
 * number is exact for this runtime's compressors. Compressed sizes can differ
 * across compressor versions; leave a margin when planning on one runtime and
 * writing on another.
 *
 * @example
 * ```typescript
 * const bytes = yield* StorageEncoding.valueBytes({
 *   schema: LedgerState,
 *   value: state,
 *   storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
 * })
 * if ("state".length + bytes > StorageEncoding.limits.item) { ... }
 * ```
 */
export const valueBytes = <S extends Schema.Top>(options: {
  readonly schema: S
  readonly value: Schema.Schema.Type<S>
  readonly storedAs?: PackedConfig | undefined
}): Effect.Effect<number, ValidationError | CompressorNotRegistered> =>
  Effect.gen(function* () {
    const operation = "StorageEncoding.valueBytes"
    const codec = options.schema as unknown as Schema.Codec<unknown, unknown>
    const wire = yield* Schema.encodeUnknownEffect(codec)(options.value).pipe(
      // A value given in its encoded form (as EventStore accepts) still measures.
      Effect.catch((primaryCause) =>
        Schema.decodeUnknownEffect(codec)(options.value).pipe(
          Effect.flatMap((decoded) => Schema.encodeUnknownEffect(codec)(decoded)),
          Effect.catch(() =>
            Effect.fail(
              new ValidationError({ entityType: ENTITY_TYPE, operation, cause: primaryCause }),
            ),
          ),
        ),
      ),
    )
    if (options.storedAs === undefined) {
      const native = yield* Effect.try({
        try: () => toAttributeValue(wire) as AttributeValue | undefined,
        catch: (cause) => new ValidationError({ entityType: ENTITY_TYPE, operation, cause }),
      })
      return native === undefined ? 0 : attributeBytes(native)
    }
    const registry = yield* currentRegistry
    const stored = yield* packValue(options.storedAs, wire, registry, {
      entityType: ENTITY_TYPE,
      attribute: "value",
      operation,
    })
    const av = storedToAttributeValue(stored)
    return av === undefined ? 0 : attributeBytes(av)
  })
