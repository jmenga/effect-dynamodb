/**
 * EventStore — Typed, Effect-native event sourcing on DynamoDB.
 *
 * Provides:
 * - `Decider` type for command-event-state modeling
 * - `makeStream` factory for creating event streams bound to a Table
 * - Core operations: `append` (atomic), `read`, `readFrom`, `currentVersion`,
 *   `readLatest` (reads optionally strongly consistent)
 * - Snapshot primitives: `writeSnapshot`, `readSnapshot`, and inline snapshots
 *   written in the append transaction (`AppendOptions.snapshot`)
 * - `commandHandler` combinator for the load-decide-fold-append cycle
 *   (snapshot-aware single-request loads, consistent loads, an optional
 *   `VersionConflict` retry policy, caller-supplied `expectedVersion`,
 *   decision-derived `additionalItems`, inline snapshots)
 * - Stream indexes (`makeStream({ indexes })`): sub-streams ordered by a key
 *   derived from each event, on an LSI or GSI, each projecting all of the
 *   event, all but its metadata, or only its keys — `readIndex`,
 *   `query.index`, and `indexDefinitions` for the `CreateTable` fragments.
 *   A GSI may derive its partition too, so several streams share one
 *   partition of it, snapshots included (#149)
 * - `fold` / `foldFrom` helpers for state reconstruction
 * - Packed storage (`makeStream({ storedAs: { data } })`, `snapshot.storedAs`):
 *   event data and snapshot state as one JSON string, optionally compressed —
 *   read by the stored form, so a stream may mix native, JSON and compressed
 *   items; `measureAppend` / `measureSnapshot` for caller-side size planning,
 *   and `decodeStreamImage` for DynamoDB Streams records
 * - Change-feed projections (#151): `projection` folds a stream into a
 *   read-model entity in version order, filling gaps from the store instead of
 *   waiting for delivery (`applyBatch`, `apply`, `catchUp`, `rebuild`,
 *   `processBatch`, `bindProjection`), plus `decoder`, `eventFilterPattern`
 *   and `batchResponse` for the change feed itself
 *
 * Built on the existing library primitives (DynamoSchema, KeyComposer, Query,
 * DynamoClient, Marshaller).
 */

import type {
  AttributeDefinition,
  AttributeValue,
  GlobalSecondaryIndex,
  LocalSecondaryIndex,
  Projection,
} from "@aws-sdk/client-dynamodb"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import { isPackedConfig, type PackedConfig } from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { normalizeTtlSeconds } from "@effect-dynamodb/schema/Entity.js"
import {
  AdditionalItemConditionFailed,
  AppendTooLarge,
  type ConcurrentModification,
  DuplicateCommand,
  isAwsConditionalCheckFailed,
  isAwsTransactionCancelled,
  type OptimisticLockError,
  TransactionCancelled,
  type UniqueConstraintViolation,
  ValidationError,
  VersionConflict,
} from "@effect-dynamodb/schema/Errors.js"
import {
  isDispatchEligible,
  packedShape,
  packValue,
  unpackStoredSync,
} from "@effect-dynamodb/schema/internal/PackedCodec.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import {
  Context,
  DateTime,
  type Duration,
  Effect,
  Function,
  Option,
  Pipeable,
  Result,
  Schedule,
  Schema,
} from "effect"
import { DynamoClient, type DynamoClientError, type DynamoClientService } from "./DynamoClient.js"
import {
  type EventProjection,
  ProjectionDecode,
  type StreamRecord,
} from "./internal/EventProjection.js"
import { type Expr, eq } from "./internal/Expr.js"
import { itemBytes, transactItemBytes } from "./internal/ItemSize.js"
import {
  type CodecRequirement,
  codecRequirements,
  currentRegistry,
  decodeImage,
  imageEntityType,
  type PackedAttributeGuard,
  runtimeCodecCheck,
  type StreamImage,
  unregisteredCodecError,
  withRegistry,
} from "./internal/Packed.js"
import { createPathBuilder } from "./internal/PathBuilder.js"
import {
  type BuiltTransactWriteItems,
  buildTransactWriteItems,
  GUARDED_TRANSACTION_ATTEMPTS,
  judgeCancellation,
  type TransactItemTarget,
  type TransactWriteItem,
  type TransactWriteOp,
  transactItemTarget,
} from "./internal/TransactWriteOps.js"
import {
  type Diagnosis,
  diagnosedValidationError,
  diagnoseFailure,
  mergeKeyAttributes,
  withCause,
} from "./internal/WriteDiagnosis.js"
import { fromAttributeMap, toAttributeMap } from "./Marshaller.js"
import * as Query from "./Query.js"
import {
  DEFAULT_TTL_ATTRIBUTE_NAME,
  resolveTtlAttributeName,
  type Table,
  type TableConfig,
} from "./Table.js"

// ---------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------

/**
 * A Decider encodes the command-event-state triad for an aggregate.
 *
 * - `decide` — given a command and current state, produce events (or fail with E)
 * - `evolve` — left fold: apply one event to a state. It may return new state or
 *   mutate the given state in place and return it; the library requires
 *   neither. State the library persists, returns or projects is always this
 *   fold, never anything produced inside `decide`.
 * - `initialState` — starting state for a new aggregate. An `evolve` that
 *   mutates in place must not mutate a shared `initialState` object (declare it
 *   as a getter that returns a fresh value).
 */
export interface Decider<State, Command, Event, E = never> {
  readonly decide: (command: Command, state: State) => Effect.Effect<ReadonlyArray<Event>, E>
  readonly evolve: (state: State, event: Event) => State
  readonly initialState: State
}

// ---------------------------------------------------------------------------
// StreamEvent
// ---------------------------------------------------------------------------

/**
 * A persisted event read from a stream, enriched with stream metadata.
 *
 * @typeParam A - The decoded event type
 * @typeParam M - The decoded metadata type (defaults to an untyped record for
 *   streams without a metadata schema)
 */
export interface StreamEvent<A, M = Record<string, unknown> | undefined> {
  readonly streamId: string
  readonly version: number
  readonly eventType: string
  readonly data: A
  readonly metadata: M
  /**
   * ISO 8601 (UTC): when the event was appended, by the append's `Clock` — or
   * the `eventTimestamps` entry it was appended with
   * ({@link AppendOptionsBase.eventTimestamps}).
   */
  readonly timestamp: string
}

/**
 * A {@link StreamEvent} together with the event's stored `data` in its wire
 * form — what `decodeStreamImage(image, { raw: true })` returns.
 */
export interface RawStreamEvent<A, M = Record<string, unknown> | undefined>
  extends StreamEvent<A, M> {
  /**
   * The event's `data` as stored, before the event schema decoded it: the
   * parsed JSON of a packed `data` (`{ _tag, ...fields }`), or the unmarshalled
   * map of a native one — fields the event schema does not model included. The
   * same object the decode read, so nothing is parsed twice.
   */
  readonly rawData: Readonly<Record<string, unknown>>
}

/** Options of `decodeStreamImage`. */
export interface DecodeStreamImageOptions {
  /**
   * Also return the event's stored `data` in wire form (`rawData`, see
   * {@link RawStreamEvent}) — for a consumer that needs fields the event
   * schema does not model, without parsing the image a second time.
   */
  readonly raw?: boolean | undefined
}

/**
 * Metadata type carried on {@link StreamEvent} for a stream: the decoded
 * metadata schema type when the stream declares one, an untyped record
 * otherwise (events may carry metadata written outside the typed API).
 */
export type StreamMetadata<TMetadata> = [TMetadata] extends [undefined]
  ? Record<string, unknown> | undefined
  : TMetadata | undefined

// ---------------------------------------------------------------------------
// Envelope schema — validates the persisted event's system fields on read
// ---------------------------------------------------------------------------

/**
 * Schema for the persisted event envelope (system fields written by `append`).
 * Event `data` and `metadata` are decoded separately through their own schemas.
 *
 * @internal
 */
/** The codecs a stream's packed `data` / `state` name (`[EDD-9078]` when unregistered). */
const streamCodecRequirements = (
  streamName: string,
  storedAs: { readonly data?: PackedConfig | undefined; readonly state?: PackedConfig | undefined },
): Array<CodecRequirement> =>
  codecRequirements(`stream "${streamName}"`, [
    ["data", storedAs.data],
    ["state", storedAs.state],
  ])

/** The attributes a stream image reads by stored form: event `data` only. */
const DATA_ATTRIBUTES: ReadonlyArray<string> = ["data"]

const EventEnvelope = Schema.Struct({
  streamId: Schema.String,
  version: Schema.Number,
  eventType: Schema.String,
  timestamp: Schema.String,
})

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result of appending events to a stream. */
export interface AppendResult<A> {
  readonly version: number
  readonly events: ReadonlyArray<A>
}

/** Result of a command handler execution. */
export interface CommandHandlerResult<State, Event> extends AppendResult<Event> {
  readonly state: State
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * A persisted fold of a stream, up to and including `asOfVersion`.
 *
 * Snapshots are a cache, never history — there is exactly one per stream and it
 * is overwritten in place. The event stream remains the source of truth, so a
 * snapshot can always be discarded and rebuilt.
 */
export interface Snapshot<State> {
  readonly state: State
  readonly asOfVersion: number
  readonly timestamp: string
}

/**
 * Snapshot configuration accepted by {@link makeStream}.
 *
 * - `schema` — the state codec. Snapshot state round-trips through it
 *   (`Schema.encodeUnknownEffect` on write, `Schema.decodeUnknownEffect` on
 *   read), so transforming schemas work.
 * - `mode` — how {@link commandHandler} writes snapshots (see
 *   {@link SnapshotMode}). Default `"after-append"`.
 * - `every` — optional snapshot cadence for {@link commandHandler}: write a
 *   fresh snapshot once at least this many events have accumulated since the
 *   last one. Must be a positive integer. With `mode: "after-append"` and no
 *   `every`, the handler never snapshots; with `mode: "inline"` and no `every`,
 *   it snapshots on every append.
 *
 * `every` also sizes the first page of {@link EventStream.readLatest}, which
 * {@link commandHandler} loads state with: a snapshot that lags the head by up
 * to `every` events still loads in one request. The first page is read whatever
 * the actual lag, so every load reads up to `every + 1` items (`2` without
 * `every`), including events the snapshot already covers, which are discarded.
 * For an `"after-append"` stream that trades read capacity for requests: with
 * `every: 100` and a snapshot one event behind, a load reads the snapshot and
 * 100 events in one request, where a `GetItem` plus `readFrom` would read the
 * snapshot and one event in two. Size `every` with that in mind, or use
 * `mode: "inline"`, which keeps the snapshot current so the page stays small.
 */
export interface SnapshotConfig<TSchema extends Schema.Top = Schema.Top> {
  /**
   * The state schema. Snapshot state is encoded through it, falling back to
   * `decode → encode` (as events are) for a value not already in its type
   * shape — so a `Schema.Class` state folded by an immutable `evolve` that
   * spreads (`({ ...s, balance })`, a plain object) still encodes.
   */
  readonly schema: TSchema
  readonly mode?: SnapshotMode | undefined
  readonly every?: number | undefined
  /**
   * How the snapshot's `state` is stored: a native map (omitted, the default)
   * or packed — `DynamoModel.Packed({ format: "json", compression? })`, one
   * JSON string, compressed to binary at or over the threshold when that is
   * smaller. Packing shrinks a large state the most: an inline snapshot rides
   * in every append's transaction, and DynamoDB's item and transaction size
   * limits count its **stored** bytes.
   *
   * The state schema's encoded side must be object- or array-shaped
   * (`[EDD-9073]`). Reads go by the stored form, so changing this setting
   * needs no rewrite: a snapshot written before still decodes.
   */
  readonly storedAs?: PackedConfig | undefined
}

/**
 * How a stream stores event `data` (`makeStream({ storedAs })`). `data` is a
 * native map by default; `DynamoModel.Packed({ format: "json", compression? })`
 * stores it as one JSON string (`S`), compressed to binary (`B`) at or over the
 * threshold when that is smaller. Metadata always stays a map.
 *
 * Reads go by each item's stored form, never by this setting, so a stream may
 * hold a mix — events appended before packing was turned on still decode, and
 * so do packed events after it is turned off.
 */
export interface StreamStorageConfig {
  readonly data?: PackedConfig | undefined
}

/** The resolved storage settings exposed on a stream (`stream.storedAs`). */
export interface StreamStorageSettings {
  /** Event `data` (`makeStream({ storedAs: { data } })`); `undefined` = native map. */
  readonly data: PackedConfig | undefined
  /** Snapshot `state` (`snapshot.storedAs`); `undefined` = native map. */
  readonly state: PackedConfig | undefined
}

/**
 * The bytes an {@link EventStream.append} would write, by DynamoDB's own size
 * accounting — {@link EventStream.measureAppend}. Every number counts stored
 * bytes: packed (and compressed) `data` and `state` as they would be sent.
 */
export interface AppendMeasurement {
  /**
   * The item size of each event `Put`, in order — what DynamoDB's 400 KB
   * (409,600-byte) item limit measures.
   */
  readonly events: ReadonlyArray<number>
  /** The item size of the idempotency sentinel `Put`, when `idempotency` is given. */
  readonly sentinel: number | undefined
  /** The item size of the inline snapshot `Put`, when `snapshot` is given. */
  readonly snapshot: number | undefined
  /**
   * What the stream's own actions (the contiguity check, the event puts, the
   * sentinel and the inline snapshot) add to the `TransactWriteItems` request
   * — its 4 MB (4,194,304-byte) limit counts items, keys and expressions.
   * Caller `additionalItems` are not included: add their size yourself.
   */
  readonly transactionBytes: number
}

/**
 * The options {@link EventStream.measureAppend} accepts: those of
 * {@link EventStream.append} except `additionalItems`.
 */
export type MeasureAppendOptions<TMetadata, TState = never> = Omit<
  AppendOptionsBase<TState>,
  "additionalItems"
> &
  AppendMetadataOptions<TMetadata>

export type { LambdaAttributeValue, StreamImage } from "./internal/Packed.js"

/**
 * How {@link commandHandler} writes snapshots.
 *
 * - `"after-append"` (default) — a best-effort `writeSnapshot` after the append
 *   succeeds, at the `every` cadence. A failed snapshot write never fails the
 *   command; the snapshot simply lags until the next threshold crossing.
 * - `"inline"` — the snapshot `Put` rides in the append's own transaction (see
 *   {@link AppendOptionsBase.snapshot}), on every append, or at the `every` cadence
 *   when one is set. The snapshot is then current after every command that
 *   writes one, so {@link EventStream.readLatest} loads state in one request.
 *   The snapshot counts towards the transaction's item and size limits.
 */
export type SnapshotMode = "after-append" | "inline"

/** The runtime snapshot settings exposed on a stream. */
export interface SnapshotSettings {
  readonly mode: SnapshotMode
  readonly every: number | undefined
}

// ---------------------------------------------------------------------------
// Append options — additional transaction items + command idempotency
// ---------------------------------------------------------------------------

/**
 * Command-dedup configuration for a single {@link EventStream.append} call.
 *
 * When present, `append` writes a sentinel item guarded by
 * `attribute_not_exists(pk)` into the same transaction as the events. A replayed
 * `commandId` therefore cancels the whole transaction and surfaces as
 * `DuplicateCommand` — the events are never written twice.
 *
 * The sentinel is consulted only by an append. Through `commandHandler`, a
 * redelivery whose `decide` returns no events against the loaded state never
 * appends, so it succeeds as a no-op instead of failing with
 * `DuplicateCommand`. Whether a no-op redelivery needs to be told apart is the
 * application's call (see {@link CommandOptionsBase.commandId}).
 *
 * The sentinel is co-located in the stream's own partition, so `commandId`
 * uniqueness is scoped to the stream (which is what "have I already applied this
 * command to this aggregate?" asks). It is invisible to `read` / `readFrom` /
 * `currentVersion`, which filter on the event entity type.
 *
 * **Casing:** the sentinel sort key is composed with the stream's key casing
 * (its `casing`, else the schema's — default `"lowercase"`), so under a folding
 * casing command ids that differ only in case collide. Use
 * case-insensitively-unique ids (UUID / ULID). The raw id is stored as the
 * `commandId` attribute regardless.
 */
export interface AppendIdempotency {
  /** Caller-supplied identifier for this command delivery. */
  readonly commandId: string
  /**
   * Optional expiry for the sentinel, written to the table's TTL attribute
   * (honours `TableConfig.ttlAttributeName`). Set it to the longest window over
   * which your infrastructure can replay a command. Omitted → sentinels are
   * permanent, which is the safe direction.
   */
  readonly ttl?: Duration.Duration | string
}

/**
 * The metadata of an {@link EventStream.append}: one value shared by every
 * event (`metadata`), or one entry per event (`eventMetadata`) — never both.
 *
 * Passing both is a compile error, and a `ValidationError` at runtime for an
 * untyped caller. `undefined` counts as absent for either, so
 * `{ metadata: undefined, eventMetadata: [...] }` is not "both".
 */
export type AppendMetadataOptions<TMetadata> =
  | {
      /**
       * Metadata written onto **every** event of the append — a copy per item,
       * encoded once through the stream's metadata schema when one is
       * configured. For metadata that belongs to each event (an event id, the
       * original occurrence time of an imported event) use `eventMetadata`:
       * packing a list into `metadata` stores every entry on every item, so
       * stored metadata grows with the square of the append size.
       */
      readonly metadata?: TMetadata
      readonly eventMetadata?: undefined
    }
  | {
      readonly metadata?: undefined
      /**
       * Per-event metadata: entry `i` is written onto event `i` (and read back
       * as that event's `StreamEvent.metadata`). Each defined entry is encoded
       * through the stream's metadata schema, as `metadata` is; an `undefined`
       * entry writes its event without a `metadata` attribute.
       *
       * Must have exactly one entry per event — a length mismatch fails with
       * `ValidationError` before anything is read or written, also for an
       * append of no events (where only `[]` is accepted).
       */
      readonly eventMetadata?: ReadonlyArray<TMetadata | undefined>
    }

/**
 * The options of {@link EventStream.append} other than its metadata (see
 * {@link AppendMetadataOptions}).
 *
 * `TState` is the stream's snapshot state type (`never` for a stream without a
 * `snapshot` config, so `snapshot` cannot be supplied there).
 */
export interface AppendOptionsBase<TState = never> {
  /**
   * Caller-owned transact items committed atomically with the events — the same
   * op union `Transaction.transactWrite` accepts (`EntityPut`, `EntityDelete`,
   * `Transaction.check(...)`).
   *
   * A put of a versioned or unique-constrained entity is written exactly as
   * the entity's own `put` writes it (#133) — reading the item, continuing a
   * replaced item's version and history, rotating its sentinels — and an
   * append whose read raced a concurrent write is written again.
   *
   * A failure of an item's OWN condition (`.condition()`, `create()`,
   * `Transaction.check`) is reported as `AdditionalItemConditionFailed`
   * (carrying the 0-based indices into this array), never as
   * `VersionConflict`. A guarded put the caller set no condition on fails as
   * the entity's put would: `UniqueConstraintViolation`, a history
   * `ValidationError`, or — a race lost on every attempt —
   * `OptimisticLockError` / `ConcurrentModification`.
   */
  readonly additionalItems?: ReadonlyArray<TransactWriteOp>
  /** Opt in to exactly-once command processing — see {@link AppendIdempotency}. */
  readonly idempotency?: AppendIdempotency
  /**
   * An inline snapshot: the stream's state as of this append's last event.
   *
   * The snapshot `Put` (`asOfVersion` = `expectedVersion + events.length`,
   * encoded through the state schema) joins the **same transaction** as the
   * events, after the idempotency sentinel, so it commits if and only if the
   * events do. The `Put` is unconditional: the event puts already prove this
   * writer owns `asOfVersion`, so it cannot regress the snapshot. It counts
   * towards the item and size limits, and a cancellation reason at its
   * position (throttling, for example) reports `TransactionCancelled`.
   *
   * `undefined` means no snapshot. Requires at least one event — with none,
   * nothing proves the writer owns the version, and the append fails with
   * `ValidationError`. On a stream without a `snapshot` config (where the type
   * is `never`) it dies with `[EDD-9026]`, as `writeSnapshot` does.
   */
  readonly snapshot?: TState
  /**
   * Per-event timestamps: entry `i` is written as event `i`'s `timestamp` (and
   * read back as that event's `StreamEvent.timestamp`), for history imported
   * with its original occurrence times. An `undefined` entry keeps the
   * append's `Clock` time. Independent of `metadata` / `eventMetadata`.
   *
   * Written with `DateTime.formatIso` — the format the append's own time is
   * written in — so a zoned `DateTime` is stored as its UTC instant.
   *
   * - Must have exactly one entry per event, each a valid `DateTime` (finite
   *   epoch) or `undefined` — anything else fails with `ValidationError` before anything is read or
   *   written, also for an append of no events (where only `[]` is accepted).
   * - Only the event items change: the idempotency sentinel, its TTL and the
   *   inline snapshot record when the append was written.
   * - No ordering is enforced. `version` orders a stream; timestamps may
   *   repeat, run backwards or lie in the future, as imported history can.
   */
  readonly eventTimestamps?: ReadonlyArray<DateTime.DateTime | undefined>
}

/**
 * Options accepted by {@link EventStream.append}: {@link AppendOptionsBase}
 * plus the exclusive `metadata` / `eventMetadata` pair
 * ({@link AppendMetadataOptions}).
 *
 * A type alias rather than an interface, since it is an intersection with a
 * union: an interface cannot extend it.
 */
export type AppendOptions<TMetadata, TState = never> = AppendOptionsBase<TState> &
  AppendMetadataOptions<TMetadata>

/** Error channel of {@link EventStream.append}. */
export type AppendError =
  | VersionConflict
  | DuplicateCommand
  | AdditionalItemConditionFailed
  | AppendTooLarge
  | DynamoClientError
  | ValidationError
  | TransactionCancelled
  | UniqueConstraintViolation
  | OptimisticLockError
  | ConcurrentModification

// ---------------------------------------------------------------------------
// Read options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link EventStream.read}, {@link EventStream.readFrom} and
 * {@link EventStream.currentVersion}.
 *
 * `consistentRead: true` sets `ConsistentRead` on every `Query` page, so the
 * read observes every append acknowledged before it started (read-your-writes).
 * Default `false`: eventually consistent, at half the read cost.
 *
 * {@link commandHandler} loads state with strongly consistent reads by default —
 * see {@link CommandHandlerOptions.consistentRead}.
 */
export interface ReadOptions {
  readonly consistentRead?: boolean | undefined
}

/**
 * Options accepted by {@link EventStream.readFrom}: {@link ReadOptions} plus
 * `toVersion`, the last version to read (inclusive) — the key condition stops
 * there, so nothing past it is read or paid for. Default: the stream's head.
 */
export interface ReadFromOptions extends ReadOptions {
  readonly toVersion?: number | undefined
}

/**
 * Options accepted by {@link EventStream.readLatest}: {@link ReadOptions} plus
 * `verifySnapshot`.
 *
 * - `verifySnapshot` — default `true`: one `Query` reads the snapshot and the
 *   events after it, so the result is verified against the stream head.
 *   `false` reads **only the snapshot item**, with one `GetItem` (consistent
 *   per `consistentRead`), and returns
 *   `{ snapshot, events: [], version: snapshot.asOfVersion }` **without
 *   checking that no event follows it** — `version` is then the snapshot's
 *   version, not a verified head. When there is no snapshot item, it falls
 *   back to the verified read and returns that result.
 *
 *   Why: a `Query`'s read capacity counts every item it reads, and the
 *   verified read's first page is the snapshot **plus** the newest event,
 *   even when the snapshot is current; a `GetItem` reads the snapshot alone.
 *   With large events that roughly halves the read capacity of a load.
 *
 *   Only a stream whose snapshot config is `mode: "inline"` **without**
 *   `every` (the only mode that writes the snapshot in every append, so it is
 *   normally at the head) accepts `false`; any other snapshot config dies with
 *   `[EDD-9068]`. On a stream without a `snapshot` config the option is
 *   ignored. {@link commandHandler} exposes the same trade-off, with
 *   automatic fallbacks, as {@link CommandHandlerOptions.verifySnapshot}.
 */
export interface ReadLatestOptions extends ReadOptions {
  readonly verifySnapshot?: boolean | undefined
}

/**
 * A stream's latest state as {@link EventStream.readLatest} loads it.
 *
 * - `snapshot` — the stream's snapshot, if one exists (always `None` on a
 *   stream without a `snapshot` config).
 * - `events` — the events after the snapshot (every event when there is
 *   none), ascending by version. Fold them onto the snapshot's state.
 * - `version` — the stream head: the newest event's version, the snapshot's
 *   `asOfVersion` when no event follows it, `0` for an empty stream. With
 *   `verifySnapshot: false` (see {@link ReadLatestOptions}) and a snapshot
 *   present, it is the snapshot's `asOfVersion` and `events` is empty —
 *   **unverified**: events appended without a snapshot (a raw `append`, data
 *   written before `mode: "inline"`) may follow it.
 */
export interface LatestState<TState, TEvent, M = Record<string, unknown> | undefined> {
  readonly snapshot: Option.Option<Snapshot<TState>>
  readonly events: ReadonlyArray<StreamEvent<TEvent, M>>
  readonly version: number
}

// ---------------------------------------------------------------------------
// Stream indexes — sub-streams by derived key (#140)
// ---------------------------------------------------------------------------

/**
 * The stream id as a stream's index functions receive it: the value of each
 * `streamId.composite` field, by name.
 */
export type StreamIndexStreamId = { readonly [field: string]: string }

/**
 * Derives an event's key in a stream index from the domain event (before it is
 * encoded), the version it is appended at — its version in the stream — and
 * the stream id it is appended to.
 *
 * - A string is the event's sort key in the index. It is stored **raw**: no
 *   casing and no prefixing is applied, so compose it to sort the way you
 *   query (zero-pad numbers, for example).
 * - `undefined` leaves the event out of the index (a sparse index).
 * - Any other value, or a `key` that throws, fails the append with
 *   `ValidationError` before anything is written. An empty string or a key
 *   over DynamoDB's 1024-byte sort-key limit is sent and rejected by
 *   DynamoDB; the append then fails with `ValidationError` naming the index
 *   and the event (#144), and nothing is written.
 *
 * The key is derived only when an event is appended. Events are never
 * rewritten, so changing `key` later leaves events already stored under their
 * old keys (or out of the index), and declaring an index on a stream that
 * already holds events indexes only the events appended from then on. The
 * library does not backfill: re-deriving and writing the index attributes on
 * existing events is the application's decision (see `indexes` on
 * {@link makeStream}).
 */
export type StreamIndexKey<TEvent, TStreamId = StreamIndexStreamId> = (
  event: TEvent,
  version: number,
  streamId: TStreamId,
) => string | undefined

/**
 * Derives an event's partition in a GSI stream index (`partition` on a
 * {@link GlobalStreamIndexConfig}, #149) from the domain event, the version it
 * is appended at and the stream id — the arguments of the index's `key`, in
 * the same order. Called for every appended event, with `key`.
 *
 * - A string is the event's partition key in the index, stored **raw** (no
 *   casing, no prefix) in the index's `pk` attribute. Several streams may
 *   derive the same value, so one query of the index reads a group of
 *   streams — `ORDER#<orderId>` for an order's line, payment and shipment
 *   streams, say.
 * - `undefined` leaves the event out of the index, as an `undefined` `key`
 *   does. An event is indexed only when both return a string.
 * - Within one append, every event whose partition is a string must have the
 *   same one, and so must the inline snapshot's entry (see
 *   {@link StreamIndexSnapshotEntry}); otherwise the append fails with
 *   `ValidationError` and nothing is written. Another value, or a function
 *   that throws, fails it the same way. An empty string, or one over
 *   DynamoDB's 2048-byte partition-key limit, is DynamoDB's to reject: the
 *   rejection is reported as a `ValidationError` naming the index and the
 *   event.
 */
export type StreamIndexPartition<TEvent, TStreamId = StreamIndexStreamId> = (
  event: TEvent,
  version: number,
  streamId: TStreamId,
) => string | undefined

/**
 * Puts a stream's snapshot in a GSI stream index with a derived partition
 * (`snapshot` on a {@link GlobalStreamIndexConfig}, #149): from the state
 * being written (before it is encoded), the snapshot's `asOfVersion` and the
 * stream id — in the order of the events' `key` and `partition` — the
 * snapshot item's partition and sort key in the index —
 * both stored **raw** — or `undefined` to leave it out.
 *
 * Every snapshot write derives it — `writeSnapshot`, the inline snapshot of
 * `append` and `commandHandler` (`mode: "inline"` or `"after-append"`) — and
 * the attributes are part of the snapshot item itself, so an inline snapshot
 * enters the index in the append's own transaction. The snapshot `Put`
 * replaces the whole item, so returning `undefined` takes a snapshot already
 * in the index out of it.
 *
 * The inline snapshot of an append must have the partition of the append's
 * events in the index (when they have one); a standalone `writeSnapshot` has
 * no events to compare with. Another value than an object of two strings, or
 * a function that throws, fails the write with `ValidationError` before
 * anything is written.
 *
 * A snapshot is the state **as of** `asOfVersion`: it is current after every
 * append only with `snapshot: { mode: "inline" }` and no `every`. A reader of
 * the index that needs the head folds the stream's indexed events after
 * `asOfVersion` onto it.
 */
export type StreamIndexSnapshotEntry<TState, TStreamId = StreamIndexStreamId> = (
  state: TState,
  asOfVersion: number,
  streamId: TStreamId,
) => { readonly partition: string; readonly key: string } | undefined

/**
 * A stream index on a **local** secondary index (the default `type`). An LSI
 * shares the table's partition key (`pk`), so its items are exactly the
 * stream's indexed events, readable with strongly consistent reads.
 *
 * - `index` — the physical LSI name.
 * - `sk` — the attribute carrying the derived key (the LSI's sort key).
 * - `key` — see {@link StreamIndexKey}.
 *
 * An LSI must be created with the table. A table with any LSI caps the item
 * collection of **every** partition key value in it at 10 GB — not only the
 * indexed stream's partitions, but every stream's (indexed or not) and every
 * entity partition sharing the table; a write that would exceed it fails. What
 * the index copies from each event is its `projection` — see
 * {@link StreamIndexProjection}.
 */
export interface LocalStreamIndexConfig<TEvent, TStreamId = StreamIndexStreamId> {
  readonly type?: "lsi" | undefined
  readonly index: string
  readonly sk: string
  /** An LSI uses the table partition key; supplying `pk` is refused (`[EDD-9063]`). */
  readonly pk?: undefined
  readonly key: StreamIndexKey<TEvent, TStreamId>
  /** An LSI's partition is the stream's; supplying `partition` is refused (`[EDD-9063]`). */
  readonly partition?: undefined
  /** Only a GSI with a derived `partition` indexes snapshots (`[EDD-9063]`). */
  readonly snapshot?: undefined
  /**
   * What the index copies from each event — see {@link StreamIndexProjection}.
   * Default `"all"`. Must match the deployed index.
   */
  readonly projection?: StreamIndexProjection | undefined
}

/**
 * A stream index on a **global** secondary index. By default `append` writes
 * the stream's partition key value into the `pk` attribute of each indexed
 * event, so the index is scoped to the same stream: the eventually consistent
 * equivalent of an LSI, without the LSI's 10 GB item-collection cap. DynamoDB
 * rejects a strongly consistent read of it, diagnosed as a `ValidationError`
 * naming the index.
 *
 * With `partition` (#149), the partition is derived instead — see
 * {@link StreamIndexPartition} — and stored raw, so several streams can write
 * the same partition of one GSI they all declare, and one query of it reads
 * the whole group (an order's line, payment and shipment streams under
 * `ORDER#<orderId>`, say). {@link indexDefinitions} emits a physical index
 * the streams declare alike once. With `snapshot` as well, each stream's
 * snapshot item is in the index too — see {@link StreamIndexSnapshotEntry}.
 * {@link EventStream.readIndex} then takes the partition to read, and
 * returns the given stream's events in it.
 *
 * Unlike an LSI, the GSI itself can be added to an existing table
 * (`UpdateTable`), but that does not index the stream's existing items: the
 * index attributes are written only by `append` (and snapshot writes), so only
 * events appended after the index is declared are in it — see
 * {@link StreamIndexKey}.
 *
 * - `index` — the physical GSI name.
 * - `pk` — the attribute carrying the partition (the GSI's HASH key): the
 *   stream's partition key, or the derived `partition`.
 * - `sk` — the attribute carrying the derived key (the GSI's RANGE key).
 * - `key` — see {@link StreamIndexKey}.
 * - `partition` — optional, see {@link StreamIndexPartition}.
 * - `snapshot` — optional, requires `partition` and a stream `snapshot`
 *   config; see {@link StreamIndexSnapshotEntry}.
 * - `projection` — see {@link StreamIndexProjection}.
 *
 * Write `type: "gsi"` in the entry itself. TypeScript infers the parameter
 * types of `partition` and `snapshot` from the GSI member of the entry union,
 * which it selects by the literal `type`: an entry whose `type` comes from an
 * object spread (`{ ...shared, partition: (event) => … }`) gets implicit-`any`
 * parameters there, although `key` still infers. Annotate them, or give the
 * shared fragment a {@link GlobalStreamIndexConfig} type.
 */
export interface GlobalStreamIndexConfig<
  TEvent,
  TStreamId = StreamIndexStreamId,
  TState = unknown,
> {
  readonly type: "gsi"
  readonly index: string
  readonly pk: string
  readonly sk: string
  readonly key: StreamIndexKey<TEvent, TStreamId>
  /** The derived partition — see {@link StreamIndexPartition}. */
  readonly partition?: StreamIndexPartition<TEvent, TStreamId> | undefined
  /** The snapshot's entry — see {@link StreamIndexSnapshotEntry}. Requires `partition`. */
  readonly snapshot?: StreamIndexSnapshotEntry<TState, TStreamId> | undefined
  /**
   * What the index copies from each event — see {@link StreamIndexProjection}.
   * Default `"all"`. Must match the deployed index.
   */
  readonly projection?: StreamIndexProjection | undefined
}

/**
 * One entry of `makeStream({ indexes })`: a sub-stream of the stream's events,
 * ordered by a key derived from each event. See {@link LocalStreamIndexConfig}
 * and {@link GlobalStreamIndexConfig}.
 */
export type StreamIndexConfig<TEvent, TStreamId = StreamIndexStreamId, TState = unknown> =
  | LocalStreamIndexConfig<TEvent, TStreamId>
  | GlobalStreamIndexConfig<TEvent, TStreamId, TState>

/**
 * What a stream index copies from each event (`projection` on an entry of
 * `makeStream({ indexes })`). {@link indexDefinitions} emits the matching
 * `Projection`, and the reads choose their path from it.
 *
 * | Value | Emitted `Projection` | Read |
 * |---|---|---|
 * | `"all"` (default) | `ALL` | one query |
 * | `"withoutMetadata"` | `INCLUDE` of every event attribute except `metadata` (plus the snapshot's `asOfVersion` and `state` when a stream indexes its snapshot in it) | one query; `metadata` is `undefined` (and typed so) |
 * | `"keys"` | `INCLUDE ["__edd_e__"]` — **not** `KEYS_ONLY` | LSI: one query with `Select: ALL_ATTRIBUTES` (DynamoDB fetches each event from the table). GSI: the query, then `BatchGetItem` for the events of each page, in index order |
 *
 * `__edd_e__` is always projected because every read filters on it, and
 * DynamoDB refuses a filter on an attribute an index does not project.
 *
 * `metadata` is often an event's largest attribute; `"withoutMetadata"` keeps
 * it out of the index, and `"keys"` keeps the index entries minimal at the cost
 * of a table read per event read (rounded up to 4 KB each).
 *
 * **The declared projection must match the deployed index.** The library does
 * not migrate: an LSI's projection is fixed when the table is created, and a
 * GSI's cannot be updated (it must be deleted and created again). Tables
 * deployed with CDK or Terraform copy `Projection` from
 * {@link indexDefinitions}' output. An index deployed narrower than declared
 * fails reads: DynamoDB refuses the `__edd_e__` filter ("does not project one
 * or more filter attributes"), or rows lack event attributes, which the read
 * reports as a `ValidationError` (`operation: "EventStore.index.decode"`)
 * naming the index.
 */
export type StreamIndexProjection = "all" | "withoutMetadata" | "keys"

/**
 * The runtime settings of one stream index, as exposed on
 * {@link EventStream.indexes}. `pk` is the index's partition key attribute:
 * the table's `pk` for an LSI, the configured attribute for a GSI.
 * `projection` is resolved: `"all"` when the index declares none.
 */
export interface StreamIndexSettings {
  readonly type: "lsi" | "gsi"
  readonly index: string
  readonly pk: string
  readonly sk: string
  readonly projection: StreamIndexProjection
  /**
   * Where the index's partition comes from: `"stream"` — the stream's own
   * partition key (every LSI, and a GSI without `partition`) — or
   * `"derived"`, a GSI's `partition` function (#149). A stream always sets
   * it; absent (a settings object built by hand) reads as `"stream"`.
   */
  readonly partition?: "stream" | "derived" | undefined
  /**
   * Whether the stream's snapshot is in the index (a GSI's `snapshot`, #149).
   * A stream always sets it; absent reads as `false`.
   */
  readonly snapshot?: boolean | undefined
}

/**
 * The `metadata` type of an event read through a stream index of projection
 * `P`: `undefined` for a `"withoutMetadata"` index, which does not hold it,
 * the stream's {@link StreamMetadata} otherwise.
 */
export type IndexEventMetadata<TMetadata, P extends StreamIndexProjection> = [P] extends [
  "withoutMetadata",
]
  ? undefined
  : StreamMetadata<TMetadata>

/** @internal The `projection` an index config declares (`"all"` when none). */
type ProjectionOf<C> = C extends { readonly projection: infer P extends StreamIndexProjection }
  ? P
  : "all"

/**
 * The projection of each index of a `makeStream({ indexes })` config, by name.
 * `"all"` for an index that declares none.
 */
export type IndexProjectionsOf<TIndexes> = {
  readonly [K in keyof TIndexes & string]: ProjectionOf<TIndexes[K]>
}

/**
 * The names of the indexes of a `makeStream({ indexes })` config that derive
 * their partition (`partition`, #149) — those {@link EventStream.readIndex}
 * and `query.index` read with an explicit `partition`.
 */
export type PartitionedIndexesOf<TIndexes> = {
  readonly [K in keyof TIndexes & string]: TIndexes[K] extends {
    readonly partition: (...args: ReadonlyArray<any>) => unknown
  }
    ? K
    : never
}[keyof TIndexes & string]

/** @internal The members a stream index entry may declare. */
type StreamIndexConfigKey =
  | keyof LocalStreamIndexConfig<unknown>
  | keyof GlobalStreamIndexConfig<unknown>

/**
 * The `indexes` parameter of {@link makeStream}: each entry is a
 * {@link StreamIndexConfig}, and a member it does not declare (a misspelled
 * `projection`, say) is typed `never`, so it is a compile error. Inferring
 * `TIndexes` from the entries turns off TypeScript's own excess-property check,
 * which would otherwise catch it.
 */
export type StreamIndexesConfig<
  TIndexes,
  TEvent,
  TStreamId = StreamIndexStreamId,
  TState = unknown,
> = {
  readonly [K in keyof TIndexes]: StreamIndexConfig<TEvent, TStreamId, TState> & {
    readonly [P in Exclude<keyof TIndexes[K], StreamIndexConfigKey>]: never
  }
}

/**
 * Options accepted by {@link EventStream.readIndex}.
 *
 * - `beginsWith` / `between` — a sort-key condition on the derived key (at most
 *   one of them, string bounds). Omitted, the whole sub-stream is read.
 *   DynamoDB rejects an empty bound, and a `between` whose lower bound sorts
 *   (by UTF-8 bytes) after its upper bound; the read then fails with a
 *   `ValidationError` naming the index and the bound, DynamoDB's error as its
 *   cause.
 * - `reverse` — descending key order.
 * - `limit` — return at most this many events (a positive integer).
 * - `consistentRead` — strongly consistent read. DynamoDB rejects it on a
 *   GSI-backed index, which it reads only eventually consistently: the read
 *   fails with a `ValidationError` naming the index.
 *
 * An index that derives its partition (#149) also takes `partition` — see
 * {@link ReadIndexArgs}.
 */
export type ReadIndexOptions = {
  readonly reverse?: boolean | undefined
  readonly limit?: number | undefined
  readonly consistentRead?: boolean | undefined
} & (
  | { readonly beginsWith?: string | undefined; readonly between?: undefined }
  | { readonly between?: readonly [string, string] | undefined; readonly beginsWith?: undefined }
)

/**
 * The options argument of {@link EventStream.readIndex} for index `N`. An
 * index that derives its partition (`partition`, #149) is read one partition
 * at a time, so `partition` — the value to read, as the index's `partition`
 * function returns it — is required, and the read returns the events of the
 * given stream in it. Any other index is scoped to the stream already: a
 * `partition` passed for it fails the read with `ValidationError` (it stays
 * in the type so that a stream whose indexes derive their partition remains
 * assignable to one whose indexes do not, as every stream is to
 * `EventStream<E, F, M, S>`).
 */
export type ReadIndexArgs<N extends string, TPartitionedIndexName extends string> = [
  TPartitionedIndexName,
] extends [never]
  ? // No index derives its partition: resolved even while `N` is a type
    // parameter, so a generic wrapper over a stream's indexes type-checks.
    [options?: (ReadIndexOptions & { readonly partition?: string | undefined }) | undefined]
  : [N] extends [TPartitionedIndexName]
    ? [options: ReadIndexOptions & { readonly partition: string }]
    : [options?: (ReadIndexOptions & { readonly partition?: string | undefined }) | undefined]

/**
 * The options argument of `query.index` for index `N` — `partition`, required
 * for an index that derives its partition, as for {@link ReadIndexArgs}; on
 * any other index, one passed throws `[EDD-9080]`.
 */
export type IndexQueryArgs<N extends string, TPartitionedIndexName extends string> = [
  TPartitionedIndexName,
] extends [never]
  ? [options?: { readonly partition?: string | undefined } | undefined]
  : [N] extends [TPartitionedIndexName]
    ? [options: { readonly partition: string }]
    : [options?: { readonly partition?: string | undefined } | undefined]

/**
 * @internal Why a {@link ReadIndexOptions} key condition cannot be sent, or
 * `undefined` when it can: the options' own meaning — at most one of
 * `beginsWith` and `between`, string bounds (a number would be sent as `N`
 * against a string key). DynamoDB's rules on the bounds — not empty, a
 * `between` in order — are DynamoDB's to enforce: its rejection is diagnosed,
 * naming the index and the bound (#144).
 */
const invalidIndexKeyCondition = (options: ReadIndexOptions | undefined): string | undefined => {
  if (options?.beginsWith !== undefined && options.between !== undefined) {
    return "Pass at most one of beginsWith and between."
  }
  const beginsWith: unknown = options?.beginsWith
  if (beginsWith !== undefined) {
    return typeof beginsWith === "string"
      ? undefined
      : "beginsWith must be a string; omit it to read the whole sub-stream."
  }
  const between: unknown = options?.between
  if (between === undefined) return undefined
  if (
    !Array.isArray(between) ||
    between.length !== 2 ||
    !between.every((bound) => typeof bound === "string")
  ) {
    return "between must be a pair of strings."
  }
  return undefined
}

/**
 * @internal The partition an append's events have in an index that derives
 * one (#149), and the first event that has it — what the other events and
 * the inline snapshot are checked against.
 */
interface IndexPartitionOrigin {
  readonly partition: string
  readonly subject: string
}

/**
 * @internal A validated stream index: its logical name, settings and key
 * derivation.
 */
interface ResolvedStreamIndex extends StreamIndexSettings {
  readonly partition: "stream" | "derived"
  readonly snapshot: boolean
  readonly name: string
  readonly key: StreamIndexKey<unknown>
  /** The derived partition (#149); `undefined` for a stream-scoped index. */
  readonly derivePartition: StreamIndexPartition<unknown> | undefined
  /** The snapshot's entry (#149); `undefined` when snapshots are not indexed. */
  readonly snapshotEntry: StreamIndexSnapshotEntry<unknown> | undefined
}

/**
 * @internal The attributes `append` writes on every event item besides the
 * table key (`pk`, `sk`), the optional `metadata` and the index attributes:
 * the envelope, `data` and the `__edd_e__` discriminator. Sorted. A
 * `"withoutMetadata"` stream index projects exactly these.
 */
const EVENT_ITEM_ATTRIBUTES = [
  "__edd_e__",
  "data",
  "eventType",
  "streamId",
  "timestamp",
  "version",
] as const

/** @internal One of {@link EVENT_ITEM_ATTRIBUTES}. */
type EventItemAttribute = (typeof EVENT_ITEM_ATTRIBUTES)[number]

/**
 * @internal The event attributes an `"all"` or `"withoutMetadata"` stream index
 * guarantees on its rows and a decode needs: a row lacking one was read
 * through an index deployed narrower than declared.
 */
const PROJECTED_ENVELOPE_ATTRIBUTES: ReadonlyArray<EventItemAttribute> = [
  "data",
  "eventType",
  "streamId",
  "timestamp",
  "version",
]

/**
 * @internal Attributes a stream writes on its own items — events, snapshot,
 * idempotency sentinel — plus the default TTL attribute. An index attribute
 * may not reuse any of them.
 */
const STREAM_OWNED_ATTRIBUTES: ReadonlyArray<string> = [
  "pk",
  "sk",
  "__edd_e__",
  "streamId",
  "version",
  "eventType",
  "data",
  "metadata",
  "timestamp",
  "asOfVersion",
  "state",
  "commandId",
  DEFAULT_TTL_ATTRIBUTE_NAME,
]

/** @internal Every member a stream index entry may declare (`StreamIndexConfigKey`). */
const STREAM_INDEX_CONFIG_KEYS: ReadonlyArray<string> = [
  "type",
  "index",
  "pk",
  "sk",
  "key",
  "partition",
  "snapshot",
  "projection",
] satisfies ReadonlyArray<StreamIndexConfigKey>

/**
 * @internal `pk = <streamPk>`: keeps one stream id's items in a partition of a
 * stream index several streams (or stream ids) share (#149). The table's `pk`
 * is projected into every index, whatever its projection.
 */
const streamPkFilter = (streamPk: string): Expr =>
  eq(createPathBuilder<{ readonly pk: string }>().pk, streamPk)

/**
 * @internal Validate `makeStream({ indexes })` at definition time.
 *
 * @throws `[EDD-9063]` for a malformed entry (unknown `type`, a `gsi` without
 *   `pk`, an `lsi` with `pk`, `partition` or `snapshot`, an empty name, a
 *   `key` / `partition` / `snapshot` that is not a function, a `snapshot`
 *   without `partition` or on a stream without a snapshot config, an unknown
 *   `projection`, a member the entry type does not declare — a misspelled
 *   `projection` would otherwise silently mean `"all"`).
 * @throws `[EDD-9064]` for an index attribute that collides with a
 *   stream-owned attribute.
 * @throws `[EDD-9065]` for two indexes sharing a physical index name or an
 *   attribute.
 */
const resolveStreamIndexes = (
  streamName: string,
  indexes: Readonly<Record<string, unknown>> | undefined,
  hasSnapshotConfig: boolean,
): ReadonlyArray<ResolvedStreamIndex> => {
  if (indexes === undefined) return []
  const fail = (code: string, message: string): never => {
    throw new Error(`[${code}] EventStream "${streamName}": ${message}`)
  }
  const isName = (value: unknown): value is string => typeof value === "string" && value !== ""
  const resolved: Array<ResolvedStreamIndex> = []
  for (const [name, raw] of Object.entries(indexes)) {
    if (typeof raw !== "object" || raw === null) {
      fail("EDD-9063", `index "${name}" must be an object; received ${String(raw)}.`)
    }
    const entry = raw as Record<string, unknown>
    const unknownKey = Object.keys(entry).find((key) => !STREAM_INDEX_CONFIG_KEYS.includes(key))
    if (unknownKey !== undefined) {
      fail(
        "EDD-9063",
        `index "${name}": unknown member "${unknownKey}"; an index declares ` +
          `${STREAM_INDEX_CONFIG_KEYS.join(", ")}.`,
      )
    }
    const type = (entry.type ?? "lsi") as "lsi" | "gsi"
    if (type !== "lsi" && type !== "gsi") {
      fail(
        "EDD-9063",
        `index "${name}": type must be "lsi" or "gsi"; received ${JSON.stringify(entry.type)}.`,
      )
    }
    if (!isName(entry.index)) {
      fail("EDD-9063", `index "${name}": index must name the physical index (a non-empty string).`)
    }
    if (!isName(entry.sk)) {
      fail("EDD-9063", `index "${name}": sk must name the sort key attribute (a non-empty string).`)
    }
    if (type === "gsi" && !isName(entry.pk)) {
      fail(
        "EDD-9063",
        `index "${name}": a "gsi" index requires pk, the attribute carrying the stream's ` +
          "partition key (a non-empty string).",
      )
    }
    if (type === "lsi" && entry.pk !== undefined) {
      fail(
        "EDD-9063",
        `index "${name}": an "lsi" index uses the table partition key "pk"; remove pk, or ` +
          'declare type: "gsi".',
      )
    }
    if (typeof entry.key !== "function") {
      fail(
        "EDD-9063",
        `index "${name}": key must be a function (event, version, streamId) => string | undefined.`,
      )
    }
    if (entry.partition !== undefined) {
      if (type !== "gsi") {
        fail(
          "EDD-9063",
          `index "${name}": an "lsi" index is partitioned by the stream; only a "gsi" index ` +
            'derives its partition. Remove partition, or declare type: "gsi".',
        )
      }
      if (typeof entry.partition !== "function") {
        fail(
          "EDD-9063",
          `index "${name}": partition must be a function (event, version, streamId) => string | undefined.`,
        )
      }
    }
    if (entry.snapshot !== undefined) {
      if (typeof entry.snapshot !== "function") {
        fail(
          "EDD-9063",
          `index "${name}": snapshot must be a function (state, asOfVersion, streamId) => ` +
            "{ partition, key } | undefined.",
        )
      }
      if (entry.partition === undefined) {
        fail(
          "EDD-9063",
          `index "${name}": snapshot requires partition — only a "gsi" index with a derived ` +
            "partition indexes the stream's snapshot.",
        )
      }
      if (!hasSnapshotConfig) {
        fail(
          "EDD-9063",
          `index "${name}": snapshot requires the stream's snapshot config ` +
            "(makeStream({ snapshot: { schema } })); the stream writes no snapshot to index.",
        )
      }
    }
    const projection = (entry.projection ?? "all") as StreamIndexProjection
    if (projection !== "all" && projection !== "withoutMetadata" && projection !== "keys") {
      fail(
        "EDD-9063",
        `index "${name}": projection must be "all", "withoutMetadata" or "keys"; received ` +
          `${JSON.stringify(entry.projection)}.`,
      )
    }
    const index = entry.index as string
    const sk = entry.sk as string
    const pk = type === "gsi" ? (entry.pk as string) : "pk"
    const attributes = type === "gsi" ? [pk, sk] : [sk]
    for (const attribute of attributes) {
      if (STREAM_OWNED_ATTRIBUTES.includes(attribute)) {
        fail(
          "EDD-9064",
          `index "${name}": attribute "${attribute}" is written by the stream itself ` +
            `(reserved: ${STREAM_OWNED_ATTRIBUTES.join(", ")}). Choose another attribute name.`,
        )
      }
    }
    if (type === "gsi" && pk === sk) {
      fail("EDD-9065", `index "${name}": pk and sk must be different attributes ("${pk}").`)
    }
    for (const other of resolved) {
      if (other.index === index) {
        fail(
          "EDD-9065",
          `indexes "${other.name}" and "${name}" both use the physical index "${index}".`,
        )
      }
      const otherAttributes = other.type === "gsi" ? [other.pk, other.sk] : [other.sk]
      const shared = attributes.find((attribute) => otherAttributes.includes(attribute))
      if (shared !== undefined) {
        fail(
          "EDD-9065",
          `indexes "${other.name}" and "${name}" both use the attribute "${shared}".`,
        )
      }
    }
    resolved.push({
      name,
      type,
      index,
      pk,
      sk,
      projection,
      partition: entry.partition === undefined ? "stream" : "derived",
      snapshot: entry.snapshot !== undefined,
      key: entry.key as StreamIndexKey<unknown>,
      derivePartition: entry.partition as StreamIndexPartition<unknown> | undefined,
      snapshotEntry: entry.snapshot as StreamIndexSnapshotEntry<unknown> | undefined,
    })
  }
  return resolved
}

/**
 * @internal Validate `makeStream({ storedAs })` and `snapshot.storedAs` at
 * definition time (#147).
 *
 * @throws `[EDD-9079]` for a `storedAs` that is not an object, a key other
 *   than `data`, or a value that is not a `DynamoModel.Packed(...)` config.
 * @throws `[EDD-9073]` for a packed snapshot whose state schema's encoded side
 *   is not object- or array-shaped.
 */
const resolveStreamStorage = (
  streamName: string,
  storedAs: unknown,
  snapshot: SnapshotConfig | undefined,
): StreamStorageSettings => {
  const fail = (code: string, message: string): never => {
    throw new Error(`[${code}] EventStream "${streamName}": ${message}`)
  }
  const describe = (value: unknown): string =>
    value === null
      ? "null"
      : typeof value === "object"
        ? "an object that is not a DynamoModel.Packed(...) config"
        : `${typeof value} ${JSON.stringify(value)}`
  let data: PackedConfig | undefined
  if (storedAs !== undefined) {
    if (typeof storedAs !== "object" || storedAs === null || Array.isArray(storedAs)) {
      fail(
        "EDD-9079",
        `storedAs must be an object { data?: DynamoModel.Packed(...) }; received ${describe(storedAs)}.`,
      )
    }
    for (const [key, value] of Object.entries(storedAs as Record<string, unknown>)) {
      if (key !== "data") {
        fail(
          "EDD-9079",
          `storedAs declares "${key}", but only "data" can be stored packed` +
            (key === "metadata" ? " — event metadata always stays a map" : "") +
            (key === "state" ? " — pack snapshot state with snapshot.storedAs" : "") +
            ".",
        )
      }
      if (value !== undefined && !isPackedConfig(value)) {
        fail(
          "EDD-9079",
          `storedAs.data must be a DynamoModel.Packed(...) config; received ${describe(value)}.`,
        )
      }
      data = value as PackedConfig | undefined
    }
  }
  let state: PackedConfig | undefined
  const snapshotStoredAs: unknown = snapshot?.storedAs
  if (snapshot !== undefined && snapshotStoredAs !== undefined) {
    if (!isPackedConfig(snapshotStoredAs)) {
      fail(
        "EDD-9079",
        `snapshot.storedAs must be a DynamoModel.Packed(...) config; received ` +
          `${describe(snapshotStoredAs)}.`,
      )
    }
    const shape = packedShape(snapshot.schema)
    if (shape._tag === "Refused") {
      fail(
        "EDD-9073",
        `snapshot.storedAs packs the snapshot state, but the state schema cannot be packed: ` +
          `${shape.reason}. Packed storage holds object- or array-shaped JSON.`,
      )
    }
    state = snapshotStoredAs as PackedConfig
  }
  return { data, state }
}

// ---------------------------------------------------------------------------
// StreamIdInput — maps composite field names to a required record
// ---------------------------------------------------------------------------

export type StreamIdInput<T extends ReadonlyArray<string>> = {
  readonly [K in T[number]]: string
}

/** @internal The state type of a `makeStream({ snapshot })` config; `never` without one. */
type SnapshotStateOf<TSnapshot> =
  TSnapshot extends SnapshotConfig<infer TStateSchema> ? Schema.Schema.Type<TStateSchema> : never

// ---------------------------------------------------------------------------
// EventStreamTypeId
// ---------------------------------------------------------------------------

const EventStreamTypeId: unique symbol = Symbol.for("effect-dynamodb/EventStream")
export type EventStreamTypeId = typeof EventStreamTypeId

/**
 * @internal Carries the stream's stream-id formatter (composites joined in
 * declaration order — the `streamId` reported on errors and stored on items),
 * so {@link commandHandler} can report a pre-decide `VersionConflict` exactly
 * as `append` would. Not part of the public interface: `makeStream` and `bind`
 * attach it; a hand-built stream object falls back to joining the id's values.
 */
const StreamIdFormatter: unique symbol = Symbol.for("effect-dynamodb/EventStream/StreamIdFormatter")

/** @internal {@link EventStream.parseStreamId}, shared by `makeStream` and `bind`. */
const parseStreamIdWith = (
  streamName: string,
  fields: ReadonlyArray<string>,
  streamId: string,
): Effect.Effect<any, ValidationError> => {
  const parts = fields.length === 1 ? [streamId] : streamId.split("#")
  if (parts.length !== fields.length) {
    return Effect.fail(
      new ValidationError({
        entityType: `${streamName.toLowerCase()}.event`,
        operation: "EventStore.parseStreamId",
        cause:
          `Stream id ${JSON.stringify(streamId)} has ${parts.length} "#"-separated parts, but ` +
          `the stream id has ${fields.length} fields (${fields.join(", ")}): a value containing ` +
          `"#" makes the id ambiguous.`,
      }),
    )
  }
  const id: Record<string, string> = {}
  fields.forEach((field, i) => {
    id[field] = parts[i]!
  })
  return Effect.succeed(id)
}

/** @internal */
const formatStreamIdOf = (stream: object, streamId: Record<string, unknown>): string => {
  const formatter = (stream as { [StreamIdFormatter]?: (id: Record<string, unknown>) => string })[
    StreamIdFormatter
  ]
  return formatter !== undefined ? formatter(streamId) : Object.values(streamId).join("#")
}

/**
 * @internal Carries a probe for a command's idempotency sentinel (one strongly
 * consistent `GetItem`), so {@link commandHandler} can tell a redelivered
 * command from a lost race when its pre-decide If-Match check fails. Not part
 * of the public interface: `makeStream` and `bind` attach it (a bound stream's
 * probe has its services provided); a hand-built stream object has none.
 */
const CommandSentinelProbe: unique symbol = Symbol.for(
  "effect-dynamodb/EventStream/CommandSentinelProbe",
)

/** @internal */
type CommandSentinelProbeFn = (
  streamId: Record<string, unknown>,
  commandId: string,
) => Effect.Effect<boolean, DynamoClientError, DynamoClient | TableConfig>

/** @internal */
const commandSentinelProbeOf = (stream: object): CommandSentinelProbeFn | undefined =>
  (stream as { [CommandSentinelProbe]?: CommandSentinelProbeFn })[CommandSentinelProbe]

/**
 * @internal Carries a head probe bounded below by a known version: the newest
 * event version above `floorVersion`, or `floorVersion` itself when there is
 * none. {@link commandHandler} uses it to confirm an unverified snapshot is
 * still the head. Unlike `currentVersion`, it never reads the newest event when
 * the snapshot is current — the key range above `floorVersion` is empty, so the
 * `Query` reads no items and costs only DynamoDB's per-request minimum, however
 * large the events are. Attached by `makeStream` and `bind` like
 * {@link CommandSentinelProbe}; a hand-built stream falls back to
 * `currentVersion`.
 */
const HeadAboveProbe: unique symbol = Symbol.for("effect-dynamodb/EventStream/HeadAboveProbe")

/** @internal */
type HeadAboveProbeFn = (
  streamId: Record<string, unknown>,
  floorVersion: number,
  options?: ReadOptions | undefined,
) => Effect.Effect<number, DynamoClientError | ValidationError, DynamoClient | TableConfig>

/** @internal */
const headAboveProbeOf = (stream: object): HeadAboveProbeFn | undefined =>
  (stream as { [HeadAboveProbe]?: HeadAboveProbeFn })[HeadAboveProbe]

/**
 * @internal `[EDD-9068]`: `verifySnapshot: false` is accepted only by a stream
 * whose snapshot is written in every append (`mode: "inline"` without `every`),
 * the only mode in which the snapshot is normally at the head. Returns the
 * refusal message, or `undefined` when the option is acceptable — including on
 * a stream without a snapshot config, where it is ignored.
 */
const unverifiedSnapshotRefusal = (
  streamName: string,
  settings: SnapshotSettings | undefined,
  operation: string,
): string | undefined =>
  settings === undefined || (settings.mode === "inline" && settings.every === undefined)
    ? undefined
    : `[EDD-9068] EventStream "${streamName}": ${operation} with verifySnapshot: false requires ` +
      `snapshot mode "inline" without "every" — the only mode that writes the snapshot in every ` +
      `append, so it is normally at the head. This stream's snapshot is mode "${settings.mode}"` +
      `${settings.every === undefined ? "" : ` with every: ${settings.every}`}.`

/**
 * @internal Why an `eventTimestamps` value cannot be written for `count`
 * events — not an array, the wrong length, or an entry that is neither a
 * valid `DateTime` (finite epoch) nor `undefined` — or `undefined` when it can. `label` opens the
 * message (`"eventTimestamps has"` / `"eventTimestamps returned"`) and
 * `events` names the events (`"2 events"` / `"the decision's 2 events"`).
 */
const eventTimestampsProblem = (
  timestamps: unknown,
  count: number,
  label: string,
  events: string,
): string | undefined => {
  if (!Array.isArray(timestamps) || timestamps.length !== count) {
    return (
      `${label} ${Array.isArray(timestamps) ? timestamps.length : "no"} entries for ${events}: ` +
      "it needs exactly one entry (a DateTime, or undefined) per event, in order."
    )
  }
  const malformed = timestamps.findIndex(
    (t) =>
      t !== undefined && (!DateTime.isDateTime(t) || !Number.isFinite(DateTime.toEpochMillis(t))),
  )
  if (malformed === -1) return undefined
  const entry: unknown = timestamps[malformed]
  // A DateTime with a NaN epoch (e.g. `setPartsUtc` from a bad parse) passes
  // `isDateTime` but makes `formatIso` throw, so it is refused here instead.
  if (DateTime.isDateTime(entry)) {
    return (
      `eventTimestamps[${malformed}] is an invalid DateTime (its epoch milliseconds are not a ` +
      "finite number): each entry must be a valid DateTime, or undefined to keep the append's own time."
    )
  }
  return (
    `eventTimestamps[${malformed}] is not a DateTime (received ` +
    `${entry instanceof Date ? "a Date — convert it with DateTime.fromDateUnsafe" : entry === null ? "null" : typeof entry}): ` +
    "each entry must be a DateTime, or undefined to keep the append's own time."
  )
}

// ---------------------------------------------------------------------------
// EventStream interface
// ---------------------------------------------------------------------------

/**
 * An EventStream is the repository for a named event stream.
 *
 * Created via {@link makeStream}. Operations are called directly on the stream:
 * `MatchEvents.append(...)`, `MatchEvents.read(...)`, `MatchEvents.query.events(...)`.
 *
 * `TIndexName` is the union of the stream's index names (`makeStream({ indexes })`),
 * `never` for a stream without indexes, so {@link EventStream.readIndex} and
 * `query.index` only accept a declared name. `TIndexProjections` is each
 * index's {@link StreamIndexProjection} by name, so an event read through a
 * `"withoutMetadata"` index has `metadata: undefined`.
 * `TPartitionedIndexName` names the indexes that derive their partition
 * (#149), which are read with an explicit `partition`.
 */
export interface EventStream<
  TEvent,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TState = never,
  TIndexName extends string = never,
  TIndexProjections extends { readonly [K in TIndexName]: StreamIndexProjection } = {
    readonly [K in TIndexName]: "all"
  },
  TPartitionedIndexName extends string = never,
> extends Pipeable.Pipeable {
  readonly [EventStreamTypeId]: EventStreamTypeId
  readonly streamName: string
  readonly eventSchema: Schema.Top

  /** The stream id's composite fields, in declaration order (`makeStream({ streamId })`). */
  readonly streamIdFields: TStreamIdFields

  /**
   * The `__edd_e__` value of the stream's event items (`<streamname>.event`,
   * lower-cased) — what a change-feed filter or {@link decoder} matches on.
   */
  readonly eventMarker: string

  /**
   * Recover the structured stream id from a {@link StreamEvent.streamId} —
   * the composites joined with `#`, in declaration order. A single-field id is
   * the whole string. A multi-field id is split on `#`; a part count other
   * than the field count (a value that itself contains `#`) is ambiguous and
   * fails with `ValidationError`.
   */
  parseStreamId(
    streamId: string,
  ): Effect.Effect<StreamIdInput<TStreamIdFields>, ValidationError, never>

  /**
   * The stream's indexes (`makeStream({ indexes })`) by name — their physical
   * index and key attributes. Empty for a stream without indexes.
   * {@link indexDefinitions} derives `CreateTable` fragments from it.
   */
  readonly indexes: { readonly [K in TIndexName]: StreamIndexSettings }

  /**
   * Present iff the stream was created with a `snapshot` config. Its presence
   * is what switches {@link commandHandler} onto the snapshot-aware read path
   * ({@link EventStream.readLatest}); its `mode` decides how the handler writes
   * snapshots.
   */
  readonly snapshotConfig: SnapshotSettings | undefined

  /**
   * How the stream stores event `data` and snapshot `state` — see
   * {@link StreamStorageConfig} and {@link SnapshotConfig.storedAs}.
   */
  readonly storedAs: StreamStorageSettings

  /**
   * Write (or overwrite) this stream's snapshot.
   *
   * Monotonic: a snapshot at an equal or newer `asOfVersion` already present is
   * left alone and the write reports success. Dies with `[EDD-9026]` on a
   * stream declared without a `snapshot` config (unreachable via the types —
   * `TState` is `never` there, so no value can be supplied).
   *
   * Declared as a **method**, not a function-typed property, on purpose. As a
   * property it is checked contravariantly in `state`, and a snapshot-less
   * stream (`TState = never`) is then assignable to no other `EventStream` at
   * all — which breaks every pipeable/data-last consumer, because TypeScript
   * erases a generic callback's type parameters to their constraints when it
   * infers the `pipe` subject. Method syntax makes the parameter bivariant, so
   * `EventStream<E, F, M, never>` unifies with `EventStream<E, F, M, TState>`
   * again. Callers are unaffected: supplying a `state` still requires `TState`.
   */
  writeSnapshot(
    streamId: StreamIdInput<TStreamIdFields>,
    state: TState,
    asOfVersion: number,
  ): Effect.Effect<void, DynamoClientError | ValidationError, DynamoClient | TableConfig>

  /**
   * Read this stream's snapshot, if one has been written.
   *
   * A snapshot that fails to decode through the configured state schema fails
   * with `ValidationError` — it is never silently discarded, because that would
   * hide state-schema evolution bugs.
   */
  readSnapshot(
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<
    Option.Option<Snapshot<TState>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /**
   * Append `events` after `expectedVersion`, atomically, in one transaction —
   * see {@link AppendOptions}.
   * A method, like `writeSnapshot`, so a snapshot-less stream (whose
   * `options.snapshot` is `never`) stays assignable to other streams.
   */
  append(
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: AppendOptions<TMetadata, TState> | undefined,
  ): Effect.Effect<AppendResult<TEvent>, AppendError, DynamoClient | TableConfig>

  /**
   * Read every event of the stream, ascending by version. Pass
   * `{ consistentRead: true }` for read-your-writes — see {@link ReadOptions}.
   */
  read(
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadOptions | undefined,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /**
   * Read the events after `afterVersion` (exclusive), ascending — up to
   * `toVersion` (inclusive) when given. Pass `{ consistentRead: true }` for
   * read-your-writes — see {@link ReadFromOptions}.
   */
  readFrom(
    streamId: StreamIdInput<TStreamIdFields>,
    afterVersion: number,
    options?: ReadFromOptions | undefined,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /**
   * The version of the stream's newest event (`0` for an empty stream), in one
   * request. Pass `{ consistentRead: true }` for read-your-writes — see
   * {@link ReadOptions}.
   */
  currentVersion(
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadOptions | undefined,
  ): Effect.Effect<number, DynamoClientError | ValidationError, DynamoClient | TableConfig>

  /**
   * The stream's snapshot (if any), the events after it, and its head — in
   * **one request** in steady state. This is how {@link commandHandler} loads
   * state on a snapshot-configured stream.
   *
   * Issues a single reverse `Query` over the sort-key range from the first
   * event to the snapshot (the snapshot sorts after every event, and the
   * idempotency sentinels before them, so the range holds exactly the events
   * and the snapshot), with a first page of `(every ?? 1) + 1` items. Further
   * pages are read only while the snapshot's `asOfVersion` has not been reached
   * (a snapshot lagging by more than `every` events) — each sized to the events
   * still missing, so a lagging snapshot costs one more request — or to the
   * start of the stream when there is no snapshot. Pass
   * `{ consistentRead: true }` for read-your-writes; it applies to the snapshot
   * and the events alike.
   *
   * A snapshot that fails to decode through the state schema fails with
   * `ValidationError`, as {@link EventStream.readSnapshot} does. On a stream
   * without a `snapshot` config it is {@link EventStream.read} plus the head.
   *
   * `{ verifySnapshot: false }` reads only the snapshot item, with one
   * `GetItem`, and returns it with no events and its `asOfVersion` as an
   * **unverified** `version`; with no snapshot item it falls back to the
   * verified read. Accepted only on a `mode: "inline"` stream without `every`
   * (otherwise a defect, `[EDD-9068]`), ignored on a stream without a
   * `snapshot` config — see {@link ReadLatestOptions}.
   */
  readLatest(
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadLatestOptions | undefined,
  ): Effect.Effect<
    LatestState<TState, TEvent, StreamMetadata<TMetadata>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /**
   * Read the stream's events in the order of one of its indexes (#140) — the
   * events whose index `key` returned a string, ordered by that key. A
   * convenience over `query.index`; pass `beginsWith` or `between` to narrow
   * the key range, `reverse`, `limit` and `consistentRead` (which DynamoDB
   * rejects on a GSI; the error names the index) — see {@link ReadIndexOptions}.
   *
   * How the events are read follows the index's {@link StreamIndexProjection}:
   * one query for `"all"` and `"withoutMetadata"` (whose events have
   * `metadata: undefined`, as the type says); for `"keys"`, one query with
   * `Select: ALL_ATTRIBUTES` on an LSI, or the query followed by `BatchGetItem`
   * (unprocessed keys retried, index order kept) on a GSI.
   *
   * An index that derives its partition (`partition`, #149) is read one
   * partition at a time: pass the partition as `options.partition` (required
   * by the types — see {@link ReadIndexArgs}). The read keeps the events of
   * `streamId` in it — not the other streams sharing the partition, nor any
   * snapshot — by filtering on the table's `pk`, which every index projects.
   */
  readIndex<N extends TIndexName>(
    name: N,
    streamId: StreamIdInput<TStreamIdFields>,
    ...options: ReadIndexArgs<N, TPartitionedIndexName>
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, IndexEventMetadata<TMetadata, TIndexProjections[N]>>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  /**
   * The bytes {@link EventStream.append} would write for these arguments, by
   * DynamoDB's own size accounting — for planning chunks against the 400 KB
   * item and 4 MB transaction limits without re-implementing the stream's
   * item layout or packing. The items are built by the same code `append`
   * uses (envelope, keys, packed and compressed `data`, metadata, stream-index
   * attributes, the sentinel, the inline snapshot), so the numbers are exact
   * for the request `append` would send now with this runtime's compressors.
   *
   * Nothing is read or written, and nothing is refused for its size: this is
   * caller-side planning, not a pre-check. `additionalItems` are not accepted
   * — add their size yourself. Fails as `append` would on invalid options
   * (`ValidationError`), and — with a `CompressorNotRegistered` cause — when a
   * value crosses its compression threshold without a registered compressor.
   */
  measureAppend(
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: MeasureAppendOptions<TMetadata, TState> | undefined,
  ): Effect.Effect<AppendMeasurement, ValidationError, TableConfig>

  /**
   * The item size, in bytes, of the snapshot {@link EventStream.writeSnapshot}
   * (or an inline snapshot at `asOfVersion`) would write — packed `state` as
   * stored. Caller-side planning, like {@link EventStream.measureAppend}. Dies
   * with `[EDD-9026]` on a stream without a `snapshot` config.
   */
  measureSnapshot(
    streamId: StreamIdInput<TStreamIdFields>,
    state: TState,
    asOfVersion: number,
  ): Effect.Effect<number, ValidationError, TableConfig>

  /**
   * Decode a DynamoDB Streams record image (`NewImage` / `OldImage`) of one
   * of this stream's events into exactly the {@link StreamEvent} the read
   * paths return — `data` decoded through the event schemas (by its stored
   * form: native map, JSON string or compressed binary), `metadata` through
   * the metadata schema when the stream declares one.
   *
   * Accepts DynamoDB JSON as Lambda and EventBridge Pipes deliver it (`B` /
   * `BS` members as base64 text, or as bytes), or an already-unmarshalled
   * item (a packed `data` as bytes or base64 text). `Option.none()` for an
   * image that is not one of this stream's events — its snapshot, an
   * idempotency sentinel, another stream's or an entity's item — so one
   * handler can fan a table's records across decoders. The type is read off
   * the raw image before anything is unmarshalled, so nothing in another
   * item's image (a number the SDK cannot represent, say) fails the decode.
   * An event image that does not decode fails with `ValidationError`.
   *
   * With `{ raw: true }`, each event also carries `rawData`: its `data` as
   * stored, in wire form, unmodelled fields included (see
   * {@link RawStreamEvent}).
   *
   * The compressor registry is not in the type (`R = never`): this unbound
   * method reads the `Compression` service from the running fiber. When the
   * stream's `storedAs.data` or `snapshot.storedAs` names a codec that
   * registry does not hold — including no `Compression` at all, for example
   * one lost behind `Layer.provide` — it dies with the `[EDD-9078]`
   * configuration defect on first use, whatever the image, rather than
   * failing with a typed error. Provide `Compression` where the handler runs,
   * or decode through {@link EventStore.bind}, which captures it.
   */
  decodeStreamImage(
    image: StreamImage,
    options: DecodeStreamImageOptions & { readonly raw: true },
  ): Effect.Effect<
    Option.Option<RawStreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    ValidationError,
    never
  >
  decodeStreamImage(
    image: StreamImage,
    options?: DecodeStreamImageOptions,
  ): Effect.Effect<
    Option.Option<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    ValidationError,
    never
  >

  readonly query: {
    events(
      streamId: StreamIdInput<TStreamIdFields>,
    ): Query.Query<StreamEvent<TEvent, StreamMetadata<TMetadata>>>
    /**
     * A query of one of the stream's indexes (#140), scoped to `streamId`:
     * decoded events in index-key order. It composes with the `Query`
     * combinators — `Query.where` (a condition on the derived key),
     * `Query.reverse`, `Query.limit`, `Query.consistentRead` (DynamoDB rejects
     * it on a GSI-backed index: a `ValidationError` naming the index) — and terminals
     * (`Query.collect`, `Query.execute`, `Query.paginate`). The
     * `__edd_e__ = <stream>.event` filter still applies.
     *
     * It reads as {@link EventStream.readIndex} does for the index's
     * projection: a `"keys"` GSI fetches each page's events with
     * `BatchGetItem` (`Query.select` moves onto that fetch); `Query.count`
     * counts index entries and fetches nothing. On a `"keys"` or
     * `"withoutMetadata"` index, a `Query.filter` on an attribute the index
     * does not project is refused by DynamoDB — use `Query.filterBy`.
     *
     * An index that derives its partition (#149) takes the partition to read
     * as `options.partition` (see {@link IndexQueryArgs}), and the query keeps
     * `streamId`'s events in it, as {@link EventStream.readIndex} does.
     */
    index<N extends TIndexName>(
      name: N,
      streamId: StreamIdInput<TStreamIdFields>,
      ...options: IndexQueryArgs<N, TPartitionedIndexName>
    ): Query.Query<StreamEvent<TEvent, IndexEventMetadata<TMetadata, TIndexProjections[N]>>>
  }
}

// ---------------------------------------------------------------------------
// Append transaction layout (internal)
// ---------------------------------------------------------------------------

/**
 * @internal The `TransactWriteItems` request of an append, laid out for
 * positional cancellation mapping:
 *
 * - `[0, guardCount)` — the version-contiguity `ConditionCheck` (0 or 1 items)
 * - `[guardCount, guardCount + eventCount)` — the event puts
 * - then the `additional` items (caller op order preserved)
 * - then, at `sentinelIndex`, the idempotency sentinel `Put`
 * - then the inline snapshot `Put`
 *
 * The sentinel and snapshot come last, so adding them never shifts the
 * additional-item indices the caller sees.
 */
interface AppendTransaction {
  readonly items: Array<TransactWriteItem>
  /**
   * Parallel to `items`, for the failure-time diagnosis: built on its first
   * call (only on failure), the same array on every call.
   */
  readonly targets: () => ReadonlyArray<TransactItemTarget>
  readonly guardCount: number
  readonly eventCount: number
  readonly additional: BuiltTransactWriteItems
  /** `-1` when the transaction carries no sentinel item. */
  readonly sentinelIndex: number
  /** `-1` when the transaction carries no inline snapshot. */
  readonly snapshotIndex: number
  /** The version the events are appended after. */
  readonly expectedVersion: number
}

/**
 * @internal The stream's own items of one append, built by `buildAppend` —
 * everything but the caller's `additionalItems`. `append` lays them out (see
 * {@link AppendTransaction}); `measureAppend` measures them.
 */
interface AppendParts {
  readonly tableName: string
  readonly streamIdStr: string
  readonly contiguityCheck: TransactWriteItem | undefined
  readonly eventItems: ReadonlyArray<TransactWriteItem>
  readonly sentinelPut: TransactWriteItem | undefined
  readonly snapshotPut: TransactWriteItem | undefined
}

// ---------------------------------------------------------------------------
// makeStream factory
// ---------------------------------------------------------------------------

/**
 * Create an EventStream bound to a Table.
 *
 * Define event schemas with `Schema.TaggedClass` (not plain `Schema.Class`):
 * stored events are decoded through a `Schema.Union` of the event schemas, and
 * without a declared `_tag` field the union discriminates structurally — two
 * event types with identical fields would mis-decode as each other.
 *
 * @example
 * ```typescript
 * class MatchStarted extends Schema.TaggedClass<MatchStarted>()("MatchStarted", {
 *   venue: Schema.String,
 * }) {}
 *
 * class InningsCompleted extends Schema.TaggedClass<InningsCompleted>()("InningsCompleted", {
 *   innings: Schema.Number,
 *   runs: Schema.Number,
 * }) {}
 *
 * const MatchEvents = EventStore.makeStream({
 *   table: EventsTable,
 *   streamName: "Match",
 *   events: [MatchStarted, InningsCompleted],
 *   streamId: { composite: ["matchId"] },
 * })
 * ```
 *
 * Opt into snapshots by declaring a state schema:
 *
 * @example
 * ```typescript
 * const MatchEvents = EventStore.makeStream({
 *   table: EventsTable,
 *   streamName: "Match",
 *   events: [MatchStarted, InningsCompleted],
 *   streamId: { composite: ["matchId"] },
 *   snapshot: { schema: MatchStateSchema, every: 100 },
 * })
 * ```
 *
 * `snapshot.mode: "inline"` writes the snapshot in the append transaction
 * itself, so it is current after every command and state loads in one
 * request — see {@link SnapshotMode}.
 *
 * `casing` overrides the key casing for this stream, as an index's or a vector
 * index's `casing` does: the stream name, stream-id values and command ids in
 * its keys all take it. When omitted, the stream name is lower-cased and the
 * rest of the key follows the schema's casing — the layout streams have always
 * had. Setting `casing` on a stream that already holds data moves its keys
 * (unless the result happens to match), so its events, snapshot and idempotency
 * sentinels are no longer read. The `__edd_e__` discriminators
 * (`<stream>.event` etc.) are always lower-cased. In the next major, omitting
 * `casing` will mean the schema's casing, as it does for indexes.
 *
 * `indexes` declares sub-streams ordered by a key derived from each event
 * (#140), on a local (default) or global secondary index. `append` writes each
 * event's derived key (and, for a GSI, the stream's partition key) on the
 * event item. Idempotency sentinels never carry them; snapshots carry an
 * entry only in a GSI that derives its partition and declares `snapshot`.
 * Read with {@link EventStream.readIndex} or `query.index`, and create the
 * indexes with {@link indexDefinitions}. Each index's `projection` (default
 * `"all"`) sets what it copies from each event and how it is read — see
 * {@link StreamIndexProjection}.
 *
 * A GSI's `partition` (#149) derives the partition from the stream id and the
 * event instead, stored raw, so several streams declaring the same GSI write
 * one partition of it — an order's line, payment and shipment streams under
 * `ORDER#<orderId>`, read by one query — and its `snapshot` puts each stream's
 * snapshot item in that partition too, in the same `Put` (so an inline
 * snapshot enters the index in the append's own transaction). See
 * {@link GlobalStreamIndexConfig}.
 *
 * Index attributes are written only at append time and events are never
 * rewritten. Declaring an index on a stream that already holds events, or
 * changing an index's `key`, therefore leaves the earlier events out of the
 * index (or under their old keys), and `readIndex` returns only what was
 * indexed — without an error. The library does not backfill; whether and how
 * to re-index existing events (for example, an `UpdateItem` per event setting
 * the derived attributes) is the application's decision.
 *
 * @example
 * ```typescript
 * // Lines and payments of an order share `gsi1` under `ORDER#<orderId>`.
 * const OrderLines = EventStore.makeStream({
 *   table: EventsTable,
 *   streamName: "OrderLine",
 *   events: [LineAdded, LineRemoved],
 *   streamId: { composite: ["orderId", "lineId"] },
 *   snapshot: { schema: LineState, mode: "inline" },
 *   indexes: {
 *     byOrder: {
 *       type: "gsi",
 *       index: "gsi1",
 *       pk: "gsi1pk",
 *       sk: "gsi1sk",
 *       partition: (_event, _version, streamId) => `ORDER#${streamId.orderId}`,
 *       key: (_event, version, streamId) => `LINE#${streamId.lineId}#EVT#${pad(version)}`,
 *       snapshot: (_state, _asOfVersion, streamId) => ({
 *         partition: `ORDER#${streamId.orderId}`,
 *         key: `LINE#${streamId.lineId}#STATE`,
 *       }),
 *     },
 *   },
 * })
 *
 * const lineEvents = yield* OrderLines.readIndex("byOrder", { orderId, lineId }, {
 *   partition: `ORDER#${orderId}`,
 * })
 * ```
 *
 * @example
 * ```typescript
 * const Entries = EventStore.makeStream({
 *   table: EventsTable,
 *   streamName: "Ledger",
 *   events: [EntryRecorded, EntryVoided],
 *   streamId: { composite: ["ledgerId"] },
 *   indexes: {
 *     byEntry: {
 *       index: "lsi1",
 *       sk: "lsi1sk",
 *       key: (event, version) =>
 *         event._tag === "EntryRecorded" ? `ENTRY#${event.section}#${pad(version)}` : undefined,
 *     },
 *     // Every event, by the day it was recorded (both event types carry `day`).
 *     byDay: { type: "gsi", index: "gsi1", pk: "gsi1pk", sk: "gsi1sk", key: (e) => e.day },
 *   },
 * })
 *
 * const sectionThree = yield* Entries.readIndex("byEntry", { ledgerId }, { beginsWith: "ENTRY#3#" })
 * ```
 *
 * @throws `[EDD-9027]` when `snapshot.every` is not a positive integer.
 * @throws `[EDD-9062]` when `snapshot.mode` is neither `"after-append"` nor
 *   `"inline"`.
 * @throws `[EDD-9063]` for a malformed index: a `type` other than `"lsi"` /
 *   `"gsi"`, a `gsi` without `pk`, an `lsi` with `pk`, `partition` or
 *   `snapshot`, an empty `index` / `sk` / `pk`, a `key` / `partition` /
 *   `snapshot` that is not a function, a `snapshot` without `partition` or on
 *   a stream without a `snapshot` config, a `projection` other than `"all"` /
 *   `"withoutMetadata"` / `"keys"`, or a member an index entry does not
 *   declare (such as a misspelled `projection`, also a type error).
 * @throws `[EDD-9064]` when an index attribute is one the stream writes itself
 *   (`pk`, `sk`, `__edd_e__`, `streamId`, `version`, `eventType`, `data`,
 *   `metadata`, `timestamp`, `asOfVersion`, `state`, `commandId`, or the
 *   default TTL attribute `_ttl`). A custom `TableConfig.ttlAttributeName`
 *   is only known at runtime: an index attribute equal to it fails each append
 *   with `ValidationError`.
 * @throws `[EDD-9065]` when two indexes share a physical index name or an
 *   attribute (or a GSI's `pk` and `sk` are the same attribute).
 * @throws `[EDD-9079]` when `storedAs` declares a key other than `data`
 *   (metadata always stays a map), or a `storedAs.data` / `snapshot.storedAs`
 *   value is not a `DynamoModel.Packed(...)` config.
 * @throws `[EDD-9073]` when `snapshot.storedAs` is set and the state schema's
 *   encoded side is not object- or array-shaped.
 *
 * `storedAs: { data: DynamoModel.Packed(...) }` stores event `data` packed, and
 * `snapshot.storedAs` the snapshot `state` — see {@link StreamStorageConfig}.
 * Register the codecs a compressed config names through the `Compression`
 * service (`Compression.layer([...])` merged into the application layer): a
 * bound stream refuses to bind without them, and an unbound one to run its
 * first operation (`[EDD-9078]`).
 */
export const makeStream = <
  const TEvents extends ReadonlyArray<Schema.Top>,
  TTable extends Table,
  const TStreamName extends string,
  const TStreamId extends { readonly composite: ReadonlyArray<string> },
  TMetadata extends Schema.Top | undefined = undefined,
  TSnapshot extends SnapshotConfig | undefined = undefined,
  const TIndexes extends {
    readonly [K in keyof TIndexes]: StreamIndexConfig<
      Schema.Schema.Type<TEvents[number]>,
      StreamIdInput<TStreamId["composite"]>,
      SnapshotStateOf<TSnapshot>
    >
  } = {},
>(config: {
  readonly table: TTable
  readonly streamName: TStreamName
  readonly events: TEvents
  readonly streamId: TStreamId
  readonly metadata?: TMetadata
  readonly snapshot?: TSnapshot
  readonly casing?: DynamoSchema.Casing | undefined
  readonly indexes?: TIndexes &
    StreamIndexesConfig<
      TIndexes,
      Schema.Schema.Type<TEvents[number]>,
      StreamIdInput<TStreamId["composite"]>,
      SnapshotStateOf<TSnapshot>
    >
  /** How event `data` is stored — see {@link StreamStorageConfig}. */
  readonly storedAs?: StreamStorageConfig | undefined
}): EventStream<
  Schema.Schema.Type<TEvents[number]>,
  TStreamId["composite"],
  TMetadata extends Schema.Top ? Schema.Schema.Type<TMetadata> : undefined,
  SnapshotStateOf<TSnapshot>,
  keyof TIndexes & string,
  IndexProjectionsOf<TIndexes>,
  PartitionedIndexesOf<TIndexes>
> => {
  type TEvent = Schema.Schema.Type<TEvents[number]>
  type TStreamIdFields = TStreamId["composite"]

  const schema = config.table.schema
  /**
   * `__edd_e__` discriminator values. Always lower-cased, whatever the casing:
   * they are matched exactly by every stream read, so they never vary with the
   * stream's or the schema's casing.
   */
  const typeLabel = config.streamName.toLowerCase()
  const entityType = `${typeLabel}.event`
  const snapshotEntityType = `${typeLabel}.snapshot`
  /**
   * Entity type of the command-dedup sentinel. Distinct from `entityType` so the
   * sentinel is filtered out of every event query (`read`, `readFrom`,
   * `currentVersion` all constrain `__edd_e__`), and it sorts before the event
   * keys (`.command` < `.event`) so it also falls outside `readFrom` ranges.
   */
  const commandEntityType = `${typeLabel}.command`

  /**
   * Stream keys. With `casing` set, the stream name goes to the key composer as
   * written and that casing applies to the whole key, as an index's `casing`
   * does. Without it, the name is lower-cased first and the schema's casing
   * applies — the layout every stream has been written with so far.
   */
  const keyOptions = config.casing === undefined ? undefined : { casing: config.casing }
  const keyLabel = config.casing === undefined ? typeLabel : config.streamName
  const eventKeyLabel = `${keyLabel}.event`
  const snapshotKeyLabel = `${keyLabel}.snapshot`
  const commandKeyLabel = `${keyLabel}.command`
  const compositeFields = config.streamId.composite

  // -------------------------------------------------------------------------
  // Snapshot config validation (EDD-9027, EDD-9062) — fail fast at definition time.
  // -------------------------------------------------------------------------

  const snapshot = config.snapshot as SnapshotConfig | undefined
  if (snapshot !== undefined && snapshot.every !== undefined) {
    if (!Number.isInteger(snapshot.every) || snapshot.every <= 0) {
      throw new Error(
        `[EDD-9027] EventStream "${config.streamName}": snapshot.every must be a positive integer; ` +
          `received ${String(snapshot.every)}.`,
      )
    }
  }
  if (
    snapshot !== undefined &&
    snapshot.mode !== undefined &&
    snapshot.mode !== "after-append" &&
    snapshot.mode !== "inline"
  ) {
    throw new Error(
      `[EDD-9062] EventStream "${config.streamName}": snapshot.mode must be "after-append" or ` +
        `"inline"; received ${JSON.stringify(snapshot.mode)}.`,
    )
  }
  const snapshotSettings: SnapshotSettings | undefined =
    snapshot === undefined
      ? undefined
      : { mode: snapshot.mode ?? "after-append", every: snapshot.every }

  // Packed storage (EDD-9079, EDD-9073) — validated at definition time.
  const storage = resolveStreamStorage(config.streamName, config.storedAs, snapshot)
  /** Event `data` packing, or `undefined` for the native map. */
  const dataStoredAs = storage.data
  /** Snapshot `state` packing, or `undefined` for the native map. */
  const stateStoredAs = storage.state
  /**
   * Whether a snapshot's stored `state` is read by its stored form: when it is
   * configured packed, or when its schema's encoded side is object- or
   * array-shaped (a native state is then never `S` / `B`), so a stream that
   * turned packing off still reads its packed snapshot.
   */
  const stateDispatch =
    snapshot !== undefined && (stateStoredAs !== undefined || isDispatchEligible(snapshot.schema))
  /**
   * The first operation run with a given compressor registry checks that it
   * has every codec `storedAs` names (`[EDD-9078]`, a defect): the stream
   * meets values compressed with them on every read and write. `bind` checks
   * the registry it captures up front instead.
   */
  const codecCheck = runtimeCodecCheck(
    `EventStore (first use of stream "${config.streamName}")`,
    streamCodecRequirements(config.streamName, storage),
  )
  const checked = <Args extends ReadonlyArray<any>, A, E, R>(
    op: (...args: Args) => Effect.Effect<A, E, R>,
  ): ((...args: Args) => Effect.Effect<A, E, R>) =>
    codecCheck === undefined ? op : (...args) => Effect.andThen(codecCheck, op(...args))
  /** The `[EDD-9076]` guard for queries of a stream whose `data` is packed. */
  const dataGuards: ReadonlyArray<PackedAttributeGuard> =
    dataStoredAs === undefined
      ? []
      : [
          {
            attribute: "data",
            owner: `EventStream "${config.streamName}"`,
            storedAs: dataStoredAs,
            alternative: (path) =>
              `Use Query.filterBy((event) => /* test event.${path} */), which runs on the ` +
              "decoded event inside the same paging loop.",
          },
        ]

  // Stream indexes (#140) — validated at definition time (EDD-9063..9065).
  const streamIndexes = resolveStreamIndexes(
    config.streamName,
    config.indexes as Readonly<Record<string, unknown>> | undefined,
    snapshot !== undefined,
  )
  const indexSettings: Record<string, StreamIndexSettings> = {}
  for (const idx of streamIndexes) {
    indexSettings[idx.name] = {
      type: idx.type,
      index: idx.index,
      pk: idx.pk,
      sk: idx.sk,
      projection: idx.projection,
      partition: idx.partition,
      snapshot: idx.snapshot,
    }
  }
  /** The indexes that hold the stream's snapshot (#149). */
  const snapshotIndexes = streamIndexes.filter((idx) => idx.snapshotEntry !== undefined)
  /** Every attribute the indexes write on an event item. */
  const indexAttributes = streamIndexes.flatMap((idx) =>
    idx.type === "gsi" ? [idx.pk, idx.sk] : [idx.sk],
  )

  // Build union schema from event schemas for decoding
  const eventUnion: Schema.Top =
    config.events.length === 1
      ? config.events[0]!
      : Schema.Union(config.events as unknown as ReadonlyArray<Schema.Top>)

  // Metadata schema (optional)
  const metadataSchema = config.metadata as Schema.Top | undefined

  // ---------------------------------------------------------------------------
  // Key helpers
  // ---------------------------------------------------------------------------

  const composeStreamPk = (streamId: Record<string, unknown>): string => {
    const composites = KeyComposer.extractComposites(compositeFields, streamId)
    return DynamoSchema.composeKey(schema, keyLabel, composites, keyOptions)
  }

  const composeEventSk = (version: number): string =>
    DynamoSchema.composeEventVersionKey(schema, eventKeyLabel, version, keyOptions)

  /** Sort key of a command's idempotency sentinel. */
  const composeCommandSk = (commandId: string): string =>
    DynamoSchema.composeKey(schema, commandKeyLabel, [commandId], keyOptions)

  /**
   * Every event SK begins with this; nothing else in the stream partition does.
   * Bounding event reads to it excludes the snapshot item at the key-condition
   * level, which matters because DynamoDB applies `Limit` *before*
   * `FilterExpression` — a filtered-out snapshot would still burn a `Limit` slot.
   */
  const eventSkPrefix = DynamoSchema.composeEventVersionKeyPrefix(schema, eventKeyLabel, keyOptions)

  /** Inclusive upper bound of the event SK range (10-digit padding maximum). */
  const maxEventSk = composeEventSk(DynamoSchema.MAX_EVENT_VERSION)

  /**
   * The snapshot SK. Distinct entity-type label (`<stream>.snapshot` vs
   * `<stream>.event_1#…`), so it can never collide with an event SK, and it
   * sorts after every event in the partition.
   *
   * The three stream-owned SKs share `<prefix>#<label>.` and differ first at
   * the literal suffix: `.command#<id>` < `.event_1#<version>` < `.snapshot`.
   * The suffixes are lower-case, and a stream `casing` applies to all three
   * alike (`"uppercase"` gives `.COMMAND` < `.EVENT_1` < `.SNAPSHOT`), so the
   * order holds under every casing. `readLatest` relies on it: the range
   * `[eventSkPrefix, snapshotSk]` holds exactly the events and the snapshot.
   */
  const snapshotSk = DynamoSchema.composeKey(schema, snapshotKeyLabel, [], keyOptions)

  const composeStreamIdString = (streamId: Record<string, unknown>): string =>
    compositeFields.map((f) => streamId[f]).join("#")

  // ---------------------------------------------------------------------------
  // Codec helpers — write encodes, read decodes (symmetry with Entity/Aggregate)
  // ---------------------------------------------------------------------------

  /**
   * Resolve the schema to encode an event with. Prefers the exact member
   * schema (via `instanceof` for `Schema.Class`/`Schema.TaggedClass` events)
   * over the union so structurally-overlapping members can't shadow each
   * other; falls back to the union for non-class event schemas.
   */
  const memberSchemaFor = (event: unknown): Schema.Top => {
    if (config.events.length === 1) return config.events[0]!
    for (const member of config.events) {
      const ctor = member as unknown as abstract new (...args: never) => unknown
      if (typeof ctor === "function" && event instanceof ctor) return member
    }
    return eventUnion
  }

  /**
   * Validate input and produce wire-form output: `Schema.encode` first, with a
   * `decode → encode` fallback for inputs already in encoded shape. Mirrors
   * the Entity write path (`encodeOrDecodeEncode` in `Entity.ts`).
   */
  const encodeToWire = (
    codec: Schema.Codec<any>,
    input: unknown,
    operation: string,
    errorEntityType: string = entityType,
  ): Effect.Effect<unknown, ValidationError> =>
    Schema.encodeUnknownEffect(codec)(input).pipe(
      Effect.catch((primaryCause) =>
        Schema.decodeUnknownEffect(codec)(input).pipe(
          Effect.flatMap((decoded) => Schema.encodeUnknownEffect(codec)(decoded)),
          // Surface the original encode error — its message is keyed on the
          // caller's input shape, which is what the user expects to see.
          Effect.catch(() =>
            Effect.fail(
              new ValidationError({ entityType: errorEntityType, operation, cause: primaryCause }),
            ),
          ),
        ),
      ),
    )

  // ---------------------------------------------------------------------------
  // Decode a raw DynamoDB item → StreamEvent<TEvent>
  // ---------------------------------------------------------------------------

  const decodeEnvelope = Schema.decodeUnknownEffect(EventEnvelope)

  /**
   * An event's stored `data` → its wire form (plain JSON), by the stored
   * form. A native value costs one `typeof` check.
   */
  const unpackData = (
    stored: unknown,
    operation: string,
  ): Effect.Effect<unknown, ValidationError> =>
    typeof stored === "string" || stored instanceof Uint8Array
      ? withRegistry((registry) =>
          unpackStoredSync(stored, registry, { entityType, operation }, "data"),
        )
      : Effect.succeed(stored)

  /**
   * A raw event row (`Query.select`) with its `data` — when projected — as
   * plain parsed JSON, whatever its stored form (R3: a stream that switched
   * encoding holds a mix). Never schema-decoded. Only this stream's event
   * rows are read: a row of another type (`Query.ignoreOwnership`) is handed
   * back untouched, its `__edd_e__` borrowed for the check and stripped again.
   * In place, so the strip reaches the row returned.
   */
  const rawEventRow: Query.QueryRawRow = Object.assign(
    (raw: Record<string, unknown>) => {
      const stored = raw.data
      if (raw.__edd_e__ !== entityType) return Effect.succeed(raw)
      if (typeof stored !== "string" && !(stored instanceof Uint8Array)) return Effect.succeed(raw)
      return Effect.map(unpackData(stored, "EventStore.select"), (data) => {
        raw.data = data
        return raw
      })
    },
    { reads: ["__edd_e__"], attributes: ["data"] },
  )

  const decodeStreamEvent = (
    raw: Record<string, unknown>,
  ): Effect.Effect<StreamEvent<TEvent>, ValidationError> =>
    Effect.gen(function* () {
      const toValidationError = (operation: string) => (cause: unknown) =>
        new ValidationError({ entityType, operation, cause })

      const envelope = yield* decodeEnvelope(raw).pipe(
        Effect.mapError(toValidationError("EventStore.decode")),
      )

      // `data` is read by its stored form (#147): a native map as it is, a
      // JSON string (`S`) parsed, compressed binary (`B`) decompressed and
      // parsed — whatever the stream's current `storedAs` says.
      const wireData = yield* unpackData(raw.data, "EventStore.decode")
      const decoder = Schema.decodeUnknownEffect(eventUnion as Schema.Schema<TEvent>)
      const data = yield* (decoder(wireData) as Effect.Effect<TEvent, unknown>).pipe(
        Effect.mapError(toValidationError("EventStore.decode")),
      )

      // Metadata is decoded through its schema when the stream declares one —
      // the mirror of the encode performed by `append`. Streams without a
      // metadata schema surface the stored attribute map untouched.
      let metadata: unknown
      if (raw.metadata !== undefined) {
        metadata = metadataSchema
          ? yield* Schema.decodeUnknownEffect(metadataSchema as Schema.Schema<unknown>)(
              raw.metadata,
            ).pipe(Effect.mapError(toValidationError("EventStore.decode.metadata")))
          : raw.metadata
      }

      return {
        streamId: envelope.streamId,
        version: envelope.version,
        eventType: envelope.eventType,
        data,
        metadata,
        timestamp: envelope.timestamp,
      }
    }) as Effect.Effect<StreamEvent<TEvent>, ValidationError>

  // ---------------------------------------------------------------------------
  // append
  // ---------------------------------------------------------------------------

  /**
   * One value an index function derives for an item (#140, #149): an event's
   * `key` or `partition`, a string or `undefined` to leave the item out.
   * Another type, or a function that throws, is a `ValidationError`, raised
   * before anything is written. DynamoDB's own rules on a key — not empty, at
   * most 1024 bytes for a sort key and 2048 for a partition key — are not
   * pre-checked: DynamoDB rejects the write and the rejection is diagnosed,
   * naming the index and the item (see `sendAppendTransaction`).
   */
  const deriveIndexValue = (
    idx: ResolvedStreamIndex,
    what: "key" | "partition",
    subject: string,
    derive: () => unknown,
  ): Effect.Effect<string | undefined, ValidationError> =>
    Effect.try({
      try: derive,
      catch: (cause) =>
        new ValidationError({ entityType, operation: "EventStore.append.indexes", cause }),
    }).pipe(
      Effect.flatMap((derived) => {
        if (derived === undefined) return Effect.succeed(undefined)
        // A string, or the event is not indexed: what the stream's own key
        // contract means, which DynamoDB cannot see (a number would be sent
        // as `N`). An empty string is DynamoDB's to reject, and is diagnosed
        // from its rejection, naming the index and the event (#144).
        if (typeof derived !== "string") {
          return Effect.fail(
            new ValidationError({
              entityType,
              operation: "EventStore.append.indexes",
              cause:
                `The ${what} of index "${idx.name}" for ${subject} must be a string or ` +
                `undefined; received ${String(derived)}. Nothing was written.`,
            }),
          )
        }
        return Effect.succeed(derived)
      }),
    )

  /**
   * The snapshot's entry in a stream index (#149): its partition and key, or
   * `undefined` to leave it out. Anything but an object of two strings, or an
   * entry function that throws, is a `ValidationError` before anything is
   * written; DynamoDB's rules on the values are its own, as for events.
   */
  const deriveSnapshotEntry = (
    idx: ResolvedStreamIndex,
    entry: StreamIndexSnapshotEntry<unknown>,
    state: unknown,
    streamId: StreamIndexStreamId,
    asOfVersion: number,
    operation: string,
  ): Effect.Effect<
    { readonly partition: string; readonly key: string } | undefined,
    ValidationError
  > =>
    Effect.try({
      try: () => entry(state, asOfVersion, streamId),
      catch: (cause) => new ValidationError({ entityType: snapshotEntityType, operation, cause }),
    }).pipe(
      Effect.flatMap((derived: unknown) => {
        if (derived === undefined) return Effect.succeed(undefined)
        const { partition, key } =
          typeof derived === "object" && derived !== null
            ? (derived as { readonly partition?: unknown; readonly key?: unknown })
            : { partition: undefined, key: undefined }
        if (typeof partition !== "string" || typeof key !== "string") {
          return Effect.fail(
            new ValidationError({
              entityType: snapshotEntityType,
              operation,
              cause:
                `The snapshot entry of index "${idx.name}" at version ${asOfVersion} must be ` +
                "{ partition: string, key: string } or undefined; received " +
                `${derived !== null && typeof derived === "object" ? JSON.stringify(derived) : String(derived)}. ` +
                "Nothing was written.",
            }),
          )
        }
        return Effect.succeed({ partition, key })
      }),
    )

  /**
   * Encode snapshot state to wire form through the state schema, with the
   * same `decode → encode` fallback as events and metadata. A structurally
   * matching plain object — what an immutable `evolve` that spreads a
   * `Schema.Class` state returns (`({ ...s, balance })`), which TypeScript
   * accepts as the class type — is decoded into the schema's type first
   * rather than refused with `Expected <Class>`.
   */
  const encodeSnapshotState = (
    state: unknown,
    operation: string,
  ): Effect.Effect<unknown, ValidationError> =>
    encodeToWire(
      (snapshot as SnapshotConfig).schema as Schema.Codec<unknown>,
      state,
      operation,
      snapshotEntityType,
    )

  /**
   * Map a failed `TransactWriteItems` of an append to its verdict. Resolves to
   * the race a guarded additional put lost (so the transaction is built and
   * written again), and fails with every other verdict.
   */
  const sendAppendTransaction = (
    client: DynamoClientService,
    tx: AppendTransaction,
    streamIdStr: string,
    commandId: string | undefined,
  ): Effect.Effect<OptimisticLockError | ConcurrentModification | undefined, AppendError> => {
    const sent = () => ({ _tag: "Transaction" as const, items: tx.items, targets: tx.targets })
    const diagnosed = (
      diagnosis: Diagnosis,
      original: unknown,
    ): AppendTooLarge | ValidationError =>
      diagnosis._tag === "TooManyItems"
        ? new AppendTooLarge({
            streamName: config.streamName,
            streamId: streamIdStr,
            count: diagnosis.count,
            limit: diagnosis.limit,
            cause: original,
          })
        : appendLimitError(diagnosis, original, tx)
    return client.transactWriteItems({ TransactItems: tx.items }).pipe(
      Effect.as(undefined),
      // One operation per item (#133, #144): diagnosed BEFORE the conditional
      // mapping below — DynamoDB can report a repeated item as a conditional
      // failure, which would read as a version conflict or a lost race (and
      // be retried). Terminal.
      diagnoseFailure({ sent, only: ["RepeatedItem"], rewrite: diagnosed }),
      Effect.catch(
        (
          error: DynamoClientError | AppendTooLarge | ValidationError,
        ): Effect.Effect<OptimisticLockError | ConcurrentModification, AppendError> => {
          if (!isAwsTransactionCancelled(error.cause)) {
            return Effect.fail(error)
          }
          const rawReasons = error.cause.CancellationReasons ?? []
          const reasons = rawReasons.map((r) => ({
            code: r?.Code,
            message: r?.Message,
          }))
          const failedAt = (index: number): boolean =>
            index >= 0 && reasons[index]?.code === "ConditionalCheckFailed"

          // Precedence is ordered by how terminal the caller's response should
          // be: a duplicate can never succeed on retry, a version conflict
          // invites a re-read, and only then are the additional items judged.
          if (commandId !== undefined && failedAt(tx.sentinelIndex)) {
            return Effect.fail(
              new DuplicateCommand({
                streamName: config.streamName,
                streamId: streamIdStr,
                commandId,
              }),
            )
          }

          // The contiguity ConditionCheck and the event puts both mean "the
          // stream is not where you said it was", so they share one verdict.
          for (let i = 0; i < tx.guardCount + tx.eventCount; i++) {
            if (failedAt(i)) {
              return Effect.fail(
                new VersionConflict({
                  streamName: config.streamName,
                  streamId: streamIdStr,
                  expectedVersion: tx.expectedVersion,
                }),
              )
            }
          }

          // The additional items, attributed back to the caller OPS that
          // produced them (several items can belong to one op). Only an op's
          // own condition is `AdditionalItemConditionFailed`: a guarded put
          // the caller set no condition on reports what the entity's own put
          // would — a taken unique value, a history conflict — or, having
          // lost a race to a concurrent write, is written again (#133).
          const judged = judgeCancellation(tx.additional, rawReasons, tx.guardCount + tx.eventCount)
          if (judged?._tag === "fail") return Effect.fail(judged.error)
          if (judged?._tag === "conditions") {
            return Effect.fail(
              new AdditionalItemConditionFailed({
                streamName: config.streamName,
                streamId: streamIdStr,
                indices: judged.opIndices,
                reasons,
              }),
            )
          }
          if (judged?._tag === "retry") return Effect.succeed(judged.error)

          // No conditional failure we can positionally justify (throttling,
          // TransactionConflict, a reason at the inline snapshot's position, or
          // a truncated/absent reason list) — never guess a VersionConflict.
          return Effect.fail(
            new TransactionCancelled({
              operation: "TransactWriteItems",
              reasons,
              cause: error.cause,
            }),
          )
        },
      ),
      // DynamoDB's limits are not pre-checked (#144): a rejection the
      // conditional mapping above could not explain is diagnosed against the
      // transaction sent, naming the event, sentinel, snapshot or additional
      // item at fault. Over 100 items is `AppendTooLarge`, with the EXPANDED
      // count.
      diagnoseFailure({
        sent,
        keys: () =>
          mergeKeyAttributes(
            {
              partition: ["pk", ...streamIndexes.map((idx) => idx.pk)],
              sort: ["sk", ...streamIndexes.map((idx) => idx.sk)],
            },
            tx.additional.keys(),
          ),
        rewrite: diagnosed,
      }),
    )
  }

  /**
   * A diagnosed rejection of an append (#144) other than its item count. An
   * over-long (or empty) stream-index key OF AN EVENT OR THE INLINE SNAPSHOT
   * — a value an index function returned — is named by its index and item,
   * as the `indexes` option reports its other key problems (see
   * {@link indexKeyError}). Only the stream's own items carry stream-index
   * keys: an additional item writing the same physical attribute
   * (single-table designs share `gsi1sk` and the like) is its own entity's
   * key, and is named as any other item.
   */
  const appendLimitError = (
    diagnosis: Diagnosis,
    original: unknown,
    tx: AppendTransaction,
  ): ValidationError => {
    if (diagnosis._tag === "KeyTooLong" || diagnosis._tag === "EmptyKey") {
      const position = tx.targets().indexOf(diagnosis.target)
      const isEvent = position >= tx.guardCount && position < tx.guardCount + tx.eventCount
      const isSnapshot = position >= 0 && position === tx.snapshotIndex
      const named =
        isEvent || isSnapshot
          ? indexKeyError(
              diagnosis,
              original,
              isSnapshot,
              "the append",
              "EventStore.append.indexes",
            )
          : undefined
      if (named !== undefined) return named
    }
    return diagnosedValidationError(diagnosis, original, {
      operation: "EventStore.append",
      entityType,
    })
  }

  /**
   * An over-long or empty key value in a stream-index attribute of an event
   * or snapshot item, named by its index and item, or `undefined` when the
   * attribute is not one the item's indexes derive. An event carries each
   * index's `key` (and a derived `partition`); a snapshot, each snapshot
   * index's entry. A stream-scoped GSI's partition is the stream's own key,
   * which no function returned: it is named as any key.
   */
  const indexKeyError = (
    diagnosis: Extract<Diagnosis, { readonly _tag: "KeyTooLong" | "EmptyKey" }>,
    original: unknown,
    isSnapshot: boolean,
    request: string,
    operation: string,
  ): ValidationError | undefined => {
    const candidates = isSnapshot ? snapshotIndexes : streamIndexes
    const kind =
      diagnosis._tag === "KeyTooLong"
        ? diagnosis.kind
        : candidates.some((idx) => idx.sk === diagnosis.attribute)
          ? "sort"
          : "partition"
    const idx = candidates.find((candidate) =>
      kind === "sort"
        ? candidate.sk === diagnosis.attribute
        : candidate.partition === "derived" && candidate.pk === diagnosis.attribute,
    )
    if (idx === undefined) return undefined
    const value = isSnapshot
      ? `The snapshot entry's ${kind === "sort" ? "key" : "partition"}`
      : `The ${kind === "sort" ? "key" : "partition"}`
    const leaveOut = isSnapshot
      ? "the snapshot function must return non-empty strings, or undefined to leave the " +
        "snapshot out of the index."
      : `the ${kind === "sort" ? "key" : "partition"} function must return a non-empty ` +
        "string, or undefined to leave the event out of the index."
    return new ValidationError({
      entityType: isSnapshot ? snapshotEntityType : entityType,
      operation,
      cause: withCause(
        `${value} of index "${idx.name}" for ${diagnosis.target.source} ` +
          (diagnosis._tag === "KeyTooLong"
            ? `is ${diagnosis.bytes} bytes, longer than DynamoDB's ` +
              `${kind === "sort" ? "1024-byte limit for a sort" : "2048-byte limit for a partition"} key.`
            : `is an empty string, which DynamoDB does not accept as a key value; ${leaveOut}`) +
          ` DynamoDB rejected ${request}. Nothing was written.`,
        original,
      ),
    })
  }

  /**
   * The snapshot item for `state` at `asOfVersion`: the state encoded through
   * the state schema, then packed per `snapshot.storedAs` (#147) — so every
   * size measured afterwards is stored bytes — with its entry in each index
   * that holds snapshots (#149). Shared by `writeSnapshot`, the inline
   * snapshot of `append`, and `measureSnapshot` / `measureAppend`.
   *
   * `eventPartitions` — the partition the append's events have in each
   * index, by index name — is what the inline snapshot's entry must match.
   */
  const buildSnapshotItem = (
    streamId: Record<string, unknown>,
    state: unknown,
    asOfVersion: number,
    now: string,
    operation: string,
    eventPartitions?: ReadonlyMap<string, IndexPartitionOrigin> | undefined,
  ): Effect.Effect<Record<string, AttributeValue>, ValidationError> =>
    Effect.gen(function* () {
      const encoded = yield* encodeSnapshotState(state, operation)
      const stored =
        stateStoredAs === undefined
          ? encoded
          : yield* packValue(stateStoredAs, encoded, yield* currentRegistry, {
              entityType: snapshotEntityType,
              attribute: "state",
              operation: `${operation}.packed`,
            })
      const item: Record<string, unknown> = {
        pk: composeStreamPk(streamId),
        sk: snapshotSk,
        __edd_e__: snapshotEntityType,
        streamId: composeStreamIdString(streamId),
        asOfVersion,
        state: stored,
        timestamp: now,
      }
      // The snapshot's index entries (#149), stored raw on the item itself,
      // so they are written by the same `Put` and count towards its size.
      for (const idx of snapshotIndexes) {
        const entry = yield* deriveSnapshotEntry(
          idx,
          idx.snapshotEntry as StreamIndexSnapshotEntry<unknown>,
          state,
          streamId as StreamIndexStreamId,
          asOfVersion,
          operation,
        )
        if (entry === undefined) continue
        const events = eventPartitions?.get(idx.name)
        if (events !== undefined && events.partition !== entry.partition) {
          return yield* new ValidationError({
            entityType: snapshotEntityType,
            operation,
            cause:
              `The inline snapshot's partition in index "${idx.name}" is ` +
              `${JSON.stringify(entry.partition)}, but ${events.subject} has ` +
              `${JSON.stringify(events.partition)}: an append's events and its inline snapshot ` +
              "must be in the same partition of an index. Nothing was written.",
          })
        }
        item[idx.pk] = entry.partition
        item[idx.sk] = entry.key
      }
      return toAttributeMap(item)
    })

  /**
   * The stream's own items of an append — everything but the caller's
   * `additionalItems` — validated and built exactly as `append` sends them.
   * Shared by `append` and `measureAppend`, so a measurement is the size of
   * the request `append` would send. `undefined` for an append with nothing
   * to write (the historical no-op).
   */
  const buildAppend = (
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options: AppendOptions<unknown, unknown> | undefined,
  ): Effect.Effect<AppendParts | undefined, ValidationError, TableConfig> =>
    Effect.gen(function* () {
      const additionalOps = options?.additionalItems ?? []
      const idempotency = options?.idempotency
      const snapshotState = options?.snapshot
      const eventMetadata = options?.eventMetadata

      // Per-event metadata (#144) is checked first — ahead of the no-op fast
      // path below, which would otherwise accept `append(id, [], v,
      // { eventMetadata: [m] })` without looking at it.
      if (eventMetadata !== undefined) {
        if (options?.metadata !== undefined) {
          return yield* new ValidationError({
            entityType,
            operation: "EventStore.append.eventMetadata",
            cause:
              "metadata and eventMetadata are mutually exclusive: pass one value shared by " +
              "every event, or one entry per event. Nothing was written.",
          })
        }
        if (!Array.isArray(eventMetadata) || eventMetadata.length !== events.length) {
          return yield* new ValidationError({
            entityType,
            operation: "EventStore.append.eventMetadata",
            cause:
              `eventMetadata has ${Array.isArray(eventMetadata) ? eventMetadata.length : "no"} ` +
              `entries for ${events.length} events: it needs exactly one entry (or undefined) ` +
              "per event, in order. Nothing was written.",
          })
        }
      }

      // Per-event timestamps (#144), checked alongside the metadata and for
      // the same reason: ahead of the no-op fast path.
      const eventTimestamps = options?.eventTimestamps
      if (eventTimestamps !== undefined) {
        const problem = eventTimestampsProblem(
          eventTimestamps,
          events.length,
          "eventTimestamps has",
          `${events.length} events`,
        )
        if (problem !== undefined) {
          return yield* new ValidationError({
            entityType,
            operation: "EventStore.append.eventTimestamps",
            cause: `${problem} Nothing was written.`,
          })
        }
      }

      if (snapshotState !== undefined && snapshot === undefined) {
        return yield* snapshotUnavailable("append({ snapshot })")
      }

      // Nothing at all to write — preserve the historical no-op fast path.
      // With additional items or a dedup sentinel the transaction still runs:
      // a caller who asked for a side write means it, and silently dropping it
      // would lose data.
      if (
        events.length === 0 &&
        additionalOps.length === 0 &&
        idempotency === undefined &&
        snapshotState === undefined
      ) {
        return undefined
      }

      // Resolve stream ID string for storage (join composites)
      const streamIdStr = composeStreamIdString(streamId as Record<string, unknown>)

      // An inline snapshot is unconditional because the event puts prove this
      // writer owns its version. Without events nothing proves it, and an
      // unconditional put could regress the snapshot.
      if (snapshotState !== undefined && events.length === 0) {
        return yield* new ValidationError({
          entityType: snapshotEntityType,
          operation: "EventStore.append.snapshot",
          cause:
            "An inline snapshot requires at least one event: nothing else proves the writer " +
            `owns version ${expectedVersion}. Nothing was written.`,
        })
      }

      // DynamoDB's 100-item limit on one transaction is not pre-checked
      // (#144): an append is never split — splitting would break its
      // atomicity — so one over the limit is rejected whole by DynamoDB and
      // reported as `AppendTooLarge`, with the expanded item count.
      const needsContiguityCheck = expectedVersion > 0 && events.length > 0

      const tableConfig = yield* config.table.Tag
      const tableName = tableConfig.name

      // A custom TTL attribute is only known at runtime. An index key attribute
      // sharing its name would receive the sentinel's numeric TTL, which a
      // string-typed index key rejects — refuse it before anything is written.
      const ttlAttribute = resolveTtlAttributeName(tableConfig)
      if (indexAttributes.includes(ttlAttribute)) {
        return yield* new ValidationError({
          entityType,
          operation: "EventStore.append.indexes",
          cause:
            `An index of stream "${config.streamName}" uses the attribute "${ttlAttribute}", ` +
            "which is the table's TTL attribute. Choose another index attribute name. " +
            "Nothing was written.",
        })
      }

      const pk = composeStreamPk(streamId as Record<string, unknown>)
      // Clock-backed timestamp (deterministic under TestClock; wall-clock in prod).
      const nowDateTime = yield* DateTime.now
      const now = DateTime.formatIso(nowDateTime)
      // The compressor registry in scope, for packed `data` / `state` (#147).
      const registry = yield* currentRegistry

      // Validate and encode metadata to wire form if schema provided. Shared
      // by every event; per-event `eventMetadata` is encoded in the loop below.
      let encodedMetadata: Record<string, unknown> | undefined
      if (options?.metadata !== undefined && metadataSchema) {
        const encoded = yield* encodeToWire(
          metadataSchema as Schema.Codec<any>,
          options.metadata,
          "EventStore.append.metadata",
        )
        encodedMetadata = encoded as Record<string, unknown>
      } else if (options?.metadata !== undefined) {
        encodedMetadata = options.metadata as Record<string, unknown>
      }

      // The partition the events have in each index that derives one (#149),
      // by index name, with the first event that has it: the events and the
      // inline snapshot of one append must agree.
      const eventPartitions = new Map<string, IndexPartitionOrigin>()

      // Build the event puts — one Put per event, each with attribute_not_exists(pk).
      // Events are encoded to wire form through their schema (codec symmetry
      // with the read path, which decodes through the same schema), so this is
      // an effectful build rather than a plain `map`.
      const eventItems: ReadonlyArray<TransactWriteItem> = yield* Effect.forEach(
        events,
        (event, i) =>
          Effect.gen(function* () {
            const version = expectedVersion + i + 1
            // In Effect v4, Schema.Class instances don't have _tag as an own property.
            // The identifier is on the constructor (class) itself.
            const evtType =
              ((event as Record<string, unknown>)._tag as string | undefined) ??
              (event as { constructor: { identifier?: string } }).constructor.identifier ??
              (event as { constructor: { name: string } }).constructor.name

            const wire = yield* encodeToWire(
              memberSchemaFor(event) as Schema.Codec<any>,
              event,
              "EventStore.append",
            )

            // Inject _tag for plain Schema.Class events; Schema.TaggedClass
            // events already carry _tag in their encoded form, which wins.
            const eventData = { _tag: evtType, ...(wire as Record<string, unknown>) }

            // Packed `data` (#147): one JSON string, or compressed binary at
            // or over the threshold when that is smaller — packed here, before
            // marshalling, so every size measured afterwards is stored bytes.
            const storedData =
              dataStoredAs === undefined
                ? eventData
                : yield* packValue(dataStoredAs, eventData, registry, {
                    entityType,
                    attribute: "data",
                    operation: "EventStore.append.packed",
                  })

            // This event's own metadata entry (#144), encoded as `metadata`
            // is; an `undefined` entry writes no metadata attribute.
            let itemMetadata = encodedMetadata
            if (eventMetadata !== undefined) {
              const entry = eventMetadata[i]
              itemMetadata =
                entry === undefined
                  ? undefined
                  : metadataSchema
                    ? ((yield* encodeToWire(
                        metadataSchema as Schema.Codec<any>,
                        entry,
                        `EventStore.append.eventMetadata[${i}]`,
                      )) as Record<string, unknown>)
                    : (entry as Record<string, unknown>)
            }

            // This event's own timestamp (#144), or the append's `now`.
            // `formatIso` renders the UTC instant, so a zoned DateTime is
            // stored in the same format as `now`.
            const eventTimestamp = eventTimestamps?.[i]

            // Exactly the table key and EVENT_ITEM_ATTRIBUTES — what a
            // "withoutMetadata" stream index projects — checked by the type.
            const envelope: { readonly [K in "pk" | "sk" | EventItemAttribute]: unknown } = {
              pk,
              sk: composeEventSk(version),
              __edd_e__: entityType,
              streamId: streamIdStr,
              version,
              eventType: evtType,
              data: storedData,
              timestamp: eventTimestamp === undefined ? now : DateTime.formatIso(eventTimestamp),
            }
            const item: Record<string, unknown> = { ...envelope }
            if (itemMetadata !== undefined) {
              item.metadata = itemMetadata
            }

            // Stream indexes (#140): the derived key, stored raw, and for a
            // GSI the stream's partition key — or the derived partition, raw
            // too (#149). The attributes are part of the event item itself,
            // so they count towards the size checks. Both functions run for
            // every event, so each one's contract is checked on every event.
            const subject = `the event at version ${version}`
            for (const idx of streamIndexes) {
              const derived = yield* deriveIndexValue(idx, "key", subject, () =>
                idx.key(event, version, streamId),
              )
              let partition: string | undefined = pk
              if (idx.derivePartition !== undefined) {
                const derivePartition = idx.derivePartition
                partition = yield* deriveIndexValue(idx, "partition", subject, () =>
                  derivePartition(event, version, streamId),
                )
                if (partition !== undefined) {
                  const first = eventPartitions.get(idx.name)
                  if (first === undefined) {
                    eventPartitions.set(idx.name, { partition, subject })
                  } else if (first.partition !== partition) {
                    return yield* new ValidationError({
                      entityType,
                      operation: "EventStore.append.indexes",
                      cause:
                        `The partition of index "${idx.name}" for ${subject} is ` +
                        `${JSON.stringify(partition)}, but ${first.subject} has ` +
                        `${JSON.stringify(first.partition)}: every event of one append must be ` +
                        "in the same partition of an index. Nothing was written.",
                    })
                  }
                }
              }
              if (derived === undefined || partition === undefined) continue
              item[idx.sk] = derived
              if (idx.type === "gsi") item[idx.pk] = partition
            }

            return {
              Put: {
                TableName: tableName,
                Item: toAttributeMap(item),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            }
          }),
      )

      // The idempotency sentinel: a Put guarded by `attribute_not_exists(pk)`.
      let sentinelPut: TransactWriteItem | undefined
      if (idempotency !== undefined) {
        const sentinel: Record<string, unknown> = {
          pk,
          sk: composeCommandSk(idempotency.commandId),
          __edd_e__: commandEntityType,
          streamId: streamIdStr,
          commandId: idempotency.commandId,
          version: expectedVersion + events.length,
          timestamp: now,
        }
        if (idempotency.ttl !== undefined) {
          const ttlSeconds = yield* Effect.try({
            try: () => normalizeTtlSeconds(idempotency.ttl as Duration.Duration | string),
            catch: (cause) =>
              new ValidationError({
                entityType: commandEntityType,
                operation: "EventStore.append.idempotency.ttl",
                cause,
              }),
          })
          sentinel[ttlAttribute] = DateTime.toEpochSeconds(nowDateTime) + ttlSeconds
        }
        sentinelPut = {
          Put: {
            TableName: tableName,
            Item: toAttributeMap(sentinel),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        }
      }

      // The inline snapshot (#138): unconditional — see AppendOptions.snapshot.
      // Packed per `snapshot.storedAs` (#147), so the transaction-size and
      // item-size diagnosis count its stored bytes.
      let snapshotPut: TransactWriteItem | undefined
      if (snapshotState !== undefined) {
        snapshotPut = {
          Put: {
            TableName: tableName,
            Item: yield* buildSnapshotItem(
              streamId as Record<string, unknown>,
              snapshotState,
              expectedVersion + events.length,
              now,
              "EventStore.append.snapshot",
              eventPartitions,
            ),
          },
        }
      }

      /**
       * Version-contiguity guard: `attribute_not_exists(pk)` on the event puts
       * only rejects STALE expected versions (the target slot already exists).
       * An AHEAD expectedVersion (e.g. 10 when the stream is at 3) would
       * silently write from version 11, leaving a permanent gap. When events
       * are written after version > 0, require the event at exactly
       * `expectedVersion` to exist so the appended range is contiguous with the
       * stream head. Its failure surfaces as a ConditionalCheckFailed
       * cancellation reason, mapping to VersionConflict just like a
       * stale-version Put failure. A zero-event append (a pure side write)
       * writes no version and so can open no gap.
       */
      const contiguityCheck: TransactWriteItem | undefined = needsContiguityCheck
        ? {
            ConditionCheck: {
              TableName: tableName,
              Key: toAttributeMap({ pk, sk: composeEventSk(expectedVersion) }),
              ConditionExpression: "attribute_exists(pk)",
            },
          }
        : undefined

      const parts: AppendParts = {
        tableName,
        streamIdStr,
        contiguityCheck,
        eventItems,
        sentinelPut,
        snapshotPut,
      }
      return parts
    }) as Effect.Effect<AppendParts | undefined, ValidationError, TableConfig>

  const append = (
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: AppendOptions<unknown, unknown> | undefined,
  ) =>
    Effect.gen(function* () {
      const additionalOps = options?.additionalItems ?? []
      const idempotency = options?.idempotency

      const parts = yield* buildAppend(streamId, events, expectedVersion, options)
      if (parts === undefined) return { version: expectedVersion, events: [] }
      const { tableName, streamIdStr, contiguityCheck, eventItems, sentinelPut, snapshotPut } =
        parts

      const client = yield* DynamoClient

      /**
       * Lay out the append's one transaction — see {@link AppendTransaction}:
       *   [0, C)                version-contiguity ConditionCheck (C is 0 or 1)
       *   [C, C + E)            event puts
       *   [C + E, C + E + A)    additional ITEMS (caller op order preserved)
       *   then                  idempotency sentinel, then inline snapshot
       *                         (last, so adding them never shifts the
       *                         additional-item indices the caller sees)
       *
       * `A` is the count of EMITTED items, which is >= the number of caller
       * ops: a guarded put (#133) expands into its item plus its sentinel
       * reservations and releases plus a snapshot. The caller-facing `indices`
       * on `AdditionalItemConditionFailed` are still indices into the caller's
       * `additionalItems` array — `judgeCancellation` maps them.
       */
      const layout = (additional: BuiltTransactWriteItems): AppendTransaction => {
        const items: Array<TransactWriteItem> = []
        // What names each item, so the targets are built only on failure.
        const naming: Array<() => ReadonlyArray<TransactItemTarget>> = []
        const pushStreamItem = (item: TransactWriteItem, type: string, source: string) => {
          items.push(item)
          naming.push(() => [transactItemTarget(item, tableName, ["pk", "sk"], type, source)])
        }
        if (contiguityCheck !== undefined) {
          pushStreamItem(contiguityCheck, entityType, "the version-contiguity check")
        }
        const guardCount = items.length
        for (const [i, item] of eventItems.entries()) {
          pushStreamItem(item, entityType, `the event at version ${expectedVersion + i + 1}`)
        }
        items.push(...additional.items)
        naming.push(additional.targets)
        const sentinelIndex = sentinelPut === undefined ? -1 : items.length
        if (sentinelPut !== undefined) {
          pushStreamItem(sentinelPut, entityType, "the idempotency sentinel")
        }
        const snapshotIndex = snapshotPut === undefined ? -1 : items.length
        if (snapshotPut !== undefined) {
          pushStreamItem(snapshotPut, snapshotEntityType, "the inline snapshot")
        }
        let targets: ReadonlyArray<TransactItemTarget> | undefined
        return {
          items,
          // Built once, on failure: a diagnosis's target is found by identity.
          targets: () => (targets ??= naming.flatMap((name) => name())),
          guardCount,
          eventCount: eventItems.length,
          additional,
          sentinelIndex,
          snapshotIndex,
          expectedVersion,
        }
      }

      // A guarded put among the additional items reads its item; a race with
      // that read cancels the append, which is then built and written again.
      let lost: OptimisticLockError | ConcurrentModification | undefined
      for (let attempt = 0; attempt < GUARDED_TRANSACTION_ATTEMPTS; attempt++) {
        // Caller-owned items, compiled through the same builder
        // `Transaction.transactWrite` uses, so the two APIs cannot drift.
        const additional = yield* buildTransactWriteItems(
          additionalOps,
          "EventStore.append.additionalItems",
        )
        const tx = layout(additional)

        // DynamoDB's rules — one operation per item (an additional item
        // repeating an event, the contiguity check, the idempotency sentinel
        // or the inline snapshot, or another additional item), 100 items,
        // 4 MB, 400 KB per item, 1024-byte sort keys — are not pre-checked:
        // `sendAppendTransaction` diagnoses DynamoDB's rejection (#144). The
        // items carry packed `data` / `state` as stored (#147), so the
        // diagnosis attributes stored bytes.
        const outcome = yield* sendAppendTransaction(
          client,
          tx,
          streamIdStr,
          idempotency?.commandId,
        )
        if (outcome === undefined) {
          return { version: expectedVersion + events.length, events }
        }
        lost = outcome
      }
      return yield* Effect.fail(lost!)
    })

  // ---------------------------------------------------------------------------
  // measureAppend / measureSnapshot — caller-side size planning (#147, R1)
  // ---------------------------------------------------------------------------

  const measureAppend = (
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: MeasureAppendOptions<unknown, unknown> | undefined,
  ): Effect.Effect<AppendMeasurement, ValidationError, TableConfig> =>
    Effect.gen(function* () {
      if ((options as { additionalItems?: unknown } | undefined)?.additionalItems !== undefined) {
        return yield* new ValidationError({
          entityType,
          operation: "EventStore.measureAppend",
          cause:
            "measureAppend does not measure additionalItems (building a guarded put reads the " +
            "table): measure the stream's own items without them, and add the size of your " +
            "own items.",
        })
      }
      const parts = yield* buildAppend(
        streamId,
        events,
        expectedVersion,
        options as AppendOptions<unknown, unknown> | undefined,
      )
      if (parts === undefined) {
        return { events: [], sentinel: undefined, snapshot: undefined, transactionBytes: 0 }
      }
      const putBytes = (item: TransactWriteItem): number => itemBytes(item.Put?.Item ?? {})
      const owned = [
        ...(parts.contiguityCheck === undefined ? [] : [parts.contiguityCheck]),
        ...parts.eventItems,
        ...(parts.sentinelPut === undefined ? [] : [parts.sentinelPut]),
        ...(parts.snapshotPut === undefined ? [] : [parts.snapshotPut]),
      ]
      const measurement: AppendMeasurement = {
        events: parts.eventItems.map(putBytes),
        sentinel: parts.sentinelPut === undefined ? undefined : putBytes(parts.sentinelPut),
        snapshot: parts.snapshotPut === undefined ? undefined : putBytes(parts.snapshotPut),
        transactionBytes: owned.reduce((sum, item) => sum + transactItemBytes(item), 0),
      }
      return measurement
    })

  const measureSnapshot = (
    streamId: StreamIdInput<TStreamIdFields>,
    state: unknown,
    asOfVersion: number,
  ): Effect.Effect<number, ValidationError, TableConfig> =>
    Effect.gen(function* () {
      if (snapshot === undefined) return yield* snapshotUnavailable("measureSnapshot")
      const now = DateTime.formatIso(yield* DateTime.now)
      const item = yield* buildSnapshotItem(
        streamId as Record<string, unknown>,
        state,
        asOfVersion,
        now,
        "EventStore.measureSnapshot",
      )
      return itemBytes(item)
    })

  // ---------------------------------------------------------------------------
  // decodeStreamImage — DynamoDB Streams records (#147, R2)
  // ---------------------------------------------------------------------------

  const decodeStreamImage = (
    image: StreamImage,
    options?: DecodeStreamImageOptions,
  ): Effect.Effect<Option.Option<StreamEvent<TEvent>>, ValidationError> =>
    Effect.gen(function* () {
      const ctx = { entityType, operation: "EventStore.decodeStreamImage" }
      // Not one of this stream's events — its snapshot, a sentinel, another
      // stream's or an entity's item: none, decided from the raw image before
      // anything is unmarshalled, so nothing in a foreign image can fail it.
      if (
        typeof image === "object" &&
        image !== null &&
        !Array.isArray(image) &&
        imageEntityType(image) !== entityType
      ) {
        return Option.none<StreamEvent<TEvent>>()
      }
      // In DynamoDB JSON the S / B tag says what `data` is; unmarshalled, a
      // string that is base64 of a `B` value is told apart from JSON text.
      const raw = yield* decodeImage(image, DATA_ATTRIBUTES, ctx)
      const event = yield* decodeStreamEvent(raw)
      if (options?.raw !== true) return Option.some(event)
      // `raw.data` is the wire form the decode just read: the parsed JSON of a
      // packed value, the unmarshalled map of a native one.
      const withRaw: RawStreamEvent<TEvent> = {
        ...event,
        rawData: raw.data as Readonly<Record<string, unknown>>,
      }
      return Option.some<StreamEvent<TEvent>>(withRaw)
    })

  // ---------------------------------------------------------------------------
  // read
  // ---------------------------------------------------------------------------

  /** Apply {@link ReadOptions} to an event query. */
  const withReadOptions = <A>(query: Query.Query<A>, options: ReadOptions | undefined) =>
    options?.consistentRead === true ? Query.consistentRead(query) : query

  const read = (
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadOptions | undefined,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      const query = withReadOptions(buildEventsQuery(streamId), options)
      return yield* Query.collect(query)
    })

  // ---------------------------------------------------------------------------
  // readFrom
  // ---------------------------------------------------------------------------

  const readFrom = (
    streamId: StreamIdInput<TStreamIdFields>,
    afterVersion: number,
    options?: ReadFromOptions | undefined,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      // Versions are integers, so the inclusive lower bound `afterVersion + 1`
      // is exactly the old exclusive `#sk > eventSk(afterVersion)`. The upper
      // bound keeps the snapshot item (which sorts after every event) out of the
      // scanned range; `toVersion` narrows it to the versions wanted.
      const upper =
        options?.toVersion === undefined ? maxEventSk : composeEventSk(options.toVersion)
      if (options?.toVersion !== undefined && options.toVersion <= afterVersion) return []
      const query = withReadOptions(
        buildEventsQuery(streamId).pipe(
          Query.where({ between: [composeEventSk(afterVersion + 1), upper] }),
        ),
        options,
      )
      return yield* Query.collect(query)
    })

  // ---------------------------------------------------------------------------
  // currentVersion
  // ---------------------------------------------------------------------------

  const currentVersion = (
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadOptions | undefined,
  ): Effect.Effect<number, DynamoClientError | ValidationError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      // Single page, not `collect`: with `Limit: 1` DynamoDB returns a
      // `LastEvaluatedKey` on every truncated page, so `collect` would walk the
      // whole partition one request per item. The `begins_with` bound on
      // `buildEventsQuery` guarantees the single evaluated item is the newest
      // *event* (never the snapshot, which sorts last).
      const query = withReadOptions(
        buildEventsQuery(streamId).pipe(Query.reverse, Query.limit(1)),
        options,
      )
      const page = yield* Query.execute(query)
      const newest = page.items[0]
      if (newest === undefined) return 0
      return newest.version
    })

  // headAbove (internal — see HeadAboveProbe)
  const headAbove = (
    streamId: Record<string, unknown>,
    floorVersion: number,
    options?: ReadOptions | undefined,
  ): Effect.Effect<number, DynamoClientError | ValidationError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      // Reverse, `Limit: 1`, bounded below by `floorVersion + 1`: an empty range
      // (the common case — nothing appended past the snapshot) reads no items;
      // otherwise the single evaluated item is the head.
      const query = withReadOptions(
        buildEventsQuery(streamId as StreamIdInput<TStreamIdFields>).pipe(
          Query.where({ between: [composeEventSk(floorVersion + 1), maxEventSk] }),
          Query.reverse,
          Query.limit(1),
        ),
        options,
      )
      const page = yield* Query.execute(query)
      const newest = page.items[0]
      return newest === undefined ? floorVersion : newest.version
    })

  // ---------------------------------------------------------------------------
  // Snapshot primitives
  // ---------------------------------------------------------------------------

  const snapshotUnavailable = (operation: string): Effect.Effect<never> =>
    Effect.die(
      new Error(
        `[EDD-9026] EventStream "${config.streamName}": ${operation} requires a snapshot config. ` +
          `Declare one with makeStream({ ..., snapshot: { schema } }).`,
      ),
    )

  const writeSnapshot = (
    streamId: StreamIdInput<TStreamIdFields>,
    state: unknown,
    asOfVersion: number,
  ): Effect.Effect<void, DynamoClientError | ValidationError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      if (snapshot === undefined) return yield* snapshotUnavailable("writeSnapshot")

      const client = yield* DynamoClient
      const { name: tableName } = yield* config.table.Tag
      const now = DateTime.formatIso(yield* DateTime.now)

      // Packed per `snapshot.storedAs` (#147): the diagnosis below measures
      // the stored bytes.
      const item = yield* buildSnapshotItem(
        streamId as Record<string, unknown>,
        state,
        asOfVersion,
        now,
        "EventStore.writeSnapshot",
      )

      const put = {
        TableName: tableName,
        Item: item,
        // Monotonic: never regress the cache. Losing this race is a no-op,
        // not an error — the events it summarises are already durable.
        ConditionExpression: "attribute_not_exists(#pk) OR #asOfVersion < :asOfVersion",
        ExpressionAttributeNames: { "#pk": "pk", "#asOfVersion": "asOfVersion" },
        ExpressionAttributeValues: toAttributeMap({ ":asOfVersion": asOfVersion }),
      }
      yield* client.putItem(put).pipe(
        Effect.catchIf(
          (error) => isAwsConditionalCheckFailed(error.cause),
          () => Effect.void,
        ),
        // An oversized snapshot is DynamoDB's to reject (#144); named here.
        diagnoseFailure({
          sent: () => ({
            _tag: "Item",
            item: { Put: put },
            target: () =>
              transactItemTarget(
                { Put: put },
                tableName,
                ["pk", "sk"],
                snapshotEntityType,
                "the snapshot",
              ),
          }),
          keys: () => ({
            partition: ["pk", ...snapshotIndexes.map((idx) => idx.pk)],
            sort: ["sk", ...snapshotIndexes.map((idx) => idx.sk)],
          }),
          // A snapshot index entry's empty or over-long value (#149) is named
          // by its index, as an inline snapshot's is.
          rewrite: (diagnosis, original) =>
            (diagnosis._tag === "KeyTooLong" || diagnosis._tag === "EmptyKey"
              ? indexKeyError(diagnosis, original, true, "the snapshot", "EventStore.writeSnapshot")
              : undefined) ??
            diagnosedValidationError(diagnosis, original, {
              operation: "EventStore.writeSnapshot",
              entityType: snapshotEntityType,
            }),
        }),
      )
    }) as Effect.Effect<void, DynamoClientError | ValidationError, DynamoClient | TableConfig>

  /**
   * Decode a stored snapshot item. A snapshot that fails to decode through the
   * state schema is a `ValidationError` — never silently discarded.
   */
  const decodeSnapshotItem = (
    raw: Record<string, unknown>,
    operation: string,
  ): Effect.Effect<Snapshot<unknown>, ValidationError> =>
    // `state` is read by its stored form (#147) when it may be packed — see
    // `stateDispatch` — then decoded through the state schema as before.
    (stateDispatch && (typeof raw.state === "string" || raw.state instanceof Uint8Array)
      ? withRegistry((registry) =>
          unpackStoredSync(
            raw.state as string | Uint8Array,
            registry,
            { entityType: snapshotEntityType, operation },
            "state",
          ),
        )
      : Effect.succeed(raw.state)
    ).pipe(
      Effect.flatMap((state) =>
        Schema.decodeUnknownEffect((snapshot as SnapshotConfig).schema as Schema.Codec<unknown>)(
          state,
        ).pipe(
          Effect.mapError(
            (cause) => new ValidationError({ entityType: snapshotEntityType, operation, cause }),
          ),
        ),
      ),
      Effect.map(
        (state): Snapshot<unknown> => ({
          state,
          asOfVersion: raw.asOfVersion as number,
          timestamp: raw.timestamp as string,
        }),
      ),
    )

  /** The raw snapshot item, by its exact key, in one `GetItem`. */
  const getSnapshotItem = (
    streamId: StreamIdInput<TStreamIdFields>,
    consistentRead: boolean,
  ): Effect.Effect<
    Record<string, unknown> | undefined,
    DynamoClientError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      const { name: tableName } = yield* config.table.Tag
      const result = yield* client.getItem({
        TableName: tableName,
        Key: toAttributeMap({
          pk: composeStreamPk(streamId as Record<string, unknown>),
          sk: snapshotSk,
        }),
        ...(consistentRead ? { ConsistentRead: true } : {}),
      })
      return result.Item === undefined ? undefined : fromAttributeMap(result.Item)
    }) as Effect.Effect<
      Record<string, unknown> | undefined,
      DynamoClientError,
      DynamoClient | TableConfig
    >

  const readSnapshot = (
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<
    Option.Option<Snapshot<unknown>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      if (snapshot === undefined) return yield* snapshotUnavailable("readSnapshot")
      const raw = yield* getSnapshotItem(streamId, true)
      if (raw === undefined) return Option.none<Snapshot<unknown>>()
      return Option.some(yield* decodeSnapshotItem(raw, "EventStore.readSnapshot"))
    }) as Effect.Effect<
      Option.Option<Snapshot<unknown>>,
      DynamoClientError | ValidationError,
      DynamoClient | TableConfig
    >

  // ---------------------------------------------------------------------------
  // readLatest — snapshot + delta + head in one request (#138)
  // ---------------------------------------------------------------------------

  const readLatest = (
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadLatestOptions | undefined,
  ): Effect.Effect<
    LatestState<unknown, TEvent>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      // Without a snapshot config there is nothing to read but the events
      // (`verifySnapshot` is ignored).
      if (snapshot === undefined) {
        const events = yield* read(streamId, options)
        return {
          snapshot: Option.none<Snapshot<unknown>>(),
          events,
          version: events[events.length - 1]?.version ?? 0,
        }
      }

      // `verifySnapshot: false` — the snapshot item alone, by its exact key:
      // a `GetItem` reads one item where the verified `Query` reads the
      // snapshot and at least the newest event. Its version is unverified
      // (see `ReadLatestOptions`). Without a snapshot item there is nothing to
      // trust, so fall through to the verified read.
      if (options?.verifySnapshot === false) {
        const refusal = unverifiedSnapshotRefusal(config.streamName, snapshotSettings, "readLatest")
        if (refusal !== undefined) return yield* Effect.die(new Error(refusal))
        const raw = yield* getSnapshotItem(streamId, options.consistentRead === true)
        if (raw !== undefined) {
          const current = yield* decodeSnapshotItem(raw, "EventStore.readLatest")
          return {
            snapshot: Option.some(current),
            events: [],
            version: current.asOfVersion,
          }
        }
      }

      const client = yield* DynamoClient
      const { name: tableName } = yield* config.table.Tag

      // One reverse Query over `[first event SK, snapshot SK]`: the snapshot
      // sorts after every event and the command sentinels before them (see
      // `snapshotSk`), so the range holds exactly the events and the snapshot,
      // and the snapshot is the first item evaluated. The `__edd_e__` filter is
      // belt and braces — `Limit` counts items before it applies.
      const base = {
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :first AND :snapshot",
        FilterExpression: "#e IN (:eventType, :snapshotType)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#e": "__edd_e__" },
        ExpressionAttributeValues: toAttributeMap({
          ":pk": composeStreamPk(streamId as Record<string, unknown>),
          ":first": eventSkPrefix,
          ":snapshot": snapshotSk,
          ":eventType": entityType,
          ":snapshotType": snapshotEntityType,
        }),
        ScanIndexForward: false,
        ...(options?.consistentRead === true ? { ConsistentRead: true } : {}),
      }

      let snapshotRaw: Record<string, unknown> | undefined
      /** Event items, newest first. */
      const eventRaws: Array<Record<string, unknown>> = []
      // The first page is sized for the snapshot plus a lag of up to `every`
      // events, so a current (or modestly lagging) snapshot loads in one
      // request.
      let limit: number | undefined = (snapshot.every ?? 1) + 1
      let startKey: Record<string, AttributeValue> | undefined
      for (;;) {
        const page = yield* client.query({
          ...base,
          ...(limit !== undefined ? { Limit: limit } : {}),
          ...(startKey !== undefined ? { ExclusiveStartKey: startKey } : {}),
        })
        for (const item of page.Items ?? []) {
          const raw = fromAttributeMap(item)
          if (raw.__edd_e__ === snapshotEntityType) snapshotRaw = raw
          else eventRaws.push(raw)
        }
        startKey = page.LastEvaluatedKey
        if (startKey === undefined) break
        // Without a snapshot (it would have been the first item evaluated),
        // read on, unlimited, to the start of the stream.
        if (snapshotRaw === undefined) {
          limit = undefined
          continue
        }
        // Done once the event right after the snapshot has been seen: versions
        // are contiguous, so every event the snapshot does not cover is then in
        // hand, and everything older is already folded into it. Otherwise read
        // exactly the events still missing, `asOfVersion + 1 … oldest - 1`
        // (DynamoDB's 1 MB page cap aside).
        const asOfVersion = snapshotRaw.asOfVersion as number
        const oldest = eventRaws[eventRaws.length - 1]?.version as number | undefined
        if (oldest !== undefined && oldest <= asOfVersion + 1) break
        limit = oldest === undefined ? undefined : oldest - asOfVersion - 1
      }

      const latest =
        snapshotRaw === undefined
          ? Option.none<Snapshot<unknown>>()
          : Option.some(yield* decodeSnapshotItem(snapshotRaw, "EventStore.readLatest"))
      const asOfVersion = Option.isSome(latest) ? latest.value.asOfVersion : 0
      const delta = eventRaws.filter((raw) => (raw.version as number) > asOfVersion).reverse()
      const events = yield* Effect.forEach(delta, (raw) => decodeStreamEvent(raw))
      return {
        snapshot: latest,
        events,
        version: events[events.length - 1]?.version ?? asOfVersion,
      }
    }) as Effect.Effect<
      LatestState<unknown, TEvent>,
      DynamoClientError | ValidationError,
      DynamoClient | TableConfig
    >

  // ---------------------------------------------------------------------------
  // hasCommandSentinel (internal — see CommandSentinelProbe)
  // ---------------------------------------------------------------------------

  const hasCommandSentinel = (
    streamId: Record<string, unknown>,
    commandId: string,
  ): Effect.Effect<boolean, DynamoClientError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      const { name: tableName } = yield* config.table.Tag
      const result = yield* client.getItem({
        TableName: tableName,
        Key: toAttributeMap({ pk: composeStreamPk(streamId), sk: composeCommandSk(commandId) }),
        ConsistentRead: true,
        ProjectionExpression: "#pk",
        ExpressionAttributeNames: { "#pk": "pk" },
      })
      return result.Item !== undefined
    }) as Effect.Effect<boolean, DynamoClientError, DynamoClient | TableConfig>

  // ---------------------------------------------------------------------------
  // query.events helper
  // ---------------------------------------------------------------------------

  const buildEventsQuery = (
    streamId: StreamIdInput<TStreamIdFields>,
  ): Query.Query<StreamEvent<TEvent>> => {
    const pk = composeStreamPk(streamId as Record<string, unknown>)
    return Query.make<StreamEvent<TEvent>>({
      tableName: "",
      indexName: undefined,
      pkField: "pk",
      pkValue: pk,
      skField: "sk",
      entityTypes: [entityType],
      decoder: (raw) => decodeStreamEvent(raw),
      // Raw rows (`Query.select`) carry `data` as parsed JSON, whatever its
      // stored form, and a filter inside a packed `data` is refused (#147).
      rawRow: rawEventRow,
      packed: dataGuards,
      resolveTableName: config.table.Tag.useSync((tc: TableConfig) => tc.name),
      keyFields: ["pk", "sk"],
      // Bound to the event SK range so non-event items in the stream partition
      // (the snapshot) are excluded at the key-condition level. A caller-supplied
      // `Query.where` replaces this — the `__edd_e__` filter still applies.
    }).pipe(Query.where({ beginsWith: eventSkPrefix }))
  }

  // ---------------------------------------------------------------------------
  // Stream indexes — query.index / readIndex (#140)
  // ---------------------------------------------------------------------------

  /**
   * @internal Why `partition` cannot be passed for index `name`, or
   * `undefined` when it can: required (a string) for an index that derives
   * its partition (#149), refused for any other. Unreachable through the
   * types. An unknown name is left to {@link buildIndexQuery}.
   */
  const invalidIndexPartition = (name: string, partition: unknown): string | undefined => {
    const idx = streamIndexes.find((candidate) => candidate.name === name)
    if (idx === undefined) return undefined
    if (idx.partition === "derived") {
      return typeof partition === "string"
        ? undefined
        : `Index "${name}" derives its partition: pass the partition to read as ` +
            `options.partition (a string); received ${String(partition)}.`
    }
    return partition === undefined
      ? undefined
      : `Index "${name}" is scoped to the stream; it takes no partition.`
  }

  /**
   * A query of one stream index. A stream-scoped index is queried in the
   * stream's partition: the LSI shares the table's `pk`; a GSI's `pk`
   * attribute carries the same value. No sort-key condition — the index holds
   * only this stream's indexed events under that key; `Query.where` narrows
   * the derived-key range.
   *
   * An index that derives its partition (#149) is queried in `partition`,
   * which other streams (and this one's other stream ids, and snapshots) may
   * share: the `__edd_e__` filter keeps this stream's events, and a filter on
   * the table's `pk` — projected by every index — keeps `streamId`'s.
   *
   * @throws `[EDD-9066]` for a name the stream does not declare (unreachable
   *   through the types).
   * @throws `[EDD-9080]` for a missing `partition` on an index that derives
   *   it, or one passed to an index that does not (unreachable through the
   *   types).
   */
  const buildIndexQuery = (
    name: string,
    streamId: StreamIdInput<TStreamIdFields>,
    partition: string | undefined,
  ): Query.Query<StreamEvent<TEvent>> => {
    const idx = streamIndexes.find((candidate) => candidate.name === name)
    if (idx === undefined) {
      throw new Error(
        `[EDD-9066] EventStream "${config.streamName}": unknown index "${String(name)}". ` +
          (streamIndexes.length === 0
            ? "The stream declares no indexes."
            : `Declared: ${streamIndexes.map((candidate) => `"${candidate.name}"`).join(", ")}.`),
      )
    }
    const partitionProblem = invalidIndexPartition(name, partition)
    if (partitionProblem !== undefined) {
      throw new Error(`[EDD-9080] EventStream "${config.streamName}": ${partitionProblem}`)
    }
    const streamPk = composeStreamPk(streamId as Record<string, unknown>)
    const query = Query.make<StreamEvent<TEvent>>({
      tableName: "",
      indexName: idx.index,
      pkField: idx.pk,
      pkValue: idx.partition === "derived" ? (partition as string) : streamPk,
      skField: idx.sk,
      entityTypes: [entityType],
      decoder: indexDecoder(idx),
      // As for `query.events` (#147) — the `"keys"` hydration path decodes
      // its fetched rows through the same hooks.
      rawRow: rawEventRow,
      packed: dataGuards,
      resolveTableName: config.table.Tag.useSync((tc: TableConfig) => tc.name),
      // DynamoDB's rejection of the key condition (an empty bound, a reversed
      // `between`) is named against the stream index; so, as for every
      // query, is a consistent read of a GSI (#144).
      keyConditionDiagnosis: {
        operation: "EventStore.readIndex",
        label: `EventStream "${config.streamName}" index "${idx.name}"`,
      },
      keyFields: [idx.pk, idx.sk, "pk", "sk"],
      // A "keys" index holds no events: an LSI has DynamoDB fetch them
      // (`Select: ALL_ATTRIBUTES`), a GSI fetches each page's with
      // `BatchGetItem` on the table key.
      ...(idx.projection === "keys"
        ? {
            hydration:
              idx.type === "lsi"
                ? ({ _tag: "Fetch" } as const)
                : ({ _tag: "BatchGet", tableKey: ["pk", "sk"] } as const),
          }
        : {}),
    })
    return idx.partition === "derived" ? Query.filterExpr(query, streamPkFilter(streamPk)) : query
  }

  /**
   * @internal The decoder of events read through `idx`.
   *
   * - `"withoutMetadata"` ignores any `metadata` on the row (an index deployed
   *   wider than declared still carries it), so the value matches the type.
   * - `"all"` / `"withoutMetadata"`: a decode failure on a row that lacks an
   *   attribute the declared projection guarantees is diagnosed as the
   *   deployed index projecting less than declared — a `ValidationError`
   *   (`operation: "EventStore.index.decode"`) naming the index, the original
   *   error kept as its cause. Anything else passes through unchanged.
   * - `"keys"` decodes items fetched from the table, so a missing attribute
   *   there is not a projection problem: failures pass through.
   */
  const indexDecoder =
    (idx: ResolvedStreamIndex) =>
    (raw: Record<string, unknown>): Effect.Effect<StreamEvent<TEvent>, ValidationError> => {
      if (idx.projection === "keys") return decodeStreamEvent(raw)
      let row = raw
      if (idx.projection === "withoutMetadata" && raw.metadata !== undefined) {
        row = { ...raw }
        delete row.metadata
      }
      return decodeStreamEvent(row).pipe(
        Effect.mapError((error) => {
          const missing = PROJECTED_ENVELOPE_ATTRIBUTES.filter((name) => row[name] === undefined)
          if (missing.length === 0) return error
          return new ValidationError({
            entityType,
            operation: "EventStore.index.decode",
            cause: withCause(
              `Stream index "${idx.name}" (physical "${idx.index}") is declared ` +
                `projection: "${idx.projection}", but its rows lack ${missing.join(", ")}: the ` +
                "deployed index likely projects less than declared. Deploy the Projection " +
                "EventStore.indexDefinitions emits for it.",
              error,
            ),
          })
        }),
      )
    }

  const readIndex = (
    name: string,
    streamId: StreamIdInput<TStreamIdFields>,
    options?: (ReadIndexOptions & { readonly partition?: string | undefined }) | undefined,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      const refuse = (cause: string) =>
        new ValidationError({ entityType, operation: "EventStore.readIndex", cause })
      const invalidCondition = invalidIndexKeyCondition(options)
      if (invalidCondition !== undefined) {
        return yield* refuse(`${invalidCondition} Nothing was sent.`)
      }
      const limit = options?.limit
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        return yield* refuse(
          `limit must be a positive integer; received ${String(limit)}. Nothing was sent.`,
        )
      }
      const partitionProblem = invalidIndexPartition(name, options?.partition)
      if (partitionProblem !== undefined) {
        return yield* refuse(`${partitionProblem} Nothing was sent.`)
      }
      let query = buildIndexQuery(name, streamId, options?.partition)
      if (options?.beginsWith !== undefined) {
        query = Query.where(query, { beginsWith: options.beginsWith })
      } else if (options?.between !== undefined) {
        query = Query.where(query, { between: options.between })
      }
      if (options?.reverse === true) query = Query.reverse(query)
      if (limit !== undefined) query = Query.limit(query, limit)
      if (options?.consistentRead === true) query = Query.consistentRead(query)
      return yield* Query.collect(query)
    }) as Effect.Effect<
      ReadonlyArray<StreamEvent<TEvent>>,
      DynamoClientError | ValidationError,
      DynamoClient | TableConfig
    >

  const queryNamespace = {
    events: (streamId: StreamIdInput<TStreamIdFields>) => buildEventsQuery(streamId),
    index: (
      name: string,
      streamId: StreamIdInput<TStreamIdFields>,
      options?: { readonly partition?: string | undefined } | undefined,
    ) => buildIndexQuery(name, streamId, options?.partition),
  }

  // ---------------------------------------------------------------------------
  // Return EventStream
  // ---------------------------------------------------------------------------

  // Cast rationale: makeStream builds the stream object from closures that capture
  // the generic config. The Table.Tag service has a dynamically-created tag whose R
  // type parameter is opaque, causing Effect.gen to infer `unknown` for R. The cast
  // is safe because all operations correctly require DynamoClient | TableConfig at
  // runtime — the user must provide these layers.
  return {
    [EventStreamTypeId]: EventStreamTypeId,
    pipe() {
      // eslint-disable-next-line prefer-rest-params
      return Pipeable.pipeArguments(this, arguments)
    },
    streamName: config.streamName,
    eventSchema: eventUnion,
    streamIdFields: compositeFields,
    eventMarker: entityType,
    parseStreamId: (id: string) => parseStreamIdWith(config.streamName, compositeFields, id),
    snapshotConfig: snapshotSettings,
    storedAs: storage,
    indexes: indexSettings,
    writeSnapshot: checked(writeSnapshot),
    readSnapshot: checked(readSnapshot),
    append: checked(append),
    read: checked(read),
    readFrom: checked(readFrom),
    currentVersion: checked(currentVersion),
    readLatest: checked(readLatest),
    readIndex: checked(readIndex),
    measureAppend: checked(measureAppend),
    measureSnapshot: checked(measureSnapshot),
    decodeStreamImage: checked(decodeStreamImage),
    query: queryNamespace,
    [StreamIdFormatter]: composeStreamIdString,
    [CommandSentinelProbe]: checked(hasCommandSentinel),
    [HeadAboveProbe]: checked(headAbove),
  } as unknown as EventStream<
    TEvent,
    TStreamIdFields,
    TMetadata extends Schema.Top ? Schema.Schema.Type<TMetadata> : undefined,
    SnapshotStateOf<TSnapshot>,
    keyof TIndexes & string,
    IndexProjectionsOf<TIndexes>,
    PartitionedIndexesOf<TIndexes>
  >
}

// ---------------------------------------------------------------------------
// BoundEventStream — EventStream operations with services pre-resolved (R = never)
// ---------------------------------------------------------------------------

/**
 * An EventStream whose operations have `DynamoClient` and `TableConfig` already
 * resolved, so all methods return `Effect<A, E, never>`.
 *
 * Created via {@link bind}. Use in service layers to avoid leaking infrastructure
 * requirements through service method signatures.
 *
 * @example
 * ```typescript
 * export class MatchEventService extends Context.Service<MatchEventService>()("MatchEventService", {
 *   make: Effect.gen(function* () {
 *     const stream = yield* EventStore.bind(MatchEvents)
 *     return {
 *       append: (matchId, events, version) => stream.append({ matchId }, events, version),
 *       read: (matchId) => stream.read({ matchId }),
 *     }
 *   }),
 * }) {}
 * ```
 */
export interface BoundEventStream<
  TEvent,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TState = never,
  TIndexName extends string = never,
  TIndexProjections extends { readonly [K in TIndexName]: StreamIndexProjection } = {
    readonly [K in TIndexName]: "all"
  },
  TPartitionedIndexName extends string = never,
> extends Pipeable.Pipeable {
  readonly [EventStreamTypeId]: EventStreamTypeId
  readonly streamName: string
  readonly eventSchema: Schema.Top

  /** See {@link EventStream.streamIdFields}. */
  readonly streamIdFields: TStreamIdFields

  /** See {@link EventStream.eventMarker}. */
  readonly eventMarker: string

  /** See {@link EventStream.parseStreamId}. */
  parseStreamId(
    streamId: string,
  ): Effect.Effect<StreamIdInput<TStreamIdFields>, ValidationError, never>

  /** See {@link EventStream.snapshotConfig}. */
  readonly snapshotConfig: SnapshotSettings | undefined

  /** See {@link EventStream.storedAs}. */
  readonly storedAs: StreamStorageSettings

  /** See {@link EventStream.indexes}. */
  readonly indexes: { readonly [K in TIndexName]: StreamIndexSettings }

  /** See {@link EventStream.writeSnapshot} — a method for the same variance reason. */
  writeSnapshot(
    streamId: StreamIdInput<TStreamIdFields>,
    state: TState,
    asOfVersion: number,
  ): Effect.Effect<void, DynamoClientError | ValidationError, never>

  /** See {@link EventStream.readSnapshot}. */
  readSnapshot(
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<Option.Option<Snapshot<TState>>, DynamoClientError | ValidationError, never>

  /** See {@link EventStream.append}. */
  append(
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: AppendOptions<TMetadata, TState> | undefined,
  ): Effect.Effect<AppendResult<TEvent>, AppendError, never>

  /** See {@link EventStream.read}. */
  read(
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadOptions | undefined,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    DynamoClientError | ValidationError,
    never
  >

  /** See {@link EventStream.readFrom}. */
  readFrom(
    streamId: StreamIdInput<TStreamIdFields>,
    afterVersion: number,
    options?: ReadFromOptions | undefined,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    DynamoClientError | ValidationError,
    never
  >

  /** See {@link EventStream.currentVersion}. */
  currentVersion(
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadOptions | undefined,
  ): Effect.Effect<number, DynamoClientError | ValidationError, never>

  /** See {@link EventStream.readLatest}. */
  readLatest(
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadLatestOptions | undefined,
  ): Effect.Effect<
    LatestState<TState, TEvent, StreamMetadata<TMetadata>>,
    DynamoClientError | ValidationError,
    never
  >

  /** See {@link EventStream.readIndex}. */
  readIndex<N extends TIndexName>(
    name: N,
    streamId: StreamIdInput<TStreamIdFields>,
    ...options: ReadIndexArgs<N, TPartitionedIndexName>
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, IndexEventMetadata<TMetadata, TIndexProjections[N]>>>,
    DynamoClientError | ValidationError,
    never
  >

  /** See {@link EventStream.measureAppend}. */
  measureAppend(
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: MeasureAppendOptions<TMetadata, TState> | undefined,
  ): Effect.Effect<AppendMeasurement, ValidationError, never>

  /** See {@link EventStream.measureSnapshot}. */
  measureSnapshot(
    streamId: StreamIdInput<TStreamIdFields>,
    state: TState,
    asOfVersion: number,
  ): Effect.Effect<number, ValidationError, never>

  /** See {@link EventStream.decodeStreamImage}. */
  decodeStreamImage(
    image: StreamImage,
    options: DecodeStreamImageOptions & { readonly raw: true },
  ): Effect.Effect<
    Option.Option<RawStreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    ValidationError,
    never
  >
  decodeStreamImage(
    image: StreamImage,
    options?: DecodeStreamImageOptions,
  ): Effect.Effect<
    Option.Option<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    ValidationError,
    never
  >

  /**
   * The stream's query builders — unbound: run them with {@link provide}, or
   * where `DynamoClient` and `TableConfig` are provided. They do not use the
   * context this bound stream captured unless run through {@link provide}:
   * run directly, raw-row unpacking (`Query.select`) and decoding read the
   * `Compression` registry of the caller's context, not the bound one.
   */
  readonly query: {
    events(
      streamId: StreamIdInput<TStreamIdFields>,
    ): Query.Query<StreamEvent<TEvent, StreamMetadata<TMetadata>>>
    /** See `EventStream.query.index`. */
    index<N extends TIndexName>(
      name: N,
      streamId: StreamIdInput<TStreamIdFields>,
      ...options: IndexQueryArgs<N, TPartitionedIndexName>
    ): Query.Query<StreamEvent<TEvent, IndexEventMetadata<TMetadata, TIndexProjections[N]>>>
  }

  /** Escape hatch: provide DynamoClient | TableConfig to an arbitrary effect. */
  readonly provide: <A, E>(
    effect: Effect.Effect<A, E, DynamoClient | TableConfig>,
  ) => Effect.Effect<A, E, never>
}

// ---------------------------------------------------------------------------
// EventStore.bind — resolve services, return BoundEventStream with R = never
// ---------------------------------------------------------------------------

/**
 * Bind an EventStream to resolved `DynamoClient` and `TableConfig` services.
 * Returns a {@link BoundEventStream} where all operations have `R = never`.
 *
 * Use inside `Context.Service` make effects to prevent service methods
 * from leaking infrastructure requirements.
 *
 * @example
 * ```typescript
 * const stream = yield* EventStore.bind(MatchEvents)
 * const events = yield* stream.read({ matchId: "m-1" })    // R = never
 * yield* stream.append({ matchId: "m-1" }, [event], 0)     // R = never
 * ```
 */
export const bind = <
  TEvent,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TState,
  TIndexName extends string = never,
  TIndexProjections extends { readonly [K in TIndexName]: StreamIndexProjection } = {
    readonly [K in TIndexName]: "all"
  },
  TPartitionedIndexName extends string = never,
>(
  stream: EventStream<
    TEvent,
    TStreamIdFields,
    TMetadata,
    TState,
    TIndexName,
    TIndexProjections,
    TPartitionedIndexName
  >,
): Effect.Effect<
  BoundEventStream<
    TEvent,
    TStreamIdFields,
    TMetadata,
    TState,
    TIndexName,
    TIndexProjections,
    TPartitionedIndexName
  >,
  never,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    const ctx = yield* Effect.context<DynamoClient | TableConfig>()
    // The stream meets values compressed with every codec its `storedAs`
    // names, so the registry captured here must have them (#147).
    const codecError = unregisteredCodecError(
      "EventStore.bind",
      streamCodecRequirements(stream.streamName, stream.storedAs),
      Context.getOrUndefined(ctx, Compression),
    )
    if (codecError !== undefined) throw codecError
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DynamoClient | TableConfig>,
    ): Effect.Effect<A, E, never> => Effect.provide(effect, ctx)
    const probe = commandSentinelProbeOf(stream)
    const headProbe = headAboveProbeOf(stream)

    return {
      [EventStreamTypeId]: EventStreamTypeId,
      pipe() {
        // eslint-disable-next-line prefer-rest-params
        return Pipeable.pipeArguments(this, arguments)
      },
      streamName: stream.streamName,
      eventSchema: stream.eventSchema,
      streamIdFields: stream.streamIdFields,
      eventMarker: stream.eventMarker,
      parseStreamId: (id: string) => stream.parseStreamId(id),
      snapshotConfig: stream.snapshotConfig,
      storedAs: stream.storedAs,
      indexes: stream.indexes,
      writeSnapshot: (streamId, state, asOfVersion) =>
        provide(stream.writeSnapshot(streamId, state, asOfVersion)),
      readSnapshot: (streamId) => provide(stream.readSnapshot(streamId)),
      append: (streamId, events, expectedVersion, options) =>
        provide(stream.append(streamId, events, expectedVersion, options)),
      read: (streamId, options) => provide(stream.read(streamId, options)),
      readFrom: (streamId, afterVersion, options) =>
        provide(stream.readFrom(streamId, afterVersion, options)),
      currentVersion: (streamId, options) => provide(stream.currentVersion(streamId, options)),
      readLatest: (streamId, options) => provide(stream.readLatest(streamId, options)),
      readIndex: (name, streamId, ...options) =>
        provide(stream.readIndex(name, streamId, ...options)),
      // The captured context carries a `Compression` registry provided where
      // the stream was bound (#147).
      measureAppend: (streamId, events, expectedVersion, options) =>
        provide(stream.measureAppend(streamId, events, expectedVersion, options)),
      measureSnapshot: (streamId, state, asOfVersion) =>
        provide(stream.measureSnapshot(streamId, state, asOfVersion)),
      decodeStreamImage: ((image: StreamImage, options?: DecodeStreamImageOptions) =>
        provide(stream.decodeStreamImage(image, options))) as BoundEventStream<
        TEvent,
        TStreamIdFields,
        TMetadata,
        TState,
        TIndexName,
        TIndexProjections,
        TPartitionedIndexName
      >["decodeStreamImage"],
      query: stream.query,
      provide,
      [StreamIdFormatter]: (id: Record<string, unknown>) => formatStreamIdOf(stream, id),
      [CommandSentinelProbe]:
        probe === undefined
          ? undefined
          : (id: Record<string, unknown>, commandId: string) => provide(probe(id, commandId)),
      [HeadAboveProbe]:
        headProbe === undefined
          ? undefined
          : (id: Record<string, unknown>, floorVersion: number, options?: ReadOptions) =>
              provide(headProbe(id, floorVersion, options)),
    } as BoundEventStream<
      TEvent,
      TStreamIdFields,
      TMetadata,
      TState,
      TIndexName,
      TIndexProjections,
      TPartitionedIndexName
    >
  })

// ---------------------------------------------------------------------------
// EventStore.indexDefinitions — CreateTable fragments for stream indexes (#140)
// ---------------------------------------------------------------------------

/**
 * @internal The `Projection` a stream index of `projection` is created with.
 * Neither list names a key attribute: table and index keys are always
 * projected.
 */
const projectionDefinition = (projection: StreamIndexProjection, snapshot: boolean): Projection =>
  projection === "all"
    ? { ProjectionType: "ALL" }
    : {
        ProjectionType: "INCLUDE",
        NonKeyAttributes:
          projection === "keys"
            ? ["__edd_e__"]
            : snapshot
              ? [...EVENT_ITEM_ATTRIBUTES, ...SNAPSHOT_ONLY_ATTRIBUTES].sort()
              : [...EVENT_ITEM_ATTRIBUTES],
      }

/**
 * @internal The snapshot item's attributes an event item does not carry: what
 * a `"withoutMetadata"` index that holds snapshots (#149) projects besides
 * {@link EVENT_ITEM_ATTRIBUTES}.
 */
const SNAPSHOT_ONLY_ATTRIBUTES = ["asOfVersion", "state"] as const

/**
 * `CreateTable` fragments for the stream indexes of one or more streams — see
 * {@link indexDefinitions}. The lists are absent when empty, because
 * DynamoDB rejects an empty index list.
 */
export interface StreamIndexDefinitions {
  /** The index key attributes (all strings), excluding the table's `pk` / `sk`. */
  readonly AttributeDefinitions: Array<AttributeDefinition>
  readonly LocalSecondaryIndexes?: Array<LocalSecondaryIndex> | undefined
  readonly GlobalSecondaryIndexes?: Array<GlobalSecondaryIndex> | undefined
}

/**
 * Derive the `CreateTable` fragments for the stream indexes (#140) of the given
 * streams (`EventStream` or `BoundEventStream`) — `AttributeDefinitions`,
 * `LocalSecondaryIndexes` and `GlobalSecondaryIndexes` — to merge into the
 * caller's `CreateTable` input. Event tables are not derived by
 * `Table.definition`, and the table's own `pk` / `sk` are not included: add
 * them (and, on a provisioned table, each GSI's `ProvisionedThroughput`)
 * yourself.
 *
 * Each index's `Projection` follows its {@link StreamIndexProjection}:
 *
 * | `projection` | `Projection` |
 * |---|---|
 * | `"all"` (default) | `{ ProjectionType: "ALL" }` |
 * | `"withoutMetadata"` | `{ ProjectionType: "INCLUDE", NonKeyAttributes: ["__edd_e__", "data", "eventType", "streamId", "timestamp", "version"] }` — plus `"asOfVersion"` and `"state"` when a stream declaring the index puts its snapshot in it (#149) |
 * | `"keys"` | `{ ProjectionType: "INCLUDE", NonKeyAttributes: ["__edd_e__"] }` — not `KEYS_ONLY`: every read filters on `__edd_e__` |
 *
 * The deployed index must project what is declared — copy `Projection` from
 * this output into CDK or Terraform definitions. Neither an LSI's nor a GSI's
 * projection can be changed in place, and the library migrates nothing. A
 * table projects at most 100 `NonKeyAttributes` across all its indexes;
 * `"withoutMetadata"` spends 6 of them and `"keys"` 1 (DynamoDB refuses a
 * table over the limit).
 *
 * An index shared by several streams with the same definition is emitted
 * once — the way several streams write one GSI whose partition they derive
 * (`partition`, #149): an order's line, payment and shipment streams under
 * `ORDER#<orderId>`, say. Whether each declaration derives its partition or
 * indexes its snapshot is not part of the definition: the index's key schema
 * and projection kind are. Lists are sorted by index name, attributes by
 * attribute name.
 *
 * - An LSI can only be created with the table, and caps the item collection
 *   of every partition key value in the table at 10 GB — entity partitions
 *   and streams without indexes included.
 *
 * @example
 * ```typescript
 * const fragments = EventStore.indexDefinitions(Entries, Orders)
 * yield* client.createTable({
 *   TableName: "events",
 *   BillingMode: "PAY_PER_REQUEST",
 *   KeySchema: [
 *     { AttributeName: "pk", KeyType: "HASH" },
 *     { AttributeName: "sk", KeyType: "RANGE" },
 *   ],
 *   AttributeDefinitions: [
 *     { AttributeName: "pk", AttributeType: "S" },
 *     { AttributeName: "sk", AttributeType: "S" },
 *     ...fragments.AttributeDefinitions,
 *   ],
 *   LocalSecondaryIndexes: fragments.LocalSecondaryIndexes,
 *   GlobalSecondaryIndexes: fragments.GlobalSecondaryIndexes,
 * })
 * ```
 *
 * @throws `[EDD-9067]` when two streams define the same physical index
 *   differently (another type, other key attributes, or another projection).
 *   Whether a declaration derives its partition or indexes its snapshot is not
 *   part of the index's definition: streams that differ only there share it.
 */
export const indexDefinitions = (
  ...streams: ReadonlyArray<{
    readonly streamName: string
    readonly indexes: {
      readonly [name: string]: Omit<
        StreamIndexSettings,
        "projection" | "partition" | "snapshot"
      > & {
        /** Read as `"all"` when absent (a hand-built settings object). */
        readonly projection?: StreamIndexProjection | undefined
        /** Read as `"stream"` when absent (a hand-built settings object). */
        readonly partition?: "stream" | "derived" | undefined
        /** Read as `false` when absent (a hand-built settings object). */
        readonly snapshot?: boolean | undefined
      }
    }
  }>
): StreamIndexDefinitions => {
  /** Per physical index: its definition, its first declarer, and whether any declarer indexes snapshots. */
  const byIndex = new Map<
    string,
    Omit<StreamIndexSettings, "partition"> & { readonly owner: string; snapshot: boolean }
  >()
  for (const stream of streams) {
    for (const [name, raw] of Object.entries(stream.indexes)) {
      const settings = {
        type: raw.type,
        index: raw.index,
        pk: raw.pk,
        sk: raw.sk,
        projection: raw.projection ?? "all",
      }
      const snapshot = raw.snapshot === true
      const owner = `index "${name}" of stream "${stream.streamName}"`
      const existing = byIndex.get(settings.index)
      if (existing === undefined) {
        byIndex.set(settings.index, { ...settings, owner, snapshot })
        continue
      }
      // Several streams writing one GSI they derive the partition of (#149)
      // is the point: one declaration indexing snapshots and another not
      // still share it, and the projection covers the snapshots.
      existing.snapshot ||= snapshot
      if (
        existing.type !== settings.type ||
        existing.pk !== settings.pk ||
        existing.sk !== settings.sk ||
        existing.projection !== settings.projection
      ) {
        const describe = (s: Pick<StreamIndexSettings, "type" | "pk" | "sk" | "projection">) =>
          `${s.type} (pk "${s.pk}", sk "${s.sk}", projection "${s.projection}")`
        throw new Error(
          `[EDD-9067] EventStore.indexDefinitions: the physical index "${settings.index}" is ` +
            `defined as ${describe(existing)} by ${existing.owner} and as ${describe(settings)} ` +
            `by ${owner}.`,
        )
      }
    }
  }

  const attributes = new Set<string>()
  const lsis: Array<LocalSecondaryIndex> = []
  const gsis: Array<GlobalSecondaryIndex> = []
  const sorted = [...byIndex.values()].sort((a, b) => a.index.localeCompare(b.index))
  for (const settings of sorted) {
    const definition = {
      IndexName: settings.index,
      KeySchema: [
        { AttributeName: settings.pk, KeyType: "HASH" as const },
        { AttributeName: settings.sk, KeyType: "RANGE" as const },
      ],
      Projection: projectionDefinition(settings.projection, settings.snapshot),
    }
    attributes.add(settings.sk)
    if (settings.type === "gsi") {
      attributes.add(settings.pk)
      gsis.push(definition)
    } else {
      lsis.push(definition)
    }
  }

  return {
    AttributeDefinitions: [...attributes]
      .sort()
      .map((name) => ({ AttributeName: name, AttributeType: "S" as const })),
    ...(lsis.length > 0 ? { LocalSecondaryIndexes: lsis } : {}),
    ...(gsis.length > 0 ? { GlobalSecondaryIndexes: gsis } : {}),
  }
}

// ---------------------------------------------------------------------------
// commandHandler
// ---------------------------------------------------------------------------

/**
 * Handler-level configuration for {@link commandHandler}.
 *
 * `idempotency` carries the policy that is fixed for the handler; the
 * `commandId` that identifies one delivery can only be per-call and lives in the
 * handler's own options.
 */
export interface CommandHandlerOptions {
  /**
   * Retry policy applied to `VersionConflict` **only**.
   *
   * The retried unit is the entire read–decide–append cycle, so every attempt
   * decides against freshly read state — a blind re-append of stale events is
   * impossible by construction. Snapshot reads participate: a retried attempt
   * re-reads the snapshot and its delta (the snapshot alone with
   * {@link verifySnapshot}`: false`), and a function-form `additionalItems` is
   * re-evaluated against the new decision.
   *
   * A number `n` is shorthand for `Schedule.recurs(n)` (n retries *after* the
   * initial attempt). Omit for the default: no retry.
   *
   * `DuplicateCommand` is deliberately NOT retried — it is terminal. Nor is
   * any call that supplies {@link CommandOptionsBase.expectedVersion}: the caller asked
   * for a conditional write, so its `VersionConflict` is always surfaced.
   */
  readonly retry?: number | Schedule.Schedule<unknown, VersionConflict> | undefined

  /** Opt in to exactly-once command processing — see {@link AppendIdempotency}. */
  readonly idempotency?: { readonly ttl?: Duration.Duration | string }

  /**
   * Load state with strongly consistent reads. Default `true`.
   *
   * An eventually consistent load can miss the newest events, so `decide` runs
   * against stale state and the append then fails with `VersionConflict` (or
   * burns a retry). A consistent load costs twice the read capacity of an
   * eventually consistent one. Set `false` to trade that for the occasional
   * conflict. On a snapshot-configured stream the snapshot and its delta are
   * one query ({@link EventStream.readLatest}), so the setting covers both.
   */
  readonly consistentRead?: boolean | undefined

  /**
   * Verify the snapshot against the stream head when loading state. Default
   * `true`.
   *
   * With `true`, a snapshot-configured stream loads with one `Query` that
   * reads the snapshot **and** the newest event (more on a lagging snapshot),
   * so the state `decide` sees is verified current. `false` loads with one
   * `GetItem` of the snapshot item only ({@link EventStream.readLatest} with
   * `verifySnapshot: false`). A `Query`'s read capacity counts every item it
   * reads, a `GetItem` only the snapshot, so with large events `false`
   * roughly halves the read capacity per command.
   *
   * Accepted only when the stream's snapshot config is `mode: "inline"`
   * **without** `every` — the only mode that writes the snapshot in every
   * append's transaction, so it is normally at the head. Any other snapshot
   * config throws `[EDD-9068]` when the handler is created (data-first or
   * data-last). On a stream without a `snapshot` config the option is
   * ignored: state is replayed and verified as always.
   *
   * The snapshot can still lag the head — events appended without one (a raw
   * `append`, data written before `mode: "inline"`). So no answer made on an
   * unverified snapshot is returned until the head confirms it: a successful
   * append confirms it by itself; anything else — a `decide` failure, a no-op
   * decision, an append `VersionConflict` — is checked with one more read,
   * and a stale load falls back to a verified one:
   *
   * - **No snapshot item** (a stream not yet snapshotted): the verified load
   *   runs at once, and `decide` runs once.
   * - **With {@link CommandOptionsBase.expectedVersion}**: a snapshot whose
   *   `asOfVersion` differs from it is re-read verified before the If-Match
   *   check, so only a genuine mismatch is reported (its `actualVersion` is
   *   the verified head). A snapshot at the expected version holds exactly the
   *   state the caller saw, so `decide` runs on it; if that decision does not
   *   append, one head `Query` above the If-Match checks the head (see
   *   below). A head past the
   *   If-Match discards the decision and answers as a verified load would:
   *   `DuplicateCommand` for a committed redelivery, else `VersionConflict`
   *   with the head as `actualVersion` — never re-decided or retried.
   * - **Without it**, a `decide` failure or a no-op is checked against the
   *   head the same way and returned when the head is at the snapshot. An
   *   append that fails with `VersionConflict` triggers one verified load:
   *   a snapshot at the head means another writer won a genuine race, and
   *   the `VersionConflict` goes to the {@link retry} policy as it always
   *   does. Otherwise — the head past the snapshot, or past the version
   *   decided on — the first decision was made on stale state and is
   *   discarded: the handler loads verified (if it has not) and decides again
   *   on that state, then appends — **`decide` (and a function-form
   *   `additionalItems`, for a decision that appends) runs twice for that
   *   call**. That is the optimistic-concurrency price of skipping the
   *   verification read, the same one a `VersionConflict` retry pays: a
   *   decision is only as current as the state it was made on, and a stale
   *   one cannot be patched, only made again. Without the re-decision, a
   *   lagging snapshot would fail or mis-answer every command on the stream,
   *   since only a successful inline append rewrites it. It happens at most
   *   once per attempt, and the second decision's outcome is final for the
   *   attempt (its conflict follows the policy).
   *
   * The head check is a reverse `Limit: 1` `Query` bounded below by the
   * snapshot's version (or the If-Match), never a read of the newest event:
   * while the snapshot is current the range is empty, so it reads no items
   * and costs only DynamoDB's per-request minimum, however large the events
   * are. A decision that appends nothing therefore costs one extra round trip,
   * not extra item reads.
   */
  readonly verifySnapshot?: boolean | undefined
}

/**
 * The outcome of one `decide` call, handed to a function-form
 * {@link CommandOptionsBase.additionalItems}, to `eventMetadata`
 * ({@link CommandMetadataOptions}) and to
 * {@link CommandOptionsBase.eventTimestamps}.
 *
 * - `events` — what `decide` returned (never empty: the function is not called
 *   for a no-op decision).
 * - `state` — the `evolve` fold of `previous` with `events`: the state the
 *   handler returns and snapshots.
 * - `previous` — the state `decide` was given.
 * - `version` — the stream version the events are appended after; the new
 *   events take `version + 1 … version + events.length`.
 *
 * `evolve` may mutate state in place. When it does, `previous` and `state` are
 * the same reference and `previous` already reflects `events`; a projection
 * that needs a pristine `previous` requires an `evolve` that returns new state.
 */
export interface Decision<State, Event> {
  readonly events: ReadonlyArray<Event>
  readonly state: State
  readonly previous: State
  readonly version: number
}

/**
 * The forms {@link CommandOptionsBase.additionalItems} accepts: a static array of
 * transact ops, or a function of the {@link Decision} returning the array
 * directly (pure projection) or as an `Effect` (a projection that needs a read).
 * The effect's `E2` joins the handler's error channel and its `R2` the handler's
 * requirements.
 */
export type AdditionalItemsInput<State, Event, E2 = never, R2 = never> =
  | ReadonlyArray<TransactWriteOp>
  | ((
      decision: Decision<State, Event>,
    ) => ReadonlyArray<TransactWriteOp> | Effect.Effect<ReadonlyArray<TransactWriteOp>, E2, R2>)

/**
 * The form `eventMetadata` ({@link CommandMetadataOptions}) accepts: a
 * function of the {@link Decision} returning one metadata entry per event
 * (`undefined` for an event without metadata), directly or as an `Effect`. The
 * effect's `E3` joins the handler's error channel and its `R3` the handler's
 * requirements.
 *
 * Function-only: the number of events is known only once `decide` has run.
 * The `Effect` form lets ids be minted through the `Crypto` service
 * (`crypto.randomULID`, or `randomUUIDv7`), which keeps them deterministic
 * under `TestClock` and a test `Crypto` layer with fixed bytes.
 */
export type EventMetadataInput<State, Event, TMetadata, E3 = never, R3 = never> = (
  decision: Decision<State, Event>,
) =>
  | ReadonlyArray<TMetadata | undefined>
  | Effect.Effect<ReadonlyArray<TMetadata | undefined>, E3, R3>

/**
 * The form {@link CommandOptionsBase.eventTimestamps} accepts: a function of
 * the {@link Decision} returning one timestamp per event (`undefined` keeps
 * the append's `Clock` time), directly or as an `Effect` — exactly as
 * {@link EventMetadataInput}. The effect's `E4` joins the handler's error
 * channel and its `R4` the handler's requirements.
 *
 * Function-only: the number of events is known only once `decide` has run.
 * The `Effect` form lets times come from a service (a source log, a
 * per-tenant clock) or from `Clock`, which keeps them deterministic under
 * `TestClock`.
 *
 * `E4` / `R4` are separate from `eventMetadata`'s `E3` / `R3`: with one shared
 * pair, an `eventMetadata` effect and an `eventTimestamps` effect with
 * different error types would not compile — TypeScript fixes the parameter
 * from one candidate and rejects the other instead of inferring a union.
 */
export type EventTimestampsInput<State, Event, E4 = never, R4 = never> = (
  decision: Decision<State, Event>,
) =>
  | ReadonlyArray<DateTime.DateTime | undefined>
  | Effect.Effect<ReadonlyArray<DateTime.DateTime | undefined>, E4, R4>

/**
 * The per-call metadata of a {@link commandHandler} handler: one value shared
 * by every event (`metadata`), or a function deriving one entry per event from
 * the decision (`eventMetadata`) — never both (see
 * {@link AppendMetadataOptions}).
 */
export type CommandMetadataOptions<TMetadata, State, Event, E3 = never, R3 = never> =
  | {
      /**
       * Metadata written onto every event the decision appends (see
       * {@link AppendMetadataOptions}). Fixed before `decide` runs; to give
       * each event its own entry, use `eventMetadata`.
       */
      readonly metadata?: TMetadata
      readonly eventMetadata?: undefined
    }
  | {
      readonly metadata?: undefined
      /**
       * Per-event metadata derived from the {@link Decision}: the function
       * returns one entry per event, in order, and entry `i` is written onto
       * event `i` (see {@link AppendMetadataOptions}).
       *
       * - Runs after `decide` and after the new events are folded, receiving
       *   the same `Decision` a function-form `additionalItems` does — and
       *   **before** `additionalItems`, so an effectful pair runs in a
       *   predictable order.
       * - Not called when `decide` returns no events.
       * - Re-run on every attempt: each `VersionConflict` retry, and the
       *   re-decision a stale unverified snapshot triggers
       *   ({@link CommandHandlerOptions.verifySnapshot}`: false`). Ids minted
       *   per attempt are safe — a failed attempt writes nothing.
       * - A result whose length differs from the decision's events fails with
       *   `ValidationError` (`operation: "EventStore.commandHandler.eventMetadata"`),
       *   never retried. A failure of the returned `Effect` surfaces as is,
       *   and is not retried either.
       *
       * Without `idempotency`, a redelivery after a lost response decides and
       * appends again, minting new ids. With it, the redelivery fails with
       * `DuplicateCommand`, so the first commit's ids are the only ones written:
       *
       * ```ts
       * // `crypto` is the `Crypto.Crypto` service; a ULID takes its time from the
       * // `Clock`, so `TestClock` plus a fixed-bytes `Crypto` make it deterministic
       * const handle = EventStore.commandHandler(decider, stream, {
       *   idempotency: { ttl: Duration.days(1) },
       * })
       * yield* handle(streamId, command, {
       *   commandId: deliveryId,
       *   eventMetadata: ({ events }) =>
       *     Effect.forEach(events, () =>
       *       Effect.map(crypto.randomULID, (eventId) => ({ eventId })),
       *     ),
       * })
       * ```
       */
      readonly eventMetadata?: EventMetadataInput<State, Event, TMetadata, E3, R3>
    }

/**
 * The options of a {@link commandHandler} handler other than its metadata
 * (see {@link CommandMetadataOptions}).
 */
export interface CommandOptionsBase<
  State = unknown,
  Event = unknown,
  E2 = never,
  R2 = never,
  E4 = never,
  R4 = never,
> {
  /**
   * Identifier for this command delivery. Required when the handler was created
   * with `idempotency`; a replayed id fails with `DuplicateCommand` — also when
   * the replay carries an {@link expectedVersion} the stream has since moved
   * past (see there).
   *
   * Otherwise the sentinel is consulted when the events are appended, after
   * `decide`, so a replay whose `decide` fails against the advanced state
   * reports that failure, and one whose `decide` returns no events succeeds as
   * a no-op. Only a redelivery that appends fails with `DuplicateCommand`.
   */
  readonly commandId?: string
  /**
   * The stream version the caller last saw — an HTTP `If-Match`.
   *
   * After state is loaded and **before `decide` runs**, a stream at any other
   * version fails the call with `VersionConflict`, carrying the loaded version
   * as `actualVersion`; `decide` never sees state the caller did not. Otherwise
   * the append is conditioned on this version, so a writer that slips in
   * between the load and the append also fails it with `VersionConflict`
   * (without `actualVersion`). Neither is retried, whatever the handler's
   * `retry` policy says.
   *
   * With `idempotency`, a mismatch is first checked against the command's
   * sentinel (one strongly consistent `GetItem`, on the mismatch path only): a
   * redelivery of a command that already committed — its response lost, the
   * same `commandId` and If-Match sent again — fails with `DuplicateCommand`,
   * not `VersionConflict`, matching the precedence `append` applies.
   *
   * A no-op decision (`decide` returns `[]`) at the matching version succeeds
   * with the current state and version. Must be a non-negative integer — any
   * other value fails with `ValidationError` before anything is read.
   */
  readonly expectedVersion?: number | undefined
  /**
   * Caller-owned transact items committed atomically with the produced events
   * (see {@link AppendOptionsBase.additionalItems}).
   *
   * Either a static array, or a function of the {@link Decision} — an inline
   * projection — returning the array or an `Effect` of it. The function runs
   * after `decide` and after the new events are folded, is not called when
   * `decide` returns no events, and is re-run on every retry attempt. The items
   * it returns count towards `AppendTooLarge`, and the `indices` of an
   * `AdditionalItemConditionFailed` refer to the array it returned.
   */
  readonly additionalItems?: AdditionalItemsInput<State, Event, E2, R2>
  /**
   * Per-event timestamps derived from the {@link Decision}: the function
   * returns one entry per event, in order, directly or as an `Effect` (see
   * {@link EventTimestampsInput}), and entry `i` is written as event `i`'s
   * `timestamp` — `undefined` keeps the append's `Clock` time (see
   * {@link AppendOptionsBase.eventTimestamps}). Independent of `metadata` /
   * `eventMetadata`. The idempotency sentinel, its TTL and an inline snapshot
   * keep the append's `Clock` time; timestamps carry no ordering check.
   *
   * - Runs after `eventMetadata` and before `additionalItems`, each to
   *   completion before the next, all receiving the same `Decision`; not
   *   called when `decide` returns no events; re-run on every attempt — each
   *   `VersionConflict` retry and the re-decision a stale unverified snapshot
   *   triggers — as `eventMetadata` is.
   * - A failure of the returned `Effect` surfaces as is, is not retried, and
   *   `additionalItems` is not run.
   * - A result — plain or produced by the `Effect` — of the wrong length, or
   *   with an entry that is neither a valid `DateTime` (finite epoch) nor
   *   `undefined`, fails with `ValidationError`
   *   (`operation: "EventStore.commandHandler.eventTimestamps"`), never
   *   retried. A value that is not a function is refused before anything is
   *   read.
   *
   * ```ts
   * // plain: the times are in the events
   * eventTimestamps: ({ events }) => events.map((event) => event.occurredAt)
   *
   * // Effect: the times come from a service
   * eventTimestamps: ({ events }) =>
   *   Effect.forEach(events, (event) => SourceLog.originalTime(event.sourceId))
   * ```
   */
  readonly eventTimestamps?: EventTimestampsInput<State, Event, E4, R4>
}

/**
 * Per-call options accepted by a handler produced by {@link commandHandler}:
 * {@link CommandOptionsBase} plus the exclusive `metadata` / `eventMetadata`
 * pair ({@link CommandMetadataOptions}).
 *
 * `State` / `Event` type the {@link Decision} a function-form `additionalItems`,
 * `eventMetadata` or `eventTimestamps` receives; `E2` / `R2` are the error and
 * requirements of the `Effect` `additionalItems` may return, `E3` / `R3` those
 * of the `Effect` `eventMetadata` may return, `E4` / `R4` those of the
 * `Effect` `eventTimestamps` may return — separate, so effects with different
 * error types all join the handler's error channel. The handler infers all of
 * them, so they only need naming when this type is written out by hand.
 */
export type CommandOptions<
  TMetadata,
  State = unknown,
  Event = unknown,
  E2 = never,
  R2 = never,
  E3 = never,
  R3 = never,
  E4 = never,
  R4 = never,
> = CommandOptionsBase<State, Event, E2, R2, E4, R4> &
  CommandMetadataOptions<TMetadata, State, Event, E3, R3>

/** Per-call options when the handler was created with `idempotency` — `commandId` is required. */
export type IdempotentCommandOptions<
  TMetadata,
  State = unknown,
  Event = unknown,
  E2 = never,
  R2 = never,
  E3 = never,
  R3 = never,
  E4 = never,
  R4 = never,
> = CommandOptions<TMetadata, State, Event, E2, R2, E3, R3, E4, R4> & {
  readonly commandId: string
}

/**
 * Options arity: configuring `idempotency` makes the handler's options parameter
 * required (and `commandId` within it non-optional), so a missing `commandId`
 * is a compile error rather than a silent downgrade to at-least-once.
 */
type CommandOptionsArgs<
  TMetadata,
  TConfig extends CommandHandlerOptions | undefined,
  State,
  TEvent,
  E2,
  R2,
  E3,
  R3,
  E4,
  R4,
> = TConfig extends { readonly idempotency: object }
  ? [options: IdempotentCommandOptions<TMetadata, State, TEvent, E2, R2, E3, R3, E4, R4>]
  : [options?: CommandOptions<TMetadata, State, TEvent, E2, R2, E3, R3, E4, R4> | undefined]

type CommandHandlerErrors<E> =
  | E
  | VersionConflict
  | DuplicateCommand
  | AdditionalItemConditionFailed
  | AppendTooLarge
  | DynamoClientError
  | ValidationError
  | TransactionCancelled
  | UniqueConstraintViolation
  | OptimisticLockError
  | ConcurrentModification

/**
 * A handler over an {@link EventStream}. Generic per call over the error (`E2`)
 * and requirements (`R2`) of a function-form `additionalItems` that returns an
 * `Effect`, those (`E3` / `R3`) of an `eventMetadata` that does, and those
 * (`E4` / `R4`) of an `eventTimestamps` that does; all are `never` otherwise.
 */
type CommandHandler<
  State,
  Command,
  TEvent,
  E,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TConfig extends CommandHandlerOptions | undefined = undefined,
> = <E2 = never, R2 = never, E3 = never, R3 = never, E4 = never, R4 = never>(
  streamId: StreamIdInput<TStreamIdFields>,
  command: Command,
  ...options: CommandOptionsArgs<TMetadata, TConfig, State, TEvent, E2, R2, E3, R3, E4, R4>
) => Effect.Effect<
  CommandHandlerResult<State, TEvent>,
  CommandHandlerErrors<E> | E2 | E3 | E4,
  DynamoClient | TableConfig | R2 | R3 | R4
>

/**
 * A handler over a {@link BoundEventStream}: the stream's services are already
 * provided, so the `R2` / `R3` / `R4` of a function-form `additionalItems` /
 * `eventMetadata` / `eventTimestamps` are its only requirements.
 */
type BoundCommandHandler<
  State,
  Command,
  TEvent,
  E,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TConfig extends CommandHandlerOptions | undefined = undefined,
> = <E2 = never, R2 = never, E3 = never, R3 = never, E4 = never, R4 = never>(
  streamId: StreamIdInput<TStreamIdFields>,
  command: Command,
  ...options: CommandOptionsArgs<TMetadata, TConfig, State, TEvent, E2, R2, E3, R3, E4, R4>
) => Effect.Effect<
  CommandHandlerResult<State, TEvent>,
  CommandHandlerErrors<E> | E2 | E3 | E4,
  R2 | R3 | R4
>

/**
 * The handler the data-last {@link commandHandler} returns for stream `S`: a
 * {@link BoundCommandHandler} for a `BoundEventStream` (checked first — a bound
 * stream is also structurally an `EventStream`), a {@link CommandHandler}
 * otherwise.
 */
type CommandHandlerFor<
  S,
  State,
  Command,
  TEvent,
  E,
  TConfig extends CommandHandlerOptions | undefined,
> =
  S extends BoundEventStream<any, infer TStreamIdFields, infer TMetadata, any, any, any, any>
    ? BoundCommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata, TConfig>
    : S extends EventStream<any, infer TStreamIdFields, infer TMetadata, any, any, any, any>
      ? CommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata, TConfig>
      : never

/** @internal Both `EventStream` and `BoundEventStream` carry this brand. */
const hasEventStreamBrand = (u: unknown): boolean =>
  typeof u === "object" && u !== null && EventStreamTypeId in u

/** @internal Resolve a {@link CommandOptionsBase.additionalItems} against a decision. */
const deriveAdditionalItems = <State, Event>(
  input: AdditionalItemsInput<State, Event, unknown, unknown> | undefined,
  decision: Decision<State, Event>,
): Effect.Effect<ReadonlyArray<TransactWriteOp> | undefined, unknown, unknown> => {
  if (typeof input !== "function") return Effect.succeed(input)
  const derived = input(decision)
  return Effect.isEffect(derived) ? derived : Effect.succeed(derived)
}

/** @internal Resolve an `eventMetadata` ({@link CommandMetadataOptions}) against a decision. */
const deriveEventMetadata = <State, Event, TMetadata>(
  input: EventMetadataInput<State, Event, TMetadata, unknown, unknown> | undefined,
  decision: Decision<State, Event>,
): Effect.Effect<ReadonlyArray<TMetadata | undefined> | undefined, unknown, unknown> => {
  if (input === undefined) return Effect.succeed(undefined)
  const derived = input(decision)
  return Effect.isEffect(derived) ? derived : Effect.succeed(derived)
}

/** @internal Resolve a {@link CommandOptionsBase.eventTimestamps} against a decision. */
const deriveEventTimestamps = <State, Event>(
  input: EventTimestampsInput<State, Event, unknown, unknown> | undefined,
  decision: Decision<State, Event>,
): Effect.Effect<ReadonlyArray<DateTime.DateTime | undefined> | undefined, unknown, unknown> => {
  if (input === undefined) return Effect.succeed(undefined)
  const derived = input(decision)
  return Effect.isEffect(derived) ? derived : Effect.succeed(derived)
}

/** @internal */
const makeCommandHandlerImpl = <
  State,
  Command,
  TEvent,
  E,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
>(
  decider: Decider<State, Command, TEvent, E>,
  stream:
    | EventStream<TEvent, TStreamIdFields, TMetadata, any, any, any, any>
    | BoundEventStream<TEvent, TStreamIdFields, TMetadata, any, any, any, any>,
  options: CommandHandlerOptions | undefined,
) => {
  // `verifySnapshot: false` is refused up front unless the stream writes its
  // snapshot in every append (EDD-9068) — at handler construction, so a
  // misconfiguration fails at startup rather than on the first command.
  const snapshotSettings = stream.snapshotConfig
  if (options?.verifySnapshot === false) {
    const refusal = unverifiedSnapshotRefusal(stream.streamName, snapshotSettings, "commandHandler")
    if (refusal !== undefined) throw new Error(refusal)
  }
  // Ignored on a stream without a snapshot config: there is no snapshot to trust.
  const unverifiedLoads = options?.verifySnapshot === false && snapshotSettings !== undefined

  const retryPolicy = options?.retry
  const schedule =
    retryPolicy === undefined
      ? undefined
      : typeof retryPolicy === "number"
        ? Schedule.recurs(retryPolicy)
        : retryPolicy
  // Consistent by default: an eventually consistent load can hand `decide`
  // state that misses acknowledged events (#139).
  const readOptions: ReadLatestOptions = { consistentRead: options?.consistentRead ?? true }
  const unverifiedReadOptions: ReadLatestOptions = { ...readOptions, verifySnapshot: false }

  return (
    streamId: StreamIdInput<TStreamIdFields>,
    command: Command,
    callOptions?:
      | CommandOptions<
          TMetadata,
          State,
          TEvent,
          unknown,
          unknown,
          unknown,
          unknown,
          unknown,
          unknown
        >
      | undefined,
  ) => {
    const expectedVersion = callOptions?.expectedVersion

    /** The state a decision is made on, and how far it can be trusted. */
    interface Loaded {
      readonly state: State
      /** The version the events are appended after. */
      readonly version: number
      readonly snapshotAsOfVersion: number
      /** `false` when the version is an unverified snapshot's `asOfVersion`. */
      readonly verified: boolean
      /** Events past the current snapshot (all events without one). */
      readonly eventsAfterSnapshot: number
    }

    // 1. Establish the base state + version. A snapshot-configured stream
    //    loads its snapshot, the events after it and its head in one request
    //    (#138) — or, unverified, the snapshot item alone; any other stream
    //    replays from the beginning.
    const load = (verify: boolean) =>
      Effect.gen(function* () {
        let state = decider.initialState
        if (snapshotSettings !== undefined) {
          const latest = (yield* stream.readLatest(
            streamId,
            verify ? readOptions : unverifiedReadOptions,
          )) as LatestState<State, TEvent, unknown>
          let snapshotAsOfVersion = 0
          if (Option.isSome(latest.snapshot)) {
            snapshotAsOfVersion = latest.snapshot.value.asOfVersion
            state = latest.snapshot.value.state
          }
          for (const event of latest.events) {
            state = decider.evolve(state, event.data)
          }
          const loaded: Loaded = {
            state,
            version: latest.version,
            snapshotAsOfVersion,
            // An unverified read returns a snapshot alone; without one it has
            // already fallen back to the verified read.
            verified: verify || Option.isNone(latest.snapshot),
            eventsAfterSnapshot: latest.events.length,
          }
          return loaded
        }
        const events = yield* stream.read(streamId, readOptions)
        for (const event of events) {
          state = decider.evolve(state, event.data)
        }
        const loaded: Loaded = {
          state,
          version: events[events.length - 1]?.version ?? 0,
          snapshotAsOfVersion: 0,
          verified: true,
          eventsAfterSnapshot: events.length,
        }
        return loaded
      })

    // 4–8. Commit one decision: fold, derive items, append, snapshot. With
    //    `returnAppendConflict`, an append that fails with `VersionConflict`
    //    returns the conflict instead of failing, so the caller can tell a
    //    stale unverified load from a lost race.
    const commit = (
      loaded: Loaded,
      newEvents: ReadonlyArray<TEvent>,
      returnAppendConflict: boolean,
    ) =>
      Effect.gen(function* () {
        const baseVersion = loaded.version
        const state = loaded.state

        // 4. No-op command — return current state
        if (newEvents.length === 0) {
          const noop: CommandHandlerResult<State, TEvent> = {
            state,
            version: baseVersion,
            events: [],
          }
          return noop
        }

        // 5. Fold the new events BEFORE appending (#137): the post-decision
        //    state is what a function-form `additionalItems` projects, what a
        //    snapshot records, and what the handler returns — always the
        //    `evolve` fold, never anything produced inside `decide`.
        const previous = state
        let next = state
        for (const event of newEvents) {
          next = decider.evolve(next, event)
        }

        // 6. Derive the caller's per-event metadata, then per-event
        //    timestamps, then items, from the decision — in that order
        //    (#144). Re-run on every attempt (and on a re-decision), because
        //    the whole cycle is the retried unit.
        const decision: Decision<State, TEvent> = {
          events: newEvents,
          state: next,
          previous,
          version: baseVersion,
        }
        const eventMetadata = yield* deriveEventMetadata(callOptions?.eventMetadata, decision)
        // A supplied function must return the array — `undefined` (e.g. a
        // block body with no `return`) is refused, not silently dropped.
        if (
          callOptions?.eventMetadata !== undefined &&
          (!Array.isArray(eventMetadata) || eventMetadata.length !== newEvents.length)
        ) {
          return yield* new ValidationError({
            entityType: stream.streamName,
            operation: "EventStore.commandHandler.eventMetadata",
            cause:
              `eventMetadata returned ${Array.isArray(eventMetadata) ? eventMetadata.length : "no"} ` +
              `entries for the decision's ${newEvents.length} events: it must return exactly ` +
              "one entry (or undefined) per event, in order. Nothing was written.",
          })
        }
        // A function (checked before the load), returning the array or an
        // `Effect` of it; the result of either form is checked here, so the
        // error names the handler's option rather than `append`'s.
        const eventTimestamps = yield* deriveEventTimestamps(callOptions?.eventTimestamps, decision)
        if (callOptions?.eventTimestamps !== undefined) {
          const problem = eventTimestampsProblem(
            eventTimestamps,
            newEvents.length,
            "eventTimestamps returned",
            `the decision's ${newEvents.length} events`,
          )
          if (problem !== undefined) {
            return yield* new ValidationError({
              entityType: stream.streamName,
              operation: "EventStore.commandHandler.eventTimestamps",
              cause: `${problem} Nothing was written.`,
            })
          }
        }
        const additionalItems = yield* deriveAdditionalItems(callOptions?.additionalItems, decision)

        // 7. Append with optimistic concurrency, plus the caller's items, the
        //    dedup sentinel and an inline snapshot, all in one transaction.
        //    `baseVersion` equals any caller-supplied `expectedVersion` here
        //    (checked in step 2).
        const appendOptions: {
          metadata?: TMetadata
          eventMetadata?: ReadonlyArray<TMetadata | undefined>
          eventTimestamps?: ReadonlyArray<DateTime.DateTime | undefined>
          additionalItems?: ReadonlyArray<TransactWriteOp>
          idempotency?: AppendIdempotency
          snapshot?: State
        } = {}
        if (callOptions?.metadata !== undefined) appendOptions.metadata = callOptions.metadata
        if (eventMetadata !== undefined) appendOptions.eventMetadata = eventMetadata
        if (eventTimestamps !== undefined) appendOptions.eventTimestamps = eventTimestamps
        if (additionalItems !== undefined) appendOptions.additionalItems = additionalItems
        if (options?.idempotency !== undefined && callOptions?.commandId !== undefined) {
          appendOptions.idempotency =
            options.idempotency.ttl !== undefined
              ? { commandId: callOptions.commandId, ttl: options.idempotency.ttl }
              : { commandId: callOptions.commandId }
        }

        // Inline snapshots (#138) ride in the append transaction: on every
        // append, or once `every` events have accumulated since the snapshot.
        const mode = snapshotSettings?.mode ?? "after-append"
        const every = snapshotSettings?.every
        const newVersion = baseVersion + newEvents.length
        if (
          snapshotSettings !== undefined &&
          mode === "inline" &&
          (every === undefined || newVersion - loaded.snapshotAsOfVersion >= every)
        ) {
          appendOptions.snapshot = next
        }

        const appended = stream.append(
          streamId,
          newEvents,
          baseVersion,
          appendOptions as AppendOptions<TMetadata, any>,
        ) as Effect.Effect<AppendResult<TEvent>, AppendError, unknown>
        const outcome = yield* returnAppendConflict
          ? appended.pipe(
              Effect.catchIf(
                (error): error is VersionConflict => error instanceof VersionConflict,
                (conflict) => Effect.succeed(conflict),
              ),
            )
          : appended
        if (outcome instanceof VersionConflict) return outcome
        const result = outcome

        // 8. After-append snapshots, once the cadence threshold is crossed.
        //    Best-effort: the events are already durable, so a snapshot-write
        //    failure must not report the command as failed. The next threshold
        //    crossing retries it.
        if (
          mode === "after-append" &&
          every !== undefined &&
          result.version - loaded.snapshotAsOfVersion >= every
        ) {
          yield* stream
            .writeSnapshot(streamId, next, result.version)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `EventStore: snapshot write failed for stream "${stream.streamName}" at version ${result.version}`,
                  cause,
                ),
              ),
            )
        }

        const done: CommandHandlerResult<State, TEvent> = {
          state: next,
          version: result.version,
          events: newEvents,
        }
        return done
      })

    // The If-Match answer for a stream at `actualVersion` (#136). A
    // redelivery of a command that already committed (its response was lost)
    // arrives with its original If-Match, which the stream has since moved
    // past. It is a duplicate, not a lost race — `append` ranks
    // `DuplicateCommand` above `VersionConflict` for the same reason — so
    // consult the sentinel before reporting the conflict. The extra read is
    // paid on this conflict path only.
    const ifMatchMismatch = (expected: number, actualVersion: number) =>
      Effect.gen(function* () {
        const probe = commandSentinelProbeOf(stream)
        const commandId = callOptions?.commandId
        if (options?.idempotency !== undefined && commandId !== undefined && probe !== undefined) {
          if (yield* probe(streamId as Record<string, unknown>, commandId)) {
            return yield* new DuplicateCommand({
              streamName: stream.streamName,
              streamId: formatStreamIdOf(stream, streamId as Record<string, unknown>),
              commandId,
            })
          }
        }
        return yield* new VersionConflict({
          streamName: stream.streamName,
          streamId: formatStreamIdOf(stream, streamId as Record<string, unknown>),
          expectedVersion: expected,
          actualVersion,
        })
      })

    // The head, known to be at least `floorVersion` (see HeadAboveProbe): one
    // `Query` that reads no items while the snapshot is current.
    const headAbove = (floorVersion: number) => {
      const probe = headAboveProbeOf(stream)
      return probe !== undefined
        ? probe(streamId as Record<string, unknown>, floorVersion, readOptions)
        : stream.currentVersion(streamId, readOptions)
    }

    const attempt = Effect.gen(function* () {
      // Backstop for JS callers and `any`-shaped call sites: silently degrading
      // to at-least-once would look like success right up until the day a
      // duplicate mattered. Not retryable — `while` below only retries
      // `VersionConflict`, so this surfaces on the first attempt.
      if (options?.idempotency !== undefined && callOptions?.commandId === undefined) {
        return yield* new ValidationError({
          entityType: stream.streamName,
          operation: "EventStore.commandHandler",
          cause: "commandId is required when commandHandler is configured with `idempotency`.",
        })
      }

      // The same backstop for the exclusive metadata pair (#144), and for an
      // `eventMetadata` or `eventTimestamps` that is not the function it must
      // be — refused before anything is read, rather than by `append` after
      // `decide`.
      if (callOptions?.eventMetadata !== undefined) {
        if (callOptions.metadata !== undefined) {
          return yield* new ValidationError({
            entityType: stream.streamName,
            operation: "EventStore.commandHandler.eventMetadata",
            cause:
              "metadata and eventMetadata are mutually exclusive: pass one value shared by " +
              "every event, or a function deriving one entry per event. Nothing was written.",
          })
        }
        if (typeof callOptions.eventMetadata !== "function") {
          return yield* new ValidationError({
            entityType: stream.streamName,
            operation: "EventStore.commandHandler.eventMetadata",
            cause:
              "eventMetadata must be a function of the decision: the number of events is " +
              "known only once `decide` has run. Nothing was written.",
          })
        }
      }
      if (
        callOptions?.eventTimestamps !== undefined &&
        typeof callOptions.eventTimestamps !== "function"
      ) {
        return yield* new ValidationError({
          entityType: stream.streamName,
          operation: "EventStore.commandHandler.eventTimestamps",
          cause:
            "eventTimestamps must be a function of the decision: the number of events is " +
            "known only once `decide` has run. Nothing was written.",
        })
      }

      // A malformed If-Match (`NaN` from a failed parse, a negative or
      // fractional number) is a caller bug, not a conflict — refuse it before
      // reading anything.
      if (
        expectedVersion !== undefined &&
        (!Number.isInteger(expectedVersion) || expectedVersion < 0)
      ) {
        return yield* new ValidationError({
          entityType: stream.streamName,
          operation: "EventStore.commandHandler",
          cause: `expectedVersion must be a non-negative integer; received ${String(expectedVersion)}.`,
        })
      }

      // 1. Load (see `load`).
      let loaded = yield* load(!unverifiedLoads)

      // An unverified snapshot at another version than the caller's If-Match
      // may merely lag the head: re-read verified, so only a genuine mismatch
      // is reported, with the verified head as its `actualVersion`.
      if (expectedVersion !== undefined && !loaded.verified && loaded.version !== expectedVersion) {
        loaded = yield* load(true)
      }

      // 2. If-Match (#136): the caller saw a different version, so `decide`
      //    must not run against state the caller never saw.
      if (expectedVersion !== undefined && expectedVersion !== loaded.version) {
        return yield* ifMatchMismatch(expectedVersion, loaded.version)
      }

      // 3. Decide on a verified load, and commit. An If-Match call's
      //    append-time conflict is its answer (never re-read or retried), and
      //    a verified load's conflict is a lost race.
      if (loaded.verified) {
        const newEvents = yield* decider.decide(command, loaded.state)
        return (yield* commit(loaded, newEvents, false)) as CommandHandlerResult<State, TEvent>
      }

      // 3'. Decide on an unverified snapshot. It is normally at the head, but
      //    events appended without one (a raw `append`, data written before
      //    inline mode) make it lag — and then every answer made on it is
      //    stale, not only one that appends. So no answer is returned until
      //    the head is confirmed: an append confirms it by succeeding; a
      //    decision that appends nothing (a `decide` failure or a no-op) and
      //    an append conflict are confirmed with one more read.
      const decided = yield* Effect.result(decider.decide(command, loaded.state))
      const first =
        Result.isSuccess(decided) && decided.success.length > 0
          ? yield* commit(loaded, decided.success, true)
          : undefined
      if (first !== undefined && !(first instanceof VersionConflict)) return first

      // The answer the first decision gives when the snapshot proves current.
      const firstAnswer: Effect.Effect<
        CommandHandlerResult<State, TEvent>,
        E | VersionConflict
      > = first !== undefined
        ? Effect.fail(first)
        : Result.isFailure(decided)
          ? Effect.fail(decided.failure)
          : Effect.succeed({ state: loaded.state, version: loaded.version, events: [] })

      // With an If-Match equal to the snapshot's `asOfVersion`, the snapshot
      // state is exactly the state the caller saw, so `decide` ran on the
      // right state — the only question is whether the stream is still at
      // that version. A newer head answers exactly as a verified load would
      // have (the pre-decide check above): `DuplicateCommand` for a committed
      // redelivery, else `VersionConflict` with the head as `actualVersion`.
      // The first decision is discarded. Never re-decided: an If-Match call's
      // conflict is its answer.
      if (expectedVersion !== undefined) {
        const head = yield* headAbove(expectedVersion)
        if (head !== expectedVersion) return yield* ifMatchMismatch(expectedVersion, head)
        return yield* firstAnswer
      }

      // No If-Match, nothing appended: a head at the snapshot's version
      // confirms the answer (one `Query` above the snapshot's version, which
      // reads no items while the snapshot is current).
      if (first === undefined) {
        const head = yield* headAbove(loaded.version)
        if (head === loaded.version) return yield* firstAnswer
      }

      // No If-Match, the append conflicted — the snapshot lagged the head, or
      // another writer won the race; one verified load tells them apart. A
      // snapshot at the head is a genuine race, which the retry policy
      // handles as it always has (a retried attempt loads unverified again).
      // A lagging snapshot is decided on again, once: only a successful inline
      // append rewrites the snapshot, so surfacing the conflict would fail
      // every command on the stream until something else repaired it.
      const verified = yield* load(true)
      if (first !== undefined && verified.eventsAfterSnapshot === 0) return yield* first

      // The first decision was made on stale state: decide again on the
      // verified state — `decide` (and a function-form `additionalItems`)
      // runs a second time in this attempt. Its own conflict follows the
      // retry policy.
      const newEvents = yield* decider.decide(command, verified.state)
      return (yield* commit(verified, newEvents, false)) as CommandHandlerResult<State, TEvent>
    })

    // A caller-supplied `expectedVersion` is a conditional write: its
    // `VersionConflict` (pre-decide or from the append) is the answer, never a
    // cue to re-read and re-decide.
    return schedule === undefined || expectedVersion !== undefined
      ? attempt
      : Effect.retry(attempt, {
          // `while` runs before the schedule, so the schedule only ever sees a
          // `VersionConflict` input — the widening cast is sound. It is needed
          // because `Retry.Options` demands a schedule whose input accepts the
          // effect's *full* error union, and `Schedule` is contravariant on input.
          schedule: schedule as Schedule.Schedule<unknown, unknown>,
          // `VersionConflict` only. `DuplicateCommand` is terminal — the same
          // commandId can never succeed — and `AdditionalItemConditionFailed`
          // will not resolve itself by re-deciding either.
          while: (error: unknown) => error instanceof VersionConflict,
        })
  }
}

/**
 * Create a command handler that reads, decides, and appends atomically.
 *
 * Supports both data-first and data-last (pipeable) usage, and works with
 * both `EventStream` (R = DynamoClient | TableConfig) and `BoundEventStream` (R = never).
 *
 * ```typescript
 * // Data-first with EventStream
 * const handle = EventStore.commandHandler(decider, stream)
 *
 * // Data-first with BoundEventStream
 * const handle = EventStore.commandHandler(decider, boundStream)
 *
 * // Data-last (pipe)
 * const handle = stream.pipe(EventStore.commandHandler(decider))
 *
 * // Retry the full read-decide-append cycle on VersionConflict
 * const handle = EventStore.commandHandler(decider, stream, { retry: 3 })
 * const handle2 = stream.pipe(EventStore.commandHandler(decider, { retry: 3 }))
 *
 * // Exactly-once command processing — `commandId` becomes required per call
 * const handle = EventStore.commandHandler(decider, stream, {
 *   idempotency: { ttl: Duration.days(1) },
 * })
 * yield* handle({ matchId: "m-1" }, command, { commandId: "cmd-7f3a" })
 *
 * // Load state from the inline snapshot alone (mode "inline" without `every`)
 * const handle = EventStore.commandHandler(decider, stream, { verifySnapshot: false })
 *
 * // If-Match: fail with VersionConflict (never retried) unless the stream is at v7
 * yield* handle({ matchId: "m-1" }, command, { expectedVersion: 7 })
 *
 * // Inline projection, committed in the same transaction as the events
 * yield* handle({ matchId: "m-1" }, command, {
 *   additionalItems: ({ state }) => [Scoreboard.put({ matchId: "m-1", runs: state.runs })],
 * })
 *
 * // Per-event metadata derived from the decision: entry i is written onto event i
 * // (`crypto` is the `Crypto.Crypto` service; `randomUUIDv7` works the same way)
 * yield* handle({ matchId: "m-1" }, command, {
 *   eventMetadata: ({ events }) =>
 *     Effect.forEach(events, () => Effect.map(crypto.randomULID, (eventId) => ({ eventId }))),
 * })
 *
 * // Per-event timestamps derived from the decision (undefined → the Clock time)
 * yield* handle({ matchId: "m-1" }, command, {
 *   eventTimestamps: ({ events }) => events.map((event) => event.occurredAt),
 * })
 *
 * // ...or from a service, as an Effect (its errors / requirements join the handler's)
 * yield* handle({ matchId: "m-1" }, command, {
 *   eventTimestamps: ({ events }) =>
 *     Effect.forEach(events, (event) => SourceLog.originalTime(event.sourceId)),
 * })
 * ```
 *
 * Each invocation runs
 * `load → [expectedVersion check] → decide → fold new events → derive items → append → [snapshot]`.
 *
 * - **Load.** Strongly consistent by default — see
 *   {@link CommandHandlerOptions.consistentRead}. When the stream declares a
 *   `snapshot` config, state is loaded with {@link EventStream.readLatest} —
 *   the snapshot, the events after it and the head in one request in steady
 *   state — and only those events are folded, instead of replaying the stream
 *   from the beginning. On a `mode: "inline"` stream without `every`,
 *   {@link CommandHandlerOptions.verifySnapshot}`: false` loads the snapshot
 *   item alone (one `GetItem`); an answer that is not a successful append is
 *   confirmed against the head first, and a snapshot that proves stale falls
 *   back to the verified load — in which case `decide` may run twice.
 * - **expectedVersion.** See {@link CommandOptionsBase.expectedVersion}.
 * - **Fold before append.** The new events are folded into state before the
 *   append, so the state returned, snapshotted and handed to a function-form
 *   `additionalItems` (see {@link Decision}) is always the `evolve` fold.
 * - **Snapshot.** With `snapshot.mode: "inline"`, the snapshot is written in
 *   the append transaction itself — on every append, or at the `every`
 *   cadence. With the default `"after-append"` and `snapshot.every` set, a
 *   fresh snapshot is written (best-effort) after a successful append once the
 *   cadence threshold is crossed. See {@link SnapshotMode}.
 * - **One atomic append.** One command, one decision, one append: a decision
 *   too large for one transaction is rejected whole by DynamoDB and fails with
 *   `AppendTooLarge` — nothing is written. A large command is split by the application into stepped
 *   commands — each an ordinary call, chained by `expectedVersion` — so a
 *   failure partway leaves the stream at a real intermediate state.
 *
 * The handler is generic per call over the error and requirements of a
 * function-form `additionalItems` that returns an `Effect`: they join the
 * handler's error channel and requirements (on a `BoundEventStream` handler
 * they are its only requirements).
 *
 * Without `idempotency`, command processing is **at-least-once**: a retry after
 * an acked-but-lost response re-runs `decide` and appends again.
 *
 * Note: this is a hand-rolled dual rather than `Function.dual` — the data
 * argument (`stream`) is the *second* parameter, which `Function.dual` cannot
 * express, and its numeric-arity form would silently drop the trailing options
 * (`retry`, `idempotency`) that both forms depend on. Dispatch is on the
 * `EventStreamTypeId` brand of the second argument.
 */
export const commandHandler: {
  // Data-last. One generic signature, not a Bound/unbound overload pair:
  // `pipe` infers from an overloaded argument using its LAST signature only,
  // which typed `bound.pipe(commandHandler(decider))` as an unbound handler
  // still requiring `DynamoClient | TableConfig`.
  <State, Command, TEvent, E, const TConfig extends CommandHandlerOptions | undefined = undefined>(
    decider: Decider<State, Command, TEvent, E>,
    options?: TConfig,
  ): <
    S extends
      | BoundEventStream<TEvent, any, any, State, any, any, any>
      | EventStream<TEvent, ReadonlyArray<string>, any, State, any, any, any>,
  >(
    stream: S,
  ) => CommandHandlerFor<S, State, Command, TEvent, E, TConfig>

  // Data-first: BoundEventStream → BoundCommandHandler
  <
    State,
    Command,
    TEvent,
    E,
    TStreamIdFields extends ReadonlyArray<string>,
    TMetadata,
    TState extends State,
    TIndexName extends string,
    TIndexProjections extends { readonly [K in TIndexName]: StreamIndexProjection },
    TPartitionedIndexName extends string,
    const TConfig extends CommandHandlerOptions | undefined = undefined,
  >(
    decider: Decider<State, Command, TEvent, E>,
    stream: BoundEventStream<
      TEvent,
      TStreamIdFields,
      TMetadata,
      TState,
      TIndexName,
      TIndexProjections,
      TPartitionedIndexName
    >,
    options?: TConfig,
  ): BoundCommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata, TConfig>

  // Data-first: EventStream → CommandHandler
  <
    State,
    Command,
    TEvent,
    E,
    TStreamIdFields extends ReadonlyArray<string>,
    TMetadata,
    TState extends State,
    TIndexName extends string,
    TIndexProjections extends { readonly [K in TIndexName]: StreamIndexProjection },
    TPartitionedIndexName extends string,
    const TConfig extends CommandHandlerOptions | undefined = undefined,
  >(
    decider: Decider<State, Command, TEvent, E>,
    stream: EventStream<
      TEvent,
      TStreamIdFields,
      TMetadata,
      TState,
      TIndexName,
      TIndexProjections,
      TPartitionedIndexName
    >,
    options?: TConfig,
  ): CommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata, TConfig>
} = ((decider: any, streamOrOptions?: any, maybeOptions?: any) => {
  if (hasEventStreamBrand(streamOrOptions)) {
    return makeCommandHandlerImpl(decider, streamOrOptions, maybeOptions)
  }
  const options = streamOrOptions as CommandHandlerOptions | undefined
  return (stream: any) => makeCommandHandlerImpl(decider, stream, options)
}) as typeof commandHandler

// ---------------------------------------------------------------------------
// fold helpers
// ---------------------------------------------------------------------------

/**
 * Reconstruct state from events by folding through a decider's `evolve` function.
 *
 * Pure synchronous — no DynamoDB access.
 */
export const fold: {
  <A>(events: ReadonlyArray<StreamEvent<A>>): <S, C, E>(decider: Decider<S, C, A, E>) => S
  <S, C, A, E>(decider: Decider<S, C, A, E>, events: ReadonlyArray<StreamEvent<A>>): S
} = Function.dual(
  2,
  <S, C, A, E>(decider: Decider<S, C, A, E>, events: ReadonlyArray<StreamEvent<A>>): S => {
    let state = decider.initialState
    for (const event of events) {
      state = decider.evolve(state, event.data)
    }
    return state
  },
)

/**
 * Fold from a starting state (e.g., snapshot + delta events).
 *
 * Pure synchronous — no DynamoDB access.
 */
export const foldFrom: {
  <A>(
    startState: unknown,
    events: ReadonlyArray<StreamEvent<A>>,
  ): <S, C, E>(decider: Decider<S, C, A, E>) => S
  <S, C, A, E>(
    decider: Decider<S, C, A, E>,
    startState: S,
    events: ReadonlyArray<StreamEvent<A>>,
  ): S
} = Function.dual(
  3,
  <S, C, A, E>(
    decider: Decider<S, C, A, E>,
    startState: S,
    events: ReadonlyArray<StreamEvent<A>>,
  ): S => {
    let state = startState
    for (const event of events) {
      state = decider.evolve(state, event.data)
    }
    return state
  },
)

// ---------------------------------------------------------------------------
// Change-feed projections (#151)
// ---------------------------------------------------------------------------

export {
  type AnyEventProjection,
  type ApplyBatchOptions,
  type BatchItemFailuresResponse,
  type BatchResponseSource,
  batchResponse,
  type CheckpointField,
  type DecodableStream,
  type DecodedStreamEvent,
  decoder,
  type EventFilterPattern,
  type EventProjection,
  type EventProjectionTypeId,
  eventFilterPattern,
  type IdentifyBySource,
  type IdentifyWith,
  type ProcessBatchesResult,
  type ProcessBatchOptions,
  type ProcessBatchResult,
  type ProjectionApplied,
  type ProjectionBatchResult,
  type ProjectionCaughtUp,
  type ProjectionCheckpoint,
  type ProjectionConfig,
  type ProjectionError,
  type ProjectionKey,
  type ProjectionOutcome,
  type ProjectionOutcomesOf,
  type ProjectionReadModel,
  type ProjectionReadModelError,
  type ProjectionRebuilt,
  type ProjectionRebuiltRow,
  type ProjectionRejected,
  type ProjectionRequirementsOf,
  type ProjectionState,
  processBatch,
  projection,
  type StreamRecord,
} from "./internal/EventProjection.js"

/**
 * Bind a projection to the services its operations need — `DynamoClient`,
 * the `TableConfig`s of the stream's table and the read model's, `evolve`'s
 * requirements, and a `Compression` registry for packed event data — so every
 * operation has `R = never`. Like {@link bind}, it checks the registry holds
 * the codecs the stream's `storedAs` names (`[EDD-9078]`).
 *
 * @example
 * ```ts
 * const summaries = yield* EventStore.bindProjection(OrderSummaryProjection)
 * export const handler = (event: { Records: Array<EventStore.StreamRecord> }) =>
 *   summaries.processBatch(event.Records, { source: "lambda" }).pipe(
 *     Effect.map((result) => result.response),
 *     Effect.runPromise,
 *   )
 * ```
 */
export const bindProjection = <
  S,
  A,
  TStreamIdFields extends ReadonlyArray<string>,
  M,
  Err,
  R,
  K,
  E,
  I extends boolean,
>(
  projection: EventProjection<S, A, TStreamIdFields, M, Err, R, K, E, I>,
): Effect.Effect<EventProjection<S, A, TStreamIdFields, M, Err, never, K, E, I>, never, R> =>
  Effect.gen(function* () {
    const ctx = yield* Effect.context<R>()
    // The codec check `bind` makes, against the registry captured here.
    yield* Effect.provide(bind(projection.stream), ctx as Context.Context<any>)
    const provide = <X, Y>(effect: Effect.Effect<X, Y, R>): Effect.Effect<X, Y, never> =>
      Effect.provide(effect, ctx)
    return {
      ...projection,
      pipe() {
        // eslint-disable-next-line prefer-rest-params
        return Pipeable.pipeArguments(this, arguments)
      },
      applyBatch: (events, options) => provide(projection.applyBatch(events, options)),
      apply: (event) => provide(projection.apply(event)),
      catchUp: (streamId) => provide(projection.catchUp(streamId)),
      // A multi-projection batch decodes through this, under the captured context.
      [ProjectionDecode]: (image: StreamImage) => provide(projection[ProjectionDecode](image)),
      rebuild: (streamId) => provide(projection.rebuild(streamId)),
      // Both overloads share one implementation.
      processBatch: ((records: ReadonlyArray<StreamRecord>, options: never) =>
        provide(projection.processBatch(records, options))) as EventProjection<
        S,
        A,
        TStreamIdFields,
        M,
        Err,
        never,
        K,
        E,
        I
      >["processBatch"],
    } satisfies EventProjection<S, A, TStreamIdFields, M, Err, never, K, E, I>
  })
