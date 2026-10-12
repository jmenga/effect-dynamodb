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
 * The registry is read from the fiber's context (as `Effect.serviceOption`
 * would), so nothing here adds a requirement; an absent service is the empty
 * registry. Every per-value step is synchronous — a plain function returning
 * its result or the `ValidationError` it fails with — and is lifted into an
 * Effect once per item (or per operation), not once per value: a read of
 * thousands of rows pays for `JSON.parse` / decompression, not for Effect
 * plumbing around each value.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import {
  Compression,
  type CompressionRegistry,
  empty as emptyRegistry,
} from "@effect-dynamodb/schema/Compression.js"
import type { PackedConfig } from "@effect-dynamodb/schema/DynamoModel.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  isBase64PackedText,
  type OperationContext,
  type PackedContext,
  type PackedStored,
  packValueSync,
  unpackBytesSync,
  unpackStoredSync,
} from "@effect-dynamodb/schema/internal/PackedCodec.js"
import { Context, Effect, Result } from "effect"
import { Base64 } from "effect/encoding"
import { fromAttributeMap } from "../Marshaller.js"
import type { QueryRawRow } from "../Query.js"
import type { Expr, Operand } from "./Expr.js"

export type { PackedContext, PackedStored } from "@effect-dynamodb/schema/internal/PackedCodec.js"

/** Who is packing/unpacking an item; the attribute is named per value only on failure. */
export type ItemContext = OperationContext

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The compressor registry in a context — the empty registry when none is provided. */
export const registryOf = (context: Context.Context<never>): CompressionRegistry =>
  Context.getOrUndefined(context, Compression) ?? emptyRegistry

/** The compressor registry in scope — the empty registry when none is provided. */
export const currentRegistry: Effect.Effect<CompressionRegistry> = Effect.withFiber((fiber) =>
  Effect.succeed(registryOf(fiber.context)),
)

/**
 * Run a synchronous pack/unpack step with the registry in scope, as ONE
 * Effect: `step` returns its result, or the `ValidationError` it fails with.
 * (`step` must never succeed with a `ValidationError` value — none of the
 * steps here can: they return parsed JSON, stored values or `undefined`.)
 */
export const withRegistry = <A>(
  step: (registry: CompressionRegistry) => A | ValidationError,
): Effect.Effect<A, ValidationError> =>
  Effect.withFiber((fiber) => {
    const result = step(registryOf(fiber.context))
    return result instanceof ValidationError ? Effect.fail(result) : Effect.succeed(result as A)
  })

/** Lift a synchronous step's result (or the `ValidationError` it returned) into an Effect. */
export const fromStep = <A>(result: A | ValidationError): Effect.Effect<A, ValidationError> =>
  result instanceof ValidationError ? Effect.fail(result) : Effect.succeed(result as A)

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Pack, in place, every attribute of `item` (keyed by **stored** name) that
 * `packed` configures. An attribute the item does not carry is left absent; a
 * wire value of `undefined` removes it. Returns the `ValidationError` of the
 * first attribute that fails (the item is then partly packed — discard it), or
 * `undefined`.
 */
export const packItemSync = (
  item: Record<string, unknown>,
  packed: Readonly<Record<string, PackedConfig>>,
  registry: CompressionRegistry,
  ctx: ItemContext,
): ValidationError | undefined => {
  for (const attribute in packed) {
    if (!(attribute in item)) continue
    const stored = packValueSync(packed[attribute]!, item[attribute], registry, ctx, attribute)
    if (stored instanceof ValidationError) return stored
    if (stored === undefined) delete item[attribute]
    else item[attribute] = stored
  }
  return undefined
}

/** {@link packItemSync} as an Effect. */
export const packItem = (
  item: Record<string, unknown>,
  packed: Readonly<Record<string, PackedConfig>>,
  registry: CompressionRegistry,
  ctx: ItemContext,
): Effect.Effect<void, ValidationError> => {
  const failure = packItemSync(item, packed, registry, ctx)
  return failure === undefined ? Effect.void : Effect.fail(failure)
}

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
): Effect.Effect<AttributeValue | undefined, ValidationError> =>
  fromStep(packAttributeValueSync(config, wire, registry, ctx, ctx.attribute))

/** {@link packAttributeValue} without an Effect: the value, or the failure (returned). */
export const packAttributeValueSync = (
  config: PackedConfig,
  wire: unknown,
  registry: CompressionRegistry,
  ctx: ItemContext,
  attribute: string,
): AttributeValue | undefined | ValidationError => {
  const stored = packValueSync(config, wire, registry, ctx, attribute)
  return stored instanceof ValidationError ? stored : storedToAttributeValue(stored)
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * True iff any listed attribute of `raw` holds a string or bytes — a value
 * read by its stored form. A native row (maps, lists, absent) is false, and
 * costs one `typeof` per attribute.
 */
export const hasStoredForm = (
  raw: Record<string, unknown>,
  attributes: ReadonlyArray<string>,
): boolean => {
  for (let i = 0; i < attributes.length; i++) {
    const value = raw[attributes[i]!]
    if (typeof value === "string" || value instanceof Uint8Array) return true
  }
  return false
}

/**
 * Unpack, in place, every listed attribute of an unmarshalled item (keyed by
 * **stored** name) by its stored form. Native values cost one `typeof` check.
 * Returns the `ValidationError` of the first value that fails, or `undefined`.
 */
export const unpackItemSync = (
  raw: Record<string, unknown>,
  attributes: Iterable<string>,
  registry: CompressionRegistry,
  ctx: ItemContext,
): ValidationError | undefined => {
  for (const attribute of attributes) {
    const value = raw[attribute]
    if (typeof value !== "string" && !(value instanceof Uint8Array)) continue
    const wire = unpackStoredSync(value, registry, ctx, attribute)
    if (wire instanceof ValidationError) return wire
    raw[attribute] = wire
  }
  return undefined
}

/** {@link unpackItemSync} as an Effect. */
export const unpackItem = (
  raw: Record<string, unknown>,
  attributes: Iterable<string>,
  registry: CompressionRegistry,
  ctx: ItemContext,
): Effect.Effect<void, ValidationError> => {
  const failure = unpackItemSync(raw, attributes, registry, ctx)
  return failure === undefined ? Effect.void : Effect.fail(failure)
}

/**
 * {@link unpackItemSync} with the registry in scope, as one Effect — and no
 * registry lookup at all for a row with nothing stored packed.
 */
export const unpackRow = (
  raw: Record<string, unknown>,
  attributes: ReadonlyArray<string>,
  ctx: ItemContext,
): Effect.Effect<void, ValidationError> =>
  hasStoredForm(raw, attributes)
    ? withRegistry((registry) => unpackItemSync(raw, attributes, registry, ctx))
    : Effect.void

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

/**
 * The entity type (`__edd_e__`) a stream image names, read straight off the
 * image — `{ S }` in DynamoDB JSON, a string when unmarshalled — so a decoder
 * can turn away an image of another type **before** unmarshalling it: an
 * attribute the SDK cannot unmarshall (a number beyond what it represents,
 * say) in some other entity's image must not fail the decode of a batch.
 * `undefined` when the image names none.
 */
export const imageEntityType = (image: StreamImage): string | undefined => {
  if (typeof image !== "object" || image === null || Array.isArray(image)) return undefined
  const value = (image as Record<string, unknown>).__edd_e__
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null) {
    const s = (value as { readonly S?: unknown }).S
    if (typeof s === "string") return s
  }
  return undefined
}

const imageError = (ctx: ItemContext, message: string, cause?: unknown): ValidationError =>
  new ValidationError({
    entityType: ctx.entityType,
    operation: ctx.operation,
    cause: cause === undefined ? new Error(message) : new Error(message, { cause }),
  })

/** Decode base64 text (or pass bytes through), or the failure naming the attribute. */
const toBytesSync = (
  value: unknown,
  ctx: ItemContext,
  attribute: string,
): Uint8Array | ValidationError => {
  if (value instanceof Uint8Array) return value
  if (typeof value === "string") {
    const decoded = Base64.decode(value)
    if (Result.isSuccess(decoded)) return decoded.success
    return imageError(
      ctx,
      `Attribute "${attribute}": a binary value is not valid base64`,
      decoded.failure,
    )
  }
  return imageError(
    ctx,
    `Attribute "${attribute}": a binary value must be bytes or base64 text, got ${typeof value}`,
  )
}

/**
 * One DynamoDB-JSON `AttributeValue` with every `B` / `BS` member (at any
 * depth) as real bytes — the value itself when it holds none as text, so a
 * typical image is not copied.
 */
const normalizeAttributeValueSync = (
  value: unknown,
  ctx: ItemContext,
  path: string,
): AttributeValue | ValidationError => {
  if (!isAttributeValueShape(value)) {
    return imageError(ctx, `Attribute "${path}": not a DynamoDB JSON attribute value`)
  }
  const av = value as Record<string, unknown>
  if ("B" in av) {
    if (av.B instanceof Uint8Array) return av as unknown as AttributeValue
    const B = toBytesSync(av.B, ctx, path)
    return B instanceof ValidationError ? B : { B }
  }
  if ("BS" in av) {
    if (!Array.isArray(av.BS) || av.BS.every((element) => element instanceof Uint8Array)) {
      return av as unknown as AttributeValue
    }
    const BS: Array<Uint8Array> = []
    for (const element of av.BS as ReadonlyArray<unknown>) {
      const bytes = toBytesSync(element, ctx, path)
      if (bytes instanceof ValidationError) return bytes
      BS.push(bytes)
    }
    return { BS }
  }
  if ("M" in av && typeof av.M === "object" && av.M !== null) {
    const members = av.M as Record<string, unknown>
    let copy: Record<string, AttributeValue> | undefined
    for (const name in members) {
      const nested = members[name]
      const normalized = normalizeAttributeValueSync(nested, ctx, `${path}.${name}`)
      if (normalized instanceof ValidationError) return normalized
      if (normalized !== nested) {
        copy ??= { ...(members as Record<string, AttributeValue>) }
        copy[name] = normalized
      }
    }
    return copy === undefined ? (av as unknown as AttributeValue) : { M: copy }
  }
  if ("L" in av && Array.isArray(av.L)) {
    const elements = av.L as ReadonlyArray<unknown>
    let copy: Array<AttributeValue> | undefined
    for (let i = 0; i < elements.length; i++) {
      const nested = elements[i]
      const normalized = normalizeAttributeValueSync(nested, ctx, `${path}[${i}]`)
      if (normalized instanceof ValidationError) return normalized
      if (normalized !== nested) {
        copy ??= [...(elements as ReadonlyArray<AttributeValue>)]
        copy[i] = normalized
      }
    }
    return copy === undefined ? (av as unknown as AttributeValue) : { L: copy }
  }
  return av as unknown as AttributeValue
}

/** How {@link normalizeImage} reads an image. */
export interface ImageOptions {
  /** The attribute {@link isAttributeValueImage} probes (default `"pk"`). */
  readonly probe?: string | undefined
  /** Skip detection: the image is known to be DynamoDB JSON, or unmarshalled. */
  readonly form?: "attributeValues" | "unmarshalled" | undefined
}

/** The form of `image` — `options.form`, or detected (see {@link isAttributeValueImage}). */
export const imageForm = (
  image: StreamImage,
  options?: ImageOptions,
): "attributeValues" | "unmarshalled" =>
  options?.form ??
  (typeof image === "object" &&
  image !== null &&
  !Array.isArray(image) &&
  isAttributeValueImage(image, options?.probe)
    ? "attributeValues"
    : "unmarshalled")

/**
 * {@link normalizeImage} without an Effect: the unmarshalled item, or the
 * `ValidationError` it fails with (returned, never thrown).
 */
export const normalizeImageSync = (
  image: StreamImage,
  ctx: ItemContext,
  options?: ImageOptions,
): Record<string, unknown> | ValidationError => {
  if (typeof image !== "object" || image === null || Array.isArray(image)) {
    return imageError(
      ctx,
      "A stream image must be an object (DynamoDB JSON or an unmarshalled item)",
    )
  }
  if (imageForm(image, options) === "unmarshalled") {
    return { ...(image as Record<string, unknown>) }
  }
  const source = image as Record<string, unknown>
  let normalized: Record<string, AttributeValue> | undefined
  for (const attribute in source) {
    const value = source[attribute]
    const av = normalizeAttributeValueSync(value, ctx, attribute)
    if (av instanceof ValidationError) return av
    if (av !== value) {
      normalized ??= { ...(source as Record<string, AttributeValue>) }
      normalized[attribute] = av
    }
  }
  try {
    return fromAttributeMap(normalized ?? (source as Record<string, AttributeValue>))
  } catch (cause) {
    return new ValidationError({ entityType: ctx.entityType, operation: ctx.operation, cause })
  }
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
): Effect.Effect<Record<string, unknown>, ValidationError> =>
  Effect.suspend(() => fromStep(normalizeImageSync(image, ctx, options)))

/**
 * {@link unpackItemSync} for a normalised **unmarshalled** stream image: on a
 * listed attribute, a string that is base64 of a `B` value (it starts with
 * `I`–`P`, which JSON text never does — see `PackedCodec.isBase64PackedText`)
 * is decoded to bytes and read as `B`; any other string is JSON.
 */
export const unpackImageItemSync = (
  raw: Record<string, unknown>,
  attributes: Iterable<string>,
  registry: CompressionRegistry,
  ctx: ItemContext,
): ValidationError | undefined => {
  for (const attribute of attributes) {
    let value = raw[attribute]
    if (typeof value === "string" && isBase64PackedText(value)) {
      const bytes = toBytesSync(value, ctx, attribute)
      if (bytes instanceof ValidationError) return bytes
      const wire = unpackBytesSync(bytes, registry, ctx, attribute)
      if (wire instanceof ValidationError) return wire
      raw[attribute] = wire
      continue
    }
    if (typeof value !== "string" && !(value instanceof Uint8Array)) continue
    value = unpackStoredSync(value, registry, ctx, attribute)
    if (value instanceof ValidationError) return value
    raw[attribute] = value
  }
  return undefined
}

/** {@link unpackImageItemSync} as an Effect. */
export const unpackImageItem = (
  raw: Record<string, unknown>,
  attributes: Iterable<string>,
  registry: CompressionRegistry,
  ctx: ItemContext,
): Effect.Effect<void, ValidationError> => {
  const failure = unpackImageItemSync(raw, attributes, registry, ctx)
  return failure === undefined ? Effect.void : Effect.fail(failure)
}

/**
 * {@link decodeImage} without an Effect, with an explicit registry: the
 * unmarshalled item, or the `ValidationError` it fails with.
 */
export const decodeImageSync = (
  image: StreamImage,
  attributes: Iterable<string>,
  registry: CompressionRegistry,
  ctx: ItemContext,
  options?: ImageOptions,
): Record<string, unknown> | ValidationError => {
  const form = imageForm(image, options)
  const raw = normalizeImageSync(image, ctx, { ...options, form })
  if (raw instanceof ValidationError) return raw
  // In DynamoDB JSON the S / B tag says what each value is; unmarshalled, a
  // string that is base64 of a `B` value is told apart from JSON text.
  const failure =
    form === "attributeValues"
      ? unpackItemSync(raw, attributes, registry, ctx)
      : unpackImageItemSync(raw, attributes, registry, ctx)
  return failure ?? raw
}

/**
 * The stream-image decode primitive: normalise `image` and unpack its
 * dispatch-eligible `attributes` (stored names), returning the unmarshalled
 * item with each packed value as its JSON wire form — ready for the same
 * sparse rebuild, renames and schema decode a table read applies. One Effect
 * per image; the work inside is synchronous.
 *
 * In DynamoDB JSON the `S` / `B` tag says what each value is; in an
 * unmarshalled image a string on a listed attribute is read as base64 `B`
 * when it starts with `I`–`P` (see {@link unpackImageItemSync}).
 */
export const decodeImage = (
  image: StreamImage,
  attributes: Iterable<string>,
  ctx: ItemContext,
  options?: ImageOptions,
): Effect.Effect<Record<string, unknown>, ValidationError> =>
  withRegistry((registry) => decodeImageSync(image, attributes, registry, ctx, options))

// ---------------------------------------------------------------------------
// Expression and projection guards (EDD-9076)
// ---------------------------------------------------------------------------

/**
 * A packed attribute an expression or projection may not look inside: DynamoDB
 * sees one opaque `S` or `B` value, so a path below it, or any operator but
 * `attribute_exists` / `attribute_not_exists` on it as a whole, can never
 * match what the reader means.
 */
export interface PackedAttributeGuard {
  /** The stored (top-level) attribute name. */
  readonly attribute: string
  /** Who stores it, for the message — e.g. `EventStream "Ledger"`. */
  readonly owner: string
  /** Its storage config (the message names the format). */
  readonly storedAs: PackedConfig
  /** What to do instead, given the refused path as written (`data.amount`). */
  readonly alternative: (path: string) => string
}

/** Render path segments as written: `data.items[0].sku`. */
export const formatPath = (segments: ReadonlyArray<string | number>): string =>
  segments
    .map((segment, i) =>
      typeof segment === "number" ? `[${segment}]` : i === 0 ? segment : `.${segment}`,
    )
    .join("")

const OPERATOR_NAMES: Readonly<Record<string, string>> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  between: "BETWEEN",
  in: "IN",
  type: "attribute_type",
  beginsWith: "begins_with",
  contains: "contains",
}

const refusal = (
  guard: PackedAttributeGuard,
  usage: string,
  path: string,
  problem: string,
): string =>
  `[EDD-9076] ${guard.owner}: the ${usage} ${problem}, but \`${guard.attribute}\` is stored packed ` +
  `(format "${guard.storedAs.format}"): DynamoDB sees one opaque string or binary value and ` +
  "cannot evaluate a path inside it, or compare it — only attribute_exists / " +
  `attribute_not_exists apply to it as a whole. ${guard.alternative(path)}`

/**
 * Why `expr` cannot be sent against an item with these packed attributes, or
 * `undefined` when it can: it addresses a path inside one, or applies anything
 * but `attribute_exists` / `attribute_not_exists` to one (`size()` included).
 * `usage` names the expression in the message (`"filter"`, `"condition"`).
 */
export const packedExprRefusal = (
  expr: Expr,
  guards: ReadonlyArray<PackedAttributeGuard>,
  usage: string,
): string | undefined => {
  if (guards.length === 0) return undefined
  const guardFor = (segments: ReadonlyArray<string | number>) => {
    const head = segments[0]
    return typeof head === "string" ? guards.find((g) => g.attribute === head) : undefined
  }
  const check = (operand: Operand, operator: string): string | undefined => {
    if (operand._tag === "value") return undefined
    const guard = guardFor(operand.segments)
    if (guard === undefined) return undefined
    const path = formatPath(operand.segments)
    if (operand._tag === "size") {
      return refusal(guard, usage, path, `applies size() to "${path}"`)
    }
    if (operand.segments.length > 1) {
      return refusal(guard, usage, path, `addresses "${path}"`)
    }
    return refusal(guard, usage, path, `applies ${operator} to "${path}"`)
  }
  const walk = (node: Expr): string | undefined => {
    switch (node._tag) {
      case "and":
      case "or": {
        for (const part of node.exprs) {
          const found = walk(part)
          if (found !== undefined) return found
        }
        return undefined
      }
      case "not":
        return walk(node.expr)
      case "exists":
      case "notExists": {
        const operand = node.operand
        // The whole attribute: whether it is stored at all is answerable.
        if (operand._tag === "path" && operand.segments.length === 1) return undefined
        return check(operand, node._tag === "exists" ? "attribute_exists" : "attribute_not_exists")
      }
      case "eq":
      case "ne":
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        return (
          check(node.left, OPERATOR_NAMES[node._tag]!) ??
          check(node.right, OPERATOR_NAMES[node._tag]!)
        )
      case "between":
        return (
          check(node.operand, "BETWEEN") ??
          check(node.low, "BETWEEN") ??
          check(node.high, "BETWEEN")
        )
      case "in": {
        const found = check(node.operand, "IN")
        if (found !== undefined) return found
        for (const value of node.values) {
          const inner = check(value, "IN")
          if (inner !== undefined) return inner
        }
        return undefined
      }
      case "type":
        return check(node.operand, "attribute_type")
      case "beginsWith":
        return check(node.operand, "begins_with") ?? check(node.prefix, "begins_with")
      case "contains":
        return check(node.operand, "contains") ?? check(node.value, "contains")
    }
  }
  return walk(expr)
}

/**
 * Why a projection cannot be sent against an item with these packed
 * attributes, or `undefined` when it can: a packed attribute may be projected
 * only whole. `paths` are segment lists (`selectPaths`); a dotted or indexed
 * name given to `select` (`"data.amount"`, `"data[0]"`) is read as the path it
 * spells.
 */
export const packedProjectionRefusal = (
  paths: ReadonlyArray<ReadonlyArray<string | number>>,
  guards: ReadonlyArray<PackedAttributeGuard>,
): string | undefined => {
  if (guards.length === 0) return undefined
  for (const segments of paths) {
    const head = segments[0]
    if (typeof head !== "string") continue
    let guard: PackedAttributeGuard | undefined
    let nested = segments.length > 1
    if (segments.length === 1) {
      // `select(["data.amount"])` — the name as a path.
      guard = guards.find(
        (g) => head.startsWith(`${g.attribute}.`) || head.startsWith(`${g.attribute}[`),
      )
      nested = guard !== undefined
    } else {
      guard = guards.find((g) => g.attribute === head)
    }
    if (guard === undefined || !nested) continue
    const path = segments.length === 1 ? head : formatPath(segments)
    return (
      `[EDD-9076] ${guard.owner}: the projection names "${path}", but \`${guard.attribute}\` is ` +
      `stored packed (format "${guard.storedAs.format}"): DynamoDB holds it as one opaque string or ` +
      `binary value and cannot project a path inside it. Select "${guard.attribute}" whole — a ` +
      "projected packed attribute comes back as its parsed JSON."
    )
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Entity / collection query wiring
// ---------------------------------------------------------------------------

/** The packed-storage surface of an entity a query is built over. */
export interface PackedEntityLike {
  readonly entityType: string
  readonly _packedGuards?: ReadonlyArray<PackedAttributeGuard> | undefined
  readonly _unpackFields?:
    | ((raw: Record<string, unknown>, operation?: string) => Effect.Effect<void, ValidationError>)
    | undefined
  /** The stored attributes `_unpackFields` reads by stored form (packed ∪ dispatch-eligible). */
  readonly _dispatchAttributes?: ReadonlyArray<string> | undefined
}

/**
 * The raw-row hook of one entity type's projections (`Query.select` /
 * `selectPaths`): reads `attributes` of the type's **own** rows by their stored
 * form, and hands every other row back untouched. `ignoreOwnership()` lets
 * rows of other types through, and their plain strings must never be parsed
 * as packed JSON. The type is read from `__edd_e__`, borrowed into the
 * projection (and stripped again) when the caller did not select it; a row
 * without it is not attributable, so it is left as is. No hook when there is
 * nothing to read, and none on a projection that names none of `attributes`.
 */
export const ownRowsRawRow = (
  entityType: string,
  attributes: ReadonlyArray<string> | undefined,
  unpack: (raw: Record<string, unknown>) => Effect.Effect<unknown, ValidationError>,
): QueryRawRow | undefined =>
  attributes !== undefined && attributes.length === 0
    ? undefined
    : Object.assign(
        (raw: Record<string, unknown>) =>
          raw.__edd_e__ === entityType ? Effect.as(unpack(raw), raw) : Effect.succeed(raw),
        { reads: ["__edd_e__"], attributes },
      )

/** `Query.make` options for the queries of one entity: guards + raw-row unpack. */
export const entityPackedQueryOptions = (
  entity: PackedEntityLike,
): {
  readonly packed: ReadonlyArray<PackedAttributeGuard>
  readonly rawRow: QueryRawRow | undefined
} => {
  const unpack = entity._unpackFields
  return {
    packed: entity._packedGuards ?? [],
    rawRow:
      unpack === undefined
        ? undefined
        : ownRowsRawRow(entity.entityType, entity._dispatchAttributes, (raw) => unpack(raw)),
  }
}

/**
 * `Query.make` options for a query over several entities (a collection): every
 * member's guards (a path packed in any member is refused, naming it), and a
 * raw-row unpack by the member the row's `__edd_e__` names.
 */
export const collectionPackedQueryOptions = (
  members: ReadonlyArray<PackedEntityLike>,
): {
  readonly packed: ReadonlyArray<PackedAttributeGuard>
  readonly rawRow: QueryRawRow | undefined
} => {
  const byType = new Map(members.map((m) => [m.entityType, m]))
  const packed = members.flatMap((m) => m._packedGuards ?? [])
  const unpacking = members.filter(
    (m) => m._unpackFields !== undefined && m._dispatchAttributes?.length !== 0,
  )
  if (unpacking.length === 0) return { packed, rawRow: undefined }
  // A row of a type that is not a member is never read (`ignoreOwnership()`).
  const rawRow = (raw: Record<string, unknown>) => {
    const member = byType.get(raw.__edd_e__ as string)
    const unpack = member?._unpackFields
    return unpack === undefined ? Effect.succeed(raw) : Effect.as(unpack(raw), raw)
  }
  // The member is named by `__edd_e__`, so a projection that does not select
  // it still reads it (borrowed, then stripped — see `Query.QueryRawRow`); a
  // projection naming none of the members' read attributes runs no hook.
  const attributes = unpacking.every((m) => m._dispatchAttributes !== undefined)
    ? [...new Set(unpacking.flatMap((m) => m._dispatchAttributes ?? []))]
    : undefined
  return { packed, rawRow: Object.assign(rawRow, { reads: ["__edd_e__"], attributes }) }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * {@link packedExprRefusal} for an already-compiled expression
 * (`Transaction.check`'s `ExpressionResult`): every placeholder naming a packed
 * attribute must appear as the whole operand of `attribute_exists(...)` /
 * `attribute_not_exists(...)` — never with a path below it or under another
 * operator. A placeholder used as a nested segment (`#a.#b`) is another
 * attribute's path, and is left alone.
 */
export const packedCompiledRefusal = (
  expression: string,
  names: Readonly<Record<string, string>>,
  guards: ReadonlyArray<PackedAttributeGuard>,
  usage: string,
): string | undefined => {
  if (guards.length === 0) return undefined
  for (const [placeholder, name] of Object.entries(names)) {
    const guard = guards.find((g) => g.attribute === name)
    if (guard === undefined) continue
    const occurrences = new RegExp(`${escapeRegExp(placeholder)}(?![A-Za-z0-9_])`, "g")
    for (const match of expression.matchAll(occurrences)) {
      const start = match.index
      const before = expression.slice(0, start)
      if (/[.\]]\s*$/.test(before)) continue // a nested segment of another path
      const after = expression.slice(start + placeholder.length)
      if (/^\s*[.[]/.test(after)) {
        return refusal(guard, usage, name, `addresses a path inside "${name}"`)
      }
      if (/attribute_(?:not_)?exists\(\s*$/.test(before) && /^\s*\)/.test(after)) continue
      return refusal(
        guard,
        usage,
        name,
        `applies an operator other than attribute_exists to "${name}"`,
      )
    }
  }
  return undefined
}
