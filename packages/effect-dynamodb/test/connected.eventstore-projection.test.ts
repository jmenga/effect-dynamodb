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
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Data, Effect, Layer, Option, Schema } from "effect"
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

class Placed extends Schema.TaggedClass<Placed>()("Placed", { zone: Schema.String }) {}
class Reading extends Schema.TaggedClass<Reading>()("Reading", {
  zone: Schema.String,
  value: Schema.Number,
}) {}

const Devices = EventStore.makeStream({
  table: EventsTable,
  streamName: "Device",
  events: [Placed, Reading],
  streamId: { composite: ["deviceId"] },
})

/** One row per device and zone — the zone comes from each event. */
const ZoneTotal = Schema.Struct({
  deviceId: Schema.String,
  zone: Schema.String,
  total: Schema.Number,
  placed: Schema.Boolean,
  seq: Schema.Number,
  lookup: DynamoModel.Hidden(Schema.String),
})

const ZoneTotals = Entity.make({
  model: ZoneTotal,
  entityType: "ZoneTotal",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: ["zone"] },
  },
  timestamps: true,
})

const ReadTable = Table.make({ schema: AppSchema, entities: { Balances, ZoneTotals } })

class NotPlaced extends Data.TaggedError("NotPlaced")<{ readonly version: number }> {}

const zoneConfig = {
  stream: Devices,
  readModel: ZoneTotals,
  key: (id: { readonly deviceId: string }, event: EventStore.StreamEvent<Placed | Reading>) => ({
    deviceId: id.deviceId,
    zone: event.data.zone,
  }),
  initial: (
    id: { readonly deviceId: string },
    event: EventStore.StreamEvent<Placed | Reading>,
  ) => ({
    deviceId: id.deviceId,
    zone: event.data.zone,
    total: 0,
    placed: false,
    seq: 0,
    lookup: "",
  }),
  evolve: (state: typeof ZoneTotal.Type, event: EventStore.StreamEvent<Placed | Reading>) =>
    Effect.gen(function* () {
      const data = event.data
      if (data._tag === "Placed") return { ...state, placed: true }
      if (!state.placed) return yield* new NotPlaced({ version: event.version })
      return { ...state, total: state.total + data.value }
    }),
  checkpoint: "seq" as const,
  toItem: (state: typeof ZoneTotal.Type) => ({ ...state, lookup: `${state.zone}#${state.total}` }),
}

/** A reading of a zone never placed is rejected — acknowledged, writing nothing. */
const ZoneProjection = EventStore.projection({
  ...zoneConfig,
  terminal: (error) => error._tag === "NotPlaced",
})
/** The same, failing the row instead. */
const StrictZoneProjection = EventStore.projection(zoneConfig)

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

  it.live("concurrent batches racing on one instance apply each event exactly once", () =>
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
      expect(Option.getOrThrow(first.state).version).toBe(1)
      const again = yield* projection.applyBatch(events)
      const outcome = again.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(outcome.applied.map((e) => e.version)).toEqual([3])
      expect(Option.getOrThrow(outcome.state).version).toBe(2)
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

      const { rows } = yield* BalanceProjection.rebuild({ accountId: "dlq" })
      expect(rows.map((r) => r.version)).toEqual([4])
      expect(Option.getOrThrow(rows[0]!.state)).toMatchObject({
        balance: 6,
        deposits: 3,
        version: 4,
      })
      const empty = yield* BalanceProjection.rebuild({ accountId: "never" })
      expect(empty).toEqual({ rows: [] })
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

  it.effect("moves a stream's events between rows mid-stream", () =>
    Effect.gen(function* () {
      yield* Devices.append(
        { deviceId: "d1" },
        [
          new Placed({ zone: "north" }),
          new Reading({ zone: "north", value: 5 }),
          new Placed({ zone: "south" }),
          new Reading({ zone: "south", value: 7 }),
          new Reading({ zone: "north", value: 1 }),
        ],
        0,
      )
      const events = yield* Devices.read({ deviceId: "d1" })
      const bound = yield* EventStore.bindProjection(ZoneProjection)
      // Delivered out of order across two batches.
      const first = yield* bound.applyBatch([events[4]!, events[3]!])
      expect(
        first.outcomes.map((o) =>
          o._tag === "Applied" ? [o.key, o.applied.map((e) => e.version), o.version] : o._tag,
        ),
      ).toEqual([
        [{ deviceId: "d1", zone: "north" }, [1, 2, 5], 5],
        [{ deviceId: "d1", zone: "south" }, [3, 4], 4],
      ])
      const late = yield* bound.applyBatch(events.slice(0, 3))
      expect(late.outcomes.every((o) => o._tag === "Applied" && o.applied.length === 0)).toBe(true)
      const north = yield* Entity.asItem(
        Entity.consistentRead(ZoneTotals.get({ deviceId: "d1", zone: "north" })),
      )
      const south = yield* Entity.asItem(
        Entity.consistentRead(ZoneTotals.get({ deviceId: "d1", zone: "south" })),
      )
      expect(north).toMatchObject({ total: 6, seq: 5, lookup: "north#6" })
      expect(south).toMatchObject({ total: 7, seq: 4, lookup: "south#7" })
    }).pipe(provide),
  )

  it.effect("an update to a row never created fails typed and writes nothing", () =>
    Effect.gen(function* () {
      yield* Devices.append(
        { deviceId: "d2" },
        [new Reading({ zone: "east", value: 3 }), new Placed({ zone: "east" })],
        0,
      )
      const [reading, placed] = yield* Devices.read({ deviceId: "d2" })
      const missing = () =>
        Effect.flip(ZoneTotals.get({ deviceId: "d2", zone: "east" }).asEffect()).pipe(
          Effect.map((e) => e._tag),
        )
      // Without `terminal`: the row fails with the typed error.
      const error = yield* Effect.flip(StrictZoneProjection.apply(reading!))
      expect(error).toEqual(new NotPlaced({ version: 1 }))
      expect(yield* missing()).toBe("ItemNotFound")
      // With `terminal`: rejected, acknowledged, nothing written.
      const rejected = yield* ZoneProjection.apply(reading!)
      expect(rejected.rejected.map((r) => r.error)).toEqual([new NotPlaced({ version: 1 })])
      expect(rejected.state).toEqual(Option.none())
      expect(yield* missing()).toBe("ItemNotFound")
      // The placing event then starts the row; the reading stays rejected.
      const started = yield* ZoneProjection.apply(placed!)
      expect(started.applied.map((e) => e.version)).toEqual([2])
      expect(started.rejected.map((r) => r.event.version)).toEqual([1])
      expect(Option.getOrThrow(started.state)).toMatchObject({ placed: true, total: 0, seq: 2 })
    }).pipe(provide),
  )

  it.live("keeps createdAt and Hidden fields across projection writes", () =>
    Effect.gen(function* () {
      yield* Devices.append(
        { deviceId: "d3" },
        [new Placed({ zone: "west" }), new Reading({ zone: "west", value: 2 })],
        0,
      )
      const [placed, reading] = yield* Devices.read({ deviceId: "d3" })
      // Without `toItem`, an unchanged state must keep the Hidden field it read.
      const plain = EventStore.projection({
        ...zoneConfig,
        evolve: (state: typeof ZoneTotal.Type) => Effect.succeed({ ...state, lookup: "kept" }),
        toItem: undefined,
      })
      yield* plain.apply(placed!)
      const row = () =>
        Entity.asItem(Entity.consistentRead(ZoneTotals.get({ deviceId: "d3", zone: "west" })))
      const before = yield* row()
      yield* Effect.sleep("30 millis")
      const unchanged = EventStore.projection({
        ...zoneConfig,
        evolve: (state: typeof ZoneTotal.Type) => Effect.succeed(state),
        toItem: undefined,
      })
      yield* unchanged.apply(reading!)
      const after = yield* row()
      expect(after.seq).toBe(2)
      expect(after.lookup).toBe("kept")
      expect(String(after.createdAt)).toBe(String(before.createdAt))
      expect(String(after.updatedAt)).not.toBe(String(before.updatedAt))
    }).pipe(provide),
  )

  it.live("24 racing single-event deliveries all succeed under the default retry", () =>
    Effect.gen(function* () {
      const n = 24
      yield* Accounts.append(
        { accountId: "race24" },
        [new Opened({ owner: "gu" }), ...deposits(n - 1)],
        0,
      )
      const events = yield* Accounts.read({ accountId: "race24" })
      const bound = yield* EventStore.bindProjection(BalanceProjection)
      const results = yield* Effect.forEach(events, (event) => bound.applyBatch([event]), {
        concurrency: "unbounded",
      })
      const outcomes = results.flatMap((r) => r.outcomes)
      expect(outcomes.filter((o) => o._tag === "Failed")).toEqual([])
      expect(appliedVersions(outcomes)).toEqual(Array.from({ length: n }, (_, i) => i + 1))
    }).pipe(provide),
  )

  it.effect(
    "maps processBatch positions to records and routes one feed to several projections",
    () =>
      Effect.gen(function* () {
        yield* Accounts.append({ accountId: "feed" }, [new Opened({ owner: "ha" })], 0)
        yield* Devices.append({ deviceId: "feed" }, [new Reading({ zone: "z", value: 1 })], 0)
        const [account] = yield* eventItems("feed")
        const device = yield* Effect.gen(function* () {
          const client = yield* DynamoClient
          const result = yield* client.query({
            TableName: eventsTableName,
            KeyConditionExpression: "#pk = :pk",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: { ":pk": { S: "$proj-it#v1#device#feed" } },
            ConsistentRead: true,
          })
          return (result.Items ?? [])[0] as Item
        })
        const modify = { ...recordOf(account!), eventName: "MODIFY" }
        const records = [modify, recordOf(device), recordOf(account!)]
        const single = yield* BalanceProjection.processBatch(records, { source: "lambda" })
        expect(single.outcomes.map((o) => o.positions)).toEqual([[2]])
        const result = yield* EventStore.processBatch(records, {
          projections: { balances: BalanceProjection, zones: StrictZoneProjection },
          source: "pipe",
        })
        expect(result.outcomes.balances.map((o) => [o._tag, o.positions])).toEqual([
          ["Applied", [2]],
        ])
        expect(result.outcomes.zones.map((o) => [o._tag, o.positions])).toEqual([["Failed", [1]]])
        expect(result.response).toEqual({
          batchItemFailures: [{ itemIdentifier: records[1]!.eventID! }],
        })
      }).pipe(provide),
  )
})
