/**
 * Multi-source projections (#153): one row per shipment, fed by an order
 * stream (one order → many shipments, `fold`), a carrier-scan stream
 * (`latest`) and an inspection stream (a field-mapped legacy checkpoint, plus
 * the map for a second instance) — against `helpers/InMemoryTables.ts`.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ProjectionSourceConflict } from "@effect-dynamodb/schema/Errors.js"
import { Data, Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import {
  calls,
  hooks,
  InMemoryClient,
  resetCalls,
  resetStore,
  store,
} from "./helpers/InMemoryTables.js"

const AppSchema = DynamoSchema.make({ name: "multi", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })

class ShipmentAdded extends Schema.TaggedClass<ShipmentAdded>()("ShipmentAdded", {
  shipmentId: Schema.String,
  lines: Schema.Number,
}) {}
class Scanned extends Schema.TaggedClass<Scanned>()("Scanned", {
  shipmentId: Schema.String,
  location: Schema.String,
}) {}
class Inspected extends Schema.TaggedClass<Inspected>()("Inspected", {
  shipmentId: Schema.String,
  score: Schema.Number,
}) {}

const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [ShipmentAdded],
  streamId: { composite: ["orderId"] },
})
const Scans = EventStore.makeStream({
  table: EventsTable,
  streamName: "Scan",
  events: [Scanned],
  streamId: { composite: ["shipmentId", "carrier"] },
})
const Inspections = EventStore.makeStream({
  table: EventsTable,
  streamName: "Inspection",
  events: [Inspected],
  streamId: { composite: ["inspectionId"] },
})

const Shipment = Schema.Struct({
  shipmentId: Schema.String,
  lines: Schema.Number,
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
})
const ReadTable = Table.make({ schema: AppSchema, entities: { Shipments } })

class NegativeScore extends Data.TaggedError("NegativeScore")<{ readonly version: number }> {}

const initial = (key: { readonly shipmentId: string }): Shipment => ({
  shipmentId: key.shipmentId,
  lines: 0,
  location: "",
  score: 0,
  inspectionVersion: 0,
  inspectionId: "",
  checkpoints: {},
  revision: 0,
})

const config = {
  readModel: Shipments,
  initial,
  sources: (source: EventStore.SourceBuilder<{ readonly shipmentId: string }, Shipment>) => ({
    order: source(Orders, {
      key: (_id, event) => ({ shipmentId: event.data.shipmentId }),
      evolve: (state, event) => Effect.succeed({ ...state, lines: state.lines + event.data.lines }),
    }),
    scan: source(Scans, {
      key: (id) => ({ shipmentId: id.shipmentId }),
      evolve: (state, event) => Effect.succeed({ ...state, location: event.data.location }),
      mode: "latest",
    }),
    inspection: source(Inspections, {
      key: (_id, event) => ({ shipmentId: event.data.shipmentId }),
      evolve: (state, event) =>
        event.data.score < 0
          ? Effect.fail(new NegativeScore({ version: event.version }))
          : Effect.succeed({ ...state, score: state.score + event.data.score }),
      terminal: (error) => error._tag === "NegativeScore",
    }),
  }),
  revision: "revision" as const,
}

const ShipmentProjection = EventStore.multiProjection({
  ...config,
  checkpoints: {
    field: "checkpoints",
    sources: { inspection: { field: "inspectionVersion", instanceField: "inspectionId" } },
  },
})
/** Field-mapped inspection without a map for a second instance. */
const StrictShipmentProjection = EventStore.multiProjection({
  ...config,
  checkpoints: {
    sources: {
      order: { field: "lines", instanceField: "location" },
      scan: { field: "score", instanceField: "location" },
      inspection: { field: "inspectionVersion", instanceField: "inspectionId" },
    },
  },
})

const TestLayer = Layer.mergeAll(
  InMemoryClient,
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
)

beforeEach(() => resetStore())

const row = (shipmentId: string) => {
  const entry = [...store.entries()].find(
    ([k, item]) => k.startsWith("read|") && item.shipmentId?.S === shipmentId,
  )
  return entry === undefined ? undefined : (fromAttributeMap(entry[1]) as Shipment)
}

/** The stored key of a shipment row. */
const keyOf = (shipmentId: string) =>
  [...store.keys()].find(
    (k) => k.startsWith("read|") && store.get(k)!.shipmentId?.S === shipmentId,
  )!

/** Overwrite a stored row's attributes, as another writer would. */
const patchRow = (shipmentId: string, patch: Partial<Shipment>) => {
  const key = keyOf(shipmentId)
  store.set(key, { ...store.get(key)!, ...toAttributeMap(patch) })
}

/** Every stored event of a stream instance, decoded and tagged. */
const tagged = <N extends string>(name: N, events: ReadonlyArray<EventStore.StreamEvent<any>>) =>
  events.map((event) => ({ stream: name, event }))

const seed = Effect.gen(function* () {
  yield* Orders.append(
    { orderId: "o1" },
    [
      new ShipmentAdded({ shipmentId: "s1", lines: 2 }),
      new ShipmentAdded({ shipmentId: "s2", lines: 1 }),
    ],
    0,
  )
  yield* Orders.append({ orderId: "o1" }, [new ShipmentAdded({ shipmentId: "s1", lines: 3 })], 2)
  yield* Scans.append(
    { shipmentId: "s1", carrier: "ups" },
    [
      new Scanned({ shipmentId: "s1", location: "depot" }),
      new Scanned({ shipmentId: "s1", location: "truck" }),
      new Scanned({ shipmentId: "s1", location: "door" }),
    ],
    0,
  )
  yield* Inspections.append(
    { inspectionId: "i1" },
    [new Inspected({ shipmentId: "s1", score: 5 }), new Inspected({ shipmentId: "s1", score: 1 })],
    0,
  )
  const orders = tagged("order" as const, yield* Orders.read({ orderId: "o1" }))
  const scans = tagged("scan" as const, yield* Scans.read({ shipmentId: "s1", carrier: "ups" }))
  const inspections = tagged("inspection" as const, yield* Inspections.read({ inspectionId: "i1" }))
  resetCalls()
  return { orders, scans, inspections }
})

describe("multiProjection", () => {
  it.effect("folds every source's events into the row with one write per row", () =>
    Effect.gen(function* () {
      const { orders, scans, inspections } = yield* seed
      const result = yield* ShipmentProjection.applyBatch([...scans, ...orders, ...inspections])
      expect(result.failedPositions).toEqual([])
      expect(result.outcomes.map((o) => (o._tag === "Applied" ? o.key : o._tag))).toEqual([
        { shipmentId: "s1" },
        { shipmentId: "s2" },
      ])
      const s1 = result.outcomes[0]!
      if (s1._tag !== "Applied") throw new Error("not applied")
      expect(
        s1.instances.map((i) => [
          i.source,
          i.streamId,
          i.applied.map((e) => e.version),
          i.superseded.map((e) => e.version),
          i.version,
        ]),
      ).toEqual([
        ["order", "o1", [1, 3], [], 3],
        ["scan", "s1#ups", [3], [1, 2], 3],
        ["inspection", "i1", [1, 2], [], 2],
      ])
      expect(row("s1")).toMatchObject({
        lines: 5,
        location: "door",
        score: 6,
        inspectionVersion: 2,
        inspectionId: "i1",
        checkpoints: { "order#o1": 3, "scan#s1#ups": 3 },
        revision: 1,
      })
      expect(row("s2")).toMatchObject({ lines: 1, checkpoints: { "order#o1": 2 }, revision: 1 })
      expect(calls.putItem).toBe(2)
      expect(calls.query).toBe(0) // the batch covered every gap
      console.log(
        "KEYS",
        [...store.keys()].filter((k) => k.startsWith("read|")),
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("each source's later writes advance only its checkpoint, the revision every time", () =>
    Effect.gen(function* () {
      const { orders, scans } = yield* seed
      yield* ShipmentProjection.applyBatch(orders.slice(0, 1))
      yield* ShipmentProjection.applyBatch(scans.slice(0, 1))
      expect(row("s1")).toMatchObject({
        lines: 2,
        location: "depot",
        checkpoints: { "order#o1": 1, "scan#s1#ups": 1 },
        revision: 2,
      })
      // A redelivery, and a late older scan, are already applied.
      const again = yield* ShipmentProjection.applyBatch([
        ...orders.slice(0, 1),
        ...scans.slice(0, 1),
      ])
      const outcome = again.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(outcome.instances.map((i) => i.alreadyApplied.length)).toEqual([1, 1])
      expect(row("s1")!.revision).toBe(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("fills a fold source's gap with only its events for this row", () =>
    Effect.gen(function* () {
      const { orders } = yield* seed
      // Only order v3 (s1) arrives: v1 (s1) is read, v2 (s2) skipped.
      const result = yield* ShipmentProjection.applyBatch([orders[2]!])
      const outcome = result.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(outcome.instances[0]!.applied.map((e) => e.version)).toEqual([1, 3])
      expect(calls.query).toBe(1)
      expect(row("s1")).toMatchObject({ lines: 5, checkpoints: { "order#o1": 3 } })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    "a second instance of a field-mapped source goes to the map, its early events kept",
    () =>
      Effect.gen(function* () {
        const { inspections } = yield* seed
        yield* ShipmentProjection.applyBatch(inspections)
        // Re-identified: a new inspection instance starts at version 1 for the same row.
        yield* Inspections.append(
          { inspectionId: "i2" },
          [new Inspected({ shipmentId: "s1", score: 10 })],
          0,
        )
        const second = tagged(
          "inspection" as const,
          yield* Inspections.read({ inspectionId: "i2" }),
        )
        const result = yield* ShipmentProjection.applyBatch(second)
        const outcome = result.outcomes[0]!
        if (outcome._tag !== "Applied") throw new Error("not applied")
        expect(outcome.instances[0]!.applied.map((e) => e.version)).toEqual([1])
        expect(row("s1")).toMatchObject({
          score: 16,
          inspectionVersion: 2,
          inspectionId: "i1",
          checkpoints: { "inspection#i2": 1 },
        })
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("without a map, a second instance is a typed ProjectionSourceConflict", () =>
    Effect.gen(function* () {
      const { inspections } = yield* seed
      yield* StrictShipmentProjection.applyBatch(inspections)
      yield* Inspections.append(
        { inspectionId: "i2" },
        [new Inspected({ shipmentId: "s1", score: 10 })],
        0,
      )
      const second = tagged("inspection" as const, yield* Inspections.read({ inspectionId: "i2" }))
      const result = yield* StrictShipmentProjection.applyBatch(second)
      const outcome = result.outcomes[0]!
      if (outcome._tag !== "Failed") throw new Error("not failed")
      expect(outcome.error).toEqual(
        new ProjectionSourceConflict({
          entityType: "Shipment",
          source: "inspection",
          recorded: "i1",
          arriving: "i2",
        }),
      )
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a legacy row's field is adopted by the first instance, from its stored version", () =>
    Effect.gen(function* () {
      const { inspections } = yield* seed
      // A row written before the projection: version 1 applied, no owner recorded.
      yield* Shipments.put({
        shipmentId: "s1",
        lines: 0,
        location: "",
        score: 5,
        inspectionVersion: 1,
        inspectionId: "",
        checkpoints: {},
        revision: 7,
      }).asEffect()
      const result = yield* ShipmentProjection.applyBatch(inspections)
      const outcome = result.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(outcome.instances[0]!.alreadyApplied.map((e) => e.version)).toEqual([1])
      expect(outcome.instances[0]!.applied.map((e) => e.version)).toEqual([2])
      expect(row("s1")).toMatchObject({
        score: 6,
        inspectionVersion: 2,
        inspectionId: "i1",
        revision: 8,
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("rejects terminal failures per source and advances past them", () =>
    Effect.gen(function* () {
      yield* Inspections.append(
        { inspectionId: "i3" },
        [
          new Inspected({ shipmentId: "s3", score: 4 }),
          new Inspected({ shipmentId: "s3", score: -1 }),
        ],
        0,
      )
      const events = tagged("inspection" as const, yield* Inspections.read({ inspectionId: "i3" }))
      const result = yield* ShipmentProjection.applyBatch(events)
      const outcome = result.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      expect(outcome.instances[0]!.rejected.map((r) => r.event.version)).toEqual([2])
      expect(row("s3")).toMatchObject({ score: 4, inspectionVersion: 2 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("concurrent writers from different sources serialise on the revision", () =>
    Effect.gen(function* () {
      const { orders, scans } = yield* seed
      yield* ShipmentProjection.applyBatch(orders.slice(0, 1))
      // A scan writer commits between this order writer's read and write.
      hooks.afterGet.push(() => {
        const current = fromAttributeMap(store.get(keyOf("s1"))!) as Shipment
        patchRow("s1", {
          location: "depot",
          checkpoints: { ...current.checkpoints, "scan#s1#ups": 1 },
          revision: current.revision + 1,
        })
      })
      // The lost race backs off (jittered) before re-reading: the test clock.
      const fiber = yield* Effect.forkChild(ShipmentProjection.applyBatch([orders[2]!]))
      yield* TestClock.adjust("1 second")
      const result = yield* Fiber.join(fiber)
      expect(result.failedPositions).toEqual([])
      // The order write re-read and kept the scan's part.
      expect(row("s1")).toMatchObject({
        lines: 5,
        location: "depot",
        checkpoints: { "order#o1": 3, "scan#s1#ups": 1 },
        revision: 3,
      })
      void scans
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("catchUp brings every known instance to its head; rebuild re-derives the row", () =>
    Effect.gen(function* () {
      const { orders, scans, inspections } = yield* seed
      yield* ShipmentProjection.applyBatch([orders[0]!, scans[0]!, inspections[0]!])
      const caught = yield* ShipmentProjection.catchUp({ shipmentId: "s1" })
      expect(caught.instances.map((i) => [i.source, i.version])).toEqual([
        ["order", 3],
        ["scan", 3],
        ["inspection", 2],
      ])
      expect(row("s1")).toMatchObject({ lines: 5, location: "door", score: 6 })
      // Corrupt the row: the scalar owned by the wrong instance, the totals off.
      const current = row("s1")!
      patchRow("s1", { inspectionId: "wrong", score: 999 })
      const rebuilt = yield* ShipmentProjection.rebuild(
        { shipmentId: "s1" },
        {
          instances: {
            order: [{ orderId: "o1" }],
            scan: [{ shipmentId: "s1", carrier: "ups" }],
            inspection: [{ inspectionId: "i1" }],
          },
        },
      )
      expect(rebuilt.revision).toBe(current.revision + 1)
      expect(row("s1")).toMatchObject({
        lines: 5,
        location: "door",
        score: 6,
        inspectionId: "i1",
        inspectionVersion: 2,
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("runs through EventStore.processBatch next to a single-source projection, bound", () =>
    Effect.gen(function* () {
      yield* seed
      const records = [...store.entries()]
        .filter(([k, item]) => k.startsWith("events|") && item.__edd_e__?.S?.endsWith(".event"))
        .map(([, item], i) => ({
          eventID: `e${i}`,
          eventName: "INSERT",
          dynamodb: { SequenceNumber: String(i).padStart(4, "0"), NewImage: item as never },
        }))
      const bound = yield* EventStore.bindProjection(ShipmentProjection)
      const run: Effect.Effect<unknown, unknown, never> = EventStore.processBatch(records, {
        projections: { shipments: bound },
        source: "lambda",
      })
      void run
      const result = yield* EventStore.processBatch(records, {
        projections: { shipments: bound },
        source: "lambda",
      })
      expect(result.response).toEqual({ batchItemFailures: [] })
      expect(result.outcomes.shipments.map((o) => (o._tag === "Applied" ? o.key : o._tag))).toEqual(
        [{ shipmentId: "s1" }, { shipmentId: "s2" }],
      )
      expect(row("s1")).toMatchObject({ lines: 5, location: "door", score: 6 })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("latest + terminal falls back newest-first until one is accepted", () =>
    Effect.gen(function* () {
      const Guarded = EventStore.multiProjection({
        ...config,
        sources: (source: EventStore.SourceBuilder<{ readonly shipmentId: string }, Shipment>) => ({
          scan: source(Scans, {
            key: (id) => ({ shipmentId: id.shipmentId }),
            evolve: (state, event) =>
              event.data.location === "nowhere"
                ? Effect.fail(new NegativeScore({ version: event.version }))
                : Effect.succeed({ ...state, location: event.data.location }),
            mode: "latest",
            terminal: (error) => error._tag === "NegativeScore",
          }),
        }),
        checkpoints: { field: "checkpoints" },
      })
      yield* Scans.append(
        { shipmentId: "s9", carrier: "ups" },
        [
          new Scanned({ shipmentId: "s9", location: "depot" }),
          new Scanned({ shipmentId: "s9", location: "truck" }),
          new Scanned({ shipmentId: "s9", location: "nowhere" }),
        ],
        0,
      )
      const events = tagged(
        "scan" as const,
        yield* Scans.read({ shipmentId: "s9", carrier: "ups" }),
      )
      const result = yield* Guarded.applyBatch(events)
      const outcome = result.outcomes[0]!
      if (outcome._tag !== "Applied") throw new Error("not applied")
      const instance = outcome.instances[0]!
      expect(instance.applied.map((e) => e.version)).toEqual([2])
      expect(instance.rejected.map((r) => r.event.version)).toEqual([3])
      expect(instance.superseded.map((e) => e.version)).toEqual([1])
      expect(instance.version).toBe(3)
      expect(row("s9")).toMatchObject({ location: "truck", checkpoints: { "scan#s9#ups": 3 } })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("one instance's failure leaves the row's other sources to apply", () =>
    Effect.gen(function* () {
      const { orders } = yield* seed
      yield* Inspections.append(
        { inspectionId: "bad" },
        [
          new Inspected({ shipmentId: "s1", score: 1 }),
          new Inspected({ shipmentId: "s1", score: 2 }),
        ],
        0,
      )
      const Fragile = EventStore.multiProjection({
        ...config,
        sources: (source: EventStore.SourceBuilder<{ readonly shipmentId: string }, Shipment>) => ({
          order: source(Orders, {
            key: (_id, event) => ({ shipmentId: event.data.shipmentId }),
            evolve: (state, event) =>
              Effect.succeed({ ...state, lines: state.lines + event.data.lines }),
          }),
          inspection: source(Inspections, {
            key: (_id, event) => ({ shipmentId: event.data.shipmentId }),
            evolve: (state, event) =>
              event.version === 2
                ? Effect.fail(new NegativeScore({ version: event.version }))
                : Effect.succeed({ ...state, score: state.score + event.data.score }),
          }),
        }),
        checkpoints: { field: "checkpoints" },
      })
      const bad = tagged("inspection" as const, yield* Inspections.read({ inspectionId: "bad" }))
      const result = yield* Fragile.applyBatch([orders[0]!, bad[0]!, bad[1]!])
      expect(result.outcomes.map((o) => [o._tag, o.positions])).toEqual([
        ["Applied", [0]],
        ["Failed", [1, 2]],
      ])
      expect(result.failedPositions).toEqual([1])
      // The order applied; the inspection's checkpoint did not move.
      expect(row("s1")).toMatchObject({ lines: 2, score: 0, checkpoints: { "order#o1": 1 } })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("revision starts at `initial` on a new row", () =>
    Effect.gen(function* () {
      const FromZero = EventStore.multiProjection({
        ...config,
        checkpoints: { field: "checkpoints" },
        revision: { field: "revision", initial: 0 },
      })
      const { orders } = yield* seed
      yield* FromZero.applyBatch(orders.slice(0, 1))
      expect(row("s1")!.revision).toBe(0)
      yield* FromZero.applyBatch(orders.slice(2, 3))
      expect(row("s1")!.revision).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("`streams` may name a projected stream: its events are applied and returned", () =>
    Effect.gen(function* () {
      yield* seed
      const records = [...store.entries()]
        .filter(([k, item]) => k.startsWith("events|") && item.__edd_e__?.S === "order.event")
        .map(([, item], i) => ({
          eventID: `e${i}`,
          eventName: "INSERT",
          dynamodb: { SequenceNumber: String(i).padStart(4, "0"), NewImage: item as never },
        }))
      const bound = yield* EventStore.bindProjection(ShipmentProjection)
      const result = yield* EventStore.processBatch(records, {
        projections: { shipments: bound },
        streams: { Order: Orders },
        source: "lambda",
      })
      expect(result.unrouted.map((u) => [u.position, u.stream, u.event.version])).toEqual([
        [0, "Order", 1],
        [1, "Order", 2],
        [2, "Order", 3],
      ])
      expect(result.outcomes.shipments).toHaveLength(2)
    }).pipe(Effect.provide(TestLayer)),
  )

  it("refuses checkpoints that cover no source, and unknown source mappings", () => {
    expect(() => EventStore.multiProjection({ ...config, checkpoints: {} } as never)).toThrow(
      /\[EDD-9081\]/,
    )
    expect(() =>
      EventStore.multiProjection({
        ...config,
        checkpoints: {
          sources: { inspection: { field: "inspectionVersion", instanceField: "inspectionId" } },
        },
      } as never),
    ).toThrow(/\[EDD-9081\].*"order" has no checkpoint/)
    expect(() =>
      EventStore.multiProjection({
        ...config,
        checkpoints: {
          field: "checkpoints",
          sources: { nope: { field: "score", instanceField: "location" } },
        },
      } as never),
    ).toThrow(/\[EDD-9081\].*nope/)
    void Option
  })
})
