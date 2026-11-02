/**
 * @internal The upload ledger (#179, design §6.2): who owns an offloaded
 * value's upload until DynamoDB has decided whether the write that carries
 * its pointer committed.
 *
 * - **Root.** The outermost library operation that can upload opens a ledger
 *   ({@link root}); nested library calls reuse it. `Capacity.detachContext`
 *   clears it from a bound client's captured context, as it clears the
 *   current operation, so a bound op joins the ledger of whatever runs it.
 * - **Entries.** Every upload ({@link upload}) becomes an entry — its ref, the
 *   store it went to, its target (table, entity, attribute, row key), when it
 *   started, and its state, starting `pending`. An upload of the same content
 *   to the same key in one ledger is memoised: a re-planned transaction, a
 *   rebuilt `additionalItems`, a `commandHandler` retry that decides the same
 *   content upload once.
 * - **Streams and handles** (design §3.8, §7). A stream is single-use: it
 *   uploads once, for one key of one ledger, memoised by its identity — a
 *   second key, a later operation or a retry after its upload failed is
 *   refused (`[EDD-9120]`). A handle's content is copied into a new version
 *   (the store's `copy` within the handle's own store, else streamed into a
 *   `put`), never shared. A `put` failure that says its multipart upload may
 *   have completed (`completeLost`) is reported at exit.
 * - **Settling.** `Capacity.client`, the one place every library DynamoDB
 *   request goes through, hands each write request of a ledger with entries to
 *   {@link guard}: it refuses a request carrying an upload older than its
 *   store's `maxUploadAge` (`BlobStoreError { reason: "Expired" }`, nothing
 *   sent), gives a `TransactWriteItems` or PartiQL `ExecuteTransaction` the
 *   library's own `ClientRequestToken` and a single-item write `ReturnValuesOnConditionCheckFailure:
 *   "ALL_OLD"`, and settles the entries the request carries by its outcome —
 *   `$metadata.attempts`, the token, the `ALL_OLD` / `ALL_NEW` evidence
 *   (the table of §6.2).
 * - **Lattice.** `pending < rejected < inDoubt < committed`: an entry only
 *   moves up, so a version attempt 2 committed is never deleted because
 *   attempt 1 was rejected.
 * - **Exit.** When the root exits — success, failure or interruption — the
 *   `pending` and `rejected` entries are deleted (uninterruptibly, one
 *   `store.delete` per store, best-effort: a failed delete never replaces the
 *   operation's outcome). `inDoubt` entries, failed deletes and uploads whose
 *   version no entry names (a lost multipart completion; a store answer that
 *   names no version of the requested key, which is refused and never
 *   deleted) are logged at `Warning` and delivered to the
 *   `Offload.layerObserver` observer.
 * - **Read cache.** Each buffered entry's content (the JSON text, or the
 *   bytes) is kept by ref, so decoding what the operation just wrote never
 *   fetches it. A stream's or a copy's content is never in hand, so is not.
 *
 * No AWS SDK import: requests and responses are read structurally.
 *
 * Not part of the public API (`Offload.layerObserver` is).
 */

import type { CompressionCodec } from "@effect-dynamodb/schema/DynamoModel.js"
import type { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  type BlobChecksum,
  type BlobPointer,
  type BlobPointerKind,
  type BlobRef,
  decode as decodePointer,
  decodeText as decodePointerText,
  isPointerHeader,
  isPointerText,
  make as makePointer,
} from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme, make as makeCrc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Semaphore,
  Stream,
} from "effect"
import { type BlobCallContext, blobError, call, refKey } from "./BlobCalls.js"
import {
  type BlobPutRequest,
  type BlobPutResult,
  type BlobSourceFailure,
  BlobStoreFailure,
  type BlobStoreService,
  utf8Bytes,
} from "./BlobStoreContract.js"
import { unusable } from "./OffloadInput.js"
import { type BlobHandle, handleStoreOf } from "./OffloadValues.js"

// ---------------------------------------------------------------------------
// Observer (public through Offload.ts)
// ---------------------------------------------------------------------------

/** Why an upload could not be settled. */
export type UnsettledReason =
  /** The outcome of the DynamoDB write that carried it is unknown: the version is kept. */
  | "inDoubt"
  /** DynamoDB rejected the write, but deleting the version failed: it is left behind. */
  | "rollbackFailed"
  /** A multipart upload completed but its response was lost: the version has no pointer. */
  | "completeLost"
  /**
   * The store's answer to the upload broke the contract (no ref, a ref outside
   * the requested key, a ref it had already returned): whatever version it
   * wrote has no pointer.
   */
  | "answerRefused"

/**
 * An upload the library could not settle. The item it was written for is the
 * one to queue for `gc.sweep`; leaks no process could report are found by
 * `gc.sweepStore`.
 */
export interface UnsettledUpload {
  readonly reason: UnsettledReason
  /** The physical table name. */
  readonly table: string
  /** The entity type, or `"<stream>.event"` / `"<stream>.snapshot"`. */
  readonly entityType: string
  /** The stored attribute name. */
  readonly attribute: string
  /** The library operation that uploaded it, e.g. `"Entity.put"`. */
  readonly operation: string
  /** The primary key of the row it was written for (stored attribute names). */
  readonly rowKey: Readonly<Record<string, unknown>>
  /** The object key. */
  readonly key: string
  /** The object version; `undefined` when it is unknown (`completeLost`, `answerRefused`). */
  readonly ref: BlobRef | undefined
  /** The store's `name`. */
  readonly store: string
  /** Why: the failed delete's error, the lost response's, the refused answer's `Rejected` error. */
  readonly cause?: unknown
}

/** Options of `Offload.layerObserver`. */
export interface ObserverOptions {
  /**
   * Called once per upload the library could not settle, after the operation
   * that made it exits. A failure is logged at `Warning` and never changes the
   * operation's result.
   */
  readonly onUnsettled: (upload: UnsettledUpload) => Effect.Effect<void>
}

/** The unsettled-upload observer. Default: none. */
export const Observer: Context.Reference<ObserverOptions | undefined> = Context.Reference<
  ObserverOptions | undefined
>("effect-dynamodb/Offload/Observer", { defaultValue: () => undefined })

/**
 * Deliver every upload the library could not settle to `onUnsettled`, for
 * everything run under this layer (and every client bound while it was in
 * context).
 */
export const layerObserver = (options: ObserverOptions): Layer.Layer<never> =>
  Layer.succeed(Observer, options)

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Where an entry stands: it only moves up. */
export type EntryState = "pending" | "rejected" | "inDoubt" | "committed"

const RANK: Readonly<Record<EntryState, number>> = {
  pending: 0,
  rejected: 1,
  inDoubt: 2,
  committed: 3,
}

/** The row attribute an upload is for. */
export interface UploadTarget {
  readonly table: string
  /** The entity type, or `"<stream>.event"` / `"<stream>.snapshot"`. */
  readonly entityType: string
  /** The stored attribute name. */
  readonly attribute: string
  /** The row's primary key (stored attribute names). */
  readonly rowKey: Readonly<Record<string, unknown>>
  /** The library operation, e.g. `"Entity.put"`. */
  readonly operation: string
  /**
   * The member's rows copy pointers (`versioned: { retain }`, `softDelete`,
   * `timeSeries`): an `ALL_OLD` image without the pointer then does not prove
   * the write never committed — an earlier commit's pointer may live on in a
   * snapshot, tombstone or event the live row no longer shows.
   */
  readonly copiesPointers: boolean
}

/** What an upload holds: the uncompressed JSON (json), or the bytes. */
export type LedgerContent =
  | { readonly kind: "json"; readonly text: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }

/** One upload. */
export interface LedgerEntry {
  readonly ref: BlobRef
  /** The store it went to, which rollback deletes from. */
  readonly store: BlobStoreService
  readonly target: UploadTarget
  /** Epoch millis, from the uploading fiber's `Clock`, taken before the store call. */
  readonly startedAt: number
  /** The pointer naming it (`undefined` when the store's answer was refused). */
  readonly pointer: BlobPointer | undefined
  state: EntryState
}

interface Memo {
  readonly deferred: Deferred.Deferred<Uploaded, BlobStoreError | ValidationError>
}

/** A settled-to-be upload: its entry and the pointer naming it. */
interface Uploaded {
  readonly entry: LedgerEntry
  readonly pointer: BlobPointer
}

/** A root operation's uploads. */
export interface Ledger {
  readonly entries: Map<string, LedgerEntry>
  readonly memo: Map<BlobStoreService, Map<string, Memo>>
  readonly cache: Map<string, LedgerContent>
  readonly permits: Map<BlobStoreService, Semaphore.Semaphore>
  /** The `ClientRequestToken`s this ledger gave transactions. */
  readonly tokens: Set<string>
  /** Uploads whose version no entry names (`completeLost`, `answerRefused`): reported at exit. */
  readonly lost: Array<UnsettledUpload>
  closed: boolean
}

/** The ledger of the root operation the fiber runs in. Never captured by a bind site. */
export const CurrentLedger: Context.Reference<Ledger | undefined> = Context.Reference<
  Ledger | undefined
>("effect-dynamodb/Offload/CurrentLedger", { defaultValue: () => undefined })

const makeLedger = (): Ledger => ({
  entries: new Map(),
  memo: new Map(),
  cache: new Map(),
  permits: new Map(),
  tokens: new Set(),
  lost: [],
  closed: false,
})

/** The open ledger of the current fiber, if any. */
export const current: Effect.Effect<Ledger | undefined> = Effect.withFiber((fiber) => {
  const ledger = fiber.getRef(CurrentLedger)
  return Effect.succeed(ledger === undefined || ledger.closed ? undefined : ledger)
})

/** What the ledger uploaded under `ref`, if it did. */
export const cached = (ledger: Ledger | undefined, ref: BlobRef): LedgerContent | undefined =>
  ledger === undefined ? undefined : ledger.cache.get(refKey(ref))

/**
 * Keep `content` in the ledger's read cache as what `ref` names, though the
 * ledger did not upload it: a read pointer a projection's row rewrite reuses
 * (design §6.11), whose content the write just compared — decoding the
 * write's result then fetches nothing. No entry: nothing settles or rolls it
 * back.
 */
export const remember = (
  ledger: Ledger | undefined,
  ref: BlobRef,
  content: LedgerContent,
): void => {
  if (ledger !== undefined && !ledger.closed) ledger.cache.set(refKey(ref), content)
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * Run `effect` as the root of a ledger, or in the ledger already open: every
 * upload inside it is settled by the requests that carry it and, at exit,
 * rolled back when DynamoDB provably did not commit it.
 */
export const root = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const open = fiber.getRef(CurrentLedger)
    if (open !== undefined && !open.closed) return effect
    const ledger = makeLedger()
    return Effect.onExit(Effect.provideService(effect, CurrentLedger, ledger), () => close(ledger))
  })

/** {@link root} when `enabled` (a member that offloads something), else `effect`. */
export const rootIf = <A, E, R>(
  enabled: boolean,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => (enabled ? root(effect) : effect)

/** True iff `member` (an entity) offloads a field. */
export const offloads = (member: unknown): boolean =>
  (member as { readonly offload?: unknown } | null)?.offload !== undefined

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * A stream to upload (design §3.8, §7): **single-use** — run at most once,
 * for one target object. Its checksum is computed as it is consumed.
 */
export interface StreamContent {
  readonly kind: "stream"
  readonly stream: Stream.Stream<Uint8Array, unknown>
  /** The caller's `Stream` value, which single use is keyed on. */
  readonly identity: object
  /** The body's length, when the caller gave it (`Offload.source`). */
  readonly contentLength: number | undefined
}

/**
 * A handle's content, to copy into a new version (design §3.8): with the
 * store's `copy` when the handle reads from the target store, else streamed
 * from the handle into a `put`.
 */
export interface CopyContent {
  readonly kind: "copy"
  readonly handle: BlobHandle
}

/** What an upload sends: buffered content, a stream, or a handle's content. */
export type UploadContent = LedgerContent | StreamContent | CopyContent

/** One value to upload. */
export interface UploadSpec {
  readonly store: BlobStoreService
  /** The derived object key (design §4.5). */
  readonly key: string
  /** The content: the uncompressed JSON (json), the field's bytes, a stream or a handle. */
  readonly content: UploadContent
  /** Codec of the object bytes (json only; `"none"` for bytes). */
  readonly codec: CompressionCodec | "none"
  /** The object bytes, when compressed (buffered content only). Default: the content's bytes. */
  readonly body?: Uint8Array | undefined
  /** The object's `Content-Type` (design §4.4). */
  readonly contentType: string
  /** The content type the pointer records, if any. */
  readonly pointerContentType?: string | undefined
  /**
   * The object metadata (design §4.6), or its builder given the content
   * checksum: the ledger computes that checksum once, for the memo key, the
   * pointer and the metadata, which it builds only when the upload is not
   * memoised. A stream's checksum is known only once it is consumed, so its
   * builder is given a zero checksum — metadata records one only for
   * compressed json, never for bytes.
   */
  readonly metadata:
    | Readonly<Record<string, string>>
    | ((checksum: BlobChecksum) => Readonly<Record<string, string>>)
  readonly target: UploadTarget
}

/** What an upload fails with: the store's failure, or an unusable input (`[EDD-9120]`). */
export type UploadError = BlobStoreError | ValidationError

const encoder = new TextEncoder()

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const ctxOf = (target: UploadTarget): BlobCallContext => ({
  entityType: target.entityType,
  attribute: target.attribute,
  operation: target.operation,
})

const permitsOf = (ledger: Ledger, store: BlobStoreService): Semaphore.Semaphore => {
  let permits = ledger.permits.get(store)
  if (permits === undefined) {
    permits = Semaphore.makeUnsafe(store.writeConcurrency)
    ledger.permits.set(store, permits)
  }
  return permits
}

/**
 * A store's answer to an upload (a `put`, or a `copy` of `source`), checked
 * against the contract:
 *
 * - `Accepted` — a ref in the requested key, new to the ledger, within the
 *   store's declared limits, for the body's size;
 * - `Refused` — a ref in the requested key, new to the ledger, that breaks a
 *   limit or misreports the size: it names what the store wrote for this
 *   upload, so it is recorded and rolled back;
 * - `Unknown` — no ref, a ref outside the requested key, one the store
 *   already returned for another upload, or a copy's own source: it cannot
 *   name what this upload wrote (deleting it could delete another row's
 *   version, or the copied one), so nothing is recorded or deleted, and the
 *   requested key is reported at exit (`answerRefused`) for `gc.sweep`.
 */
type StoreAnswer =
  | { readonly _tag: "Accepted"; readonly ref: BlobRef }
  | { readonly _tag: "Refused"; readonly ref: BlobRef; readonly message: string }
  | { readonly _tag: "Unknown"; readonly ref: BlobRef | undefined; readonly message: string }

const checkAnswer = (
  ledger: Ledger,
  store: BlobStoreService,
  key: string,
  action: "put" | "copy",
  bodyBytes: number,
  result: unknown,
  source: BlobRef | undefined,
): StoreAnswer => {
  const answered = (result as { readonly ref?: unknown } | null)?.ref as
    | { readonly key?: unknown; readonly version?: unknown }
    | undefined
  if (typeof answered?.key !== "string" || typeof answered.version !== "string") {
    return {
      _tag: "Unknown",
      ref: undefined,
      message: `the store's ${action} returned no { key, version } ref`,
    }
  }
  const ref: BlobRef = { key: answered.key, version: answered.version }
  if (source !== undefined && ref.key === source.key && ref.version === source.version) {
    return {
      _tag: "Unknown",
      ref,
      message: "the store's copy returned its source's ref, not a new version's",
    }
  }
  if (!ref.key.startsWith(key)) {
    return {
      _tag: "Unknown",
      ref,
      message: `the store's ${action} returned key "${ref.key}", outside the requested key "${key}"`,
    }
  }
  if (ledger.entries.has(refKey(ref))) {
    return {
      _tag: "Unknown",
      ref,
      message: `the store's ${action} returned a ref it already returned for another upload`,
    }
  }
  const refused = (message: string): StoreAnswer => ({ _tag: "Refused", ref, message })
  const suffix = (utf8Bytes(ref.key) ?? Number.POSITIVE_INFINITY) - (utf8Bytes(key) ?? 0)
  if (suffix > store.limits.maxKeySuffixBytes) {
    return refused(
      `the store's ${action} extended the key by ${suffix} bytes, over its declared ` +
        `limits.maxKeySuffixBytes (${store.limits.maxKeySuffixBytes})`,
    )
  }
  const version = utf8Bytes(ref.version) ?? Number.POSITIVE_INFINITY
  if (version > store.limits.maxVersionBytes) {
    return refused(
      `the store's ${action} returned a ${version}-byte version, over its declared ` +
        `limits.maxVersionBytes (${store.limits.maxVersionBytes})`,
    )
  }
  const size = (result as { readonly size?: unknown }).size
  if (size !== bodyBytes) {
    return refused(
      `the store's ${action} reported ${String(size)} stored bytes for a ${bodyBytes}-byte body`,
    )
  }
  return { _tag: "Accepted", ref }
}

/** What a store answered, and what the pointer naming it records. */
interface Answered {
  readonly action: "put" | "copy"
  readonly startedAt: number
  readonly result: unknown
  readonly kind: BlobPointerKind
  readonly objectSize: number
  readonly contentSize: number
  readonly checksum: BlobChecksum
  /** A copy's source: never what the copy wrote. */
  readonly source?: BlobRef | undefined
  /** Why an accepted answer must still be refused (a stream the put never finished). */
  readonly problem?: string | undefined
}

/**
 * Record a store's answer: the entry of the version it names (`pending`,
 * rolled back at exit unless a request settles it) and the pointer naming
 * it; a refused answer is recorded, then fails the upload; an unknown one is
 * reported at exit and fails it.
 */
const record = (
  ledger: Ledger,
  spec: UploadSpec,
  ctx: BlobCallContext,
  answered: Answered,
): Effect.Effect<Uploaded, BlobStoreError> =>
  Effect.suspend(() => {
    const checked = checkAnswer(
      ledger,
      spec.store,
      spec.key,
      answered.action,
      answered.objectSize,
      answered.result,
      answered.source,
    )
    const answer: StoreAnswer =
      checked._tag === "Accepted" && answered.problem !== undefined
        ? { _tag: "Refused", ref: checked.ref, message: answered.problem }
        : checked
    if (answer._tag === "Unknown") {
      // Nothing names what the store wrote under the requested key: the
      // key is reported at exit, and no ref the answer gave is deleted.
      const error = blobError(ctx, answered.action, "Rejected", answer.ref, answer.message)
      ledger.lost.push(
        unsettledOf(spec.target, spec.store, "answerRefused", spec.key, undefined, error),
      )
      return Effect.fail(error)
    }
    const ref = answer.ref
    const pointer =
      answer._tag === "Refused"
        ? answer.message
        : makePointer({
            kind: answered.kind,
            codec: spec.codec,
            ref,
            objectSize: answered.objectSize,
            contentSize: answered.contentSize,
            checksum: answered.checksum,
            contentType: Option.fromNullishOr(spec.pointerContentType),
          })
    const entry: LedgerEntry = {
      ref,
      store: spec.store,
      target: spec.target,
      startedAt: answered.startedAt,
      pointer: typeof pointer === "string" ? undefined : pointer,
      state: "pending",
    }
    // Registered before anything else can fail: whatever happens next,
    // the version is deleted at exit unless a request settles it.
    ledger.entries.set(refKey(ref), entry)
    if (typeof pointer === "string") {
      return Effect.fail(blobError(ctx, answered.action, "Rejected", ref, pointer))
    }
    return Effect.succeed({ entry, pointer } satisfies Uploaded)
  })

/**
 * A store `put`, its failure wrapped. A failure that says its multipart
 * upload may have completed (`completeLost`) is reported at exit: a version
 * may exist that no ref names (design §7).
 */
const putCall = (
  ledger: Ledger,
  spec: UploadSpec,
  ctx: BlobCallContext,
  request: BlobPutRequest,
): Effect.Effect<BlobPutResult, BlobStoreError> =>
  call(spec.store, "put", ctx, { key: spec.key }, () => spec.store.put(request)).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if ((error.cause as { readonly completeLost?: unknown } | null)?.completeLost === true) {
          ledger.lost.push(
            unsettledOf(spec.target, spec.store, "completeLost", spec.key, undefined, error),
          )
        }
      }),
    ),
  )

const memoOf = (ledger: Ledger, store: BlobStoreService): Map<string, Memo> => {
  let byStore = ledger.memo.get(store)
  if (byStore === undefined) {
    byStore = new Map()
    ledger.memo.set(store, byStore)
  }
  return byStore
}

/**
 * Run `start` once per `memoKey` in the ledger, at the store's write
 * concurrency: a later call with the same key reuses its pointer — unless
 * that upload is too old to commit any more and nothing committed it, when
 * a fresh one runs (the old one is deleted at exit). A failed upload is
 * forgotten, so a retry runs it again.
 */
const withMemo = (
  ledger: Ledger,
  spec: UploadSpec,
  memoKey: string,
  start: () => Effect.Effect<Uploaded, UploadError>,
): Effect.Effect<BlobPointer, UploadError> => {
  const byStore = memoOf(ledger, spec.store)
  const hit = byStore.get(memoKey)
  if (hit !== undefined) {
    return Effect.flatMap(Deferred.await(hit.deferred), ({ entry, pointer }) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const stale =
          RANK[entry.state] < RANK.inDoubt &&
          now - entry.startedAt > Duration.toMillis(entry.store.maxUploadAge)
        if (!stale) return Effect.succeed(pointer)
        if (byStore.get(memoKey) === hit) byStore.delete(memoKey)
        return upload(spec)
      }),
    )
  }
  const memo: Memo = { deferred: Deferred.makeUnsafe<Uploaded, UploadError>() }
  byStore.set(memoKey, memo)
  return permitsOf(ledger, spec.store)
    .withPermit(Effect.suspend(start))
    .pipe(
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit) && byStore.get(memoKey) === memo) byStore.delete(memoKey)
        return Deferred.done(memo.deferred, exit)
      }),
      Effect.map(({ pointer }) => pointer),
    )
}

const ZERO_CHECKSUM: BlobChecksum = { algorithm: "crc64nvme", value: new Uint8Array(8) }

const metadataOf = (spec: UploadSpec, checksum: BlobChecksum): Readonly<Record<string, string>> =>
  typeof spec.metadata === "function" ? spec.metadata(checksum) : spec.metadata

/** Buffered content: the bytes, or the JSON text (compressed into `spec.body`). */
const bufferedUpload = (
  ledger: Ledger,
  spec: UploadSpec,
  ledgerContent: LedgerContent,
): Effect.Effect<BlobPointer, UploadError> => {
  const kind: BlobPointerKind = ledgerContent.kind
  const content =
    ledgerContent.kind === "json" ? encoder.encode(ledgerContent.text) : ledgerContent.bytes
  if (kind === "bytes" && spec.codec !== "none") {
    return Effect.die(new Error("BlobLedger: a bytes value is never compressed"))
  }
  const body = spec.body ?? content
  if (spec.codec === "none" && body.length !== content.length) {
    return Effect.die(new Error("BlobLedger: an uncompressed object's body is its content"))
  }
  const checksum: BlobChecksum = { algorithm: "crc64nvme", value: crc64nvme(content) }
  const memoKey = [spec.key, hexOf(checksum.value), content.length, kind, spec.contentType].join(
    "\u0000",
  )
  const ctx = ctxOf(spec.target)
  return withMemo(ledger, spec, memoKey, () => {
    const metadata = metadataOf(spec, checksum)
    const bodyChecksum: BlobChecksum =
      body === content ? checksum : { algorithm: "crc64nvme", value: crc64nvme(body) }
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const result = yield* restore(
          putCall(ledger, spec, ctx, {
            key: spec.key,
            body,
            contentLength: body.length,
            checksum: Effect.succeed(bodyChecksum),
            contentType: spec.contentType,
            metadata,
          }),
        )
        const uploaded = yield* record(ledger, spec, ctx, {
          action: "put",
          startedAt,
          result,
          kind,
          objectSize: body.length,
          contentSize: content.length,
          checksum,
        })
        ledger.cache.set(refKey(uploaded.entry.ref), ledgerContent)
        return uploaded
      }),
    )
  })
}

const sourceFailed = (cause: unknown): BlobSourceFailure =>
  new BlobStoreFailure({ reason: "SourceFailed", cause }) as BlobSourceFailure

/**
 * Upload a stream of bytes with a `put`: the body handed to the store is the
 * stream tapped with the incremental CRC-64/NVME and its length counted
 * (checked against `contentLength`, when given); `request.checksum` resolves
 * when it ends. Its failure is `SourceFailed`.
 */
const streamedPut = (
  ledger: Ledger,
  spec: UploadSpec,
  ctx: BlobCallContext,
  stream: Stream.Stream<Uint8Array, unknown>,
  contentLength: number | undefined,
): Effect.Effect<Uploaded, BlobStoreError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const hasher = makeCrc64nvme()
      let size = 0
      let ended = false
      const checksum = Deferred.makeUnsafe<BlobChecksum>()
      const body: Stream.Stream<Uint8Array, BlobSourceFailure> = stream.pipe(
        Stream.mapError((cause) => sourceFailed(cause)),
        Stream.mapEffect((chunk: unknown) => {
          if (!(chunk instanceof Uint8Array)) {
            return Effect.fail(
              sourceFailed(new Error("the stream emitted a chunk that is not a Uint8Array")),
            )
          }
          size += chunk.length
          if (contentLength !== undefined && size > contentLength) {
            return Effect.fail(
              sourceFailed(
                new Error(`the stream gave more bytes than its contentLength of ${contentLength}`),
              ),
            )
          }
          hasher.update(chunk)
          return Effect.succeed(chunk)
        }),
        Stream.onEnd(
          Effect.suspend(() => {
            if (contentLength !== undefined && size !== contentLength) {
              return Effect.fail(
                sourceFailed(
                  new Error(
                    `the stream gave ${size} bytes, but its contentLength is ${contentLength}`,
                  ),
                ),
              )
            }
            ended = true
            const value: BlobChecksum = { algorithm: "crc64nvme", value: hasher.digest() }
            return Deferred.succeed(checksum, value)
          }),
        ),
      )
      const startedAt = yield* Clock.currentTimeMillis
      const result = yield* restore(
        putCall(ledger, spec, ctx, {
          key: spec.key,
          body,
          contentLength,
          checksum: Deferred.await(checksum),
          contentType: spec.contentType,
          metadata: metadataOf(spec, ZERO_CHECKSUM),
        }),
      )
      return yield* record(ledger, spec, ctx, {
        action: "put",
        startedAt,
        result,
        kind: "bytes",
        objectSize: size,
        contentSize: size,
        checksum: ended ? yield* Deferred.await(checksum) : ZERO_CHECKSUM,
        problem: ended ? undefined : "the store's put succeeded before its body ended",
      })
    }),
  )

/** Who consumed a stream: single use (design §3.8). */
interface StreamUse {
  readonly ledger: Ledger
  readonly store: BlobStoreService
  readonly key: string
  readonly memo: Memo
  failed: boolean
}

const streamUses = new WeakMap<object, StreamUse>()

/**
 * Why a stream cannot be uploaded to `key` of `store` in `ledger`, or
 * `undefined` when it can (its first use, or the same upload again: a
 * re-planned or retried request reuses its pointer). A stream is consumed
 * once, for one target object: never for a second object, by a later
 * operation, or again after its upload failed.
 */
export const streamRefusal = (
  ledger: Ledger | undefined,
  identity: object,
  store: BlobStoreService,
  key: string,
): string | undefined => {
  const use = streamUses.get(identity)
  if (use === undefined) return undefined
  if (use.ledger === ledger && use.store === store && use.key === key) {
    return use.failed ? "its upload failed, and a consumed stream is never replayed" : undefined
  }
  return use.ledger === ledger
    ? "it is already the content of another value of this operation"
    : "an earlier operation already consumed it"
}

/** The `[EDD-9120]` refusal of a stream {@link streamRefusal} refused. */
export const singleUseError = (
  entityType: string,
  operation: string,
  attribute: string,
  why: string,
): ValidationError =>
  unusable(
    entityType,
    operation,
    `the Stream given for attribute "${attribute}" is single-use, and ${why}. Give each ` +
      "value its own Stream (or its bytes, a BlobHandle, or Offload.source(...)).",
  )

const streamUpload = (
  ledger: Ledger,
  spec: UploadSpec,
  content: StreamContent,
): Effect.Effect<BlobPointer, UploadError> => {
  const why = streamRefusal(ledger, content.identity, spec.store, spec.key)
  if (why !== undefined) {
    return Effect.fail(
      singleUseError(spec.target.entityType, spec.target.operation, spec.target.attribute, why),
    )
  }
  const known = streamUses.get(content.identity)
  if (known !== undefined) {
    // The same upload again: its pointer (a stale one is refused at the
    // choke point with `Expired` — a consumed stream is never re-run).
    return Effect.map(Deferred.await(known.memo.deferred), ({ pointer }) => pointer)
  }
  const use: StreamUse = {
    ledger,
    store: spec.store,
    key: spec.key,
    memo: { deferred: Deferred.makeUnsafe<Uploaded, UploadError>() },
    failed: false,
  }
  streamUses.set(content.identity, use)
  const ctx = ctxOf(spec.target)
  return permitsOf(ledger, spec.store)
    .withPermit(streamedPut(ledger, spec, ctx, content.stream, content.contentLength))
    .pipe(
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit)) use.failed = true
        return Deferred.done(use.memo.deferred, exit)
      }),
      Effect.map(({ pointer }) => pointer),
    )
}

/**
 * A handle's content as a new version under `spec.key`: the store's `copy`
 * when the handle reads from this store (its checksum is the source's), else
 * its content streamed into a `put`. Never the handle's own version — even
 * when it is the field's current one.
 */
const copyUpload = (
  ledger: Ledger,
  spec: UploadSpec,
  content: CopyContent,
): Effect.Effect<BlobPointer, UploadError> => {
  const { handle } = content
  const source = Option.getOrUndefined(handle.ref)
  const copy = spec.store.copy
  const viaCopy = copy !== undefined && source !== undefined && handleStoreOf(handle) === spec.store
  const memoKey = [
    "copy",
    spec.key,
    source === undefined ? `inline:${hexOf(handle.checksum.value)}` : refKey(source),
    handle.size,
    spec.contentType,
  ].join("\u0000")
  const ctx = ctxOf(spec.target)
  return withMemo(ledger, spec, memoKey, () => {
    if (!viaCopy) {
      return streamedPut(
        ledger,
        spec,
        ctx,
        Stream.suspend(() => handle.stream()),
        handle.size,
      )
    }
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const result = yield* restore(
          call(spec.store, "copy", ctx, { key: spec.key, ref: source }, () =>
            copy(source, {
              key: spec.key,
              contentLength: handle.size,
              contentType: spec.contentType,
              metadata: metadataOf(spec, handle.checksum),
            }),
          ),
        )
        return yield* record(ledger, spec, ctx, {
          action: "copy",
          startedAt,
          result,
          kind: "bytes",
          objectSize: handle.size,
          contentSize: handle.size,
          checksum: handle.checksum,
          source,
        })
      }),
    )
  })
}

/**
 * Upload one value through the current ledger and return the pointer that
 * names it. The entry is `pending` until a request carrying the pointer
 * settles it. The same content for the same key and store in one ledger
 * uploads once (an upload older than the store's `maxUploadAge` that no
 * request committed is not reused); a stream uploads at most once, for one
 * key (`[EDD-9120]` otherwise). Uploads run at the store's
 * `writeConcurrency` per ledger.
 *
 * Dies when no ledger is open: every write path runs under a root.
 */
export const upload: {
  /** Buffered content never fails with a `ValidationError`. */
  (
    spec: UploadSpec & { readonly content: LedgerContent },
  ): Effect.Effect<BlobPointer, BlobStoreError>
  (spec: UploadSpec): Effect.Effect<BlobPointer, UploadError>
} = (spec: UploadSpec): Effect.Effect<BlobPointer, any> =>
  Effect.withFiber((fiber) => {
    const ledger = fiber.getRef(CurrentLedger)
    if (ledger === undefined || ledger.closed) {
      return Effect.die(
        new Error(
          `BlobLedger: an upload of ${spec.target.entityType} attribute "${spec.target.attribute}" ` +
            "ran outside a ledger root. This is a defect in effect-dynamodb.",
        ),
      )
    }
    const content = spec.content
    switch (content.kind) {
      case "stream":
        return streamUpload(ledger, spec, content)
      case "copy":
        return copyUpload(ledger, spec, content)
      default:
        return bufferedUpload(ledger, spec, content)
    }
  })

// ---------------------------------------------------------------------------
// Settling at the choke point
// ---------------------------------------------------------------------------

/**
 * The write commands a ledger settles. A PartiQL request is one too (`insert()`, design §6.2);
 * one that only reads (`SELECT`) carries no pointer to settle ({@link refsOfRequest}).
 */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "PutItem",
  "UpdateItem",
  "DeleteItem",
  "BatchWriteItem",
  "TransactWriteItems",
  "ExecuteStatement",
  "ExecuteTransaction",
])

/** The ledger a request of `command` settles: an open one with entries, for a write. */
export const settling = (ledger: Ledger | undefined, command: string): Ledger | undefined =>
  ledger !== undefined && !ledger.closed && ledger.entries.size > 0 && WRITE_COMMANDS.has(command)
    ? ledger
    : undefined

type Item = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

/** Collect the refs of every pointer in an `AttributeValue`, at any depth. */
const visitValue = (value: unknown, out: Set<string>): void => {
  if (!isObject(value)) return
  const b = value.B
  if (b instanceof Uint8Array) {
    if (b.length > 0 && isPointerHeader(b[0]!)) {
      const pointer = decodePointer(b)
      if (typeof pointer !== "string") out.add(refKey(pointer.ref))
    }
    return
  }
  const s = value.S
  if (typeof s === "string") {
    if (isPointerText(s)) {
      const pointer = decodePointerText(s)
      if (pointer !== undefined && typeof pointer !== "string") out.add(refKey(pointer.ref))
    }
    return
  }
  const m = value.M
  if (isObject(m)) {
    for (const key in m) visitValue(m[key], out)
    return
  }
  const l = value.L
  if (Array.isArray(l)) for (const element of l) visitValue(element, out)
}

const visitItem = (item: unknown, out: Set<string>): void => {
  if (!isObject(item)) return
  for (const key in item) visitValue(item[key], out)
}

/**
 * The first attribute of a marshalled row that holds a well-formed blob pointer, in either stored
 * form and at any depth, whatever its member now declares; `undefined` when none does. Rekey's
 * backstop (design §11.10): a row holding one must never move.
 */
export const pointerAttributeOf = (item: unknown): string | undefined => {
  if (!isObject(item)) return undefined
  for (const key in item) {
    const out = new Set<string>()
    visitValue(item[key], out)
    if (out.size > 0) return key
  }
  return undefined
}

/** The refs of every pointer an item (a marshalled image) holds. */
export const refsOfItem = (item: unknown): Set<string> => {
  const out = new Set<string>()
  visitItem(item, out)
  return out
}

const isSelect = (statement: unknown): boolean =>
  typeof statement === "string" && /^\s*SELECT\b/i.test(statement)

/** A PartiQL statement's parameters (`AttributeValue`s), unless it only reads. */
const visitStatement = (entry: unknown, out: Set<string>): void => {
  if (!isObject(entry) || isSelect(entry.Statement)) return
  const parameters = entry.Parameters
  if (Array.isArray(parameters)) for (const parameter of parameters) visitValue(parameter, out)
}

const IF_NOT_EXISTS = /if_not_exists\s*\(\s*[^,()]*,\s*(:[A-Za-z0-9_]+)\s*\)/g

/** The refs a request carries, and (UpdateItem) those it writes under `if_not_exists`. */
const refsOfRequest = (
  command: string,
  input: Item,
): { readonly all: Set<string>; readonly conditional: Set<string> } => {
  const all = new Set<string>()
  const conditional = new Set<string>()
  switch (command) {
    case "PutItem":
      visitItem(input.Item, all)
      visitItem(input.ExpressionAttributeValues, all)
      break
    case "UpdateItem": {
      const values = input.ExpressionAttributeValues
      visitItem(values, all)
      const expression = input.UpdateExpression
      if (typeof expression === "string" && isObject(values)) {
        for (const match of expression.matchAll(IF_NOT_EXISTS)) {
          visitValue(values[match[1]!], conditional)
        }
      }
      break
    }
    case "DeleteItem":
      visitItem(input.ExpressionAttributeValues, all)
      break
    case "BatchWriteItem":
      visitBatch(input.RequestItems, all)
      break
    case "TransactWriteItems": {
      const items = input.TransactItems
      if (Array.isArray(items)) {
        for (const transactItem of items) {
          if (!isObject(transactItem)) continue
          for (const part of Object.values(transactItem)) {
            if (!isObject(part)) continue
            visitItem(part.Item, all)
            visitItem(part.ExpressionAttributeValues, all)
          }
        }
      }
      break
    }
    case "ExecuteStatement":
      visitStatement(input, all)
      break
    case "ExecuteTransaction": {
      const statements = input.TransactStatements
      if (Array.isArray(statements)) for (const entry of statements) visitStatement(entry, all)
      break
    }
  }
  return { all, conditional }
}

/** `RequestItems` / `UnprocessedItems`: each put request's item. */
const forEachPut = (requestItems: unknown, f: (item: unknown) => void): void => {
  if (!isObject(requestItems)) return
  for (const table in requestItems) {
    const requests = requestItems[table]
    if (!Array.isArray(requests)) continue
    for (const request of requests) {
      if (isObject(request) && isObject(request.PutRequest)) f(request.PutRequest.Item)
    }
  }
}

/** `RequestItems` / `UnprocessedItems`: the refs of the put requests' items. */
const visitBatch = (requestItems: unknown, out: Set<string>): void =>
  forEachPut(requestItems, (item) => visitItem(item, out))

/** `RequestItems` / `UnprocessedItems`: per ref, how many put requests carry it. */
const requestsPerRef = (requestItems: unknown): Map<string, number> => {
  const counts = new Map<string, number>()
  forEachPut(requestItems, (item) => {
    for (const key of refsOfItem(item)) counts.set(key, (counts.get(key) ?? 0) + 1)
  })
  return counts
}

/** The entries a request carries. */
interface Carried {
  readonly entries: ReadonlyArray<LedgerEntry>
  /** UpdateItem: the entries it writes under `if_not_exists`. */
  readonly conditional: ReadonlySet<LedgerEntry>
}

const carriedBy = (ledger: Ledger, command: string, input: Item): Carried | undefined => {
  const refs = refsOfRequest(command, input)
  const entries: Array<LedgerEntry> = []
  const conditional = new Set<LedgerEntry>()
  for (const key of refs.all) {
    const entry = ledger.entries.get(key)
    if (entry === undefined) continue
    entries.push(entry)
    if (refs.conditional.has(key)) conditional.add(entry)
  }
  return entries.length === 0 ? undefined : { entries, conditional }
}

/** A fresh `ClientRequestToken`: 128 random bits from the platform's Web Crypto, as hex. */
const makeToken = (): string =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")

const SINGLE_ITEM: ReadonlySet<string> = new Set(["PutItem", "UpdateItem", "DeleteItem"])

/** The transactions whose `ClientRequestToken` the SDK models as an idempotency token. */
const TRANSACTIONS: ReadonlySet<string> = new Set(["TransactWriteItems", "ExecuteTransaction"])

/**
 * The request as sent: a `TransactWriteItems` or `ExecuteTransaction` carries
 * the library's own `ClientRequestToken` (fresh per request, so a resend of
 * this request object is idempotent and a cancellation proves it did not
 * commit), a single-item
 * write asks for `ALL_OLD` on a failed condition (the evidence a
 * `ConditionalCheckFailed` is settled by). A field the caller set is kept.
 */
const prepare = (ledger: Ledger, command: string, input: Item): Item => {
  if (TRANSACTIONS.has(command) && input.ClientRequestToken === undefined) {
    const token = makeToken()
    ledger.tokens.add(token)
    return { ...input, ClientRequestToken: token }
  }
  if (SINGLE_ITEM.has(command) && input.ReturnValuesOnConditionCheckFailure === undefined) {
    return { ...input, ReturnValuesOnConditionCheckFailure: "ALL_OLD" }
  }
  return input
}

const raise = (entry: LedgerEntry, state: EntryState): void => {
  if (RANK[state] > RANK[entry.state]) entry.state = state
}

/** The SDK error a client failure carries: its `cause`, or the failure itself. */
const sdkErrorOf = (error: unknown): Item | undefined => {
  const cause = isObject(error) ? error.cause : undefined
  if (isObject(cause) && typeof cause.name === "string") return cause
  return isObject(error) ? error : undefined
}

/** The library's tagged client errors, by the SDK exception each one wraps. */
const TAG_NAMES: Readonly<Record<string, string>> = {
  ThrottlingError: "ThrottlingException",
  DynamoValidationError: "ValidationException",
  ResourceNotFoundError: "ResourceNotFoundException",
  InternalServerError: "InternalServerError",
}

/** The SDK exception name of a client failure. */
export const errorName = (error: unknown): string | undefined => {
  const sdk = sdkErrorOf(error)
  if (sdk !== undefined && sdk !== error && typeof sdk.name === "string") return sdk.name
  const tag = isObject(error) ? error._tag : undefined
  if (typeof tag === "string" && TAG_NAMES[tag] !== undefined) return TAG_NAMES[tag]
  const name = isObject(error) ? error.name : undefined
  return typeof name === "string" ? name : undefined
}

const attemptsIn = (value: unknown): number | undefined => {
  const metadata = isObject(value) ? value.$metadata : undefined
  const attempts = isObject(metadata) ? metadata.attempts : undefined
  return typeof attempts === "number" ? attempts : undefined
}

/** `$metadata.attempts` of a client failure (on the SDK error it wraps), if reported. */
export const attemptsOf = (error: unknown): number | undefined =>
  attemptsIn(sdkErrorOf(error)) ?? attemptsIn(error)

const THROTTLING = [
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
]

/** Refusals of a single-item write: rejected when the SDK sent the request once. */
const SINGLE_REFUSALS: ReadonlySet<string> = new Set([
  "ValidationException",
  "ResourceNotFoundException",
  "ItemCollectionSizeLimitExceededException",
  ...THROTTLING,
  "TransactionConflictException",
  "AccessDeniedException",
])

/**
 * Refusals of a PartiQL `ExecuteStatement`: rejected when the SDK sent it once. An `INSERT` is
 * not idempotent, so `DuplicateItemException` after a resend may be refusing the item the first
 * attempt wrote: it proves non-commit only for a statement sent once.
 */
const STATEMENT_REFUSALS: ReadonlySet<string> = new Set([
  ...SINGLE_REFUSALS,
  "DuplicateItemException",
  // DynamoDB Local's name for it (`isAwsDuplicateItem`).
  "DuplicateItem",
  "ConditionalCheckFailedException",
])

/** A transaction carrying a token: refused outright, so never committed. */
const TRANSACT_REJECTED: ReadonlySet<string> = new Set([
  "TransactionCanceledException",
  "ValidationException",
  "ConditionalCheckFailedException",
])

/** A `TransactWriteItems` whose token DynamoDB did not let decide: in doubt. */
const TRANSACT_IN_DOUBT: ReadonlySet<string> = new Set([
  "IdempotentParameterMismatchException",
  "TransactionInProgressException",
])

/**
 * Whole-request refusals of a `TransactWriteItems` / `BatchWriteItem`: DynamoDB
 * applies nothing of a request it refuses, so one sent once was not committed.
 */
const REQUEST_REFUSALS: ReadonlySet<string> = new Set([
  "ValidationException",
  "ResourceNotFoundException",
  ...THROTTLING,
  "AccessDeniedException",
])

/**
 * Where each entry a request carried moves by the request's outcome (design
 * §6.2's table); `undefined` leaves them as they are (a request never sent).
 */
const outcomeOf = (
  ledger: Ledger,
  command: string,
  sent: Item,
  carried: Carried,
  exit: Exit.Exit<unknown, unknown>,
  isNotSent: (error: unknown) => boolean,
): ((entry: LedgerEntry) => EntryState) | undefined => {
  const every = (state: EntryState) => (): EntryState => state
  if (Exit.isSuccess(exit)) {
    const output = isObject(exit.value) ? exit.value : undefined
    if (command === "BatchWriteItem") {
      // Per ref, not per request: `UnprocessedItems` holds copies of the
      // requests it left, so a ref is committed when more requests carried it
      // than were left — some processed request wrote it.
      const carrying = requestsPerRef(sent.RequestItems)
      const unprocessed = requestsPerRef(output?.UnprocessedItems)
      // Only in unprocessed requests: rejected only when the SDK sent this request once.
      const left: EntryState = attemptsIn(output) === 1 ? "rejected" : "inDoubt"
      return (entry) => {
        const key = refKey(entry.ref)
        const leftIn = unprocessed.get(key) ?? 0
        return leftIn === 0 || (carrying.get(key) ?? 0) > leftIn ? "committed" : left
      }
    }
    if (command === "UpdateItem" && carried.conditional.size > 0) {
      const returnValues = sent.ReturnValues
      const kept =
        (returnValues === "ALL_NEW" || returnValues === "UPDATED_NEW") &&
        isObject(output?.Attributes)
          ? refsOfItem(output.Attributes)
          : undefined
      return (entry) =>
        !carried.conditional.has(entry)
          ? "committed"
          : kept === undefined
            ? "inDoubt"
            : kept.has(refKey(entry.ref))
              ? "committed"
              : "rejected"
    }
    return every("committed")
  }
  const failure = Cause.findErrorOption(exit.cause)
  // Interrupted in flight, or a defect: the request may have reached DynamoDB.
  if (Option.isNone(failure)) return every("inDoubt")
  const error = failure.value
  if (isNotSent(error)) return undefined
  const name = errorName(error)
  const once = attemptsOf(error) === 1
  const refusedOnce = (refusals: ReadonlySet<string>): EntryState =>
    name !== undefined && refusals.has(name) && once ? "rejected" : "inDoubt"
  if (TRANSACTIONS.has(command)) {
    if (name !== undefined && TRANSACT_REJECTED.has(name)) {
      // Only the library's own token proves it: a resend of this request
      // object is idempotent, so a cancellation means no attempt committed.
      const token = sent.ClientRequestToken
      return every(typeof token === "string" && ledger.tokens.has(token) ? "rejected" : "inDoubt")
    }
    if (name !== undefined && TRANSACT_IN_DOUBT.has(name)) return every("inDoubt")
    return every(refusedOnce(REQUEST_REFUSALS))
  }
  if (command === "BatchWriteItem") return every(refusedOnce(REQUEST_REFUSALS))
  if (command === "ExecuteStatement") return every(refusedOnce(STATEMENT_REFUSALS))
  if (name === "ConditionalCheckFailedException") {
    // The evidence: the row as stored, returned because the request asked.
    if (sent.ReturnValuesOnConditionCheckFailure !== "ALL_OLD") return every("inDoubt")
    const held = refsOfItem(sdkErrorOf(error)?.Item)
    return (entry) =>
      held.has(refKey(entry.ref))
        ? "committed"
        : entry.target.copiesPointers
          ? "inDoubt"
          : "rejected"
  }
  return every(refusedOnce(SINGLE_REFUSALS))
}

/** Settle what a request carried by its outcome. */
const settle = (
  ledger: Ledger,
  command: string,
  sent: Item,
  carried: Carried,
  exit: Exit.Exit<unknown, unknown>,
  isNotSent: (error: unknown) => boolean,
): void => {
  const next = outcomeOf(ledger, command, sent, carried, exit, isNotSent)
  if (next === undefined) return
  for (const entry of carried.entries) raise(entry, next(entry))
}

const expiredError = (entry: LedgerEntry, now: number): BlobStoreError =>
  blobError(
    ctxOf(entry.target),
    "put",
    "Expired",
    entry.ref,
    `the upload started ${Duration.format(Duration.millis(now - entry.startedAt))} ago, over the ` +
      `store's maxUploadAge (${Duration.format(entry.store.maxUploadAge)}); nothing was written ` +
      "to DynamoDB",
  )

/**
 * Send one write request of a ledger with entries (`send` is the choke
 * point's own sending): refuse it with `Expired` when it carries an upload
 * older than its store's `maxUploadAge`, prepare it ({@link prepare}), and
 * settle the entries it carries by its outcome. A request carrying none of
 * the ledger's uploads is sent unchanged.
 */
export const guard = <A, E, R>(
  ledger: Ledger,
  command: string,
  input: Item,
  send: (input: Item) => Effect.Effect<A, E, R>,
  isNotSent: (error: unknown) => boolean,
): Effect.Effect<A, E | BlobStoreError, R> =>
  Effect.suspend((): Effect.Effect<A, E | BlobStoreError, R> => {
    const carried = carriedBy(ledger, command, input)
    if (carried === undefined) return send(input)
    return Effect.flatMap(
      Clock.currentTimeMillis,
      (now): Effect.Effect<A, E | BlobStoreError, R> => {
        const expired = carried.entries.find(
          (entry) => now - entry.startedAt > Duration.toMillis(entry.store.maxUploadAge),
        )
        if (expired !== undefined) return Effect.fail(expiredError(expired, now))
        const sent = prepare(ledger, command, input)
        return send(sent).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() =>
              settle(
                ledger,
                command,
                sent,
                carried,
                exit as Exit.Exit<unknown, unknown>,
                isNotSent,
              ),
            ),
          ),
        )
      },
    )
  })

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

const MESSAGES: Readonly<Record<UnsettledReason, string>> = {
  inDoubt:
    "the outcome of the DynamoDB write that carried it is unknown, so its object version is " +
    "kept; queue the item for gc.sweep",
  rollbackFailed:
    "DynamoDB did not commit the write that carried it, but deleting its object version " +
    "failed; the version is left for gc.sweep",
  completeLost:
    "its multipart upload completed but the response was lost, so the version it made has no " +
    "pointer; it is left for gc.sweep",
  answerRefused:
    "the store's answer to it broke the BlobStore contract and was refused, so the version it " +
    "wrote, if any, has no pointer; it is left for gc.sweep",
}

const unsettledOf = (
  target: UploadTarget,
  store: BlobStoreService,
  reason: UnsettledReason,
  key: string,
  ref: BlobRef | undefined,
  cause: unknown,
): UnsettledUpload => ({
  reason,
  table: target.table,
  entityType: target.entityType,
  attribute: target.attribute,
  operation: target.operation,
  rowKey: target.rowKey,
  key,
  ref,
  store: store.name,
  ...(cause !== undefined && { cause }),
})

/** Log an unsettled upload at `Warning` and deliver it to the observer, if any. */
const report = (upload: UnsettledUpload): Effect.Effect<void> =>
  Effect.withFiber((fiber) => {
    const observer = fiber.getRef(Observer)
    const logged = Effect.logWarning(
      `effect-dynamodb: an upload of ${upload.entityType} attribute "${upload.attribute}" ` +
        `(${upload.operation}) could not be settled: ${MESSAGES[upload.reason]}`,
      ...(upload.cause === undefined ? [] : [upload.cause]),
    ).pipe(
      Effect.annotateLogs({
        table: upload.table,
        entityType: upload.entityType,
        attribute: upload.attribute,
        operation: upload.operation,
        rowKey: upload.rowKey,
        objectKey: upload.key,
        ...(upload.ref !== undefined &&
          upload.ref.version !== "" && { version: upload.ref.version }),
        store: upload.store,
      }),
    )
    if (observer === undefined) return logged
    return Effect.andThen(
      logged,
      Effect.suspend(() => observer.onUnsettled(upload)).pipe(
        Effect.exit,
        Effect.flatMap((observed) =>
          Exit.isFailure(observed) && !Cause.hasInterruptsOnly(observed.cause)
            ? Effect.logWarning(
                "effect-dynamodb: the Offload observer failed; the unsettled upload was not delivered",
                observed.cause,
              )
            : Effect.void,
        ),
      ),
    )
  })

const deleteContext = (entries: ReadonlyArray<LedgerEntry>): BlobCallContext => {
  const first = entries[0]!.target
  const same = (pick: (t: UploadTarget) => string) =>
    entries.every((entry) => pick(entry.target) === pick(first))
  return {
    entityType: same((t) => t.entityType) ? first.entityType : "(several)",
    attribute: same((t) => t.attribute) ? first.attribute : "(several)",
    operation: same((t) => t.operation) ? first.operation : "(several)",
  }
}

/** Close a root's ledger: roll back what DynamoDB did not commit, report what is unsettled. */
const close = (ledger: Ledger): Effect.Effect<void> =>
  Effect.suspend(() => {
    ledger.closed = true
    if (ledger.entries.size === 0 && ledger.lost.length === 0) return Effect.void
    const rollback = new Map<BlobStoreService, Array<LedgerEntry>>()
    const inDoubt: Array<LedgerEntry> = []
    for (const entry of ledger.entries.values()) {
      if (entry.state === "pending" || entry.state === "rejected") {
        const group = rollback.get(entry.store)
        if (group === undefined) rollback.set(entry.store, [entry])
        else group.push(entry)
      } else if (entry.state === "inDoubt") {
        inDoubt.push(entry)
      }
    }
    ledger.cache.clear()
    return Effect.gen(function* () {
      for (const [store, entries] of rollback) {
        const deleted = yield* Effect.exit(
          call(
            store,
            "delete",
            deleteContext(entries),
            { ref: entries.length === 1 ? entries[0]!.ref : undefined },
            () => store.delete(entries.map((entry) => entry.ref)),
          ),
        )
        if (Exit.isFailure(deleted)) {
          const cause = Cause.squash(deleted.cause)
          for (const entry of entries) {
            yield* report(
              unsettledOf(entry.target, store, "rollbackFailed", entry.ref.key, entry.ref, cause),
            )
          }
        }
      }
      for (const entry of inDoubt) {
        yield* report(
          unsettledOf(entry.target, entry.store, "inDoubt", entry.ref.key, entry.ref, undefined),
        )
      }
      for (const upload of ledger.lost) yield* report(upload)
    }).pipe(Effect.provideService(CurrentLedger, undefined))
  })
