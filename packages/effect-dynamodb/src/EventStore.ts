/**
 * EventStore — Typed, Effect-native event sourcing on DynamoDB.
 *
 * Provides:
 * - `Decider` type for command-event-state modeling
 * - `makeStream` factory for creating event streams bound to a Table
 * - Core operations: `append`, `read`, `readFrom`, `currentVersion`
 * - `commandHandler` combinator for read-decide-append cycle
 * - `fold` / `foldFrom` helpers for state reconstruction
 *
 * Built on the existing library primitives (DynamoSchema, KeyComposer, Query,
 * DynamoClient, Marshaller).
 */

import { Effect, Function, Schema } from "effect"
import { DynamoClient, type DynamoClientError } from "./DynamoClient.js"
import * as DynamoSchema from "./DynamoSchema.js"
import {
  isAwsTransactionCancelled,
  TransactionCancelled,
  ValidationError,
  VersionConflict,
} from "./Errors.js"
import * as KeyComposer from "./KeyComposer.js"
import { toAttributeMap } from "./Marshaller.js"
import * as Query from "./Query.js"
import type { Table, TableConfig } from "./Table.js"

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
 */
export interface StreamEvent<A> {
  readonly streamId: string
  readonly version: number
  readonly eventType: string
  readonly data: A
  readonly metadata: Record<string, unknown> | undefined
  readonly timestamp: string
}

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
export interface EventStream<TEvent, TStreamIdFields extends ReadonlyArray<string>, TMetadata> {
  readonly [EventStreamTypeId]: EventStreamTypeId
  readonly streamName: string
  readonly eventSchema: Schema.Top

  readonly append: (
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: { readonly metadata?: TMetadata } | undefined,
  ) => Effect.Effect<
    AppendResult<TEvent>,
    VersionConflict | DynamoClientError | ValidationError | TransactionCancelled,
    DynamoClient | TableConfig
  >

  readonly read: (
    streamId: StreamIdInput<TStreamIdFields>,
  ) => Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  readonly readFrom: (
    streamId: StreamIdInput<TStreamIdFields>,
    afterVersion: number,
  ) => Effect.Effect<
    ReadonlyArray<StreamEvent<TEvent>>,
    DynamoClientError | ValidationError,
    DynamoClient | TableConfig
  >

  readonly currentVersion: (
    streamId: StreamIdInput<TStreamIdFields>,
  ) => Effect.Effect<number, DynamoClientError | ValidationError, DynamoClient | TableConfig>

  readonly query: {
    readonly events: (streamId: StreamIdInput<TStreamIdFields>) => Query.Query<StreamEvent<TEvent>>
  }
}

// ---------------------------------------------------------------------------
// makeStream factory
// ---------------------------------------------------------------------------

/**
 * Create an EventStream bound to a Table.
 *
 * @example
 * ```typescript
 * class MatchStarted extends Schema.Class<MatchStarted>("MatchStarted")({
 *   venue: Schema.String,
 * }) {}
 *
 * class InningsCompleted extends Schema.Class<InningsCompleted>("InningsCompleted")({
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
 */
export const makeStream = <
  const TEvents extends ReadonlyArray<Schema.Top>,
  TTable extends Table,
  const TStreamName extends string,
  const TStreamId extends { readonly composite: ReadonlyArray<string> },
  TMetadata extends Schema.Top | undefined = undefined,
>(config: {
  readonly table: TTable
  readonly streamName: TStreamName
  readonly events: TEvents
  readonly streamId: TStreamId
  readonly metadata?: TMetadata
}): EventStream<
  Schema.Schema.Type<TEvents[number]>,
  TStreamId["composite"],
  TMetadata extends Schema.Top ? Schema.Schema.Type<TMetadata> : undefined
> => {
  type TEvent = Schema.Schema.Type<TEvents[number]>
  type TStreamIdFields = TStreamId["composite"]

  const schema = config.table.schema
  const entityType = `${config.streamName.toLowerCase()}.event`
  const compositeFields = config.streamId.composite

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

  // ---------------------------------------------------------------------------
  // Decode a raw DynamoDB item → StreamEvent<TEvent>
  // ---------------------------------------------------------------------------

  const decodeStreamEvent = (
    raw: Record<string, unknown>,
  ): Effect.Effect<StreamEvent<TEvent>, ValidationError> =>
    Effect.gen(function* () {
      const decoder = Schema.decodeUnknownEffect(eventUnion as Schema.Schema<TEvent>)
      const data = yield* (decoder(raw.data) as Effect.Effect<TEvent, unknown>).pipe(
        Effect.mapError(
          (cause) =>
            new ValidationError({
              entityType,
              operation: "EventStore.decode",
              cause,
            }),
        ),
      )
      return {
        streamId: raw.streamId as string,
        version: raw.version as number,
        eventType: raw.eventType as string,
        data,
        metadata: raw.metadata as Record<string, unknown> | undefined,
        timestamp: raw.timestamp as string,
      }
    }) as Effect.Effect<StreamEvent<TEvent>, ValidationError>

  // ---------------------------------------------------------------------------
  // append
  // ---------------------------------------------------------------------------

  const append = (
    streamId: StreamIdInput<TStreamIdFields>,
    events: ReadonlyArray<TEvent>,
    expectedVersion: number,
    options?: { readonly metadata?: unknown } | undefined,
  ) =>
    Effect.gen(function* () {
      if (events.length === 0) {
        return { version: expectedVersion, events: [] }
      }

      const client = yield* DynamoClient
      const { name: tableName } = yield* config.table.Tag

      const pk = composeStreamPk(streamId as Record<string, unknown>)
      const now = new Date().toISOString()

      // Resolve stream ID string for storage (join composites)
      const streamIdStr = compositeFields
        .map((f) => (streamId as Record<string, unknown>)[f])
        .join("#")

      // Validate and encode metadata if schema provided
      let encodedMetadata: Record<string, unknown> | undefined
      if (options?.metadata !== undefined && metadataSchema) {
        const validated = yield* Schema.decodeUnknownEffect(
          metadataSchema as Schema.Schema<unknown>,
        )(options.metadata).pipe(
          Effect.mapError(
            (cause) =>
              new ValidationError({
                entityType,
                operation: "EventStore.append.metadata",
                cause,
              }),
          ),
        )
        encodedMetadata = validated as Record<string, unknown>
      } else if (options?.metadata !== undefined) {
        encodedMetadata = options.metadata as Record<string, unknown>
      }

      // Build transact items — one Put per event, each with attribute_not_exists(pk)
      const transactItems = events.map((event, i) => {
        const version = expectedVersion + i + 1
        // In Effect v4, Schema.Class instances don't have _tag as an own property.
        // The identifier is on the constructor (class) itself.
        const evtType =
          ((event as Record<string, unknown>)._tag as string | undefined) ??
          (event as { constructor: { identifier?: string } }).constructor.identifier ??
          (event as { constructor: { name: string } }).constructor.name

        const eventData = { _tag: evtType, ...(event as Record<string, unknown>) }

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
      })

      yield* client.transactWriteItems({ TransactItems: transactItems }).pipe(
        Effect.mapError((error) => {
          if (isAwsTransactionCancelled(error.cause)) {
            const reasons = (error.cause.CancellationReasons ?? []).map((r) => ({
              code: r?.Code,
              message: r?.Message,
            }))
            const hasConflict = reasons.some((r) => r.code === "ConditionalCheckFailed")
            if (hasConflict) {
              return new VersionConflict({
                streamName: config.streamName,
                streamId: streamIdStr,
                expectedVersion,
              }) as VersionConflict | DynamoClientError | TransactionCancelled
            }
            return new TransactionCancelled({
              operation: "TransactWriteItems",
              reasons,
              cause: error.cause,
            }) as VersionConflict | DynamoClientError | TransactionCancelled
          }
          return error as VersionConflict | DynamoClientError | TransactionCancelled
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
      const query = buildEventsQuery(streamId).pipe(
        Query.where({ gt: composeEventSk(afterVersion) }),
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
      const query = buildEventsQuery(streamId).pipe(Query.reverse, Query.limit(1))
      const results = yield* Query.collect(query)
      if (results.length === 0) return 0
      return results[0]!.version
    })

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
    })
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
    streamName: config.streamName,
    eventSchema: eventUnion,
    append,
    read,
    readFrom,
    currentVersion,
    query: queryNamespace,
  } as unknown as EventStream<
    TEvent,
    TStreamIdFields,
    TMetadata extends Schema.Top ? Schema.Schema.Type<TMetadata> : undefined
  >
}

// ---------------------------------------------------------------------------
// commandHandler
// ---------------------------------------------------------------------------

type CommandHandler<
  State,
  Command,
  TEvent,
  E,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
> = (
  streamId: StreamIdInput<TStreamIdFields>,
  command: Command,
  options?: { readonly metadata?: TMetadata } | undefined,
) => Effect.Effect<
  CommandHandlerResult<State, TEvent>,
  E | VersionConflict | DynamoClientError | ValidationError | TransactionCancelled,
  DynamoClient | TableConfig
>

/**
 * Create a command handler that reads, decides, and appends atomically.
 *
 * Supports both data-first and data-last (pipeable) usage:
 * ```typescript
 * // Data-first
 * const handle = EventStore.commandHandler(decider, stream)
 *
 * // Data-last (pipe)
 * const handle = stream.pipe(EventStore.commandHandler(decider))
 * ```
 */
export const commandHandler: {
  <State, Command, TEvent, E>(
    decider: Decider<State, Command, TEvent, E>,
  ): <TStreamIdFields extends ReadonlyArray<string>, TMetadata>(
    stream: EventStream<TEvent, TStreamIdFields, TMetadata>,
  ) => CommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata>

  <State, Command, TEvent, E, TStreamIdFields extends ReadonlyArray<string>, TMetadata>(
    decider: Decider<State, Command, TEvent, E>,
    stream: EventStream<TEvent, TStreamIdFields, TMetadata>,
  ): CommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata>
} = Function.dual(
  2,
  <State, Command, TEvent, E, TStreamIdFields extends ReadonlyArray<string>, TMetadata>(
    decider: Decider<State, Command, TEvent, E>,
    stream: EventStream<TEvent, TStreamIdFields, TMetadata>,
  ): CommandHandler<State, Command, TEvent, E, TStreamIdFields, TMetadata> =>
    (streamId, command, options) =>
      Effect.gen(function* () {
        // 1. Read all events
        const events = yield* stream.read(streamId)

        // 2. Fold to current state
        const curVersion = events.length > 0 ? events[events.length - 1]!.version : 0
        let state = decider.initialState
        for (const event of events) {
          state = decider.evolve(state, event.data)
        }

        // 3. Decide
        const newEvents = yield* decider.decide(command, state)

        // 4. No-op command — return current state
        if (newEvents.length === 0) {
          return { state, version: curVersion, events: [] }
        }

        // 5. Append with optimistic concurrency
        const result = yield* stream.append(
          streamId,
          newEvents,
          curVersion,
          options as { readonly metadata?: TMetadata } | undefined,
        )

        // 6. Evolve state through new events
        for (const event of newEvents) {
          state = decider.evolve(state, event)
        }

        return { state, version: result.version, events: newEvents }
      }),
)

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
