/**
 * The polled change feed (#156): `changeFeed`, `runChangeFeed`, the in-memory
 * `CheckpointStore` and `DynamoStreamsClient` error mapping — against a fake
 * DynamoDB Streams backend behind the real SDK-wrapping service, so the
 * error classification is exercised too.
 */

import {
  type _Record,
  DescribeStreamCommand,
  type DescribeStreamCommandInput,
  type DynamoDBStreamsClient,
  GetRecordsCommand,
  type GetRecordsCommandInput,
  GetShardIteratorCommand,
  type GetShardIteratorCommandInput,
  ListStreamsCommand,
  type Shard,
  type StreamStatus,
} from "@aws-sdk/client-dynamodb-streams"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Random,
  References,
  Schema,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { classifyStreamsError, fromSdkClient } from "../src/change-feed/DynamoStreamsClient.js"
import {
  type ChangeFeedBatch,
  type ChangeFeedError,
  ChangeFeedLeaseLost,
  type ChangeFeedOptions,
  CheckpointStore,
  CheckpointStoreError,
  type CheckpointStoreService,
  changeFeed,
  DynamoStreamsClient,
  type FeedId,
  runChangeFeed,
} from "../src/change-feed/index.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { collectReports } from "./helpers/CapacityMock.js"
import {
  answer,
  hang,
  type LocalServer,
  localServer,
  passThrough,
  type Reply,
  reset,
  type SeenRequest,
} from "./helpers/LocalServer.js"

// ---------------------------------------------------------------------------
// A fake DynamoDB Streams backend
// ---------------------------------------------------------------------------

const STREAM_ARN = "arn:aws:dynamodb:local:000000000000:table/t/stream/1"

const awsError = (name: string, message = name) => Object.assign(new Error(message), { name })

const seqOf = (n: number) => String(n).padStart(21, "0")

interface FakeShard {
  readonly id: string
  readonly parent: string | undefined
  readonly records: Array<_Record>
  closed: boolean
  /** Sequence numbers below this are trimmed. */
  trimmedBelow: number
}

class FakeStreams {
  readonly shards: Array<FakeShard> = []
  status: StreamStatus = "ENABLED"
  shardFilter: "supported" | "unsupported" | "ignored" = "supported"
  readonly log: Array<string> = []
  readonly iteratorRequests: Array<GetShardIteratorCommandInput> = []
  readonly describeRequests: Array<DescribeStreamCommandInput> = []
  /** Shards whose next `GetRecords` fails with `ExpiredIteratorException`. */
  readonly expireNext = new Set<string>()
  /** `GetRecords` calls to throttle (`LimitExceededException`) before serving. */
  throttle = 0
  /** `GetShardIterator` calls, per shard, to answer without an iterator. */
  readonly noIterator = new Map<string, number>()
  /** Full describes, per shard, that leave the shard out (an inconsistent describe). */
  readonly omitDescribes = new Map<string, number>()
  private omitting = new Set<string>()
  /** Delay of each `GetShardIterator` / `GetRecords`, and the most seen in flight. */
  readDelayMs = 0
  private inFlight = 0
  maxInFlight = 0
  /** Shards dropped from the stream when answered without an iterator. */
  readonly removeOnIterator = new Set<string>()
  private seq = 0

  addShard(id: string, parent?: string): this {
    this.shards.push({ id, parent, records: [], closed: false, trimmedBelow: 0 })
    return this
  }

  shard(id: string): FakeShard {
    const shard = this.shards.find((s) => s.id === id)
    if (shard === undefined) throw new Error(`no shard ${id}`)
    return shard
  }

  /** Append records to a shard — `images` are their `NewImage`s (default: a plain item). */
  put(shardId: string, count: number, image?: (i: number) => _Record["dynamodb"]): this {
    const shard = this.shard(shardId)
    for (let i = 0; i < count; i++) {
      this.seq++
      const SequenceNumber = seqOf(this.seq)
      shard.records.push({
        eventID: `e-${this.seq}`,
        eventName: "INSERT",
        dynamodb: {
          SequenceNumber,
          Keys: { pk: { S: `k-${this.seq}` } },
          NewImage: { pk: { S: `k-${this.seq}` } },
          ...image?.(this.seq),
        },
      })
    }
    return this
  }

  /** Drop a shard from the stream, as retention does 24 hours after it closes. */
  remove(shardId: string): this {
    this.shards.splice(this.shards.indexOf(this.shard(shardId)), 1)
    return this
  }

  close(shardId: string): this {
    this.shard(shardId).closed = true
    return this
  }

  private describeShard(shard: FakeShard): Shard {
    const first = shard.records[0]?.dynamodb?.SequenceNumber ?? seqOf(0)
    const last = shard.records[shard.records.length - 1]?.dynamodb?.SequenceNumber ?? first
    return {
      ShardId: shard.id,
      ...(shard.parent === undefined ? {} : { ParentShardId: shard.parent }),
      SequenceNumberRange: {
        StartingSequenceNumber: first,
        ...(shard.closed ? { EndingSequenceNumber: last } : {}),
      },
    }
  }

  async send(command: unknown): Promise<unknown> {
    if (
      this.readDelayMs > 0 &&
      (command instanceof GetShardIteratorCommand || command instanceof GetRecordsCommand)
    ) {
      this.inFlight++
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      await new Promise((resolve) => setTimeout(resolve, this.readDelayMs))
      this.inFlight--
    }
    if (command instanceof DescribeStreamCommand) {
      const input = command.input
      this.describeRequests.push(input)
      if (input.ShardFilter !== undefined) {
        this.log.push(`describe:filter:${input.ShardFilter.ShardId}`)
        if (this.shardFilter === "unsupported") {
          throw awsError("ValidationException", "ShardFilter is not supported")
        }
        const shards =
          this.shardFilter === "ignored"
            ? this.shards
            : this.shards.filter((s) => s.parent === input.ShardFilter?.ShardId)
        return {
          StreamDescription: {
            StreamStatus: this.status,
            Shards: shards.map((s) => this.describeShard(s)),
          },
        }
      }
      this.log.push("describe")
      if (input.ExclusiveStartShardId === undefined) {
        this.omitting = new Set()
        for (const [id, count] of this.omitDescribes) {
          if (count > 0) {
            this.omitting.add(id)
            this.omitDescribes.set(id, count - 1)
          }
        }
      }
      const visible = this.shards.filter((s) => !this.omitting.has(s.id))
      // Two shards a page, to exercise pagination.
      const from =
        input.ExclusiveStartShardId === undefined
          ? 0
          : visible.findIndex((s) => s.id === input.ExclusiveStartShardId) + 1
      const page = visible.slice(from, from + 2)
      const more = from + 2 < visible.length
      return {
        StreamDescription: {
          StreamArn: STREAM_ARN,
          StreamStatus: this.status,
          Shards: page.map((s) => this.describeShard(s)),
          ...(more ? { LastEvaluatedShardId: page[page.length - 1]!.id } : {}),
        },
      }
    }
    if (command instanceof GetShardIteratorCommand) {
      const input = command.input
      this.iteratorRequests.push(input)
      if (!this.shards.some((s) => s.id === input.ShardId)) {
        this.log.push(`iterator:${input.ShardId}:missing`)
        throw awsError("ResourceNotFoundException", `Shard ${input.ShardId} not found`)
      }
      const shard = this.shard(input.ShardId!)
      this.log.push(`iterator:${shard.id}:${input.ShardIteratorType}`)
      const misses = this.noIterator.get(shard.id) ?? 0
      if (misses > 0) {
        this.noIterator.set(shard.id, misses - 1)
        if (this.removeOnIterator.delete(shard.id)) this.remove(shard.id)
        return {}
      }
      const seq = input.SequenceNumber === undefined ? undefined : Number(input.SequenceNumber)
      if (seq !== undefined && seq < shard.trimmedBelow) {
        throw awsError("TrimmedDataAccessException")
      }
      const indexOf = (s: number) =>
        shard.records.findIndex((r) => Number(r.dynamodb!.SequenceNumber) >= s)
      let index: number
      switch (input.ShardIteratorType) {
        case "TRIM_HORIZON":
          index = 0
          break
        case "LATEST":
          index = shard.records.length
          break
        case "AT_SEQUENCE_NUMBER":
          index = indexOf(seq!)
          break
        default:
          index = indexOf(seq! + 1)
      }
      if (index === -1) index = shard.records.length
      return { ShardIterator: JSON.stringify({ shard: shard.id, index }) }
    }
    if (command instanceof GetRecordsCommand) {
      const input: GetRecordsCommandInput = command.input
      const { shard: shardId, index } = JSON.parse(input.ShardIterator!) as {
        shard: string
        index: number
      }
      if (this.throttle > 0) {
        this.throttle--
        this.log.push(`throttled:${shardId}`)
        throw awsError("LimitExceededException")
      }
      if (this.expireNext.delete(shardId)) {
        this.log.push(`expired:${shardId}`)
        throw awsError("ExpiredIteratorException")
      }
      const shard = this.shard(shardId)
      const records = shard.records.slice(index, index + (input.Limit ?? 1000))
      const next = index + records.length
      this.log.push(`records:${shardId}:${records.length}`)
      return {
        Records: records,
        ...(shard.closed && next >= shard.records.length
          ? {}
          : { NextShardIterator: JSON.stringify({ shard: shardId, index: next }) }),
      }
    }
    if (command instanceof ListStreamsCommand) {
      return { Streams: [{ StreamArn: STREAM_ARN }] }
    }
    throw new Error("unexpected command")
  }
}

const layerOf = (fake: FakeStreams, store: CheckpointStoreService = CheckpointStore.makeMemory()) =>
  Layer.mergeAll(
    Layer.succeed(DynamoStreamsClient, fromSdkClient(fake as unknown as DynamoDBStreamsClient)),
    Layer.succeed(CheckpointStore, store),
  )

const fast: Partial<ChangeFeedOptions> = {
  pollInterval: "5 millis",
  describeInterval: "20 millis",
  backoff: { initial: "1 millis", max: "5 millis" },
}

const sequencesOf = (batches: ReadonlyArray<ChangeFeedBatch>) =>
  batches.flatMap((b) => b.records.map((r) => Number(r.dynamodb!.SequenceNumber)))

/** Commit every batch, collecting them until the feed ends or `take` batches arrived. */
const collect = (options: ChangeFeedOptions, take?: number) => {
  const committed = changeFeed(options).pipe(
    Stream.mapEffect((batch) => Effect.as(batch.commit(), batch)),
  )
  return Stream.runCollect(take === undefined ? committed : Stream.take(committed, take))
}

const feedId = { streamArn: STREAM_ARN, consumer: "default" }

/** The typed failure of an exit, if any. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: unknown } | undefined)?.error
    : undefined

/** A store whose commits are recorded (`finished` for a `Finished` checkpoint). */
const recording = (store: CheckpointStoreService, fail?: (n: number) => boolean) => {
  const committed: Array<string> = []
  let n = 0
  const spy: CheckpointStoreService = {
    ...store,
    commit: (feed, shardId, checkpoint) =>
      Effect.suspend(() => {
        const label = checkpoint._tag === "Sequence" ? checkpoint.sequenceNumber : "finished"
        if (fail?.(++n) === true) {
          committed.push(`failed:${label}`)
          return Effect.fail(new CheckpointStoreError({ operation: "commit", cause: "blip" }))
        }
        committed.push(label)
        return store.commit(feed, shardId, checkpoint)
      }),
  }
  return { committed, spy }
}

/** Let the fake's promises settle (they run outside the test clock). */
const flush = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)))

/** Wait for the feed's own fibers to reach a point, however long that takes under load. */
const until = (reached: () => boolean) =>
  Effect.gen(function* () {
    while (!reached()) yield* Effect.sleep("1 millis")
  })

/** Advance the test clock, then let the fake's promises settle. */
const adjust = (duration: Duration.Input) =>
  TestClock.adjust(duration).pipe(Effect.andThen(flush), Effect.andThen(flush))

/**
 * A feed whose batches the test holds: unacknowledged, each stays in flight and its shard
 * waits, and the feed's failure still ends the fiber.
 */
const feedKeepingBatches = (
  options: ChangeFeedOptions,
  fake: FakeStreams,
  store: CheckpointStoreService,
) =>
  Effect.gen(function* () {
    const batches: Array<ChangeFeedBatch> = []
    const fiber = yield* changeFeed(options).pipe(
      Stream.runForEach((batch) =>
        Effect.sync(() => {
          batches.push(batch)
        }),
      ),
      Effect.provide(layerOf(fake, store)),
      Effect.forkChild,
    )
    return { batches, fiber }
  })

/**
 * Let the feed's fibers and the fake's promises run until `reached` holds, in real time and
 * with the test clock standing still, however long that takes under load. It gives up
 * eventually, for the assertion after it to report.
 */
const settle = (reached: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && !reached(); i++) yield* flush
  })

const blip = (operation: string) => new CheckpointStoreError({ operation, cause: "blip" })

const heldLease = { owner: "me", duration: "30 seconds", renewEvery: "10 seconds" } as const

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("changeFeed", () => {
  it.live("reads every shard to its end and ends once the stream is disabled", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams()
        .addShard("s1")
        .addShard("s2")
        .addShard("s3")
        .put("s1", 3)
        .put("s2", 2)
        .put("s3", 1)
      fake.close("s1").close("s2").close("s3").status = "DISABLED"
      const store = CheckpointStore.makeMemory()
      const batches = yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
        Effect.provide(layerOf(fake, store)),
      )
      expect(sequencesOf(batches).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
      for (const b of batches) expect(b.streamArn).toBe(STREAM_ARN)
      // Pagination: three shards over two describe pages.
      expect(fake.describeRequests.some((r) => r.ExclusiveStartShardId === "s2")).toBe(true)
      const checkpoints = yield* store.load(feedId)
      expect([...checkpoints.entries()].sort()).toEqual([
        ["s1", { _tag: "Finished" }],
        ["s2", { _tag: "Finished" }],
        ["s3", { _tag: "Finished" }],
      ])
    }),
  )

  it.live("batches carry the shard id and their sequence range, at most batchSize records", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams().addShard("s1").put("s1", 5).close("s1")
      fake.status = "DISABLED"
      const batches = yield* collect({ streamArn: STREAM_ARN, batchSize: 2, ...fast }).pipe(
        Effect.provide(layerOf(fake)),
      )
      expect(batches.map((b) => [b.shardId, b.firstSequenceNumber, b.lastSequenceNumber])).toEqual([
        ["s1", seqOf(1), seqOf(2)],
        ["s1", seqOf(3), seqOf(4)],
        ["s1", seqOf(5), seqOf(5)],
      ])
      for (const request of fake.log.filter((l) => l.startsWith("records:"))) {
        expect(Number(request.split(":")[2])).toBeLessThanOrEqual(2)
      }
    }),
  )

  it.live("reads a parent to its end, acknowledged, before its children", () =>
    Effect.gen(function* () {
      // A split: p closed with three records; c1 and c2 its open children.
      const fake = new FakeStreams()
        .addShard("p")
        .addShard("c1", "p")
        .addShard("c2", "p")
        .put("p", 3)
        .put("c1", 2)
        .put("c2", 2)
        .close("p")
      const order: Array<string> = []
      const batches = yield* changeFeed({ streamArn: STREAM_ARN, batchSize: 1, ...fast }).pipe(
        Stream.mapEffect((batch) =>
          Effect.gen(function* () {
            // A slow consumer of the parent: its children must still wait.
            if (batch.shardId === "p") yield* Effect.sleep("10 millis")
            order.push(`${batch.shardId}:${Number(batch.firstSequenceNumber)}`)
            yield* batch.commit()
            return batch
          }),
        ),
        Stream.take(7),
        Stream.runCollect,
        Effect.provide(layerOf(fake)),
      )
      expect(batches).toHaveLength(7)
      expect(order.slice(0, 3)).toEqual(["p:1", "p:2", "p:3"])
      const firstChildIterator = fake.log.findIndex((l) => l.startsWith("iterator:c"))
      const lastParentRead = fake.log.lastIndexOf("records:p:0")
      expect(firstChildIterator).toBeGreaterThan(lastParentRead)
      // Each child's records in order.
      expect(order.filter((o) => o.startsWith("c1"))).toEqual(["c1:4", "c1:5"])
      expect(order.filter((o) => o.startsWith("c2"))).toEqual(["c2:6", "c2:7"])
      // The parent's children were looked up with ShardFilter.
      expect(fake.log).toContain("describe:filter:p")
    }),
  )

  it.live(
    "finds a drained shard's children with a full describe where ShardFilter is unsupported",
    () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("p").put("p", 1)
        fake.shardFilter = "unsupported"
        const run = yield* collect(
          { streamArn: STREAM_ARN, ...fast, describeInterval: "1 hour" },
          3,
        ).pipe(Effect.provide(layerOf(fake)), Effect.forkChild)
        // The parent closes after the first describe; its child (and grandchild) appear then.
        yield* until(() => fake.log.some((line) => line.startsWith("records:p")))
        fake.addShard("c", "p").put("c", 1).addShard("g", "c").put("g", 1)
        fake.close("p").close("c")
        const batches = yield* Fiber.join(run)
        expect(batches.map((b) => b.shardId)).toEqual(["p", "c", "g"])
        // One filtered describe failed; later lookups go straight to a full describe.
        expect(fake.log.filter((l) => l.startsWith("describe:filter"))).toEqual([
          "describe:filter:p",
        ])
        expect(fake.log.filter((l) => l === "describe").length).toBeGreaterThanOrEqual(3)
      }),
  )

  it.live("keeps only the parent's children when a store ignores ShardFilter", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams()
        .addShard("p")
        .addShard("other")
        .addShard("c", "p")
        .put("p", 1)
        .put("c", 1)
        .close("p")
      fake.shardFilter = "ignored"
      const batches = yield* collect({ streamArn: STREAM_ARN, ...fast }, 2).pipe(
        Effect.provide(layerOf(fake)),
      )
      expect(batches.map((b) => b.shardId).sort()).toEqual(["c", "p"])
    }),
  )

  it.live("resumes after a checkpoint and skips finished shards", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams()
        .addShard("done")
        .addShard("s1")
        .put("done", 2)
        .put("s1", 4)
        .close("done")
        .close("s1")
      fake.status = "DISABLED"
      const store = CheckpointStore.makeMemory()
      yield* store.commit(feedId, "done", { _tag: "Finished" })
      yield* store.commit(feedId, "s1", { _tag: "Sequence", sequenceNumber: seqOf(4) })
      const batches = yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
        Effect.provide(layerOf(fake, store)),
      )
      expect(sequencesOf(batches)).toEqual([5, 6])
      expect(
        fake.iteratorRequests.map((r) => [r.ShardId, r.ShardIteratorType, r.SequenceNumber]),
      ).toEqual([["s1", "AFTER_SEQUENCE_NUMBER", seqOf(4)]])
    }),
  )

  it.live("keeps checkpoints per consumer", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams().addShard("s1").put("s1", 2).close("s1")
      fake.status = "DISABLED"
      const store = CheckpointStore.makeMemory()
      yield* collect({ streamArn: STREAM_ARN, consumer: "a", ...fast }).pipe(
        Effect.provide(layerOf(fake, store)),
      )
      const again = yield* collect({ streamArn: STREAM_ARN, consumer: "b", ...fast }).pipe(
        Effect.provide(layerOf(fake, store)),
      )
      expect(sequencesOf(again)).toEqual([1, 2])
      expect((yield* store.load({ streamArn: STREAM_ARN, consumer: "a" })).get("s1")).toEqual({
        _tag: "Finished",
      })
    }),
  )

  it.live("starts open shards at LATEST on a fresh start, and skips closed ones", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams()
        .addShard("old")
        .addShard("s1", "old")
        .put("old", 2)
        .put("s1", 2)
        .close("old")
      const store = CheckpointStore.makeMemory()
      const run = yield* collect(
        { streamArn: STREAM_ARN, startingPosition: "LATEST", ...fast },
        1,
      ).pipe(Effect.provide(layerOf(fake, store)), Effect.forkChild)
      yield* until(() => fake.iteratorRequests.length > 0)
      fake.put("s1", 1)
      const batches = yield* Fiber.join(run)
      expect(sequencesOf(batches)).toEqual([5])
      expect(fake.iteratorRequests.map((r) => [r.ShardId, r.ShardIteratorType])).toEqual([
        ["s1", "LATEST"],
      ])
      expect((yield* store.load(feedId)).get("old")).toEqual({ _tag: "Finished" })
    }),
  )

  it.live("re-acquires an expired iterator after the last acknowledged record", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams().addShard("s1").put("s1", 4).close("s1")
      fake.status = "DISABLED"
      let first = true
      const batches = yield* changeFeed({ streamArn: STREAM_ARN, batchSize: 2, ...fast }).pipe(
        Stream.mapEffect((batch) =>
          Effect.gen(function* () {
            // The consumer is slow: the next iterator expires meanwhile.
            if (first) fake.expireNext.add("s1")
            first = false
            yield* batch.commit()
            return batch
          }),
        ),
        Stream.runCollect,
        Effect.provide(layerOf(fake)),
      )
      expect(sequencesOf(batches)).toEqual([1, 2, 3, 4])
      expect(fake.log).toContain("expired:s1")
      expect(fake.iteratorRequests.map((r) => [r.ShardIteratorType, r.SequenceNumber])).toEqual([
        ["TRIM_HORIZON", undefined],
        ["AFTER_SEQUENCE_NUMBER", seqOf(2)],
      ])
    }),
  )

  it.live("fails with ChangeFeedTrimmed when a checkpoint is past retention", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams().addShard("s1").put("s1", 5)
      fake.shard("s1").trimmedBelow = 4
      const store = CheckpointStore.makeMemory()
      yield* store.commit(feedId, "s1", { _tag: "Sequence", sequenceNumber: seqOf(2) })
      const exit = yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
        Effect.provide(layerOf(fake, store)),
        Effect.exit,
      )
      expect(exit).toStrictEqual(Exit.fail(expect.anything()))
      const error = Exit.isFailure(exit)
        ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: unknown } | undefined)
            ?.error
        : undefined
      expect(error).toMatchObject({
        _tag: "ChangeFeedTrimmed",
        streamArn: STREAM_ARN,
        shardId: "s1",
        sequenceNumber: seqOf(2),
      })
    }),
  )

  describe("partial failures", () => {
    const failing = (failed: (batch: ChangeFeedBatch) => ReadonlyArray<string>) => {
      const seen: Array<Array<number>> = []
      let attempts = 0
      const feed = changeFeed({ streamArn: STREAM_ARN, ...fast }).pipe(
        Stream.mapEffect((batch) =>
          Effect.gen(function* () {
            seen.push(batch.records.map((r) => Number(r.dynamodb!.SequenceNumber)))
            attempts++
            const ids = attempts === 1 ? failed(batch) : []
            yield* batch.complete({
              batchItemFailures: ids.map((itemIdentifier) => ({ itemIdentifier })),
            })
            return batch
          }),
        ),
      )
      return { seen, feed }
    }

    it.live("checkpoints before the earliest failed record and re-reads from it", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 5).close("s1")
        fake.status = "DISABLED"
        const store = CheckpointStore.makeMemory()
        const { seen, feed } = failing((batch) => [
          batch.records[3]!.dynamodb!.SequenceNumber!,
          batch.records[2]!.dynamodb!.SequenceNumber!,
        ])
        const committed: Array<string> = []
        const spy: CheckpointStoreService = {
          ...store,
          commit: (feed, shardId, checkpoint) => {
            committed.push(checkpoint._tag === "Sequence" ? checkpoint.sequenceNumber : "finished")
            return store.commit(feed, shardId, checkpoint)
          },
        }
        yield* Stream.runDrain(feed).pipe(Effect.provide(layerOf(fake, spy)))
        expect(seen).toEqual([
          [1, 2, 3, 4, 5],
          [3, 4, 5],
        ])
        expect(committed).toEqual([seqOf(2), seqOf(5), "finished"])
        expect(fake.iteratorRequests.map((r) => [r.ShardIteratorType, r.SequenceNumber])).toEqual([
          ["TRIM_HORIZON", undefined],
          ["AT_SEQUENCE_NUMBER", seqOf(3)],
        ])
      }),
    )

    it.live("leaves the checkpoint when the first record failed", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 3).close("s1")
        fake.status = "DISABLED"
        const store = CheckpointStore.makeMemory()
        yield* store.commit(feedId, "s1", { _tag: "Sequence", sequenceNumber: seqOf(0) })
        const { seen, feed } = failing((batch) => [batch.firstSequenceNumber])
        const committed: Array<string> = []
        const spy: CheckpointStoreService = {
          ...store,
          commit: (feed, shardId, checkpoint) => {
            committed.push(checkpoint._tag === "Sequence" ? checkpoint.sequenceNumber : "finished")
            return store.commit(feed, shardId, checkpoint)
          },
        }
        yield* Stream.runDrain(feed).pipe(Effect.provide(layerOf(fake, spy)))
        expect(seen).toEqual([
          [1, 2, 3],
          [1, 2, 3],
        ])
        expect(committed).toEqual([seqOf(3), "finished"])
      }),
    )

    it.live("re-reads the whole batch for an identifier that names no record", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 2).close("s1")
        fake.status = "DISABLED"
        const { seen, feed } = failing(() => ["not-a-sequence-number"])
        yield* Stream.runDrain(feed).pipe(Effect.provide(layerOf(fake)))
        expect(seen).toEqual([
          [1, 2],
          [1, 2],
        ])
      }),
    )

    it.live("re-reads the whole batch when any identifier names no record", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 5).close("s1")
        fake.status = "DISABLED"
        const { committed, spy } = recording(CheckpointStore.makeMemory())
        const { seen, feed } = failing((batch) => [
          "bogus",
          batch.records[3]!.dynamodb!.SequenceNumber!,
          batch.records[2]!.dynamodb!.SequenceNumber!,
        ])
        yield* Stream.runDrain(feed).pipe(Effect.provide(layerOf(fake, spy)))
        expect(seen).toEqual([
          [1, 2, 3, 4, 5],
          [1, 2, 3, 4, 5],
        ])
        // The checkpoint never moved to 2.
        expect(committed).toEqual([seqOf(5), "finished"])
      }),
    )

    it.live("only the first acknowledgement of a batch counts", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 2).close("s1")
        fake.status = "DISABLED"
        const batches = yield* changeFeed({ streamArn: STREAM_ARN, ...fast }).pipe(
          Stream.mapEffect((batch) =>
            batch.commit().pipe(
              Effect.andThen(
                batch.complete({
                  batchItemFailures: [{ itemIdentifier: batch.firstSequenceNumber }],
                }),
              ),
              Effect.as(batch),
            ),
          ),
          Stream.runCollect,
          Effect.provide(layerOf(fake)),
        )
        expect(sequencesOf(batches)).toEqual([1, 2])
      }),
    )
  })

  describe("acknowledgement failures", () => {
    it.live("a commit whose write failed writes again when retried", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 2).close("s1")
        fake.status = "DISABLED"
        const store = CheckpointStore.makeMemory()
        const { committed, spy } = recording(store, (n) => n === 1)
        const errors: Array<string> = []
        const batches = yield* changeFeed({ streamArn: STREAM_ARN, batchSize: 1, ...fast }).pipe(
          Stream.mapEffect((batch) =>
            batch.commit().pipe(
              Effect.tapError((e) => Effect.sync(() => errors.push(e._tag))),
              Effect.retry({ times: 2 }),
              Effect.as(batch),
            ),
          ),
          Stream.runCollect,
          Effect.provide(layerOf(fake, spy)),
        )
        expect(errors).toEqual(["CheckpointStoreError"])
        expect(sequencesOf(batches)).toEqual([1, 2])
        expect(committed).toEqual([`failed:${seqOf(1)}`, seqOf(1), seqOf(2), "finished"])
        expect((yield* store.load(feedId)).get("s1")).toEqual({ _tag: "Finished" })
      }),
    )

    it.live(
      "a failed complete() writes again when retried, then later acknowledgements are no-ops",
      () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1").put("s1", 3).close("s1")
          fake.status = "DISABLED"
          const store = CheckpointStore.makeMemory()
          const { committed, spy } = recording(store, (n) => n === 1)
          let first = true
          const seen: Array<Array<number>> = []
          yield* changeFeed({ streamArn: STREAM_ARN, ...fast }).pipe(
            Stream.mapEffect((batch) =>
              Effect.gen(function* () {
                seen.push(batch.records.map((r) => Number(r.dynamodb!.SequenceNumber)))
                if (!first) return yield* batch.commit()
                first = false
                const response = {
                  batchItemFailures: [
                    { itemIdentifier: batch.records[2]!.dynamodb!.SequenceNumber! },
                  ],
                }
                yield* batch.complete(response).pipe(Effect.retry({ times: 1 }))
                // Settled: a later acknowledgement writes nothing.
                yield* batch.commit()
              }),
            ),
            Stream.runDrain,
            Effect.provide(layerOf(fake, spy)),
          )
          expect(seen).toEqual([[1, 2, 3], [3]])
          expect(committed).toEqual([`failed:${seqOf(2)}`, seqOf(2), seqOf(3), "finished"])
        }),
    )

    it.live("a failed commit that is not retried fails the feed instead of hanging", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 2)
        const { spy } = recording(CheckpointStore.makeMemory(), () => true)
        const exit = yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
          Effect.provide(layerOf(fake, spy)),
          Effect.exit,
        )
        expect(failureOf(exit)).toMatchObject({ _tag: "CheckpointStoreError" })
      }),
    )
  })

  describe("trimmed lineage at startup", () => {
    it.live("fails when a checkpointed shard has left the stream", () =>
      Effect.gen(function* () {
        // p was being read; downtime past retention dropped it, leaving c.
        const fake = new FakeStreams().addShard("p").addShard("c", "p").put("p", 3).put("c", 2)
        fake.close("p").remove("p")
        const store = CheckpointStore.makeMemory()
        yield* store.commit(feedId, "p", { _tag: "Sequence", sequenceNumber: seqOf(1) })
        const exit = yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
          Effect.provide(layerOf(fake, store)),
          Effect.exit,
        )
        expect(failureOf(exit)).toMatchObject({
          _tag: "ChangeFeedTrimmed",
          shardId: "p",
          sequenceNumber: seqOf(1),
        })
        // Only a probe of p, confirming it is gone; nothing was read.
        expect(fake.log.filter((l) => l.startsWith("iterator:"))).toEqual(["iterator:p:missing"])
      }),
    )

    it.live("fails when an unread shard's parent has left the stream unfinished", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams()
          .addShard("other")
          .addShard("p")
          .addShard("c", "p")
          .put("p", 1)
          .put("c", 1)
        fake.close("p").remove("p")
        const store = CheckpointStore.makeMemory()
        // The consumer has checkpoints, but none for p or c.
        yield* store.commit(feedId, "other", { _tag: "Finished" })
        const exit = yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
          Effect.provide(layerOf(fake, store)),
          Effect.exit,
        )
        expect(failureOf(exit)).toMatchObject({
          _tag: "ChangeFeedTrimmed",
          shardId: "p",
          sequenceNumber: undefined,
        })
      }),
    )

    it.live("a fresh consumer owes nothing to parents already gone, and remembers so", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("p").addShard("c", "p").put("p", 1).put("c", 2)
        fake.close("p").remove("p")
        const store = CheckpointStore.makeMemory()
        const first = yield* collect({ streamArn: STREAM_ARN, ...fast }, 1).pipe(
          Effect.provide(layerOf(fake, store)),
        )
        expect(sequencesOf(first)).toEqual([2, 3])
        expect((yield* store.load(feedId)).get("p")).toEqual({ _tag: "Finished" })
        // A restart is not mistaken for lost records.
        fake.put("c", 1)
        const again = yield* collect({ streamArn: STREAM_ARN, ...fast }, 1).pipe(
          Effect.provide(layerOf(fake, store)),
        )
        expect(sequencesOf(again)).toEqual([4])
      }),
    )

    it.live("a parent finished before it left the stream is fine", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("p").addShard("c", "p").put("p", 1).put("c", 1)
        fake.close("p").remove("p")
        const store = CheckpointStore.makeMemory()
        yield* store.commit(feedId, "p", { _tag: "Finished" })
        const batches = yield* collect({ streamArn: STREAM_ARN, ...fast }, 1).pipe(
          Effect.provide(layerOf(fake, store)),
        )
        expect(sequencesOf(batches)).toEqual([2])
      }),
    )
  })

  describe("shards a describe omits", () => {
    const fullDescribes = (fake: FakeStreams) =>
      fake.describeRequests.filter(
        (r) => r.ShardFilter === undefined && r.ExclusiveStartShardId === undefined,
      ).length

    it.live("a fresh start describes again before treating a missing parent as gone", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("p").addShard("c", "p").put("p", 2).put("c", 1)
        fake.close("p")
        fake.omitDescribes.set("p", 1)
        const store = CheckpointStore.makeMemory()
        const { committed, spy } = recording(store)
        const batches = yield* collect({ streamArn: STREAM_ARN, ...fast }, 2).pipe(
          Effect.provide(layerOf(fake, spy)),
        )
        expect(batches.map((b) => b.shardId)).toEqual(["p", "c"])
        expect(sequencesOf(batches)).toEqual([1, 2, 3])
        // p was read, not written off.
        expect(committed.slice(0, 2)).toEqual([seqOf(2), "finished"])
      }),
    )

    it.live("a parent missing from two describes is probed, and read first when it exists", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("p").addShard("c", "p").put("p", 2).put("c", 1)
        fake.close("p")
        fake.omitDescribes.set("p", 5)
        const store = CheckpointStore.makeMemory()
        const batches = yield* collect({ streamArn: STREAM_ARN, ...fast }, 2).pipe(
          Effect.provide(layerOf(fake, store)),
        )
        expect(batches.map((b) => b.shardId)).toEqual(["p", "c"])
        expect(sequencesOf(batches)).toEqual([1, 2, 3])
        // The probe of p's trim horizon, then its read.
        expect(
          fake.iteratorRequests.slice(0, 2).map((r) => [r.ShardId, r.ShardIteratorType]),
        ).toEqual([
          ["p", "TRIM_HORIZON"],
          ["p", "TRIM_HORIZON"],
        ])
      }),
    )

    it.live("a restart reads a checkpointed shard a describe omits, without a trimmed error", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 3)
        fake.omitDescribes.set("s1", 2)
        const store = CheckpointStore.makeMemory()
        yield* store.commit(feedId, "s1", { _tag: "Sequence", sequenceNumber: seqOf(1) })
        const batches = yield* collect({ streamArn: STREAM_ARN, ...fast }, 1).pipe(
          Effect.provide(layerOf(fake, store)),
        )
        expect(sequencesOf(batches)).toEqual([2, 3])
      }),
    )

    it.live("drained shards without children share describes", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams()
        for (let i = 1; i <= 8; i++) fake.addShard(`s${i}`).put(`s${i}`, 1).close(`s${i}`)
        fake.status = "DISABLED"
        // Children are looked up with ShardFilter (finding none), then by describe.
        const batches = yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
          Effect.provide(layerOf(fake)),
        )
        expect(batches).toHaveLength(8)
        // One per drained shard, but the feed ends once they're all drained: the last
        // lookups can lose that race.
        const lookups = fake.log.filter((l) => l.startsWith("describe:filter"))
        expect(lookups.length).toBeGreaterThan(0)
        expect(lookups.length).toBeLessThanOrEqual(8)
        // The initial describe plus shared ones — not one per drained shard.
        expect(fullDescribes(fake)).toBeLessThanOrEqual(3)
      }),
    )
  })

  describe("read concurrency", () => {
    it.live("bounds the shard reads in flight without starving any shard", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams()
        for (let i = 1; i <= 8; i++) fake.addShard(`s${i}`).put(`s${i}`, 1)
        fake.readDelayMs = 5
        const batches = yield* collect(
          { streamArn: STREAM_ARN, ...fast, maxConcurrentReads: 2 },
          8,
        ).pipe(Effect.provide(layerOf(fake)))
        expect(new Set(batches.map((b) => b.shardId)).size).toBe(8)
        expect(fake.maxInFlight).toBe(2)
      }),
    )

    it.live("reads 16 shards at once by default", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams()
        for (let i = 1; i <= 24; i++) fake.addShard(`s${i}`).put(`s${i}`, 1)
        fake.readDelayMs = 20
        yield* collect({ streamArn: STREAM_ARN, ...fast }, 24).pipe(Effect.provide(layerOf(fake)))
        expect(fake.maxInFlight).toBe(16)
      }),
    )
  })

  describe("option validation", () => {
    const attempt = (options: Partial<ChangeFeedOptions>) => () =>
      changeFeed({ streamArn: STREAM_ARN, ...options })

    it("refuses a renewal interval of half the lease or more", () => {
      expect(attempt({ lease: { duration: "30 seconds", renewEvery: "15 seconds" } })).toThrow(
        /\[EDD-9083\].*renewEvery \(15000 ms\) must be less than half of lease\.duration \(30000 ms\)/,
      )
      expect(attempt({ lease: { duration: "30 seconds", renewEvery: "20 seconds" } })).toThrow(
        /EDD-9083/,
      )
      expect(attempt({ lease: { duration: "10 seconds" } })).not.toThrow()
      expect(attempt({ lease: { duration: "30 seconds", renewEvery: "14 seconds" } })).not.toThrow()
      expect(attempt({ lease: false })).not.toThrow()
    })

    it("refuses a non-positive read bound and an out-of-range batch size", () => {
      expect(attempt({ maxConcurrentReads: 0 })).toThrow(/EDD-9083.*maxConcurrentReads/)
      expect(attempt({ maxConcurrentReads: 1.5 })).toThrow(/EDD-9083/)
      expect(attempt({ batchSize: 1001 })).toThrow(/EDD-9083.*batchSize/)
      expect(attempt({ batchSize: 0 })).toThrow(/EDD-9083/)
      expect(attempt({ batchSize: 1000, maxConcurrentReads: 1 })).not.toThrow()
    })
  })

  describe("missing iterators", () => {
    it.live("an open shard without an iterator is retried, not finished", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 1)
        fake.noIterator.set("s1", 3)
        const store = CheckpointStore.makeMemory()
        const batches = yield* collect({ streamArn: STREAM_ARN, ...fast }, 1).pipe(
          Effect.provide(layerOf(fake, store)),
        )
        expect(sequencesOf(batches)).toEqual([1])
        expect(fake.iteratorRequests).toHaveLength(4)
        expect((yield* store.load(feedId)).get("s1")).toEqual({
          _tag: "Sequence",
          sequenceNumber: seqOf(1),
        })
      }),
    )

    it.live("a closed shard without an iterator is finished", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").close("s1")
        fake.status = "DISABLED"
        fake.noIterator.set("s1", 1)
        const store = CheckpointStore.makeMemory()
        yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
          Effect.provide(layerOf(fake, store)),
        )
        expect(fake.iteratorRequests).toHaveLength(1)
        expect((yield* store.load(feedId)).get("s1")).toEqual({ _tag: "Finished" })
      }),
    )

    it.live("a shard gone from the stream without an iterator is trimmed", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 1)
        fake.noIterator.set("s1", 1)
        // Dropped from the stream as its iterator is requested.
        fake.removeOnIterator.add("s1")
        const exit = yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
          Effect.provide(layerOf(fake)),
          Effect.exit,
        )
        expect(failureOf(exit)).toMatchObject({ _tag: "ChangeFeedTrimmed", shardId: "s1" })
      }),
    )
  })

  describe("lease", () => {
    it.live("fails with ChangeFeedLeaseHeld while another process holds it", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 1)
        const store = CheckpointStore.makeMemory()
        yield* store.acquireLease(feedId, "other", Duration.seconds(30))
        const exit = yield* collect({ streamArn: STREAM_ARN, ...fast }).pipe(
          Effect.provide(layerOf(fake, store)),
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit)
          ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: unknown } | undefined)
              ?.error
          : undefined
        expect(error).toMatchObject({ _tag: "ChangeFeedLeaseHeld", owner: "other" })
        expect(fake.log).toEqual([])
      }),
    )

    it.live("takes over an expired lease, and releases it when the feed ends", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 1).close("s1")
        fake.status = "DISABLED"
        const store = CheckpointStore.makeMemory()
        yield* store.acquireLease(feedId, "crashed", Duration.millis(10))
        yield* Effect.sleep("20 millis")
        const batches = yield* collect({
          streamArn: STREAM_ARN,
          ...fast,
          lease: { owner: "me" },
        }).pipe(Effect.provide(layerOf(fake, store)))
        expect(sequencesOf(batches)).toEqual([1])
        // Released: anyone can take it now.
        yield* store.acquireLease(feedId, "next", Duration.seconds(30))
      }),
    )

    it.live('waits for a held lease with onHeld: "wait"', () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 1).close("s1")
        fake.status = "DISABLED"
        const store = CheckpointStore.makeMemory()
        yield* store.acquireLease(feedId, "other", Duration.seconds(30))
        const run = yield* collect({
          streamArn: STREAM_ARN,
          ...fast,
          lease: { onHeld: "wait", renewEvery: "5 millis" },
        }).pipe(Effect.provide(layerOf(fake, store)), Effect.forkChild)
        yield* Effect.sleep("20 millis")
        expect(fake.log).toEqual([])
        yield* store.releaseLease(feedId, "other")
        const batches = yield* Fiber.join(run)
        expect(sequencesOf(batches)).toEqual([1])
      }),
    )

    it.live("fails with ChangeFeedLeaseLost when another process takes the lease", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 1)
        const store = CheckpointStore.makeMemory()
        const run = yield* collect({
          streamArn: STREAM_ARN,
          ...fast,
          lease: { owner: "me", duration: "30 seconds", renewEvery: "20 millis" },
        }).pipe(Effect.provide(layerOf(fake, store)), Effect.exit, Effect.forkChild)
        // Another process takes the lease over; the next renewal finds it lost.
        yield* until(() => fake.log.length > 0)
        yield* store.releaseLease(feedId, "me")
        yield* store.acquireLease(feedId, "other", Duration.seconds(30))
        const exit = yield* Fiber.join(run)
        const error = Exit.isFailure(exit)
          ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: unknown } | undefined)
              ?.error
          : undefined
        expect(error).toMatchObject({ _tag: "ChangeFeedLeaseLost", owner: "me" })
      }),
    )

    it.live("retries a renewal the store failed to write", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 1)
        const store = CheckpointStore.makeMemory()
        let renewals = 0
        const renewedAfterTheFailure = yield* Deferred.make<void>()
        const flaky: CheckpointStoreService = {
          ...store,
          renewLease: (feed, owner, duration) =>
            Effect.suspend(() => {
              const attempt = ++renewals
              if (attempt === 1) {
                return Effect.fail(
                  new CheckpointStoreError({ operation: "renewLease", cause: "blip" }),
                )
              }
              return store
                .renewLease(feed, owner, duration)
                .pipe(
                  Effect.tap(() =>
                    attempt > 2 ? Deferred.succeed(renewedAfterTheFailure, undefined) : Effect.void,
                  ),
                )
            }),
        }
        const fiber = yield* collect({
          streamArn: STREAM_ARN,
          ...fast,
          // Long enough that a stalled process can't reach the renewal deadline.
          lease: { duration: "1 hour", renewEvery: "10 millis" },
        }).pipe(Effect.provide(layerOf(fake, flaky)), Effect.exit, Effect.forkChild)
        yield* Deferred.await(renewedAfterTheFailure)
        expect(renewals).toBeGreaterThan(2)
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(fiber)
      }),
    )

    it.effect("retries a failing renewal until the lease is about to lapse", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1")
        const store = CheckpointStore.makeMemory()
        let failing = true
        let attempts = 0
        const flaky: CheckpointStoreService = {
          ...store,
          renewLease: (feed, owner, duration) =>
            Effect.suspend(() => {
              attempts++
              return failing
                ? Effect.fail(new CheckpointStoreError({ operation: "renewLease", cause: "blip" }))
                : store.renewLease(feed, owner, duration)
            }),
        }
        const fiber = yield* collect({
          streamArn: STREAM_ARN,
          backoff: { initial: "100 millis", max: "1 second" },
          lease: { duration: "30 seconds", renewEvery: "10 seconds" },
        }).pipe(Effect.provide(layerOf(fake, flaky)), Effect.exit, Effect.forkChild)
        // Renewals fail from 10 s on; the deadline is 30 - 10 = 20 s after acquiring.
        for (let i = 0; i < 18; i++) yield* adjust("1 second")
        expect(attempts).toBeGreaterThan(5)
        expect(fiber.pollUnsafe()).toBeUndefined()
        failing = false
        yield* adjust("1 second")
        // Renewed at about 19 s: the next deadline is 20 s after that.
        for (let i = 0; i < 15; i++) yield* adjust("1 second")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(fiber)
      }),
    )

    it.effect("fails once renewals have failed up to the deadline", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1")
        const store = CheckpointStore.makeMemory()
        const flaky: CheckpointStoreService = {
          ...store,
          renewLease: () =>
            Effect.fail(new CheckpointStoreError({ operation: "renewLease", cause: "blip" })),
        }
        const fiber = yield* collect({
          streamArn: STREAM_ARN,
          backoff: { initial: "100 millis", max: "1 second" },
          lease: { duration: "30 seconds", renewEvery: "10 seconds" },
        }).pipe(Effect.provide(layerOf(fake, flaky)), Effect.forkChild)
        for (let i = 0; i < 19; i++) yield* adjust("1 second")
        expect(fiber.pollUnsafe()).toBeUndefined()
        for (let i = 0; i < 3; i++) yield* adjust("1 second")
        const exit = fiber.pollUnsafe()
        expect(exit).toBeDefined()
        expect(failureOf(exit!)).toMatchObject({ _tag: "CheckpointStoreError" })
      }),
    )

    describe("deadlines", () => {
      const backoff = { initial: "100 millis", max: "1 second" } as const
      const options = { streamArn: STREAM_ARN, backoff, lease: heldLease }
      const ended = (fiber: Fiber.Fiber<unknown, unknown>) => () => fiber.pollUnsafe() !== undefined

      for (const [kind, hung] of [
        ["never returns", Effect.never],
        ["never returns and can't be interrupted", Effect.uninterruptible(Effect.never)],
      ] as const) {
        it.effect(`a renewal that ${kind} loses the lease at the deadline`, () =>
          Effect.gen(function* () {
            const fake = new FakeStreams().addShard("s1").put("s1", 1)
            const store = CheckpointStore.makeMemory()
            const { batches, fiber } = yield* feedKeepingBatches(options, fake, {
              ...store,
              renewLease: () => hung,
            })
            yield* settle(() => batches.length === 1)
            // The renewal starts at 10 s; the deadline is 30 - 10 = 20 s after acquiring.
            yield* TestClock.adjust("19 seconds")
            yield* flush
            expect(fiber.pollUnsafe()).toBeUndefined()
            yield* TestClock.adjust("1 second")
            yield* settle(ended(fiber))
            expect(failureOf(fiber.pollUnsafe()!)).toMatchObject({
              _tag: "ChangeFeedLeaseLost",
              owner: "me",
            })
            // The batch still in flight can't commit, and the lease is released.
            const refused = yield* Effect.flip(batches[0]!.commit())
            expect(refused).toMatchObject({ _tag: "ChangeFeedLeaseLost", owner: "me" })
            expect((yield* store.load(feedId)).size).toBe(0)
            yield* store.acquireLease(feedId, "next", Duration.seconds(30))
          }),
        )
      }

      it.effect("a renewal that hangs after failing loses the lease at the same deadline", () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1")
          const store = CheckpointStore.makeMemory()
          let attempts = 0
          const { fiber } = yield* feedKeepingBatches(options, fake, {
            ...store,
            renewLease: () =>
              Effect.suspend(() => (++attempts >= 3 ? Effect.never : Effect.fail(blip("renew")))),
          })
          yield* settle(() => fake.log.length > 0)
          yield* TestClock.adjust("19 seconds")
          yield* settle(() => attempts >= 3)
          expect(attempts).toBeGreaterThanOrEqual(3)
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust("1 second")
          yield* settle(ended(fiber))
          expect(failureOf(fiber.pollUnsafe()!)).toMatchObject({ _tag: "ChangeFeedLeaseLost" })
        }),
      )

      it.effect("the last retry reaches the store whatever the backoff's jitter", () =>
        Effect.gen(function* () {
          for (let seed = 0; seed < 6; seed++) {
            const fake = new FakeStreams().addShard("s1")
            const store = CheckpointStore.makeMemory()
            const { fiber } = yield* feedKeepingBatches(options, fake, {
              ...store,
              renewLease: () => Effect.fail(blip("renew")),
            }).pipe(Random.withSeed(seed))
            yield* settle(() => fake.log.length > 0)
            yield* TestClock.adjust("20 seconds")
            yield* settle(ended(fiber))
            expect(failureOf(fiber.pollUnsafe()!), `seed ${seed}`).toMatchObject({
              _tag: "CheckpointStoreError",
            })
          }
        }),
      )

      it.effect("renewals keep their schedule when each call is slow", () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1")
          const store = CheckpointStore.makeMemory()
          const startedAt: Array<number> = []
          const { fiber } = yield* feedKeepingBatches(options, fake, {
            ...store,
            renewLease: (feed, owner, duration) =>
              Clock.currentTimeMillis.pipe(
                Effect.tap((now) => Effect.sync(() => startedAt.push(now))),
                Effect.andThen(store.renewLease(feed, owner, duration)),
                Effect.andThen(Effect.sleep("5 seconds")),
              ),
          })
          yield* settle(() => fake.log.length > 0)
          yield* TestClock.adjust("41 seconds")
          yield* settle(() => startedAt.length >= 4)
          expect(startedAt).toEqual([10_000, 20_000, 30_000, 40_000])
          expect(fiber.pollUnsafe()).toBeUndefined()
        }),
      )

      /** A store whose `acquireLease` writes, then takes `seconds` more to answer. */
      const slowToAcquire = (store: CheckpointStoreService, seconds: number) => {
        let attempts = 0
        return {
          attempts: () => attempts,
          store: {
            ...store,
            acquireLease: (feed: FeedId, owner: string, duration: Duration.Duration) =>
              Effect.suspend(() => {
                attempts++
                return store
                  .acquireLease(feed, owner, duration)
                  .pipe(Effect.andThen(Effect.sleep(Duration.seconds(seconds))))
              }),
          } satisfies CheckpointStoreService,
        }
      }

      it.effect("the deadline counts from before a slow acquire", () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1").put("s1", 1)
          const store = CheckpointStore.makeMemory()
          const slow = slowToAcquire(store, 15)
          const { batches, fiber } = yield* feedKeepingBatches(options, fake, {
            ...slow.store,
            renewLease: () => Effect.fail(blip("renew")),
          })
          yield* settle(() => slow.attempts() === 1)
          // The lease was written at 0 and expires at 30 s, so the deadline is 20 s.
          yield* TestClock.adjust("15 seconds")
          yield* settle(() => batches.length === 1)
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust("5 seconds")
          yield* settle(ended(fiber))
          expect(failureOf(fiber.pollUnsafe()!)).toMatchObject({ _tag: "CheckpointStoreError" })
          const refused = yield* Effect.flip(batches[0]!.commit())
          expect(refused).toMatchObject({ _tag: "ChangeFeedLeaseLost", owner: "me" })
        }),
      )

      it.effect("a slow acquire renews before the lease it took expires", () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1")
          const store = CheckpointStore.makeMemory()
          const slow = slowToAcquire(store, 25)
          const startedAt: Array<number> = []
          const { fiber } = yield* feedKeepingBatches(options, fake, {
            ...slow.store,
            renewLease: (feed, owner, duration) =>
              Clock.currentTimeMillis.pipe(
                Effect.tap((now) => Effect.sync(() => startedAt.push(now))),
                Effect.andThen(store.renewLease(feed, owner, duration)),
              ),
          })
          yield* settle(() => slow.attempts() === 1)
          yield* TestClock.adjust("31 seconds")
          yield* settle(() => startedAt.length > 0)
          expect(startedAt[0]).toBe(25_000)
          const rival = yield* Effect.flip(store.acquireLease(feedId, "b", Duration.seconds(30)))
          expect(rival).toMatchObject({ _tag: "ChangeFeedLeaseHeld", owner: "me" })
          expect(fiber.pollUnsafe()).toBeUndefined()
        }),
      )

      it.effect("a renewal past the deadline may still answer, for renewEvery at most", () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1")
          const store = CheckpointStore.makeMemory()
          const slow = slowToAcquire(store, 25)
          const { fiber } = yield* feedKeepingBatches(options, fake, {
            ...slow.store,
            renewLease: () => Effect.never,
          })
          yield* settle(() => slow.attempts() === 1)
          // Answered at 25 s, past the 20 s deadline: the renewal starts at once.
          yield* TestClock.adjust("34 seconds")
          yield* flush
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust("1 second")
          yield* settle(ended(fiber))
          expect(failureOf(fiber.pollUnsafe()!)).toMatchObject({ _tag: "ChangeFeedLeaseLost" })
        }),
      )

      it.effect('onHeld: "wait" counts from before the attempt that took the lease', () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1")
          const store = CheckpointStore.makeMemory()
          yield* store.acquireLease(feedId, "other", Duration.hours(1))
          const slow = slowToAcquire(store, 15)
          const { fiber } = yield* feedKeepingBatches(
            { ...options, lease: { ...heldLease, onHeld: "wait" } },
            fake,
            { ...slow.store, renewLease: () => Effect.fail(blip("renew")) },
          )
          yield* settle(() => slow.attempts() === 1)
          // Attempts every 10 s: the one at 50 s takes it, and answers at 65 s.
          yield* TestClock.adjust("45 seconds")
          yield* store.releaseLease(feedId, "other")
          yield* TestClock.adjust("24 seconds")
          yield* flush
          expect(fiber.pollUnsafe()).toBeUndefined()
          // Written at 50 s: the deadline is 70 s.
          yield* TestClock.adjust("1 second")
          yield* settle(ended(fiber))
          expect(failureOf(fiber.pollUnsafe()!)).toMatchObject({ _tag: "CheckpointStoreError" })
        }),
      )

      it.effect("an acquire interrupted after its write landed still releases the lease", () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1")
          const store = CheckpointStore.makeMemory()
          let wrote = false
          const { fiber } = yield* feedKeepingBatches(options, fake, {
            ...store,
            acquireLease: (feed, owner, duration) =>
              store.acquireLease(feed, owner, duration).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    wrote = true
                  }),
                ),
                Effect.andThen(Effect.never),
              ),
          })
          yield* settle(() => wrote)
          yield* Fiber.interrupt(fiber)
          yield* store.acquireLease(feedId, "next", Duration.seconds(30))
        }),
      )

      it.effect("a release that never returns holds the feed's end for renewEvery at most", () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1").put("s1", 1).close("s1")
          fake.status = "DISABLED"
          const store = CheckpointStore.makeMemory()
          let releasing = false
          const run = yield* collect({ streamArn: STREAM_ARN, lease: heldLease }).pipe(
            Effect.provide(
              layerOf(fake, {
                ...store,
                releaseLease: () =>
                  Effect.suspend(() => {
                    releasing = true
                    return Effect.never
                  }),
              }),
            ),
            Effect.forkChild,
          )
          yield* settle(() => releasing)
          yield* TestClock.adjust("9 seconds")
          yield* flush
          expect(run.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust("1 second")
          yield* settle(ended(run))
          const exit = run.pollUnsafe()
          expect(exit).toBeDefined()
          expect(Exit.isSuccess(exit!)).toBe(true)
        }),
      )

      /** The memory store, with each renewal first doing what `script` says for its attempt. */
      const scripted = (
        store: CheckpointStoreService,
        script: (attempt: number) => Effect.Effect<void, ChangeFeedError>,
      ) => {
        const startedAt: Array<number> = []
        let interrupted = 0
        return {
          startedAt,
          interrupted: () => interrupted,
          store: {
            ...store,
            renewLease: (feed: FeedId, owner: string, duration: Duration.Duration) =>
              Effect.gen(function* () {
                startedAt.push(yield* Clock.currentTimeMillis)
                yield* script(startedAt.length)
                yield* store.renewLease(feed, owner, duration)
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted++
                  }),
                ),
              ),
          } as CheckpointStoreService,
        }
      }

      describe("a renewal that doesn't answer", () => {
        it.effect("is abandoned and retried inside the window, keeping the lease", () =>
          Effect.gen(function* () {
            const fake = new FakeStreams().addShard("s1")
            const memory = CheckpointStore.makeMemory()
            const script = scripted(memory, (attempt) =>
              attempt === 1 ? Effect.never : Effect.void,
            )
            const { fiber } = yield* feedKeepingBatches(options, fake, script.store)
            yield* settle(() => fake.log.length > 0)
            yield* TestClock.adjust("17500 millis")
            yield* settle(() => script.startedAt.length === 2)
            // At the default ratio the first attempt leaves a quarter of the 10 s window.
            expect(script.startedAt).toEqual([10_000, 17_500])
            expect(script.interrupted()).toBe(1)
            // Past the deadline the first attempt had: the retry's answer moved it.
            yield* TestClock.adjust("10 seconds")
            yield* settle(() => script.startedAt.length === 3)
            expect(script.startedAt).toEqual([10_000, 17_500, 27_500])
            expect(fiber.pollUnsafe()).toBeUndefined()
            const rival = yield* Effect.flip(
              memory.acquireLease(feedId, "rival", Duration.seconds(30)),
            )
            expect(rival).toMatchObject({ _tag: "ChangeFeedLeaseHeld", owner: "me" })
          }),
        )

        for (const [name, duration, attempts, lostAt] of [
          // The window is 10 s: two attempts, three quarters then the rest.
          ["at the default ratio", 30, [10_000, 17_500], 20_000],
          // 15 s: `renewEvery` then the rest, since a quarter of it is left after the first.
          ["with a little room", 35, [10_000, 20_000], 25_000],
          // 40 s: `renewEvery` each.
          ["with room for several", 60, [10_000, 20_000, 30_000, 40_000], 50_000],
        ] as const) {
          it.effect(`${name}, every attempt is aborted, then the lease is lost`, () =>
            Effect.gen(function* () {
              const fake = new FakeStreams().addShard("s1")
              const script = scripted(CheckpointStore.makeMemory(), () => Effect.never)
              const { fiber } = yield* feedKeepingBatches(
                {
                  ...options,
                  lease: { ...heldLease, duration: Duration.seconds(duration) },
                },
                fake,
                script.store,
              )
              yield* settle(() => fake.log.length > 0)
              for (const at of attempts) {
                const before = yield* Clock.currentTimeMillis
                yield* TestClock.adjust(Duration.millis(at - before))
                yield* settle(() => script.startedAt.includes(at))
              }
              expect(script.startedAt).toEqual(attempts)
              expect(script.interrupted()).toBe(attempts.length - 1)
              const before = yield* Clock.currentTimeMillis
              yield* TestClock.adjust(Duration.millis(lostAt - before - 1))
              yield* flush
              expect(fiber.pollUnsafe()).toBeUndefined()
              yield* TestClock.adjust("1 millis")
              yield* settle(ended(fiber))
              expect(failureOf(fiber.pollUnsafe()!)).toMatchObject({
                _tag: "ChangeFeedLeaseLost",
                owner: "me",
              })
              expect(script.interrupted()).toBe(attempts.length)
            }),
          )
        }

        it.effect("is retried though it can't be interrupted, and not waited for", () =>
          Effect.gen(function* () {
            const fake = new FakeStreams().addShard("s1")
            const script = scripted(CheckpointStore.makeMemory(), (attempt) =>
              attempt === 1 ? Effect.uninterruptible(Effect.never) : Effect.void,
            )
            const { fiber } = yield* feedKeepingBatches(options, fake, script.store)
            yield* settle(() => fake.log.length > 0)
            yield* TestClock.adjust("27500 millis")
            yield* settle(() => script.startedAt.length === 3)
            expect(script.startedAt).toEqual([10_000, 17_500, 27_500])
            expect(fiber.pollUnsafe()).toBeUndefined()
          }),
        )

        it.effect("answering after it was abandoned changes nothing", () =>
          Effect.gen(function* () {
            const fake = new FakeStreams().addShard("s1")
            const late = yield* Deferred.make<void>()
            const script = scripted(CheckpointStore.makeMemory(), (attempt) =>
              attempt === 1
                ? Effect.uninterruptible(
                    Deferred.await(late).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new ChangeFeedLeaseLost({
                            streamArn: STREAM_ARN,
                            consumer: "default",
                            owner: "me",
                          }),
                        ),
                      ),
                    ),
                  )
                : Effect.void,
            )
            const { fiber } = yield* feedKeepingBatches(options, fake, script.store)
            yield* settle(() => fake.log.length > 0)
            yield* TestClock.adjust("17500 millis")
            yield* settle(() => script.startedAt.length === 2)
            yield* Deferred.succeed(late, undefined)
            yield* flush
            expect(fiber.pollUnsafe()).toBeUndefined()
            yield* TestClock.adjust("10 seconds")
            yield* settle(() => script.startedAt.length === 3)
            expect(script.startedAt).toEqual([10_000, 17_500, 27_500])
            expect(fiber.pollUnsafe()).toBeUndefined()
          }),
        )

        it.effect("after a failure that left the rest of the window, gets a retry too", () =>
          Effect.gen(function* () {
            const fake = new FakeStreams().addShard("s1")
            const script = scripted(CheckpointStore.makeMemory(), (attempt) =>
              attempt === 1
                ? Effect.fail(blip("renew"))
                : attempt === 2
                  ? Effect.never
                  : Effect.void,
            )
            const { fiber } = yield* feedKeepingBatches(options, fake, script.store)
            yield* settle(() => fake.log.length > 0)
            yield* TestClock.adjust("19999 millis")
            yield* settle(() => script.startedAt.length === 3)
            expect(script.startedAt).toHaveLength(3)
            expect(script.interrupted()).toBe(1)
            yield* TestClock.adjust("1 second")
            yield* flush
            expect(fiber.pollUnsafe()).toBeUndefined()
          }),
        )
      })

      describe("on the real client", () => {
        const feedOver = (server: LocalServer, fake: FakeStreams) =>
          Layer.mergeAll(
            Layer.succeed(
              DynamoStreamsClient,
              fromSdkClient(fake as unknown as DynamoDBStreamsClient),
            ),
            CheckpointStore.layerDynamoDB({ tableName: "checkpoints" }).pipe(
              Layer.provide(
                DynamoClient.layer({
                  region: "us-east-1",
                  endpoint: server.endpoint,
                  credentials: { accessKeyId: "local", secretAccessKey: "local" },
                }),
              ),
            ),
          )

        it.live("a request that never answers is aborted, and fails the feed at the deadline", () =>
          Effect.gen(function* () {
            const server = yield* localServer((request) =>
              request.operation === "UpdateItem" ? hang : passThrough,
            )
            const startedAt = Date.now()
            // Inside the layer: destroying the client would close the connections anyway.
            yield* Effect.gen(function* () {
              const exit = yield* collect({
                streamArn: STREAM_ARN,
                ...fast,
                lease: { owner: "me", duration: "600 millis", renewEvery: "100 millis" },
              }).pipe(Effect.exit)
              expect(failureOf(exit)).toMatchObject({ _tag: "ChangeFeedLeaseLost", owner: "me" })
              // At the deadline and not before it.
              expect(Date.now() - startedAt).toBeGreaterThanOrEqual(490)
              // No answer ever came, and the server saw each connection end.
              const renewals = server.of("UpdateItem")
              expect(renewals.length).toBeGreaterThanOrEqual(1)
              yield* server.until(() => renewals.every((renewal) => renewal.connectionClosed))
              expect(renewals.some((renewal) => renewal.answered)).toBe(false)
              // The release still went out, though the feed need not wait for its answer.
              yield* server.until(() => server.of("DeleteItem").length > 0)
            }).pipe(Effect.provide(feedOver(server, new FakeStreams().addShard("s1"))))
          }),
        )

        it.live(
          "the first renewal hanging closes its connection, and the feed carries on",
          () =>
            Effect.gen(function* () {
              let renewals = 0
              const server = yield* localServer((request) =>
                request.operation === "UpdateItem" && ++renewals === 1 ? hang : passThrough,
              )
              const fake = new FakeStreams().addShard("s1").put("s1", 1)
              yield* Effect.gen(function* () {
                const committed: Array<ChangeFeedBatch> = []
                // The default ratio. Its window is long enough for this to pass under load: the
                // retry has a quarter of 2 s to be answered.
                const fiber = yield* changeFeed({
                  streamArn: STREAM_ARN,
                  startingPosition: "TRIM_HORIZON",
                  ...fast,
                  lease: { owner: "me", duration: "6 seconds", renewEvery: "2 seconds" },
                }).pipe(
                  Stream.runForEach((batch) =>
                    batch.commit().pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          committed.push(batch)
                        }),
                      ),
                    ),
                  ),
                  Effect.forkChild,
                )
                yield* until(() => committed.length === 1)
                yield* server.until(() => server.of("UpdateItem").length === 1)
                const first = server.of("UpdateItem")[0]!
                // Aborted, not left open: this is what #194 could not do.
                yield* server.until(() => first.connectionClosed)
                expect(first.answered).toBe(false)
                yield* server.until(() => server.of("UpdateItem")[1]?.answered === true)
                expect(fiber.pollUnsafe()).toBeUndefined()
                // The feed carries on: a new record is delivered and committed.
                fake.put("s1", 1)
                yield* until(() => committed.length === 2)
                // And the next renewal comes on schedule, past the deadline the first had.
                yield* server.until(() => server.of("UpdateItem")[2]?.answered === true)
                expect(fiber.pollUnsafe()).toBeUndefined()
                yield* Fiber.interrupt(fiber)
                yield* server.until(() => server.of("DeleteItem").length > 0)
              }).pipe(Effect.provide(feedOver(server, fake)))
            }),
          30_000,
        )

        it.live(
          "each attempt is reported on its own, the abandoned one as interrupted",
          () =>
            Effect.gen(function* () {
              let renewals = 0
              const server = yield* localServer((request) =>
                request.operation === "UpdateItem" && ++renewals === 1 ? hang : passThrough,
              )
              const { reports, onOperation } = collectReports()
              const renewalsReported = () =>
                reports.filter((report) => report.operation === "CheckpointStore.renewLease")
              yield* Effect.gen(function* () {
                const fiber = yield* changeFeed({
                  streamArn: STREAM_ARN,
                  ...fast,
                  lease: { owner: "me", duration: "4 seconds", renewEvery: "1 second" },
                }).pipe(Stream.runDrain, Effect.forkChild)
                yield* server.until(() => server.of("UpdateItem")[1]?.answered === true)
                yield* until(() => renewalsReported().length >= 2)
                yield* Fiber.interrupt(fiber)
              }).pipe(
                Effect.provide(
                  Layer.merge(
                    feedOver(server, new FakeStreams().addShard("s1")),
                    ConsumedCapacity.layer({ onOperation, spans: false }),
                  ),
                ),
              )
              const byOutcome = renewalsReported()
                .slice(0, 2)
                .map((report) => [report.outcome, report.requests, report.unreportedRequests])
                .sort()
              // One request each, neither lost nor counted twice, and nothing came back for either
              // (this server's answers carry no capacity).
              expect(byOutcome).toEqual([
                ["interrupted", 1, 1],
                ["success", 1, 1],
              ])
            }),
          30_000,
        )

        it.live("a release that never answers closes its connection", () =>
          Effect.gen(function* () {
            const server = yield* localServer((request) =>
              request.operation === "DeleteItem" ? hang : passThrough,
            )
            yield* Effect.gen(function* () {
              const fake = new FakeStreams().addShard("s1").put("s1", 1)
              yield* collect(
                {
                  streamArn: STREAM_ARN,
                  startingPosition: "TRIM_HORIZON",
                  ...fast,
                  lease: { owner: "me", duration: "600 millis", renewEvery: "100 millis" },
                },
                1,
              ).pipe(
                Effect.provide(Layer.succeed(DynamoStreamsClient, fromSdkClient(fake as never))),
              )
              const release = server.of("DeleteItem")[0]!
              yield* server.until(() => release.connectionClosed)
              expect(release.answered).toBe(false)
            }).pipe(Effect.provide(feedOver(server, new FakeStreams().addShard("s1"))))
          }),
        )
      })

      describe("a read on a client with a timeout", () => {
        /** DynamoDB Streams' JSON protocol, for one shard of one record. */
        const replies = (request: SeenRequest, hangReads: () => boolean): Reply => {
          switch (request.operation) {
            case "DescribeStream":
              return answer(
                200,
                JSON.stringify({
                  StreamDescription: {
                    StreamArn: STREAM_ARN,
                    StreamStatus: "ENABLED",
                    Shards: [
                      {
                        ShardId: "s1",
                        SequenceNumberRange: { StartingSequenceNumber: seqOf(1) },
                      },
                    ],
                  },
                }),
              )
            case "GetShardIterator":
              return answer(200, JSON.stringify({ ShardIterator: "iterator" }))
            default:
              return hangReads()
                ? hang
                : answer(
                    200,
                    JSON.stringify({
                      Records: [
                        {
                          eventID: "e-1",
                          eventName: "INSERT",
                          dynamodb: {
                            SequenceNumber: seqOf(1),
                            Keys: { pk: { S: "k" } },
                          },
                        },
                      ],
                      NextShardIterator: "iterator",
                    }),
                  )
          }
        }

        it.live("that times out is retried, and the feed delivers", () =>
          Effect.gen(function* () {
            let reads = 0
            const server = yield* localServer((request) => replies(request, () => ++reads === 1))
            const batches = yield* collect(
              { streamArn: STREAM_ARN, startingPosition: "TRIM_HORIZON", ...fast, lease: false },
              1,
            ).pipe(
              Effect.provide(
                Layer.mergeAll(
                  DynamoStreamsClient.layer({
                    region: "us-east-1",
                    endpoint: server.endpoint,
                    credentials: { accessKeyId: "local", secretAccessKey: "local" },
                    requestHandler: { socketTimeout: 50 },
                    maxAttempts: 1,
                  }),
                  Layer.succeed(CheckpointStore, CheckpointStore.makeMemory()),
                ),
              ),
            )
            expect(sequencesOf(batches)).toEqual([1])
            expect(server.of("GetRecords").length).toBeGreaterThanOrEqual(2)
            expect(server.of("GetRecords")[0]!.answered).toBe(false)
          }),
        )

        const feedOn = (endpoint: string) =>
          collect({ streamArn: STREAM_ARN, ...fast, lease: false }).pipe(
            Effect.provide(
              Layer.mergeAll(
                DynamoStreamsClient.layer({
                  region: "us-east-1",
                  endpoint,
                  credentials: { accessKeyId: "local", secretAccessKey: "local" },
                  maxAttempts: 1,
                }),
                Layer.succeed(CheckpointStore, CheckpointStore.makeMemory()),
              ),
            ),
            Effect.exit,
          )

        it.live("that is refused still ends the feed: it may be a wrong endpoint", () =>
          Effect.gen(function* () {
            // A port that was just free, so nothing listens on it.
            const endpoint = yield* Effect.scoped(
              Effect.map(localServer(), (server) => server.endpoint),
            )
            expect(failureOf(yield* feedOn(endpoint))).toMatchObject({
              _tag: "DynamoError",
              cause: { code: "ECONNREFUSED" },
            })
          }),
        )

        it.live("whose connection drops still ends the feed, though it's named a timeout", () =>
          Effect.gen(function* () {
            const server = yield* localServer((request) =>
              request.operation === "DescribeStream"
                ? reset
                : answer(200, JSON.stringify({ Streams: [] })),
            )
            expect(failureOf(yield* feedOn(server.endpoint))).toMatchObject({
              _tag: "DynamoError",
              cause: { name: "TimeoutError", code: "ECONNRESET" },
            })
            expect(server.of("DescribeStream")).toHaveLength(1)
          }),
        )
      })
    })

    // Any scheduler budget: the feed records the loss some time after the store reports
    // it, so the test waits for the record, which only a commit can see.
    for (const budget of [16, 256, 2048]) {
      it.live(`a batch in flight when the lease is lost commits nothing (budget ${budget})`, () =>
        Effect.gen(function* () {
          const fake = new FakeStreams().addShard("s1").put("s1", 1)
          const store = CheckpointStore.makeMemory()
          const inFlight = yield* Deferred.make<void>()
          const lost = yield* Deferred.make<void>()
          const go = yield* Deferred.make<void>()
          const acknowledged = yield* Deferred.make<Exit.Exit<void, unknown>>()
          let writes = 0
          let writesByTheLastCommit = -1
          const watched: CheckpointStoreService = {
            ...store,
            renewLease: (feed, owner, duration) =>
              store
                .renewLease(feed, owner, duration)
                .pipe(Effect.tapError(() => Deferred.succeed(lost, undefined))),
            // Until the feed has recorded the loss a commit gets this far, and failing here
            // leaves the batch unsettled, so it can be committed again.
            commit: () =>
              Effect.suspend(() => {
                writes++
                return Effect.fail(new CheckpointStoreError({ operation: "commit", cause: "down" }))
              }),
          }
          const commitUntilRefused = (batch: ChangeFeedBatch) =>
            Effect.gen(function* () {
              for (let attempt = 0; ; attempt++) {
                const before = writes
                const exit = yield* Effect.exit(batch.commit())
                if (attempt === 2000 || !(failureOf(exit) instanceof CheckpointStoreError)) {
                  writesByTheLastCommit = writes - before
                  return exit
                }
                yield* Effect.sleep("1 millis")
              }
            })
          const fiber = yield* changeFeed({
            streamArn: STREAM_ARN,
            ...fast,
            lease: { owner: "me", duration: "30 seconds", renewEvery: "20 millis" },
          }).pipe(
            Stream.mapEffect((batch) =>
              Effect.uninterruptible(
                Deferred.succeed(inFlight, undefined).pipe(
                  Effect.andThen(Deferred.await(go)),
                  Effect.andThen(commitUntilRefused(batch)),
                  Effect.flatMap((exit) => Deferred.succeed(acknowledged, exit)),
                ),
              ),
            ),
            Stream.runDrain,
            Effect.provide(layerOf(fake, watched)),
            Effect.exit,
            Effect.forkChild,
          )
          // Another process takes the lease over; the next renewal finds it lost.
          yield* Deferred.await(inFlight)
          yield* store.releaseLease(feedId, "me")
          yield* store.acquireLease(feedId, "other", Duration.seconds(30))
          yield* Deferred.await(lost)
          yield* Deferred.succeed(go, undefined)
          const exit = yield* Deferred.await(acknowledged)
          expect(failureOf(exit)).toMatchObject({ _tag: "ChangeFeedLeaseLost", owner: "me" })
          expect(writesByTheLastCommit).toBe(0)
          expect((yield* store.load(feedId)).size).toBe(0)
          expect(failureOf(yield* Fiber.join(fiber))).toMatchObject({
            _tag: "ChangeFeedLeaseLost",
          })
        }).pipe(Effect.provideService(References.MaxOpsBeforeYield, budget)),
      )
    }

    it.live("lease: false takes no lease", () =>
      Effect.gen(function* () {
        const fake = new FakeStreams().addShard("s1").put("s1", 1).close("s1")
        fake.status = "DISABLED"
        const store = CheckpointStore.makeMemory()
        yield* store.acquireLease(feedId, "other", Duration.seconds(30))
        const batches = yield* collect({ streamArn: STREAM_ARN, ...fast, lease: false }).pipe(
          Effect.provide(layerOf(fake, store)),
        )
        expect(sequencesOf(batches)).toEqual([1])
      }),
    )
  })

  it.effect("backs off throttled reads with growing delays", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams().addShard("s1").put("s1", 1).close("s1")
      fake.status = "DISABLED"
      fake.throttle = 3
      const run = yield* collect({
        streamArn: STREAM_ARN,
        backoff: { initial: "1 second", max: "10 seconds" },
        lease: false,
      }).pipe(Effect.provide(layerOf(fake)), Effect.forkChild)
      const throttled = () => fake.log.filter((l) => l.startsWith("throttled")).length
      yield* adjust("1 millis")
      expect(throttled()).toBe(1)
      // The first retry waits about a second (jittered), the next about two.
      yield* adjust("500 millis")
      expect(throttled()).toBe(1)
      yield* adjust("800 millis")
      expect(throttled()).toBe(2)
      yield* adjust("1 second")
      expect(throttled()).toBe(2)
      yield* adjust("2 seconds")
      expect(throttled()).toBe(3)
      yield* adjust("10 seconds")
      const batches = yield* Fiber.join(run)
      expect(sequencesOf(batches)).toEqual([1])
    }),
  )

  it.effect("an idle open shard polls every pollInterval", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams().addShard("s1")
      const fiber = yield* collect({
        streamArn: STREAM_ARN,
        pollInterval: "1 second",
        lease: false,
      }).pipe(Effect.provide(layerOf(fake)), Effect.forkChild)
      const reads = () => fake.log.filter((l) => l.startsWith("records:")).length
      yield* adjust("1 millis")
      expect(reads()).toBe(1)
      yield* adjust("999 millis")
      expect(reads()).toBe(1)
      yield* adjust("1 millis")
      expect(reads()).toBe(2)
      for (let i = 0; i < 3; i++) yield* adjust("1 second")
      expect(reads()).toBe(5)
      yield* Fiber.interrupt(fiber)
    }),
  )
})

// ---------------------------------------------------------------------------
// runChangeFeed
// ---------------------------------------------------------------------------

class Opened extends Schema.TaggedClass<Opened>()("Opened", { owner: Schema.String }) {}

const Accounts = EventStore.makeStream({
  table: Table.make({ schema: DynamoSchema.make({ name: "cf", version: 1 }), entities: {} }),
  streamName: "Account",
  events: [Opened],
  streamId: { composite: ["accountId"] },
})

/** A stored `Opened` event item's image (`data` as a native map). */
const eventImage = (seq: number, data: unknown): _Record["dynamodb"] => ({
  NewImage: {
    pk: { S: `$cf#v1#account#a-${seq}` },
    sk: { S: `$cf#v1#account#${String(1).padStart(10, "0")}` },
    __edd_e__: { S: Accounts.eventMarker },
    streamId: { S: `a-${seq}` },
    version: { N: "1" },
    eventType: { S: "Opened" },
    data: data as never,
    timestamp: { S: "2026-01-01T00:00:00.000Z" },
  },
})

describe("runChangeFeed", () => {
  it.live("decodes each batch, acknowledges it per its response, and re-reads failed records", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams().addShard("s1")
      fake.put("s1", 1, (seq) =>
        eventImage(seq, { M: { _tag: { S: "Opened" }, owner: { S: "ann" } } }),
      )
      fake.put("s1", 1, (seq) =>
        eventImage(seq, { M: { _tag: { S: "Opened" }, owner: { N: "1" } } }),
      )
      fake.put("s1", 1, (seq) =>
        eventImage(seq, { M: { _tag: { S: "Opened" }, owner: { S: "cy" } } }),
      )
      const store = CheckpointStore.makeMemory()
      const seen: Array<{ positions: Array<number>; failed: number; owners: Array<string> }> = []
      const redelivered = yield* Deferred.make<void>()
      const fiber = yield* runChangeFeed(changeFeed({ streamArn: STREAM_ARN, ...fast }), {
        projections: {},
        streams: { Account: Accounts },
        onBatch: (batch, result) =>
          Effect.suspend(() => {
            seen.push({
              positions: batch.records.map((r) => Number(r.dynamodb!.SequenceNumber)),
              failed: result.failedRecords.length,
              owners: result.unrouted.map((u) => u.event.data.owner),
            })
            return seen.length === 2 ? Deferred.succeed(redelivered, undefined) : Effect.void
          }),
      }).pipe(Effect.provide(layerOf(fake, store)), Effect.forkChild)
      yield* Deferred.await(redelivered)
      yield* Fiber.interrupt(fiber)
      // The record that fails to decode is reported: the checkpoint stops before it.
      expect(seen[0]).toEqual({ positions: [1, 2, 3], failed: 1, owners: ["ann", "cy"] })
      expect(seen[1]?.positions).toEqual([2, 3])
      expect((yield* store.load(feedId)).get("s1")).toEqual({
        _tag: "Sequence",
        sequenceNumber: seqOf(1),
      })
    }),
  )

  it.live("skipped decode failures are acknowledged", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams().addShard("s1")
      fake.put("s1", 1, (seq) =>
        eventImage(seq, { M: { _tag: { S: "Opened" }, owner: { N: "1" } } }),
      )
      fake.put("s1", 1)
      fake.close("s1").status = "DISABLED"
      const store = CheckpointStore.makeMemory()
      yield* runChangeFeed(changeFeed({ streamArn: STREAM_ARN, ...fast }), {
        projections: {},
        streams: { Account: Accounts },
        onDecodeFailure: "skip",
      }).pipe(Effect.provide(layerOf(fake, store)))
      expect((yield* store.load(feedId)).get("s1")).toEqual({ _tag: "Finished" })
    }),
  )
})

// ---------------------------------------------------------------------------
// DynamoStreamsClient
// ---------------------------------------------------------------------------

describe("DynamoStreamsClient", () => {
  it("maps SDK failures to tagged errors", () => {
    const tag = (name: string) => classifyStreamsError("GetRecords")(awsError(name))._tag
    expect(tag("ExpiredIteratorException")).toBe("ShardIteratorExpired")
    expect(tag("TrimmedDataAccessException")).toBe("StreamDataTrimmed")
    expect(tag("LimitExceededException")).toBe("ThrottlingError")
    expect(tag("ThrottlingException")).toBe("ThrottlingError")
    expect(tag("ValidationException")).toBe("DynamoValidationError")
    expect(tag("InternalServerError")).toBe("InternalServerError")
    expect(tag("ResourceNotFoundException")).toBe("ResourceNotFoundError")
    expect(tag("Anything")).toBe("DynamoError")
  })

  it.effect("wraps the SDK client's commands", () =>
    Effect.gen(function* () {
      const fake = new FakeStreams().addShard("s1")
      const client = fromSdkClient(fake as unknown as DynamoDBStreamsClient)
      const streams = yield* client.listStreams({})
      expect(streams.Streams?.[0]?.StreamArn).toBe(STREAM_ARN)
      const error = yield* Effect.flip(client.getRecords({ ShardIterator: "{}" }))
      expect(error._tag).toBe("DynamoError")
    }),
  )
})
