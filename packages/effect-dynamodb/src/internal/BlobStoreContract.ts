/**
 * @internal The `BlobStore` contract (#179, design §12.1): what a store
 * implements, what it fails with, and the checks `BlobStore.layer` runs on a
 * store before the library uses it (`[EDD-9116]`). `BlobStore.ts` re-exports
 * the public parts.
 *
 * Not part of the public API.
 */

import type { BlobStoreReason } from "@effect-dynamodb/schema/Errors.js"
import type { BlobChecksum, BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { MAX_KEY_BYTES, MAX_VERSION_BYTES } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { MAX_OFFLOAD_PREFIX_BYTES } from "@effect-dynamodb/schema/internal/EntityOffload.js"
import { Data, Duration, type Effect, Option, type Stream } from "effect"
import { HASHED_KEY_BYTES } from "./BlobKeys.js"

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** A byte range of an object: `length` bytes from `offset` (to the end when absent). */
export interface ByteRange {
  readonly offset: number
  readonly length?: number | undefined
}

/**
 * What a store fails with. The library wraps it into a `BlobStoreError`
 * with the operation's context (entity type, attribute, operation, action).
 */
export class BlobStoreFailure extends Data.TaggedError("BlobStoreFailure")<{
  readonly reason: BlobStoreReason
  /** The object version involved, when there is one. */
  readonly ref?: BlobRef | undefined
  /**
   * A `put` (or a `copy`) whose multipart upload may have completed although
   * its response was lost (a `CompleteMultipartUpload` that failed without an
   * answer, or whose retry found no upload): a version may exist that no ref
   * names. The library reports the requested key to the observer
   * (`completeLost`) for `gc.sweep`. An interrupted call needs no flag: the
   * library reports every `put` or `copy` that exits interrupted itself
   * (`interrupted`).
   */
  readonly completeLost?: boolean | undefined
  /** The store's own error (for the S3 store, the SDK error). */
  readonly cause: unknown
}> {
  constructor(fields: {
    readonly reason: BlobStoreReason
    readonly ref?: BlobRef | undefined
    readonly completeLost?: boolean | undefined
    readonly cause: unknown
  }) {
    super(fields)
    const detail =
      fields.cause instanceof Error
        ? `: ${fields.cause.message}`
        : typeof fields.cause === "string"
          ? `: ${fields.cause}`
          : ""
    this.message =
      `blob store failure (${fields.reason})` +
      (fields.ref === undefined
        ? ""
        : ` for object "${fields.ref.key}"` +
          (fields.ref.version === "" ? "" : ` version "${fields.ref.version}"`)) +
      detail
  }
}

/**
 * How a source stream fails in a {@link BlobPutRequest}: the library wraps the
 * input `Stream`'s error as a {@link BlobStoreFailure} with reason
 * `"SourceFailed"` (its `cause` the source's own error), so a store lets it
 * through as its own failure.
 */
export type BlobSourceFailure = BlobStoreFailure & { readonly reason: "SourceFailed" }

/** An upload. */
export interface BlobPutRequest {
  /**
   * The library-derived key (design §4.5). A key-per-write store may extend
   * it, never move it out of its family prefix.
   */
  readonly key: string
  readonly body: Uint8Array | Stream.Stream<Uint8Array, BlobSourceFailure>
  /** The body's length, when known before it is consumed. */
  readonly contentLength: number | undefined
  /**
   * CRC-64/NVME of the body bytes; resolves once `body` has been consumed — a
   * store consumes the body before it awaits this (for a `Uint8Array` body it
   * resolves at once).
   */
  readonly checksum: Effect.Effect<BlobChecksum>
  readonly contentType: string
  /** User metadata (design §4.6): US-ASCII, at most 2 KB. */
  readonly metadata: Readonly<Record<string, string>>
}

/** A server-side copy of another version: an upload without a body. */
export type BlobCopyRequest = Omit<BlobPutRequest, "body" | "checksum">

/** What an upload made. */
export interface BlobPutResult {
  /** An immutable reference: the bytes it names never change. */
  readonly ref: BlobRef
  /** Bytes of the stored object. */
  readonly size: number
}

/** One version of a listing. */
export interface BlobListing {
  readonly ref: BlobRef
  readonly size: number
  readonly lastModified: Date
  /** The key's newest version. */
  readonly isLatest: boolean
}

/** Upper bounds the item-budget planner counts a pointer at (design §6.3). */
export interface BlobStoreLimits {
  /** The longest version id the store returns, in UTF-8 bytes (S3: 1,024). */
  readonly maxVersionBytes: number
  /** The most bytes a key-per-write store appends to a key (`0` for a versioned store). */
  readonly maxKeySuffixBytes: number
}

/**
 * Unreferenced-since marks (design §11.4). `get` succeeds with `Option.none()`
 * for a version without a mark and for an absent ref; `set` and `clear` succeed
 * on an absent ref.
 */
export interface BlobStoreMarks {
  readonly get: (ref: BlobRef) => Effect.Effect<Option.Option<Date>, BlobStoreFailure>
  readonly set: (ref: BlobRef, since: Date) => Effect.Effect<void, BlobStoreFailure>
  readonly clear: (ref: BlobRef) => Effect.Effect<void, BlobStoreFailure>
}

/** Options of a presigned GET URL. */
export interface BlobPresignOptions {
  readonly expiresIn: Duration.Duration
  /** A `Content-Type` the response overrides the stored one with. */
  readonly contentType?: string | undefined
}

/**
 * A blob store: the contract the library writes offloaded values through and
 * reads them back from. It has no `R` — an implementation closes over its
 * client.
 *
 * The library computes every checksum and verifies sizes and checksums on
 * read, so a store never has to be trusted for either; it also enforces
 * `maxUploadAge`, which a store only declares. `copy`, `list`, `head`,
 * `marks` and `presign` are optional capabilities: GC states what it needs.
 */
export interface BlobStoreService {
  /** For messages, e.g. `"s3://documents-blobs/prod/"`. */
  readonly name: string
  /** The store prefix; an entity's `offload.prefix` replaces it for that entity. */
  readonly prefix: string
  readonly limits: BlobStoreLimits
  /**
   * An upload not committed by this age after it started fails with
   * `Expired`; GC relies on it (design §6.1, §11.4). Every process writing or
   * collecting against one store configures the same value.
   */
  readonly maxUploadAge: Duration.Duration
  /**
   * Concurrent reads the library runs against the store per operation (eager
   * resolution): a page, a batch get's group, an aggregate's partition, and
   * all of a `GeoIndex.nearby` search's parallel queries together.
   */
  readonly readConcurrency: number
  /** Concurrent uploads the library runs against the store per operation. */
  readonly writeConcurrency: number
  /** MUST return an immutable reference: the bytes `ref` names never change. */
  readonly put: (request: BlobPutRequest) => Effect.Effect<BlobPutResult, BlobStoreFailure>
  /**
   * The bytes `ref` names, in chunks. Each chunk is handed over: the store
   * never reuses or changes one it has emitted (the library may return it to
   * the caller as is).
   */
  readonly get: (
    ref: BlobRef,
    options?: { readonly range?: ByteRange | undefined },
  ) => Stream.Stream<Uint8Array, BlobStoreFailure>
  /** Idempotent: deleting an absent ref succeeds. */
  readonly delete: (refs: ReadonlyArray<BlobRef>) => Effect.Effect<void, BlobStoreFailure>
  readonly copy?:
    | ((
        source: BlobRef,
        request: BlobCopyRequest,
      ) => Effect.Effect<BlobPutResult, BlobStoreFailure>)
    | undefined
  /** Every version under `prefix`, keys ascending (UTF-8 order), versions newest first. */
  readonly list?:
    | ((
        prefix: string,
        options?: { readonly startAfter?: string | undefined },
      ) => Stream.Stream<BlobListing, BlobStoreFailure>)
    | undefined
  /** The metadata the library wrote with the version (design §4.6). */
  readonly head?:
    | ((ref: BlobRef) => Effect.Effect<Readonly<Record<string, string>>, BlobStoreFailure>)
    | undefined
  readonly marks?: BlobStoreMarks | undefined
  readonly presign?:
    | ((ref: BlobRef, options: BlobPresignOptions) => Effect.Effect<string, BlobStoreFailure>)
    | undefined
}

// ---------------------------------------------------------------------------
// Defaults and bounds
// ---------------------------------------------------------------------------

/** The default `maxUploadAge`: 1 hour. */
export const DEFAULT_MAX_UPLOAD_AGE: Duration.Duration = Duration.hours(1)
/** The shortest `maxUploadAge` a store's options accept. */
export const MIN_MAX_UPLOAD_AGE: Duration.Duration = Duration.minutes(1)
/** The longest `maxUploadAge` a store's options accept. */
export const MAX_MAX_UPLOAD_AGE: Duration.Duration = Duration.days(7)

/** The default `readConcurrency`. */
export const DEFAULT_READ_CONCURRENCY = 16
/** The default `writeConcurrency`. */
export const DEFAULT_WRITE_CONCURRENCY = 8

/** The longest store prefix, in UTF-8 bytes. */
export const MAX_STORE_PREFIX_BYTES = 256

/**
 * The most a key-per-write store may append to a key: what is left of S3's
 * 1,024-byte key after the longest prefix (256 bytes, a store's or an
 * entity's) and the hashed `P/F/O` (98 bytes), so every key fits a pointer.
 */
export const MAX_KEY_SUFFIX_BYTES = MAX_KEY_BYTES - MAX_OFFLOAD_PREFIX_BYTES - HASHED_KEY_BYTES

// ---------------------------------------------------------------------------
// Validation ([EDD-9116])
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** UTF-8 bytes of `text`, or `undefined` when it holds a lone surrogate. */
export const utf8Bytes = (text: string): number | undefined => {
  const bytes = encoder.encode(text)
  return fatalDecoder.decode(bytes) === text ? bytes.length : undefined
}

const show = (value: unknown): string =>
  typeof value === "string"
    ? JSON.stringify(value)
    : typeof value === "bigint"
      ? `${value}n`
      : Duration.isDuration(value)
        ? Duration.format(value)
        : String(value)

/** Throw the `[EDD-9116]` defect of `where`. */
export const invalid = (where: string, message: string): never => {
  throw new Error(`[EDD-9116] ${where}: ${message}`)
}

/** A store prefix: a string of at most 256 UTF-8 bytes, not starting with `/`. */
export const checkPrefix = (where: string, name: string, prefix: unknown): string => {
  const bytes = typeof prefix === "string" ? utf8Bytes(prefix) : undefined
  if (typeof prefix !== "string" || bytes === undefined) {
    return invalid(where, `${name} must be a well-formed string, got ${show(prefix)}.`)
  }
  if (prefix.startsWith("/")) {
    return invalid(where, `${name} must not start with "/", got ${show(prefix)}.`)
  }
  if (bytes > MAX_STORE_PREFIX_BYTES) {
    return invalid(
      where,
      `${name} is ${bytes} UTF-8 bytes, over the ${MAX_STORE_PREFIX_BYTES}-byte limit.`,
    )
  }
  return prefix
}

/** A concurrency (or other count): a positive safe integer. */
export const checkPositiveInteger = (where: string, name: string, value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid(where, `${name} must be a positive integer, got ${show(value)}.`)
  }
  return value
}

/**
 * A `maxUploadAge` option: a `Duration.Input` from 1 minute to 7 days
 * (default 1 hour).
 */
export const checkMaxUploadAgeOption = (where: string, value: unknown): Duration.Duration => {
  if (value === undefined) return DEFAULT_MAX_UPLOAD_AGE
  let decoded: Option.Option<Duration.Duration>
  try {
    decoded = Duration.fromInput(value as Duration.Input)
  } catch {
    decoded = Option.none()
  }
  if (
    Option.isNone(decoded) ||
    Duration.isLessThan(decoded.value, MIN_MAX_UPLOAD_AGE) ||
    Duration.isGreaterThan(decoded.value, MAX_MAX_UPLOAD_AGE)
  ) {
    return invalid(
      where,
      `maxUploadAge must be a duration from 1 minute to 7 days, got ${show(value)}.`,
    )
  }
  return decoded.value
}

const isFunction = (value: unknown): boolean => typeof value === "function"

/**
 * Check a store before the library uses it, returning it unchanged.
 *
 * @throws `[EDD-9116]` when `name` is not a non-empty string; `prefix` is not a
 *   string of at most 256 UTF-8 bytes that does not start with `/`; `limits`
 *   are not non-negative integers (`maxVersionBytes` at most 1,024, the
 *   pointer's version limit; `maxKeySuffixBytes` at most
 *   {@link MAX_KEY_SUFFIX_BYTES}); `maxUploadAge` is not a positive, finite
 *   `Duration`; a concurrency is not a positive integer; `put`, `get` or
 *   `delete` is not a function; or an optional capability is present but not
 *   a function (`marks`: an object of `get`, `set` and `clear` functions).
 */
export const validateService = (where: string, service: unknown): BlobStoreService => {
  if (typeof service !== "object" || service === null) {
    return invalid(where, `a blob store must be an object, got ${show(service)}.`)
  }
  const s = service as Record<string, unknown>
  if (typeof s.name !== "string" || s.name.length === 0) {
    invalid(where, `name must be a non-empty string, got ${show(s.name)}.`)
  }
  checkPrefix(where, "prefix", s.prefix)
  const limits = s.limits as Record<string, unknown> | null | undefined
  if (typeof limits !== "object" || limits === null) {
    invalid(where, "limits must be { maxVersionBytes, maxKeySuffixBytes }.")
  } else {
    for (const [name, max] of [
      ["maxVersionBytes", MAX_VERSION_BYTES],
      ["maxKeySuffixBytes", MAX_KEY_SUFFIX_BYTES],
    ] as const) {
      const value = limits[name]
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
        invalid(where, `limits.${name} must be an integer in 0 … ${max}, got ${show(value)}.`)
      }
    }
  }
  const age = s.maxUploadAge
  if (!Duration.isDuration(age) || !Duration.isFinite(age) || !Duration.isPositive(age)) {
    invalid(where, `maxUploadAge must be a positive, finite Duration, got ${show(age)}.`)
  }
  checkPositiveInteger(where, "readConcurrency", s.readConcurrency)
  checkPositiveInteger(where, "writeConcurrency", s.writeConcurrency)
  for (const name of ["put", "get", "delete"] as const) {
    if (!isFunction(s[name])) invalid(where, `${name} must be a function.`)
  }
  for (const name of ["copy", "list", "head", "presign"] as const) {
    if (s[name] !== undefined && !isFunction(s[name])) {
      invalid(where, `${name} must be a function when present.`)
    }
  }
  const marks = s.marks as Record<string, unknown> | null | undefined
  if (
    marks !== undefined &&
    (typeof marks !== "object" ||
      marks === null ||
      !isFunction(marks.get) ||
      !isFunction(marks.set) ||
      !isFunction(marks.clear))
  ) {
    invalid(where, "marks must be { get, set, clear } functions when present.")
  }
  return service as BlobStoreService
}
