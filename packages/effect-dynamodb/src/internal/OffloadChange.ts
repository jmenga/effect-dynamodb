/**
 * @internal Change detection over offloaded fields (#179, design §10.3,
 * §10.4): what a write did to one offloaded field, read from the stored forms
 * of its old and new values — never from the blob store — and the check that
 * a DynamoDB Streams record carries the images change detection needs.
 *
 * - **Stored forms.** An offloaded attribute holds, by its stored form: a
 *   pointer (a `B` json pointer on an overflow attribute, `~edbp:` `S` text on
 *   a binary one), an inline value (an overflow field's JSON as `S`, or as a
 *   v1 `B` — its content the decompressed JSON; a binary field's bytes), a
 *   legacy native value (an overflow attribute written before `Packed`: a map,
 *   a list, …), `NULL`, or nothing.
 * - **Classification** ({@link compareForms}, design §10.3's table): a pointer
 *   to the same ref is `unchanged`; equal checksum algorithm, checksum and
 *   content size elsewhere `rewritten` (probably identical, §5); an inline
 *   value against a pointer is compared by the CRC-64/NVME and size of its
 *   content, computed here; two inline values by their content bytes; legacy
 *   native values only with each other, structurally; anything else
 *   `changed`. `added` / `removed` when one side is absent.
 * - **Records** ({@link recordImages}): `[EDD-9119]` when a record's
 *   `StreamViewType` is not `NEW_AND_OLD_IMAGES`, or a record lacks an image
 *   its event has (a `MODIFY` / `REMOVE` without `OldImage`, a `MODIFY` /
 *   `INSERT` without `NewImage`).
 *
 * Runtime-neutral, like `Offload.ts`, which re-exports {@link compareStored}:
 * no AWS SDK and no Node builtin in its import graph (types included), so the
 * attribute values it takes are typed structurally
 * ({@link StoredAttributeValue}, which the SDK's `AttributeValue` fits).
 *
 * Not part of the public API.
 */

import {
  Compression,
  type CompressionRegistry,
  empty as emptyRegistry,
} from "@effect-dynamodb/schema/Compression.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  type BlobPointer,
  isBlobPointer,
  isPointerText,
} from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import {
  isBase64PackedText,
  type OperationContext,
  parseBinaryPointerText,
  unpackPayloadSync,
} from "@effect-dynamodb/schema/internal/PackedCodec.js"
import { Context, Effect, Result } from "effect"
import { Base64 } from "effect/encoding"
import type { OffloadKind } from "./OffloadValues.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What a write did to one offloaded field, read from its stored forms
 * (design §10.3):
 *
 * - `unchanged` — the same value: a pointer to the same object version, or
 *   inline values with the same content;
 * - `rewritten` — **probably** the same content in another place: another
 *   version (or another stored form — inline, compressed — of it) with the
 *   same checksum algorithm, content checksum and content size. A checksum
 *   match is not proof (CRC-64/NVME can be matched by crafted content): a
 *   consumer that must not miss a change treats `rewritten` as `changed`, or
 *   compares the content;
 * - `changed` — different content (or no way to compare: a legacy native
 *   value against any other form);
 * - `added` / `removed` — the field is only in the new / old image.
 */
export type OffloadChange = "unchanged" | "rewritten" | "changed" | "added" | "removed"

/**
 * One attribute value in DynamoDB JSON, as the SDK, DynamoDB Streams, Lambda
 * and EventBridge Pipes deliver it — `B` / `BS` members as bytes or base64
 * text. Structural, with every member optional, so the SDK's `AttributeValue`
 * and Lambda's (`aws-lambda`) both fit; a value must still have exactly one
 * member, or it fails with a `ValidationError` — a member set to `undefined`
 * is not one (`{ S: "…", B: undefined }` is an `S` value).
 */
export type StoredAttributeValue = {
  readonly S?: string | undefined
  readonly N?: string | undefined
  readonly B?: Uint8Array | string | undefined
  readonly BOOL?: boolean | undefined
  readonly NULL?: boolean | undefined
  readonly SS?: ReadonlyArray<string> | undefined
  readonly NS?: ReadonlyArray<string> | undefined
  readonly BS?: ReadonlyArray<Uint8Array | string> | undefined
  readonly M?: { readonly [name: string]: StoredAttributeValue } | undefined
  readonly L?: ReadonlyArray<StoredAttributeValue> | undefined
}

/** A DynamoDB Streams image: DynamoDB JSON, or an already-unmarshalled item. */
export type RecordImage = { readonly [attribute: string]: unknown }

/**
 * A DynamoDB Streams record — only the members change detection and the
 * blob reaper read. Structural: the SDK's `_Record` (the change feed's
 * records), a Lambda `DynamoDBRecord`, an EventBridge Pipes record and a
 * Kinesis Data Streams for DynamoDB record all fit.
 */
export interface StreamRecordLike {
  readonly eventName?: string | undefined
  /**
   * The ARN of the stream the record was read from
   * (`arn:…:dynamodb:…:table/<name>/stream/<label>`), as Lambda and
   * EventBridge Pipes deliver it.
   */
  readonly eventSourceARN?: string | undefined
  /** The table the record was written to, as a Kinesis Data Streams record carries it. */
  readonly tableName?: string | undefined
  readonly dynamodb?:
    | {
        readonly Keys?: RecordImage | undefined
        readonly OldImage?: RecordImage | undefined
        readonly NewImage?: RecordImage | undefined
        readonly StreamViewType?: string | undefined
        /**
         * A `Date` (the SDK), epoch seconds (DynamoDB Streams JSON: Lambda,
         * Pipes), or epoch milliseconds or microseconds (Kinesis Data
         * Streams, per `ApproximateCreationDateTimePrecision`).
         */
        readonly ApproximateCreationDateTime?: Date | number | undefined
        /** `"MILLISECOND"` or `"MICROSECOND"`: a Kinesis Data Streams record's time unit. */
        readonly ApproximateCreationDateTimePrecision?: string | undefined
      }
    | undefined
}

/** The event and images of a record that passed {@link recordImages}. */
export interface RecordImages {
  readonly eventName: "INSERT" | "MODIFY" | "REMOVE"
  /** A `MODIFY` / `REMOVE` record's `OldImage`; `undefined` for an `INSERT`. */
  readonly oldImage: RecordImage | undefined
  /** An `INSERT` / `MODIFY` record's `NewImage`; `undefined` for a `REMOVE`. */
  readonly newImage: RecordImage | undefined
}

// ---------------------------------------------------------------------------
// Records (EDD-9119)
// ---------------------------------------------------------------------------

const EVENT_NAMES: ReadonlySet<string> = new Set(["INSERT", "MODIFY", "REMOVE"])

const describe = (u: unknown): string => {
  try {
    return JSON.stringify(u) ?? String(u)
  } catch {
    return String(u)
  }
}

const isImage = (u: unknown): u is RecordImage =>
  typeof u === "object" && u !== null && !Array.isArray(u)

/**
 * The event and images of `record`, or why it cannot be read: `[EDD-9119]`
 * when it lacks the images change detection (and the reaper) need — its
 * `StreamViewType` is not `NEW_AND_OLD_IMAGES`, or it lacks an image its
 * event has (design §10.4) — and a plain reason for a record that is not
 * one (no event name of DynamoDB's, an image that is not an object).
 * `consumer` names the caller in the message. A `StreamViewType` is checked
 * when present; the images always, so a record whose view type an input
 * template stripped is still caught. An `INSERT`'s `OldImage` and a
 * `REMOVE`'s `NewImage` are ignored.
 */
export const recordImages = (record: StreamRecordLike, consumer: string): RecordImages | string => {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return "a stream record must be an object"
  }
  const eventName = record.eventName
  if (typeof eventName !== "string" || !EVENT_NAMES.has(eventName)) {
    return (
      `a stream record's eventName must be "INSERT", "MODIFY" or "REMOVE", got ` +
      `${describe(eventName)}`
    )
  }
  const dynamodb = record.dynamodb
  const viewType = dynamodb?.StreamViewType
  if (viewType !== undefined && viewType !== "NEW_AND_OLD_IMAGES") {
    return (
      `[EDD-9119] ${consumer} needs the records of a NEW_AND_OLD_IMAGES stream: this ` +
      `record's StreamViewType is ${describe(viewType)}. Enable the table's stream with ` +
      "StreamViewType NEW_AND_OLD_IMAGES — change detection compares the old and new images."
    )
  }
  const take = (
    name: "OldImage" | "NewImage",
    needed: boolean,
  ): RecordImage | string | undefined => {
    const image = dynamodb?.[name]
    if (!needed) return undefined
    if (image === undefined || image === null) {
      return (
        `[EDD-9119] ${consumer} needs the records of a NEW_AND_OLD_IMAGES stream: this ` +
        `${eventName} record has no ${name}, so its stream's view type is not ` +
        "NEW_AND_OLD_IMAGES (or an input template dropped the image)."
      )
    }
    return isImage(image) ? image : `a stream record's ${name} must be an object`
  }
  const oldImage = take("OldImage", eventName !== "INSERT")
  if (typeof oldImage === "string") return oldImage
  const newImage = take("NewImage", eventName !== "REMOVE")
  if (typeof newImage === "string") return newImage
  return { eventName: eventName as RecordImages["eventName"], oldImage, newImage }
}

// ---------------------------------------------------------------------------
// Stored forms
// ---------------------------------------------------------------------------

/** One side of a comparison: an offloaded attribute's value, by its stored form. */
export type StoredForm =
  | { readonly _tag: "absent" }
  | { readonly _tag: "null" }
  | { readonly _tag: "pointer"; readonly pointer: BlobPointer }
  /** The content the checksum covers: the JSON's UTF-8 bytes (overflow), the bytes (binary). */
  | { readonly _tag: "inline"; readonly content: Uint8Array }
  /** A legacy native value of an overflow attribute, in DynamoDB JSON. */
  | { readonly _tag: "native"; readonly value: StoredAttributeValue }

/** The form of an attribute an image does not hold. */
export const ABSENT: StoredForm = { _tag: "absent" }
const NULL: StoredForm = { _tag: "null" }

const encoder = new TextEncoder()

const invalid = (ctx: OperationContext, attribute: string, message: string, cause?: unknown) =>
  new ValidationError({
    entityType: ctx.entityType,
    operation: ctx.operation,
    cause:
      cause === undefined
        ? new Error(`Offloaded attribute "${attribute}": ${message}`)
        : new Error(`Offloaded attribute "${attribute}": ${message}`, { cause }),
  })

/** Bytes, or the bytes base64 text stands for. */
const bytesOf = (
  value: unknown,
  ctx: OperationContext,
  attribute: string,
): Uint8Array | ValidationError => {
  if (value instanceof Uint8Array) return value
  if (typeof value === "string") {
    const decoded = Base64.decode(value)
    if (Result.isSuccess(decoded)) return decoded.success
    return invalid(ctx, attribute, "a binary value is not valid base64", decoded.failure)
  }
  return invalid(ctx, attribute, `a binary value must be bytes or base64 text, got ${typeof value}`)
}

/** An overflow attribute's `B` value: a json pointer, or an inline value's content. */
const overflowBytes = (
  bytes: Uint8Array,
  registry: CompressionRegistry,
  ctx: OperationContext,
  attribute: string,
): StoredForm | ValidationError => {
  const payload = unpackPayloadSync(bytes, registry, ctx, attribute)
  if (payload instanceof ValidationError) return payload
  return isBlobPointer(payload)
    ? { _tag: "pointer", pointer: payload }
    : { _tag: "inline", content: payload }
}

/** A binary attribute's `S` value: a bytes pointer, or `undefined` when it is not one. */
const binaryText = (
  text: string,
  ctx: OperationContext,
  attribute: string,
): StoredForm | ValidationError | undefined => {
  const pointer = parseBinaryPointerText(text, ctx, attribute)
  if (pointer === undefined || pointer instanceof ValidationError) return pointer
  return { _tag: "pointer", pointer }
}

const notBinary = (ctx: OperationContext, attribute: string, what: string) =>
  invalid(ctx, attribute, `${what} is neither a binary value nor a blob pointer`)

/**
 * An overflow attribute's `S` value: its inline JSON — never a binary field's
 * `~edbp:` pointer, which an overflow attribute does not hold (§4.1: its `S`
 * is JSON, and `~` starts no JSON text).
 */
const overflowText = (
  text: string,
  ctx: OperationContext,
  attribute: string,
): StoredForm | ValidationError =>
  isPointerText(text)
    ? invalid(
        ctx,
        attribute,
        "the stored text is a binary field's blob pointer (~edbp:), which an overflow " +
          "attribute never holds",
      )
    : { _tag: "inline", content: encoder.encode(text) }

/**
 * The one member of a DynamoDB JSON value — a member set to `undefined` is no
 * member (`StoredAttributeValue`'s optional members admit one) — or
 * `undefined` when it has none or several, or is not an object.
 */
const tagOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  let tag: string | undefined
  for (const key of Object.keys(value)) {
    if ((value as Record<string, unknown>)[key] === undefined) continue
    if (tag !== undefined) return undefined
    tag = key
  }
  return tag
}

const ATTRIBUTE_VALUE_TAGS: ReadonlySet<string> = new Set([
  "S",
  "N",
  "B",
  "BOOL",
  "NULL",
  "SS",
  "NS",
  "BS",
  "M",
  "L",
])

/**
 * The stored form of an offloaded attribute's value in DynamoDB JSON (`B` as
 * bytes or base64 text): `undefined` is absent. In DynamoDB JSON the `S` /
 * `B` tag says what the value is.
 */
export const formOfAttributeValue = (
  value: unknown,
  kind: OffloadKind,
  registry: CompressionRegistry,
  ctx: OperationContext,
  attribute: string,
): StoredForm | ValidationError => {
  if (value === undefined) return ABSENT
  const tag = tagOf(value)
  if (tag === undefined || !ATTRIBUTE_VALUE_TAGS.has(tag) || value instanceof Uint8Array) {
    return invalid(ctx, attribute, "the value is not a DynamoDB JSON attribute value")
  }
  const member = (value as Record<string, unknown>)[tag]
  if (tag === "NULL") return NULL
  if (tag === "S") {
    if (typeof member !== "string") return invalid(ctx, attribute, "an S value must be a string")
    if (kind === "overflow") return overflowText(member, ctx, attribute)
    return binaryText(member, ctx, attribute) ?? notBinary(ctx, attribute, "an S value")
  }
  if (tag === "B") {
    const bytes = bytesOf(member, ctx, attribute)
    if (bytes instanceof ValidationError) return bytes
    return kind === "binary"
      ? { _tag: "inline", content: bytes }
      : overflowBytes(bytes, registry, ctx, attribute)
  }
  return kind === "overflow"
    ? { _tag: "native", value: value as StoredAttributeValue }
    : notBinary(ctx, attribute, `a ${tag} value`)
}

/**
 * The stored form of an offloaded attribute's value in an unmarshalled item
 * (`string` for `S`, `Uint8Array` for `B`): `undefined` is absent. In an
 * unmarshalled stream **image** (`image`), a `B` value may arrive as base64
 * text — on an overflow attribute a string starting with `I`–`X` (which JSON
 * text never does), on a binary one any string but a `~edbp:` pointer (§4.3).
 * A legacy native value is marshalled by `marshal` to be compared.
 */
export const formOfUnmarshalled = (
  value: unknown,
  kind: OffloadKind,
  image: boolean,
  marshal: (value: unknown) => unknown,
  registry: CompressionRegistry,
  ctx: OperationContext,
  attribute: string,
): StoredForm | ValidationError => {
  if (value === undefined) return ABSENT
  if (value === null) return NULL
  if (typeof value === "string") {
    if (kind === "overflow") {
      if (!(image && isBase64PackedText(value))) return overflowText(value, ctx, attribute)
      const bytes = bytesOf(value, ctx, attribute)
      return bytes instanceof ValidationError
        ? bytes
        : overflowBytes(bytes, registry, ctx, attribute)
    }
    const pointer = binaryText(value, ctx, attribute)
    if (pointer !== undefined) return pointer
    if (!image) return notBinary(ctx, attribute, "a string value")
    const bytes = bytesOf(value, ctx, attribute)
    return bytes instanceof ValidationError ? bytes : { _tag: "inline", content: bytes }
  }
  if (value instanceof Uint8Array) {
    return kind === "binary"
      ? { _tag: "inline", content: value }
      : overflowBytes(value, registry, ctx, attribute)
  }
  if (kind === "binary") return notBinary(ctx, attribute, `a ${typeof value} value`)
  try {
    return { _tag: "native", value: marshal(value) as StoredAttributeValue }
  } catch (cause) {
    return invalid(ctx, attribute, "the legacy native value cannot be marshalled", cause)
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/** Equal content checksum (algorithm and value) and content size. */
const sameContent = (a: BlobPointer, b: BlobPointer): boolean =>
  a.checksum.algorithm === b.checksum.algorithm &&
  sameBytes(a.checksum.value, b.checksum.value) &&
  a.contentSize === b.contentSize

/** The inline content's CRC-64/NVME and size against the pointer's. */
const inlineMatches = (pointer: BlobPointer, content: Uint8Array): boolean =>
  pointer.checksum.algorithm === "crc64nvme" &&
  pointer.contentSize === content.length &&
  sameBytes(pointer.checksum.value, crc64nvme(content))

const sameRef = (a: BlobPointer, b: BlobPointer): boolean =>
  a.ref.key === b.ref.key && a.ref.version === b.ref.version

/**
 * What the change from `before` to `after` did to the field (design §10.3;
 * see {@link OffloadChange}). Both absent: `unchanged`.
 */
export const compareForms = (before: StoredForm, after: StoredForm): OffloadChange => {
  if (before._tag === "absent") return after._tag === "absent" ? "unchanged" : "added"
  if (after._tag === "absent") return "removed"
  if (before._tag === "null" || after._tag === "null") {
    return before._tag === after._tag ? "unchanged" : "changed"
  }
  if (before._tag === "native" || after._tag === "native") {
    return before._tag === "native" &&
      after._tag === "native" &&
      nativeEquals(before.value, after.value)
      ? "unchanged"
      : "changed"
  }
  if (before._tag === "pointer" && after._tag === "pointer") {
    if (!sameContent(before.pointer, after.pointer)) return "changed"
    return sameRef(before.pointer, after.pointer) ? "unchanged" : "rewritten"
  }
  if (before._tag === "inline" && after._tag === "inline") {
    return sameBytes(before.content, after.content) ? "unchanged" : "changed"
  }
  // One inline, one pointer: the inline content's checksum, computed here.
  const [pointer, inline] =
    before._tag === "pointer"
      ? [before.pointer, (after as { readonly content: Uint8Array }).content]
      : [(after as { readonly pointer: BlobPointer }).pointer, before.content]
  return inlineMatches(pointer, inline) ? "rewritten" : "changed"
}

/** Bytes or base64 text, as bytes — `undefined` when it is neither. */
const looseBytes = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) return value
  if (typeof value !== "string") return undefined
  const decoded = Base64.decode(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

const bytesKey = (value: unknown): string | undefined => {
  const bytes = looseBytes(value)
  return bytes === undefined ? undefined : Array.from(bytes).join(",")
}

const sameSet = (a: ReadonlyArray<string | undefined>, b: ReadonlyArray<string | undefined>) => {
  if (a.includes(undefined) || b.includes(undefined)) return false
  const xs = new Set(a)
  return xs.size === new Set(b).size && b.every((v) => xs.has(v))
}

/** Structural equality of two DynamoDB JSON values (sets as sets, `B` as bytes or base64). */
const nativeEquals = (a: unknown, b: unknown): boolean => {
  const tag = tagOf(a)
  if (tag === undefined || tagOf(b) !== tag) return false
  const x = (a as Record<string, unknown>)[tag]
  const y = (b as Record<string, unknown>)[tag]
  switch (tag) {
    case "L": {
      if (!Array.isArray(x) || !Array.isArray(y)) return false
      return x.length === y.length && x.every((v, i) => nativeEquals(v, y[i]))
    }
    case "M": {
      if (typeof x !== "object" || x === null || typeof y !== "object" || y === null) return false
      const xm = x as Record<string, unknown>
      const ym = y as Record<string, unknown>
      const keys = Object.keys(xm)
      return (
        keys.length === Object.keys(ym).length &&
        keys.every((k) => Object.hasOwn(ym, k) && nativeEquals(xm[k], ym[k]))
      )
    }
    case "SS":
    case "NS":
      return Array.isArray(x) && Array.isArray(y) && sameSet(x, y)
    case "B": {
      const xb = bytesKey(x)
      return xb !== undefined && xb === bytesKey(y)
    }
    case "BS":
      return Array.isArray(x) && Array.isArray(y) && sameSet(x.map(bytesKey), y.map(bytesKey))
    default:
      return x === y
  }
}

// ---------------------------------------------------------------------------
// compareStored
// ---------------------------------------------------------------------------

const COMPARE: OperationContext = {
  entityType: "Offload",
  operation: "Offload.compareStored",
}

/**
 * What a change did to one offloaded field, from the stored attribute values
 * of its old and new images (DynamoDB JSON, `B` as bytes or base64 text;
 * `undefined` when the image has no such attribute) — see
 * {@link OffloadChange}. `kind` is the field's: `"overflow"`
 * (`Packed({ external })`) or `"binary"` (`External`). Never touches the blob
 * store; an inline compressed value is decompressed with the `Compression`
 * service in scope to checksum its content (without the codec: a
 * `ValidationError` whose `cause` is a `CompressorNotRegistered`). A value
 * that is not a stored form of `kind` (a malformed pointer, an `S` value on a
 * binary attribute that is not a pointer, a binary field's `~edbp:` text on
 * an overflow attribute) fails with a `ValidationError`.
 */
export const compareStored = (
  oldValue: StoredAttributeValue | undefined,
  newValue: StoredAttributeValue | undefined,
  kind: OffloadKind,
): Effect.Effect<OffloadChange, ValidationError> =>
  Effect.withFiber((fiber) => {
    if (kind !== "overflow" && kind !== "binary") {
      return Effect.fail(
        new ValidationError({
          ...COMPARE,
          cause: new Error(
            `compareStored: kind must be "overflow" or "binary", got ${describe(kind)}`,
          ),
        }),
      )
    }
    const registry =
      Context.getOrUndefined(fiber.context as Context.Context<never>, Compression) ?? emptyRegistry
    const before = formOfAttributeValue(oldValue, kind, registry, COMPARE, "old value")
    if (before instanceof ValidationError) return Effect.fail(before)
    const after = formOfAttributeValue(newValue, kind, registry, COMPARE, "new value")
    if (after instanceof ValidationError) return Effect.fail(after)
    return Effect.succeed(compareForms(before, after))
  })
