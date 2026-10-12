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
 * Compressors come from the `Compression` service in scope (read like
 * `Effect.serviceOption`, so `R = never`). Without one, uncompressed values
 * work and a value that needs a codec fails with a `ValidationError` whose
 * `cause` is a `CompressorNotRegistered`.
 *
 * Each helper has a synchronous twin — {@link encodeSync}, {@link decodeSync},
 * {@link decodeUnmarshalledSync}, {@link valueBytesSync} — for pure code (chunk
 * planning, a hand-rolled Lambda loop): it takes its compressors explicitly
 * (`{ compressors }`, none by default) and throws the `ValidationError` the
 * Effect form fails with. The Effect forms cost one Effect per call and look
 * the registry up only when a value is compressed; to decode many values with
 * no Effect per value, resolve the registry once (`yield* Effect.serviceOption(
 * Compression)`) and call the sync twin in a loop.
 *
 * Nothing here is a pre-check: the library never refuses a write by its
 * measured size — DynamoDB enforces its limits, and the failure diagnosis
 * names the item at fault. These helpers are for callers planning chunks.
 *
 * See `DESIGN.md §7 "Packed Storage"`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import {
  type CompressionRegistry,
  type Compressor,
  empty as emptyRegistry,
  make as makeRegistry,
} from "@effect-dynamodb/schema/Compression.js"
import type { PackedConfig } from "@effect-dynamodb/schema/DynamoModel.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  isBase64PackedText,
  packValueSync,
  unpackStoredSync,
} from "@effect-dynamodb/schema/internal/PackedCodec.js"
import { Effect, Schema } from "effect"
import { attributeBytes, ITEM_MAX_BYTES, TRANSACT_WRITE_MAX_BYTES } from "./internal/ItemSize.js"
import {
  normalizeImageSync,
  packAttributeValueSync,
  type StreamImage,
  storedToAttributeValue,
  unpackImageItemSync,
  withRegistry,
} from "./internal/Packed.js"
import { toAttributeValue } from "./Marshaller.js"

const ENTITY_TYPE = "StorageEncoding"

/**
 * Options of the synchronous helpers: the compressors a value may need. Give a
 * registry (`Compression.make([...])`, or the one in scope) or a list of
 * compressors; omitted, none — uncompressed values (and values under their
 * config's threshold) still work, and a value that needs a codec throws a
 * `ValidationError` whose `cause` is a `CompressorNotRegistered`.
 */
export interface SyncOptions {
  readonly compressors?: CompressionRegistry | ReadonlyArray<Compressor> | undefined
}

const registries = new WeakMap<ReadonlyArray<Compressor>, CompressionRegistry>()

/** The registry `options` names — built once per compressor list. */
const registryFrom = (options: SyncOptions | undefined): CompressionRegistry => {
  const compressors = options?.compressors
  if (compressors === undefined) return emptyRegistry
  if (!Array.isArray(compressors)) return compressors as CompressionRegistry
  const list = compressors as ReadonlyArray<Compressor>
  let registry = registries.get(list)
  if (registry === undefined) {
    registry = makeRegistry(list)
    registries.set(list, registry)
  }
  return registry
}

/** Return a sync step's value, or throw the `ValidationError` it returned. */
const orThrow = <A>(result: A | ValidationError): A => {
  if (result instanceof ValidationError) throw result
  return result as A
}

const lift = <A>(result: A | ValidationError): Effect.Effect<A, ValidationError> =>
  result instanceof ValidationError ? Effect.fail(result) : Effect.succeed(result as A)

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
): Effect.Effect<AttributeValue | undefined, ValidationError> =>
  withRegistry((registry) => encodeStep(storedAs, wire, registry))

const ENCODE = { entityType: ENTITY_TYPE, operation: "StorageEncoding.encode" }

const encodeStep = (storedAs: PackedConfig, wire: unknown, registry: CompressionRegistry) =>
  packAttributeValueSync(storedAs, wire, registry, ENCODE, "value")

/**
 * {@link encode}, synchronously, with explicit compressors (see
 * {@link SyncOptions}). Throws the `ValidationError` `encode` fails with.
 */
export const encodeSync = (
  storedAs: PackedConfig,
  wire: unknown,
  options?: SyncOptions,
): AttributeValue | undefined => orThrow(encodeStep(storedAs, wire, registryFrom(options)))

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
): Effect.Effect<unknown, ValidationError> => {
  if (stored === undefined) return Effect.succeed(undefined)
  // `S` never needs a compressor: no registry lookup.
  const text = (stored as { readonly S?: unknown }).S
  if (typeof text === "string") return lift(unpackStoredSync(text, emptyRegistry, DECODE, "value"))
  return withRegistry((registry) => decodeStep(stored, registry))
}

const DECODE = { entityType: ENTITY_TYPE, operation: "StorageEncoding.decode" }

const decodeStep = (
  stored: AttributeValue | { readonly B: string } | undefined,
  registry: CompressionRegistry,
): unknown => {
  if (stored === undefined) return undefined
  // DynamoDB JSON: the S / B tag is unambiguous, so no base64 sniffing.
  const raw = normalizeImageSync({ value: stored } as StreamImage, DECODE, {
    form: "attributeValues",
  })
  if (raw instanceof ValidationError) return raw
  const value = raw.value
  return typeof value === "string" || value instanceof Uint8Array
    ? unpackStoredSync(value, registry, DECODE, "value")
    : value
}

/**
 * {@link decode}, synchronously, with explicit compressors (see
 * {@link SyncOptions}). Throws the `ValidationError` `decode` fails with.
 */
export const decodeSync = (
  stored: AttributeValue | { readonly B: string } | undefined,
  options?: SyncOptions,
): unknown => orThrow(decodeStep(stored, registryFrom(options)))

/**
 * Read an already-unmarshalled stored value by its form, returning its wire
 * (encoded) form as plain JSON — not schema-decoded: a string is JSON unless it
 * is base64 of a `B` value (it then starts with `I`–`P`, which JSON text never
 * does), bytes are `B`, and anything else is a native value returned unchanged.
 *
 * For an `AttributeValue` (DynamoDB JSON), use {@link decode}.
 */
export const decodeUnmarshalled = (stored: unknown): Effect.Effect<unknown, ValidationError> => {
  // A native value is returned as is, and JSON text never needs a compressor:
  // only bytes (or base64 of them) look the registry up.
  if (typeof stored === "string" && !isBase64PackedText(stored)) {
    return lift(unpackStoredSync(stored, emptyRegistry, DECODE_UNMARSHALLED, "value"))
  }
  if (typeof stored !== "string" && !(stored instanceof Uint8Array)) {
    return Effect.succeed(stored)
  }
  return withRegistry((registry) => decodeUnmarshalledStep(stored, registry))
}

const DECODE_UNMARSHALLED = {
  entityType: ENTITY_TYPE,
  operation: "StorageEncoding.decodeUnmarshalled",
}

const decodeUnmarshalledStep = (stored: unknown, registry: CompressionRegistry): unknown => {
  if (typeof stored !== "string" && !(stored instanceof Uint8Array)) return stored
  const raw: Record<string, unknown> = { value: stored }
  const failure = unpackImageItemSync(raw, VALUE, registry, DECODE_UNMARSHALLED)
  return failure ?? raw.value
}

const VALUE: ReadonlyArray<string> = ["value"]

/**
 * {@link decodeUnmarshalled}, synchronously, with explicit compressors (see
 * {@link SyncOptions}). Throws the `ValidationError` `decodeUnmarshalled`
 * fails with. A native value is returned as is.
 */
export const decodeUnmarshalledSync = (stored: unknown, options?: SyncOptions): unknown =>
  orThrow(decodeUnmarshalledStep(stored, registryFrom(options)))

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
}): Effect.Effect<number, ValidationError> =>
  Effect.gen(function* () {
    const codec = options.schema as unknown as Schema.Codec<unknown, unknown>
    const wire = yield* Schema.encodeUnknownEffect(codec)(options.value).pipe(
      // A value given in its encoded form (as EventStore accepts) still measures.
      Effect.catch((primaryCause) =>
        Schema.decodeUnknownEffect(codec)(options.value).pipe(
          Effect.flatMap((decoded) => Schema.encodeUnknownEffect(codec)(decoded)),
          Effect.catch(() => Effect.fail(measureError(primaryCause))),
        ),
      ),
    )
    const storedAs = options.storedAs
    if (storedAs === undefined) return yield* lift(nativeBytes(wire))
    return yield* withRegistry((registry) => packedBytes(storedAs, wire, registry))
  })

const MEASURE = { entityType: ENTITY_TYPE, operation: "StorageEncoding.valueBytes" }

const measureError = (cause: unknown): ValidationError => new ValidationError({ ...MEASURE, cause })

/** The size of a wire value marshalled natively (a map), or the failure. */
const nativeBytes = (wire: unknown): number | ValidationError => {
  let native: AttributeValue | undefined
  try {
    native = toAttributeValue(wire) as AttributeValue | undefined
  } catch (cause) {
    return measureError(cause)
  }
  return native === undefined ? 0 : attributeBytes(native)
}

/** The size of a wire value packed under `storedAs`, or the failure. */
const packedBytes = (
  storedAs: PackedConfig,
  wire: unknown,
  registry: CompressionRegistry,
): number | ValidationError => {
  const stored = packValueSync(storedAs, wire, registry, MEASURE, "value")
  if (stored instanceof ValidationError) return stored
  const av = storedToAttributeValue(stored)
  return av === undefined ? 0 : attributeBytes(av)
}

/**
 * {@link valueBytes}, synchronously — for pure planning code. The value is
 * encoded through `schema` synchronously (a schema whose encoding is
 * effectful, or needs a service, cannot be measured this way: use
 * `valueBytes`), then packed with the compressors given in `compressors` (see
 * {@link SyncOptions}; none by default, enough for an uncompressed config and
 * for any value under its threshold). Returns exactly what `valueBytes` returns
 * for the same input and compressors; throws the `ValidationError` it fails
 * with.
 *
 * @example
 * ```typescript
 * const bytes = StorageEncoding.valueBytesSync({
 *   schema: LedgerState,
 *   value: state,
 *   storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
 *   compressors: [ZlibCompression.zstd()],
 * })
 * ```
 */
export const valueBytesSync = <S extends Schema.Top>(
  options: {
    readonly schema: S
    readonly value: Schema.Schema.Type<S>
    readonly storedAs?: PackedConfig | undefined
  } & SyncOptions,
): number => {
  const codec = options.schema as unknown as Schema.Codec<unknown, unknown>
  let wire: unknown
  try {
    wire = Schema.encodeUnknownSync(codec)(options.value)
  } catch (primaryCause) {
    // A value given in its encoded form (as EventStore accepts) still measures.
    try {
      wire = Schema.encodeUnknownSync(codec)(Schema.decodeUnknownSync(codec)(options.value))
    } catch {
      throw measureError(primaryCause)
    }
  }
  const storedAs = options.storedAs
  return orThrow(
    storedAs === undefined ? nativeBytes(wire) : packedBytes(storedAs, wire, registryFrom(options)),
  )
}
