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
import { Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { classifyStreamsError, fromSdkClient } from "../src/change-feed/DynamoStreamsClient.js"
import {
  type ChangeFeedBatch,
  type ChangeFeedOptions,
  CheckpointStore,
  CheckpointStoreError,
  type CheckpointStoreService,
  changeFeed,
  DynamoStreamsClient,
  runChangeFeed,
} from "../src/change-feed/index.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

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
      // Two shards a page, to exercise pagination.
      const from =
        input.ExclusiveStartShardId === undefined
          ? 0
          : this.shards.findIndex((s) => s.id === input.ExclusiveStartShardId) + 1
      const page = this.shards.slice(from, from + 2)
      const more = from + 2 < this.shards.length
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
      const shard = this.shard(input.ShardId!)
      this.log.push(`iterator:${shard.id}:${input.ShardIteratorType}`)
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

/** Let the fake's promises settle (they run outside the test clock). */
const flush = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)))

/** Advance the test clock, then let the fake's promises settle. */
const adjust = (duration: Duration.Input) =>
  TestClock.adjust(duration).pipe(Effect.andThen(flush), Effect.andThen(flush))

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
        yield* Effect.sleep("20 millis")
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
      yield* Effect.sleep("20 millis")
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
          lease: { owner: "me", duration: "10 millis", renewEvery: "40 millis" },
        }).pipe(Effect.provide(layerOf(fake, store)), Effect.exit, Effect.forkChild)
        // The lease lapses before its renewal; another process takes it.
        yield* Effect.sleep("20 millis")
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
        const flaky: CheckpointStoreService = {
          ...store,
          renewLease: (feed, owner, duration) =>
            Effect.suspend(() =>
              ++renewals === 1
                ? Effect.fail(new CheckpointStoreError({ operation: "renewLease", cause: "blip" }))
                : store.renewLease(feed, owner, duration),
            ),
        }
        const fiber = yield* collect({
          streamArn: STREAM_ARN,
          ...fast,
          lease: { duration: "1 second", renewEvery: "10 millis" },
        }).pipe(Effect.provide(layerOf(fake, flaky)), Effect.exit, Effect.forkChild)
        yield* Effect.sleep("60 millis")
        expect(renewals).toBeGreaterThan(2)
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(fiber)
      }),
    )

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
      const fiber = yield* runChangeFeed(changeFeed({ streamArn: STREAM_ARN, ...fast }), {
        projections: {},
        streams: { Account: Accounts },
        onBatch: (batch, result) =>
          Effect.sync(() => {
            seen.push({
              positions: batch.records.map((r) => Number(r.dynamodb!.SequenceNumber)),
              failed: result.failedRecords.length,
              owners: result.unrouted.map((u) => u.event.data.owner),
            })
          }),
      }).pipe(Effect.provide(layerOf(fake, store)), Effect.forkChild)
      yield* Effect.sleep("40 millis")
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
