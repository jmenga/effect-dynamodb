/**
 * @internal The in-memory `BlobStore` (#179, design §12.3): a faithful test
 * double for the S3 store, behind `BlobStore.memory` / `BlobStore.layerMemory`.
 *
 * - **Versioning.** `"versioned"` (default): stable keys, version ids of 32
 *   random lowercase hex characters (like S3's). `"keyPerWrite"`: every upload
 *   gets `key + "/" + a 26-character suffix` (a millisecond timestamp and 80
 *   random bits, Crockford base32, monotonic per store like a monotonic ULID:
 *   within one millisecond the random part counts up, so a family's keys
 *   list in write order even under a frozen `TestClock`) and version `""` —
 *   the contract's path for stores without versioning (§12.4).
 * - **Like S3.** Uploads are validated as S3 validates them: the body against
 *   the request's CRC-64/NVME (`ChecksumMismatch`) and its `contentLength`,
 *   keys up to 1,024 bytes, a content type and user metadata of printable
 *   US-ASCII, the metadata within 2 KB (`Rejected`).
 *   Metadata keys are stored lowercased. Ranged reads honour offsets; a range
 *   starting past the end is `Rejected`. Listings are in UTF-8 key order,
 *   versions newest first.
 * - **Time and randomness** come from Effect's `Clock` and `Random`, read from
 *   the calling fiber (or the `clock` option), so `TestClock` drives
 *   `lastModified` — GC and `maxUploadAge` tests — and `Random.withSeed`
 *   makes version ids reproducible.
 * - **Multipart, simulated.** A `put` runs the multipart driver S3's does
 *   (`Multipart.upload`, design §7): a body of at most `partSize` bytes is one
 *   upload, a longer one is created, uploaded in parts of exactly `partSize`
 *   bytes (raised for a known `contentLength` past `maxParts` parts) at
 *   `uploadConcurrency`, and completed — or aborted on any failure or
 *   interruption. A part failing with `Throttled` / `Unavailable` is retried
 *   (`partAttempts`), as the SDK retries one; part `maxParts + 1` is
 *   `TooLarge`. Unlike S3, any part size is allowed, so tests exercise
 *   multipart with small bodies.
 * - **Fault injection.** `failures` is asked about every call, numbered per
 *   action, and may fail it with a reason or interrupt it, before it takes
 *   effect or after (a lost response), or part-way through a stream. A lost
 *   `put` or `copy` response names the version it stored — a test
 *   convenience an S3 store cannot offer, which no settlement may rely on.
 *   It is also asked about each phase of a multipart upload (create, every
 *   part attempt, complete, abort) as its own action, `"multipart"`, with the
 *   put's `n` — so a hook keyed on `action === "put"` sees only the put; a
 *   lost `complete` response fails the put with `completeLost` and no ref, as
 *   S3's does.
 * - **Inspection.** `inspect()` returns the stored versions (bytes, metadata,
 *   marks), the number of calls per action, and the multipart calls.
 *
 * Not part of the public API (`BlobStore.memory` is).
 */

import type { BlobStoreAction, BlobStoreReason } from "@effect-dynamodb/schema/Errors.js"
import type { BlobRef } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { MAX_KEY_BYTES } from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Clock, Duration, Effect, Option, Random, Stream } from "effect"
import { MAX_METADATA_BYTES, metadataBytes } from "./BlobMetadata.js"
import {
  type BlobCopyRequest,
  type BlobListing,
  type BlobPresignOptions,
  type BlobPutRequest,
  type BlobPutResult,
  BlobStoreFailure,
  type BlobStoreMarks,
  type BlobStoreService,
  type ByteRange,
  checkMaxUploadAgeOption,
  checkPositiveInteger,
  checkPrefix,
  DEFAULT_READ_CONCURRENCY,
  DEFAULT_WRITE_CONCURRENCY,
  invalid,
  utf8Bytes,
} from "./BlobStoreContract.js"
import * as Multipart from "./Multipart.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** A call the memory store is about to serve, as its `failures` hook sees it. */
export interface MemoryBlobCall {
  /**
   * The store action, or `"multipart"` for a phase of a `put`'s multipart
   * upload (`multipart` says which): a hook keyed on `action === "put"` sees
   * each put once, never its phases.
   */
  readonly action: BlobStoreAction | "multipart"
  /**
   * 1-based: this is the `n`-th call of `action` on this store — for a
   * `"multipart"` phase, the `n` of the put it belongs to (phases are not
   * counted in `calls`).
   */
  readonly n: number
  /** `put` / `copy`: the requested key; `list`: the prefix. */
  readonly key?: string | undefined
  /** `get` / `head` / `mark` / `presign`: the ref; `copy`: its source. */
  readonly ref?: BlobRef | undefined
  /** `delete`: the refs. */
  readonly refs?: ReadonlyArray<BlobRef> | undefined
  /** `mark`: which of the marks operations. */
  readonly mark?: "get" | "set" | "clear" | undefined
  /**
   * `"multipart"` only: the phase of the put's multipart upload — `create`, a
   * `part` (its number and 1-based attempt), `complete` or `abort`. A
   * `complete` fault `at: "response"` stores the version, then fails the put
   * with `completeLost` and no ref. A `create` fault `at: "response"` opens an
   * upload the put never learns of: it stays `inProgress`, as an S3 upload
   * whose create response was lost stays until a lifecycle
   * `AbortIncompleteMultipartUpload` rule aborts it.
   */
  readonly multipart?:
    | {
        readonly phase: "create" | "part" | "complete" | "abort"
        readonly part?: number | undefined
        readonly attempt?: number | undefined
      }
    | undefined
}

/** A store call, as `begin` counts it (a multipart phase is asked directly). */
type StoreCall = Omit<MemoryBlobCall, "n" | "action"> & { readonly action: BlobStoreAction }

/**
 * A fault to inject into a call.
 *
 * - `at: "request"` (default): the call fails (or is interrupted) **without
 *   taking effect** — a `put` first consumes `afterChunks` body chunks (default:
 *   the whole body, so a single-use stream is drained), then fails before it
 *   completes: a multipart body's parts may already be uploaded, and the
 *   upload is aborted; a `get` or `list` first emits `afterChunks` items
 *   (default none).
 * - `at: "response"`: the call **takes effect**, then its response is lost —
 *   an upload is stored (or a version deleted) and the caller sees the
 *   failure; a `get` or `list` emits everything, then fails. A `put` or
 *   `copy` failure names the version it stored (a request-time `copy` fault
 *   names the source). Naming it is a test convenience: an S3 store whose
 *   response was lost cannot know the version, so settlement must never
 *   depend on a failed upload's `ref`.
 */
export type MemoryBlobFault =
  | {
      readonly _tag: "Fail"
      readonly reason: BlobStoreReason
      readonly at?: "request" | "response" | undefined
      readonly afterChunks?: number | undefined
    }
  | {
      readonly _tag: "Interrupt"
      readonly at?: "request" | "response" | undefined
      readonly afterChunks?: number | undefined
    }

/** Options of `BlobStore.memory`. */
export interface MemoryBlobStoreOptions {
  /** `"versioned"` (default) or `"keyPerWrite"`. */
  readonly versioning?: "versioned" | "keyPerWrite" | undefined
  /** The store prefix (default `""`): at most 256 UTF-8 bytes, not starting with `/`. */
  readonly prefix?: string | undefined
  /** Implement `presign` (fake `memory://` URLs). Default `false`. */
  readonly presign?: boolean | undefined
  /**
   * The declared `limits.maxVersionBytes` (default 32 when versioned, 0 per
   * key-per-write): at least the ids the store makes, at most 1,024.
   */
  readonly maxVersionBytes?: number | undefined
  /** Default 1 hour; from 1 minute to 7 days. */
  readonly maxUploadAge?: Duration.Input | undefined
  /** Concurrent reads per operation (eager resolution). Default 16. */
  readonly readConcurrency?: number | undefined
  /** Concurrent uploads per operation. Default 8. */
  readonly writeConcurrency?: number | undefined
  /** Bytes per chunk a `get` emits (default 65,536). */
  readonly readChunkBytes?: number | undefined
  /**
   * Bytes per part of a multipart upload (default 8 MiB); a body of at most
   * this many bytes is one upload. Any positive integer: unlike S3, no 5 MiB
   * floor, so tests exercise multipart with small bodies.
   */
  readonly partSize?: number | undefined
  /** The most parts an upload may have (default 10,000, S3's). */
  readonly maxParts?: number | undefined
  /** Parts uploaded at once (default 4). */
  readonly uploadConcurrency?: number | undefined
  /** Attempts per part on `Throttled` / `Unavailable`, as the SDK retries (default 3). */
  readonly partAttempts?: number | undefined
  /** The clock `lastModified` comes from; default the calling fiber's. */
  readonly clock?: Clock.Clock | undefined
  /** Asked about every call; `undefined` lets it run. May be an effect (to pause a call). */
  readonly failures?:
    | ((
        call: MemoryBlobCall,
      ) => MemoryBlobFault | undefined | Effect.Effect<MemoryBlobFault | undefined>)
    | undefined
}

/** One stored version, as `inspect()` returns it. */
export interface MemoryBlobVersion {
  readonly ref: BlobRef
  readonly size: number
  /** A copy of the stored bytes. */
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly metadata: Readonly<Record<string, string>>
  readonly lastModified: Date
  readonly isLatest: boolean
  /** The unreferenced-since mark; `Option.none()` when the version has none. */
  readonly mark: Option.Option<Date>
}

/** The multipart calls a memory store served (attempts included), and the uploads still open. */
export interface MemoryMultipartSnapshot {
  readonly creates: number
  readonly parts: number
  readonly completes: number
  readonly aborts: number
  /** Uploads created and neither completed nor aborted. */
  readonly inProgress: number
}

/** What the memory store holds, and how often each action was called. */
export interface MemoryBlobSnapshot {
  /** Keys ascending (UTF-8 order), versions newest first. */
  readonly versions: ReadonlyArray<MemoryBlobVersion>
  readonly calls: Readonly<Record<BlobStoreAction, number>>
  readonly multipart: MemoryMultipartSnapshot
}

/** The in-memory store: every capability, plus {@link MemoryBlobStore.inspect}. */
export interface MemoryBlobStore extends BlobStoreService {
  readonly copy: NonNullable<BlobStoreService["copy"]>
  readonly list: NonNullable<BlobStoreService["list"]>
  readonly head: NonNullable<BlobStoreService["head"]>
  readonly marks: BlobStoreMarks
  /** The store's contents and call counts. */
  readonly inspect: () => MemoryBlobSnapshot
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  "versioning",
  "prefix",
  "presign",
  "maxVersionBytes",
  "maxUploadAge",
  "readConcurrency",
  "writeConcurrency",
  "readChunkBytes",
  "partSize",
  "maxParts",
  "uploadConcurrency",
  "partAttempts",
  "clock",
  "failures",
])

const VERSION_ID_CHARS = 32
const KEY_SUFFIX_CHARS = 26
const DEFAULT_READ_CHUNK_BYTES = 65_536
const WHERE = "BlobStore.memory"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StoredVersion {
  readonly version: string
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly metadata: Readonly<Record<string, string>>
  readonly lastModified: number
  mark: number | undefined
}

/** Order strings as their UTF-8 bytes (code points), as S3 orders keys. */
export const compareUtf8 = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    // Surrogates (supplementary code points) sort above U+E000–U+FFFF.
    const fx = x >= 0xd800 && x <= 0xdfff ? x + 0x2000 : x >= 0xe000 ? x - 0x800 : x
    const fy = y >= 0xd800 && y <= 0xdfff ? y + 0x2000 : y >= 0xe000 ? y - 0x800 : y
    return fx - fy
  }
  return a.length - b.length
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"

const randomHex = (chars: number): Effect.Effect<string> =>
  Effect.map(
    Effect.forEach(Array.from({ length: chars }), () =>
      Random.nextIntBetween(0, 16, { halfOpen: true }),
    ),
    (digits) => digits.map((d) => d.toString(16)).join(""),
  )

const SUFFIX_TIME_CHARS = 10
const SUFFIX_RANDOM_CHARS = KEY_SUFFIX_CHARS - SUFFIX_TIME_CHARS

/** The random part of a key-per-write suffix: base-32 digits. */
const randomDigits: Effect.Effect<ReadonlyArray<number>> = Effect.forEach(
  Array.from({ length: SUFFIX_RANDOM_CHARS }),
  () => Random.nextIntBetween(0, 32, { halfOpen: true }),
)

/** The digits plus one, or `undefined` when every digit is the largest. */
const incremented = (digits: ReadonlyArray<number>): ReadonlyArray<number> | undefined => {
  const next = [...digits]
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i] = next[i]! + 1
      return next
    }
    next[i] = 0
  }
  return undefined
}

/** The last key-per-write suffix a store made, as a timestamp and random digits. */
interface SuffixState {
  readonly time: number
  readonly digits: ReadonlyArray<number>
}

/**
 * The suffix after `last` at time `now`, monotonic like a monotonic ULID: a
 * later millisecond takes the fresh digits; the same or an earlier one keeps
 * `last`'s time and counts its digits up (into the next millisecond in the
 * astronomically unlikely case they are all at their largest).
 */
const nextSuffix = (
  last: SuffixState | undefined,
  now: number,
  fresh: ReadonlyArray<number>,
): SuffixState => {
  const time = Math.max(0, Math.floor(now))
  if (last === undefined || time > last.time) return { time, digits: fresh }
  const digits = incremented(last.digits)
  return digits === undefined ? { time: last.time + 1, digits: fresh } : { time: last.time, digits }
}

const encodeSuffix = (suffix: SuffixState): string => {
  let time = ""
  let t = suffix.time
  for (let i = 0; i < SUFFIX_TIME_CHARS; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  return time + suffix.digits.map((d) => CROCKFORD[d]).join("")
}

const isAsciiPrintable = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

const rejected = (message: string, ref?: BlobRef): BlobStoreFailure =>
  new BlobStoreFailure({ reason: "Rejected", ref, cause: new Error(`${WHERE}: ${message}`) })

const notFound = (ref: BlobRef): BlobStoreFailure =>
  new BlobStoreFailure({
    reason: "NotFound",
    ref,
    cause: new Error(`${WHERE}: no such version`),
  })

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Build an in-memory store.
 *
 * @throws `[EDD-9116]` for invalid options: an unknown key; `versioning` not
 *   `"versioned"` / `"keyPerWrite"`; a `prefix` over 256 bytes or starting
 *   with `/`; `presign` not a boolean; `maxVersionBytes` not an integer from
 *   the ids the store makes (32 / 0) to 1,024; `maxUploadAge` outside 1 minute
 *   … 7 days; a concurrency, `readChunkBytes`, `partSize`, `maxParts` or
 *   `partAttempts` not a positive integer; `clock` not a `Clock`; `failures`
 *   not a function.
 */
export const make = (options: MemoryBlobStoreOptions = {}): MemoryBlobStore => {
  if (typeof options !== "object" || options === null) {
    return invalid(WHERE, `options must be an object, got ${String(options)}.`)
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      invalid(WHERE, `unknown option "${key}" (expected ${[...OPTION_KEYS].join(", ")}).`)
    }
  }
  const versioning = options.versioning ?? "versioned"
  if (versioning !== "versioned" && versioning !== "keyPerWrite") {
    invalid(
      WHERE,
      `versioning must be "versioned" or "keyPerWrite", got ${JSON.stringify(versioning)}.`,
    )
  }
  const prefix = checkPrefix(WHERE, "prefix", options.prefix ?? "")
  const presign = options.presign ?? false
  if (typeof presign !== "boolean") {
    invalid(WHERE, `presign must be a boolean, got ${String(presign)}.`)
  }
  const idBytes = versioning === "versioned" ? VERSION_ID_CHARS : 0
  const maxVersionBytes = options.maxVersionBytes ?? idBytes
  if (
    typeof maxVersionBytes !== "number" ||
    !Number.isSafeInteger(maxVersionBytes) ||
    maxVersionBytes < idBytes ||
    maxVersionBytes > 1_024
  ) {
    invalid(
      WHERE,
      `maxVersionBytes must be an integer from ${idBytes} (the version ids this store makes) ` +
        `to 1024, got ${String(maxVersionBytes)}.`,
    )
  }
  const maxUploadAge = checkMaxUploadAgeOption(WHERE, options.maxUploadAge)
  const readConcurrency = checkPositiveInteger(
    WHERE,
    "readConcurrency",
    options.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
  )
  const writeConcurrency = checkPositiveInteger(
    WHERE,
    "writeConcurrency",
    options.writeConcurrency ?? DEFAULT_WRITE_CONCURRENCY,
  )
  const readChunkBytes = checkPositiveInteger(
    WHERE,
    "readChunkBytes",
    options.readChunkBytes ?? DEFAULT_READ_CHUNK_BYTES,
  )
  const partSize = checkPositiveInteger(
    WHERE,
    "partSize",
    options.partSize ?? Multipart.DEFAULT_PART_SIZE,
  )
  const maxParts = checkPositiveInteger(WHERE, "maxParts", options.maxParts ?? Multipart.MAX_PARTS)
  const uploadConcurrency = checkPositiveInteger(
    WHERE,
    "uploadConcurrency",
    options.uploadConcurrency ?? Multipart.DEFAULT_UPLOAD_CONCURRENCY,
  )
  const partAttempts = checkPositiveInteger(WHERE, "partAttempts", options.partAttempts ?? 3)
  const clock = options.clock
  if (
    clock !== undefined &&
    (typeof clock !== "object" || clock === null || !Effect.isEffect(clock.currentTimeMillis))
  ) {
    invalid(WHERE, "clock must be an Effect Clock.")
  }
  const failures = options.failures
  if (failures !== undefined && typeof failures !== "function") {
    invalid(WHERE, "failures must be a function.")
  }

  const objects = new Map<string, Array<StoredVersion>>()
  let lastSuffix: SuffixState | undefined
  const calls: Record<BlobStoreAction, number> = {
    put: 0,
    get: 0,
    delete: 0,
    copy: 0,
    list: 0,
    head: 0,
    mark: 0,
    presign: 0,
  }

  const multipart = { creates: 0, parts: 0, completes: 0, aborts: 0 }
  /** Open multipart uploads: id → their parts by number. */
  const uploads = new Map<number, Map<number, Uint8Array>>()
  let nextUpload = 0

  const now: Effect.Effect<number> =
    clock === undefined ? Clock.currentTimeMillis : clock.currentTimeMillis

  /** Ask the hook about a call. */
  const ask = (call: MemoryBlobCall): Effect.Effect<MemoryBlobFault | undefined> =>
    Effect.suspend(() => {
      if (failures === undefined) return Effect.succeed(undefined)
      const answer = failures(call)
      return Effect.flatMap(Effect.isEffect(answer) ? answer : Effect.succeed(answer), (fault) =>
        fault === undefined || fault._tag === "Fail" || fault._tag === "Interrupt"
          ? Effect.succeed(fault)
          : Effect.die(new Error(`${WHERE}: failures returned an unknown fault`)),
      )
    })

  /** Count the call and ask the hook about it. */
  const begin = (call: StoreCall): Effect.Effect<MemoryBlobFault | undefined> =>
    Effect.suspend(() => {
      calls[call.action] += 1
      return ask({ ...call, n: calls[call.action] })
    })

  const trigger = (
    fault: MemoryBlobFault,
    action: BlobStoreAction,
    ref: BlobRef | undefined,
  ): Effect.Effect<never, BlobStoreFailure> =>
    fault._tag === "Interrupt"
      ? Effect.interrupt
      : Effect.fail(
          new BlobStoreFailure({
            reason: fault.reason,
            ref,
            cause: new Error(
              `${WHERE}: injected ${fault.reason} on ${action}` +
                (fault.at === "response" ? " (after it took effect)" : ""),
            ),
          }),
        )

  const atRequest = (fault: MemoryBlobFault | undefined): fault is MemoryBlobFault =>
    fault !== undefined && fault.at !== "response"
  const atResponse = (fault: MemoryBlobFault | undefined): fault is MemoryBlobFault =>
    fault !== undefined && fault.at === "response"

  /**
   * Run an effect-shaped call: the fault before or after `body`. A fault at
   * the request names `ref`; one at the response names `responseRef(result)`
   * (default `ref`).
   */
  const call = <A>(
    info: StoreCall,
    ref: BlobRef | undefined,
    body: Effect.Effect<A, BlobStoreFailure>,
    responseRef: (result: A) => BlobRef | undefined = () => ref,
  ): Effect.Effect<A, BlobStoreFailure> =>
    Effect.flatMap(begin(info), (fault) =>
      atRequest(fault)
        ? trigger(fault, info.action, ref)
        : Effect.flatMap(body, (result) =>
            atResponse(fault)
              ? trigger(fault, info.action, responseRef(result))
              : Effect.succeed(result),
          ),
    )

  /** Run a stream-shaped call: the fault after `afterChunks` items, or at the end. */
  const streamCall = <A>(
    info: StoreCall,
    ref: BlobRef | undefined,
    items: Effect.Effect<ReadonlyArray<A>, BlobStoreFailure>,
  ): Stream.Stream<A, BlobStoreFailure> =>
    Stream.unwrap(
      Effect.flatMap(begin(info), (fault) => {
        if (atRequest(fault) && (fault.afterChunks ?? 0) === 0) {
          return Effect.succeed(Stream.fromEffect(trigger(fault, info.action, ref)))
        }
        return Effect.map(items, (all) => {
          if (fault === undefined) return Stream.fromIterable(all)
          const head = atRequest(fault) ? all.slice(0, fault.afterChunks ?? 0) : all
          return Stream.concat(
            Stream.fromIterable(head),
            Stream.fromEffect(trigger(fault, info.action, ref)),
          )
        })
      }),
    )

  const find = (ref: BlobRef): StoredVersion | undefined =>
    objects.get(ref.key)?.find((v) => v.version === ref.version)

  const checkKey = (key: unknown): BlobStoreFailure | undefined => {
    const bytes = typeof key === "string" ? utf8Bytes(key) : undefined
    if (bytes === undefined || bytes < 1) return rejected("the key must be a non-empty string")
    // A key-per-write store appends "/" + the suffix.
    const extended = versioning === "keyPerWrite" ? bytes + 1 + KEY_SUFFIX_CHARS : bytes
    if (extended > MAX_KEY_BYTES) {
      return rejected(`the key is ${extended} UTF-8 bytes, over S3's ${MAX_KEY_BYTES}-byte limit`)
    }
    return undefined
  }

  const checkUpload = (request: BlobCopyRequest): BlobStoreFailure | undefined => {
    const keyFailure = checkKey(request.key)
    if (keyFailure !== undefined) return keyFailure
    if (
      typeof request.contentType !== "string" ||
      request.contentType.length === 0 ||
      !isAsciiPrintable(request.contentType)
    ) {
      // An HTTP header carries no control character (CR, LF, NUL…).
      return rejected("contentType must be a non-empty printable US-ASCII string")
    }
    const metadata = request.metadata as Readonly<Record<string, unknown>> | null | undefined
    if (typeof metadata !== "object" || metadata === null) {
      return rejected("metadata must be a record of strings")
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (key.length === 0 || typeof value !== "string" || !isAsciiPrintable(key + value)) {
        return rejected(`metadata entry ${JSON.stringify(key)} is not a printable US-ASCII string`)
      }
    }
    const bytes = metadataBytes(metadata as Readonly<Record<string, string>>)
    if (bytes > MAX_METADATA_BYTES) {
      return rejected(`metadata is ${bytes} bytes, over S3's ${MAX_METADATA_BYTES}-byte limit`)
    }
    return undefined
  }

  /** Store a new version; returns its ref. */
  const store = (request: BlobCopyRequest, bytes: Uint8Array): Effect.Effect<BlobPutResult> =>
    Effect.gen(function* () {
      const at = yield* now
      const metadata: Record<string, string> = {}
      for (const [key, value] of Object.entries(request.metadata)) {
        metadata[key.toLowerCase()] = value
      }
      let key = request.key
      let version = ""
      if (versioning === "keyPerWrite") {
        const fresh = yield* randomDigits
        // From here to the insert nothing yields, so the suffix order is the write order.
        do {
          lastSuffix = nextSuffix(lastSuffix, at, fresh)
          key = `${request.key}/${encodeSuffix(lastSuffix)}`
        } while (objects.has(key))
      } else {
        const existing = objects.get(key) ?? []
        do {
          version = yield* randomHex(VERSION_ID_CHARS)
        } while (existing.some((v) => v.version === version))
      }
      const versions = objects.get(key) ?? []
      versions.push({
        version,
        bytes,
        contentType: request.contentType,
        metadata: Object.freeze(metadata),
        lastModified: at,
        mark: undefined,
      })
      objects.set(key, versions)
      return { ref: { key, version }, size: bytes.length }
    })

  /** The stored body checked as S3 checks one: its length and its CRC-64/NVME. */
  const checkBody = (
    request: BlobPutRequest,
    bytes: Uint8Array,
  ): Effect.Effect<void, BlobStoreFailure> =>
    Effect.gen(function* () {
      if (request.contentLength !== undefined && request.contentLength !== bytes.length) {
        return yield* rejected(
          `the body is ${bytes.length} bytes, but contentLength is ${request.contentLength}`,
        )
      }
      const checksum = yield* request.checksum
      if (checksum.algorithm !== "crc64nvme" || !sameBytes(checksum.value, crc64nvme(bytes))) {
        return yield* new BlobStoreFailure({
          reason: "ChecksumMismatch",
          cause: new Error(`${WHERE}: the body does not match its CRC-64/NVME`),
        })
      }
    })

  const RETRIED: ReadonlySet<BlobStoreReason> = new Set(["Throttled", "Unavailable"])

  /** S3's multipart protocol, simulated, for one put (`n` is its call number). */
  const protocolOf = (
    request: BlobPutRequest,
    n: number,
  ): Multipart.MultipartProtocol<number, number> => {
    const phase = (
      info: NonNullable<MemoryBlobCall["multipart"]>,
    ): Effect.Effect<MemoryBlobFault | undefined> =>
      ask({ action: "multipart", n, key: request.key, multipart: info })
    const part = (
      id: number,
      req: Multipart.PartRequest,
      attempt: number,
    ): Effect.Effect<number, BlobStoreFailure> =>
      Effect.gen(function* () {
        multipart.parts += 1
        const fault = yield* phase({ phase: "part", part: req.number, attempt })
        const open = uploads.get(id)
        if (open === undefined) {
          return yield* rejected(`no multipart upload ${id} is open (NoSuchUpload)`)
        }
        if (req.number > maxParts) {
          return yield* new BlobStoreFailure({
            reason: "TooLarge",
            cause: new Error(
              `${WHERE}: the body needs more than ${maxParts} parts of ${req.partSize} bytes; ` +
                "give its length (Offload.source(stream, { contentLength })) so the part size " +
                "adapts, or raise partSize",
            ),
          })
        }
        if (atRequest(fault)) return yield* trigger(fault, "put", undefined)
        open.set(req.number, new Uint8Array(req.bytes))
        if (atResponse(fault)) return yield* trigger(fault, "put", undefined)
        return req.number
      }).pipe(
        Effect.catchIf(
          (failure) => RETRIED.has(failure.reason) && attempt < partAttempts,
          () => part(id, req, attempt + 1),
        ),
      )
    return {
      single: (bytes) =>
        Effect.gen(function* () {
          yield* checkBody(request, bytes)
          return yield* store(request, new Uint8Array(bytes))
        }),
      create: Effect.gen(function* () {
        multipart.creates += 1
        const fault = yield* phase({ phase: "create" })
        if (atRequest(fault)) return yield* trigger(fault, "put", undefined)
        const id = ++nextUpload
        uploads.set(id, new Map())
        if (atResponse(fault)) return yield* trigger(fault, "put", undefined)
        return id
      }),
      part: (id, req) => part(id, req, 1),
      complete: (id, numbers) =>
        Effect.gen(function* () {
          multipart.completes += 1
          const fault = yield* phase({ phase: "complete" })
          const lost = atResponse(fault) ? fault : undefined
          if (atRequest(fault)) return yield* trigger(fault, "put", undefined)
          const open = uploads.get(id)
          if (open === undefined) {
            return yield* rejected(`no multipart upload ${id} is open (NoSuchUpload)`)
          }
          const parts = numbers.map((number) => open.get(number))
          if (parts.some((bytes) => bytes === undefined)) {
            return yield* rejected("a completed part was never uploaded (InvalidPart)")
          }
          const bytes = concat(parts as ReadonlyArray<Uint8Array>)
          yield* checkBody(request, bytes)
          uploads.delete(id)
          const result = yield* store(request, bytes)
          if (lost !== undefined) {
            if (lost._tag === "Interrupt") return yield* Effect.interrupt
            // S3 never learns the version a lost Complete made.
            return yield* new BlobStoreFailure({
              reason: lost.reason,
              completeLost: true,
              cause: new Error(
                `${WHERE}: injected ${lost.reason} on put (its multipart upload completed, ` +
                  "but the response was lost)",
              ),
            })
          }
          return result
        }),
      abort: (id) =>
        Effect.gen(function* () {
          multipart.aborts += 1
          const fault = yield* phase({ phase: "abort" })
          if (atRequest(fault)) return yield* trigger(fault, "put", undefined)
          uploads.delete(id)
          if (atResponse(fault)) return yield* trigger(fault, "put", undefined)
        }),
    }
  }

  const put = (request: BlobPutRequest): Effect.Effect<BlobPutResult, BlobStoreFailure> =>
    Effect.suspend(() => {
      calls.put += 1
      const n = calls.put
      return Effect.flatMap(ask({ action: "put", n, key: request.key }), (fault) =>
        Effect.gen(function* () {
          const failure = checkUpload(request)
          if (failure !== undefined) return yield* failure
          let body: Uint8Array | Stream.Stream<Uint8Array, BlobStoreFailure>
          if (request.body instanceof Uint8Array) {
            body = request.body
          } else if (Stream.isStream(request.body)) {
            body = request.body
          } else {
            return yield* rejected("body must be a Uint8Array or a Stream")
          }
          if (atRequest(fault)) {
            // No effect: the body is consumed (`afterChunks` chunks, default all
            // of it — a single-use stream is drained), then the call fails
            // before it completes (a multipart upload's parts are aborted).
            const limit = fault.afterChunks
            const chunks = body instanceof Uint8Array ? Stream.succeed(body) : body
            body = Stream.concat(
              Stream.mapEffect(chunks, (chunk, i) =>
                limit !== undefined && i >= limit
                  ? trigger(fault, "put", undefined)
                  : Effect.succeed(chunk),
              ),
              Stream.fromEffect(trigger(fault, "put", undefined)),
            )
          }
          const result = yield* Multipart.upload(
            body,
            request.contentLength,
            { partSize, concurrency: uploadConcurrency, maxParts, where: WHERE },
            protocolOf(request, n),
          )
          if (atResponse(fault)) return yield* trigger(fault, "put", result.ref)
          return result
        }),
      )
    })

  const checkRange = (range: ByteRange | undefined, size: number): string | undefined => {
    if (range === undefined) return undefined
    const { offset, length } = range
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      return `range offset ${String(offset)} is not a non-negative integer`
    }
    if (
      length !== undefined &&
      (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
    ) {
      return `range length ${String(length)} is not a non-negative integer`
    }
    if (offset > size) return `range offset ${offset} is past the end (${size} bytes)`
    return undefined
  }

  const get = (
    ref: BlobRef,
    options?: { readonly range?: ByteRange | undefined },
  ): Stream.Stream<Uint8Array, BlobStoreFailure> =>
    streamCall(
      { action: "get", ref },
      ref,
      Effect.suspend(() => {
        const found = find(ref)
        if (found === undefined) return Effect.fail(notFound(ref))
        const range = options?.range
        const problem = checkRange(range, found.bytes.length)
        if (problem !== undefined) return Effect.fail(rejected(problem, ref))
        const start = range?.offset ?? 0
        const end =
          range?.length === undefined
            ? found.bytes.length
            : Math.min(found.bytes.length, start + range.length)
        const chunks: Array<Uint8Array> = []
        for (let at = start; at < end; at += readChunkBytes) {
          chunks.push(found.bytes.slice(at, Math.min(end, at + readChunkBytes)))
        }
        return Effect.succeed(chunks)
      }),
    )

  const deleteRefs = (refs: ReadonlyArray<BlobRef>): Effect.Effect<void, BlobStoreFailure> =>
    call(
      { action: "delete", refs },
      undefined,
      Effect.sync(() => {
        for (const ref of refs) {
          const versions = objects.get(ref.key)
          if (versions === undefined) continue
          const kept = versions.filter((v) => v.version !== ref.version)
          if (kept.length === 0) objects.delete(ref.key)
          else objects.set(ref.key, kept)
        }
      }),
    )

  const copy = (
    source: BlobRef,
    request: BlobCopyRequest,
  ): Effect.Effect<BlobPutResult, BlobStoreFailure> =>
    call(
      { action: "copy", key: request.key, ref: source },
      source,
      Effect.suspend(() => {
        const found = find(source)
        if (found === undefined) return Effect.fail(notFound(source))
        const failure = checkUpload(request)
        if (failure !== undefined) return Effect.fail(failure)
        if (request.contentLength !== undefined && request.contentLength !== found.bytes.length) {
          return Effect.fail(
            rejected(
              `the source is ${found.bytes.length} bytes, but contentLength is ${request.contentLength}`,
              source,
            ),
          )
        }
        return store(request, found.bytes)
      }),
      // a lost response names the copy it stored, as a put's does
      (result) => result.ref,
    )

  const list = (
    listPrefix: string,
    options?: { readonly startAfter?: string | undefined },
  ): Stream.Stream<BlobListing, BlobStoreFailure> =>
    streamCall(
      { action: "list", key: listPrefix },
      undefined,
      Effect.sync(() => {
        const startAfter = options?.startAfter
        const keys = [...objects.keys()]
          .filter(
            (key) =>
              key.startsWith(listPrefix) &&
              (startAfter === undefined || compareUtf8(key, startAfter) > 0),
          )
          .sort((a, b) => compareUtf8(a, b))
        return keys.flatMap((key) => {
          const versions = objects.get(key) ?? []
          return versions
            .map(
              (v, i): BlobListing => ({
                ref: { key, version: v.version },
                size: v.bytes.length,
                lastModified: new Date(v.lastModified),
                isLatest: i === versions.length - 1,
              }),
            )
            .reverse()
        })
      }),
    )

  const head = (ref: BlobRef): Effect.Effect<Readonly<Record<string, string>>, BlobStoreFailure> =>
    call(
      { action: "head", ref },
      ref,
      Effect.suspend(() => {
        const found = find(ref)
        return found === undefined
          ? Effect.fail(notFound(ref))
          : Effect.succeed({ ...found.metadata })
      }),
    )

  const marks: BlobStoreMarks = {
    get: (ref) =>
      call(
        { action: "mark", ref, mark: "get" },
        ref,
        Effect.sync(() =>
          Option.map(Option.fromNullishOr(find(ref)?.mark), (mark) => new Date(mark)),
        ),
      ),
    set: (ref, since) =>
      call(
        { action: "mark", ref, mark: "set" },
        ref,
        Effect.suspend(() => {
          if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
            return Effect.fail(rejected("a mark must be a valid Date", ref))
          }
          const found = find(ref)
          if (found !== undefined) found.mark = since.getTime()
          return Effect.void
        }),
      ),
    clear: (ref) =>
      call(
        { action: "mark", ref, mark: "clear" },
        ref,
        Effect.sync(() => {
          const found = find(ref)
          if (found !== undefined) found.mark = undefined
        }),
      ),
  }

  const presignUrl = (ref: BlobRef, options: BlobPresignOptions) =>
    call(
      { action: "presign", ref },
      ref,
      Effect.suspend(() => {
        const expiresIn = options?.expiresIn
        if (
          !Duration.isDuration(expiresIn) ||
          !Duration.isFinite(expiresIn) ||
          !Duration.isPositive(expiresIn)
        ) {
          return Effect.fail(rejected("expiresIn must be a positive, finite Duration", ref))
        }
        const params = new URLSearchParams()
        if (ref.version !== "") params.set("versionId", ref.version)
        params.set("expiresIn", String(Math.ceil(Duration.toSeconds(expiresIn))))
        if (options.contentType !== undefined) params.set("contentType", options.contentType)
        const path = ref.key
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")
        return Effect.succeed(`memory://${path}?${params.toString()}`)
      }),
    )

  const inspect = (): MemoryBlobSnapshot => ({
    versions: [...objects.keys()]
      .sort((a, b) => compareUtf8(a, b))
      .flatMap((key) => {
        const versions = objects.get(key) ?? []
        return versions
          .map(
            (v, i): MemoryBlobVersion => ({
              ref: { key, version: v.version },
              size: v.bytes.length,
              bytes: v.bytes.slice(),
              contentType: v.contentType,
              metadata: v.metadata,
              lastModified: new Date(v.lastModified),
              isLatest: i === versions.length - 1,
              mark: Option.map(Option.fromNullishOr(v.mark), (mark) => new Date(mark)),
            }),
          )
          .reverse()
      }),
    calls: { ...calls },
    multipart: { ...multipart, inProgress: uploads.size },
  })

  return {
    name: `memory://${prefix}`,
    prefix,
    limits: {
      maxVersionBytes,
      maxKeySuffixBytes: versioning === "keyPerWrite" ? 1 + KEY_SUFFIX_CHARS : 0,
    },
    maxUploadAge,
    readConcurrency,
    writeConcurrency,
    put,
    get,
    delete: deleteRefs,
    copy,
    list,
    head,
    marks,
    ...(presign ? { presign: presignUrl } : {}),
    inspect,
  }
}
