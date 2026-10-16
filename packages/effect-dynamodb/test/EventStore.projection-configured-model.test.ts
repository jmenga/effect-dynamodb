/**
 * Projection rows read through a `DynamoModel.configure`d read model (#160):
 * the state holds exactly the model's fields (`Hidden` ones included), never
 * the table's keys or marker — against `helpers/InMemoryTables.ts`.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Option, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { InMemoryClient, resetCalls, resetStore } from "./helpers/InMemoryTables.js"

const AppSchema = DynamoSchema.make({ name: "cfg", version: 1 })

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
  evolve: (state, event) => {
    // The state `evolve` sees is the model's fields only.
    expect(Object.keys(state).sort()).toEqual(["orderId", "searchKey", "total", "version"])
    return Effect.succeed({ ...state, total: state.total + event.data.amount })
  },
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
      evolve: (state, event) => {
        expect(Object.keys(state).sort()).toEqual(shipmentFields)
        return Effect.succeed({ ...state, total: state.total + event.data.amount })
      },
    }),
  }),
  checkpoints: { field: "checkpoints" },
  revision: "revision",
})

const summaryFields = ["orderId", "searchKey", "total", "version"]
const shipmentFields = ["checkpoints", "revision", "searchKey", "shipmentId", "total"]

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
)

beforeEach(() => resetStore())

const seed = Effect.gen(function* () {
  yield* Orders.append(
    { orderId: "o1" },
    [new Placed({ shipmentId: "s1", amount: 1 }), new Placed({ shipmentId: "s1", amount: 2 })],
    0,
  )
  const read = yield* Orders.read({ orderId: "o1" })
  resetCalls()
  return read
})

const keysOf = (state: Option.Option<unknown>) =>
  Object.keys(Option.getOrThrow(state) as object).sort()

describe("projections over a configured read model (#160)", () => {
  it.effect("single-source: a redelivered row's state holds only the model's fields", () =>
    Effect.gen(function* () {
      const events = yield* seed
      yield* SummaryProjection.applyBatch(events)
      // Already applied: the result carries the stored row as read.
      const redelivered = yield* SummaryProjection.applyBatch(events)
      const outcome = redelivered.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(outcome.alreadyApplied).toHaveLength(2)
      expect(keysOf(outcome.state)).toEqual(summaryFields)
      expect(Option.getOrThrow(outcome.state)).toEqual({
        orderId: "o1",
        total: 3,
        searchKey: "order#o1",
        version: 2,
      })
      // And through `catchUp`, which reads the row too.
      const caughtUp = yield* SummaryProjection.catchUp({ orderId: "o1" })
      expect(keysOf(caughtUp.state)).toEqual(summaryFields)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("multi-source: a redelivered row's state holds only the model's fields", () =>
    Effect.gen(function* () {
      const events = (yield* seed).map((event) => ({ stream: "order" as const, event }))
      yield* ShipmentProjection.applyBatch(events)
      const redelivered = yield* ShipmentProjection.applyBatch(events)
      const outcome = redelivered.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(keysOf(outcome.state)).toEqual(shipmentFields)
      expect(Option.getOrThrow(outcome.state)).toEqual({
        shipmentId: "s1",
        total: 3,
        searchKey: "shipment#s1",
        checkpoints: { "order#o1": 2 },
        revision: 1,
      })
      const caughtUp = yield* ShipmentProjection.catchUp({ shipmentId: "s1" })
      expect(keysOf(caughtUp.state)).toEqual(shipmentFields)
    }).pipe(Effect.provide(TestLayer)),
  )

  it("checks the named fields against a configured model", () => {
    expect(() =>
      EventStore.projection({
        stream: Orders,
        readModel: Summaries,
        key: (id) => ({ orderId: id.orderId }),
        initial: (id): Summary => ({ orderId: id.orderId, total: 0, searchKey: "", version: 0 }),
        evolve: (state) => Effect.succeed(state),
        checkpoint: "version",
        // @ts-expect-error — not a field of the read model
        revision: "missing",
      }),
    ).toThrow(/EDD-9081/)
  })
})
