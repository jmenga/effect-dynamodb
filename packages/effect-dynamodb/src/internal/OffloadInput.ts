/**
 * @internal Write inputs of binary fields (#179, design §3.8, §7): what a
 * `DynamoModel.External()` field takes on a write — a `Uint8Array`, a
 * `Stream` of bytes, a `BlobHandle` (content to copy) or `Offload.source(...)`
 * (bytes or a stream with upload options) — and how a write carries each one
 * from its input to its upload.
 *
 * - **Placeholders.** Schema encoding, renames and request building handle a
 *   binary field's value as a `Uint8Array`. So {@link prepare} replaces every
 *   input that is not one with a fresh `Uint8Array` **placeholder**,
 *   registered (by identity) with what it stands for; the write path carries
 *   the placeholder to `OffloadWrite.route`, which uploads what it stands for
 *   ({@link preparedOf}). The bytes of an `Offload.source(bytes)` are the
 *   placeholder's own content (a copy), so the field's schema checks them
 *   like any other bytes; a stream's or a handle's placeholder is empty and
 *   **opaque** — the write path skips the field's schema for it
 *   ({@link opaqueFields}), as its content is not in hand before the upload.
 * - **Single-use streams.** A placeholder stands for its stream; the upload
 *   ledger runs a given stream at most once, for one target object
 *   (`BlobLedger`, `[EDD-9120]`).
 * - **Refusals.** {@link prepare} refuses, as a `ValidationError` naming
 *   `[EDD-9120]`, an input of the wrong shape for a binary field and a
 *   stream, handle, source or lazy value for an overflow field (which takes
 *   its domain value) — reachable only from untyped code.
 *
 * `prepare` is idempotent: a placeholder is kept as it is, so a write path
 * that hands its prepared input to another (a guarded upsert's create, an
 * update that creates its missing item) prepares nothing twice.
 *
 * Not part of the public API (`Offload.source`, `BinaryInput` and
 * `BlobSource` are).
 */

import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { MAX_CONTENT_TYPE_BYTES } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Effect, Inspectable, Pipeable, Stream } from "effect"
import { type BlobHandle, isBlobHandle, isOffloadedValue } from "./OffloadValues.js"

// ---------------------------------------------------------------------------
// BlobSource (public through Offload.ts)
// ---------------------------------------------------------------------------

export const BlobSourceTypeId: unique symbol = Symbol.for("effect-dynamodb/BlobSource")
export type BlobSourceTypeId = typeof BlobSourceTypeId

/** Upload options of one binary value ({@link source}). */
export interface BlobSourceOptions {
  /**
   * The object's `Content-Type` (and the pointer's): non-empty printable
   * US-ASCII (no control character, which no HTTP header carries), at most
   * 255 bytes. Default: the field's `External({ contentType })`.
   */
  readonly contentType?: string | undefined
  /**
   * The body's length in bytes, when known before it is consumed: a stream
   * that gives more or fewer bytes fails the write (`SourceFailed`). A store
   * may use it to plan the upload (the S3 store raises its part size for a
   * long one).
   */
  readonly contentLength?: number | undefined
}

/** A binary value with upload options: {@link source}. */
export interface BlobSource extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [BlobSourceTypeId]: BlobSourceTypeId
  readonly body: Uint8Array | Stream.Stream<Uint8Array, unknown, never>
  readonly contentType: string | undefined
  readonly contentLength: number | undefined
}

/**
 * What a binary field (`DynamoModel.External()`) takes on a write:
 *
 * - a `Uint8Array` — the bytes;
 * - a `Stream` of byte chunks — **single-use**: the library runs it at most
 *   once, for one target object (a second field, item or operation given the
 *   same `Stream` value fails with `[EDD-9120]`); a failure of the stream
 *   fails the write with `BlobStoreError { reason: "SourceFailed" }`;
 * - a `BlobHandle` (a binary field read lazily) — content to **copy**: the
 *   write stores a new version under this item's key, never shares the
 *   handle's;
 * - {@link source}`(bytes | stream, { contentType, contentLength })`.
 */
export type BinaryInput =
  | Uint8Array
  | Stream.Stream<Uint8Array, unknown, never>
  | BlobHandle
  | BlobSource

const BlobSourceProto = Object.assign(
  Object.create(Inspectable.BaseProto) as Inspectable.Inspectable,
  {
    [BlobSourceTypeId]: BlobSourceTypeId as BlobSourceTypeId,
    pipe(this: BlobSource) {
      return Pipeable.pipeArguments(this, arguments)
    },
    toJSON(this: BlobSource) {
      return {
        _id: "BlobSource",
        body: this.body instanceof Uint8Array ? `Uint8Array(${this.body.length})` : "Stream",
        contentType: this.contentType,
        contentLength: this.contentLength,
      }
    },
  },
)

/**
 * A binary field's value with upload options: its bytes or a stream of them,
 * the object's content type, and the body's length when known. The options
 * are checked when the write runs (`[EDD-9120]`).
 *
 * @example
 * ```ts
 * db.entities.Documents.put({
 *   id,
 *   owner,
 *   scan: Offload.source(fileStream, { contentType: "image/png", contentLength: size }),
 * })
 * ```
 */
export const source = (
  body: Uint8Array | Stream.Stream<Uint8Array, unknown, never>,
  options?: BlobSourceOptions,
): BlobSource =>
  Object.freeze(
    Object.assign(Object.create(BlobSourceProto) as BlobSource, {
      body,
      contentType: options?.contentType,
      contentLength: options?.contentLength,
    }),
  )

/** True iff `u` is a {@link BlobSource}. */
export const isBlobSource = (u: unknown): u is BlobSource =>
  typeof u === "object" && u !== null && BlobSourceTypeId in u

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/** What a placeholder stands for. */
export type Prepared =
  /** `Offload.source(bytes)`: the placeholder holds (a copy of) the bytes. */
  | { readonly _tag: "Bytes"; readonly contentType: string | undefined }
  /** A stream (or `Offload.source(stream)`): `identity` is the caller's `Stream` value. */
  | {
      readonly _tag: "Stream"
      readonly stream: Stream.Stream<Uint8Array, unknown>
      readonly identity: object
      readonly contentType: string | undefined
      readonly contentLength: number | undefined
    }
  /** A handle: content to copy. */
  | { readonly _tag: "Handle"; readonly handle: BlobHandle }

const placeholders = new WeakMap<Uint8Array, Prepared>()

/** What `value` stands for, when it is a placeholder {@link prepare} made. */
export const preparedOf = (value: unknown): Prepared | undefined =>
  value instanceof Uint8Array ? placeholders.get(value) : undefined

/** True iff `value` is an opaque placeholder (a stream's or a handle's). */
export const isOpaque = (value: unknown): boolean => {
  const prepared = preparedOf(value)
  return prepared !== undefined && prepared._tag !== "Bytes"
}

const placeholder = (prepared: Prepared, bytes?: Uint8Array): Uint8Array => {
  const out = bytes === undefined ? new Uint8Array(0) : new Uint8Array(bytes)
  placeholders.set(out, prepared)
  return out
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

/** A member's offloaded fields, by domain name. */
export interface InputFields {
  readonly entityType: string
  /** Binary (`External`) fields. */
  readonly binary: ReadonlyArray<string>
  /** Overflow (`Packed({ external })`) fields. */
  readonly overflow: ReadonlyArray<string>
}

/** The `[EDD-9120]` refusal of an offloaded field's write input. */
export const unusable = (entityType: string, operation: string, message: string): ValidationError =>
  new ValidationError({
    entityType,
    operation,
    cause: new Error(`[EDD-9120] Entity "${entityType}": ${message}`),
  })

const describe = (value: unknown): string =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "an array"
      : isOffloadedValue(value)
        ? "an OffloadedValue"
        : typeof value === "object"
          ? `an object (${Object.prototype.toString.call(value).slice(8, -1)})`
          : typeof value

/** The rule of `DynamoModel.External({ contentType })`: printable US-ASCII (0x20–0x7e). */
const isPrintableAscii = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

/** Why `options` of a source are unusable, or `undefined`. */
const sourceRefusal = (source: BlobSource): string | undefined => {
  const { body, contentType, contentLength } = source
  if (!(body instanceof Uint8Array) && !Stream.isStream(body)) {
    return `Offload.source takes a Uint8Array or a Stream of bytes, got ${describe(body)}`
  }
  if (
    contentType !== undefined &&
    (typeof contentType !== "string" ||
      contentType.length === 0 ||
      contentType.length > MAX_CONTENT_TYPE_BYTES ||
      !isPrintableAscii(contentType))
  ) {
    return (
      `Offload.source contentType must be a non-empty printable US-ASCII string of at most ` +
      `${MAX_CONTENT_TYPE_BYTES} bytes, got ${JSON.stringify(contentType)}`
    )
  }
  if (
    contentLength !== undefined &&
    (typeof contentLength !== "number" || !Number.isSafeInteger(contentLength) || contentLength < 0)
  ) {
    return `Offload.source contentLength must be a non-negative integer, got ${String(contentLength)}`
  }
  if (body instanceof Uint8Array && contentLength !== undefined && contentLength !== body.length) {
    return `Offload.source contentLength is ${contentLength}, but its bytes are ${body.length}`
  }
  return undefined
}

/** The placeholder of a binary field's input, `undefined` to keep it, or why it is unusable. */
const prepareBinary = (field: string, value: unknown): Uint8Array | undefined | string => {
  if (value === undefined || value === null || value instanceof Uint8Array) return undefined
  if (isBlobSource(value)) {
    const refusal = sourceRefusal(value)
    if (refusal !== undefined) return `binary field "${field}": ${refusal}`
    return value.body instanceof Uint8Array
      ? placeholder({ _tag: "Bytes", contentType: value.contentType }, value.body)
      : placeholder({
          _tag: "Stream",
          stream: value.body,
          identity: value.body,
          contentType: value.contentType,
          contentLength: value.contentLength,
        })
  }
  if (Stream.isStream(value)) {
    return placeholder({
      _tag: "Stream",
      stream: value as Stream.Stream<Uint8Array, unknown>,
      identity: value,
      contentType: undefined,
      contentLength: undefined,
    })
  }
  if (isBlobHandle(value)) return placeholder({ _tag: "Handle", handle: value })
  return (
    `binary field "${field}" takes a Uint8Array, a Stream of bytes, a BlobHandle or ` +
    `Offload.source(...), got ${describe(value)}`
  )
}

/**
 * Replace every binary input of `record` that is not a `Uint8Array` with its
 * placeholder, and refuse an unusable one (`[EDD-9120]`). `record` itself
 * when nothing is replaced (a class instance keeps its prototype); a shallow
 * copy otherwise.
 */
export const prepare = (
  record: unknown,
  fields: InputFields,
  operation: string,
): Effect.Effect<unknown, ValidationError> => {
  if (typeof record !== "object" || record === null) return Effect.succeed(record)
  const input = record as Readonly<Record<string, unknown>>
  let out: Record<string, unknown> | undefined
  for (const field of fields.overflow) {
    const value = input[field]
    if (Stream.isStream(value) || isBlobHandle(value) || isBlobSource(value)) {
      return Effect.fail(
        unusable(
          fields.entityType,
          operation,
          `overflow field "${field}" takes its domain value, got ` +
            (Stream.isStream(value)
              ? "a Stream"
              : isBlobHandle(value)
                ? "a BlobHandle"
                : "an Offload.source(...)") +
            ": only a binary (DynamoModel.External) field takes bytes from a stream, a handle " +
            "or a source",
        ),
      )
    }
    if (isOffloadedValue(value)) {
      return Effect.fail(
        unusable(
          fields.entityType,
          operation,
          `overflow field "${field}" takes its domain value, got an OffloadedValue (a lazy ` +
            "read): read() it first, or read the item eagerly",
        ),
      )
    }
  }
  for (const field of fields.binary) {
    const prepared = prepareBinary(field, input[field])
    if (prepared === undefined) continue
    if (typeof prepared === "string") {
      return Effect.fail(unusable(fields.entityType, operation, prepared))
    }
    out ??= { ...input }
    out[field] = prepared
  }
  return Effect.succeed(out ?? record)
}

/** The fields of `record` among `binary` that hold an opaque placeholder. */
export const opaqueFields = (record: unknown, binary: ReadonlyArray<string>): Array<string> => {
  if (typeof record !== "object" || record === null) return []
  const input = record as Readonly<Record<string, unknown>>
  return binary.filter((field) => isOpaque(input[field]))
}

/**
 * `encoded` (the schema encoding of a prepared `input`) with each
 * `Offload.source(bytes)` placeholder's upload options kept on its encoded
 * bytes, when the field's schema gave a new array for them.
 */
export const carry = (input: unknown, encoded: unknown, binary: ReadonlyArray<string>): unknown => {
  if (typeof input !== "object" || input === null) return encoded
  if (typeof encoded !== "object" || encoded === null) return encoded
  const from = input as Readonly<Record<string, unknown>>
  const to = encoded as Readonly<Record<string, unknown>>
  for (const field of binary) {
    const prepared = preparedOf(from[field])
    const out = to[field]
    if (prepared?._tag === "Bytes" && out instanceof Uint8Array && out !== from[field]) {
      placeholders.set(out, prepared)
    }
  }
  return encoded
}
