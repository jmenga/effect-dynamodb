/**
 * Advanced projections guide example — effect-dynamodb
 *
 * Demonstrates:
 *   - EventStore.multiProjection(): one read-model row fed by several streams,
 *     a checkpoint per source instance, writes guarded by a revision
 *   - "fold" and "latest" sources
 *   - removal: EventStore.removeRow and tombstones that keep the checkpoints
 *   - outbox: side effects committed with the row, drained in order
 *   - EventStore.processBatch() over a feed carrying every stream
 *   - rebuild() as the repair path
 *   - adopting rows written before the projection: optional checkpoint,
 *     instance, map and revision fields
 *
 * DynamoDB Local has no stream trigger, so the demo appends events, reads the
 * stored items back and feeds them to the handler as Lambda-shaped records.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-projections-advanced.ts
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Config, Console, Effect, Layer, Option, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Three streams
// ---------------------------------------------------------------------------

// #region streams
class ParcelAdded extends Schema.TaggedClass<ParcelAdded>()("ParcelAdded", {
  shipmentId: Schema.String,
  parcels: Schema.Number,
}) {}
class OrderCancelled extends Schema.TaggedClass<OrderCancelled>()("OrderCancelled", {
  shipmentId: Schema.String,
}) {}
class Scanned extends Schema.TaggedClass<Scanned>()("Scanned", {
  location: Schema.String,
}) {}
class Weighed extends Schema.TaggedClass<Weighed>()("Weighed", {
  shipmentId: Schema.String,
  kg: Schema.Number,
}) {}

const AppSchema = DynamoSchema.make({ name: "freight", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })

// One order feeds several shipments
const OrderEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [ParcelAdded, OrderCancelled],
  streamId: { composite: ["orderId"] },
})
// One scan stream per shipment: each event carries the whole location
const ScanEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Scan",
  events: [Scanned],
  streamId: { composite: ["shipmentId"] },
})
// Weighings arrive from a scale, one stream per weighing session
const WeighEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Weigh",
  events: [Weighed],
  streamId: { composite: ["sessionId"] },
})
// #endregion

// ---------------------------------------------------------------------------
// 2. The read model
// ---------------------------------------------------------------------------

// #region read-model
const ShipmentSummary = Schema.Struct({
  shipmentId: Schema.String,
  parcels: Schema.Number,
  location: Schema.String,
  kg: Schema.Number,
  checkpoints: Schema.Record(Schema.String, Schema.Number), // one per source instance
  revision: Schema.Number, // incremented by every write, and its guard
})

const ShipmentSummaries = Entity.make({
  model: ShipmentSummary,
  entityType: "ShipmentSummary",
  primaryKey: {
    pk: { field: "pk", composite: ["shipmentId"] },
    sk: { field: "sk", composite: [] },
  },
})

const ReadTable = Table.make({ schema: AppSchema, entities: { ShipmentSummaries } })
// #endregion

// ---------------------------------------------------------------------------
// 3. The multi-source projection
// ---------------------------------------------------------------------------

// #region projection
const ShipmentNotice = Schema.Struct({ shipmentId: Schema.String, kind: Schema.String })

const ShipmentProjection = EventStore.multiProjection({
  readModel: ShipmentSummaries,
  initial: (key) => ({
    shipmentId: key.shipmentId,
    parcels: 0,
    location: "",
    kg: 0,
    checkpoints: {},
    revision: 0,
  }),
  sources: (source) => ({
    order: source(OrderEvents, {
      key: (_orderId, event) => ({ shipmentId: event.data.shipmentId }),
      evolve: (state, event) =>
        Effect.succeed(
          event.data._tag === "OrderCancelled"
            ? EventStore.removeRow
            : { ...state, parcels: state.parcels + event.data.parcels },
        ),
    }),
    scan: source(ScanEvents, {
      key: (streamId) => ({ shipmentId: streamId.shipmentId }),
      evolve: (state, event) => Effect.succeed({ ...state, location: event.data.location }),
      mode: "latest", // each scan carries the whole location: only the newest matters
    }),
    weigh: source(WeighEvents, {
      key: (_sessionId, event) => ({ shipmentId: event.data.shipmentId }),
      evolve: (state, event) => Effect.succeed({ ...state, kg: state.kg + event.data.kg }),
    }),
  }),
  checkpoints: { field: "checkpoints" },
  revision: "revision",
  removal: {},
  outbox: {
    schema: ShipmentNotice,
    effects: (event, next) =>
      event.eventType === "Scanned" && next !== undefined
        ? [{ shipmentId: next.shipmentId, kind: `at ${next.location}` }]
        : [],
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 4. Adopting rows written before the projection
// ---------------------------------------------------------------------------

// #region adoption
const WeightLog = Schema.Struct({
  shipmentId: Schema.String,
  kg: Schema.Number,
  // Absent on rows written before the projection
  weighVersion: Schema.optional(Schema.Number),
  weighSession: Schema.optional(Schema.String),
  checkpoints: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  revision: Schema.optional(Schema.Number),
})

const WeightLogs = Entity.make({
  model: WeightLog,
  entityType: "WeightLog",
  primaryKey: {
    pk: { field: "pk", composite: ["shipmentId"] },
    sk: { field: "sk", composite: [] },
  },
})

const WeightProjection = EventStore.multiProjection({
  readModel: WeightLogs,
  initial: (key) => ({ shipmentId: key.shipmentId, kg: 0 }),
  sources: (source) => ({
    weigh: source(WeighEvents, {
      key: (_sessionId, event) => ({ shipmentId: event.data.shipmentId }),
      evolve: (state, event) => Effect.succeed({ ...state, kg: state.kg + event.data.kg }),
    }),
  }),
  checkpoints: {
    field: "checkpoints",
    sources: { weigh: { field: "weighVersion", offset: -1, instanceField: "weighSession" } },
  },
  revision: "revision",
})
// #endregion

const LegacyTable = Table.make({ schema: AppSchema, entities: { WeightLogs } })

// ---------------------------------------------------------------------------
// 5. The handler
// ---------------------------------------------------------------------------

/** Stands in for a message to a bus. */
const delivered: Array<string> = []
const deliver = (notice: typeof ShipmentNotice.Type, meta: EventStore.OutboxMeta) =>
  Effect.sync(() => {
    delivered.push(`${notice.shipmentId} ${notice.kind}`)
  }).pipe(
    Effect.andThen(
      Console.log(`  notify ${notice.shipmentId}: ${notice.kind} (${meta.source} v${meta.version})`),
    ),
  )

// #region handler
type StreamBatch = { readonly Records: ReadonlyArray<EventStore.StreamRecord> }

const makeHandler = Effect.gen(function* () {
  const shipments = yield* EventStore.bindProjection(ShipmentProjection)
  return (batch: StreamBatch) =>
    EventStore.processBatch(batch.Records, {
      projections: { shipments },
      source: "lambda",
      // Deliver each written row's effects, in order, right after its write
      deliver: (effect, meta) => deliver(effect as typeof ShipmentNotice.Type, meta),
    }).pipe(Effect.map((result) => result.response))
})
// #endregion

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

const eventsTableName = "advanced-projections-events"
const readTableName = "advanced-projections-read"

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

let sequence = 0
const toRecord = (NewImage: Record<string, AttributeValue>): EventStore.StreamRecord => {
  sequence++
  return {
    eventID: `event-${sequence}`,
    eventName: "INSERT",
    dynamodb: { SequenceNumber: String(sequence).padStart(21, "0"), NewImage },
  }
}

const program = Effect.gen(function* () {
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

  yield* OrderEvents.append(
    { orderId: "o-1" },
    [
      new ParcelAdded({ shipmentId: "sh-1", parcels: 2 }),
      new ParcelAdded({ shipmentId: "sh-2", parcels: 1 }),
    ],
    0,
  )
  yield* ScanEvents.append(
    { shipmentId: "sh-1" },
    [new Scanned({ location: "depot" }), new Scanned({ location: "truck" })],
    0,
  )
  yield* WeighEvents.append(
    { sessionId: "w-1" },
    [new Weighed({ shipmentId: "sh-1", kg: 3 }), new Weighed({ shipmentId: "sh-1", kg: 4 })],
    0,
  )

  // One feed carries all three streams, in whatever order it delivers them
  const { Items: images = [] } = yield* client.scan({ TableName: eventsTableName })
  const records = images
    .filter((image) => image.__edd_e__?.S?.endsWith(".event"))
    .reverse()
    .map((image) => toRecord(image))

  const handle = yield* makeHandler
  yield* Console.log("Feed:")
  assertEq(yield* handle({ Records: records }), { batchItemFailures: [] }, "feed applied")
  // `latest`: only the newest scan was folded, so one notice
  assertEq(delivered, ["sh-1 at truck"], "delivered in order")

  const db = yield* DynamoClient.make({ entities: { ShipmentSummaries } })
  const sh1 = yield* db.entities.ShipmentSummaries.get({ shipmentId: "sh-1" })
  yield* Console.log(`sh-1: ${sh1.parcels} parcels, ${sh1.kg} kg, at ${sh1.location}`)
  assertEq([sh1.parcels, sh1.kg, sh1.location], [2, 7, "truck"], "sh-1")
  assertEq(
    sh1.checkpoints,
    { "order#o-1": 1, "scan#sh-1": 2, "weigh#w-1": 2 },
    "checkpoints",
  )

  // Cancel the order: its shipments' rows become tombstones
  yield* OrderEvents.append(
    { orderId: "o-1" },
    [new OrderCancelled({ shipmentId: "sh-2" })],
    2,
  )
  const [cancelled] = yield* OrderEvents.readFrom({ orderId: "o-1" }, 2)
  // #region removal
  const removed = yield* ShipmentProjection.applyBatch([{ stream: "order", event: cancelled! }])
  // #endregion
  const outcome = removed.outcomes[0]!
  assertEq(outcome._tag === "Applied" && outcome.removed, true, "removed")
  const gone = yield* Effect.flip(db.entities.ShipmentSummaries.get({ shipmentId: "sh-2" }))
  assertEq(gone._tag, "ItemNotFound", "tombstone reads as no row")

  // #region rebuild
  const rebuilt = yield* ShipmentProjection.rebuild(
    { shipmentId: "sh-1" },
    {
      instances: {
        order: [{ orderId: "o-1" }],
        scan: [{ shipmentId: "sh-1" }],
        weigh: [{ sessionId: "w-1" }],
      },
    },
  )
  // #endregion
  assertEq(
    Option.map(rebuilt.state, (s) => [s.parcels, s.kg, s.location]),
    Option.some([2, 7, "truck"]),
    "rebuild",
  )

  // A weight log written before the projection: none of its fields
  const logs = yield* DynamoClient.make({ entities: { WeightLogs } })
  yield* logs.entities.WeightLogs.put({ shipmentId: "sh-1", kg: 1 })
  const weighs = yield* WeighEvents.read({ sessionId: "w-1" })
  yield* WeightProjection.applyBatch(weighs.map((event) => ({ stream: "weigh", event })))
  const log = yield* logs.entities.WeightLogs.get({ shipmentId: "sh-1" })
  yield* Console.log(`sh-1 log: ${log.kg} kg, weigh version ${log.weighVersion}`)
  assertEq(
    [log.kg, log.weighVersion, log.weighSession, log.revision],
    [8, 1, "w-1", 1],
    "adopted",
  )
  // No instance went to the map, so it was not written
  assertEq(log.checkpoints, undefined, "map stays absent")

  for (const TableName of [eventsTableName, readTableName]) yield* client.deleteTable({ TableName })
})

const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
  LegacyTable.layer({ name: readTableName }),
)

Effect.runPromise(program.pipe(Effect.provide(AppLayer))).then(() => console.log("\nDone."))
