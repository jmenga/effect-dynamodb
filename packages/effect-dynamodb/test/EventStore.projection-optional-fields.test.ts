/**
 * Optional checkpoint, instance, map and revision fields (#158): a read model
 * adopting a projection over rows written before it — against the in-memory
 * tables in `helpers/InMemoryTables.ts`.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { hooks, InMemoryClient, resetCalls, resetStore, store } from "./helpers/InMemoryTables.js"

const AppSchema = DynamoSchema.make({ name: "opt", version: 1 })

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

/** A summary whose rows predate the projection: its fields are optional. */
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

/** No revision: each write is conditioned on the checkpoint read. */
const Unrevisioned = EventStore.projection({ ...summaryBase, checkpoint: "version" })
const Revisioned = EventStore.projection({
  ...summaryBase,
  checkpoint: { field: "version", offset: -1 },
  revision: { field: "rev", initial: 0 },
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

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
)

beforeEach(() => resetStore())

/** Store a row as it was before the projection: domain fields only. */
const legacyRow = (pk: string, entityType: string, fields: Record<string, unknown>) =>
  store.set(`read|${pk}|$opt#v1#${entityType.toLowerCase()}`, {
    ...toAttributeMap({ pk, sk: `$opt#v1#${entityType.toLowerCase()}`, ...fields }),
    __edd_e__: { S: entityType },
  })

const rowOf = (id: string) => {
  const entry = [...store.entries()].find(([k]) => k.startsWith("read|") && k.includes(`_${id}|`))
  return entry === undefined ? undefined : (fromAttributeMap(entry[1]) as Record<string, unknown>)
}

const seedOrder = (orderId: string, events: ReadonlyArray<OrderEvent>) =>
  Effect.gen(function* () {
    yield* Orders.append({ orderId }, events, 0)
    const read = yield* Orders.read({ orderId })
    resetCalls()
    return read
  })

const seedInspection = (inspectionId: string, events: ReadonlyArray<Inspected>) =>
  Effect.gen(function* () {
    yield* Inspections.append({ inspectionId }, events, 0)
    const read = yield* Inspections.read({ inspectionId })
    resetCalls()
    return read.map((event) => ({ stream: "inspection" as const, event }))
  })

describe("optional projection fields: types", () => {
  it("accepts optional fields in every position, and still rejects the wrong type", () => {
    const _typesOnly = () => {
      EventStore.projection({ ...summaryBase, checkpoint: "version" })
      EventStore.projection({ ...summaryBase, checkpoint: { field: "version", offset: -1 } })
      EventStore.projection({ ...summaryBase, checkpoint: "version", revision: "rev" })
      EventStore.projection({
        ...summaryBase,
        checkpoint: "version",
        revision: { field: "rev", initial: 0 },
      })
      EventStore.projection({
        ...summaryBase,
        // @ts-expect-error — `note` is an optional string field
        checkpoint: "note",
      })
      EventStore.projection({
        ...summaryBase,
        checkpoint: "version",
        // @ts-expect-error — `note` is an optional string field
        revision: "note",
      })
      const multi = {
        readModel: Shipments,
        initial: (key: { readonly shipmentId: string }): Shipment => ({
          shipmentId: key.shipmentId,
          score: 0,
        }),
        sources: (source: EventStore.SourceBuilder<{ readonly shipmentId: string }, Shipment>) => ({
          inspection: source(Inspections, {
            key: (_id, event) => ({ shipmentId: event.data.shipmentId }),
            evolve: (state) => Effect.succeed(state),
          }),
        }),
        revision: "revision" as const,
      }
      EventStore.multiProjection({ ...multi, checkpoints: { field: "checkpoints" } })
      EventStore.multiProjection({
        ...multi,
        checkpoints: {
          sources: {
            inspection: { field: "inspectionVersion", offset: -1, instanceField: "inspectionId" },
          },
        },
      })
      EventStore.multiProjection({
        ...multi,
        // @ts-expect-error — `inspectionId` is an optional string field
        checkpoints: { field: "inspectionId" },
      })
      EventStore.multiProjection({
        ...multi,
        checkpoints: {
          sources: {
            // @ts-expect-error — `inspectionVersion` is an optional numeric field
            inspection: { field: "inspectionVersion", instanceField: "inspectionVersion" },
          },
        },
      })
    }
    void _typesOnly
  })
})

describe("optional projection fields: a row written before the projection", () => {
  it.effect("adopts a row without a checkpoint, keeping its other attributes", () =>
    Effect.gen(function* () {
      legacyRow("$opt#v1#summary#orderid_o1", "Summary", { orderId: "o1", total: 10, note: "x" })
      const events = yield* seedOrder("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
      const result = yield* Unrevisioned.applyBatch(events)
      expect(result.failedPositions).toEqual([])
      const row = rowOf("o1")!
      expect(row).toMatchObject({ orderId: "o1", total: 13, note: "x", version: 2 })
      // No revision configured, none written.
      expect(row).not.toHaveProperty("rev")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("guards that first write with attribute_not_exists on the checkpoint", () =>
    Effect.gen(function* () {
      legacyRow("$opt#v1#summary#orderid_o1", "Summary", { orderId: "o1", total: 10 })
      const events = yield* seedOrder("o1", [new Placed({ amount: 1 }), new Added({ amount: 2 })])
      // Another writer applies version 1 between this writer's read and write.
      hooks.afterGet.push(() => {
        const current = rowOf("o1")!
        store.set("read|$opt#v1#summary#orderid_o1|$opt#v1#summary", {
          ...toAttributeMap({ ...current, total: 11, version: 1 }),
        })
      })
      const fiber = yield* Effect.forkChild(Unrevisioned.applyBatch(events))
      yield* TestClock.adjust("1 second")
      const result = yield* Fiber.join(fiber)
      expect(result.failedPositions).toEqual([])
      // The lost race re-read the row: version 1 was not applied twice.
      expect(rowOf("o1")).toMatchObject({ total: 13, version: 2 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a revision absent on the row starts at `initial`", () =>
    Effect.gen(function* () {
      legacyRow("$opt#v1#summary#orderid_o1", "Summary", { orderId: "o1", total: 10 })
      const events = yield* seedOrder("o1", [new Placed({ amount: 1 })])
      yield* Revisioned.applyBatch(events)
      expect(rowOf("o1")).toMatchObject({ total: 11, version: 0, rev: 0 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a field-mapped instance adopts an unowned row, and the map stays absent", () =>
    Effect.gen(function* () {
      legacyRow("$opt#v1#shipment#shipmentid_s1", "Shipment", {
        shipmentId: "s1",
        score: 5,
        note: "x",
      })
      const events = yield* seedInspection("i1", [
        new Inspected({ shipmentId: "s1", score: 1 }),
        new Inspected({ shipmentId: "s1", score: 2 }),
      ])
      yield* ShipmentProjection.applyBatch(events)
      const row = rowOf("s1")!
      expect(row).toMatchObject({
        shipmentId: "s1",
        score: 8,
        note: "x",
        inspectionVersion: 2,
        inspectionId: "i1",
        revision: 1,
      })
      expect(row).not.toHaveProperty("checkpoints")

      // A second instance has no field of its own: it goes to the map.
      const second = yield* seedInspection("i2", [new Inspected({ shipmentId: "s1", score: 4 })])
      yield* ShipmentProjection.applyBatch(second)
      expect(rowOf("s1")).toMatchObject({
        score: 12,
        inspectionVersion: 2,
        inspectionId: "i1",
        checkpoints: { "inspection#i2": 1 },
        revision: 2,
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a new row writes only what the projection set", () =>
    Effect.gen(function* () {
      const events = yield* seedInspection("i1", [new Inspected({ shipmentId: "s1", score: 3 })])
      yield* ShipmentProjection.applyBatch(events)
      const row = rowOf("s1")!
      expect(Object.keys(row).sort()).toEqual(
        [
          "__edd_e__",
          "inspectionId",
          "inspectionVersion",
          "pk",
          "revision",
          "score",
          "shipmentId",
          "sk",
        ].sort(),
      )
    }).pipe(Effect.provide(TestLayer)),
  )
})
