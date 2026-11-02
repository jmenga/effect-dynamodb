/**
 * @internal The read side of offloaded values (#179, design §8): phase two of
 * the two-phase decode.
 *
 * 1. **Unpack** (synchronous, the decoders') replaces each pointer a row holds
 *    with a {@link PendingBlob} placeholder naming it.
 * 2. **Resolve** (here, effectful, batched over a page, a batch response, a
 *    partition or one item) turns every placeholder into its value per the
 *    read's modes ({@link resolveRows}):
 *    - **eager** — fetch at the store's `readConcurrency` (failing a read as
 *      soon as it runs past the pointer's size), verify the object's
 *      size and the CRC-64/NVME of its content (§8.6), decompress, then
 *      `JSON.parse` (overflow) or the bytes (binary). What the operation
 *      itself uploaded comes from the upload ledger's read cache, unfetched;
 *    - **lazy** — an `OffloadedValue` (overflow) or `BlobHandle` (binary): no
 *      I/O until `read()` / `stream()`, which fetch, verify and decode each
 *      call with the store and compressor registry of the fiber that resolved
 *      it (`R = never`).
 * 3. **Schema decode** (the decoders') runs over the resolved row.
 *
 * A row without placeholders resolves with no I/O and no allocation.
 *
 * Failures: a store failure, a missing store (`NotProvided`) and a size or
 * checksum mismatch (`ChecksumMismatch`) are `BlobStoreError`s; a payload that
 * fails decompression or `JSON.parse` after a verified fetch, and a missing
 * compressor, are `ValidationError`s (§14.2). A ranged read cannot verify a
 * whole-object checksum and does not; `stream()` without a range verifies as
 * its last chunk arrives, failing the stream after the bytes were emitted.
 *
 * Not part of the public API.
 */

import type { CompressionRegistry } from "@effect-dynamodb/schema/Compression.js"
import type { BlobStoreAction, BlobStoreError } from "@effect-dynamodb/schema/Errors.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import type {
  BlobChecksum,
  BlobPointer,
  BlobRef,
} from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme, make as makeCrc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import type { OffloadMode } from "@effect-dynamodb/schema/internal/EntityTypes.js"
import { notRegistered } from "@effect-dynamodb/schema/internal/PackedCodec.js"
import { Context, Duration, Effect, Option, Stream } from "effect"
import { BlobStore } from "../BlobStore.js"
import { type BlobCallContext, blobError, call, callStream } from "./BlobCalls.js"
import * as BlobLedger from "./BlobLedger.js"
import type { BlobStoreService, ByteRange } from "./BlobStoreContract.js"
import {
  type BlobHandle,
  makeBlobHandle,
  makeOffloadedValue,
  type OffloadedValue,
} from "./OffloadValues.js"
import { registryOf } from "./Packed.js"

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

export const PendingBlobTypeId: unique symbol = Symbol.for("effect-dynamodb/PendingBlob")
export type PendingBlobTypeId = typeof PendingBlobTypeId

/** Which kind of offloaded field: an overflow (`Packed({ external })`) or binary (`External`) one. */
export type OffloadKind = "overflow" | "binary"

/** A pointer an unpacked row holds in place of its value, until it is resolved. */
export interface PendingBlob {
  readonly [PendingBlobTypeId]: PendingBlobTypeId
  readonly pointer: BlobPointer
  /** The stored attribute name. */
  readonly attribute: string
  /** The domain field name. */
  readonly field: string
  readonly kind: OffloadKind
}

/** True iff `u` is a {@link PendingBlob}. */
export const isPendingBlob = (u: unknown): u is PendingBlob =>
  typeof u === "object" && u !== null && PendingBlobTypeId in u

/**
 * A placeholder for `pointer`. Dies when the pointer's kind is not the
 * field's (json for an overflow field, bytes for a binary one): the unpack
 * step refuses such a value before it gets here.
 */
export const makePendingBlob = (fields: {
  readonly pointer: BlobPointer
  readonly attribute: string
  readonly field: string
  readonly kind: OffloadKind
}): PendingBlob => {
  if ((fields.kind === "overflow") !== (fields.pointer.kind === "json")) {
    throw new Error(
      `BlobResolver: a ${fields.pointer.kind} pointer cannot stand for the ${fields.kind} ` +
        `attribute "${fields.attribute}". This is a defect in effect-dynamodb.`,
    )
  }
  return Object.freeze({ [PendingBlobTypeId]: PendingBlobTypeId as PendingBlobTypeId, ...fields })
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The modes a read resolves each kind in. */
export interface Modes {
  readonly overflow: OffloadMode
  readonly binary: OffloadMode
}

/** The defaults (decision 5): overflow eager, binary lazy. */
export const DEFAULT_MODES: Modes = Object.freeze({ overflow: "eager", binary: "lazy" })

/** Both kinds eager: aggregates, `GeoSearch.nearby`, the projection engine's row read. */
export const EAGER_MODES: Modes = Object.freeze({ overflow: "eager", binary: "eager" })

/** Both kinds lazy: error payloads and ref hydration, which never do I/O. */
export const LAZY_MODES: Modes = Object.freeze({ overflow: "lazy", binary: "lazy" })

/** What a resolution is for. */
export interface ResolveOptions {
  readonly entityType: string
  /** The operation errors name; a lazy value's reads name `<operation>.read`. */
  readonly operation: string
  readonly modes: Modes
  /** The DynamoDB write committed: this resolves its result (design §6.13). */
  readonly committed?: boolean | undefined
  /**
   * Decode a lazy overflow value's wire form when it is read (the field's
   * schema). Default: the wire form itself.
   */
  readonly decode?:
    | ((field: string, wire: unknown) => Effect.Effect<unknown, ValidationError>)
    | undefined
}

/** What a resolution captured from the fiber that ran it. */
interface Environment {
  readonly store: BlobStoreService | undefined
  readonly registry: CompressionRegistry
  readonly ledger: BlobLedger.Ledger | undefined
}

const environmentOf = (
  context: Context.Context<never>,
  ledger: BlobLedger.Ledger | undefined,
): Environment => ({
  store: Context.getOrUndefined(context, BlobStore),
  registry: registryOf(context),
  ledger: ledger === undefined || ledger.closed ? undefined : ledger,
})

// ---------------------------------------------------------------------------
// Fetch and verify
// ---------------------------------------------------------------------------

/** The library's verified content of an object: the uncompressed JSON text, or the bytes. */
export type BlobContent = BlobLedger.LedgerContent

const fatalDecoder = new TextDecoder("utf-8", { fatal: true })
const encoder = new TextEncoder()

const invalid = (ctx: BlobCallContext, message: string, cause?: unknown): ValidationError =>
  new ValidationError({
    entityType: ctx.entityType,
    operation: ctx.operation,
    cause:
      cause === undefined
        ? new Error(`Offloaded attribute "${ctx.attribute}": ${message}`)
        : new Error(`Offloaded attribute "${ctx.attribute}": ${message}`, { cause }),
  })

const notProvided = (ctx: BlobCallContext, action: BlobStoreAction, ref: BlobRef): BlobStoreError =>
  blobError(
    ctx,
    action,
    "NotProvided",
    ref,
    "no BlobStore is in context: provide one (DynamoClient.make({ blobStore }), BlobStore.layer, " +
      "or the S3 store's layer) where the operation runs or the client is bound",
  )

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  if (chunks.length === 1) return chunks[0]!
  let size = 0
  for (const chunk of chunks) size += chunk.length
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

const mismatch = (ctx: BlobCallContext, ref: BlobRef, message: string): BlobStoreError =>
  blobError(ctx, "get", "ChecksumMismatch", ref, message)

/** The bytes of a ranged read, unverified. */
const getRange = (
  store: BlobStoreService,
  ref: BlobRef,
  ctx: BlobCallContext,
  range: ByteRange,
): Effect.Effect<Uint8Array, BlobStoreError> =>
  Effect.map(
    Stream.runCollect(callStream(store, "get", ctx, ref, () => store.get(ref, { range }))),
    (chunks) => concat(chunks),
  )

/**
 * The bytes of the whole object `pointer` names, unverified but bounded: the
 * read fails (`ChecksumMismatch`) as soon as it runs past the pointer's
 * `objectSize`, so an oversized or corrupt object is never buffered whole.
 */
const getObject = (
  store: BlobStoreService,
  pointer: BlobPointer,
  ctx: BlobCallContext,
): Effect.Effect<Uint8Array, BlobStoreError> =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = []
    let size = 0
    return callStream(store, "get", ctx, pointer.ref, () => store.get(pointer.ref)).pipe(
      Stream.runForEach((chunk) => {
        size += chunk.length
        if (size > pointer.objectSize) {
          return Effect.fail(
            mismatch(
              ctx,
              pointer.ref,
              `the object runs past the ${pointer.objectSize} bytes its pointer says ` +
                `(${size} bytes read)`,
            ),
          )
        }
        chunks.push(chunk)
        return Effect.void
      }),
      Effect.map(() => concat(chunks)),
    )
  })

/** True iff `checksum` is the pointer's. */
const checksumMatches = (pointer: BlobPointer, checksum: Uint8Array): boolean =>
  pointer.checksum.algorithm === "crc64nvme" && sameBytes(pointer.checksum.value, checksum)

/**
 * Verify an object against its pointer and return its content: the object's
 * size, then (decompressed, for compressed json) the content's size and
 * CRC-64/NVME.
 */
export const verify = (
  pointer: BlobPointer,
  object: Uint8Array,
  registry: CompressionRegistry,
  ctx: BlobCallContext,
): BlobContent | BlobStoreError | ValidationError => {
  const ref = pointer.ref
  if (object.length !== pointer.objectSize) {
    return mismatch(
      ctx,
      ref,
      `the object is ${object.length} bytes; its pointer says ${pointer.objectSize}`,
    )
  }
  let content = object
  if (pointer.codec !== "none") {
    const compressor = registry.get(pointer.codec)
    if (compressor === undefined)
      return notRegistered(ctx, ctx.attribute, pointer.codec, "decompress")
    try {
      content = compressor.decompress(object)
    } catch (cause) {
      return invalid(ctx, `the "${pointer.codec}" decompressor failed on the object`, cause)
    }
    if (!(content instanceof Uint8Array)) {
      return invalid(ctx, `the "${pointer.codec}" decompressor did not return a Uint8Array`)
    }
  }
  if (content.length !== pointer.contentSize || !checksumMatches(pointer, crc64nvme(content))) {
    return mismatch(
      ctx,
      ref,
      content.length !== pointer.contentSize
        ? `the content is ${content.length} bytes; its pointer says ${pointer.contentSize}`
        : "the CRC-64/NVME of the content does not match its pointer's",
    )
  }
  if (pointer.kind === "bytes") return { kind: "bytes", bytes: content }
  let text: string
  try {
    text = fatalDecoder.decode(content)
  } catch (cause) {
    return invalid(ctx, "the offloaded JSON is not valid UTF-8", cause)
  }
  return { kind: "json", text }
}

const lift = <A>(
  value: A | BlobStoreError | ValidationError,
): Effect.Effect<A, BlobStoreError | ValidationError> =>
  value instanceof ValidationError || isBlobStoreError(value)
    ? Effect.fail(value as BlobStoreError | ValidationError)
    : Effect.succeed(value as A)

const isBlobStoreError = (value: unknown): value is BlobStoreError =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "BlobStoreError"

/**
 * The verified content `pointer` names: from the ledger's read cache when the
 * operation uploaded it, else fetched from the store.
 */
const fetchContent = (
  env: Environment,
  pointer: BlobPointer,
  ctx: BlobCallContext,
): Effect.Effect<BlobContent, BlobStoreError | ValidationError> => {
  const cached = BlobLedger.cached(env.ledger, pointer.ref)
  if (cached !== undefined) {
    // The cache holds the operation's own input bytes: hand out a copy, never them.
    return Effect.succeed(
      cached.kind === "bytes" ? { kind: "bytes", bytes: new Uint8Array(cached.bytes) } : cached,
    )
  }
  const store = env.store
  if (store === undefined) return Effect.fail(notProvided(ctx, "get", pointer.ref))
  return Effect.flatMap(getObject(store, pointer, ctx), (object) =>
    lift(verify(pointer, object, env.registry, ctx)),
  )
}

/** Parse JSON content to its wire form. */
const parse = (text: string, ctx: BlobCallContext): Effect.Effect<unknown, ValidationError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(JSON.parse(text) as unknown)
    } catch (cause) {
      return Effect.fail(invalid(ctx, "the offloaded value is not valid JSON", cause))
    }
  })

/**
 * The eager value of content: the wire form (json), or the bytes — the
 * caller's own, since {@link fetchContent} copies what comes from the cache
 * and a store's chunks are handed over (the `get` contract).
 */
const valueOf = (
  content: BlobContent,
  ctx: BlobCallContext,
): Effect.Effect<unknown, ValidationError> =>
  content.kind === "json" ? parse(content.text, ctx) : Effect.succeed(content.bytes)

// ---------------------------------------------------------------------------
// Lazy values
// ---------------------------------------------------------------------------

/** The default `expiresIn` of a presigned URL: the reaper's default grace (design §3.7). */
export const DEFAULT_PRESIGN_EXPIRY: Duration.Duration = Duration.minutes(15)

const presignedUrl = (
  store: BlobStoreService | undefined,
  ref: BlobRef,
  ctx: BlobCallContext,
  expiresIn: Duration.Input | undefined,
): Effect.Effect<string, BlobStoreError> => {
  if (store === undefined) return Effect.fail(notProvided(ctx, "presign", ref))
  const presign = store.presign
  if (presign === undefined) {
    return Effect.fail(
      blobError(ctx, "presign", "Unsupported", ref, `the store ${store.name} cannot presign URLs`),
    )
  }
  const expiry =
    expiresIn === undefined ? Option.some(DEFAULT_PRESIGN_EXPIRY) : Duration.fromInput(expiresIn)
  if (
    Option.isNone(expiry) ||
    !Duration.isFinite(expiry.value) ||
    !Duration.isPositive(expiry.value)
  ) {
    return Effect.fail(
      blobError(ctx, "presign", "Rejected", ref, "expiresIn must be a positive, finite duration"),
    )
  }
  return call(store, "presign", ctx, { ref }, () => presign(ref, { expiresIn: expiry.value }))
}

/** A whole-object stream whose end verifies the size and checksum (bytes pointers). */
const verifiedStream = (
  store: BlobStoreService,
  pointer: BlobPointer,
  ctx: BlobCallContext,
): Stream.Stream<Uint8Array, BlobStoreError> =>
  Stream.suspend(() => {
    const hasher = makeCrc64nvme()
    let size = 0
    return callStream(store, "get", ctx, pointer.ref, () => store.get(pointer.ref)).pipe(
      Stream.map((chunk) => {
        hasher.update(chunk)
        size += chunk.length
        return chunk
      }),
      Stream.concat(
        Stream.suspend(() =>
          size !== pointer.objectSize
            ? Stream.fail(
                mismatch(
                  ctx,
                  pointer.ref,
                  `the object is ${size} bytes; its pointer says ${pointer.objectSize}`,
                ),
              )
            : !checksumMatches(pointer, hasher.digest())
              ? Stream.fail(
                  mismatch(
                    ctx,
                    pointer.ref,
                    "the CRC-64/NVME of the object does not match its pointer's",
                  ),
                )
              : Stream.empty,
        ),
      ),
    )
  })

const readContext = (ctx: BlobCallContext): BlobCallContext => ({
  entityType: ctx.entityType,
  attribute: ctx.attribute,
  operation: `${ctx.operation}.read`,
})

/** The lazy form of an overflow pointer: fetched, verified and decoded on each `read()`. */
const lazyOverflow = (
  env: Environment,
  pending: PendingBlob,
  ctx: BlobCallContext,
  decode: (field: string, wire: unknown) => Effect.Effect<unknown, ValidationError>,
): OffloadedValue<unknown> => {
  // A handle is a value: it never pins the ledger (or its cached content).
  const later: Environment = { store: env.store, registry: env.registry, ledger: undefined }
  const readCtx = readContext(ctx)
  return makeOffloadedValue({
    location: "external",
    ref: Option.some(pending.pointer.ref),
    size: pending.pointer.objectSize,
    checksum: pending.pointer.checksum,
    read: () =>
      fetchContent(later, pending.pointer, readCtx).pipe(
        Effect.flatMap((content) => valueOf(content, readCtx)),
        Effect.flatMap((wire) => decode(pending.field, wire)),
      ),
  })
}

/** The lazy form of a binary pointer. */
const lazyBinary = (env: Environment, pending: PendingBlob, ctx: BlobCallContext): BlobHandle => {
  const { pointer } = pending
  const store = env.store
  const readCtx = readContext(ctx)
  const later: Environment = { store, registry: env.registry, ledger: undefined }
  return makeBlobHandle({
    location: "external",
    ref: Option.some(pointer.ref),
    size: pointer.objectSize,
    contentType: Option.getOrElse(pointer.contentType, () => "application/octet-stream"),
    checksum: pointer.checksum,
    read: (options) => {
      const range = options?.range
      if (range === undefined) {
        return fetchContent(later, pointer, readCtx).pipe(
          // A bytes pointer (the only kind a binary placeholder holds) is never
          // compressed nor decoded as text, so its verification cannot fail
          // with a ValidationError: one would be a defect.
          Effect.catchTag("ValidationError", (error) => Effect.die(error)),
          Effect.map((content) =>
            content.kind === "bytes" ? content.bytes : encoder.encode(content.text),
          ),
        )
      }
      return store === undefined
        ? Effect.fail(notProvided(readCtx, "get", pointer.ref))
        : getRange(store, pointer.ref, readCtx, range)
    },
    stream: (options) => {
      const range = options?.range
      if (store === undefined) return Stream.fail(notProvided(readCtx, "get", pointer.ref))
      return range === undefined
        ? verifiedStream(store, pointer, readCtx)
        : callStream(store, "get", readCtx, pointer.ref, () => store.get(pointer.ref, { range }))
    },
    presignedUrl: (options) => presignedUrl(store, pointer.ref, readCtx, options?.expiresIn),
  })
}

// ---------------------------------------------------------------------------
// Inline values (a lazy read of a value stored in the item)
// ---------------------------------------------------------------------------

const checksumOf = (content: Uint8Array): BlobChecksum => ({
  algorithm: "crc64nvme",
  value: crc64nvme(content),
})

/**
 * The lazy form of an overflow value stored inline: `text` is its JSON (the
 * content its checksum covers), `size` the attribute's stored bytes. `read()`
 * parses and decodes it, with no I/O.
 */
export const inlineOffloadedValue = (fields: {
  readonly text: string
  readonly size: number
  readonly decode: (wire: unknown) => Effect.Effect<unknown, ValidationError>
  readonly ctx: BlobCallContext
}): OffloadedValue<unknown> =>
  makeOffloadedValue({
    location: "inline",
    ref: Option.none(),
    size: fields.size,
    checksum: checksumOf(encoder.encode(fields.text)),
    read: () => Effect.flatMap(parse(fields.text, fields.ctx), (wire) => fields.decode(wire)),
  })

/** `bytes[range]`, or the `Rejected` failure of a range that starts past the end. */
const sliceRange = (
  bytes: Uint8Array,
  range: ByteRange | undefined,
  ctx: BlobCallContext,
): Uint8Array | BlobStoreError => {
  if (range === undefined) return new Uint8Array(bytes)
  const { offset, length } = range
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
  ) {
    return blobError(
      ctx,
      "get",
      "Rejected",
      undefined,
      "a range is a non-negative offset and length",
    )
  }
  if (offset > bytes.length) {
    return blobError(
      ctx,
      "get",
      "Rejected",
      undefined,
      "the range starts past the end of the value",
    )
  }
  return bytes.slice(offset, length === undefined ? bytes.length : offset + length)
}

/**
 * The lazy form of a binary value stored inline (a native `B` written before
 * the field was `External`): it serves its bytes with no I/O and cannot be
 * presigned (`Unsupported`).
 */
export const inlineBlobHandle = (fields: {
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly ctx: BlobCallContext
}): BlobHandle => {
  const bytes = new Uint8Array(fields.bytes)
  const ctx = readContext(fields.ctx)
  return makeBlobHandle({
    location: "inline",
    ref: Option.none(),
    size: bytes.length,
    contentType: fields.contentType,
    checksum: checksumOf(bytes),
    read: (options) =>
      Effect.suspend(() => {
        const out = sliceRange(bytes, options?.range, ctx)
        return out instanceof Uint8Array ? Effect.succeed(out) : Effect.fail(out)
      }),
    stream: (options) =>
      Stream.suspend(() => {
        const out = sliceRange(bytes, options?.range, ctx)
        return out instanceof Uint8Array ? Stream.succeed(out) : Stream.fail(out)
      }),
    presignedUrl: () =>
      Effect.fail(
        blobError(
          ctx,
          "presign",
          "Unsupported",
          undefined,
          "the value is stored inline in the item, not in the blob store",
        ),
      ),
  })
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

const identity = (_field: string, wire: unknown): Effect.Effect<unknown, ValidationError> =>
  Effect.succeed(wire)

const contextOf = (options: ResolveOptions, pending: PendingBlob): BlobCallContext => ({
  entityType: options.entityType,
  attribute: pending.attribute,
  operation: options.operation,
  committed: options.committed,
})

/**
 * Resolve `pendings` per `options.modes`, in order: the eager ones fetched
 * together at the store's `readConcurrency` (the ledger's read cache first),
 * the lazy ones as handles capturing the fiber's store and compressor
 * registry.
 */
export const resolveAll = (
  pendings: ReadonlyArray<PendingBlob>,
  options: ResolveOptions,
): Effect.Effect<Array<unknown>, BlobStoreError | ValidationError> =>
  Effect.withFiber((fiber) => {
    const env = environmentOf(
      fiber.context as Context.Context<never>,
      fiber.getRef(BlobLedger.CurrentLedger),
    )
    const decode = options.decode ?? identity
    const results: Array<unknown> = new Array(pendings.length)
    const eager: Array<number> = []
    for (let i = 0; i < pendings.length; i++) {
      const pending = pendings[i]!
      const ctx = contextOf(options, pending)
      if (options.modes[pending.kind] === "eager") eager.push(i)
      else
        results[i] =
          pending.kind === "overflow"
            ? lazyOverflow(env, pending, ctx, decode)
            : lazyBinary(env, pending, ctx)
    }
    if (eager.length === 0) return Effect.succeed(results)
    return Effect.forEach(
      eager,
      (i) => {
        const pending = pendings[i]!
        const ctx = contextOf(options, pending)
        return fetchContent(env, pending.pointer, ctx).pipe(
          Effect.flatMap((content) => valueOf(content, ctx)),
          Effect.tap((value) =>
            Effect.sync(() => {
              results[i] = value
            }),
          ),
        )
      },
      { concurrency: env.store?.readConcurrency ?? 1, discard: true },
    ).pipe(Effect.as(results))
  })

/**
 * Resolve, in place, every {@link PendingBlob} the rows hold (as an own
 * attribute). Rows without one cost a scan of their attributes and nothing
 * else.
 */
export const resolveRows = (
  rows: ReadonlyArray<Record<string, unknown>>,
  options: ResolveOptions,
): Effect.Effect<void, BlobStoreError | ValidationError> => {
  const slots: Array<readonly [Record<string, unknown>, string]> = []
  const pendings: Array<PendingBlob> = []
  for (const row of rows) {
    for (const attribute of Object.keys(row)) {
      const value = row[attribute]
      if (isPendingBlob(value)) {
        slots.push([row, attribute])
        pendings.push(value)
      }
    }
  }
  if (pendings.length === 0) return Effect.void
  return Effect.map(resolveAll(pendings, options), (values) => {
    for (let i = 0; i < slots.length; i++) {
      const [row, attribute] = slots[i]!
      row[attribute] = values[i]
    }
  })
}
