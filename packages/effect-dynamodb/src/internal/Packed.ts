/**
 * @internal Packed storage at the Marshaller boundary — item-level pack/unpack
 * over the pure codec (`@effect-dynamodb/schema/internal/PackedCodec`), the
 * compressor registry in scope, and DynamoDB Streams image normalisation.
 *
 * Where it runs:
 *
 * - **Write:** after the schema encode, field renames and sparse flattening,
 *   before `toAttributeMap` — {@link packItem} replaces each packed attribute's
 *   wire value with the JS value that marshals to its stored form (`string` →
 *   `S`, `Uint8Array` → `B`, `null` → `NULL`). Everything measured afterwards
 *   (item-size diagnosis, `Batch.write` chunking) therefore sees stored bytes.
 * - **Read:** after `fromAttributeMap`, before sparse rebuild and renames —
 *   {@link unpackItem} dispatches each dispatch-eligible attribute on its
 *   stored form (native → unchanged, `S` → JSON, `B` → header + payload).
 * - **Streams:** {@link normalizeImage} turns a Streams image (DynamoDB JSON,
 *   `B`/`BS` as bytes or base64, or an already-unmarshalled item) into an
 *   unmarshalled item with real bytes, and {@link unpackImageItem} additionally
 *   reads base64 text on a dispatch-eligible attribute as `B`.
 *
 * The registry is read with `Effect.serviceOption(Compression)`, so nothing
 * here adds a requirement; an absent service is the empty registry.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import {
  Compression,
  type CompressionRegistry,
  empty as emptyRegistry,
} from "@effect-dynamodb/schema/Compression.js"
import type { PackedConfig } from "@effect-dynamodb/schema/DynamoModel.js"
import type { CompressorNotRegistered } from "@effect-dynamodb/schema/Errors.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  isBase64PackedText,
  type PackedContext,
  type PackedStored,
  packValue,
  unpackBytes,
  unpackValue,
} from "@effect-dynamodb/schema/internal/PackedCodec.js"
import { Effect, Option, Result } from "effect"
import { Base64 } from "effect/encoding"
import { fromAttributeMap } from "../Marshaller.js"

export type { PackedContext, PackedStored } from "@effect-dynamodb/schema/internal/PackedCodec.js"

/** Error channel of every pack/unpack. */
export type PackedError = ValidationError | CompressorNotRegistered

/** Who is packing/unpacking an item; the attribute is filled in per value. */
export interface ItemContext {
  readonly entityType: string
  readonly operation: string
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The compressor registry in scope — the empty registry when none is provided. */
export const currentRegistry: Effect.Effect<CompressionRegistry> = Effect.map(
  Effect.serviceOption(Compression),
  (registry) => Option.getOrElse(registry, () => emptyRegistry),
)

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Pack, in place, every attribute of `item` (keyed by **stored** name) that
 * `packed` configures. An attribute the item does not carry is left absent; a
 * wire value of `undefined` removes it.
 */
export const packItem = (
  item: Record<string, unknown>,
  packed: Readonly<Record<string, PackedConfig>>,
  registry: CompressionRegistry,
  ctx: ItemContext,
): Effect.Effect<void, PackedError> =>
  Effect.forEach(
    Object.entries(packed),
    ([attribute, config]) => {
      if (!(attribute in item)) return Effect.void
      return Effect.map(
        packValue(config, item[attribute], registry, { ...ctx, attribute }),
        (stored) => {
          if (stored === undefined) delete item[attribute]
          else item[attribute] = stored
        },
      )
    },
    { discard: true },
  )

/** The `AttributeValue` a packed stored value marshals to (`undefined`: no attribute). */
export const storedToAttributeValue = (stored: PackedStored): AttributeValue | undefined => {
  if (stored === undefined) return undefined
  if (stored === null) return { NULL: true }
  if (typeof stored === "string") return { S: stored }
  return { B: stored }
}

/**
 * Pack one wire value straight to its `AttributeValue` — for an `UpdateItem`
 * `SET #f = :v`, where the value never passes through `toAttributeMap`.
 */
export const packAttributeValue = (
  config: PackedConfig,
  wire: unknown,
  registry: CompressionRegistry,
  ctx: PackedContext,
): Effect.Effect<AttributeValue | undefined, PackedError> =>
  Effect.map(packValue(config, wire, registry, ctx), storedToAttributeValue)

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Unpack, in place, every listed attribute of an unmarshalled item (keyed by
 * **stored** name) by its stored form. Native values cost one `typeof` check.
 */
export const unpackItem = (
  raw: Record<string, unknown>,
  attributes: Iterable<string>,
  registry: CompressionRegistry,
  ctx: ItemContext,
): Effect.Effect<void, PackedError> => {
  const pending: Array<string> = []
  for (const attribute of attributes) {
    const value = raw[attribute]
    if (typeof value === "string" || value instanceof Uint8Array) pending.push(attribute)
  }
  if (pending.length === 0) return Effect.void
  return Effect.forEach(
    pending,
    (attribute) =>
      Effect.map(unpackValue(raw[attribute], registry, { ...ctx, attribute }), (wire) => {
        raw[attribute] = wire
      }),
    { discard: true },
  )
}

// ---------------------------------------------------------------------------
// Streams images
// ---------------------------------------------------------------------------

/**
 * An `AttributeValue` as DynamoDB Streams delivers it through Lambda or
 * EventBridge Pipes: DynamoDB JSON whose `B` / `BS` members are base64 text.
 */
export type LambdaAttributeValue =
  | { readonly S: string }
  | { readonly N: string }
  | { readonly B: string | Uint8Array }
  | { readonly BOOL: boolean }
  | { readonly NULL: boolean }
  | { readonly SS: ReadonlyArray<string> }
  | { readonly NS: ReadonlyArray<string> }
  | { readonly BS: ReadonlyArray<string | Uint8Array> }
  | { readonly M: Readonly<Record<string, LambdaAttributeValue>> }
  | { readonly L: ReadonlyArray<LambdaAttributeValue> }

/**
 * A DynamoDB Streams image: DynamoDB JSON (`B`/`BS` as bytes or base64 text) or
 * an already-unmarshalled item.
 */
export type StreamImage =
  | Readonly<Record<string, AttributeValue | LambdaAttributeValue>>
  | Readonly<Record<string, unknown>>

const ATTRIBUTE_VALUE_TAGS = new Set(["S", "N", "B", "BOOL", "NULL", "SS", "NS", "BS", "M", "L"])

/** True iff `value` is shaped like one DynamoDB JSON `AttributeValue` (one known tag key). */
export const isAttributeValueShape = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  if (value instanceof Uint8Array) return false
  const keys = Object.keys(value)
  return keys.length === 1 && ATTRIBUTE_VALUE_TAGS.has(keys[0]!)
}

/**
 * True iff `image` is DynamoDB JSON rather than an unmarshalled item: its
 * `probe` attribute (default `"pk"`, a string key attribute on every item the
 * library writes) is an object with a string `S` member — or, without that
 * attribute, every value is shaped like an `AttributeValue`.
 */
export const isAttributeValueImage = (image: StreamImage, probe = "pk"): boolean => {
  const key = (image as Record<string, unknown>)[probe]
  if (key !== undefined) {
    return typeof key === "object" && key !== null && typeof (key as { S?: unknown }).S === "string"
  }
  const values = Object.values(image)
  return values.length > 0 && values.every(isAttributeValueShape)
}

/** Decode base64 text (or pass bytes through), failing with the attribute named. */
const toBytes = (
  value: unknown,
  ctx: PackedContext,
): Effect.Effect<Uint8Array, ValidationError> => {
  if (value instanceof Uint8Array) return Effect.succeed(value)
  if (typeof value === "string") {
    const decoded = Base64.decode(value)
    if (Result.isSuccess(decoded)) return Effect.succeed(decoded.success)
    return Effect.fail(
      new ValidationError({
        entityType: ctx.entityType,
        operation: ctx.operation,
        cause: new Error(`Attribute "${ctx.attribute}": a binary value is not valid base64`, {
          cause: decoded.failure,
        }),
      }),
    )
  }
  return Effect.fail(
    new ValidationError({
      entityType: ctx.entityType,
      operation: ctx.operation,
      cause: new Error(
        `Attribute "${ctx.attribute}": a binary value must be bytes or base64 text, got ${typeof value}`,
      ),
    }),
  )
}

/**
 * Rebuild one DynamoDB-JSON `AttributeValue` with every `B` / `BS` member (at
 * any depth) as real bytes.
 */
const normalizeAttributeValue = (
  value: unknown,
  ctx: PackedContext,
): Effect.Effect<AttributeValue, ValidationError> => {
  if (!isAttributeValueShape(value)) {
    return Effect.fail(
      new ValidationError({
        entityType: ctx.entityType,
        operation: ctx.operation,
        cause: new Error(`Attribute "${ctx.attribute}": not a DynamoDB JSON attribute value`),
      }),
    )
  }
  const av = value as Record<string, unknown>
  if ("B" in av) return Effect.map(toBytes(av.B, ctx), (B) => ({ B }))
  if ("BS" in av) {
    if (!Array.isArray(av.BS)) return Effect.succeed(av as unknown as AttributeValue)
    return Effect.map(
      Effect.forEach(av.BS as ReadonlyArray<unknown>, (element) => toBytes(element, ctx)),
      (BS) => ({ BS }),
    )
  }
  if ("M" in av && typeof av.M === "object" && av.M !== null) {
    return Effect.map(
      Effect.forEach(Object.entries(av.M as Record<string, unknown>), ([name, nested]) =>
        Effect.map(
          normalizeAttributeValue(nested, { ...ctx, attribute: `${ctx.attribute}.${name}` }),
          (normalized) => [name, normalized] as const,
        ),
      ),
      (entries) => ({ M: Object.fromEntries(entries) }),
    )
  }
  if ("L" in av && Array.isArray(av.L)) {
    return Effect.map(
      Effect.forEach(av.L as ReadonlyArray<unknown>, (nested, i) =>
        normalizeAttributeValue(nested, { ...ctx, attribute: `${ctx.attribute}[${i}]` }),
      ),
      (L) => ({ L }),
    )
  }
  return Effect.succeed(av as unknown as AttributeValue)
}

/** How {@link normalizeImage} reads an image. */
export interface ImageOptions {
  /** The attribute {@link isAttributeValueImage} probes (default `"pk"`). */
  readonly probe?: string | undefined
  /** Skip detection: the image is known to be DynamoDB JSON, or unmarshalled. */
  readonly form?: "attributeValues" | "unmarshalled" | undefined
}

/**
 * Normalise a DynamoDB Streams image to an unmarshalled item.
 *
 * - DynamoDB JSON (see {@link isAttributeValueImage}): `B` / `BS` members given
 *   as base64 text are decoded at any depth (Lambda and EventBridge Pipes
 *   deliver them that way; `unmarshall` does not decode them), then the image is
 *   unmarshalled.
 * - Already unmarshalled: returned as a shallow copy. A packed attribute's `B`
 *   may still be base64 text there — {@link unpackImageItem} handles it.
 */
export const normalizeImage = (
  image: StreamImage,
  ctx: ItemContext,
  options?: ImageOptions,
): Effect.Effect<Record<string, unknown>, ValidationError> => {
  if (typeof image !== "object" || image === null || Array.isArray(image)) {
    return Effect.fail(
      new ValidationError({
        entityType: ctx.entityType,
        operation: ctx.operation,
        cause: new Error(
          "A stream image must be an object (DynamoDB JSON or an unmarshalled item)",
        ),
      }),
    )
  }
  const form =
    options?.form ??
    (isAttributeValueImage(image, options?.probe) ? "attributeValues" : "unmarshalled")
  if (form === "unmarshalled") return Effect.succeed({ ...(image as Record<string, unknown>) })
  return Effect.flatMap(
    Effect.forEach(Object.entries(image), ([attribute, value]) =>
      Effect.map(
        normalizeAttributeValue(value, { ...ctx, attribute }),
        (normalized) => [attribute, normalized] as const,
      ),
    ),
    (entries) =>
      Effect.try({
        try: () => fromAttributeMap(Object.fromEntries(entries)),
        catch: (cause) =>
          new ValidationError({ entityType: ctx.entityType, operation: ctx.operation, cause }),
      }),
  )
}

/**
 * {@link unpackItem} for a normalised stream image: on a listed attribute, a
 * string that is base64 of a `B` value (it starts with `I`–`P`, which JSON text
 * never does — see `PackedCodec.isBase64PackedText`) is decoded to bytes and
 * read as `B`; any other string is JSON.
 */
export const unpackImageItem = (
  raw: Record<string, unknown>,
  attributes: Iterable<string>,
  registry: CompressionRegistry,
  ctx: ItemContext,
): Effect.Effect<void, PackedError> =>
  Effect.forEach(
    [...attributes],
    (attribute) => {
      const value = raw[attribute]
      const valueCtx = { ...ctx, attribute }
      if (typeof value === "string" && isBase64PackedText(value)) {
        return toBytes(value, valueCtx).pipe(
          Effect.flatMap((bytes) => unpackBytes(bytes, registry, valueCtx)),
          Effect.tap((wire) =>
            Effect.sync(() => {
              raw[attribute] = wire
            }),
          ),
          Effect.asVoid,
        )
      }
      if (typeof value === "string" || value instanceof Uint8Array) {
        return Effect.map(unpackValue(value, registry, valueCtx), (wire) => {
          raw[attribute] = wire
        })
      }
      return Effect.void
    },
    { discard: true },
  )

/**
 * The stream-image decode primitive: normalise `image` and unpack its
 * dispatch-eligible `attributes` (stored names), returning the unmarshalled
 * item with each packed value as its JSON wire form — ready for the same
 * sparse rebuild, renames and schema decode a table read applies.
 *
 * In DynamoDB JSON the `S` / `B` tag says what each value is; in an
 * unmarshalled image a string on a listed attribute is read as base64 `B`
 * when it starts with `I`–`P` (see {@link unpackImageItem}).
 */
export const decodeImage = (
  image: StreamImage,
  attributes: Iterable<string>,
  ctx: ItemContext,
  options?: ImageOptions,
): Effect.Effect<Record<string, unknown>, PackedError> =>
  Effect.gen(function* () {
    const form =
      options?.form ??
      (typeof image === "object" && image !== null && isAttributeValueImage(image, options?.probe)
        ? "attributeValues"
        : "unmarshalled")
    const raw = yield* normalizeImage(image, ctx, { ...options, form })
    const registry = yield* currentRegistry
    if (form === "attributeValues") yield* unpackItem(raw, attributes, registry, ctx)
    else yield* unpackImageItem(raw, attributes, registry, ctx)
    return raw
  })
