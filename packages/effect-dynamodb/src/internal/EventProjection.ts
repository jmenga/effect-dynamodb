/**
 * EventStore projections (#151) — read models folded from a change feed that
 * take their order from the event store, not from delivery.
 *
 * DynamoDB Streams orders records per item only, and a transaction's records
 * carry no grouping or order, so a stream's events reach a consumer in any
 * order. A projection groups a batch's events by row, sorts and
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
  type ConcurrentModification,
  type ConditionalCheckFailed,
  type ItemNotFound,
  StreamRecordIdentifierMissing,
  type ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import {
  Duration,
  Effect,
  Option,
  Pipeable,
  Result,
  type Schedule,
  type Schema,
  Stream,
} from "effect"
import type { DynamoClient, DynamoClientError } from "../DynamoClient.js"
import type { EventStream, StreamEvent, StreamIdInput, StreamMetadata } from "../EventStore.js"
import * as Query from "../Query.js"
import type { Table, TableConfig } from "../Table.js"
import type { EntityGet, EntityPut } from "./EntityOps.js"
import { imageEntityType, type StreamImage } from "./Packed.js"
import {
  addressed,
  type DrainResult,
  type EngineConfig,
  type EngineEntity,
  type EngineSource,
  type InstanceWork,
  keyId,
  makeEngine,
  modelFields,
  type OutboxMeta,
  type RemoveRow,
  type RowResult,
  retrySchedule,
} from "./ProjectionEngine.js"

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
  readonly systemFields: { readonly createdAt: string | null }
  readonly _attachPrototype?: ((decoded: any) => any) | undefined
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
  KR extends ProjectionKey<RM> | Option.Option<ProjectionKey<RM>> = ProjectionKey<RM>,
  O = never,
> {
  /** The source stream. One projection reads one stream. */
  readonly stream: EventStream<TEvent, TStreamIdFields, TMetadata, any, any, any, any>
  /** The read model (an unbound `Entity`). */
  readonly readModel: RM
  /**
   * The row an event folds into. A function of the stream id alone gives one
   * row per stream instance. One that also reads the event lets a stream feed
   * several rows — each row is still fed by that one stream instance (a row
   * fed by several streams needs a checkpoint per source, which projections
   * don't keep). When a later event addresses a different row, the earlier
   * row keeps what it had, and the new row folds only its own events.
   *
   * Return an `Option` to let an event address no row: `Option.none()`
   * acknowledges it — no row is read or written, no checkpoint moves, and it
   * is in no outcome (`ignored` lists its position). `apply` then returns an
   * `Option` too.
   */
  readonly key: (
    streamId: StreamIdInput<TStreamIdFields>,
    event: StreamEvent<TEvent, StreamMetadata<TMetadata>>,
  ) => KR
  /**
   * The state a row starts from, before `event` — the first event folded into
   * a row that does not exist yet.
   */
  readonly initial: (
    streamId: StreamIdInput<TStreamIdFields>,
    event: StreamEvent<TEvent, StreamMetadata<TMetadata>>,
  ) => ProjectionState<RM>
  /**
   * Apply one event. Return the state unchanged to ignore an event (the
   * checkpoint still advances), or `EventStore.removeRow` to remove the row
   * (with `removal`). A failure fails this row only, unless `terminal`
   * accepts it. The library sets the checkpoint (and revision) after the
   * fold; `evolve` need not. It runs again on every lost-race retry, so keep
   * it free of side effects.
   */
  readonly evolve: (
    state: ProjectionState<RM>,
    event: StreamEvent<TEvent, StreamMetadata<TMetadata>>,
  ) => Effect.Effect<ProjectionState<RM> | RemoveRow, E, R>
  /** See {@link ProjectionCheckpoint}. */
  readonly checkpoint: ProjectionCheckpoint<ProjectionState<RM>>
  /**
   * The row as written, from the folded state (checkpoint set) — to recompute
   * attributes kept for other readers (`Hidden` index fields, say) on every
   * write. Default: the state as folded.
   */
  readonly toItem?:
    | ((
        state: ProjectionState<RM>,
        context: {
          readonly streamId: StreamIdInput<TStreamIdFields>
          readonly key: ProjectionKey<RM>
        },
      ) => ProjectionState<RM>)
    | undefined
  /**
   * The `evolve` failures that reject their event rather than fail the row —
   * an update to a row that was never created, say. A rejected event is
   * skipped and reported in the outcome's `rejected`; the fold continues, and
   * a row that does not exist is not created by rejected events alone. The
   * decision must be deterministic: a rejected event can be read again (to
   * fill a later gap) and is rejected again. Any other failure fails the row,
   * and keeps failing it on every redelivery.
   *
   * A row that is never created (every one of its events rejected) has no
   * checkpoint, so each later delivery of its events gap-reads from version 1
   * and reports the earlier rejections again — dedupe `rejected` by version
   * when counting or logging them; the read grows with the stream.
   */
  readonly terminal?: ((error: E) => boolean) | undefined
  /**
   * Retries after a lost race — another invocation advanced the row between
   * this one's read and its conditional write. Each retry re-reads the row, so
   * it usually finds the events applied and has nothing left to write. A
   * number `n` is `Schedule.recurs(n)`. Default: up to 12 retries after a
   * jittered delay growing from 5 ms by 1.5× (about 1.3 s in all). Exhausted,
   * the row fails with `ConcurrentModification`.
   */
  readonly retry?: number | Schedule.Schedule<unknown, ConcurrentModification> | undefined
  /**
   * A numeric model field the library owns: every write sets it one higher
   * and is conditioned on the value it read (`attribute_not_exists` when the
   * row has none). It may be an existing write counter readers already use.
   * With it, a write is guarded by the revision instead of the checkpoint, so
   * a `rebuild` can't be undone by a concurrent writer. Required by `outbox`.
   */
  readonly revision?: CheckpointField<ProjectionState<RM>> | undefined
  /**
   * Allow `evolve` to remove the row (`EventStore.removeRow`): the library
   * writes a tombstone at the row's key that keeps its checkpoint and
   * revision — read as no row, by this projection and by the entity — so a
   * redelivery can't recreate it. `ttl` lets DynamoDB expire tombstones; it
   * must exceed the change feed's 24 hours plus any redelivery or replay
   * window, or a very late event recreates the row.
   */
  readonly removal?: { readonly ttl?: Duration.Input | undefined } | undefined
  /** Side effects committed with the row — see {@link ProjectionOutboxConfig}. */
  readonly outbox?:
    | ProjectionOutboxConfig<O, StreamEvent<TEvent, StreamMetadata<TMetadata>>, ProjectionState<RM>>
    | undefined
}

/**
 * An ordered, at-least-once outbox (#155). `effects(event, next, context)`
 * returns the side effects an applied event produces (`next` is the row's
 * state after it, `undefined` when it removed the row); they are written —
 * encoded through `schema` — as outbox items in the same transaction as the
 * row, so state and effects commit together. `drain` (or `deliver` on
 * `applyBatch` / `processBatch`) hands them to a `deliver` function strictly
 * in order per row, removing each only after it succeeds.
 *
 * Outbox items live in the row's own partition (sort key
 * `<row sk>#outbox#<revision>#<n>`, `__edd_e__` `<entityType>#outbox`) — or
 * in `table` when given (keyed by `keys`, default `pk` / `sk`). In the read
 * model's table they show in its change stream and in full-table scans (not
 * in the entity's reads, which filter on `__edd_e__`); a separate table keeps
 * them out of both. `index` (a sparse index whose key attributes only outbox
 * items carry) enables `drainPending`. A claim lasts `claimFor` (default 30
 * seconds): a drainer that crashes after delivering leaves it to expire, and
 * the effect is delivered again.
 */
export interface ProjectionOutboxConfig<O, Ev, S> {
  readonly schema: Schema.Codec<O, any>
  readonly effects: (
    event: Ev,
    next: S | undefined,
    context: { readonly source: string; readonly streamId: string },
  ) => ReadonlyArray<O>
  readonly table?: Table<any, any> | undefined
  readonly keys?: { readonly pk: string; readonly sk: string } | undefined
  readonly index?: { readonly name: string; readonly pk: string; readonly sk: string } | undefined
  readonly claimFor?: Duration.Input | undefined
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** An event `evolve` rejected — see {@link ProjectionConfig.terminal}. */
export interface ProjectionRejected<A, M, E> {
  readonly event: StreamEvent<A, M>
  readonly error: E
}

/** One row applied by {@link EventProjection.applyBatch} / `apply`. */
export interface ProjectionApplied<S, A, M, K = unknown, E = unknown> {
  /** The stream instance (`StreamEvent.streamId`). */
  readonly streamId: string
  /** The row's key. */
  readonly key: K
  /**
   * The events this call applied to the row, in version order — including
   * any it read from the store to fill a gap. Each event is in exactly one
   * call's `applied`: the one whose conditional write won. Side effects driven
   * from it are at most once (a crash after the write loses them).
   */
  readonly applied: ReadonlyArray<StreamEvent<A, M>>
  /**
   * The events `evolve` rejected (see {@link ProjectionConfig.terminal}), in
   * version order. Reported by every call that reads them — again, if a row
   * that does not exist is not created before the next read.
   */
  readonly rejected: ReadonlyArray<ProjectionRejected<A, M, E>>
  /**
   * The batch's events this row had already applied (version at or below the
   * checkpoint it read), in version order — a redelivery, or a late
   * out-of-order delivery. Republishing their side effects gives at-least-once
   * delivery, for consumers that tolerate duplicates.
   */
  readonly alreadyApplied: ReadonlyArray<StreamEvent<A, M>>
  /**
   * The row as written, or as read when nothing was left to apply.
   * `Option.none()` when there is no row: every event was rejected, or the
   * row is removed (`removed`).
   */
  readonly state: Option.Option<S>
  /**
   * The row's checkpoint, in store numbering (offset removed): every stream
   * version up to it has been considered for this row.
   */
  readonly version: number
  /** The row is removed: a tombstone keeps its checkpoint (see `removal`). */
  readonly removed: boolean
  /** Outbox effects committed with this write. */
  readonly enqueued: number
  /**
   * With `deliver`: the effect delivery stopped at — it stays pending, at the
   * head of the row's outbox, for the next drain. The write itself succeeded.
   */
  readonly undelivered: Option.Option<{ readonly meta: OutboxMeta; readonly error: unknown }>
}

/** The outcome of one row in {@link ProjectionBatchResult}. */
export type ProjectionOutcome<S, A, M, Err, K = unknown, E = unknown> =
  | ({
      readonly _tag: "Applied"
      /** Positions of this row's events in the `applyBatch` input, ascending. */
      readonly positions: ReadonlyArray<number>
    } & ProjectionApplied<S, A, M, K, E>)
  | {
      readonly _tag: "Failed"
      readonly streamId: string
      /** The row's key — `undefined` when the stream id could not be parsed. */
      readonly key: K | undefined
      /** Positions of this row's events in the `applyBatch` input, ascending. */
      readonly positions: ReadonlyArray<number>
      readonly error: Err
    }

/** Result of {@link EventProjection.applyBatch}. */
export interface ProjectionBatchResult<S, A, M, Err, K = unknown, E = unknown> {
  /** One outcome per row, in order of first delivery. */
  readonly outcomes: ReadonlyArray<ProjectionOutcome<S, A, M, Err, K, E>>
  /**
   * The earliest input position of each failed row, ascending — the records
   * to report in a partial batch response.
   */
  readonly failedPositions: ReadonlyArray<number>
  /** Input positions of the events whose `key` returned `Option.none()`, ascending. */
  readonly ignored: ReadonlyArray<number>
}

/** Result of {@link EventProjection.catchUp}. */
export interface ProjectionCaughtUp<S, A, M, K = unknown, E = unknown> {
  /** The row of the stream's latest event — `Option.none()` for a stream with no events. */
  readonly key: Option.Option<K>
  /** The events folded, in version order. Empty when the row was current. */
  readonly applied: ReadonlyArray<StreamEvent<A, M>>
  /** The events `evolve` rejected, in version order. */
  readonly rejected: ReadonlyArray<ProjectionRejected<A, M, E>>
  /** The row — `Option.none()` when there is none, or it is removed. */
  readonly state: Option.Option<S>
  readonly version: number
  /** The row is removed (a tombstone). */
  readonly removed: boolean
}

/** One row re-derived by {@link EventProjection.rebuild}. */
export interface ProjectionRebuiltRow<S, A, M, K = unknown, E = unknown> {
  readonly key: K
  /** The row as written — as read, when every one of its events was rejected. */
  readonly state: Option.Option<S>
  /** The version of the row's last event. */
  readonly version: number
  readonly rejected: ReadonlyArray<ProjectionRejected<A, M, E>>
  /** The fold ended removed: a tombstone was written. */
  readonly removed: boolean
}

/** Result of {@link EventProjection.rebuild}. */
export interface ProjectionRebuilt<S, A = unknown, M = unknown, K = unknown, E = unknown> {
  /** Every row the stream's events address, in order of their first event. Empty for a stream with no events. */
  readonly rows: ReadonlyArray<ProjectionRebuiltRow<S, A, M, K, E>>
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
  /** Rows applied concurrently. Default `10`. */
  readonly concurrency?: number | "unbounded" | undefined
  /**
   * Drain each row that committed outbox effects right after its write,
   * through this function (see {@link EventProjection.drain}). A delivery
   * failure is reported in the outcome's `undelivered`; it never fails the
   * row — the effects are committed, and stay pending for the next drain.
   */
  readonly deliver?: ((effect: any, meta: OutboxMeta) => Effect.Effect<void, any, any>) | undefined
}

// ---------------------------------------------------------------------------
// Change-feed records and partial batch responses
// ---------------------------------------------------------------------------

/**
 * A DynamoDB Streams record as a Lambda event source mapping or an
 * EventBridge Pipe delivers it — only the members the projection reads.
 * Structural, so no `aws-lambda` types are needed. A record of another shape
 * (a Pipe input template's) is read through `image` / `identifier` accessors.
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

/** Identify records by their source's member — see {@link BatchResponseSource}. */
export interface IdentifyBySource {
  readonly source: BatchResponseSource
}

/** Identify records with an accessor — for a record shape of your own. */
export interface IdentifyWith<Rec> {
  readonly identifier: (record: Rec) => string | undefined
}

/** Options of {@link EventProjection.processBatch}, beside how records are identified. */
export interface ProcessBatchOptions<Rec> extends ApplyBatchOptions {
  /**
   * A record's image, `undefined` to skip it. Default: the `NewImage` of an
   * `INSERT` (a record without an `eventName` counts as one).
   */
  readonly image?: ((record: Rec) => StreamImage | undefined) | undefined
  /**
   * What to do with a record whose image does not decode. A decode failure is
   * deterministic, so `"report"` (the default) makes the source redeliver it
   * — and everything after it on its shard — until its retries or age run out.
   * `"skip"` acknowledges it, to log and dead-letter it yourself. Either way it
   * is in `decodeFailures`.
   *
   * Skipping acknowledges the record, not the stored event: the next event of
   * the same row gap-fills through it, fails to decode it, and fails the row
   * (that record is reported). It helps when the bad event is its stream's
   * last, or once the stored item is repaired or removed.
   */
  readonly onDecodeFailure?: "report" | "skip" | undefined
}

/** Result of {@link EventProjection.processBatch}. */
export interface ProcessBatchResult<S, A, M, Err, Rec, K = unknown, E = unknown> {
  /**
   * See {@link ProjectionBatchResult.outcomes} — with `positions` indexing the
   * **records** passed in.
   */
  readonly outcomes: ReadonlyArray<ProjectionOutcome<S, A, M, Err, K, E>>
  /** Records whose image failed to decode. */
  readonly decodeFailures: ReadonlyArray<{ readonly record: Rec; readonly error: ValidationError }>
  /**
   * The records the response reports, in delivery order: the earliest record
   * of each failed row, and (with `onDecodeFailure: "report"`) every record
   * that failed to decode.
   */
  readonly failedRecords: ReadonlyArray<Rec>
  /**
   * The partial batch response for `failedRecords`. To fail more records (a
   * side effect that failed, say), pass them with these to {@link batchResponse}.
   */
  readonly response: BatchItemFailuresResponse
}

const identify = <Rec>(
  record: Rec,
  index: number,
  options: IdentifyBySource | IdentifyWith<Rec>,
): Effect.Effect<string, StreamRecordIdentifierMissing> => {
  const [itemIdentifier, member] =
    "identifier" in options
      ? [options.identifier(record), "identifier"]
      : options.source === "lambda"
        ? [(record as StreamRecord).dynamodb?.SequenceNumber, "dynamodb.SequenceNumber"]
        : [(record as StreamRecord).eventID, "eventID"]
  return typeof itemIdentifier === "string" && itemIdentifier.length > 0
    ? Effect.succeed(itemIdentifier)
    : Effect.fail(new StreamRecordIdentifierMissing({ index, member }))
}

/**
 * The partial batch response (`ReportBatchItemFailures`) for `failedRecords`:
 * each identified by `dynamodb.SequenceNumber` for a Lambda event source
 * mapping, by `eventID` for an EventBridge Pipe, or by your own `identifier`
 * accessor.
 *
 * Lambda checkpoints at the lowest reported sequence number and redelivers
 * every record from there, so reporting the earliest failed record of each
 * row is enough. A record without an identifier fails with
 * `StreamRecordIdentifierMissing` — an empty one would fail the whole batch
 * silently — so fail the invocation, and the source redelivers the batch.
 */
export const batchResponse: {
  (
    failedRecords: ReadonlyArray<StreamRecord>,
    options: IdentifyBySource,
  ): Effect.Effect<BatchItemFailuresResponse, StreamRecordIdentifierMissing>
  <Rec>(
    failedRecords: ReadonlyArray<Rec>,
    options: IdentifyWith<Rec>,
  ): Effect.Effect<BatchItemFailuresResponse, StreamRecordIdentifierMissing>
} = <Rec>(
  failedRecords: ReadonlyArray<Rec>,
  options: IdentifyBySource | IdentifyWith<Rec>,
): Effect.Effect<BatchItemFailuresResponse, StreamRecordIdentifierMissing> =>
  Effect.forEach(failedRecords, (record, i) => identify(record, i, options)).pipe(
    Effect.map((ids) => ({ batchItemFailures: ids.map((itemIdentifier) => ({ itemIdentifier })) })),
  )

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
 * @internal How a projection takes part in a multi-projection batch: one
 * route per source stream — its decode (under the bound context for a bound
 * projection) and its `applyBatch`.
 */
export const ProjectionRoutes: unique symbol = Symbol.for("effect-dynamodb/EventProjection/Routes")

/**
 * A change-feed projection: one source stream folded into read-model rows —
 * see {@link projection}. Its operations need `DynamoClient | TableConfig`
 * (the stream's table and the read model's) and `evolve`'s requirements;
 * {@link bindProjection} resolves them (`R = never`).
 */
export interface EventProjection<
  S,
  A,
  TStreamIdFields extends ReadonlyArray<string>,
  M,
  Err,
  R,
  K = unknown,
  E = unknown,
  I extends boolean = false,
  O = never,
> extends Pipeable.Pipeable {
  readonly [EventProjectionTypeId]: EventProjectionTypeId
  /** The source stream. */
  readonly stream: EventStream<A, TStreamIdFields, any, any, any, any, any>
  /** @internal See {@link ProjectionRoutes}. */
  readonly [ProjectionRoutes]: (name: string) => ReadonlyArray<Route>
  /** The read model's entity type. */
  readonly entityType: string

  /**
   * Apply one stream's decoded change-feed events — a batch, in delivery
   * order. Per row (`key(streamId, event)`, concurrently across rows):
   *
   * 1. sort and deduplicate the row's events by version;
   * 2. read the row (strongly consistent) and its checkpoint `c`; the events
   *    at or below `c` are `alreadyApplied`, and with none left the row is
   *    done;
   * 3. if the rest are not exactly `c + 1 …` their highest version, read
   *    `c + 1 …` that version from the store with one strongly consistent
   *    `readFrom` and keep the row's events — so nothing waits for a delivery;
   * 4. fold through `evolve` (skipping `terminal` rejections), set the
   *    checkpoint, and write the row once, conditioned on the checkpoint still
   *    being `c` (`create` for a new row; nothing when a new row's events were
   *    all rejected);
   * 5. on a lost race, re-read and continue, under the `retry` policy.
   *
   * Never fails: each row's failure is its outcome, so one row's error can't
   * hide the others' `applied`.
   */
  applyBatch(
    events: ReadonlyArray<StreamEvent<A, M>>,
    options?: ApplyBatchOptions | undefined,
  ): Effect.Effect<ProjectionBatchResult<S, A, M, Err, K, E>, never, R>

  /** {@link EventProjection.applyBatch} of one event, its failure in the error channel. */
  apply(
    event: StreamEvent<A, M>,
  ): Effect.Effect<
    I extends true
      ? Option.Option<ProjectionApplied<S, A, M, K, E>>
      : ProjectionApplied<S, A, M, K, E>,
    Err,
    R
  >

  /**
   * Bring the row of the stream's latest event up to the head: read that
   * event (one strongly consistent `Query`), then the row's events after its
   * checkpoint (one strongly consistent `readFrom`) — to repair a row whose
   * last event never arrived (a dead-lettered record, say). An earlier missing
   * event is filled in by the next delivery anyway. With one row per stream
   * instance that is the only row; {@link EventProjection.rebuild} re-derives
   * every row.
   */
  catchUp(
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<ProjectionCaughtUp<S, A, M, K, E>, Err, R>

  /**
   * Re-derive every row of a stream instance from version 1: fold the whole
   * stream (strongly consistent) from `initial`, row by row, ignoring the rows'
   * state, and write each conditioned on the checkpoint read. Returns no
   * applied events, so a rebuild never replays side effects. A stream with no
   * events writes nothing.
   *
   * Pause live delivery for the stream instance while it runs. The condition
   * is the checkpoint, and a rebuild of a row already at the stream's head
   * writes the same checkpoint back — so an `applyBatch` that read the row
   * before the rebuild still holds a matching condition, and its later write
   * (folded from the old state) replaces the rebuilt row.
   */
  rebuild(
    streamId: StreamIdInput<TStreamIdFields>,
  ): Effect.Effect<ProjectionRebuilt<S, A, M, K, E>, Err, R>

  /**
   * Process a raw change-feed batch: decode each `INSERT`'s `NewImage` (other
   * records, and images that are not this stream's events, are skipped), apply
   * the events with {@link EventProjection.applyBatch}, and build the partial
   * batch response — the earliest record of each failed row and every record
   * that failed to decode (unless `onDecodeFailure: "skip"`), identified per
   * `options.source` or by `options.identifier`. Outcome `positions` index
   * `records`. A failed record without an identifier fails the call with
   * `StreamRecordIdentifierMissing`: fail the invocation, and the source
   * redelivers the batch.
   */
  processBatch<Rec extends StreamRecord>(
    records: ReadonlyArray<Rec>,
    options: ProcessBatchOptions<Rec> & (IdentifyBySource | IdentifyWith<Rec>),
  ): Effect.Effect<ProcessBatchResult<S, A, M, Err, Rec, K, E>, StreamRecordIdentifierMissing, R>
  /** A record shape of your own, read through `image` and `identifier`. */
  processBatch<Rec>(
    records: ReadonlyArray<Rec>,
    options: ProcessBatchOptions<Rec> & {
      readonly image: (record: Rec) => StreamImage | undefined
    } & IdentifyWith<Rec>,
  ): Effect.Effect<ProcessBatchResult<S, A, M, Err, Rec, K, E>, StreamRecordIdentifierMissing, R>

  /**
   * Deliver a row's pending outbox effects (see `outbox`), strictly in order:
   * claim the head item, `deliver` it, delete it, repeat — stopping at a
   * failure (reported in `undelivered`, the effect left pending) or at a head
   * another drainer holds. A crash after delivering leaves a claim that
   * expires (`claimFor`), and the effect is delivered again: at least once.
   */
  drain<DE, DR>(
    key: K,
    deliver: (effect: O, meta: OutboxMeta) => Effect.Effect<void, DE, DR>,
  ): Effect.Effect<DrainResult<DE>, DynamoClientError | ValidationError, R | DR>

  /**
   * Drain every row with pending effects, found through the outbox's sparse
   * `index` — the sweeper for rows that receive no further events.
   */
  drainPending<DE, DR>(
    deliver: (effect: O, meta: OutboxMeta) => Effect.Effect<void, DE, DR>,
  ): Effect.Effect<
    {
      readonly delivered: number
      readonly undelivered: ReadonlyArray<{ readonly meta: OutboxMeta; readonly error: DE }>
    },
    DynamoClientError | ValidationError,
    R | DR
  >
}

type AnyEvent = StreamEvent<unknown, unknown>

/** @internal Refusals shared by `projection` and `multiProjection` (`[EDD-9081]`). */
export const refuseReadModel = (
  label: string,
  readModel: ProjectionReadModel,
  options: {
    readonly fields: ReadonlyArray<string>
    readonly removal: boolean
    readonly outbox: boolean
    readonly revision: string | undefined
  },
): void => {
  const refuse = (problem: string): never => {
    throw new Error(`[EDD-9081] ${label}: ${problem}`)
  }
  if (readModel.versioned) {
    refuse(
      "the read model is `versioned`. The projection's checkpoint is the row's version, and a " +
        "versioned put adds its own lock — use a plain entity with a numeric checkpoint field " +
        "(and `revision` for a write counter).",
    )
  }
  if (readModel.softDelete) {
    refuse("the read model has `softDelete`; projections remove rows with `removal` tombstones.")
  }
  if (readModel.timeSeries) {
    refuse("the read model is a `timeSeries` entity, written by `append`, not `put`.")
  }
  const declared = modelFields(readModel.model)
  for (const f of options.fields) {
    if (declared !== undefined && !declared.includes(f)) {
      refuse(`"${f}" is not a field of the read model.`)
    }
  }
  const multiItem = (readModel as { readonly _multiItemWriteFeatures?: ReadonlyArray<string> })
    ._multiItemWriteFeatures
  if ((options.removal || options.outbox) && multiItem !== undefined && multiItem.length > 0) {
    refuse(
      `\`${options.removal ? "removal" : "outbox"}\` writes the row's item itself, which a read ` +
        `model with ${multiItem.join(", ")} can't take (its extra items would not be maintained).`,
    )
  }
  if (options.outbox && options.revision === undefined) {
    refuse("`outbox` orders a row's effects by its `revision`: declare one.")
  }
}

/** @internal An outbox config, resolved. */
export const resolveOutbox = (outbox: ProjectionOutboxConfig<any, any, any> | undefined) =>
  outbox === undefined
    ? undefined
    : {
        schema: outbox.schema,
        effects: outbox.effects,
        table: outbox.table,
        pk: outbox.keys?.pk ?? "pk",
        sk: outbox.keys?.sk ?? "sk",
        index: outbox.index,
        claimFor: Duration.fromInputUnsafe(outbox.claimFor ?? "30 seconds"),
      }

/**
 * Define a change-feed projection of `stream` into `readModel` — rows keyed by
 * `key(streamId, event)` (one per stream instance when the key ignores the
 * event), each folded from `initial(streamId, event)` through `evolve`, its
 * checkpoint kept in `checkpoint`. See {@link EventProjection} for the
 * operations.
 *
 * The read model must be a plain entity: `versioned` (the checkpoint is the
 * version), `softDelete` (removal is `removal` tombstones) and `timeSeries`
 * read models throw `[EDD-9081]`, as do a field the model lacks, a
 * non-integer offset, `removal` / `outbox` on a read model with `unique`
 * constraints, and `outbox` without `revision`.
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
  KR extends ProjectionKey<RM> | Option.Option<ProjectionKey<RM>> = ProjectionKey<RM>,
  O = never,
>(
  config: ProjectionConfig<TEvent, TStreamIdFields, TMetadata, RM, E, R, KR, O>,
): EventProjection<
  ProjectionState<RM>,
  TEvent,
  TStreamIdFields,
  StreamMetadata<TMetadata>,
  ProjectionError<RM, E>,
  R | DynamoClient | TableConfig,
  ProjectionKey<RM>,
  E,
  [Extract<KR, Option.Option<unknown>>] extends [never] ? false : true,
  O
> => {
  type S = ProjectionState<RM>
  type K = ProjectionKey<RM>
  type Ev = StreamEvent<TEvent, StreamMetadata<TMetadata>>
  type Err = ProjectionError<RM, E>
  type Req = R | DynamoClient | TableConfig
  type Id = StreamIdInput<TStreamIdFields>
  type Applied = ProjectionApplied<S, TEvent, StreamMetadata<TMetadata>, K, E>
  type Outcome = ProjectionOutcome<S, TEvent, StreamMetadata<TMetadata>, Err, K, E>

  const { stream, readModel } = config
  const label = `EventStore.projection("${stream.streamName}" → "${readModel.entityType}")`
  const field = (
    typeof config.checkpoint === "string" ? config.checkpoint : config.checkpoint.field
  ) as string
  const offset = typeof config.checkpoint === "string" ? 0 : (config.checkpoint.offset ?? 0)
  refuseReadModel(label, readModel, {
    fields: [field, ...(config.revision === undefined ? [] : [config.revision as string])],
    removal: config.removal !== undefined,
    outbox: config.outbox !== undefined,
    revision: config.revision as string | undefined,
  })
  if (!Number.isInteger(offset)) {
    throw new Error(`[EDD-9081] ${label}: the checkpoint offset ${offset} is not an integer.`)
  }

  const source: EngineSource = {
    name: "projection",
    stream: stream as unknown as EngineSource["stream"],
    key: config.key as EngineSource["key"],
    evolve: (state, event) => config.evolve(state, event),
    mode: "fold",
    terminal: config.terminal as EngineSource["terminal"],
  }
  const engine = makeEngine({
    label,
    readModel: readModel as unknown as EngineEntity,
    sources: [source],
    initial: (_key, context) => config.initial(context.streamId, context.event),
    checkpoints: { kind: "scalar", field, offset },
    revision: config.revision as string | undefined,
    toItem: config.toItem as EngineConfig["toItem"],
    toItemContext: (key, work) => ({ streamId: work[0]?.streamId, key }),
    retry: retrySchedule(config.retry),
    removal:
      config.removal === undefined
        ? undefined
        : {
            ttl:
              config.removal.ttl === undefined
                ? undefined
                : Duration.fromInputUnsafe(config.removal.ttl),
          },
    outbox: resolveOutbox(config.outbox),
  })

  const keyOf = (streamId: Id, event: Ev): Effect.Effect<Option.Option<K>, ValidationError> =>
    engine.call("key", () => addressed<K>(config.key(streamId, event)))

  /** A row's engine result, as this projection reports it. */
  const appliedOf = (streamIdStr: string, result: RowResult): Applied => {
    const instance = result.instances[0]
    return {
      streamId: streamIdStr,
      key: result.key as K,
      applied: (instance?.applied ?? []) as Applied["applied"],
      rejected: (instance?.rejected ?? []) as Applied["rejected"],
      alreadyApplied: (instance?.alreadyApplied ?? []) as Applied["alreadyApplied"],
      state: result.state as Option.Option<S>,
      version: instance?.version ?? 0,
      removed: result.removed,
      enqueued: result.enqueued,
      undelivered: Option.none(),
    }
  }

  /** After a write with effects, drain the row when the caller passed `deliver`. */
  const deliverAfter = (
    applied: Applied,
    deliver: ApplyBatchOptions["deliver"],
  ): Effect.Effect<Applied, Err, Req> =>
    deliver === undefined || config.outbox === undefined || applied.enqueued === 0
      ? Effect.succeed(applied)
      : (
          engine.drain(applied.key, deliver as never) as Effect.Effect<
            DrainResult<unknown>,
            Err,
            Req
          >
        ).pipe(
          Effect.map((drained) => ({
            ...applied,
            undelivered: drained.undelivered as Applied["undelivered"],
          })),
        )

  const applyBatch = (
    events: ReadonlyArray<Ev>,
    options?: ApplyBatchOptions | undefined,
  ): Effect.Effect<
    ProjectionBatchResult<S, TEvent, StreamMetadata<TMetadata>, Err, K, E>,
    never,
    Req
  > =>
    Effect.gen(function* () {
      // By stream instance, in order of first delivery.
      const streams = new Map<string, Array<readonly [number, Ev]>>()
      events.forEach((event, position) => {
        const group = streams.get(event.streamId)
        if (group === undefined) streams.set(event.streamId, [[position, event]])
        else group.push([position, event])
      })
      /** Positions of the events that address no row. */
      const ignored: Array<number> = []
      // Then by row; each row's task is ordered by its first delivered event.
      const tasks: Array<{
        readonly first: number
        readonly run: Effect.Effect<Outcome, never, Req>
      }> = []
      for (const [streamIdStr, group] of streams) {
        const positions = group.map(([position]) => position)
        // A stream id that does not parse, or a `key` that throws, fails the
        // whole stream instance: its events can't be placed in rows.
        const rows = yield* Effect.result(
          Effect.gen(function* () {
            const streamId = (yield* stream.parseStreamId(streamIdStr)) as Id
            const byRow = new Map<string, { key: K; positions: Array<number>; events: Array<Ev> }>()
            for (const [position, event] of group) {
              const key = yield* keyOf(streamId, event)
              if (Option.isNone(key)) {
                ignored.push(position)
                continue
              }
              const id = keyId(key.value)
              const row = byRow.get(id)
              if (row === undefined) {
                byRow.set(id, { key: key.value, positions: [position], events: [event] })
              } else {
                row.positions.push(position)
                row.events.push(event)
              }
            }
            return { streamId, rows: [...byRow.values()] }
          }),
        )
        if (Result.isFailure(rows)) {
          const error = rows.failure as Err
          tasks.push({
            first: positions[0]!,
            run: Effect.succeed({
              _tag: "Failed",
              streamId: streamIdStr,
              key: undefined,
              positions,
              error,
            }),
          })
          continue
        }
        const { streamId } = rows.success
        const delivered = new Set(group.map(([, event]) => event.version))
        for (const row of rows.success.rows) {
          // Sorted by version, one event per version (a redelivery is a duplicate).
          const ordered = [...row.events]
            .sort((a, b) => a.version - b.version)
            .filter((e, i, sorted) => i === 0 || sorted[i - 1]!.version !== e.version)
          const work: InstanceWork = {
            source,
            streamIdStr,
            streamId,
            events: ordered as ReadonlyArray<AnyEvent>,
            top: 0,
            delivered,
          }
          tasks.push({
            first: row.positions[0]!,
            run: Effect.result(
              (engine.applyRow(row.key, [work]) as Effect.Effect<RowResult, Err, Req>).pipe(
                Effect.flatMap((result) =>
                  deliverAfter(appliedOf(streamIdStr, result), options?.deliver),
                ),
              ),
            ).pipe(
              Effect.map(
                (result): Outcome =>
                  Result.isSuccess(result)
                    ? { _tag: "Applied", positions: row.positions, ...result.success }
                    : {
                        _tag: "Failed",
                        streamId: streamIdStr,
                        key: row.key,
                        positions: row.positions,
                        error: result.failure,
                      },
              ),
            ),
          })
        }
      }
      tasks.sort((a, b) => a.first - b.first)
      const outcomes = yield* Effect.forEach(tasks, (task) => task.run, {
        concurrency: options?.concurrency ?? 10,
      })
      return {
        outcomes,
        failedPositions: outcomes
          .filter((o) => o._tag === "Failed")
          .map((o) => o.positions[0]!)
          .sort((a, b) => a - b),
        ignored: ignored.sort((a, b) => a - b),
      }
    })

  /**
   * `applyBatch([event])`, the row's failure in the error channel — wrapped in
   * an `Option` when `key` returns one (none: the event addresses no row).
   */
  const apply = (event: Ev): Effect.Effect<Applied | Option.Option<Applied>, Err, Req> =>
    Effect.gen(function* () {
      const streamId = (yield* stream.parseStreamId(event.streamId)) as Id
      const key = yield* engine.call("key", () => config.key(streamId, event))
      const optional = Option.isOption(key)
      if (optional && Option.isNone(key)) return Option.none<Applied>()
      const { outcomes } = yield* applyBatch([event])
      const outcome = outcomes[0]!
      if (outcome._tag === "Failed") return yield* Effect.fail(outcome.error)
      const { _tag, positions, ...applied } = outcome
      return optional ? Option.some(applied) : applied
    }) as Effect.Effect<Applied | Option.Option<Applied>, Err, Req>

  const joinStreamId = (streamId: Id): string =>
    stream.streamIdFields.map((f) => (streamId as Record<string, string>)[f]).join("#")

  const catchUp = (
    streamId: Id,
  ): Effect.Effect<ProjectionCaughtUp<S, TEvent, StreamMetadata<TMetadata>, K, E>, Err, Req> =>
    Effect.gen(function* () {
      // The latest event that addresses a row — usually the head, one page.
      const pages = yield* Query.paginate(
        stream.query
          .events(streamId)
          .pipe(Query.reverse, Query.pageSize(25), (q) => Query.consistentRead(q)),
      )
      const latest = yield* pages.pipe(
        Stream.flatMap((page) => Stream.fromIterable(page as Array<Ev>)),
        Stream.mapEffect((event) =>
          keyOf(streamId, event).pipe(
            Effect.map((key) => Option.map(key, (k) => [event, k] as const)),
          ),
        ),
        Stream.filter((found) => Option.isSome(found)),
        Stream.map((found) => Option.getOrThrow(found)),
        Stream.runHead,
      )
      if (Option.isNone(latest)) {
        return {
          key: Option.none(),
          applied: [],
          rejected: [],
          state: Option.none(),
          version: 0,
          removed: false,
        }
      }
      const [head, key] = latest.value
      const result = (yield* engine.applyRow(key, [
        {
          source,
          streamIdStr: joinStreamId(streamId),
          streamId,
          events: undefined,
          top: head.version,
          delivered: new Set(),
        },
      ])) as RowResult
      const applied = appliedOf(joinStreamId(streamId), result)
      return {
        key: Option.some(key),
        applied: applied.applied,
        rejected: applied.rejected,
        state: applied.state,
        version: applied.version,
        removed: applied.removed,
      }
    }) as Effect.Effect<ProjectionCaughtUp<S, TEvent, StreamMetadata<TMetadata>, K, E>, Err, Req>

  const rebuild = (
    streamId: Id,
  ): Effect.Effect<ProjectionRebuilt<S, TEvent, StreamMetadata<TMetadata>, K, E>, Err, Req> =>
    Effect.gen(function* () {
      const events = (yield* stream.read(streamId, { consistentRead: true })) as Array<Ev>
      const delivered = new Set(events.map((e) => e.version))
      const rows = new Map<string, { key: K; events: Array<Ev> }>()
      for (const event of events) {
        const key = yield* keyOf(streamId, event)
        if (Option.isNone(key)) continue
        const id = keyId(key.value)
        const row = rows.get(id)
        if (row === undefined) rows.set(id, { key: key.value, events: [event] })
        else row.events.push(event)
      }
      const rebuilt = yield* Effect.forEach(
        [...rows.values()],
        ({ key, events: rowEvents }) =>
          (
            engine.applyRow(
              key,
              [
                {
                  source,
                  streamIdStr: joinStreamId(streamId),
                  streamId,
                  events: rowEvents as ReadonlyArray<AnyEvent>,
                  top: rowEvents[rowEvents.length - 1]!.version,
                  delivered,
                },
              ],
              { fromScratch: true },
            ) as Effect.Effect<RowResult, Err, Req>
          ).pipe(
            Effect.map((result) => {
              const applied = appliedOf(joinStreamId(streamId), result)
              return {
                key,
                state: applied.state,
                version: applied.version,
                rejected: applied.rejected,
                removed: applied.removed,
              }
            }),
          ),
        { concurrency: 10 },
      )
      return { rows: rebuilt }
    }) as Effect.Effect<ProjectionRebuilt<S, TEvent, StreamMetadata<TMetadata>, K, E>, Err, Req>

  const processBatch = <Rec>(
    records: ReadonlyArray<Rec>,
    options: ProcessBatchOptions<Rec> & (IdentifyBySource | IdentifyWith<Rec>),
  ) =>
    runBatch(`${label}.processBatch`, records, options, [
      {
        name: "projection",
        stream: stream as unknown as DecodableStream,
        decode: (image: StreamImage) => stream.decodeStreamImage(image),
        applyBatch: (events, applyOptions) => applyBatch(events as ReadonlyArray<Ev>, applyOptions),
      },
    ]).pipe(
      Effect.map(
        ({ outcomes, unrouted: _, ...rest }) =>
          ({
            ...rest,
            outcomes: outcomes.projection as ReadonlyArray<Outcome>,
          }) satisfies ProcessBatchResult<S, TEvent, StreamMetadata<TMetadata>, Err, Rec, K, E>,
      ),
    )

  const outboxRequired = (operation: string) =>
    Effect.die(
      new Error(`[EDD-9081] ${label}.${operation}: the projection declares no \`outbox\`.`),
    )

  return {
    [EventProjectionTypeId]: EventProjectionTypeId,
    pipe() {
      // eslint-disable-next-line prefer-rest-params
      return Pipeable.pipeArguments(this, arguments)
    },
    stream,
    entityType: readModel.entityType,
    [ProjectionRoutes]: (name: string): ReadonlyArray<Route> => [
      {
        name,
        stream: stream as unknown as DecodableStream,
        decode: (image: StreamImage) => stream.decodeStreamImage(image),
        applyBatch: (events, applyOptions) => applyBatch(events as ReadonlyArray<Ev>, applyOptions),
      },
    ],
    applyBatch,
    apply,
    catchUp,
    rebuild,
    processBatch,
    drain: (key: K, deliver: (effect: O, meta: OutboxMeta) => Effect.Effect<void, any, any>) =>
      config.outbox === undefined ? outboxRequired("drain") : engine.drain(key, deliver),
    drainPending: (deliver: (effect: O, meta: OutboxMeta) => Effect.Effect<void, any, any>) =>
      config.outbox === undefined ? outboxRequired("drainPending") : engine.drainPending(deliver),
  } as unknown as EventProjection<
    S,
    TEvent,
    TStreamIdFields,
    StreamMetadata<TMetadata>,
    Err,
    Req,
    K,
    E,
    [Extract<KR, Option.Option<unknown>>] extends [never] ? false : true,
    O
  >
}

// ---------------------------------------------------------------------------
// Batches across projections
// ---------------------------------------------------------------------------

/** Any projection, bound or unbound — single-source, or multi-source. */
export type AnyEventProjection =
  | EventProjection<any, any, any, any, any, any, any, any, any, any>
  | {
      readonly [ProjectionRoutes]: (name: string) => ReadonlyArray<Route>
      applyBatch(events: ReadonlyArray<any>, options?: any): Effect.Effect<any, never, any>
    }

/** A projection's outcomes. */
export type ProjectionOutcomesOf<P> =
  P extends EventProjection<
    infer S,
    infer A,
    any,
    infer M,
    infer Err,
    any,
    infer K,
    infer E,
    any,
    any
  >
    ? ReadonlyArray<ProjectionOutcome<S, A, M, Err, K, E>>
    : P extends {
          applyBatch(
            events: any,
            options?: any,
          ): Effect.Effect<{ readonly outcomes: infer Outcomes }, never, any>
        }
      ? Outcomes
      : never

/** A projection's requirements. */
export type ProjectionRequirementsOf<P> =
  P extends EventProjection<any, any, any, any, any, infer R, any, any, any, any>
    ? R
    : P extends { applyBatch(events: any, options?: any): Effect.Effect<any, never, infer R> }
      ? R
      : never

/** Result of {@link processBatch}. */
export interface ProcessBatchesResult<
  Projections extends { readonly [name: string]: AnyEventProjection },
  Rec,
  Streams extends { readonly [name: string]: DecodableStream } = {},
> {
  /**
   * The events of the `streams` named without a projection, in delivery order,
   * each with its record's position — so a caller acting on them needs no
   * second decode.
   */
  readonly unrouted: ReadonlyArray<{ readonly position: number } & DecodedStreamEvent<Streams>>
  /**
   * Each projection's outcomes — `positions` index the **records** passed in.
   * A projection whose stream had no events in the batch has none.
   */
  readonly outcomes: { readonly [K in keyof Projections]: ProjectionOutcomesOf<Projections[K]> }
  /** Records whose image failed to decode. */
  readonly decodeFailures: ReadonlyArray<{ readonly record: Rec; readonly error: ValidationError }>
  /**
   * The records the response reports, in delivery order: the earliest record
   * of each failed row of every projection, and (with
   * `onDecodeFailure: "report"`) every record that failed to decode.
   */
  readonly failedRecords: ReadonlyArray<Rec>
  /** The partial batch response for `failedRecords`. */
  readonly response: BatchItemFailuresResponse
}

/** @internal One projection behind a feed: the stream it decodes and its `applyBatch`. */
export interface Route {
  readonly name: string
  /**
   * A multi-source projection's name for this stream: its events reach
   * `applyBatch` as `{ stream: tag, event }`. Undefined: as the bare event.
   */
  readonly tag?: string | undefined
  /** The (unbound) stream — its identity groups the projections that read it. */
  readonly stream: DecodableStream
  /** How its images decode — under the bound context for a bound projection. */
  readonly decode: (
    image: StreamImage,
  ) => Effect.Effect<Option.Option<unknown>, ValidationError, any>
  readonly applyBatch: (
    events: ReadonlyArray<any>,
    options?: ApplyBatchOptions | undefined,
  ) => Effect.Effect<ProjectionBatchResult<any, any, any, any, any, any>, never, any>
}

/** The default `image` accessor: the `NewImage` of an `INSERT`. */
const insertImage = (record: StreamRecord): StreamImage | undefined =>
  record.eventName !== undefined && record.eventName !== "INSERT"
    ? undefined
    : record.dynamodb?.NewImage

/**
 * @internal Decode a batch once, route each event to the projections of its
 * stream, apply each projection's events, and build one partial batch
 * response — shared by {@link processBatch} and `projection.processBatch`.
 */
export const runBatch = <Rec>(
  operation: string,
  records: ReadonlyArray<Rec>,
  options: ProcessBatchOptions<Rec> & (IdentifyBySource | IdentifyWith<Rec>),
  routes: ReadonlyArray<Route>,
  /** Streams decoded without a projection: their events are returned as `unrouted`. */
  decodeOnly: ReadonlyArray<readonly [string, DecodableStream]> = [],
): Effect.Effect<
  {
    readonly unrouted: ReadonlyArray<{
      readonly position: number
      readonly stream: string
      readonly event: unknown
    }>
    readonly outcomes: Record<
      string,
      ReadonlyArray<ProjectionOutcome<any, any, any, any, any, any>>
    >
    readonly decodeFailures: ReadonlyArray<{
      readonly record: Rec
      readonly error: ValidationError
    }>
    readonly failedRecords: ReadonlyArray<Rec>
    readonly response: BatchItemFailuresResponse
  },
  StreamRecordIdentifierMissing,
  any
> => {
  return Effect.gen(function* () {
    // One decode per stream, however many projections read it.
    const streams = new Map<DecodableStream, Array<Route>>()
    for (const route of routes) {
      const readers = streams.get(route.stream)
      if (readers === undefined) streams.set(route.stream, [route])
      else readers.push(route)
    }
    const unroutedStreams = decodeOnly.filter(([, stream]) => !streams.has(stream))
    /** A marker's stream: the projections that read it, or its name when it has none. */
    const byMarker = markerIndex(operation, [
      ...[...streams.keys()].map((stream) => [stream.streamName, stream] as const),
      ...unroutedStreams,
    ])
    const unroutedNames = new Map(unroutedStreams.map(([name, stream]) => [stream, name]))
    const unrouted: Array<{
      readonly position: number
      readonly stream: string
      readonly event: unknown
    }> = []
    const image =
      options.image ?? (insertImage as unknown as (record: Rec) => StreamImage | undefined)
    /** Each projection's events, and the record each came from. */
    const routed = new Map<string, { events: Array<unknown>; recordOf: Array<number> }>(
      routes.map((route) => [route.name, { events: [], recordOf: [] }]),
    )
    const decodeFailures: Array<{ readonly record: Rec; readonly error: ValidationError }> = []
    const failed = new Set<number>()
    for (const [i, record] of records.entries()) {
      const recordImage = image(record)
      if (recordImage === undefined) continue
      const entry =
        typeof recordImage === "object" && recordImage !== null && !Array.isArray(recordImage)
          ? byMarker.get(imageEntityType(recordImage) ?? "")
          : undefined
      // Not an event of any stream named: nothing to apply.
      if (entry === undefined) continue
      const readers = streams.get(entry[1])
      const decoded = yield* Effect.result(
        readers === undefined
          ? entry[1].decodeStreamImage(recordImage)
          : readers[0]!.decode(recordImage),
      )
      if (Result.isFailure(decoded)) {
        decodeFailures.push({ record, error: decoded.failure })
        if (options.onDecodeFailure !== "skip") failed.add(i)
      } else if (Option.isSome(decoded.success) && readers === undefined) {
        unrouted.push({
          position: i,
          stream: unroutedNames.get(entry[1])!,
          event: decoded.success.value,
        })
      } else if (Option.isSome(decoded.success)) {
        for (const route of readers!) {
          const target = routed.get(route.name)!
          target.events.push(
            route.tag === undefined
              ? decoded.success.value
              : { stream: route.tag, event: decoded.success.value },
          )
          target.recordOf.push(i)
        }
      }
    }
    const outcomes: Record<
      string,
      ReadonlyArray<ProjectionOutcome<any, any, any, any, any, any>>
    > = {}
    // One `applyBatch` per projection, however many of its sources routed here.
    const projections = [...new Map(routes.map((route) => [route.name, route])).values()]
    for (const route of projections) {
      const { events, recordOf } = routed.get(route.name)!
      if (events.length === 0) {
        outcomes[route.name] = []
        continue
      }
      const batch = yield* route.applyBatch(
        events,
        options.concurrency === undefined ? undefined : { concurrency: options.concurrency },
      )
      for (const position of batch.failedPositions) failed.add(recordOf[position]!)
      // Positions index the records, not the decoded events.
      outcomes[route.name] = batch.outcomes.map((outcome) => ({
        ...outcome,
        positions: outcome.positions.map((position) => recordOf[position]!),
      }))
    }
    const failedRecords = [...failed].sort((a, b) => a - b).map((i) => records[i]!)
    const response = yield* batchResponse(
      failedRecords,
      ("identifier" in options && options.identifier !== undefined
        ? { identifier: options.identifier }
        : { source: (options as IdentifyBySource).source }) as IdentifyWith<Rec>,
    )
    return { unrouted, outcomes, decodeFailures, failedRecords, response }
  })
}

/**
 * Process one change-feed batch for several projections — the usual shape
 * when one table's feed carries several streams. Each record is decoded once
 * and routed to every projection of its stream; records of other streams and
 * items are skipped, as acknowledged. Each projection applies its events
 * (see {@link EventProjection.applyBatch}), and one partial batch response
 * names the earliest record of every failed row across all of them, plus the
 * records that failed to decode (unless `onDecodeFailure: "skip"`). Outcome
 * `positions` index `records`.
 *
 * Records are read as `StreamRecord`s, identified per `source`, or through
 * `image` / `identifier` accessors for a shape of your own (a Pipe input
 * template's). A failed record without an identifier fails the call with
 * `StreamRecordIdentifierMissing`. `streams` names streams to decode without a
 * projection: their events come back as `unrouted`. Two streams storing
 * events under one marker die with `[EDD-9082]`.
 *
 * @example
 * ```ts
 * const result = yield* EventStore.processBatch(event.Records, {
 *   projections: { summaries: OrderSummaryProjection, balances: BalanceProjection },
 *   source: "lambda",
 * })
 * return result.response
 * ```
 */
export const processBatch: {
  <
    const Projections extends { readonly [name: string]: AnyEventProjection },
    Rec extends StreamRecord,
    const Streams extends { readonly [name: string]: DecodableStream } = {},
  >(
    records: ReadonlyArray<Rec>,
    options: ProcessBatchOptions<Rec> &
      (IdentifyBySource | IdentifyWith<Rec>) & {
        readonly projections: Projections
        readonly streams?: Streams | undefined
      },
  ): Effect.Effect<
    ProcessBatchesResult<Projections, Rec, Streams>,
    StreamRecordIdentifierMissing,
    ProjectionRequirementsOf<Projections[keyof Projections]>
  >
  <
    const Projections extends { readonly [name: string]: AnyEventProjection },
    Rec,
    const Streams extends { readonly [name: string]: DecodableStream } = {},
  >(
    records: ReadonlyArray<Rec>,
    options: ProcessBatchOptions<Rec> & {
      readonly image: (record: Rec) => StreamImage | undefined
    } & IdentifyWith<Rec> & {
        readonly projections: Projections
        readonly streams?: Streams | undefined
      },
  ): Effect.Effect<
    ProcessBatchesResult<Projections, Rec, Streams>,
    StreamRecordIdentifierMissing,
    ProjectionRequirementsOf<Projections[keyof Projections]>
  >
} = (records: ReadonlyArray<unknown>, options: any): any =>
  runBatch(
    "EventStore.processBatch",
    records,
    options,
    Object.entries(
      options.projections as Record<
        string,
        { readonly [ProjectionRoutes]: (name: string) => ReadonlyArray<Route> }
      >,
    ).flatMap(([name, projection]) => projection[ProjectionRoutes](name)),
    Object.entries((options.streams ?? {}) as Record<string, DecodableStream>),
  )
