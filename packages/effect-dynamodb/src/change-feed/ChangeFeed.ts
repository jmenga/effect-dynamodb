/**
 * A polled change feed: an Effect `Stream` over a DynamoDB stream's records,
 * for consumers outside Lambda and EventBridge Pipes (#156). See
 * `docs/designs/change-feed.md`.
 *
 * @module
 */

import type {
  _Record,
  DescribeStreamCommandInput,
  Shard,
  StreamStatus,
} from "@aws-sdk/client-dynamodb-streams"
import type { StreamRecordIdentifierMissing } from "@effect-dynamodb/schema/Errors.js"
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Option,
  Queue,
  Random,
  Result,
  Schedule,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
import * as Capacity from "../internal/Capacity.js"
import {
  type AnyEventProjection,
  type BatchItemFailuresResponse,
  type DecodableStream,
  type ProcessBatchesResult,
  type ProcessBatchOptions,
  type ProjectionRequirementsOf,
  processBatch,
} from "../internal/EventProjection.js"
import { CheckpointStore, type FeedId, type ShardCheckpoint } from "./CheckpointStore.js"
import { DynamoStreamsClient, type DynamoStreamsClientError } from "./DynamoStreamsClient.js"
import {
  type ChangeFeedLeaseHeld,
  ChangeFeedLeaseLost,
  ChangeFeedTrimmed,
  type CheckpointStoreError,
  type ShardIteratorExpired,
  type StreamDataTrimmed,
} from "./Errors.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A change-feed record: the SDK's `GetRecords` record, shaped like the record a
 * Lambda event source mapping delivers (`eventID`, `eventName`,
 * `dynamodb.SequenceNumber`, `dynamodb.NewImage` as DynamoDB JSON with `B` as
 * bytes) — so `EventStore.processBatch` and the stream decoders take it as is.
 */
export type ChangeFeedRecord = _Record

/**
 * One shard's records, in sequence order, read by one `GetRecords`. The shard
 * is not read again until the batch is acknowledged with {@link
 * ChangeFeedBatch.commit} or {@link ChangeFeedBatch.complete} — so a shard's
 * batches are processed in order, and a consumer that never acknowledges a
 * batch stalls its shard.
 */
export interface ChangeFeedBatch {
  readonly streamArn: string
  readonly shardId: string
  /** Non-empty, in sequence order. */
  readonly records: ReadonlyArray<ChangeFeedRecord>
  readonly firstSequenceNumber: string
  readonly lastSequenceNumber: string
  /**
   * Acknowledge every record: commit the shard's checkpoint at
   * `lastSequenceNumber`, and let the shard read on. Only the first
   * acknowledgement that commits counts; one whose write failed can be
   * retried (the shard waits meanwhile). Fails with `ChangeFeedLeaseLost`,
   * writing nothing, once the feed has lost its lease.
   */
  readonly commit: () => Effect.Effect<void, CheckpointStoreError | ChangeFeedLeaseLost>
  /**
   * Acknowledge per a partial batch response whose identifiers are
   * `SequenceNumber`s (`source: "lambda"`): with no failures, {@link commit};
   * otherwise commit the checkpoint at the record before the earliest failed
   * one (none when that is the first record), and read the shard again from
   * the failed record after a backoff. An identifier that names no record of
   * the batch fails the whole batch, as Lambda does.
   */
  readonly complete: (
    response: BatchItemFailuresResponse,
  ) => Effect.Effect<void, CheckpointStoreError | ChangeFeedLeaseLost>
}

/** Where a shard without a checkpoint starts, at a consumer's first start. */
export type StartingPosition = "TRIM_HORIZON" | "LATEST"

/** The feed's lease — see {@link ChangeFeedOptions.lease}. */
export interface ChangeFeedLeaseOptions {
  /** How long a lease lasts unless renewed. Default 30 s. */
  readonly duration?: Duration.Input | undefined
  /**
   * How often the holder renews it. Default a third of `duration`. Must be
   * less than half of `duration` (`[EDD-9083]` otherwise): a renewal the store
   * fails to write is retried until `renewEvery` before the lease would lapse,
   * which leaves `duration − 2 × renewEvery` to retry in.
   */
  readonly renewEvery?: Duration.Input | undefined
  /**
   * A lease held by another process: `"fail"` with `ChangeFeedLeaseHeld`
   * (default), or `"wait"` — try again every `renewEvery` until it is
   * released or expires.
   */
  readonly onHeld?: "fail" | "wait" | undefined
  /** This process's owner id. Default: a random UUID. */
  readonly owner?: string | undefined
}

/** Options of {@link changeFeed}. */
export interface ChangeFeedOptions {
  /** The stream to read (`TableDescription.LatestStreamArn`). */
  readonly streamArn: string
  /**
   * The application consuming the stream: checkpoints and the lease are kept
   * per consumer, so several applications can read one stream with one
   * checkpoint store. Default `"default"`.
   */
  readonly consumer?: string | undefined
  /**
   * Where shards without a checkpoint start when the consumer has no
   * checkpoints at all for the stream. `"TRIM_HORIZON"` (default): every
   * record still retained. `"LATEST"`: the shards open now start after their
   * latest record, and closed shards are checkpointed as finished unread.
   * Every other shard without a checkpoint — a child found later, or any shard
   * after a restart — starts at its trim horizon.
   */
  readonly startingPosition?: StartingPosition | undefined
  /** How long an idle shard waits between empty reads. Default 1 s. */
  readonly pollInterval?: Duration.Input | undefined
  /** Records per batch (`GetRecords.Limit`, 1–1000). Default 100. */
  readonly batchSize?: number | undefined
  /** How often the whole stream is described again for new shards. Default 30 s. */
  readonly describeInterval?: Duration.Input | undefined
  /**
   * How many shard reads (`GetShardIterator` / `GetRecords` calls) may be in
   * flight at once, across all shards. Every shard keeps its own reader and
   * takes turns, so a bound below the number of open shards slows reading
   * rather than starving any shard. Default 16.
   */
  readonly maxConcurrentReads?: number | undefined
  /**
   * Backoff for throttling and transient errors (retried without limit) and
   * for re-reading a batch with failed records: jittered, exponential from
   * `initial` (default 100 ms) up to `max` (default 10 s).
   */
  readonly backoff?:
    | { readonly initial?: Duration.Input | undefined; readonly max?: Duration.Input | undefined }
    | undefined
  /**
   * One lease per consumer and stream, held while the feed runs, so a second
   * process can't consume the same feed by accident. `false` disables it.
   * Default: enabled, with the defaults of {@link ChangeFeedLeaseOptions}.
   */
  readonly lease?: ChangeFeedLeaseOptions | false | undefined
}

/** What a change feed fails with. */
export type ChangeFeedError =
  | Exclude<DynamoStreamsClientError, ShardIteratorExpired | StreamDataTrimmed>
  | ChangeFeedTrimmed
  | ChangeFeedLeaseHeld
  | ChangeFeedLeaseLost
  | CheckpointStoreError

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/** How a batch was acknowledged. */
type Ack =
  | { readonly _tag: "Continue" }
  | {
      readonly _tag: "Retry"
      /** The record to read from again. */
      readonly from: string
      /** The checkpoint committed — `undefined` when it did not move. */
      readonly acknowledged: string | undefined
    }

/** Where a shard iterator starts. */
type Position =
  | { readonly type: "TRIM_HORIZON" | "LATEST" }
  | {
      readonly type: "AFTER_SEQUENCE_NUMBER" | "AT_SEQUENCE_NUMBER"
      readonly sequenceNumber: string
    }

const isTransient = (error: { readonly _tag: string }): boolean =>
  error._tag === "ThrottlingError" || error._tag === "InternalServerError"

/**
 * A change feed over `options.streamArn`: a `Stream` of {@link ChangeFeedBatch}es.
 *
 * - **Shards** are found with `DescribeStream` (paginated), at start and every
 *   `describeInterval`; a drained shard's children are looked up with
 *   `ShardFilter` (`CHILD_SHARDS`), falling back to a full describe where the
 *   filter is unsupported (DynamoDB Local) or finds nothing yet.
 * - **A parent shard is read to its end before its children**, so one item's
 *   records stay in order across a split. A closed shard is drained, its last
 *   batch acknowledged, checkpointed as finished, and dropped.
 * - **Shards are read concurrently**, each in order with one batch in flight:
 *   a shard reads again only once its batch is acknowledged, so a slow
 *   consumer slows polling.
 *   `maxConcurrentReads` bounds the reads in flight across shards.
 * - **Checkpoints** move only when a batch is acknowledged — at least once.
 *   A shard resumes after its checkpoint (`AFTER_SEQUENCE_NUMBER`). An expired
 *   iterator is re-acquired from the shard's position; a position past the
 *   stream's retention fails with `ChangeFeedTrimmed`.
 * - **Throttling and transient errors** retry with jittered backoff. An idle
 *   shard polls every `pollInterval`.
 * - **The lease** keeps a second process from consuming the same feed.
 *
 * The stream ends when the stream is disabled and every shard is drained;
 * otherwise it runs until interrupted.
 *
 * Throws `[EDD-9083]` for options it can't honour: `lease.renewEvery` of half
 * `lease.duration` or more, a `batchSize` outside 1–1000, a
 * `maxConcurrentReads` that is not a positive integer.
 *
 * @example
 * ```ts
 * const feed = changeFeed({ streamArn, startingPosition: "TRIM_HORIZON" })
 * yield* feed.pipe(
 *   Stream.mapEffect((batch) => handle(batch.records).pipe(Effect.andThen(batch.commit()))),
 *   Stream.runDrain,
 * )
 * ```
 */
export const changeFeed = (
  options: ChangeFeedOptions,
): Stream.Stream<ChangeFeedBatch, ChangeFeedError, DynamoStreamsClient | CheckpointStore> => {
  validate(options)
  return Stream.callback<ChangeFeedBatch, ChangeFeedError, DynamoStreamsClient | CheckpointStore>(
    (queue) =>
      run(options, queue).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Queue.failCause(queue, cause),
        ),
      ),
  )
}

/** The lease's `duration` and `renewEvery`, defaults applied. */
const leaseTiming = (lease: ChangeFeedLeaseOptions) => {
  const duration = Duration.fromInputUnsafe(lease.duration ?? "30 seconds")
  const renewEvery = Duration.fromInputUnsafe(
    lease.renewEvery ?? Duration.millis(Math.max(1, Math.floor(Duration.toMillis(duration) / 3))),
  )
  return { duration, renewEvery }
}

/** Refuse options the feed can't honour — `[EDD-9083]`. */
const validate = (options: ChangeFeedOptions): void => {
  const refuse = (problem: string): never => {
    throw new Error(`[EDD-9083] changeFeed("${options.streamArn}"): ${problem}`)
  }
  if (options.lease !== false && options.lease !== undefined) {
    const { duration, renewEvery } = leaseTiming(options.lease)
    if (!(Duration.toMillis(renewEvery) > 0)) refuse("lease.renewEvery must be positive.")
    if (Duration.toMillis(renewEvery) * 2 >= Duration.toMillis(duration)) {
      refuse(
        `lease.renewEvery (${Duration.toMillis(renewEvery)} ms) must be less than half of ` +
          `lease.duration (${Duration.toMillis(duration)} ms), to leave time to retry a ` +
          "renewal the store fails to write before the lease lapses.",
      )
    }
  }
  const reads = options.maxConcurrentReads
  if (reads !== undefined && !(Number.isInteger(reads) && reads >= 1)) {
    refuse(`maxConcurrentReads must be a positive integer, got ${reads}.`)
  }
  const size = options.batchSize
  if (size !== undefined && !(Number.isInteger(size) && size >= 1 && size <= 1000)) {
    refuse(`batchSize must be an integer from 1 to 1000, got ${size}.`)
  }
}

const run = (
  options: ChangeFeedOptions,
  queue: Queue.Queue<ChangeFeedBatch, ChangeFeedError | Cause.Done>,
): Effect.Effect<void, ChangeFeedError, DynamoStreamsClient | CheckpointStore | Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* DynamoStreamsClient
    const store = yield* CheckpointStore
    const scope = yield* Effect.scope
    const { streamArn } = options
    const feed: FeedId = { streamArn, consumer: options.consumer ?? "default" }
    const pollInterval = Duration.fromInputUnsafe(options.pollInterval ?? "1 second")
    const describeInterval = Duration.fromInputUnsafe(options.describeInterval ?? "30 seconds")
    const batchSize = options.batchSize ?? 100
    const initialBackoff = Duration.fromInputUnsafe(options.backoff?.initial ?? "100 millis")
    const maxBackoff = Duration.fromInputUnsafe(options.backoff?.max ?? "10 seconds")
    const backoff = Schedule.jittered(
      Schedule.min([Schedule.exponential(initialBackoff, 2), Schedule.spaced(maxBackoff)]),
    )

    /** Retry throttling and transient errors without limit. */
    const transient = <A, E extends { readonly _tag: string }, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => Effect.retry(effect, { schedule: backoff, while: isTransient })

    /** Fail the stream with a forked fiber's failure. */
    const failStream = <A, E extends ChangeFeedError, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<void, never, R> =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Queue.failCause(queue, cause),
        ),
      )

    /** Bounds the shard reads in flight; held for one call, not across a backoff. */
    const reads = yield* Semaphore.make(options.maxConcurrentReads ?? 16)
    const read = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
      transient(Semaphore.withPermit(reads, effect))

    /** A jittered delay growing per consecutive failure, capped at `backoff.max`. */
    const retryDelay = (failures: number) =>
      Effect.map(Random.nextBetween(0.8, 1.2), (jitter) =>
        Duration.millis(
          Math.min(
            Duration.toMillis(maxBackoff),
            Duration.toMillis(initialBackoff) * 2 ** failures,
          ) * jitter,
        ),
      )

    // -- Lease -------------------------------------------------------------

    /** Set once the lease is lost: acknowledgements then fail, writing nothing. */
    let leaseLost: ChangeFeedLeaseLost | undefined

    if (options.lease !== false) {
      const lease = options.lease ?? {}
      const { duration, renewEvery } = leaseTiming(lease)
      const owner = lease.owner ?? globalThis.crypto.randomUUID()
      const acquire = store.acquireLease(feed, owner, duration)
      yield* lease.onHeld === "wait"
        ? Effect.retry(acquire, {
            schedule: Schedule.spaced(renewEvery),
            while: (error) => error._tag === "ChangeFeedLeaseHeld",
          })
        : acquire
      yield* Effect.addFinalizer(() => Effect.ignore(store.releaseLease(feed, owner)))
      let renewedAt = yield* Clock.currentTimeMillis
      const lost = (error: ChangeFeedLeaseLost | CheckpointStoreError) => {
        leaseLost = new ChangeFeedLeaseLost({ streamArn, consumer: feed.consumer, owner })
        return Effect.fail(error)
      }
      /**
       * Renew the lease. A store failure is retried until the lease is about
       * to lapse — `renewEvery` before it expires — and a lease taken over is
       * not retried; either way the lease counts as lost.
       */
      const renew = Effect.gen(function* () {
        const deadline = renewedAt + Duration.toMillis(duration) - Duration.toMillis(renewEvery)
        for (let attempt = 0; ; attempt++) {
          const at = yield* Clock.currentTimeMillis
          const result = yield* Effect.result(store.renewLease(feed, owner, duration))
          if (Result.isSuccess(result)) {
            renewedAt = at
            return
          }
          const now = yield* Clock.currentTimeMillis
          if (result.failure._tag !== "CheckpointStoreError" || now >= deadline) {
            return yield* lost(result.failure)
          }
          const delay = yield* retryDelay(attempt)
          yield* Effect.sleep(Duration.millis(Math.min(Duration.toMillis(delay), deadline - now)))
        }
      })
      // Forked fibers run detached from any current operation, so each
      // checkpoint-store call is reported on its own (consumed capacity, #174).
      yield* Effect.forkIn(
        Capacity.detached(
          failStream(Effect.forever(Effect.sleep(renewEvery).pipe(Effect.andThen(renew)))),
        ),
        scope,
      )
    }

    // -- Shards ------------------------------------------------------------

    const checkpoints = yield* store.load(feed)
    const fresh = checkpoints.size === 0
    /** Every shard described, by id — updated by each describe (a shard closes). */
    const known = new Map<string, Shard>()
    const started = new Set<string>()
    const finished = new Set<string>()
    for (const [shardId, checkpoint] of checkpoints) {
      if (checkpoint._tag === "Finished") finished.add(shardId)
    }
    /** At a fresh `LATEST` start, the shards open at that moment. */
    const latest = new Set<string>()
    let status: StreamStatus | undefined
    let shardFilter = true

    /** Shards missing from a describe that a probe found still there, all closed parents. */
    const probedClosed = new Set<string>()
    /**
     * Asks the describer for a full describe soon: drained shards that find no
     * children share one describe instead of each running their own.
     */
    const wake = yield* Queue.dropping<void>(1)

    const absorb = (shards: ReadonlyArray<Shard>) => {
      for (const shard of shards) if (shard.ShardId !== undefined) known.set(shard.ShardId, shard)
    }

    /** `DescribeStream`, transient errors retried (it raises no iterator errors). */
    const describe = (input: DescribeStreamCommandInput) =>
      transient(client.describeStream(input)).pipe(
        Effect.catchTags({
          ShardIteratorExpired: (e) => Effect.die(e),
          StreamDataTrimmed: (e) => Effect.die(e),
        }),
      )

    const describeAll = Effect.gen(function* () {
      const shards: Array<Shard> = []
      let ExclusiveStartShardId: string | undefined
      do {
        const page = yield* describe({
          StreamArn: streamArn,
          ...(ExclusiveStartShardId === undefined ? {} : { ExclusiveStartShardId }),
        })
        shards.push(...(page.StreamDescription?.Shards ?? []))
        status = page.StreamDescription?.StreamStatus ?? status
        ExclusiveStartShardId = page.StreamDescription?.LastEvaluatedShardId
      } while (ExclusiveStartShardId !== undefined)
      absorb(shards)
      // Forget finished shards that have left the stream (24 h after closing),
      // so a long-running feed does not accumulate them.
      const listed = new Set(
        shards.flatMap((shard) => (shard.ShardId === undefined ? [] : [shard.ShardId])),
      )
      for (const shardId of [...known.keys()]) {
        if (!listed.has(shardId) && finished.has(shardId)) {
          known.delete(shardId)
          started.delete(shardId)
          finished.delete(shardId)
        }
      }
      return listed as ReadonlySet<string>
    })

    /**
     * The children of a drained shard — with `ShardFilter`, or, where the
     * filter is unsupported or finds none yet, the describer's next full
     * describe, which it runs soon (shared by every shard drained meanwhile).
     */
    const discoverChildren = (parentId: string) =>
      Effect.gen(function* () {
        if (shardFilter) {
          const filtered = yield* describe({
            StreamArn: streamArn,
            ShardFilter: { Type: "CHILD_SHARDS", ShardId: parentId },
          }).pipe(
            Effect.map(Option.some),
            Effect.catchTag("DynamoValidationError", () => {
              shardFilter = false
              return Effect.succeed(Option.none())
            }),
          )
          if (Option.isSome(filtered)) {
            const description = filtered.value.StreamDescription
            status = description?.StreamStatus ?? status
            const children = (description?.Shards ?? []).filter((s) => s.ParentShardId === parentId)
            absorb(children)
            if (children.length > 0) return
          }
        }
        Queue.offerUnsafe(wake, undefined)
      })

    const isOpen = (shardId: string): boolean =>
      !probedClosed.has(shardId) &&
      known.get(shardId)?.SequenceNumberRange?.EndingSequenceNumber === undefined

    const startPosition = (shardId: string): Position => {
      const checkpoint: ShardCheckpoint | undefined = checkpoints.get(shardId)
      if (checkpoint?._tag === "Sequence") {
        return { type: "AFTER_SEQUENCE_NUMBER", sequenceNumber: checkpoint.sequenceNumber }
      }
      return { type: latest.has(shardId) ? "LATEST" : "TRIM_HORIZON" }
    }

    /** Hand a batch to the consumer and wait for its acknowledgement. */
    const deliver = (shardId: string, records: ReadonlyArray<ChangeFeedRecord>) =>
      Effect.gen(function* () {
        const ack = yield* Deferred.make<Ack>()
        const sequences = records.map((record) => record.dynamodb?.SequenceNumber ?? "")
        const first = sequences[0]!
        const last = sequences[sequences.length - 1]!
        // Acknowledgements run one at a time; the first whose checkpoint is
        // written settles the batch, and a failed write leaves it unsettled, so
        // a retry writes again.
        const lock = yield* Semaphore.make(1)
        let settled = false
        const settle = (checkpoint: string | undefined, result: Ack) =>
          Semaphore.withPermit(
            lock,
            Effect.suspend((): Effect.Effect<void, CheckpointStoreError | ChangeFeedLeaseLost> => {
              if (settled) return Effect.void
              if (leaseLost !== undefined) return Effect.fail(leaseLost)
              return (
                checkpoint === undefined
                  ? Effect.void
                  : store.commit(feed, shardId, { _tag: "Sequence", sequenceNumber: checkpoint })
              ).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    settled = true
                    return Deferred.succeed(ack, result)
                  }),
                ),
                Effect.asVoid,
              )
            }),
          )
        const commit = () => settle(last, { _tag: "Continue" })
        const complete = (response: BatchItemFailuresResponse) =>
          Effect.suspend(() => {
            if (response.batchItemFailures.length === 0) return commit()
            const failed = new Set(response.batchItemFailures.map((f) => f.itemIdentifier))
            const inBatch = new Set(sequences)
            // An identifier naming no record fails the whole batch, as Lambda does.
            const at = [...failed].some((id) => !inBatch.has(id))
              ? 0
              : sequences.findIndex((sequence) => failed.has(sequence))
            const acknowledged = at === 0 ? undefined : sequences[at - 1]
            return settle(acknowledged, { _tag: "Retry", from: sequences[at]!, acknowledged })
          })
        yield* Queue.offer(queue, {
          streamArn,
          shardId,
          records,
          firstSequenceNumber: first,
          lastSequenceNumber: last,
          commit,
          complete,
        })
        return yield* Deferred.await(ack)
      })

    /** Read one shard to its end (it closed and every record was acknowledged). */
    const readShard = (shardId: string, start: Position) =>
      Effect.gen(function* () {
        let position = start
        let acknowledged = start.type === "AFTER_SEQUENCE_NUMBER" ? start.sequenceNumber : undefined
        let iterator: string | undefined
        let failures = 0
        let misses = 0
        const trimmed = (cause: unknown) =>
          new ChangeFeedTrimmed({ streamArn, shardId, sequenceNumber: acknowledged, cause })
        while (true) {
          if (iterator === undefined) {
            const acquired = yield* read(
              client.getShardIterator({
                StreamArn: streamArn,
                ShardId: shardId,
                ShardIteratorType: position.type,
                ...("sequenceNumber" in position
                  ? { SequenceNumber: position.sequenceNumber }
                  : {}),
              }),
            ).pipe(
              Effect.catchTag("StreamDataTrimmed", (e) => Effect.fail(trimmed(e.cause))),
              Effect.catchTag("ShardIteratorExpired", (e) => Effect.die(e)),
            )
            iterator = acquired.ShardIterator
            if (iterator === undefined) {
              // No iterator. A closed shard has nothing left to read; for one
              // the stream still lists as open, refresh the list and retry.
              const listed = yield* describeAll
              if (!listed.has(shardId)) {
                return yield* trimmed(new Error(`Shard ${shardId} is no longer in the stream`))
              }
              if (!isOpen(shardId)) return
              yield* Effect.sleep(yield* retryDelay(misses++))
              continue
            }
            misses = 0
          }
          const page = yield* read(
            client.getRecords({ ShardIterator: iterator, Limit: batchSize }),
          ).pipe(
            Effect.map(Option.some),
            Effect.catchTag("ShardIteratorExpired", () => Effect.succeed(Option.none())),
            Effect.catchTag("StreamDataTrimmed", (e) => Effect.fail(trimmed(e.cause))),
          )
          if (Option.isNone(page)) {
            // Re-acquire from the shard's position.
            iterator = undefined
            continue
          }
          const records = page.value.Records ?? []
          if (records.length > 0) {
            const ack = yield* deliver(shardId, records)
            if (ack._tag === "Retry") {
              if (ack.acknowledged !== undefined) acknowledged = ack.acknowledged
              position = { type: "AT_SEQUENCE_NUMBER", sequenceNumber: ack.from }
              iterator = undefined
              yield* Effect.sleep(yield* retryDelay(failures++))
              continue
            }
            failures = 0
            acknowledged = records[records.length - 1]!.dynamodb?.SequenceNumber ?? acknowledged
            if (acknowledged !== undefined) {
              position = { type: "AFTER_SEQUENCE_NUMBER", sequenceNumber: acknowledged }
            }
          }
          const next = page.value.NextShardIterator
          // No next iterator: the shard is closed and read to its end.
          if (next === undefined) return
          iterator = next
          if (records.length === 0 && isOpen(shardId)) yield* Effect.sleep(pollInterval)
        }
      })

    /** End the stream once the stream is disabled and every shard is drained. */
    const maybeEnd = Effect.suspend(() =>
      status === "DISABLED" &&
      [...known.keys()].every((shardId) => finished.has(shardId)) &&
      [...started].every((shardId) => finished.has(shardId))
        ? Effect.asVoid(Queue.end(queue))
        : Effect.void,
    )

    /** Start every shard whose parent is drained (or gone). */
    const schedule: Effect.Effect<void> = Effect.suspend(() => {
      const ready: Array<string> = []
      for (const [shardId, shard] of known) {
        if (started.has(shardId) || finished.has(shardId)) continue
        const parent = shard.ParentShardId
        if (parent !== undefined && known.has(parent) && !finished.has(parent)) continue
        started.add(shardId)
        ready.push(shardId)
      }
      return Effect.forEach(
        ready,
        (shardId) => Effect.forkIn(Capacity.detached(failStream(shardLifecycle(shardId))), scope),
        { discard: true },
      )
    })

    const shardLifecycle = (shardId: string): Effect.Effect<void, ChangeFeedError> =>
      Effect.gen(function* () {
        yield* readShard(shardId, startPosition(shardId))
        yield* store.commit(feed, shardId, { _tag: "Finished" })
        finished.add(shardId)
        yield* discoverChildren(shardId)
        yield* schedule
        yield* maybeEnd
      })

    /**
     * Whether a shard missing from a describe is still in the stream — its
     * trim horizon still yields an iterator. Gone: not found, or trimmed.
     */
    const exists = (shardId: string) =>
      read(
        client.getShardIterator({
          StreamArn: streamArn,
          ShardId: shardId,
          ShardIteratorType: "TRIM_HORIZON",
        }),
      ).pipe(
        Effect.as(true),
        Effect.catchTags({
          ResourceNotFoundError: () => Effect.succeed(false),
          StreamDataTrimmed: () => Effect.succeed(false),
          ShardIteratorExpired: (e) => Effect.die(e),
        }),
      )

    let listed = yield* describeAll
    /**
     * Shards this consumer may still owe records from that the describe did
     * not list: shards with a `Sequence` checkpoint, and the unfinished parents
     * of listed shards it has not started.
     */
    const unlisted = () => {
      const ids = new Map<string, "parent" | "checkpoint">()
      for (const [shardId, checkpoint] of checkpoints) {
        if (checkpoint._tag === "Sequence" && !listed.has(shardId)) ids.set(shardId, "checkpoint")
      }
      for (const [shardId, shard] of known) {
        const parent = shard.ParentShardId
        if (
          parent !== undefined &&
          !checkpoints.has(shardId) &&
          !listed.has(parent) &&
          !finished.has(parent) &&
          !ids.has(parent)
        ) {
          ids.set(parent, "parent")
        }
      }
      return ids
    }
    let missing = unlisted()
    // A describe may omit a shard that is still there: describe once more,
    // then probe what is still missing before treating it as gone.
    if (missing.size > 0) {
      listed = yield* describeAll
      missing = unlisted()
    }
    for (const [shardId, kind] of missing) {
      if (yield* exists(shardId)) {
        // Still there: read it like any other shard, before its children.
        known.set(shardId, { ShardId: shardId })
        if (kind === "parent") probedClosed.add(shardId)
      } else if (fresh) {
        // Gone before this consumer started: nothing of it is owed. Recorded,
        // so a restart can tell it from a lost one.
        yield* store.commit(feed, shardId, { _tag: "Finished" })
        finished.add(shardId)
      } else {
        // Gone while this consumer still owed records from it (downtime past
        // the 24-hour retention): its unread records are lost.
        const checkpoint = checkpoints.get(shardId)
        return yield* new ChangeFeedTrimmed({
          streamArn,
          shardId,
          sequenceNumber: checkpoint?._tag === "Sequence" ? checkpoint.sequenceNumber : undefined,
          cause: new Error(
            `Shard ${shardId} is no longer in the stream, and was not read to its end`,
          ),
        })
      }
    }
    if (fresh && options.startingPosition === "LATEST") {
      for (const [shardId] of known) {
        if (isOpen(shardId)) {
          latest.add(shardId)
        } else {
          yield* store.commit(feed, shardId, { _tag: "Finished" })
          finished.add(shardId)
        }
      }
    }
    yield* schedule
    yield* maybeEnd
    // The describer: every `describeInterval`, or soon after a drained shard
    // found no children — at most one describe per `pollInterval` for those.
    yield* Effect.forkIn(
      Capacity.detached(
        failStream(
          Effect.forever(
            Effect.gen(function* () {
              yield* Effect.raceFirst(Effect.sleep(describeInterval), Queue.take(wake))
              yield* Queue.clear(wake)
              yield* describeAll
              yield* schedule
              yield* maybeEnd
              yield* Effect.sleep(pollInterval)
            }),
          ),
        ),
      ),
      scope,
    )
  })

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/** Options of {@link runChangeFeed}. */
export type RunChangeFeedOptions<
  Projections extends { readonly [name: string]: AnyEventProjection },
  Streams extends { readonly [name: string]: DecodableStream },
  E2,
  R2,
> = ProcessBatchOptions<ChangeFeedRecord> & {
  /** The projections to apply, as `EventStore.processBatch` takes them. */
  readonly projections: Projections
  /** Streams to decode without a projection — their events come back as `unrouted`. */
  readonly streams?: Streams | undefined
  /**
   * Called with each batch and its result before the batch is acknowledged —
   * to act on `applied` events or `unrouted` ones. Its failure ends the run
   * before the acknowledgement, so the batch is read again on restart.
   */
  readonly onBatch?:
    | ((
        batch: ChangeFeedBatch,
        result: ProcessBatchesResult<Projections, ChangeFeedRecord, Streams>,
      ) => Effect.Effect<void, E2, R2>)
    | undefined
}

/**
 * Run a change feed into projections: each batch goes through
 * `EventStore.processBatch(batch.records, { projections, source: "lambda" })`,
 * then `batch.complete(result.response)` — the checkpoint moves past the
 * batch, or to the record before its earliest failed record, which the shard
 * reads again. Batches of different shards are processed concurrently.
 *
 * Runs until the feed ends (its stream disabled and drained) or fails.
 *
 * @example
 * ```ts
 * yield* runChangeFeed(changeFeed({ streamArn }), {
 *   projections: { summaries: OrderSummaryProjection },
 * })
 * ```
 */
export const runChangeFeed = <
  const Projections extends { readonly [name: string]: AnyEventProjection },
  E,
  R,
  const Streams extends { readonly [name: string]: DecodableStream } = {},
  E2 = never,
  R2 = never,
>(
  feed: Stream.Stream<ChangeFeedBatch, E, R>,
  options: RunChangeFeedOptions<Projections, Streams, E2, R2>,
): Effect.Effect<
  void,
  E | E2 | CheckpointStoreError | ChangeFeedLeaseLost | StreamRecordIdentifierMissing,
  R | R2 | ProjectionRequirementsOf<Projections[keyof Projections]>
> => {
  const { onBatch, ...processOptions } = options
  return feed.pipe(
    Stream.mapEffect(
      (batch) =>
        (
          processBatch(batch.records, {
            ...processOptions,
            source: "lambda",
          }) as Effect.Effect<
            ProcessBatchesResult<Projections, ChangeFeedRecord, Streams>,
            StreamRecordIdentifierMissing,
            ProjectionRequirementsOf<Projections[keyof Projections]>
          >
        ).pipe(
          Effect.tap((result) => (onBatch === undefined ? Effect.void : onBatch(batch, result))),
          Effect.flatMap((result) => batch.complete(result.response)),
        ),
      { concurrency: "unbounded", unordered: true },
    ),
    Stream.runDrain,
  )
}
