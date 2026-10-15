/**
 * Connected integration tests for optional projection fields (#158) against a
 * real DynamoDB Local: adopting rows written before the projection, which have
 * none of its checkpoint, instance, map or revision attributes.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Asserts on the raw stored items: the row keeps its own attributes, gains
 * only what the projection set, and an empty checkpoint map stays absent.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
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

const AppSchema = DynamoSchema.make({ name: "opt-it", version: 1 })
const suffix = Date.now()
const eventsTableName = `opt-events-${suffix}`
const readTableName = `opt-read-${suffix}`

class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
type OrderEvent = Placed | Added
class Inspected extends Schema.TaggedClass<Inspected>()("Inspected", {
  shipmentId: Schema.String,
  score: Schema.Number,
}) {}

const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Placed, Added],
  streamId: { composite: ["orderId"] },
})
const Inspections = EventStore.makeStream({
  table: EventsTable,
  streamName: "Inspection",
  events: [Inspected],
  streamId: { composite: ["inspectionId"] },
})

const Summary = Schema.Struct({
  orderId: Schema.String,
  total: Schema.Number,
  note: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Number),
  rev: Schema.optional(Schema.Number),
})
type Summary = typeof Summary.Type

const Summaries = Entity.make({
  model: Summary,
  entityType: "Summary",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
})

const Shipment = Schema.Struct({
  shipmentId: Schema.String,
  score: Schema.Number,
  note: Schema.optional(Schema.String),
  inspectionVersion: Schema.optional(Schema.Number),
  inspectionId: Schema.optional(Schema.String),
  checkpoints: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  revision: Schema.optional(Schema.Number),
})
type Shipment = typeof Shipment.Type

const Shipments = Entity.make({
  model: Shipment,
  entityType: "Shipment",
  primaryKey: {
    pk: { field: "pk", composite: ["shipmentId"] },
    sk: { field: "sk", composite: [] },
  },
})

const ReadTable = Table.make({ schema: AppSchema, entities: { Summaries, Shipments } })

const summaryBase = {
  stream: Orders,
  readModel: Summaries,
  key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
  initial: (id: { readonly orderId: string }): Summary => ({ orderId: id.orderId, total: 0 }),
  evolve: (state: Summary, event: EventStore.StreamEvent<OrderEvent>) =>
    Effect.succeed({ ...state, total: state.total + event.data.amount }),
}
const Unrevisioned = EventStore.projection({ ...summaryBase, checkpoint: "version" })
const Revisioned = EventStore.projection({
  ...summaryBase,
  checkpoint: "version",
  revision: "rev",
})

const ShipmentProjection = EventStore.multiProjection({
  readModel: Shipments,
  initial: (key: { readonly shipmentId: string }): Shipment => ({
    shipmentId: key.shipmentId,
    score: 0,
  }),
  sources: (source) => ({
    inspection: source(Inspections, {
      key: (_id, event) => ({ shipmentId: event.data.shipmentId }),
      evolve: (state, event) => Effect.succeed({ ...state, score: state.score + event.data.score }),
    }),
  }),
  checkpoints: {
    field: "checkpoints",
    sources: { inspection: { field: "inspectionVersion", instanceField: "inspectionId" } },
  },
  revision: "revision",
})

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const TestLayer = Layer.mergeAll(
  DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials }),
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
)
const provide = Effect.provide(TestLayer)

/** Put a row as it was before the projection: domain fields only. */
const putLegacy = (entityType: string, id: string, fields: Record<string, unknown>) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const prefix = `$opt-it#v1#${entityType.toLowerCase()}`
    const idField = entityType === "Summary" ? "orderid" : "shipmentid"
    yield* client.putItem({
      TableName: readTableName,
      Item: toAttributeMap({
        pk: `${prefix}#${idField}_${id}`,
        sk: prefix,
        __edd_e__: entityType,
        ...fields,
      }),
    })
  })

const raw = (entityType: string, id: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const prefix = `$opt-it#v1#${entityType.toLowerCase()}`
    const idField = entityType === "Summary" ? "orderid" : "shipmentid"
    const { Item } = yield* client.getItem({
      TableName: readTableName,
      Key: toAttributeMap({ pk: `${prefix}#${idField}_${id}`, sk: prefix }),
      ConsistentRead: true,
    })
    return Item === undefined ? undefined : (fromAttributeMap(Item) as Record<string, unknown>)
  })

const sorted = (item: Record<string, unknown> | undefined) => Object.keys(item ?? {}).sort()

describeConnected("EventStore projections over rows without their fields (connected)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const TableName of [eventsTableName, readTableName]) {
          yield* client.createTable({
            TableName,
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
        }
      }).pipe(provide),
    )
  })

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const TableName of [eventsTableName, readTableName]) {
          yield* client.deleteTable({ TableName }).pipe(Effect.ignore)
        }
      }).pipe(provide),
    )
  })

  it.effect("a single-source projection adopts a row without a checkpoint", () =>
    Effect.gen(function* () {
      yield* putLegacy("Summary", "o1", { orderId: "o1", total: 10, note: "kept" })
      yield* Orders.append({ orderId: "o1" }, [new Placed({ amount: 1 })], 0)
      yield* Orders.append({ orderId: "o1" }, [new Added({ amount: 2 })], 1)
      const events = yield* Orders.read({ orderId: "o1" })

      // Version 1 alone: the write is guarded by attribute_not_exists(version).
      yield* Unrevisioned.apply(events[0]!)
      const first = yield* raw("Summary", "o1")
      expect(first).toMatchObject({ orderId: "o1", total: 11, note: "kept", version: 1 })
      expect(sorted(first)).toEqual(
        ["__edd_e__", "note", "orderId", "pk", "sk", "total", "version"].sort(),
      )

      // Then version 2, and a redelivery of version 1 changes nothing.
      yield* Unrevisioned.applyBatch(events)
      expect(yield* raw("Summary", "o1")).toMatchObject({ total: 13, version: 2 })
    }).pipe(provide),
  )

  it.effect("an absent revision is conditioned on attribute_not_exists and starts at 1", () =>
    Effect.gen(function* () {
      yield* putLegacy("Summary", "o2", { orderId: "o2", total: 0 })
      yield* Orders.append({ orderId: "o2" }, [new Placed({ amount: 4 })], 0)
      yield* Revisioned.applyBatch(yield* Orders.read({ orderId: "o2" }))
      const row = yield* raw("Summary", "o2")
      expect(row).toMatchObject({ total: 4, version: 1, rev: 1 })
      expect(row).not.toHaveProperty("note")
    }).pipe(provide),
  )

  it.effect("a multi-source projection adopts an unowned row, its map absent until used", () =>
    Effect.gen(function* () {
      yield* putLegacy("Shipment", "s1", { shipmentId: "s1", score: 5, note: "kept" })
      yield* Inspections.append(
        { inspectionId: "i1" },
        [
          new Inspected({ shipmentId: "s1", score: 1 }),
          new Inspected({ shipmentId: "s1", score: 2 }),
        ],
        0,
      )
      const first = (yield* Inspections.read({ inspectionId: "i1" })).map((event) => ({
        stream: "inspection" as const,
        event,
      }))
      const result = yield* ShipmentProjection.applyBatch(first)
      expect(result.failedPositions).toEqual([])
      const adopted = yield* raw("Shipment", "s1")
      expect(adopted).toMatchObject({
        score: 8,
        note: "kept",
        inspectionVersion: 2,
        inspectionId: "i1",
        revision: 1,
      })
      // The map gained no entries: it is not written.
      expect(sorted(adopted)).toEqual(
        [
          "__edd_e__",
          "inspectionId",
          "inspectionVersion",
          "note",
          "pk",
          "revision",
          "score",
          "shipmentId",
          "sk",
        ].sort(),
      )

      // A second instance goes to the map, which now exists.
      yield* Inspections.append(
        { inspectionId: "i2" },
        [new Inspected({ shipmentId: "s1", score: 4 })],
        0,
      )
      const second = (yield* Inspections.read({ inspectionId: "i2" })).map((event) => ({
        stream: "inspection" as const,
        event,
      }))
      yield* ShipmentProjection.applyBatch(second)
      expect(yield* raw("Shipment", "s1")).toMatchObject({
        score: 12,
        inspectionVersion: 2,
        inspectionId: "i1",
        checkpoints: { "inspection#i2": 1 },
        revision: 2,
      })

      // Redelivering both instances' events changes nothing.
      yield* ShipmentProjection.applyBatch([...first, ...second])
      expect(yield* raw("Shipment", "s1")).toMatchObject({ score: 12, revision: 2 })
    }).pipe(provide),
  )
})
