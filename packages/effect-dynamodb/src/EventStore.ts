/**
 * EventStore — Typed, Effect-native event sourcing on DynamoDB.
 *
 * Provides:
 * - `Decider` type for command-event-state modeling
 * - `makeStream` factory for creating event streams bound to a Table
 * - Core operations: `append` (atomic, or opt-in `chunked` across
 *   transactions), `read`, `readFrom`, `currentVersion`, `readLatest` (reads
 *   optionally strongly consistent)
 * - Snapshot primitives: `writeSnapshot`, `readSnapshot`, and inline snapshots
 *   written in the append transaction (`AppendOptions.snapshot`)
 * - `commandHandler` combinator for the load-decide-fold-append cycle
 *   (snapshot-aware single-request loads, consistent loads, an optional
 *   `VersionConflict` retry policy, caller-supplied `expectedVersion`,
 *   decision-derived `additionalItems`, inline snapshots, chunked appends)
 * - `fold` / `foldFrom` helpers for state reconstruction
 *
 * Built on the existing library primitives (DynamoSchema, KeyComposer, Query,
 * DynamoClient, Marshaller).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
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
  PartialAppend,
  TRANSACT_WRITE_ITEMS_LIMIT,
  TransactionCancelled,
  type UniqueConstraintViolation,
  ValidationError,
  VersionConflict,
} from "@effect-dynamodb/schema/Errors.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import {
  DateTime,
  type Duration,
  Effect,
  Function,
  Option,
  Pipeable,
  Schedule,
  Schema,
} from "effect"
import { DynamoClient, type DynamoClientError, type DynamoClientService } from "./DynamoClient.js"
import {
  type BuiltTransactWriteItems,
  buildTransactWriteItems,
  fitsOneTransaction,
  GUARDED_TRANSACTION_ATTEMPTS,
  judgeCancellation,
  measureTransaction,
  refuseOversizedTransaction,
  refuseRepeatedItems,
  type TransactItemTarget,
  type TransactWriteItem,
  type TransactWriteOp,
  transactEntryBytes,
  transactItemTarget,
} from "./internal/TransactWriteOps.js"
import { fromAttributeMap, toAttributeMap } from "./Marshaller.js"
import * as Query from "./Query.js"
import { resolveTtlAttributeName, type Table, type TableConfig } from "./Table.js"

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
  readonly timestamp: string
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
  readonly schema: TSchema
  readonly mode?: SnapshotMode | undefined
  readonly every?: number | undefined
}

/**
 * How {@link commandHandler} writes snapshots.
 *
 * - `"after-append"` (default) — a best-effort `writeSnapshot` after the append
 *   succeeds, at the `every` cadence. A failed snapshot write never fails the
 *   command; the snapshot simply lags until the next threshold crossing.
 * - `"inline"` — the snapshot `Put` rides in the append's own transaction (see
 *   {@link AppendOptions.snapshot}), on every append, or at the `every` cadence
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
 * A chunked append split across transactions ({@link AppendOptions.chunked})
 * claims the command in its **first** transaction, with a `pending` sentinel,
 * and completes the sentinel in its final one. From the first transaction on,
 * every other delivery of the `commandId` — concurrent with the append, or
 * after it failed partway with `PartialAppend` — fails with `DuplicateCommand`
 * and writes nothing. A command whose chunked append failed partway is
 * therefore never applied twice, but nor is it completed by a redelivery: the
 * prefix it left stays recorded under the command, and repairing it is the
 * application's call.
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
 * Options accepted by {@link EventStream.append}.
 *
 * `TState` is the stream's snapshot state type (`never` for a stream without a
 * `snapshot` config, so `snapshot` cannot be supplied there).
 */
export interface AppendOptions<TMetadata, TState = never> {
  /** Per-append metadata, validated against the stream's metadata schema when configured. */
  readonly metadata?: TMetadata
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
   * Split an append too large for one transaction across several. Default
   * `false`: an append over DynamoDB's 100-item or 4 MB transaction limits
   * fails with `AppendTooLarge` (or `ValidationError` for size) before anything
   * is written.
   *
   * With `true`, an append that fits one transaction is written exactly as
   * without it — atomically, in one request. A larger one is split, in order,
   * into transactions that each fit both limits, written sequentially at
   * successive versions:
   *
   * - The **first** carries the version-contiguity check on `expectedVersion`
   *   and, with `idempotency`, claims the command with a `pending` sentinel
   *   (see {@link AppendIdempotency}), so a replay — or a redelivery while
   *   this append is in flight — fails with `DuplicateCommand`. Concurrency is
   *   decided here: its failure maps exactly as a non-chunked append's does. A
   *   cancellation (`VersionConflict`, `DuplicateCommand`, …) means nothing
   *   was written; a transport error leaves the first transaction's outcome
   *   unknown, exactly as it leaves a non-chunked append's, except that what
   *   may have committed is a prefix of the events. Re-read the stream before
   *   acting on one.
   * - Each **later** one checks that the previous chunk's last event exists.
   * - The **final** one also carries `additionalItems`, the completed
   *   idempotency sentinel and the inline `snapshot`, so read models never
   *   show a partially written command. If they cannot fit alongside one
   *   event, the append fails before anything is written: with
   *   `AppendTooLarge` for the item count, or `ValidationError` for the 4 MB
   *   size.
   *
   * **Not atomic.** Readers can observe a prefix of the events, and another
   * writer appending between two chunks aborts the rest: any failure after the
   * first chunk surfaces as `PartialAppend`, carrying the last version known to
   * be committed. The result's `version` is the final version.
   */
  readonly chunked?: boolean | undefined
}

/** Error channel of {@link EventStream.append}. */
export type AppendError =
  | VersionConflict
  | DuplicateCommand
  | PartialAppend
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
 * A stream's latest state as {@link EventStream.readLatest} loads it.
 *
 * - `snapshot` — the stream's snapshot, if one exists (always `None` on a
 *   stream without a `snapshot` config).
 * - `events` — the events after the snapshot (every event when there is
 *   none), ascending by version. Fold them onto the snapshot's state.
 * - `version` — the stream head: the newest event's version, the snapshot's
 *   `asOfVersion` when no event follows it, `0` for an empty stream.
 */
export interface LatestState<TState, TEvent, M = Record<string, unknown> | undefined> {
  readonly snapshot: Option.Option<Snapshot<TState>>
  readonly events: ReadonlyArray<StreamEvent<TEvent, M>>
  readonly version: number
}

// ---------------------------------------------------------------------------
// StreamIdInput — maps composite field names to a required record
// ---------------------------------------------------------------------------

type StreamIdInput<T extends ReadonlyArray<string>> = {
  readonly [K in T[number]]: string
}

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

// ---------------------------------------------------------------------------
// EventStream interface
// ---------------------------------------------------------------------------

/**
 * An EventStream is the repository for a named event stream.
 *
 * Created via {@link makeStream}. Operations are called directly on the stream:
 * `MatchEvents.append(...)`, `MatchEvents.read(...)`, `MatchEvents.query.events(...)`.
 */
export interface EventStream<
  TEvent,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TState = never,
> extends Pipeable.Pipeable {
  readonly [EventStreamTypeId]: EventStreamTypeId
  readonly streamName: string
  readonly eventSchema: Schema.Top

  /**
   * Present iff the stream was created with a `snapshot` config. Its presence
   * is what switches {@link commandHandler} onto the snapshot-aware read path
   * ({@link EventStream.readLatest}); its `mode` decides how the handler writes
   * snapshots.
   */
  readonly snapshotConfig: SnapshotSettings | undefined

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
   * Append `events` after `expectedVersion`, atomically (or, with
   * `chunked: true`, across several transactions) — see {@link AppendOptions}.
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
   * Read the events after `afterVersion` (exclusive), ascending. Pass
   * `{ consistentRead: true }` for read-your-writes — see {@link ReadOptions}.
   */
  readFrom(
    streamId: StreamIdInput<TStreamIdFields>,
    afterVersion: number,
    options?: ReadOptions | undefined,
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
   */
  readLatest(
    streamId: StreamIdInput<TStreamIdFields>,
    options?: ReadOptions | undefined,
  ): Effect.Effect<
    LatestState<TState, TEvent, StreamMetadata<TMetadata>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  readonly query: {
    events(
      streamId: StreamIdInput<TStreamIdFields>,
    ): Query.Query<StreamEvent<TEvent, StreamMetadata<TMetadata>>>
  }
}

// ---------------------------------------------------------------------------
// Append transaction layout (internal)
// ---------------------------------------------------------------------------

/**
 * @internal One `TransactWriteItems` request of an append, laid out for
 * positional cancellation mapping:
 *
 * - `[0, guardCount)` — the version-contiguity `ConditionCheck` (0 or 1 items)
 * - `[guardCount, guardCount + eventCount)` — the event puts
 * - then the `additional` items (caller op order preserved)
 * - then, at `sentinelIndex`, the idempotency sentinel `Put` (on the first
 *   chunk of a chunked append its guarded `pending` claim, on the final chunk
 *   the unconditional completed sentinel)
 * - then the inline snapshot `Put`
 *
 * The sentinel and snapshot come last, so adding them never shifts the
 * additional-item indices the caller sees.
 */
interface AppendTransaction {
  readonly items: Array<TransactWriteItem>
  /** Parallel to `items`, for `refuseRepeatedItems` / `refuseOversizedTransaction`. */
  readonly targets: Array<TransactItemTarget>
  readonly guardCount: number
  readonly eventCount: number
  readonly additional: BuiltTransactWriteItems | undefined
  /** `-1` when the transaction carries no sentinel item. */
  readonly sentinelIndex: number
  /** The version this transaction's events are appended after. */
  readonly baseVersion: number
}

/** @internal Event indices `[from, to)` of one chunk of a chunked append. */
interface AppendChunk {
  readonly from: number
  readonly to: number
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
 * @throws `[EDD-9027]` when `snapshot.every` is not a positive integer.
 * @throws `[EDD-9062]` when `snapshot.mode` is neither `"after-append"` nor
 *   `"inline"`.
 */
export const makeStream = <
  const TEvents extends ReadonlyArray<Schema.Top>,
  TTable extends Table,
  const TStreamName extends string,
  const TStreamId extends { readonly composite: ReadonlyArray<string> },
  TMetadata extends Schema.Top | undefined = undefined,
  TSnapshot extends SnapshotConfig | undefined = undefined,
>(config: {
  readonly table: TTable
  readonly streamName: TStreamName
  readonly events: TEvents
  readonly streamId: TStreamId
  readonly metadata?: TMetadata
  readonly snapshot?: TSnapshot
  readonly casing?: DynamoSchema.Casing | undefined
}): EventStream<
  Schema.Schema.Type<TEvents[number]>,
  TStreamId["composite"],
  TMetadata extends Schema.Top ? Schema.Schema.Type<TMetadata> : undefined,
  TSnapshot extends SnapshotConfig<infer TStateSchema> ? Schema.Schema.Type<TStateSchema> : never
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
  ): Effect.Effect<unknown, ValidationError> =>
    Schema.encodeUnknownEffect(codec)(input).pipe(
      Effect.catch((primaryCause) =>
        Schema.decodeUnknownEffect(codec)(input).pipe(
          Effect.flatMap((decoded) => Schema.encodeUnknownEffect(codec)(decoded)),
          // Surface the original encode error — its message is keyed on the
          // caller's input shape, which is what the user expects to see.
          Effect.catch(() =>
            Effect.fail(new ValidationError({ entityType, operation, cause: primaryCause })),
          ),
        ),
      ),
    )

  // ---------------------------------------------------------------------------
  // Decode a raw DynamoDB item → StreamEvent<TEvent>
  // ---------------------------------------------------------------------------

  const decodeEnvelope = Schema.decodeUnknownEffect(EventEnvelope)

  const decodeStreamEvent = (
    raw: Record<string, unknown>,
  ): Effect.Effect<StreamEvent<TEvent>, ValidationError> =>
    Effect.gen(function* () {
      const toValidationError = (operation: string) => (cause: unknown) =>
        new ValidationError({ entityType, operation, cause })

      const envelope = yield* decodeEnvelope(raw).pipe(
        Effect.mapError(toValidationError("EventStore.decode")),
      )

      const decoder = Schema.decodeUnknownEffect(eventUnion as Schema.Schema<TEvent>)
      const data = yield* (decoder(raw.data) as Effect.Effect<TEvent, unknown>).pipe(
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

  /** Encode snapshot state to wire form through the state schema. */
  const encodeSnapshotState = (
    state: unknown,
    operation: string,
  ): Effect.Effect<unknown, ValidationError> =>
    Schema.encodeUnknownEffect((snapshot as SnapshotConfig).schema as Schema.Codec<unknown>)(
      state,
    ).pipe(
      Effect.mapError(
        (cause) => new ValidationError({ entityType: snapshotEntityType, operation, cause }),
      ),
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
  ): Effect.Effect<OptimisticLockError | ConcurrentModification | undefined, AppendError> =>
    client.transactWriteItems({ TransactItems: tx.items }).pipe(
      Effect.as(undefined),
      Effect.catch(
        (
          error: DynamoClientError,
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
                  expectedVersion: tx.baseVersion,
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
          if (tx.additional !== undefined) {
            const judged = judgeCancellation(
              tx.additional,
              rawReasons,
              tx.guardCount + tx.eventCount,
            )
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
          }

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
    )

  /**
   * Split a chunked append's events into the chunks written BEFORE its final
   * one (#141), in order, each within DynamoDB's 100 items and 4 MB. Chunks
   * are filled by the UPPER bound of the item-size rules
   * `refuseOversizedTransaction` applies (`transactEntryBytes`), so a planned
   * chunk never overfills; only the final chunk, when it is down to one event,
   * is held to the lower bound the refusal uses.
   *
   * - The first chunk carries `firstChunkGuards` (the contiguity check on
   *   `expectedVersion`, the sentinel's `pending` claim); every later one a
   *   contiguity check on the previous chunk's last event.
   * - Chunks are filled greedily until the remaining events fit the final
   *   chunk together with `finalExtras` (additional items, sentinel Put, inline
   *   snapshot), which always keeps at least one event.
   *
   * Fails — before anything is written — when the final chunk's items cannot
   * fit alongside one event: `AppendTooLarge` for the item count,
   * `ValidationError` for the size.
   */
  const planChunks = (spec: {
    readonly eventItems: ReadonlyArray<TransactWriteItem>
    readonly expectedVersion: number
    readonly firstChunkGuards: ReadonlyArray<TransactWriteItem>
    readonly contiguityCheck: (version: number) => TransactWriteItem
    readonly finalExtras: ReadonlyArray<TransactWriteItem>
    /** The final chunk with only the last event: the smallest it can be. */
    readonly smallestFinal: () => AppendTransaction
    readonly tooManyItems: (count: number) => AppendTooLarge
  }): Effect.Effect<ReadonlyArray<AppendChunk>, AppendTooLarge | ValidationError> =>
    Effect.gen(function* () {
      const n = spec.eventItems.length
      const smallest = spec.smallestFinal()
      if (smallest.items.length > TRANSACT_WRITE_ITEMS_LIMIT) {
        return yield* spec.tooManyItems(smallest.items.length)
      }
      yield* refuseOversizedTransaction(smallest.items, smallest.targets, "EventStore.append")

      const bytesOf = (items: ReadonlyArray<TransactWriteItem>) =>
        items.reduce((sum, item) => sum + transactEntryBytes(item, "upper"), 0)
      const eventBytes = spec.eventItems.map((item) => transactEntryBytes(item, "upper"))
      /** `remaining[i]`: the bytes of the events from index `i` on. */
      const remaining = new Array<number>(n + 1).fill(0)
      for (let i = n - 1; i >= 0; i--) remaining[i] = remaining[i + 1]! + eventBytes[i]!
      const extrasBytes = bytesOf(spec.finalExtras)
      const fitsFinal = (from: number) =>
        fitsOneTransaction(
          1 + (n - from) + spec.finalExtras.length,
          transactEntryBytes(spec.contiguityCheck(spec.expectedVersion + from), "upper") +
            remaining[from]! +
            extrasBytes,
        )

      // Every pass takes at least one event and never the last, so the loop
      // ends by `n - 1`, where the final chunk is the smallest one — checked
      // above.
      const chunks: Array<AppendChunk> = []
      let from = 0
      while (from === 0 || (from < n - 1 && !fitsFinal(from))) {
        const guards =
          from === 0 ? spec.firstChunkGuards : [spec.contiguityCheck(spec.expectedVersion + from)]
        let count = guards.length
        let bytes = bytesOf(guards)
        let to = from
        while (to < n - 1 && fitsOneTransaction(count + 1, bytes + eventBytes[to]!)) {
          count++
          bytes += eventBytes[to]!
          to++
        }
        if (to === from) {
          // Unreachable for an event DynamoDB accepts (an item is at most
          // 400 KB), but never loop on it.
          return yield* new ValidationError({
            entityType,
            operation: "EventStore.append",
            cause:
              `EventStore.append: the event at version ${spec.expectedVersion + from + 1} does ` +
              "not fit one transaction. Nothing was written.",
          })
        }
        chunks.push({ from, to })
        from = to
      }
      return chunks
    })

  const append = (
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: AppendOptions<unknown, unknown> | undefined,
  ) =>
    Effect.gen(function* () {
      const additionalOps = options?.additionalItems ?? []
      const idempotency = options?.idempotency
      const snapshotState = options?.snapshot
      const chunked = options?.chunked === true

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
        return { version: expectedVersion, events: [] }
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

      // Guard: every item the transaction will carry — one Put per event, the
      // items each caller-supplied additional op compiles to, the idempotency
      // sentinel, the inline snapshot, and the version-contiguity
      // ConditionCheck when expectedVersion > 0 — must fit DynamoDB's
      // TransactWriteItems limit, unless the caller opted into `chunked`.
      //
      // This first check is a LOWER BOUND, counting one item per additional op.
      // Expansion (uniqueness sentinels, version snapshots — #113) only ever
      // adds items, so an append that already fails here can never fit, and
      // failing now keeps an oversized append free. The authoritative check runs
      // once the ops are compiled, below. A chunked append fails here only when
      // its final chunk — the inline items, a contiguity check and one event —
      // cannot fit.
      const needsContiguityCheck = expectedVersion > 0 && events.length > 0
      const inlineItems =
        (idempotency !== undefined ? 1 : 0) + (snapshotState !== undefined ? 1 : 0)
      const fixedItems = events.length + inlineItems + (needsContiguityCheck ? 1 : 0)
      if (fixedItems + additionalOps.length > TRANSACT_WRITE_ITEMS_LIMIT) {
        const smallestFinalChunk = additionalOps.length + inlineItems + 2
        if (!chunked || events.length <= 1 || smallestFinalChunk > TRANSACT_WRITE_ITEMS_LIMIT) {
          return yield* new AppendTooLarge({
            streamName: config.streamName,
            streamId: streamIdStr,
            count:
              chunked && events.length > 1 ? smallestFinalChunk : fixedItems + additionalOps.length,
            limit: TRANSACT_WRITE_ITEMS_LIMIT,
          })
        }
      }

      const client = yield* DynamoClient
      const tableConfig = yield* config.table.Tag
      const tableName = tableConfig.name

      const pk = composeStreamPk(streamId as Record<string, unknown>)
      // Clock-backed timestamp (deterministic under TestClock; wall-clock in prod).
      const nowDateTime = yield* DateTime.now
      const now = DateTime.formatIso(nowDateTime)

      // Validate and encode metadata to wire form if schema provided
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

            const item: Record<string, unknown> = {
              pk,
              sk: composeEventSk(version),
              __edd_e__: entityType,
              streamId: streamIdStr,
              version,
              eventType: evtType,
              data: eventData,
              timestamp: now,
            }
            if (encodedMetadata !== undefined) {
              item.metadata = encodedMetadata
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
      // A chunked append split across transactions writes it twice: its FIRST
      // transaction claims the command with a guarded `pending` sentinel — so a
      // redelivery while the append is in flight, or after it failed partway,
      // reports DuplicateCommand instead of applying the command again on top
      // of the prefix — and its FINAL transaction overwrites the claim with the
      // completed sentinel, unconditionally: that transaction's event puts
      // prove this append still owns the stream, as they do for the inline
      // snapshot.
      let sentinelPut: TransactWriteItem | undefined
      let sentinelClaim: TransactWriteItem | undefined
      let sentinelComplete: TransactWriteItem | undefined
      if (idempotency !== undefined) {
        const sentinelSk = composeCommandSk(idempotency.commandId)
        const sentinel: Record<string, unknown> = {
          pk,
          sk: sentinelSk,
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
          sentinel[resolveTtlAttributeName(tableConfig)] =
            DateTime.toEpochSeconds(nowDateTime) + ttlSeconds
        }
        sentinelPut = {
          Put: {
            TableName: tableName,
            Item: toAttributeMap(sentinel),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        }
        sentinelClaim = {
          Put: {
            TableName: tableName,
            Item: toAttributeMap({ ...sentinel, pending: true }),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        }
        sentinelComplete = { Put: { TableName: tableName, Item: toAttributeMap(sentinel) } }
      }

      // The inline snapshot (#138): unconditional — see AppendOptions.snapshot.
      let snapshotPut: TransactWriteItem | undefined
      if (snapshotState !== undefined) {
        const encoded = yield* encodeSnapshotState(snapshotState, "EventStore.append.snapshot")
        snapshotPut = {
          Put: {
            TableName: tableName,
            Item: toAttributeMap({
              pk,
              sk: snapshotSk,
              __edd_e__: snapshotEntityType,
              streamId: streamIdStr,
              asOfVersion: expectedVersion + events.length,
              state: encoded,
              timestamp: now,
            }),
          },
        }
      }

      /**
       * Version-contiguity guard: `attribute_not_exists(pk)` on the event puts
       * only rejects STALE expected versions (the target slot already exists).
       * An AHEAD expectedVersion (e.g. 10 when the stream is at 3) would
       * silently write from version 11, leaving a permanent gap. Requiring the
       * event at exactly the version a transaction appends after to exist keeps
       * the appended range contiguous with the stream head. Its failure
       * surfaces as a ConditionalCheckFailed cancellation reason, mapping to
       * VersionConflict just like a stale-version Put failure.
       */
      const contiguityCheck = (version: number): TransactWriteItem => ({
        ConditionCheck: {
          TableName: tableName,
          Key: toAttributeMap({ pk, sk: composeEventSk(version) }),
          ConditionExpression: "attribute_exists(pk)",
        },
      })

      /** Lay out one transaction of this append — see {@link AppendTransaction}. */
      const layout = (spec: {
        /** Event indices `[from, to)` this transaction writes. */
        readonly from: number
        readonly to: number
        /** Contiguity-check the event at this version, if any. */
        readonly checkVersion: number | undefined
        readonly additional?: BuiltTransactWriteItems | undefined
        readonly sentinel?: TransactWriteItem | undefined
        readonly snapshot?: TransactWriteItem | undefined
      }): AppendTransaction => {
        const items: Array<TransactWriteItem> = []
        const targets: Array<TransactItemTarget> = []
        const pushStreamItem = (item: TransactWriteItem, type: string, source: string) => {
          items.push(item)
          targets.push(transactItemTarget(item, tableName, ["pk", "sk"], type, source))
        }
        if (spec.checkVersion !== undefined) {
          pushStreamItem(
            contiguityCheck(spec.checkVersion),
            entityType,
            "the version-contiguity check",
          )
        }
        const guardCount = items.length
        for (let i = spec.from; i < spec.to; i++) {
          pushStreamItem(
            eventItems[i]!,
            entityType,
            `the event at version ${expectedVersion + i + 1}`,
          )
        }
        if (spec.additional !== undefined) {
          items.push(...spec.additional.items)
          targets.push(...spec.additional.targets)
        }
        const sentinelIndex = spec.sentinel === undefined ? -1 : items.length
        if (spec.sentinel !== undefined) {
          pushStreamItem(spec.sentinel, entityType, "the idempotency sentinel")
        }
        if (spec.snapshot !== undefined) {
          pushStreamItem(spec.snapshot, snapshotEntityType, "the inline snapshot")
        }
        return {
          items,
          targets,
          guardCount,
          eventCount: spec.to - spec.from,
          additional: spec.additional,
          sentinelIndex,
          baseVersion: expectedVersion + spec.from,
        }
      }

      /** A transaction carrying more than DynamoDB's item cap. */
      const tooManyItems = (count: number) =>
        new AppendTooLarge({
          streamName: config.streamName,
          streamId: streamIdStr,
          count,
          limit: TRANSACT_WRITE_ITEMS_LIMIT,
        })

      const commandId = idempotency?.commandId
      const done = { version: expectedVersion + events.length, events }

      /** Events durably written by the chunks of a chunked append committed so far. */
      let committed = 0
      const partial = (cause: unknown) =>
        new PartialAppend({
          streamName: config.streamName,
          streamId: streamIdStr,
          expectedVersion,
          committedVersion: expectedVersion + committed,
          intendedVersion: expectedVersion + events.length,
          cause,
        })
      /** After the first chunk commits, every failure is a PartialAppend. */
      const afterFirstChunk = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        committed === 0 ? effect : Effect.mapError(effect, partial)

      // A guarded put among the additional items reads its item; a race with
      // that read cancels the transaction carrying it, which is then built and
      // written again. For a chunked append that is the final chunk alone.
      let lost: OptimisticLockError | ConcurrentModification | undefined
      for (let attempt = 0; attempt < GUARDED_TRANSACTION_ATTEMPTS; attempt++) {
        // Caller-owned items, compiled through the same builder
        // `Transaction.transactWrite` uses, so the two APIs cannot drift.
        const additional = yield* afterFirstChunk(
          buildTransactWriteItems(additionalOps, "EventStore.append.additionalItems"),
        )

        if (committed === 0) {
          // The whole append as one transaction:
          //   [0, C)                version-contiguity ConditionCheck (C is 0 or 1)
          //   [C, C + E)            event puts
          //   [C + E, C + E + A)    additional ITEMS (caller op order preserved)
          //   then                  idempotency sentinel, then inline snapshot
          //                         (last, so adding them never shifts the
          //                         additional-item indices the caller sees)
          //
          // `A` is the count of EMITTED items, which is >= the number of caller
          // ops: a guarded put (#133) expands into its item plus its sentinel
          // reservations and releases plus a snapshot. The caller-facing
          // `indices` on `AdditionalItemConditionFailed` are still indices into
          // the caller's `additionalItems` array — `judgeCancellation` maps them.
          const whole = layout({
            from: 0,
            to: events.length,
            checkVersion: needsContiguityCheck ? expectedVersion : undefined,
            additional,
            sentinel: sentinelPut,
            snapshot: snapshotPut,
          })

          // Authoritative cap check: one additional op can compile to several
          // items (#113), so the pre-flight lower bound above is not
          // sufficient. Reporting the EXPANDED count is the point — "you
          // passed 40 items" when the caller passed 30 ops is baffling without it.
          if (!chunked && whole.items.length > TRANSACT_WRITE_ITEMS_LIMIT) {
            return yield* tooManyItems(whole.items.length)
          }

          // Checked before anything is sent: one op per item — an additional
          // item repeating an event, the contiguity check, the idempotency
          // sentinel or the inline snapshot is refused, as additional items
          // repeating each other are — and the transaction within DynamoDB's
          // 4 MB (#133). A chunked append is checked as a whole too, so its
          // chunks never repeat an item either.
          yield* refuseRepeatedItems(whole.targets, "EventStore.append")
          if (
            !chunked ||
            fitsOneTransaction(whole.items.length, measureTransaction(whole.items).total)
          ) {
            // Fits (or not chunked): exactly the atomic, one-request append.
            yield* refuseOversizedTransaction(whole.items, whole.targets, "EventStore.append")
            const outcome = yield* sendAppendTransaction(client, whole, streamIdStr, commandId)
            if (outcome === undefined) return done
            lost = outcome
            continue
          }

          // Chunked, and too large for one transaction (#141): write every
          // chunk but the final one now. The final chunk is written below, and
          // alone is rebuilt if a guarded additional put loses a race.
          const plan = yield* planChunks({
            eventItems,
            expectedVersion,
            firstChunkGuards: [
              ...(needsContiguityCheck ? [contiguityCheck(expectedVersion)] : []),
              ...(sentinelClaim === undefined ? [] : [sentinelClaim]),
            ],
            contiguityCheck,
            finalExtras: [
              ...additional.items,
              ...(sentinelComplete === undefined ? [] : [sentinelComplete]),
              ...(snapshotPut === undefined ? [] : [snapshotPut]),
            ],
            smallestFinal: () =>
              events.length <= 1
                ? whole
                : layout({
                    from: events.length - 1,
                    to: events.length,
                    checkVersion: expectedVersion + events.length - 1,
                    additional,
                    sentinel: sentinelComplete,
                    snapshot: snapshotPut,
                  }),
            tooManyItems,
          })

          for (const [index, chunk] of plan.entries()) {
            // The first chunk decides concurrency and claims the command: its
            // failure maps exactly as a non-chunked append's does. A
            // cancellation writes nothing; a transport error leaves its outcome
            // unknown, as it leaves a non-chunked append's. (The AWS SDK's own
            // retries are idempotent: it fills in a ClientRequestToken once per
            // request and every retry reuses it, so a retry of a chunk that
            // committed succeeds instead of conflicting with itself.)
            const tx = layout({
              from: chunk.from,
              to: chunk.to,
              checkVersion:
                index === 0
                  ? needsContiguityCheck
                    ? expectedVersion
                    : undefined
                  : expectedVersion + chunk.from,
              sentinel: index === 0 ? sentinelClaim : undefined,
            })
            yield* afterFirstChunk(sendAppendTransaction(client, tx, streamIdStr, commandId))
            committed = chunk.to
          }
        }

        // The final chunk of a chunked append: the remaining events, plus the
        // additional items, the idempotency sentinel and the inline snapshot.
        const outcome = yield* afterFirstChunk(
          Effect.gen(function* () {
            const final = layout({
              from: committed,
              to: events.length,
              checkVersion: expectedVersion + committed,
              additional,
              sentinel: sentinelComplete,
              snapshot: snapshotPut,
            })
            if (final.items.length > TRANSACT_WRITE_ITEMS_LIMIT) {
              return yield* tooManyItems(final.items.length)
            }
            yield* refuseRepeatedItems(final.targets, "EventStore.append")
            yield* refuseOversizedTransaction(final.items, final.targets, "EventStore.append")
            return yield* sendAppendTransaction(client, final, streamIdStr, commandId)
          }),
        )
        if (outcome === undefined) return done
        lost = outcome
      }
      return yield* Effect.fail(committed === 0 ? lost! : partial(lost!))
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
    options?: ReadOptions | undefined,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      // Versions are integers, so the inclusive lower bound `afterVersion + 1`
      // is exactly the old exclusive `#sk > eventSk(afterVersion)`. The upper
      // bound keeps the snapshot item (which sorts after every event) out of the
      // scanned range.
      const query = withReadOptions(
        buildEventsQuery(streamId).pipe(
          Query.where({ between: [composeEventSk(afterVersion + 1), maxEventSk] }),
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

      const encoded = yield* encodeSnapshotState(state, "EventStore.writeSnapshot")

      const item: Record<string, unknown> = {
        pk: composeStreamPk(streamId as Record<string, unknown>),
        sk: snapshotSk,
        __edd_e__: snapshotEntityType,
        streamId: composeStreamIdString(streamId as Record<string, unknown>),
        asOfVersion,
        state: encoded,
        timestamp: now,
      }

      yield* client
        .putItem({
          TableName: tableName,
          Item: toAttributeMap(item),
          // Monotonic: never regress the cache. Losing this race is a no-op,
          // not an error — the events it summarises are already durable.
          ConditionExpression: "attribute_not_exists(#pk) OR #asOfVersion < :asOfVersion",
          ExpressionAttributeNames: { "#pk": "pk", "#asOfVersion": "asOfVersion" },
          ExpressionAttributeValues: toAttributeMap({ ":asOfVersion": asOfVersion }),
        })
        .pipe(
          Effect.catchIf(
            (error) => isAwsConditionalCheckFailed(error.cause),
            () => Effect.void,
          ),
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
    Schema.decodeUnknownEffect((snapshot as SnapshotConfig).schema as Schema.Codec<unknown>)(
      raw.state,
    ).pipe(
      Effect.mapError(
        (cause) => new ValidationError({ entityType: snapshotEntityType, operation, cause }),
      ),
      Effect.map(
        (state): Snapshot<unknown> => ({
          state,
          asOfVersion: raw.asOfVersion as number,
          timestamp: raw.timestamp as string,
        }),
      ),
    )

  const readSnapshot = (
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<
    Option.Option<Snapshot<unknown>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      if (snapshot === undefined) return yield* snapshotUnavailable("readSnapshot")

      const client = yield* DynamoClient
      const { name: tableName } = yield* config.table.Tag

      const result = yield* client.getItem({
        TableName: tableName,
        Key: toAttributeMap({
          pk: composeStreamPk(streamId as Record<string, unknown>),
          sk: snapshotSk,
        }),
        ConsistentRead: true,
      })

      if (result.Item === undefined) return Option.none<Snapshot<unknown>>()
      return Option.some(
        yield* decodeSnapshotItem(fromAttributeMap(result.Item), "EventStore.readSnapshot"),
      )
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
    options?: ReadOptions | undefined,
  ): Effect.Effect<
    LatestState<unknown, TEvent>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      // Without a snapshot config there is nothing to read but the events.
      if (snapshot === undefined) {
        const events = yield* read(streamId, options)
        return {
          snapshot: Option.none<Snapshot<unknown>>(),
          events,
          version: events[events.length - 1]?.version ?? 0,
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
      resolveTableName: config.table.Tag.useSync((tc: TableConfig) => tc.name),
      keyFields: ["pk", "sk"],
      // Bound to the event SK range so non-event items in the stream partition
      // (the snapshot) are excluded at the key-condition level. A caller-supplied
      // `Query.where` replaces this — the `__edd_e__` filter still applies.
    }).pipe(Query.where({ beginsWith: eventSkPrefix }))
  }

  const queryNamespace = {
    events: (streamId: StreamIdInput<TStreamIdFields>) => buildEventsQuery(streamId),
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
    snapshotConfig: snapshotSettings,
    writeSnapshot,
    readSnapshot,
    append,
    read,
    readFrom,
    currentVersion,
    readLatest,
    query: queryNamespace,
    [StreamIdFormatter]: composeStreamIdString,
    [CommandSentinelProbe]: hasCommandSentinel,
  } as unknown as EventStream<
    TEvent,
    TStreamIdFields,
    TMetadata extends Schema.Top ? Schema.Schema.Type<TMetadata> : undefined,
    TSnapshot extends SnapshotConfig<infer TStateSchema> ? Schema.Schema.Type<TStateSchema> : never
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
> extends Pipeable.Pipeable {
  readonly [EventStreamTypeId]: EventStreamTypeId
  readonly streamName: string
  readonly eventSchema: Schema.Top

  /** See {@link EventStream.snapshotConfig}. */
  readonly snapshotConfig: SnapshotSettings | undefined

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
    options?: ReadOptions | undefined,
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
    options?: ReadOptions | undefined,
  ): Effect.Effect<
    LatestState<TState, TEvent, StreamMetadata<TMetadata>>,
    DynamoClientError | ValidationError,
    never
  >

  readonly query: {
    events(
      streamId: StreamIdInput<TStreamIdFields>,
    ): Query.Query<StreamEvent<TEvent, StreamMetadata<TMetadata>>>
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
export const bind = <TEvent, TStreamIdFields extends ReadonlyArray<string>, TMetadata, TState>(
  stream: EventStream<TEvent, TStreamIdFields, TMetadata, TState>,
): Effect.Effect<
  BoundEventStream<TEvent, TStreamIdFields, TMetadata, TState>,
  never,
  DynamoClient | TableConfig
> =>
  Effect.gen(function* () {
    const ctx = yield* Effect.context<DynamoClient | TableConfig>()
    const provide = <A, E>(
      effect: Effect.Effect<A, E, DynamoClient | TableConfig>,
    ): Effect.Effect<A, E, never> => Effect.provide(effect, ctx)
    const probe = commandSentinelProbeOf(stream)

    return {
      [EventStreamTypeId]: EventStreamTypeId,
      pipe() {
        // eslint-disable-next-line prefer-rest-params
        return Pipeable.pipeArguments(this, arguments)
      },
      streamName: stream.streamName,
      eventSchema: stream.eventSchema,
      snapshotConfig: stream.snapshotConfig,
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
      query: stream.query,
      provide,
      [StreamIdFormatter]: (id: Record<string, unknown>) => formatStreamIdOf(stream, id),
      [CommandSentinelProbe]:
        probe === undefined
          ? undefined
          : (id: Record<string, unknown>, commandId: string) => provide(probe(id, commandId)),
    } as BoundEventStream<TEvent, TStreamIdFields, TMetadata, TState>
  })

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
   * re-reads the snapshot and its delta, and a function-form `additionalItems`
   * is re-evaluated against the new decision.
   *
   * A number `n` is shorthand for `Schedule.recurs(n)` (n retries *after* the
   * initial attempt). Omit for the default: no retry.
   *
   * `DuplicateCommand` is deliberately NOT retried — it is terminal — and nor
   * is `PartialAppend` (part of the decision is already written). Nor is any
   * call that supplies {@link CommandOptions.expectedVersion}: the caller asked
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
   * Default for {@link CommandOptions.chunked}: split an append too large for
   * one transaction across several — see {@link AppendOptions.chunked}. A
   * per-call `chunked` overrides it. Default `false`.
   */
  readonly chunked?: boolean | undefined
}

/**
 * The outcome of one `decide` call, handed to a function-form
 * {@link CommandOptions.additionalItems}.
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
 * The forms {@link CommandOptions.additionalItems} accepts: a static array of
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
 * Per-call options accepted by a handler produced by {@link commandHandler}.
 *
 * `State` / `Event` type the {@link Decision} a function-form `additionalItems`
 * receives; `E2` / `R2` are the error and requirements of the `Effect` it may
 * return. The handler infers all four, so they only need naming when this type
 * is written out by hand.
 */
export interface CommandOptions<
  TMetadata,
  State = unknown,
  Event = unknown,
  E2 = never,
  R2 = never,
> {
  readonly metadata?: TMetadata
  /**
   * Identifier for this command delivery. Required when the handler was created
   * with `idempotency`; a replayed id fails with `DuplicateCommand` — also when
   * the replay carries an {@link expectedVersion} the stream has since moved
   * past (see there).
   *
   * Otherwise the sentinel is consulted when the events are appended, after
   * `decide`, so a replay whose `decide` fails against the advanced state
   * reports that failure, and one whose `decide` returns no events succeeds as
   * a no-op.
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
   * (see {@link AppendOptions.additionalItems}).
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
   * Split this call's append across transactions when it is too large for
   * one — see {@link AppendOptions.chunked}. Overrides the handler's
   * {@link CommandHandlerOptions.chunked}. **Not atomic** past the first
   * transaction: a failure after it surfaces as `PartialAppend`, which is
   * never retried. The `additionalItems`, the completed idempotency sentinel
   * and the inline snapshot ride on the final transaction; the first one
   * claims the command, so a redelivery never applies it twice (see
   * {@link AppendIdempotency}).
   */
  readonly chunked?: boolean | undefined
}

/** Per-call options when the handler was created with `idempotency` — `commandId` is required. */
export interface IdempotentCommandOptions<
  TMetadata,
  State = unknown,
  Event = unknown,
  E2 = never,
  R2 = never,
> extends CommandOptions<TMetadata, State, Event, E2, R2> {
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
> = TConfig extends { readonly idempotency: object }
  ? [options: IdempotentCommandOptions<TMetadata, State, TEvent, E2, R2>]
  : [options?: CommandOptions<TMetadata, State, TEvent, E2, R2> | undefined]

type CommandHandlerErrors<E> =
  | E
  | VersionConflict
  | DuplicateCommand
  | PartialAppend
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
 * `Effect`; both are `never` otherwise.
 */
type CommandHandler<
  State,
  Command,
  TEvent,
  E,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TConfig extends CommandHandlerOptions | undefined = undefined,
> = <E2 = never, R2 = never>(
  streamId: StreamIdInput<TStreamIdFields>,
  command: Command,
  ...options: CommandOptionsArgs<TMetadata, TConfig, State, TEvent, E2, R2>
) => Effect.Effect<
  CommandHandlerResult<State, TEvent>,
  CommandHandlerErrors<E> | E2,
  DynamoClient | TableConfig | R2
>

/**
 * A handler over a {@link BoundEventStream}: the stream's services are already
 * provided, so a function-form `additionalItems`' `R2` is its only requirement.
 */
type BoundCommandHandler<
  State,
  Command,
  TEvent,
  E,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TConfig extends CommandHandlerOptions | undefined = undefined,
> = <E2 = never, R2 = never>(
  streamId: StreamIdInput<TStreamIdFields>,
  command: Command,
  ...options: CommandOptionsArgs<TMetadata, TConfig, State, TEvent, E2, R2>
) => Effect.Effect<CommandHandlerResult<State, TEvent>, CommandHandlerErrors<E> | E2, R2>

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
  S extends BoundEventStream<any, infer TStreamIdFields, infer TMetadata, any>
    ? BoundCommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata, TConfig>
    : S extends EventStream<any, infer TStreamIdFields, infer TMetadata, any>
      ? CommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata, TConfig>
      : never

/** @internal Both `EventStream` and `BoundEventStream` carry this brand. */
const hasEventStreamBrand = (u: unknown): boolean =>
  typeof u === "object" && u !== null && EventStreamTypeId in u

/** @internal Resolve a {@link CommandOptions.additionalItems} against a decision. */
const deriveAdditionalItems = <State, Event>(
  input: AdditionalItemsInput<State, Event, unknown, unknown> | undefined,
  decision: Decision<State, Event>,
): Effect.Effect<ReadonlyArray<TransactWriteOp> | undefined, unknown, unknown> => {
  if (typeof input !== "function") return Effect.succeed(input)
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
    | EventStream<TEvent, TStreamIdFields, TMetadata, any>
    | BoundEventStream<TEvent, TStreamIdFields, TMetadata, any>,
  options: CommandHandlerOptions | undefined,
) => {
  const retryPolicy = options?.retry
  const schedule =
    retryPolicy === undefined
      ? undefined
      : typeof retryPolicy === "number"
        ? Schedule.recurs(retryPolicy)
        : retryPolicy
  // Consistent by default: an eventually consistent load can hand `decide`
  // state that misses acknowledged events (#139).
  const readOptions: ReadOptions = { consistentRead: options?.consistentRead ?? true }

  return (
    streamId: StreamIdInput<TStreamIdFields>,
    command: Command,
    callOptions?: CommandOptions<TMetadata, State, TEvent, unknown, unknown> | undefined,
  ) => {
    const expectedVersion = callOptions?.expectedVersion

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

      const snapshotSettings = stream.snapshotConfig

      // 1. Establish the base state + version. A snapshot-configured stream
      //    loads its snapshot, the events after it and its head in one
      //    request (#138); any other stream replays from the beginning.
      let state = decider.initialState
      let baseVersion = 0
      let snapshotAsOfVersion = 0

      if (snapshotSettings !== undefined) {
        const latest = (yield* stream.readLatest(streamId, readOptions)) as LatestState<
          State,
          TEvent,
          unknown
        >
        if (Option.isSome(latest.snapshot)) {
          snapshotAsOfVersion = latest.snapshot.value.asOfVersion
          state = latest.snapshot.value.state
        }
        for (const event of latest.events) {
          state = decider.evolve(state, event.data)
        }
        baseVersion = latest.version
      } else {
        const events = yield* stream.read(streamId, readOptions)
        for (const event of events) {
          state = decider.evolve(state, event.data)
        }
        const newest = events[events.length - 1]
        baseVersion = newest === undefined ? 0 : newest.version
      }

      // 2. If-Match (#136): the caller saw a different version, so `decide`
      //    must not run against state the caller never saw.
      if (expectedVersion !== undefined && expectedVersion !== baseVersion) {
        // A redelivery of a command that already committed (its response was
        // lost) arrives with its original If-Match, which the stream has since
        // moved past. It is a duplicate, not a lost race — `append` ranks
        // `DuplicateCommand` above `VersionConflict` for the same reason — so
        // consult the sentinel before reporting the conflict. The extra read is
        // paid on this conflict path only.
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
          expectedVersion,
          actualVersion: baseVersion,
        })
      }

      // 3. Decide
      const newEvents = yield* decider.decide(command, state)

      // 4. No-op command — return current state
      if (newEvents.length === 0) {
        return { state, version: baseVersion, events: [] }
      }

      // 5. Fold the new events BEFORE appending (#137): the post-decision state
      //    is what a function-form `additionalItems` projects, what a snapshot
      //    records, and what the handler returns — always the `evolve` fold,
      //    never anything produced inside `decide`.
      const previous = state
      let next = state
      for (const event of newEvents) {
        next = decider.evolve(next, event)
      }

      // 6. Derive the caller's items from the decision. Re-run on every
      //    attempt, because the whole cycle is the retried unit.
      const additionalItems = yield* deriveAdditionalItems(callOptions?.additionalItems, {
        events: newEvents,
        state: next,
        previous,
        version: baseVersion,
      })

      // 7. Append with optimistic concurrency, plus the caller's items, the
      //    dedup sentinel and an inline snapshot, all in one transaction (or,
      //    chunked, with all three on the final one). `baseVersion` equals any
      //    caller-supplied `expectedVersion` here (checked in step 2).
      const appendOptions: {
        metadata?: TMetadata
        additionalItems?: ReadonlyArray<TransactWriteOp>
        idempotency?: AppendIdempotency
        snapshot?: State
        chunked?: boolean
      } = {}
      if (callOptions?.metadata !== undefined) appendOptions.metadata = callOptions.metadata
      if (additionalItems !== undefined) appendOptions.additionalItems = additionalItems
      if (options?.idempotency !== undefined && callOptions?.commandId !== undefined) {
        appendOptions.idempotency =
          options.idempotency.ttl !== undefined
            ? { commandId: callOptions.commandId, ttl: options.idempotency.ttl }
            : { commandId: callOptions.commandId }
      }
      if ((callOptions?.chunked ?? options?.chunked) === true) appendOptions.chunked = true

      // Inline snapshots (#138) ride in the append transaction: on every
      // append, or once `every` events have accumulated since the snapshot.
      const mode = snapshotSettings?.mode ?? "after-append"
      const every = snapshotSettings?.every
      const newVersion = baseVersion + newEvents.length
      if (
        snapshotSettings !== undefined &&
        mode === "inline" &&
        (every === undefined || newVersion - snapshotAsOfVersion >= every)
      ) {
        appendOptions.snapshot = next
      }

      const result = yield* stream.append(
        streamId,
        newEvents,
        baseVersion,
        appendOptions as AppendOptions<TMetadata, any>,
      )

      // 8. After-append snapshots, once the cadence threshold is crossed.
      //    Best-effort: the events are already durable, so a snapshot-write
      //    failure must not report the command as failed. The next threshold
      //    crossing retries it.
      if (
        mode === "after-append" &&
        every !== undefined &&
        result.version - snapshotAsOfVersion >= every
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

      return { state: next, version: result.version, events: newEvents }
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
          // commandId can never succeed — `AdditionalItemConditionFailed`
          // will not resolve itself by re-deciding either, and a
          // `PartialAppend` has already written part of the decision.
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
 * // If-Match: fail with VersionConflict (never retried) unless the stream is at v7
 * yield* handle({ matchId: "m-1" }, command, { expectedVersion: 7 })
 *
 * // Inline projection, committed in the same transaction as the events
 * yield* handle({ matchId: "m-1" }, command, {
 *   additionalItems: ({ state }) => [Scoreboard.put({ matchId: "m-1", runs: state.runs })],
 * })
 *
 * // A command that may emit more events than one transaction holds
 * yield* handle({ matchId: "m-1" }, importCommand, { chunked: true })
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
 *   from the beginning.
 * - **expectedVersion.** See {@link CommandOptions.expectedVersion}.
 * - **Fold before append.** The new events are folded into state before the
 *   append, so the state returned, snapshotted and handed to a function-form
 *   `additionalItems` (see {@link Decision}) is always the `evolve` fold.
 * - **Snapshot.** With `snapshot.mode: "inline"`, the snapshot is written in
 *   the append transaction itself — on every append, or at the `every`
 *   cadence. With the default `"after-append"` and `snapshot.every` set, a
 *   fresh snapshot is written (best-effort) after a successful append once the
 *   cadence threshold is crossed. See {@link SnapshotMode}.
 * - **Chunked.** `chunked: true` (handler default or per call) splits an
 *   append too large for one transaction — see {@link AppendOptions.chunked}.
 *   A `PartialAppend` is never retried.
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
      | BoundEventStream<TEvent, any, any, State>
      | EventStream<TEvent, ReadonlyArray<string>, any, State>,
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
    const TConfig extends CommandHandlerOptions | undefined = undefined,
  >(
    decider: Decider<State, Command, TEvent, E>,
    stream: BoundEventStream<TEvent, TStreamIdFields, TMetadata, TState>,
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
    const TConfig extends CommandHandlerOptions | undefined = undefined,
  >(
    decider: Decider<State, Command, TEvent, E>,
    stream: EventStream<TEvent, TStreamIdFields, TMetadata, TState>,
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
