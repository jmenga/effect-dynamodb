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
import { Config, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
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
import {
  hang,
  type LocalServer,
  localServer,
  passThrough,
  type SeenRequest,
} from "./helpers/LocalServer.js"

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

const ledgerTotalOf = (ledgerId: string) =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { LedgerTotals } })
    return yield* db.entities.LedgerTotals.get({ ledgerId }).asEffect()
  })

const checkpointOf = (consumer: string) =>
  Effect.gen(function* () {
    const store = yield* CheckpointStore
    return yield* store.load({ streamArn, consumer })
  })

/** The sequence number the consumer's one shard is checkpointed at, if any. */
const committedAt = (consumer: string) =>
  Effect.map(checkpointOf(consumer), (checkpoints) => {
    const [checkpoint] = [...checkpoints.values()]
    return checkpoint?._tag === "Sequence" ? checkpoint.sequenceNumber : undefined
  })

const leaseOf = (consumer: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Item } = yield* client.getItem({
      TableName: checkpointTableName,
      Key: { pk: { S: `${consumer}#${streamArn}` }, sk: { S: "lease" } },
      ConsistentRead: true,
    })
    return Item === undefined
      ? undefined
      : { owner: Item.owner?.S, expiresAt: Number(Item.expiresAt?.N) }
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

  /**
   * Run the feed into the projections, stop it, write while no consumer runs, and run it again:
   * the restart reads from the DynamoDB checkpoint on. A run is stopped only once what the test
   * asserts next has happened, never on the read model alone: the projections write the read
   * model before `onBatch` runs and before the batch is committed, so a run stopped as soon as
   * the read model shows an event can stop before `onBatch` has seen it or its checkpoint is
   * written. `onBatch` is slowed by `onBatchDelay`, to hold that window open.
   */
  const restartScenario = (options: {
    readonly consumer: string
    readonly accounts: readonly [string, string]
    readonly ledger: string
    readonly onBatchDelay: Duration.Input
  }) =>
    Effect.gen(function* () {
      const { consumer, ledger } = options
      const [account, other] = options.accounts
      yield* Accounts.append(
        { accountId: account },
        [new Opened({ owner: "ada" }), new Deposited({ amount: 5 })],
        0,
      )
      yield* Accounts.append({ accountId: other }, [new Opened({ owner: "bo" })], 0)
      yield* Ledgers.append(
        { ledgerId: ledger },
        [new Deposited({ amount: 7 }), new Deposited({ amount: 8 })],
        0,
      )

      const seen: Array<string> = []
      const run = () =>
        runChangeFeed(changeFeed(feedOptions(consumer)), {
          projections,
          onBatch: (batch: ChangeFeedBatch, result) =>
            Effect.sleep(options.onBatchDelay).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  expect(result.response.batchItemFailures).toEqual([])
                  for (const r of batch.records) seen.push(r.dynamodb!.SequenceNumber!)
                }),
              ),
            ),
        }).pipe(Effect.forkChild)

      // First run: every event projected, and a checkpoint committed at a batch `onBatch` saw.
      const first = yield* run()
      yield* eventually(
        Effect.gen(function* () {
          const projected = yield* Effect.all([
            balanceOf(account),
            balanceOf(other),
            ledgerTotalOf(ledger),
          ]).pipe(
            Effect.map(([a, b, l]) => a.balance === 5 && b.version === 1 && l.total === 15),
            Effect.orElseSucceed(() => false),
          )
          const at = yield* committedAt(consumer)
          return projected && at !== undefined && seen.includes(at)
        }),
      )
      expect(yield* balanceOf(other)).toMatchObject({ owner: "bo", version: 1 })
      yield* Fiber.interrupt(first)
      const checkpoints = yield* checkpointOf(consumer)
      expect(checkpoints.size).toBe(1)
      const [checkpoint] = [...checkpoints.values()]
      expect(checkpoint?._tag).toBe("Sequence")
      const committed = checkpoint?._tag === "Sequence" ? checkpoint.sequenceNumber : ""
      expect(seen).toContain(committed)

      // Written while no consumer runs.
      yield* Accounts.append({ accountId: account }, [new Deposited({ amount: 10 })], 2)
      const before = seen.length

      // Restart: reads from the checkpoint on, not from the trim horizon. Stopped once the
      // deposit is projected and the restarted run has committed a checkpoint past `committed`,
      // which it does only after `onBatch` has seen that batch.
      const second = yield* run()
      yield* eventually(
        Effect.gen(function* () {
          const balance = yield* balanceOf(account).pipe(
            Effect.map((b) => b.balance),
            Effect.orElseSucceed(() => 0),
          )
          const at = yield* committedAt(consumer)
          return balance === 15 && at !== undefined && BigInt(at) > BigInt(committed)
        }),
      )
      yield* Fiber.interrupt(second)
      const resumed = seen.slice(before)
      expect(resumed.length).toBeGreaterThan(0)
      for (const sequence of resumed) expect(BigInt(sequence) > BigInt(committed)).toBe(true)
      expect(yield* balanceOf(account)).toMatchObject({ owner: "ada", balance: 15, version: 3 })
    })

  it.live("projects the feed, then resumes after a restart from the DynamoDB checkpoints", () =>
    restartScenario({
      consumer: "projections",
      accounts: ["a1", "a2"],
      ledger: "l1",
      onBatchDelay: Duration.zero,
    }).pipe(provide),
  )

  it.live("resumes after a restart the same way when onBatch is slower than the read model", () =>
    restartScenario({
      consumer: "projections-slow",
      accounts: ["s1", "s2"],
      ledger: "sl1",
      onBatchDelay: "250 millis",
    }).pipe(provide),
  )

  it.live("a second consumer process is refused the lease; another consumer is not", () =>
    Effect.gen(function* () {
      yield* Accounts.append({ accountId: "l1" }, [new Opened({ owner: "lee" })], 0)
      const holder = yield* runChangeFeed(changeFeed(feedOptions("leased")), { projections }).pipe(
        Effect.forkChild,
      )
      // The holder has taken the lease.
      yield* eventually(Effect.map(leaseOf("leased"), (lease) => lease !== undefined))
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

  /** A client whose requests go through `server`, on its way to DynamoDB Local. */
  const storeThrough = (server: LocalServer) =>
    CheckpointStore.layerDynamoDB({ tableName: checkpointTableName }).pipe(
      Layer.provide(
        DynamoClient.layer({ region: "us-east-1", endpoint: server.endpoint, credentials }),
      ),
    )

  it.live("every renewal hung on the wire is aborted, and the next process takes over", () =>
    Effect.gen(function* () {
      yield* Accounts.append({ accountId: "h1" }, [new Opened({ owner: "hal" })], 0)
      // Between the checkpoint store and DynamoDB Local: an UpdateItem (the renewal) goes
      // unanswered, everything else passes through.
      const server = yield* localServer(
        (seen) => (seen.operation === "UpdateItem" ? hang : passThrough),
        { upstream: ENDPOINT },
      )
      const startedAt = Date.now()
      // Inside the layer: destroying the client would close the connections anyway.
      yield* Effect.gen(function* () {
        const exit = yield* changeFeed({
          ...feedOptions("hung-renewal"),
          lease: { owner: "hung", duration: "2 seconds", renewEvery: "500 millis" },
        }).pipe(Stream.runDrain, Effect.exit)
        expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("ChangeFeedLeaseLost")
        // At the deadline and not before it, with each attempt aborted.
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1490)
        const renewals = server.of("UpdateItem")
        expect(renewals.length).toBeGreaterThanOrEqual(1)
        yield* server.until(() => renewals.every((renewal) => renewal.connectionClosed))
        expect(renewals.some((renewal) => renewal.answered)).toBe(false)
      }).pipe(Effect.provide(storeThrough(server)))
      // The release reached the table, though the feed need not wait for its answer, and
      // the next process takes the lease at once.
      yield* eventually(Effect.map(leaseOf("hung-renewal"), (lease) => lease === undefined))
      const [next] = yield* changeFeed(feedOptions("hung-renewal")).pipe(takeOne)
      expect(next!.records.length).toBeGreaterThan(0)
    }).pipe(provide),
  )

  it.live(
    "the first renewal hung on the wire is retried: the lease survives, the feed goes on",
    () =>
      Effect.gen(function* () {
        yield* Accounts.append({ accountId: "h2" }, [new Opened({ owner: "hope" })], 0)
        let renewals = 0
        const server = yield* localServer(
          (seen) => (seen.operation === "UpdateItem" && ++renewals === 1 ? hang : passThrough),
          { upstream: ENDPOINT },
        )
        const consumer = "hung-once"
        yield* Effect.gen(function* () {
          const committed: Array<ChangeFeedBatch> = []
          const fiber = yield* changeFeed({
            ...feedOptions(consumer),
            lease: { owner: "survivor", duration: "4 seconds", renewEvery: "1 second" },
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
          yield* server.until(() => server.of("UpdateItem").length === 1)
          const first = server.of("UpdateItem")[0]!
          yield* server.until(() => first.connectionClosed)
          expect(first.answered).toBe(false)
          yield* server.until(() => server.of("UpdateItem")[1]?.answered === true)
          // The retry reached the table, and the row is still the holder's.
          expect(yield* leaseOf(consumer)).toMatchObject({ owner: "survivor" })
          // The next renewal, past the first attempt's deadline, comes with the feed still up.
          yield* server.until(() => server.of("UpdateItem")[2]?.answered === true)
          expect(fiber.pollUnsafe()).toBeUndefined()
          // A record written after the hang is delivered and committed.
          const before = committed.length
          yield* Accounts.append({ accountId: "h2" }, [new Deposited({ amount: 1 })], 1)
          yield* eventually(Effect.sync(() => committed.length > before))
          // A rival is still refused.
          const store = yield* CheckpointStore
          const rival = yield* Effect.flip(
            store.acquireLease({ streamArn, consumer }, "rival", Duration.seconds(4)),
          )
          expect(rival).toMatchObject({ _tag: "ChangeFeedLeaseHeld", owner: "survivor" })
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(storeThrough(server)))
        yield* eventually(Effect.map(leaseOf(consumer), (lease) => lease === undefined))
      }).pipe(provide),
  )

  describe("a renewal that lands after the feed gave up on it", () => {
    it.live("can move the expiry back, and the holder's next renewal puts it right", () =>
      Effect.gen(function* () {
        yield* Accounts.append({ accountId: "h3" }, [new Opened({ owner: "ian" })], 0)
        let renewals = 0
        const server = yield* localServer(
          (seen) => (seen.operation === "UpdateItem" && ++renewals === 1 ? hang : passThrough),
          { upstream: ENDPOINT },
        )
        const consumer = "late-renewal"
        const duration = 4000
        const every = 1000
        const expiryIn = (seen: SeenRequest) =>
          Number(JSON.parse(seen.body).ExpressionAttributeValues[":expiresAt"].N)
        yield* Effect.gen(function* () {
          const fiber = yield* changeFeed({
            ...feedOptions(consumer),
            lease: {
              owner: "holder",
              duration: Duration.millis(duration),
              renewEvery: Duration.millis(every),
            },
          }).pipe(Stream.runDrain, Effect.forkChild)
          yield* server.until(() => server.of("UpdateItem")[1]?.answered === true)
          const [abandoned, retried] = server.of("UpdateItem")
          // The abandoned request reaches the table now, as a delayed packet would. It is
          // the holder's own row, so the condition passes and its older expiry is written.
          const landed = yield* server.land(abandoned!)
          expect(landed.status).toBe(200)
          expect(expiryIn(abandoned!)).toBeLessThan(expiryIn(retried!))
          const after = yield* leaseOf(consumer)
          expect(after?.owner).toBe("holder")
          expect(after!.expiresAt).toBeGreaterThanOrEqual(expiryIn(abandoned!))
          // The holder renews `every` after the retry started, before that older expiry.
          const retriedAt = expiryIn(retried!) - duration
          expect(retriedAt + every).toBeLessThan(expiryIn(abandoned!))
          // That renewal puts the expiry right, and the feed never noticed.
          yield* server.until(() => server.of("UpdateItem")[2]?.answered === true)
          expect((yield* leaseOf(consumer))!.expiresAt).toBeGreaterThan(expiryIn(retried!))
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(storeThrough(server)))
      }).pipe(provide),
    )

    it.live("can't recreate a released lease or take one back from a rival", () =>
      Effect.gen(function* () {
        yield* Accounts.append({ accountId: "h4" }, [new Opened({ owner: "joy" })], 0)
        const server = yield* localServer(
          (seen) => (seen.operation === "UpdateItem" ? hang : passThrough),
          { upstream: ENDPOINT },
        )
        const consumer = "late-after-loss"
        const exit = yield* changeFeed({
          ...feedOptions(consumer),
          lease: { owner: "gone", duration: "2 seconds", renewEvery: "500 millis" },
        }).pipe(Stream.runDrain, Effect.provide(storeThrough(server)), Effect.exit)
        expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("ChangeFeedLeaseLost")
        yield* eventually(Effect.map(leaseOf(consumer), (lease) => lease === undefined))
        const [one, two] = server.of("UpdateItem")
        expect(two).toBeDefined()

        // Released: the condition on `owner` finds no row, and writes none.
        const onReleased = yield* server.land(one!)
        expect(onReleased.status).toBe(400)
        expect(onReleased.body).toContain("ConditionalCheckFailedException")
        expect(yield* leaseOf(consumer)).toBeUndefined()

        // Taken: the condition finds the rival, and its expiry stands.
        const store = yield* CheckpointStore
        yield* store.acquireLease({ streamArn, consumer }, "rival", Duration.minutes(5))
        const taken = yield* leaseOf(consumer)
        const onTaken = yield* server.land(two!)
        expect(onTaken.status).toBe(400)
        expect(onTaken.body).toContain("ConditionalCheckFailedException")
        expect(yield* leaseOf(consumer)).toEqual(taken)
        expect(taken?.owner).toBe("rival")
        yield* store.releaseLease({ streamArn, consumer }, "rival")
      }).pipe(provide),
    )
  })

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
