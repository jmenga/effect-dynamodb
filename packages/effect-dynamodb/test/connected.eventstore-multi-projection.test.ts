/**
 * Connected integration tests for multi-source projections (#153),
 * tombstones (#154) and the outbox (#155) against a real DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Covers, end to end:
 *   - A field-mapped source plus a map field: a second instance arriving after
 *     legacy adoption (to the map), and before it (adopting the scalar — the
 *     documented risk), then `rebuild` repairing the scalar owned by the wrong
 *     instance.
 *   - Writers from different sources racing on one row, serialised by the
 *     revision: no part lost.
 *   - Tombstones: the entity reads none, redeliveries stay removed, a later
 *     event recreates the row, the TTL attribute.
 *   - The outbox in the read model's table and in a separate table:
 *     transactional commits, ordered drains under concurrent drainers, and
 *     `drainPending` over a sparse index.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

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

const AppSchema = DynamoSchema.make({ name: "multi-it", version: 1 })
const suffix = Date.now()
const eventsTableName = `multi-events-${suffix}`
const readTableName = `multi-read-${suffix}`
const outboxTableName = `multi-outbox-${suffix}`

class LineAdded extends Schema.TaggedClass<LineAdded>()("LineAdded", {
  shipmentId: Schema.String,
  qty: Schema.Number,
}) {}
class Scanned extends Schema.TaggedClass<Scanned>()("Scanned", { location: Schema.String }) {}
class Inspected extends Schema.TaggedClass<Inspected>()("Inspected", {
  shipmentId: Schema.String,
  score: Schema.Number,
}) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", { shipmentId: Schema.String }) {}

const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [LineAdded, Closed],
  streamId: { composite: ["orderId"] },
})
const Scans = EventStore.makeStream({
  table: EventsTable,
  streamName: "Scan",
  events: [Scanned],
  streamId: { composite: ["shipmentId"] },
})
const Inspections = EventStore.makeStream({
  table: EventsTable,
  streamName: "Inspection",
  events: [Inspected],
  streamId: { composite: ["inspectionId"] },
})

const Shipment = Schema.Struct({
  shipmentId: Schema.String,
  qty: Schema.Number,
  location: Schema.String,
  score: Schema.Number,
  inspectionVersion: Schema.Number,
  inspectionId: Schema.String,
  checkpoints: Schema.Record(Schema.String, Schema.Number),
  revision: Schema.Number,
})
type Shipment = typeof Shipment.Type

const Shipments = Entity.make({
  model: Shipment,
  entityType: "Shipment",
  primaryKey: {
    pk: { field: "pk", composite: ["shipmentId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
})
const ReadTable = Table.make({ schema: AppSchema, entities: { Shipments } })
const OutboxTable = Table.make({ schema: AppSchema, entities: {} })

const Notice = Schema.Struct({ shipmentId: Schema.String, what: Schema.String, n: Schema.Number })
type Notice = typeof Notice.Type

const initial = (key: { readonly shipmentId: string }): Shipment => ({
  shipmentId: key.shipmentId,
  qty: 0,
  location: "",
  score: 0,
  inspectionVersion: 0,
  inspectionId: "",
  checkpoints: {},
  revision: 0,
})

const sources = (source: EventStore.SourceBuilder<{ readonly shipmentId: string }, Shipment>) => ({
  order: source(Orders, {
    key: (_id, event) => ({ shipmentId: event.data.shipmentId }),
    evolve: (state, event) =>
      Effect.succeed(
        event.data._tag === "Closed"
          ? EventStore.removeRow
          : { ...state, qty: state.qty + event.data.qty },
      ),
  }),
  scan: source(Scans, {
    key: (id) => ({ shipmentId: id.shipmentId }),
    evolve: (state, event) => Effect.succeed({ ...state, location: event.data.location }),
    mode: "latest",
  }),
  inspection: source(Inspections, {
    key: (_id, event) => ({ shipmentId: event.data.shipmentId }),
    evolve: (state, event) => Effect.succeed({ ...state, score: state.score + event.data.score }),
  }),
})

const checkpoints = {
  field: "checkpoints" as const,
  sources: {
    inspection: { field: "inspectionVersion" as const, instanceField: "inspectionId" as const },
  },
}

const ShipmentProjection = EventStore.multiProjection({
  readModel: Shipments,
  initial,
  sources,
  checkpoints,
  revision: "revision",
  removal: { ttl: "7 days" },
  outbox: {
    schema: Notice,
    effects: (event, next) => [
      { shipmentId: next?.shipmentId ?? "removed", what: event.eventType, n: event.version },
    ],
  },
})

/** A claim shorter than a delivery: overlapping drainers re-claim each other's heads. */
const SlowDrainProjection = EventStore.multiProjection({
  readModel: Shipments,
  initial,
  sources,
  checkpoints,
  revision: "revision",
  outbox: {
    schema: Notice,
    effects: (event) => [{ shipmentId: event.streamId, what: event.eventType, n: event.version }],
    claimFor: "50 millis",
  },
})

const ElsewhereProjection = EventStore.multiProjection({
  readModel: Shipments,
  initial,
  sources,
  checkpoints,
  revision: "revision",
  outbox: {
    schema: Notice,
    effects: (event) => [{ shipmentId: event.streamId, what: event.eventType, n: event.version }],
    table: OutboxTable,
    index: { name: "pending", pk: "obpk", sk: "obsk" },
  },
})

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const TestLayer = Layer.mergeAll(
  DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials }),
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
  OutboxTable.layer({ name: outboxTableName }),
)
const provide = Effect.provide(TestLayer)

const tagged = <N extends string>(stream: N, events: ReadonlyArray<EventStore.StreamEvent<any>>) =>
  events.map((event) => ({ stream, event }))

const rawItems = (TableName: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Items = [] } = yield* client.scan({ TableName, ConsistentRead: true })
    return Items.map((item) => fromAttributeMap(item) as Record<string, unknown>)
  })

const shipment = (shipmentId: string) =>
  Effect.gen(function* () {
    const items = yield* rawItems(readTableName)
    // The row or its tombstone — not the outbox items in its partition.
    return items.find(
      (item) =>
        item.pk === `$multi-it#v1#shipment#shipmentid_${shipmentId}` &&
        (item.__edd_e__ === "Shipment" || item.__edd_e__ === "Shipment#tombstone"),
    )
  })

describeConnected("EventStore multi-source projections (connected)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const keySchema = [
          { AttributeName: "pk", KeyType: "HASH" as const },
          { AttributeName: "sk", KeyType: "RANGE" as const },
        ]
        const keys = [
          { AttributeName: "pk", AttributeType: "S" as const },
          { AttributeName: "sk", AttributeType: "S" as const },
        ]
        for (const TableName of [eventsTableName, readTableName]) {
          yield* client.createTable({
            TableName,
            BillingMode: "PAY_PER_REQUEST",
            KeySchema: keySchema,
            AttributeDefinitions: keys,
          })
        }
        yield* client.createTable({
          TableName: outboxTableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: keySchema,
          AttributeDefinitions: [
            ...keys,
            { AttributeName: "obpk", AttributeType: "S" },
            { AttributeName: "obsk", AttributeType: "S" },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "pending",
              KeySchema: [
                { AttributeName: "obpk", KeyType: "HASH" },
                { AttributeName: "obsk", KeyType: "RANGE" },
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
        for (const TableName of [eventsTableName, readTableName, outboxTableName]) {
          yield* client.deleteTable({ TableName })
        }
      }).pipe(
        provide,
        Effect.catch(() => Effect.void),
      ),
    )
  })

  it.effect(
    "field-mapped source + map: second instance before and after legacy adoption; rebuild repairs",
    () =>
      Effect.gen(function* () {
        // Legacy rows: inspection version 1 applied by instance "a", owner unrecorded.
        for (const shipmentId of ["after", "before"]) {
          yield* Shipments.put({
            ...initial({ shipmentId }),
            score: 5,
            inspectionVersion: 1,
          }).asEffect()
          yield* Inspections.append(
            { inspectionId: `${shipmentId}-a` },
            [new Inspected({ shipmentId, score: 5 }), new Inspected({ shipmentId, score: 1 })],
            0,
          )
          yield* Inspections.append(
            { inspectionId: `${shipmentId}-b` },
            [new Inspected({ shipmentId, score: 10 })],
            0,
          )
        }
        const read = (id: string) =>
          Inspections.read({ inspectionId: id }).pipe(Effect.map((e) => tagged("inspection", e)))

        // After adoption: "a" arrives first and adopts the scalar; "b" goes to the map.
        yield* ShipmentProjection.applyBatch(yield* read("after-a"))
        yield* ShipmentProjection.applyBatch(yield* read("after-b"))
        expect(yield* shipment("after")).toMatchObject({
          score: 16,
          inspectionVersion: 2,
          inspectionId: "after-a",
          checkpoints: { "inspection#after-b": 1 },
        })

        // Before adoption: "b" arrives first and adopts the scalar at version 1,
        // so its own version 1 is taken as applied — the documented risk.
        const wrong = yield* ShipmentProjection.applyBatch(yield* read("before-b"))
        const outcome = wrong.outcomes[0]!
        if (outcome._tag !== "Applied") throw new Error("not applied")
        expect(outcome.instances[0]!.alreadyApplied.map((e) => e.version)).toEqual([1])
        // Nothing new to write, so the row is untouched — "b"'s score is missing.
        expect(yield* shipment("before")).toMatchObject({ score: 5, inspectionId: "" })

        // `rebuild` names both instances: "a" (first by stream id) owns the scalar again.
        const rebuilt = yield* ShipmentProjection.rebuild(
          { shipmentId: "before" },
          {
            instances: { inspection: [{ inspectionId: "before-a" }, { inspectionId: "before-b" }] },
          },
        )
        expect(rebuilt.instances.map((i) => [i.streamId, i.version])).toEqual([
          ["before-a", 2],
          ["before-b", 1],
        ])
        expect(yield* shipment("before")).toMatchObject({
          score: 16,
          inspectionVersion: 2,
          inspectionId: "before-a",
          checkpoints: { "inspection#before-b": 1 },
        })
      }).pipe(provide),
  )

  it.live("writers from different sources racing on one row lose nothing", () =>
    Effect.gen(function* () {
      yield* Orders.append(
        { orderId: "race" },
        Array.from({ length: 12 }, () => new LineAdded({ shipmentId: "race", qty: 1 })),
        0,
      )
      yield* Scans.append(
        { shipmentId: "race" },
        Array.from({ length: 12 }, (_, i) => new Scanned({ location: `hop-${i + 1}` })),
        0,
      )
      yield* Inspections.append(
        { inspectionId: "race-i" },
        Array.from({ length: 12 }, () => new Inspected({ shipmentId: "race", score: 2 })),
        0,
      )
      const all = [
        ...tagged("order" as const, yield* Orders.read({ orderId: "race" })),
        ...tagged("scan" as const, yield* Scans.read({ shipmentId: "race" })),
        ...tagged("inspection" as const, yield* Inspections.read({ inspectionId: "race-i" })),
      ]
      const bound = yield* EventStore.bindProjection(ElsewhereProjection)
      // Every event its own concurrent call.
      const results = yield* Effect.forEach(all, (event) => bound.applyBatch([event]), {
        concurrency: "unbounded",
      })
      expect(results.flatMap((r) => r.outcomes).filter((o) => o._tag === "Failed")).toEqual([])
      const row = (yield* shipment("race")) as Shipment
      expect(row).toMatchObject({
        qty: 12,
        location: "hop-12",
        score: 24,
        inspectionVersion: 12,
        checkpoints: { "order#race": 12, "scan#race": 12 },
      })
    }).pipe(provide),
  )

  it.effect(
    "a tombstone keeps the checkpoints, reads as no row, and a later event recreates it",
    () =>
      Effect.gen(function* () {
        yield* Orders.append(
          { orderId: "gone" },
          [new LineAdded({ shipmentId: "gone", qty: 2 }), new Closed({ shipmentId: "gone" })],
          0,
        )
        yield* Scans.append({ shipmentId: "gone" }, [new Scanned({ location: "dock" })], 0)
        const orders = tagged("order" as const, yield* Orders.read({ orderId: "gone" }))
        yield* ShipmentProjection.applyBatch(orders)
        const tomb = (yield* shipment("gone"))!
        expect(tomb.__edd_e__).toBe("Shipment#tombstone")
        expect(tomb.checkpoints).toEqual({ "order#gone": 2 })
        expect(typeof tomb._ttl).toBe("number")
        const missing = yield* Effect.flip(Shipments.get({ shipmentId: "gone" }).asEffect())
        expect(missing._tag).toBe("ItemNotFound")
        // Redelivered: still removed.
        const again = yield* ShipmentProjection.applyBatch(orders)
        const outcome = again.outcomes[0]!
        if (outcome._tag !== "Applied") throw new Error("not applied")
        expect(outcome.removed).toBe(true)
        // Another source's event recreates the row from `initial`, the order checkpoint kept.
        const scans = tagged("scan" as const, yield* Scans.read({ shipmentId: "gone" }))
        yield* ShipmentProjection.applyBatch(scans)
        const back = yield* Shipments.get({ shipmentId: "gone" }).asEffect()
        expect(back).toMatchObject({
          qty: 0,
          location: "dock",
          checkpoints: { "order#gone": 2, "scan#gone": 1 },
        })
      }).pipe(provide),
  )

  it.live(
    "the outbox commits with the row and drains in order, once, under concurrent drainers",
    () =>
      Effect.gen(function* () {
        yield* Orders.append(
          { orderId: "ob" },
          Array.from({ length: 6 }, () => new LineAdded({ shipmentId: "ob", qty: 1 })),
          0,
        )
        const events = tagged("order" as const, yield* Orders.read({ orderId: "ob" }))
        // Three writes, two effects each — transactions that keep the row's `createdAt`.
        const createdAts: Array<unknown> = []
        for (const pair of [events.slice(0, 2), events.slice(2, 4), events.slice(4, 6)]) {
          yield* ShipmentProjection.applyBatch(pair)
          createdAts.push((yield* shipment("ob"))!.createdAt)
          yield* Effect.sleep("5 millis")
        }
        expect(new Set(createdAts).size).toBe(1)
        const outboxOf = (items: ReadonlyArray<Record<string, unknown>>) =>
          items.filter(
            (i) =>
              i.__edd_e__ === "Shipment#outbox" && i.pk === "$multi-it#v1#shipment#shipmentid_ob",
          )
        expect(outboxOf(yield* rawItems(readTableName))).toHaveLength(6)
        const delivered: Array<number> = []
        const drainers = yield* Effect.forEach(
          [1, 2, 3, 4],
          () =>
            ShipmentProjection.drain({ shipmentId: "ob" }, (effect) =>
              Effect.sync(() => {
                delivered.push(effect.n)
              }),
            ),
          { concurrency: "unbounded" },
        )
        // Any leftovers a stopped drainer left behind.
        yield* ShipmentProjection.drain({ shipmentId: "ob" }, (effect) =>
          Effect.sync(() => {
            delivered.push(effect.n)
          }),
        )
        expect(delivered).toEqual([1, 2, 3, 4, 5, 6])
        expect(drainers.reduce((n, d) => n + d.delivered, 0)).toBeLessThanOrEqual(6)
        expect(outboxOf(yield* rawItems(readTableName))).toEqual([])
      }).pipe(provide),
  )

  it.effect("a separate outbox table, swept by drainPending over its sparse index", () =>
    Effect.gen(function* () {
      yield* Scans.append({ shipmentId: "far" }, [new Scanned({ location: "a" })], 0)
      yield* Orders.append({ orderId: "far" }, [new LineAdded({ shipmentId: "far", qty: 1 })], 0)
      yield* ElsewhereProjection.applyBatch([
        ...tagged("scan" as const, yield* Scans.read({ shipmentId: "far" })),
        ...tagged("order" as const, yield* Orders.read({ orderId: "far" })),
      ])
      expect(
        (yield* rawItems(readTableName)).filter(
          (i) =>
            i.__edd_e__ === "Shipment#outbox" && i.pk === "$multi-it#v1#shipment#shipmentid_far",
        ),
      ).toEqual([])
      const elsewhere = (yield* rawItems(outboxTableName)).filter(
        (i) => i.__edd_e__ === "Shipment#outbox",
      )
      expect(elsewhere.length).toBeGreaterThanOrEqual(2)
      const seen: Array<string> = []
      const swept = yield* ElsewhereProjection.drainPending((effect, meta) =>
        Effect.sync(() => {
          seen.push(`${meta.source}:${(effect as Notice).what}`)
        }),
      )
      expect(swept.undelivered).toEqual([])
      expect(seen).toContain("scan:Scanned")
      expect(seen).toContain("order:LineAdded")
      void Option
    }).pipe(provide),
  )

  it.live("a delivery outlasting its claim still retires the effect: no livelock", () =>
    Effect.gen(function* () {
      yield* Orders.append(
        { orderId: "slow" },
        Array.from({ length: 3 }, () => new LineAdded({ shipmentId: "slow", qty: 1 })),
        0,
      )
      yield* SlowDrainProjection.applyBatch(
        tagged("order" as const, yield* Orders.read({ orderId: "slow" })),
      )
      const deliveries: Array<number> = []
      const deliver = (effect: Notice) =>
        Effect.sleep("150 millis").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              deliveries.push(effect.n)
            }),
          ),
        )
      yield* Effect.forEach(
        [1, 2],
        () => SlowDrainProjection.drain({ shipmentId: "slow" }, deliver),
        {
          concurrency: "unbounded",
        },
      )
      yield* SlowDrainProjection.drain({ shipmentId: "slow" }, deliver)
      // Every effect delivered, at least once, and the outbox emptied — bounded, not looping.
      expect([...new Set(deliveries)].sort()).toEqual([1, 2, 3])
      expect(deliveries.length).toBeLessThanOrEqual(6)
      expect(
        (yield* rawItems(readTableName)).filter(
          (i) =>
            i.__edd_e__ === "Shipment#outbox" && i.pk === "$multi-it#v1#shipment#shipmentid_slow",
        ),
      ).toEqual([])
    }).pipe(provide),
  )
})
