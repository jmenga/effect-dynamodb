/**
 * Connected integration tests for projections over a `DynamoModel.configure`d
 * read model (#160) against a real DynamoDB Local: a row read back holds only
 * the model's fields, never the table's keys or marker.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Single-source and multi-source, through an already-applied redelivery and
 * `catchUp`.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
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

const AppSchema = DynamoSchema.make({ name: "cfg-it", version: 1 })
const suffix = Date.now()
const eventsTableName = `cfg-events-${suffix}`
const readTableName = `cfg-read-${suffix}`

class Placed extends Schema.TaggedClass<Placed>()("Placed", {
  shipmentId: Schema.String,
  amount: Schema.Number,
}) {}

const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Placed],
  streamId: { composite: ["orderId"] },
})

const Summary = Schema.Struct({
  orderId: Schema.String,
  total: Schema.Number,
  searchKey: DynamoModel.Hidden(Schema.String),
  version: Schema.Number,
})
type Summary = typeof Summary.Type

const Summaries = Entity.make({
  model: DynamoModel.configure(Summary, { total: { field: "amt" } }),
  entityType: "Summary",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
})

const Shipment = Schema.Struct({
  shipmentId: Schema.String,
  total: Schema.Number,
  searchKey: DynamoModel.Hidden(Schema.String),
  checkpoints: Schema.Record(Schema.String, Schema.Number),
  revision: Schema.Number,
})
type Shipment = typeof Shipment.Type

const Shipments = Entity.make({
  model: DynamoModel.configure(Shipment, { total: { field: "amt" } }),
  entityType: "Shipment",
  primaryKey: {
    pk: { field: "pk", composite: ["shipmentId"] },
    sk: { field: "sk", composite: [] },
  },
})

const ReadTable = Table.make({ schema: AppSchema, entities: { Summaries, Shipments } })

const SummaryProjection = EventStore.projection({
  stream: Orders,
  readModel: Summaries,
  key: (id) => ({ orderId: id.orderId }),
  initial: (id): Summary => ({
    orderId: id.orderId,
    total: 0,
    searchKey: `order#${id.orderId}`,
    version: 0,
  }),
  evolve: (state, event) => Effect.succeed({ ...state, total: state.total + event.data.amount }),
  checkpoint: "version",
})

const ShipmentProjection = EventStore.multiProjection({
  readModel: Shipments,
  initial: (key: { readonly shipmentId: string }): Shipment => ({
    shipmentId: key.shipmentId,
    total: 0,
    searchKey: `shipment#${key.shipmentId}`,
    checkpoints: {},
    revision: 0,
  }),
  sources: (source) => ({
    order: source(Orders, {
      key: (_id, event) => ({ shipmentId: event.data.shipmentId }),
      evolve: (state, event) =>
        Effect.succeed({ ...state, total: state.total + event.data.amount }),
    }),
  }),
  checkpoints: { field: "checkpoints" },
  revision: "revision",
})

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const TestLayer = Layer.mergeAll(
  DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials }),
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
)
const provide = Effect.provide(TestLayer)

const keysOf = (state: Option.Option<unknown>) =>
  Object.keys(Option.getOrThrow(state) as object).sort()

describeConnected("EventStore projections over a configured read model (connected)", () => {
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
        yield* Orders.append(
          { orderId: "o1" },
          [
            new Placed({ shipmentId: "s1", amount: 1 }),
            new Placed({ shipmentId: "s1", amount: 2 }),
          ],
          0,
        )
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

  it.effect("single-source: the row read back holds only the model's fields", () =>
    Effect.gen(function* () {
      const events = yield* Orders.read({ orderId: "o1" })
      yield* SummaryProjection.applyBatch(events)
      const redelivered = yield* SummaryProjection.applyBatch(events)
      const outcome = redelivered.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(Option.getOrThrow(outcome.state)).toEqual({
        orderId: "o1",
        total: 3,
        searchKey: "order#o1",
        version: 2,
      })
      const caughtUp = yield* SummaryProjection.catchUp({ orderId: "o1" })
      expect(keysOf(caughtUp.state)).toEqual(["orderId", "searchKey", "total", "version"])
    }).pipe(provide),
  )

  it.effect("multi-source: the row read back holds only the model's fields", () =>
    Effect.gen(function* () {
      const events = (yield* Orders.read({ orderId: "o1" })).map((event) => ({
        stream: "order" as const,
        event,
      }))
      yield* ShipmentProjection.applyBatch(events)
      const redelivered = yield* ShipmentProjection.applyBatch(events)
      const outcome = redelivered.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(Option.getOrThrow(outcome.state)).toEqual({
        shipmentId: "s1",
        total: 3,
        searchKey: "shipment#s1",
        checkpoints: { "order#o1": 2 },
        revision: 1,
      })
      const caughtUp = yield* ShipmentProjection.catchUp({ shipmentId: "s1" })
      expect(keysOf(caughtUp.state)).toEqual([
        "checkpoints",
        "revision",
        "searchKey",
        "shipmentId",
        "total",
      ])
    }).pipe(provide),
  )
})
