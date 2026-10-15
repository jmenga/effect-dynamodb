/**
 * Connected integration tests for EventStore change-feed projections (#151)
 * against a real DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Covers, end to end:
 *   - A stream on one table projected into a read model on another (with
 *     timestamps and a GSI), fed Lambda-shaped records built from the stored
 *     items — reversed and split across batches, with redeliveries: every
 *     event applied exactly once, the row and its GSI entry current.
 *   - Concurrent `applyBatch` calls racing on one stream instance: each event
 *     in exactly one call's `applied`, the rest in `alreadyApplied`.
 *   - A checkpoint offset, `catchUp` and `rebuild` against real conditions.
 *   - `processBatch` with a record that fails to decode, per source.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
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

const AppSchema = DynamoSchema.make({ name: "proj-it", version: 1 })
const eventsTableName = `proj-events-${Date.now()}`
const readTableName = `proj-read-${Date.now()}`

class Opened extends Schema.TaggedClass<Opened>()("Opened", { owner: Schema.String }) {}
class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {}) {}
type AccountEvent = Opened | Deposited | Closed

const EventsTable = Table.make({ schema: AppSchema, entities: {} })

const Accounts = EventStore.makeStream({
  table: EventsTable,
  streamName: "Account",
  events: [Opened, Deposited, Closed],
  streamId: { composite: ["accountId"] },
})

const Balance = Schema.Struct({
  accountId: Schema.String,
  owner: Schema.String,
  status: Schema.String,
  balance: Schema.Number,
  deposits: Schema.Number,
  version: Schema.Number,
})
type Balance = typeof Balance.Type

const Balances = Entity.make({
  model: Balance,
  entityType: "Balance",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byStatus: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["status"] },
      sk: { field: "gsi1sk", composite: ["accountId"] },
    },
  },
  timestamps: true,
})

const ReadTable = Table.make({ schema: AppSchema, entities: { Balances } })

const evolve = (state: Balance, event: EventStore.StreamEvent<AccountEvent>) => {
  const data = event.data
  switch (data._tag) {
    case "Opened":
      return Effect.succeed({ ...state, owner: data.owner, status: "open" })
    case "Deposited":
      return Effect.succeed({
        ...state,
        balance: state.balance + data.amount,
        deposits: state.deposits + 1,
      })
    case "Closed":
      return Effect.succeed({ ...state, status: "closed" })
  }
}

const initial = (id: { readonly accountId: string }): Balance => ({
  accountId: id.accountId,
  owner: "",
  status: "new",
  balance: 0,
  deposits: 0,
  version: 0,
})

const BalanceProjection = EventStore.projection({
  stream: Accounts,
  readModel: Balances,
  key: (id) => ({ accountId: id.accountId }),
  initial,
  evolve,
  checkpoint: "version",
})

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const TestLayer = Layer.mergeAll(
  ClientLayer,
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
)
const provide = Effect.provide(TestLayer)

type Item = Record<string, AttributeValue>

/** The stored event items of one account, in version order. */
const eventItems = (accountId: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const result = yield* client.query({
      TableName: eventsTableName,
      KeyConditionExpression: "#pk = :pk",
      FilterExpression: "#e = :e",
      ExpressionAttributeNames: { "#pk": "pk", "#e": "__edd_e__" },
      ExpressionAttributeValues: {
        ":pk": { S: `$proj-it#v1#account#${accountId}` },
        ":e": { S: Accounts.eventMarker },
      },
      ConsistentRead: true,
    })
    return (result.Items ?? []) as Array<Item>
  })

let sequence = 0
/** A Lambda-shaped `INSERT` record of a stored item. */
const recordOf = (item: Item): EventStore.StreamRecord => {
  sequence++
  return {
    eventID: `event-${sequence}`,
    eventName: "INSERT",
    dynamodb: { SequenceNumber: String(sequence).padStart(21, "0"), NewImage: item as never },
  }
}

const deposits = (n: number) =>
  Array.from({ length: n }, (_, i) => new Deposited({ amount: i + 1 }))

/** Every version applied across outcomes, sorted. */
const appliedVersions = (
  outcomes: ReadonlyArray<EventStore.ProjectionOutcome<Balance, AccountEvent, any, unknown>>,
) =>
  outcomes
    .flatMap((o) => (o._tag === "Applied" ? o.applied.map((e) => e.version) : []))
    .sort((a, b) => a - b)

describeConnected("EventStore projections (connected)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: eventsTableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
        })
        yield* client.createTable({
          TableName: readTableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            { AttributeName: "gsi1pk", AttributeType: "S" },
            { AttributeName: "gsi1sk", AttributeType: "S" },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "gsi1",
              KeySchema: [
                { AttributeName: "gsi1pk", KeyType: "HASH" },
                { AttributeName: "gsi1sk", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
        })
      }).pipe(provide),
    )
  })

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: eventsTableName })
        yield* client.deleteTable({ TableName: readTableName })
      }).pipe(
        provide,
        Effect.catch(() => Effect.void),
      ),
    )
  })

  it.effect("applies reversed, split and redelivered batches exactly once", () =>
    Effect.gen(function* () {
      yield* Accounts.append({ accountId: "a1" }, [new Opened({ owner: "ada" }), ...deposits(4)], 0)
      yield* Accounts.append({ accountId: "a1" }, [new Closed({})], 5)
      yield* Accounts.append({ accountId: "a2" }, [new Opened({ owner: "bo" }), ...deposits(2)], 0)
      const a1 = yield* eventItems("a1")
      const a2 = yield* eventItems("a2")
      expect(a1).toHaveLength(6)

      // Batch 1: a1's tail reversed (5, 4) — 1–3 still queued — and a2's 3.
      const batch1 = [recordOf(a1[4]!), recordOf(a1[3]!), recordOf(a2[2]!)]
      // Batch 2: a1's 1–3 arrive late, 6 arrives, 4 is redelivered; a2's 1–2.
      const batch2 = [a1[0]!, a1[3]!, a1[1]!, a2[0]!, a1[5]!, a1[2]!, a2[1]!].map(recordOf)

      const bound = yield* EventStore.bindProjection(BalanceProjection)
      const first = yield* bound.processBatch(batch1, { source: "lambda" })
      expect(first.response).toEqual({ batchItemFailures: [] })
      expect(appliedVersions(first.outcomes)).toEqual([1, 1, 2, 2, 3, 3, 4, 5])
      const second = yield* bound.processBatch(batch2, { source: "lambda" })
      expect(second.response).toEqual({ batchItemFailures: [] })
      const a1Second = second.outcomes.find((o) => o.streamId === "a1")!
      if (a1Second._tag !== "Applied") throw new Error("not applied")
      expect(a1Second.applied.map((e) => e.version)).toEqual([6])
      expect(a1Second.alreadyApplied.map((e) => e.version)).toEqual([1, 2, 3, 4])

      const db = yield* DynamoClient.make({ entities: { Balances } })
      const row = yield* db.entities.Balances.get({ accountId: "a1" })
      expect(row).toMatchObject({
        accountId: "a1",
        owner: "ada",
        status: "closed",
        balance: 10,
        deposits: 4,
        version: 6,
      })
      const closed = yield* db.entities.Balances.byStatus({ status: "closed" }).collect()
      expect(closed.map((b) => b.accountId)).toEqual(["a1"])
      const open = yield* db.entities.Balances.byStatus({ status: "open" }).collect()
      expect(open.map((b) => [b.accountId, b.balance, b.version])).toEqual([["a2", 3, 3]])
    }).pipe(provide),
  )

  it.effect("concurrent batches racing on one instance apply each event exactly once", () =>
    Effect.gen(function* () {
      const n = 24
      yield* Accounts.append(
        { accountId: "race" },
        [new Opened({ owner: "cy" }), ...deposits(n - 1)],
        0,
      )
      const events = yield* Accounts.read({ accountId: "race" })
      const bound = yield* EventStore.bindProjection(BalanceProjection)
      // Eight overlapping deliveries, each a different shuffled slice.
      const slices = Array.from({ length: 8 }, (_, k) =>
        events.filter((_, i) => (i * 7 + k) % 3 !== 0).reverse(),
      )
      const results = yield* Effect.forEach(slices, (slice) => bound.applyBatch(slice), {
        concurrency: "unbounded",
      })
      const outcomes = results.flatMap((r) => r.outcomes)
      expect(outcomes.every((o) => o._tag === "Applied")).toBe(true)
      expect(appliedVersions(outcomes)).toEqual(Array.from({ length: n }, (_, i) => i + 1))
      const row = yield* Entity.consistentRead(Balances.get({ accountId: "race" }))
      expect(row.version).toBe(n)
      expect(row.deposits).toBe(n - 1)
      expect(row.balance).toBe(((n - 1) * n) / 2)
    }).pipe(provide),
  )

  it.effect("keeps the checkpoint through an offset under real conditions", () =>
    Effect.gen(function* () {
      const projection = EventStore.projection({
        stream: Accounts,
        readModel: Balances,
        key: (id) => ({ accountId: id.accountId }),
        initial,
        evolve,
        checkpoint: { field: "version", offset: -1 },
      })
      yield* Accounts.append(
        { accountId: "zero" },
        [new Opened({ owner: "di" }), ...deposits(2)],
        0,
      )
      const events = yield* Accounts.read({ accountId: "zero" })
      const first = yield* projection.apply(events[1]!)
      expect(first.applied.map((e) => e.version)).toEqual([1, 2])
      expect(first.state.version).toBe(1)
      const again = yield* projection.applyBatch(events)
      const outcome = again.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(outcome.applied.map((e) => e.version)).toEqual([3])
      expect(outcome.state.version).toBe(2)
      expect(outcome.version).toBe(3)
    }).pipe(provide),
  )

  it.effect("catchUp brings a row to the head and rebuild re-derives it", () =>
    Effect.gen(function* () {
      yield* Accounts.append({ accountId: "dlq" }, [new Opened({ owner: "ed" }), ...deposits(3)], 0)
      const events = yield* Accounts.read({ accountId: "dlq" })
      yield* BalanceProjection.apply(events[1]!)
      // Version 4 was dead-lettered and never redelivered.
      const caught = yield* BalanceProjection.catchUp({ accountId: "dlq" })
      expect(caught.applied.map((e) => e.version)).toEqual([3, 4])
      expect(Option.getOrThrow(caught.state).balance).toBe(6)

      const rebuilt = yield* BalanceProjection.rebuild({ accountId: "dlq" })
      expect(rebuilt.version).toBe(4)
      expect(Option.getOrThrow(rebuilt.state)).toMatchObject({
        balance: 6,
        deposits: 3,
        version: 4,
      })
      const empty = yield* BalanceProjection.rebuild({ accountId: "never" })
      expect(empty).toEqual({ state: Option.none(), version: 0 })
    }).pipe(provide),
  )

  it.effect("reports a record that fails to decode, by sequence number or event id", () =>
    Effect.gen(function* () {
      yield* Accounts.append({ accountId: "poison" }, [new Opened({ owner: "fi" })], 0)
      const [good] = yield* eventItems("poison")
      const poison = recordOf({ ...good!, version: { S: "one" } })
      const records = [recordOf(good!), poison]
      const lambda = yield* BalanceProjection.processBatch(records, { source: "lambda" })
      expect(lambda.decodeFailures.map((f) => f.record)).toEqual([poison])
      expect(lambda.response).toEqual({
        batchItemFailures: [{ itemIdentifier: poison.dynamodb!.SequenceNumber! }],
      })
      const pipe = yield* BalanceProjection.processBatch(records, { source: "pipe" })
      expect(pipe.response).toEqual({ batchItemFailures: [{ itemIdentifier: poison.eventID! }] })
    }).pipe(provide),
  )
})
