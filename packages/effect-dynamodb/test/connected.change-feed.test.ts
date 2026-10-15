/**
 * Connected tests for the polled change feed (#156) against DynamoDB Local's
 * Streams API.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Covers, end to end:
 *   - discovery: the table's stream, its shard, Lambda-shaped records;
 *   - `runChangeFeed` into an `EventStore.projection`, including a packed
 *     (gzip) stream whose images carry `B` as bytes;
 *   - resume after a restart from the DynamoDB checkpoint store;
 *   - the lease held in the DynamoDB checkpoint store;
 *   - closed-shard retirement: disabling the stream closes its shard, which is
 *     drained, checkpointed as finished, and ends the feed.
 *
 * DynamoDB Local never splits a shard (by volume or by time), so
 * parent-before-child across a split is covered by `ChangeFeed.test.ts`.
 */

import { it } from "@effect/vitest"
import { Compression } from "@effect-dynamodb/schema/Compression.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import {
  type ChangeFeedBatch,
  type ChangeFeedOptions,
  CheckpointStore,
  changeFeed,
  DynamoStreamsClient,
  runChangeFeed,
} from "../src/change-feed/index.js"
import * as ZlibCompression from "../src/compression/zlib.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local isn't reachable
// ---------------------------------------------------------------------------

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}

const describeConnected = dynamoAvailable ? describe : describe.skip

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "feed-it", version: 1 })
const suffix = Date.now()
const eventsTableName = `feed-events-${suffix}`
const readTableName = `feed-read-${suffix}`
const checkpointTableName = `feed-checkpoints-${suffix}`

class Opened extends Schema.TaggedClass<Opened>()("Opened", { owner: Schema.String }) {}
class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}

const EventsTable = Table.make({ schema: AppSchema, entities: {} })

const Accounts = EventStore.makeStream({
  table: EventsTable,
  streamName: "Account",
  events: [Opened, Deposited],
  streamId: { composite: ["accountId"] },
})

/** Event data stored packed with gzip: its stream images carry `B` as bytes. */
const Ledgers = EventStore.makeStream({
  table: EventsTable,
  streamName: "Ledger",
  events: [Deposited],
  streamId: { composite: ["ledgerId"] },
  storedAs: {
    data: DynamoModel.Packed({ format: "json", compression: { codec: "gzip", threshold: 1 } }),
  },
})

const Balances = Entity.make({
  model: Schema.Struct({
    accountId: Schema.String,
    owner: Schema.String,
    balance: Schema.Number,
    version: Schema.Number,
  }),
  entityType: "Balance",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
})

const LedgerTotals = Entity.make({
  model: Schema.Struct({ ledgerId: Schema.String, total: Schema.Number, seq: Schema.Number }),
  entityType: "LedgerTotal",
  primaryKey: {
    pk: { field: "pk", composite: ["ledgerId"] },
    sk: { field: "sk", composite: [] },
  },
})

const ReadTable = Table.make({ schema: AppSchema, entities: { Balances, LedgerTotals } })

const BalanceProjection = EventStore.projection({
  stream: Accounts,
  readModel: Balances,
  key: (id) => ({ accountId: id.accountId }),
  initial: (id) => ({ accountId: id.accountId, owner: "", balance: 0, version: 0 }),
  evolve: (state, event) => {
    const data = event.data
    return Effect.succeed(
      data._tag === "Opened"
        ? { ...state, owner: data.owner }
        : { ...state, balance: state.balance + data.amount },
    )
  },
  checkpoint: "version",
})

const LedgerProjection = EventStore.projection({
  stream: Ledgers,
  readModel: LedgerTotals,
  key: (id) => ({ ledgerId: id.ledgerId }),
  initial: (id) => ({ ledgerId: id.ledgerId, total: 0, seq: 0 }),
  evolve: (state, event) => Effect.succeed({ ...state, total: state.total + event.data.amount }),
  checkpoint: "seq",
})

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const TestLayer = Layer.mergeAll(
  ClientLayer,
  DynamoStreamsClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials }),
  CheckpointStore.layerDynamoDB({ tableName: checkpointTableName }).pipe(
    Layer.provide(ClientLayer),
  ),
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
  Compression.layer([ZlibCompression.gzip()]),
)
const provide = Effect.provide(TestLayer)

let streamArn = ""

const feedOptions = (consumer = "projections"): ChangeFeedOptions => ({
  streamArn,
  consumer,
  pollInterval: "50 millis",
  describeInterval: "200 millis",
})

const projections = { balances: BalanceProjection, ledgers: LedgerProjection }

/** Poll `check` until it holds (or give up after ~10 s). */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      if (yield* check) return
      yield* Effect.sleep("50 millis")
    }
    throw new Error("condition not reached")
  })

const balanceOf = (accountId: string) =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { Balances } })
    return yield* db.entities.Balances.get({ accountId }).asEffect()
  })

const checkpointOf = (consumer: string) =>
  Effect.gen(function* () {
    const store = yield* CheckpointStore
    return yield* store.load({ streamArn, consumer })
  })

/** The first batch, committed. */
const takeOne = <E, R>(feed: Stream.Stream<ChangeFeedBatch, E, R>) =>
  feed.pipe(
    Stream.mapEffect((batch) => Effect.as(batch.commit(), batch)),
    Stream.take(1),
    Stream.runCollect,
  )

describeConnected("change feed (connected)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const keys = {
          BillingMode: "PAY_PER_REQUEST" as const,
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" as const },
            { AttributeName: "sk", KeyType: "RANGE" as const },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" as const },
            { AttributeName: "sk", AttributeType: "S" as const },
          ],
        }
        const created = yield* client.createTable({
          TableName: eventsTableName,
          ...keys,
          StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
        })
        streamArn = created.TableDescription?.LatestStreamArn ?? ""
        yield* client.createTable({ TableName: readTableName, ...keys })
        yield* client.createTable(CheckpointStore.tableDefinition(checkpointTableName))
      }).pipe(provide),
    )
  })

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const TableName of [eventsTableName, readTableName, checkpointTableName]) {
          yield* client.deleteTable({ TableName }).pipe(Effect.ignore)
        }
      }).pipe(provide),
    )
  })

  it.live("discovers the table's stream and delivers Lambda-shaped records", () =>
    Effect.gen(function* () {
      expect(streamArn).toContain("/stream/")
      const streams = yield* DynamoStreamsClient
      const listed = yield* streams.listStreams({ TableName: eventsTableName })
      expect(listed.Streams?.map((s) => s.StreamArn)).toEqual([streamArn])

      yield* Accounts.append({ accountId: "probe" }, [new Opened({ owner: "pat" })], 0)
      const [batch] = yield* changeFeed({ ...feedOptions("probe"), lease: false }).pipe(takeOne)
      expect(batch!.streamArn).toBe(streamArn)
      expect(batch!.shardId).toMatch(/^shardId-/)
      const record = batch!.records[0]!
      expect(record.eventName).toBe("INSERT")
      expect(record.dynamodb?.SequenceNumber).toBe(batch!.firstSequenceNumber)
      expect(record.dynamodb?.NewImage?.__edd_e__).toEqual({ S: Accounts.eventMarker })
    }).pipe(provide),
  )

  it.live("projects the feed, then resumes after a restart from the DynamoDB checkpoints", () =>
    Effect.gen(function* () {
      yield* Accounts.append(
        { accountId: "a1" },
        [new Opened({ owner: "ada" }), new Deposited({ amount: 5 })],
        0,
      )
      yield* Accounts.append({ accountId: "a2" }, [new Opened({ owner: "bo" })], 0)
      yield* Ledgers.append(
        { ledgerId: "l1" },
        [new Deposited({ amount: 7 }), new Deposited({ amount: 8 })],
        0,
      )

      const seen: Array<string> = []
      const run = () =>
        runChangeFeed(changeFeed(feedOptions()), {
          projections,
          onBatch: (batch: ChangeFeedBatch, result) =>
            Effect.sync(() => {
              expect(result.response.batchItemFailures).toEqual([])
              for (const r of batch.records) seen.push(r.dynamodb!.SequenceNumber!)
            }),
        }).pipe(Effect.forkChild)

      // First run.
      const first = yield* run()
      yield* eventually(
        balanceOf("a1").pipe(
          Effect.map((b) => b.balance === 5),
          Effect.orElseSucceed(() => false),
        ),
      )
      yield* eventually(
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({ entities: { LedgerTotals } })
          const total = yield* db.entities.LedgerTotals.get({ ledgerId: "l1" }).asEffect()
          return total.total === 15
        }).pipe(Effect.orElseSucceed(() => false)),
      )
      expect(yield* balanceOf("a2")).toMatchObject({ owner: "bo", version: 1 })
      yield* Fiber.interrupt(first)
      const checkpoints = yield* checkpointOf("projections")
      expect(checkpoints.size).toBe(1)
      const [checkpoint] = [...checkpoints.values()]
      expect(checkpoint?._tag).toBe("Sequence")
      const committed = checkpoint?._tag === "Sequence" ? checkpoint.sequenceNumber : ""
      expect(seen).toContain(committed)

      // Written while no consumer runs.
      yield* Accounts.append({ accountId: "a1" }, [new Deposited({ amount: 10 })], 2)
      const before = seen.length

      // Restart: reads from the checkpoint on, not from the trim horizon.
      const second = yield* run()
      yield* eventually(
        balanceOf("a1").pipe(
          Effect.map((b) => b.balance === 15),
          Effect.orElseSucceed(() => false),
        ),
      )
      yield* Fiber.interrupt(second)
      const resumed = seen.slice(before)
      expect(resumed.length).toBeGreaterThan(0)
      for (const sequence of resumed) expect(BigInt(sequence) > BigInt(committed)).toBe(true)
      expect(yield* balanceOf("a1")).toMatchObject({ owner: "ada", balance: 15, version: 3 })
    }).pipe(provide),
  )

  it.live("a second consumer process is refused the lease; another consumer is not", () =>
    Effect.gen(function* () {
      yield* Accounts.append({ accountId: "l1" }, [new Opened({ owner: "lee" })], 0)
      const holder = yield* runChangeFeed(changeFeed(feedOptions("leased")), { projections }).pipe(
        Effect.forkChild,
      )
      // The holder has taken the lease and started reading.
      yield* Effect.sleep("500 millis")
      const refused = yield* runChangeFeed(changeFeed(feedOptions("leased")), { projections }).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(refused)).toBe(true)
      expect(String(Exit.isFailure(refused) ? refused.cause : "")).toContain("ChangeFeedLeaseHeld")
      // Another application consumes the same stream alongside.
      const [other] = yield* changeFeed(feedOptions("other-app")).pipe(takeOne)
      expect(other!.records.length).toBeGreaterThan(0)
      yield* Fiber.interrupt(holder)
      // Released on interruption: the next process takes it at once.
      yield* Accounts.append({ accountId: "l1" }, [new Deposited({ amount: 1 })], 1)
      const [next] = yield* changeFeed(feedOptions("leased")).pipe(takeOne)
      expect(next!.records.length).toBeGreaterThan(0)
    }).pipe(provide),
  )

  it.live("drains a closed shard, checkpoints it as finished, and ends with the stream", () =>
    Effect.gen(function* () {
      yield* Accounts.append({ accountId: "a3" }, [new Opened({ owner: "cy" })], 0)
      const client = yield* DynamoClient
      // Disabling the stream closes its shard.
      yield* client.updateTable({
        TableName: eventsTableName,
        StreamSpecification: { StreamEnabled: false },
      })
      // Runs to completion by itself: every shard drained, the stream disabled.
      yield* runChangeFeed(changeFeed(feedOptions()), { projections })
      expect(yield* balanceOf("a3")).toMatchObject({ owner: "cy", version: 1 })
      const checkpoints = yield* checkpointOf("projections")
      expect([...checkpoints.values()]).toEqual([{ _tag: "Finished" }])
      // A restart finds nothing left to read and ends at once.
      yield* runChangeFeed(changeFeed(feedOptions()), { projections })
    }).pipe(provide),
  )
})
