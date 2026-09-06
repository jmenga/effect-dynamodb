/**
 * EventStore — Typed, Effect-native event sourcing on DynamoDB.
 *
 * Provides:
 * - `Decider` type for command-event-state modeling
 * - `makeStream` factory for creating event streams bound to a Table
 * - Core operations: `append`, `read`, `readFrom`, `currentVersion`
 * - Snapshot primitives: `writeSnapshot`, `readSnapshot`
 * - `commandHandler` combinator for read-decide-append cycle (snapshot-aware,
 *   with an optional `VersionConflict` retry policy)
 * - `fold` / `foldFrom` helpers for state reconstruction
 *
 * Built on the existing library primitives (DynamoSchema, KeyComposer, Query,
 * DynamoClient, Marshaller).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { normalizeTtlSeconds } from "@effect-dynamodb/schema/Entity.js"
import {
  AdditionalItemConditionFailed,
  AppendTooLarge,
  DuplicateCommand,
  isAwsConditionalCheckFailed,
  isAwsTransactionCancelled,
  TRANSACT_WRITE_ITEMS_LIMIT,
  TransactionCancelled,
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
import { DynamoClient, type DynamoClientError } from "./DynamoClient.js"
import {
  buildTransactWriteItems,
  type TransactWriteItem,
  type TransactWriteOp,
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
 * - `evolve` — pure left fold: apply one event to a state
 * - `initialState` — starting state for a new aggregate
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
 * - `every` — optional auto-snapshot cadence for {@link commandHandler}: after a
 *   successful append, write a fresh snapshot once at least this many events
 *   have accumulated since the last one. Must be a positive integer.
 */
export interface SnapshotConfig<TSchema extends Schema.Top = Schema.Top> {
  readonly schema: TSchema
  readonly every?: number | undefined
}

/** The runtime snapshot settings exposed on a stream. */
export interface SnapshotSettings {
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
 * The sentinel is co-located in the stream's own partition, so `commandId`
 * uniqueness is scoped to the stream (which is what "have I already applied this
 * command to this aggregate?" asks). It is invisible to `read` / `readFrom` /
 * `currentVersion`, which filter on the event entity type.
 *
 * **Casing:** the sentinel sort key is composed with the schema's casing (default
 * `"lowercase"`), so command ids that differ only in case collide. Use
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

/** Options accepted by {@link EventStream.append}. */
export interface AppendOptions<TMetadata> {
  /** Per-append metadata, validated against the stream's metadata schema when configured. */
  readonly metadata?: TMetadata
  /**
   * Caller-owned transact items committed atomically with the events — the same
   * op union `Transaction.transactWrite` accepts (`EntityPut`, `EntityDelete`,
   * `Transaction.check(...)`).
   *
   * Conditional failures on these items are reported as
   * `AdditionalItemConditionFailed` (carrying the 0-based indices into this
   * array), never as `VersionConflict`.
   */
  readonly additionalItems?: ReadonlyArray<TransactWriteOp>
  /** Opt in to exactly-once command processing — see {@link AppendIdempotency}. */
  readonly idempotency?: AppendIdempotency
}

/** Error channel of {@link EventStream.append}. */
export type AppendError =
  | VersionConflict
  | DuplicateCommand
  | AdditionalItemConditionFailed
  | AppendTooLarge
  | DynamoClientError
  | ValidationError
  | TransactionCancelled

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
   * is what switches {@link commandHandler} onto the snapshot-aware read path.
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

  append(
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: AppendOptions<TMetadata> | undefined,
  ): Effect.Effect<AppendResult<TEvent>, AppendError, DynamoClient | TableConfig>

  read(
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  readFrom(
    streamId: StreamIdInput<TStreamIdFields>,
    afterVersion: number,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  currentVersion(
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<number, DynamoClientError | ValidationError, DynamoClient | TableConfig>

  readonly query: {
    events(
      streamId: StreamIdInput<TStreamIdFields>,
    ): Query.Query<StreamEvent<TEvent, StreamMetadata<TMetadata>>>
  }
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
 * @throws `[EDD-9027]` when `snapshot.every` is not a positive integer.
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
}): EventStream<
  Schema.Schema.Type<TEvents[number]>,
  TStreamId["composite"],
  TMetadata extends Schema.Top ? Schema.Schema.Type<TMetadata> : undefined,
  TSnapshot extends SnapshotConfig<infer TStateSchema> ? Schema.Schema.Type<TStateSchema> : never
> => {
  type TEvent = Schema.Schema.Type<TEvents[number]>
  type TStreamIdFields = TStreamId["composite"]

  const schema = config.table.schema
  const entityType = `${config.streamName.toLowerCase()}.event`
  const snapshotEntityType = `${config.streamName.toLowerCase()}.snapshot`
  /**
   * Entity type of the command-dedup sentinel. Distinct from `entityType` so the
   * sentinel is filtered out of every event query (`read`, `readFrom`,
   * `currentVersion` all constrain `__edd_e__`), and it sorts before the event
   * keys (`.command` < `.event`) so it also falls outside `readFrom` ranges.
   */
  const commandEntityType = `${config.streamName.toLowerCase()}.command`
  const compositeFields = config.streamId.composite

  // -------------------------------------------------------------------------
  // Snapshot config validation (EDD-9027) — fail fast at definition time.
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
  const snapshotSettings: SnapshotSettings | undefined =
    snapshot === undefined ? undefined : { every: snapshot.every }

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
    return DynamoSchema.composeKey(schema, config.streamName.toLowerCase(), composites)
  }

  const composeEventSk = (version: number): string =>
    DynamoSchema.composeEventVersionKey(schema, entityType, version)

  /**
   * Every event SK begins with this; nothing else in the stream partition does.
   * Bounding event reads to it excludes the snapshot item at the key-condition
   * level, which matters because DynamoDB applies `Limit` *before*
   * `FilterExpression` — a filtered-out snapshot would still burn a `Limit` slot.
   */
  const eventSkPrefix = DynamoSchema.composeEventVersionKeyPrefix(schema, entityType)

  /** Inclusive upper bound of the event SK range (10-digit padding maximum). */
  const maxEventSk = composeEventSk(DynamoSchema.MAX_EVENT_VERSION)

  /**
   * The snapshot SK. Distinct entity-type label (`<stream>.snapshot` vs
   * `<stream>.event_1#…`), so it can never collide with an event SK, and it
   * sorts after every event in the partition.
   */
  const snapshotSk = DynamoSchema.composeKey(schema, snapshotEntityType, [])

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

  const append = (
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: AppendOptions<unknown> | undefined,
  ) =>
    Effect.gen(function* () {
      const additionalOps = options?.additionalItems ?? []
      const idempotency = options?.idempotency

      // Nothing at all to write — preserve the historical no-op fast path.
      // With additional items or a dedup sentinel the transaction still runs:
      // a caller who asked for a side write means it, and silently dropping it
      // would lose data.
      if (events.length === 0 && additionalOps.length === 0 && idempotency === undefined) {
        return { version: expectedVersion, events: [] }
      }

      // Resolve stream ID string for storage (join composites)
      const streamIdStr = composeStreamIdString(streamId as Record<string, unknown>)

      // Guard: every item the transaction will carry — one Put per event, the
      // items each caller-supplied additional op compiles to, the idempotency
      // sentinel, and the version-contiguity ConditionCheck when
      // expectedVersion > 0 — must fit DynamoDB's TransactWriteItems limit.
      // Never chunk: chunking would break append atomicity.
      //
      // This first check is a LOWER BOUND, counting one item per additional op.
      // Expansion (uniqueness sentinels, version snapshots — #113) only ever
      // adds items, so an append that already fails here can never fit, and
      // failing now keeps an oversized append free. The authoritative check runs
      // once the ops are compiled, below.
      const needsContiguityCheck = expectedVersion > 0 && events.length > 0
      const fixedItems =
        events.length + (idempotency !== undefined ? 1 : 0) + (needsContiguityCheck ? 1 : 0)
      if (fixedItems + additionalOps.length > TRANSACT_WRITE_ITEMS_LIMIT) {
        return yield* new AppendTooLarge({
          streamName: config.streamName,
          streamId: streamIdStr,
          count: fixedItems + additionalOps.length,
          limit: TRANSACT_WRITE_ITEMS_LIMIT,
        })
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
      const eventItems = yield* Effect.forEach(events, (event, i) =>
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
      // Caller-owned items, compiled through the same builder
      // `Transaction.transactWrite` uses, so the two APIs cannot drift.
      const { items: additionalItems, provenance: additionalProvenance } =
        yield* buildTransactWriteItems(additionalOps, "EventStore.append.additionalItems")

      // Authoritative cap check: one additional op can compile to several items
      // (#113), so the pre-flight lower bound above is not sufficient. Reporting
      // the EXPANDED count is the point — "you passed 40 items" when the caller
      // passed 30 ops is baffling without it.
      if (fixedItems + additionalItems.length > TRANSACT_WRITE_ITEMS_LIMIT) {
        return yield* new AppendTooLarge({
          streamName: config.streamName,
          streamId: streamIdStr,
          count: fixedItems + additionalItems.length,
          limit: TRANSACT_WRITE_ITEMS_LIMIT,
        })
      }

      // Version-contiguity guard: `attribute_not_exists(pk)` on the event puts
      // only rejects STALE expected versions (the target slot already exists).
      // An AHEAD expectedVersion (e.g. 10 when the stream is at 3) would
      // silently write from version 11, leaving a permanent gap. When
      // expectedVersion > 0, require the event at exactly `expectedVersion` to
      // exist so the appended range is contiguous with the stream head. Its
      // failure surfaces as a ConditionalCheckFailed cancellation reason,
      // mapping to VersionConflict below just like a stale-version Put failure.
      //
      // Only when events are actually being written: the guard exists to stop an
      // AHEAD expectedVersion opening a permanent gap, and a zero-event append
      // (pure `additionalItems` / sentinel side-write) writes no version and so
      // can open no gap.
      const contiguityCheck: Array<TransactWriteItem> = needsContiguityCheck
        ? [
            {
              ConditionCheck: {
                TableName: tableName,
                Key: toAttributeMap({ pk, sk: composeEventSk(expectedVersion) }),
                ConditionExpression: "attribute_exists(pk)",
              },
            },
          ]
        : []

      // Item layout is load-bearing — cancellation reasons are positional:
      //   [0, C)                version-contiguity ConditionCheck (C is 0 or 1)
      //   [C, C + E)            event puts
      //   [C + E, C + E + A)    additional ITEMS (caller op order preserved)
      //   C + E + A             idempotency sentinel (last, so adding it never
      //                         shifts the additional-item indices the caller sees)
      //
      // `A` is the count of EMITTED items, which is >= the number of caller ops:
      // a `unique` / `retain` put expands into its item plus sentinels plus a
      // snapshot (#113). The 1:1 "item index == caller index" assumption is gone,
      // so the reason mapping below goes through `additionalProvenance` — the
      // caller-facing `indices` on `AdditionalItemConditionFailed` are still
      // indices into the caller's `additionalItems` array, unchanged.
      const transactItems: Array<TransactWriteItem> = [
        ...contiguityCheck,
        ...eventItems,
        ...additionalItems,
      ]
      const checkCount = contiguityCheck.length
      const eventCount = eventItems.length
      const additionalCount = additionalItems.length
      const sentinelIndex = idempotency !== undefined ? transactItems.length : -1

      if (idempotency !== undefined) {
        const sentinel: Record<string, unknown> = {
          pk,
          sk: DynamoSchema.composeKey(schema, commandEntityType, [idempotency.commandId]),
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
        transactItems.push({
          Put: {
            TableName: tableName,
            Item: toAttributeMap(sentinel),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        })
      }

      yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
        Effect.mapError((error) => {
          if (!isAwsTransactionCancelled(error.cause)) {
            return error as AppendError
          }
          const reasons = (error.cause.CancellationReasons ?? []).map((r) => ({
            code: r?.Code,
            message: r?.Message,
          }))
          const failedAt = (index: number): boolean =>
            index >= 0 && reasons[index]?.code === "ConditionalCheckFailed"

          // Precedence is ordered by how terminal the caller's response should
          // be: a duplicate can never succeed on retry, a version conflict
          // invites a re-read, and only then is the caller's own condition the
          // most specific explanation left.
          if (idempotency !== undefined && failedAt(sentinelIndex)) {
            return new DuplicateCommand({
              streamName: config.streamName,
              streamId: streamIdStr,
              commandId: idempotency.commandId,
            }) as AppendError
          }

          // The contiguity ConditionCheck and the event puts both mean "the
          // stream is not where you said it was", so they share one verdict.
          for (let i = 0; i < checkCount + eventCount; i++) {
            if (failedAt(i)) {
              return new VersionConflict({
                streamName: config.streamName,
                streamId: streamIdStr,
                expectedVersion,
              }) as AppendError
            }
          }

          // Attribute each failed additional ITEM back to the caller OP that
          // produced it. Several items can belong to one op (its main item, its
          // sentinels, its snapshot), so indices are deduped — a caller who
          // passed one op must never see it reported twice.
          const failedOps = new Set<number>()
          for (let i = 0; i < additionalCount; i++) {
            if (!failedAt(checkCount + eventCount + i)) continue
            const from = additionalProvenance[i]
            // A reason with no provenance entry cannot be justified positionally;
            // fall through to TransactionCancelled rather than guess.
            if (from !== undefined) failedOps.add(from.opIndex)
          }
          const failedAdditional = Array.from(failedOps).sort((a, b) => a - b)
          if (failedAdditional.length > 0) {
            return new AdditionalItemConditionFailed({
              streamName: config.streamName,
              streamId: streamIdStr,
              indices: failedAdditional,
              reasons,
            }) as AppendError
          }

          // No conditional failure we can positionally justify (throttling,
          // TransactionConflict, or a truncated/absent reason list) — never
          // guess a VersionConflict.
          return new TransactionCancelled({
            operation: "TransactWriteItems",
            reasons,
            cause: error.cause,
          }) as AppendError
        }),
      )

      return {
        version: expectedVersion + events.length,
        events,
      }
    })

  // ---------------------------------------------------------------------------
  // read
  // ---------------------------------------------------------------------------

  const read = (
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  > =>
    Effect.gen(function* () {
      const query = buildEventsQuery(streamId)
      return yield* Query.collect(query)
    })

  // ---------------------------------------------------------------------------
  // readFrom
  // ---------------------------------------------------------------------------

  const readFrom = (
    streamId: StreamIdInput<TStreamIdFields>,
    afterVersion: number,
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
      const query = buildEventsQuery(streamId).pipe(
        Query.where({ between: [composeEventSk(afterVersion + 1), maxEventSk] }),
      )
      return yield* Query.collect(query)
    })

  // ---------------------------------------------------------------------------
  // currentVersion
  // ---------------------------------------------------------------------------

  const currentVersion = (
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<number, DynamoClientError | ValidationError, DynamoClient | TableConfig> =>
    Effect.gen(function* () {
      // Single page, not `collect`: with `Limit: 1` DynamoDB returns a
      // `LastEvaluatedKey` on every truncated page, so `collect` would walk the
      // whole partition one request per item. The `begins_with` bound on
      // `buildEventsQuery` guarantees the single evaluated item is the newest
      // *event* (never the snapshot, which sorts last).
      const query = buildEventsQuery(streamId).pipe(Query.reverse, Query.limit(1))
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

      const encoded = yield* Schema.encodeUnknownEffect(snapshot.schema as Schema.Schema<unknown>)(
        state,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ValidationError({
              entityType: snapshotEntityType,
              operation: "EventStore.writeSnapshot",
              cause,
            }),
        ),
      )

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

      const raw = fromAttributeMap(result.Item)
      const state = yield* Schema.decodeUnknownEffect(snapshot.schema as Schema.Schema<unknown>)(
        raw.state,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ValidationError({
              entityType: snapshotEntityType,
              operation: "EventStore.readSnapshot",
              cause,
            }),
        ),
      )

      return Option.some<Snapshot<unknown>>({
        state,
        asOfVersion: raw.asOfVersion as number,
        timestamp: raw.timestamp as string,
      })
    }) as Effect.Effect<
      Option.Option<Snapshot<unknown>>,
      DynamoClientError | ValidationError,
      DynamoClient | TableConfig
    >

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
    query: queryNamespace,
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

  append(
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: AppendOptions<TMetadata> | undefined,
  ): Effect.Effect<AppendResult<TEvent>, AppendError, never>

  read(
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    DynamoClientError | ValidationError,
    never
  >

  readFrom(
    streamId: StreamIdInput<TStreamIdFields>,
    afterVersion: number,
  ): Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
    DynamoClientError | ValidationError,
    never
  >

  currentVersion(
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<number, DynamoClientError | ValidationError, never>

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
      read: (streamId) => provide(stream.read(streamId)),
      readFrom: (streamId, afterVersion) => provide(stream.readFrom(streamId, afterVersion)),
      currentVersion: (streamId) => provide(stream.currentVersion(streamId)),
      query: stream.query,
      provide,
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
   * re-reads the snapshot and its delta.
   *
   * A number `n` is shorthand for `Schedule.recurs(n)` (n retries *after* the
   * initial attempt). Omit for the default: no retry.
   *
   * `DuplicateCommand` is deliberately NOT retried — it is terminal.
   */
  readonly retry?: number | Schedule.Schedule<unknown, VersionConflict> | undefined

  /** Opt in to exactly-once command processing — see {@link AppendIdempotency}. */
  readonly idempotency?: { readonly ttl?: Duration.Duration | string }
}

/** Per-call options accepted by a handler produced by {@link commandHandler}. */
export interface CommandOptions<TMetadata> {
  readonly metadata?: TMetadata
  /**
   * Identifier for this command delivery. Required when the handler was created
   * with `idempotency`; a replayed id fails with `DuplicateCommand`.
   */
  readonly commandId?: string
  /** Caller-owned transact items committed atomically with the produced events. */
  readonly additionalItems?: ReadonlyArray<TransactWriteOp>
}

/** Per-call options when the handler was created with `idempotency` — `commandId` is required. */
export interface IdempotentCommandOptions<TMetadata> extends CommandOptions<TMetadata> {
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
> = TConfig extends { readonly idempotency: object }
  ? [options: IdempotentCommandOptions<TMetadata>]
  : [options?: CommandOptions<TMetadata> | undefined]

type CommandHandlerErrors<E> =
  | E
  | VersionConflict
  | DuplicateCommand
  | AdditionalItemConditionFailed
  | AppendTooLarge
  | DynamoClientError
  | ValidationError
  | TransactionCancelled

type CommandHandler<
  State,
  Command,
  TEvent,
  E,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TConfig extends CommandHandlerOptions | undefined = undefined,
> = (
  streamId: StreamIdInput<TStreamIdFields>,
  command: Command,
  ...options: CommandOptionsArgs<TMetadata, TConfig>
) => Effect.Effect<
  CommandHandlerResult<State, TEvent>,
  CommandHandlerErrors<E>,
  DynamoClient | TableConfig
>

type BoundCommandHandler<
  State,
  Command,
  TEvent,
  E,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  TConfig extends CommandHandlerOptions | undefined = undefined,
> = (
  streamId: StreamIdInput<TStreamIdFields>,
  command: Command,
  ...options: CommandOptionsArgs<TMetadata, TConfig>
) => Effect.Effect<CommandHandlerResult<State, TEvent>, CommandHandlerErrors<E>, never>

/** @internal Both `EventStream` and `BoundEventStream` carry this brand. */
const hasEventStreamBrand = (u: unknown): boolean =>
  typeof u === "object" && u !== null && EventStreamTypeId in u

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

  return (
    streamId: StreamIdInput<TStreamIdFields>,
    command: Command,
    callOptions?: CommandOptions<TMetadata> | undefined,
  ) => {
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

      const snapshotSettings = stream.snapshotConfig

      // 1. Establish the base state + version — from a snapshot plus its delta
      //    when the stream has snapshots enabled and one exists, otherwise from
      //    a full replay.
      let state = decider.initialState
      let baseVersion = 0
      let snapshotAsOfVersion = 0

      const snapshot =
        snapshotSettings === undefined
          ? Option.none<Snapshot<State>>()
          : ((yield* stream.readSnapshot(streamId)) as Option.Option<Snapshot<State>>)

      if (Option.isSome(snapshot)) {
        snapshotAsOfVersion = snapshot.value.asOfVersion
        baseVersion = snapshot.value.asOfVersion
        state = snapshot.value.state
        const delta = yield* stream.readFrom(streamId, snapshot.value.asOfVersion)
        for (const event of delta) {
          state = decider.evolve(state, event.data)
        }
        const newest = delta[delta.length - 1]
        if (newest !== undefined) baseVersion = newest.version
      } else {
        const events = yield* stream.read(streamId)
        for (const event of events) {
          state = decider.evolve(state, event.data)
        }
        const newest = events[events.length - 1]
        baseVersion = newest === undefined ? 0 : newest.version
      }

      // 2. Decide
      const newEvents = yield* decider.decide(command, state)

      // 3. No-op command — return current state
      if (newEvents.length === 0) {
        return { state, version: baseVersion, events: [] }
      }

      // 4. Append with optimistic concurrency, plus any caller-owned items and
      //    the dedup sentinel, all in one transaction.
      const appendOptions: {
        metadata?: TMetadata
        additionalItems?: ReadonlyArray<TransactWriteOp>
        idempotency?: AppendIdempotency
      } = {}
      if (callOptions?.metadata !== undefined) appendOptions.metadata = callOptions.metadata
      if (callOptions?.additionalItems !== undefined) {
        appendOptions.additionalItems = callOptions.additionalItems
      }
      if (options?.idempotency !== undefined && callOptions?.commandId !== undefined) {
        appendOptions.idempotency =
          options.idempotency.ttl !== undefined
            ? { commandId: callOptions.commandId, ttl: options.idempotency.ttl }
            : { commandId: callOptions.commandId }
      }

      const result = yield* stream.append(
        streamId,
        newEvents,
        baseVersion,
        appendOptions as AppendOptions<TMetadata>,
      )

      // 5. Evolve state through the new events
      for (const event of newEvents) {
        state = decider.evolve(state, event)
      }

      // 6. Auto-snapshot once the cadence threshold is crossed. Best-effort:
      //    the events are already durable, so a snapshot-write failure must not
      //    report the command as failed. The next threshold crossing retries it.
      const every = snapshotSettings?.every
      if (every !== undefined && result.version - snapshotAsOfVersion >= every) {
        yield* stream
          .writeSnapshot(streamId, state, result.version)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `EventStore: snapshot write failed for stream "${stream.streamName}" at version ${result.version}`,
                cause,
              ),
            ),
          )
      }

      return { state, version: result.version, events: newEvents }
    })

    return schedule === undefined
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
 * ```
 *
 * When the stream declares a `snapshot` config, each invocation reads the
 * snapshot and folds only the events after it, instead of replaying the stream
 * from the beginning. With `snapshot.every` set, a fresh snapshot is written
 * (best-effort) after a successful append once the cadence threshold is crossed.
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
  // Data-last overloads
  <State, Command, TEvent, E, const TConfig extends CommandHandlerOptions | undefined = undefined>(
    decider: Decider<State, Command, TEvent, E>,
    options?: TConfig,
  ): {
    <TStreamIdFields extends ReadonlyArray<string>, TMetadata, TState extends State>(
      stream: BoundEventStream<TEvent, TStreamIdFields, TMetadata, TState>,
    ): BoundCommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata, TConfig>
    <TStreamIdFields extends ReadonlyArray<string>, TMetadata, TState extends State>(
      stream: EventStream<TEvent, TStreamIdFields, TMetadata, TState>,
    ): CommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata, TConfig>
  }

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
