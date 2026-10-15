/**
 * EventStore projections (#151) — read models folded from a change feed that
 * take their order from the event store, not from delivery.
 *
 * DynamoDB Streams orders records per item only, and a transaction's records
 * carry no grouping or order, so a stream's events reach a consumer in any
 * order. A projection groups a batch's events by stream instance, sorts and
 * deduplicates them, reads from the store only the versions the batch lacks
 * (one strongly consistent `readFrom`), folds, and writes the read-model row
 * once, conditioned on the checkpoint it read. See
 * `docs/designs/eventstore-projections.md`.
 *
 * Re-exported from `EventStore`; this module only type-imports it.
 *
 * @internal
 */

import {
  ConcurrentModification,
  type ConditionalCheckFailed,
  type ItemNotFound,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect, Option, Pipeable, Result, Schedule, type Schema } from "effect"
import type { DynamoClient, DynamoClientError } from "../DynamoClient.js"
import type { EventStream, StreamEvent, StreamIdInput, StreamMetadata } from "../EventStore.js"
import type { TableConfig } from "../Table.js"
import {
  condition as entityCondition,
  consistentRead as entityConsistentRead,
} from "./EntityCombinators.js"
import type { EntityGet, EntityPut } from "./EntityOps.js"
import { imageEntityType, type StreamImage } from "./Packed.js"

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/**
 * The read model a projection writes: an unbound `Entity`. Its row is read
 * with a strongly consistent `get` and written whole with `put` (or `create`
 * for a new row), so the projection owns the row.
 */
export interface ProjectionReadModel {
  readonly entityType: string
  readonly model: Schema.Top
  readonly versioned: unknown
  readonly softDelete: unknown
  readonly timeSeries: unknown
  readonly get: (key: any) => EntityGet<any, any, any, any>
  readonly put: (input: any) => EntityPut<any, any, any, any>
  readonly create: (input: any) => EntityPut<any, any, any, any>
}

/** The state a projection folds: the read model's model type. */
export type ProjectionState<RM> = RM extends {
  readonly get: (key: any) => EntityGet<infer A, any, any, any>
}
  ? A
  : never

/** The read model's primary key, as its `get` takes it. */
export type ProjectionKey<RM> = RM extends { readonly get: (key: infer K) => any } ? K : never

/**
 * What reading and writing the read-model row can fail with — its `get` (a
 * missing row is not an error) and its `put`. The conditional write's
 * `ConditionalCheckFailed` is the projection's own race signal, never surfaced.
 */
export type ProjectionReadModelError<RM> =
  | (RM extends { readonly put: (input: any) => EntityPut<any, any, infer E, any> }
      ? Exclude<E, ConditionalCheckFailed>
      : never)
  | (RM extends { readonly get: (key: any) => EntityGet<any, any, infer E, any> }
      ? Exclude<E, ItemNotFound>
      : never)

/** The read model's numeric fields — those a checkpoint may name. */
export type CheckpointField<S> = {
  [K in keyof S]-?: S[K] extends number ? K : never
}[keyof S] &
  string

/**
 * The read model's field holding the last applied stream version. With
 * `{ field, offset }` the field stores `version + offset`: a read model that
 * numbered versions from 0 adopts a projection with `offset: -1`, its stored
 * values and readers unchanged.
 */
export type ProjectionCheckpoint<S> =
  | CheckpointField<S>
  | { readonly field: CheckpointField<S>; readonly offset?: number | undefined }

/** Configuration of {@link projection}. */
export interface ProjectionConfig<
  TEvent,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  RM extends ProjectionReadModel,
  E,
  R,
> {
  /** The source stream. One projection reads one stream. */
  readonly stream: EventStream<TEvent, TStreamIdFields, TMetadata, any, any, any, any>
  /** The read model (an unbound `Entity`) — one row per stream instance. */
  readonly readModel: RM
  /** The row's primary key for a stream instance. */
  readonly key: (streamId: StreamIdInput<TStreamIdFields>) => ProjectionKey<RM>
  /** The state a stream instance's row starts from, before its first event. */
  readonly initial: (streamId: StreamIdInput<TStreamIdFields>) => ProjectionState<RM>
  /**
   * Apply one event. Return the state unchanged to ignore an event (the
   * checkpoint still advances). A failure fails this stream instance only.
   * The library sets the checkpoint field after the fold; `evolve` need not.
   */
  readonly evolve: (
    state: ProjectionState<RM>,
    event: StreamEvent<TEvent, StreamMetadata<TMetadata>>,
  ) => Effect.Effect<ProjectionState<RM>, E, R>
  /** See {@link ProjectionCheckpoint}. */
  readonly checkpoint: ProjectionCheckpoint<ProjectionState<RM>>
  /**
   * Retries after a lost race — another invocation advanced the row between
   * this one's read and its conditional write. Each retry re-reads the row, so
   * it usually finds the events applied and has nothing left to write. A
   * number `n` is `Schedule.recurs(n)`. Default `5`. Exhausted, the instance
   * fails with `ConcurrentModification`.
   */
  readonly retry?: number | Schedule.Schedule<unknown, ConcurrentModification> | undefined
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One stream instance applied by {@link EventProjection.applyBatch} / `apply`. */
export interface ProjectionApplied<S, A, M> {
  /** The stream instance (`StreamEvent.streamId`). */
  readonly streamId: string
  /**
   * The events this call applied, in version order — including any it read
   * from the store to fill a gap. Each event is in exactly one call's
   * `applied`: the one whose conditional write won. Side effects driven from
   * it are at most once (a crash after the write loses them).
   */
  readonly applied: ReadonlyArray<StreamEvent<A, M>>
  /**
   * The batch's events this instance had already applied (version at or below
   * the checkpoint it read), in version order — a redelivery, or a late
   * out-of-order delivery. Republishing their side effects gives at-least-once
   * delivery, for consumers that tolerate duplicates.
   */
  readonly alreadyApplied: ReadonlyArray<StreamEvent<A, M>>
  /** The row as written — or as read, when nothing was left to apply. */
  readonly state: S
  /** The stream version the row is at (store numbering, offset removed). */
  readonly version: number
}

/** The outcome of one stream instance in {@link ProjectionBatchResult}. */
export type ProjectionOutcome<S, A, M, Err> =
  | ({
      readonly _tag: "Applied"
      /** Positions of this instance's events in the `applyBatch` input, ascending. */
      readonly positions: ReadonlyArray<number>
    } & ProjectionApplied<S, A, M>)
  | {
      readonly _tag: "Failed"
      readonly streamId: string
      /** Positions of this instance's events in the `applyBatch` input, ascending. */
      readonly positions: ReadonlyArray<number>
      readonly error: Err
    }

/** Result of {@link EventProjection.applyBatch}. */
export interface ProjectionBatchResult<S, A, M, Err> {
  /** One outcome per stream instance, in order of first delivery. */
  readonly outcomes: ReadonlyArray<ProjectionOutcome<S, A, M, Err>>
  /**
   * The earliest input position of each failed instance, ascending — the
   * records to report in a partial batch response.
   */
  readonly failedPositions: ReadonlyArray<number>
}

/** Result of {@link EventProjection.catchUp}. */
export interface ProjectionCaughtUp<S, A, M> {
  /** The events folded, in version order. Empty when the row was current. */
  readonly applied: ReadonlyArray<StreamEvent<A, M>>
  /** The row — `Option.none()` for a stream with no events and no row. */
  readonly state: Option.Option<S>
  readonly version: number
}

/** Result of {@link EventProjection.rebuild}. */
export interface ProjectionRebuilt<S> {
  /** The row as written — as read (if any) for a stream with no events. */
  readonly state: Option.Option<S>
  readonly version: number
}

/** What a projection's operations fail with: `evolve`'s `E`, the read model's errors, and the store's. */
export type ProjectionError<RM, E> =
  | E
  | ProjectionReadModelError<RM>
  | DynamoClientError
  | ValidationError
  | ConcurrentModification

/** Options of {@link EventProjection.applyBatch}. */
export interface ApplyBatchOptions {
  /** Stream instances applied concurrently. Default `10`. */
  readonly concurrency?: number | "unbounded" | undefined
}

// ---------------------------------------------------------------------------
// Change-feed records and partial batch responses
// ---------------------------------------------------------------------------

/**
 * A DynamoDB Streams record as a Lambda event source mapping or an
 * EventBridge Pipe delivers it — only the members the projection reads.
 * Structural, so no `aws-lambda` types are needed.
 */
export interface StreamRecord {
  readonly eventID?: string | undefined
  readonly eventName?: string | undefined
  readonly dynamodb?:
    | {
        readonly SequenceNumber?: string | undefined
        readonly NewImage?: StreamImage | undefined
      }
    | undefined
}

/**
 * Who reads the partial batch response. A Lambda event source mapping on a
 * DynamoDB stream identifies a record by `dynamodb.SequenceNumber`; an
 * EventBridge Pipe by `eventID`.
 */
export type BatchResponseSource = "lambda" | "pipe"

/** The `ReportBatchItemFailures` response. */
export interface BatchItemFailuresResponse {
  readonly batchItemFailures: Array<{ readonly itemIdentifier: string }>
}

/** Options of {@link EventProjection.processBatch}. */
export interface ProcessBatchOptions extends ApplyBatchOptions {
  readonly source: BatchResponseSource
}

/** Result of {@link EventProjection.processBatch}. */
export interface ProcessBatchResult<S, A, M, Err, Rec extends StreamRecord> {
  /** See {@link ProjectionBatchResult.outcomes}. */
  readonly outcomes: ReadonlyArray<ProjectionOutcome<S, A, M, Err>>
  /** Records whose image failed to decode — each one is reported as failed. */
  readonly decodeFailures: ReadonlyArray<{ readonly record: Rec; readonly error: ValidationError }>
  /**
   * The records the response reports, in delivery order: the earliest record
   * of each failed instance, and every record that failed to decode.
   */
  readonly failedRecords: ReadonlyArray<Rec>
  /**
   * The partial batch response for `failedRecords`. To fail more records (a
   * side effect that failed, say), pass them with these to {@link batchResponse}.
   */
  readonly response: BatchItemFailuresResponse
}

/**
 * The partial batch response (`ReportBatchItemFailures`) for `failedRecords`:
 * each identified by `dynamodb.SequenceNumber` for a Lambda event source
 * mapping, by `eventID` for an EventBridge Pipe.
 *
 * Lambda checkpoints at the lowest reported sequence number and redelivers
 * every record from there, so reporting the earliest failed record of each
 * stream instance is enough. A record missing its identifier — a Pipe input
 * template that drops `eventID`, say — throws `[EDD-9083]`: an empty
 * identifier would silently fail the whole batch.
 */
export const batchResponse = (
  failedRecords: ReadonlyArray<StreamRecord>,
  options: { readonly source: BatchResponseSource },
): BatchItemFailuresResponse => ({
  batchItemFailures: failedRecords.map((record, i) => {
    const itemIdentifier =
      options.source === "lambda" ? record.dynamodb?.SequenceNumber : record.eventID
    if (typeof itemIdentifier !== "string" || itemIdentifier.length === 0) {
      const member = options.source === "lambda" ? "dynamodb.SequenceNumber" : "eventID"
      throw new Error(
        `[EDD-9083] EventStore.batchResponse: failed record ${i} has no ${member}, which a ` +
          `${options.source === "lambda" ? "Lambda event source mapping" : "Pipe"} needs to ` +
          "identify it. Deliver the record with it (a Pipe input template must keep it).",
      )
    }
    return { itemIdentifier }
  }),
})

// ---------------------------------------------------------------------------
// Table-level decoding and filtering
// ---------------------------------------------------------------------------

/** A stream {@link decoder} can dispatch to — an `EventStream` or a `BoundEventStream`. */
export interface DecodableStream {
  readonly streamName: string
  readonly eventMarker: string
  decodeStreamImage(image: StreamImage): Effect.Effect<Option.Option<unknown>, ValidationError, any>
}

/** The event a decodable stream decodes to. */
type DecodedEventOf<S> = S extends {
  decodeStreamImage(image: any, options?: any): Effect.Effect<Option.Option<infer Ev>, any, any>
}
  ? Ev
  : never

/** What {@link decoder} returns for one of its streams' event images. */
export type DecodedStreamEvent<Streams extends { readonly [name: string]: DecodableStream }> = {
  readonly [K in keyof Streams & string]: {
    readonly stream: K
    readonly event: DecodedEventOf<Streams[K]>
  }
}[keyof Streams & string]

const markerIndex = (
  operation: string,
  streams: ReadonlyArray<readonly [string, DecodableStream]>,
): Map<string, readonly [string, DecodableStream]> => {
  const index = new Map<string, readonly [string, DecodableStream]>()
  for (const entry of streams) {
    const existing = index.get(entry[1].eventMarker)
    if (existing !== undefined) {
      throw new Error(
        `[EDD-9082] ${operation}: "${existing[0]}" and "${entry[0]}" both store events as ` +
          `"${entry[1].eventMarker}", so their images can't be told apart. Give the streams ` +
          "distinct names.",
      )
    }
    index.set(entry[1].eventMarker, entry)
  }
  return index
}

/**
 * One decoder for several streams' change-feed images. Name the streams in a
 * record; `decode(image)` dispatches on the image's `__edd_e__` and returns
 * `{ stream: <name>, event }`, or `Option.none()` for anything that is not one
 * of their events (snapshots, idempotency sentinels, entities, other streams).
 * The image is decoded by that stream's `decodeStreamImage`, so it accepts the
 * same shapes (DynamoDB JSON with `B` as base64 or bytes, or unmarshalled).
 *
 * Two streams storing events under the same marker throw `[EDD-9082]`.
 *
 * @example
 * ```ts
 * const decode = EventStore.decoder({ Order: OrderEvents, Payment: PaymentEvents })
 * const decoded = yield* decode(record.dynamodb.NewImage)
 * if (Option.isSome(decoded) && decoded.value.stream === "Order") { ... }
 * ```
 */
export const decoder = <const Streams extends { readonly [name: string]: DecodableStream }>(
  streams: Streams,
): ((
  image: StreamImage,
) => Effect.Effect<Option.Option<DecodedStreamEvent<Streams>>, ValidationError, never>) => {
  const index = markerIndex("EventStore.decoder", Object.entries(streams))
  return (image) => {
    const entry =
      typeof image === "object" && image !== null && !Array.isArray(image)
        ? index.get(imageEntityType(image) ?? "")
        : undefined
    if (entry === undefined) return Effect.succeed(Option.none())
    const [name, stream] = entry
    return stream
      .decodeStreamImage(image)
      .pipe(
        Effect.map((event) =>
          Option.map(event, (e) => ({ stream: name, event: e }) as DecodedStreamEvent<Streams>),
        ),
      ) as Effect.Effect<Option.Option<DecodedStreamEvent<Streams>>, ValidationError, never>
  }
}

/** A Lambda event source mapping / EventBridge Pipe filter pattern. */
export interface EventFilterPattern {
  readonly eventName: ReadonlyArray<"INSERT">
  readonly dynamodb: {
    readonly NewImage: { readonly __edd_e__: { readonly S: ReadonlyArray<string> } }
  }
}

/**
 * The filter pattern that selects the `INSERT`s of these streams' event items
 * — `JSON.stringify` it into `FilterCriteria.Filters[].Pattern` of a Lambda
 * event source mapping or an EventBridge Pipe. Snapshots, idempotency
 * sentinels and other items are filtered out before the function runs.
 */
export const eventFilterPattern = (
  streams: ReadonlyArray<DecodableStream> | { readonly [name: string]: DecodableStream },
): EventFilterPattern => {
  const list: ReadonlyArray<DecodableStream> = Array.isArray(streams)
    ? streams
    : Object.values(streams)
  const markers = [...new Set(list.map((s) => s.eventMarker))]
  return { eventName: ["INSERT"], dynamodb: { NewImage: { __edd_e__: { S: markers } } } }
}

// ---------------------------------------------------------------------------
// EventProjection
// ---------------------------------------------------------------------------

const EventProjectionTypeId: unique symbol = Symbol.for("effect-dynamodb/EventProjection")
export type EventProjectionTypeId = typeof EventProjectionTypeId

/**
 * A change-feed projection: one source stream folded into one read-model row
 * per stream instance — see {@link projection}. Its operations need
 * `DynamoClient | TableConfig` (the stream's table and the read model's) and
 * `evolve`'s requirements; {@link bindProjection} resolves them (`R = never`).
 */
export interface EventProjection<S, A, TStreamIdFields extends ReadonlyArray<string>, M, Err, R>
  extends Pipeable.Pipeable {
  readonly [EventProjectionTypeId]: EventProjectionTypeId
  /** The source stream. */
  readonly stream: EventStream<A, TStreamIdFields, any, any, any, any, any>
  /** The read model's entity type. */
  readonly entityType: string

  /**
   * Apply one stream's decoded change-feed events — a batch, in delivery
   * order. Per stream instance (concurrently across instances):
   *
   * 1. sort and deduplicate the instance's events by version;
   * 2. read the row (strongly consistent) and its checkpoint `c`; the events
   *    at or below `c` are `alreadyApplied`, and with none left the instance
   *    is done;
   * 3. if the rest are not exactly `c + 1 …` their highest version, read
   *    `c + 1 …` that version from the store with one strongly consistent
   *    `readFrom` — so nothing waits for a delivery;
   * 4. fold through `evolve`, set the checkpoint, and write the row once,
   *    conditioned on the checkpoint still being `c` (`create` for a new row);
   * 5. on a lost race, re-read and continue, under the `retry` policy.
   *
   * Never fails: each instance's failure is its outcome, so one instance's
   * error can't hide the others' `applied`.
   */
  applyBatch(
    events: ReadonlyArray<StreamEvent<A, M>>,
    options?: ApplyBatchOptions | undefined,
  ): Effect.Effect<ProjectionBatchResult<S, A, M, Err>, never, R>

  /** {@link EventProjection.applyBatch} of one event, its failure in the error channel. */
  apply(event: StreamEvent<A, M>): Effect.Effect<ProjectionApplied<S, A, M>, Err, R>

  /**
   * Apply everything from the row's checkpoint to the stream's head (one
   * strongly consistent `readFrom`) — to repair a row whose last event never
   * arrived (a dead-lettered record, say). An earlier missing event is filled
   * in by the next delivery anyway.
   */
  catchUp(
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<ProjectionCaughtUp<S, A, M>, Err, R>

  /**
   * Re-derive the row from version 1: fold the whole stream (strongly
   * consistent) from `initial`, ignoring the row's state, and write it
   * conditioned on the checkpoint read. Returns no events, so a rebuild never
   * replays side effects. A stream with no events writes nothing.
   */
  rebuild(streamId: StreamIdInput<TStreamIdFields>): Effect.Effect<ProjectionRebuilt<S>, Err, R>

  /**
   * Process a raw change-feed batch: decode each `INSERT`'s `NewImage` (other
   * records, and images that are not this stream's events, are skipped), apply
   * the events with {@link EventProjection.applyBatch}, and build the partial
   * batch response — the earliest record of each failed instance and every
   * record that failed to decode, identified per `options.source`.
   */
  processBatch<Rec extends StreamRecord>(
    records: ReadonlyArray<Rec>,
    options: ProcessBatchOptions,
  ): Effect.Effect<ProcessBatchResult<S, A, M, Err, Rec>, never, R>
}

type AnyEvent = StreamEvent<unknown, unknown>

/** The `retry` option as a schedule. */
const retrySchedule = (
  retry: number | Schedule.Schedule<unknown, ConcurrentModification> | undefined,
): Schedule.Schedule<unknown, unknown> =>
  (retry === undefined
    ? Schedule.recurs(5)
    : typeof retry === "number"
      ? Schedule.recurs(retry)
      : retry) as Schedule.Schedule<unknown, unknown>

/** The model's declared fields, when its schema exposes them. */
const modelFields = (model: Schema.Top): ReadonlyArray<string> | undefined => {
  const fields = (model as { readonly fields?: unknown }).fields
  return typeof fields === "object" && fields !== null ? Object.keys(fields) : undefined
}

/**
 * Define a change-feed projection of `stream` into `readModel` — one row per
 * stream instance, keyed by `key(streamId)`, folded from `initial(streamId)`
 * through `evolve`, its last applied version kept in `checkpoint`. See
 * {@link EventProjection} for the operations.
 *
 * The read model must be a plain entity: `versioned` (the checkpoint is the
 * version), `softDelete` (rows are never deleted) and `timeSeries` read
 * models throw `[EDD-9081]`, as do a checkpoint the model has no field for and
 * a non-integer offset.
 *
 * @example
 * ```ts
 * const OrderSummaryProjection = EventStore.projection({
 *   stream: OrderEvents,
 *   readModel: OrderSummaries,
 *   key: (id) => ({ orderId: id.orderId }),
 *   initial: (id) => ({ orderId: id.orderId, status: "open", total: 0, version: 0 }),
 *   evolve: (state, event) => Effect.succeed(next(state, event.data)),
 *   checkpoint: "version",
 * })
 * ```
 */
export const projection = <
  TEvent,
  TStreamIdFields extends ReadonlyArray<string>,
  TMetadata,
  RM extends ProjectionReadModel,
  E = never,
  R = never,
>(
  config: ProjectionConfig<TEvent, TStreamIdFields, TMetadata, RM, E, R>,
): EventProjection<
  ProjectionState<RM>,
  TEvent,
  TStreamIdFields,
  StreamMetadata<TMetadata>,
  ProjectionError<RM, E>,
  R | DynamoClient | TableConfig
> => {
  type S = ProjectionState<RM>
  type Ev = StreamEvent<TEvent, StreamMetadata<TMetadata>>
  type Err = ProjectionError<RM, E>
  type Req = R | DynamoClient | TableConfig

  const { stream, readModel } = config
  const label = `EventStore.projection("${stream.streamName}" → "${readModel.entityType}")`
  const refuse = (problem: string): never => {
    throw new Error(`[EDD-9081] ${label}: ${problem}`)
  }
  if (readModel.versioned) {
    refuse(
      "the read model is `versioned`. The projection's checkpoint is the row's version, and a " +
        "versioned put adds its own lock — use a plain entity with a numeric checkpoint field.",
    )
  }
  if (readModel.softDelete) {
    refuse("the read model has `softDelete`; a projection never deletes its rows.")
  }
  if (readModel.timeSeries) {
    refuse("the read model is a `timeSeries` entity, written by `append`, not `put`.")
  }
  const field = (
    typeof config.checkpoint === "string" ? config.checkpoint : config.checkpoint.field
  ) as string
  const offset = typeof config.checkpoint === "string" ? 0 : (config.checkpoint.offset ?? 0)
  const fields = modelFields(readModel.model)
  if (fields !== undefined && !fields.includes(field)) {
    refuse(`the checkpoint field "${field}" is not a field of the read model.`)
  }
  if (!Number.isInteger(offset)) {
    refuse(`the checkpoint offset ${offset} is not an integer.`)
  }
  const schedule = retrySchedule(config.retry)

  /** The row, read strongly consistent; none when there is none. */
  const readRow = (key: unknown): Effect.Effect<Option.Option<S>, Err, Req> =>
    (
      entityConsistentRead(readModel.get(key)).asEffect() as Effect.Effect<
        unknown,
        ItemNotFound | Err,
        Req
      >
    ).pipe(
      Effect.map((row) => Option.some(row as S)),
      Effect.catchTag("ItemNotFound", () => Effect.succeed(Option.none<S>())),
    ) as Effect.Effect<Option.Option<S>, Err, Req>

  /** The stream version a row is at — its checkpoint, offset removed. */
  const versionOf = (row: Option.Option<S>): number =>
    Option.isSome(row) ? Number((row.value as Record<string, unknown>)[field]) - offset : 0

  /**
   * Write the folded state at `version`, conditioned on the row still being at
   * `previous` (`create` when there was no row). A failed condition is a lost
   * race: `ConcurrentModification`, which the caller's retry re-reads after.
   */
  const writeRow = (
    key: unknown,
    state: S,
    version: number,
    row: Option.Option<S>,
  ): Effect.Effect<S, Err, Req> => {
    const item = { ...(state as object), [field]: version + offset }
    const op = Option.isSome(row)
      ? entityCondition(readModel.put(item), { eq: { [field]: versionOf(row) + offset } })
      : readModel.create(item)
    return (op.asEffect() as Effect.Effect<S, Err | ConditionalCheckFailed, Req>).pipe(
      Effect.catchTag("ConditionalCheckFailed", () =>
        Effect.fail(
          new ConcurrentModification({
            entityType: readModel.entityType,
            key: key as Record<string, unknown>,
            attributes: [field],
            current: Option.none(),
          }),
        ),
      ),
    ) as Effect.Effect<S, Err, Req>
  }

  const fold = (state: S, events: ReadonlyArray<Ev>): Effect.Effect<S, Err, Req> =>
    Effect.gen(function* () {
      let current = state
      for (const event of events) current = yield* config.evolve(current, event)
      return current
    })

  /** `events` is exactly `from, from + 1, …`. */
  const contiguousFrom = (events: ReadonlyArray<AnyEvent>, from: number): boolean =>
    events.every((event, i) => event.version === from + i)

  const withRetry = <X>(attempt: Effect.Effect<X, Err, Req>): Effect.Effect<X, Err, Req> =>
    Effect.retry(attempt, {
      schedule,
      while: (error: unknown) => error instanceof ConcurrentModification,
    }) as Effect.Effect<X, Err, Req>

  // Unreachable for a stream written by `append` (a contiguity-checked
  // transaction): the store holds every version below a delivered one.
  const gapError = (streamId: string, from: number, to: number) =>
    Effect.fail(
      new ValidationError({
        entityType: stream.eventMarker,
        operation: "EventStore.projection",
        cause:
          `Stream ${JSON.stringify(streamId)} is missing events between versions ${from} and ` +
          `${to}: a strongly consistent read did not return them. Was the stream written ` +
          "outside `append`?",
      }),
    )

  /**
   * One stream instance: `events` sorted and deduplicated, or none for a
   * catch-up to the head.
   */
  const applyInstance = (
    streamIdStr: string,
    knownId: StreamIdInput<TStreamIdFields> | undefined,
    events: ReadonlyArray<Ev> | undefined,
  ): Effect.Effect<ProjectionApplied<S, TEvent, StreamMetadata<TMetadata>>, Err, Req> =>
    Effect.gen(function* () {
      const streamId = knownId ?? (yield* stream.parseStreamId(streamIdStr))
      const key = config.key(streamId)
      const attempt = Effect.gen(function* () {
        const row = yield* readRow(key)
        const at = versionOf(row)
        const alreadyApplied = events?.filter((e) => e.version <= at) ?? []
        const pending = events?.filter((e) => e.version > at)
        const done = (state: S) =>
          ({ streamId: streamIdStr, applied: [], alreadyApplied, state, version: at }) as const
        if (pending !== undefined && pending.length === 0) return done(Option.getOrThrow(row))
        let run: ReadonlyArray<Ev>
        if (pending !== undefined && contiguousFrom(pending, at + 1)) {
          run = pending
        } else {
          const top = pending === undefined ? Infinity : pending[pending.length - 1]!.version
          const read = (yield* stream.readFrom(streamId, at, { consistentRead: true })) as Array<Ev>
          run = read.filter((e) => e.version <= top)
          if (!contiguousFrom(run, at + 1) || (pending !== undefined && run.length < top - at)) {
            return yield* gapError(streamIdStr, at + 1, top)
          }
        }
        if (run.length === 0) return done(Option.getOrUndefined(row) as S)
        const folded = yield* fold(
          Option.getOrElse(row, () => config.initial(streamId)),
          run,
        )
        const version = run[run.length - 1]!.version
        const state = yield* writeRow(key, folded, version, row)
        return { streamId: streamIdStr, applied: run, alreadyApplied, state, version }
      })
      return yield* withRetry(attempt)
    }) as Effect.Effect<ProjectionApplied<S, TEvent, StreamMetadata<TMetadata>>, Err, Req>

  const applyBatch = (
    events: ReadonlyArray<Ev>,
    options?: ApplyBatchOptions | undefined,
  ): Effect.Effect<
    ProjectionBatchResult<S, TEvent, StreamMetadata<TMetadata>, Err>,
    never,
    Req
  > => {
    const groups = new Map<string, { positions: Array<number>; events: Array<Ev> }>()
    events.forEach((event, position) => {
      const group = groups.get(event.streamId)
      if (group === undefined)
        groups.set(event.streamId, { positions: [position], events: [event] })
      else {
        group.positions.push(position)
        group.events.push(event)
      }
    })
    return Effect.forEach(
      [...groups],
      ([streamId, group]) => {
        const seen = new Set<number>()
        const ordered = [...group.events]
          .sort((a, b) => a.version - b.version)
          .filter((e) => (seen.has(e.version) ? false : (seen.add(e.version), true)))
        return Effect.result(applyInstance(streamId, undefined, ordered)).pipe(
          Effect.map(
            (result): ProjectionOutcome<S, TEvent, StreamMetadata<TMetadata>, Err> =>
              Result.isSuccess(result)
                ? { _tag: "Applied", positions: group.positions, ...result.success }
                : { _tag: "Failed", streamId, positions: group.positions, error: result.failure },
          ),
        )
      },
      { concurrency: options?.concurrency ?? 10 },
    ).pipe(
      Effect.map((outcomes) => ({
        outcomes,
        failedPositions: outcomes
          .filter((o) => o._tag === "Failed")
          .map((o) => o.positions[0]!)
          .sort((a, b) => a - b),
      })),
    )
  }

  const apply = (event: Ev) =>
    applyBatch([event]).pipe(
      Effect.flatMap(({ outcomes }) => {
        const outcome = outcomes[0]!
        if (outcome._tag === "Failed") return Effect.fail(outcome.error)
        const { _tag, positions, ...applied } = outcome
        return Effect.succeed(applied as ProjectionApplied<S, TEvent, StreamMetadata<TMetadata>>)
      }),
    )

  const catchUp = (
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<ProjectionCaughtUp<S, TEvent, StreamMetadata<TMetadata>>, Err, Req> =>
    applyInstance(
      stream.streamIdFields.map((f) => (streamId as Record<string, string>)[f]).join("#"),
      streamId,
      undefined,
    ).pipe(
      Effect.map((result) => ({
        applied: result.applied,
        // No row and no events: there is nothing to return.
        state: Option.fromUndefinedOr(result.state as S | undefined),
        version: result.version,
      })),
    )

  const rebuild = (streamId: StreamIdInput<TStreamIdFields>) => {
    const key = config.key(streamId)
    const attempt = Effect.gen(function* () {
      const row = yield* readRow(key)
      const events = (yield* stream.read(streamId, { consistentRead: true })) as Array<Ev>
      if (events.length === 0) return { state: row, version: versionOf(row) }
      const folded = yield* fold(config.initial(streamId), events)
      const version = events[events.length - 1]!.version
      const state = yield* writeRow(key, folded, version, row)
      return { state: Option.some(state), version }
    })
    return withRetry(attempt) as Effect.Effect<ProjectionRebuilt<S>, Err, Req>
  }

  const processBatch = <Rec extends StreamRecord>(
    records: ReadonlyArray<Rec>,
    options: ProcessBatchOptions,
  ) =>
    Effect.gen(function* () {
      const events: Array<Ev> = []
      const recordOf: Array<number> = []
      const decodeFailures: Array<{ readonly record: Rec; readonly error: ValidationError }> = []
      const failed = new Set<number>()
      for (const [i, record] of records.entries()) {
        if (record.eventName !== undefined && record.eventName !== "INSERT") continue
        const image = record.dynamodb?.NewImage
        if (image === undefined) continue
        const decoded = yield* Effect.result(stream.decodeStreamImage(image))
        if (Result.isFailure(decoded)) {
          decodeFailures.push({ record, error: decoded.failure })
          failed.add(i)
        } else if (Option.isSome(decoded.success)) {
          events.push(decoded.success.value as Ev)
          recordOf.push(i)
        }
      }
      const batch = yield* applyBatch(
        events,
        options.concurrency === undefined ? undefined : { concurrency: options.concurrency },
      )
      for (const position of batch.failedPositions) failed.add(recordOf[position]!)
      const failedRecords = [...failed].sort((a, b) => a - b).map((i) => records[i]!)
      return {
        outcomes: batch.outcomes,
        decodeFailures,
        failedRecords,
        response: batchResponse(failedRecords, { source: options.source }),
      } satisfies ProcessBatchResult<S, TEvent, StreamMetadata<TMetadata>, Err, Rec>
    })

  return {
    [EventProjectionTypeId]: EventProjectionTypeId,
    pipe() {
      // eslint-disable-next-line prefer-rest-params
      return Pipeable.pipeArguments(this, arguments)
    },
    stream,
    entityType: readModel.entityType,
    applyBatch,
    apply,
    catchUp,
    rebuild,
    processBatch,
  } as unknown as EventProjection<S, TEvent, TStreamIdFields, StreamMetadata<TMetadata>, Err, Req>
}
