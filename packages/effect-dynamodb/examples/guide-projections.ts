/**
 * Projections from DynamoDB Streams guide example — effect-dynamodb
 *
 * Demonstrates:
 *   - EventStore.projection(): an event stream folded into a read-model entity
 *   - processBatch(): decode → order → gap-fill → write once → partial batch response
 *   - bindProjection(): the same operations with R = never, for a Lambda handler
 *   - EventStore.decoder() / eventFilterPattern() / batchResponse()
 *   - catchUp() and rebuild()
 *
 * DynamoDB Local has no stream trigger, so the demo appends events, reads the
 * stored event items back with a raw query, wraps them in Lambda-shaped
 * records — out of order and split across batches, as a real stream may
 * deliver them — and feeds those records to the handler.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-projections.ts
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Config, Console, Data, Effect, Layer, Option, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Events and the stream
// ---------------------------------------------------------------------------

// #region stream
class OrderPlaced extends Schema.TaggedClass<OrderPlaced>()("OrderPlaced", {
  customer: Schema.String,
}) {}
class ItemAdded extends Schema.TaggedClass<ItemAdded>()("ItemAdded", {
  sku: Schema.String,
  price: Schema.Number,
}) {}
class OrderShipped extends Schema.TaggedClass<OrderShipped>()("OrderShipped", {}) {}

const AppSchema = DynamoSchema.make({ name: "shop", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })

const OrderEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [OrderPlaced, ItemAdded, OrderShipped],
  streamId: { composite: ["orderId"] },
})
// #endregion

// ---------------------------------------------------------------------------
// 2. The read model
// ---------------------------------------------------------------------------

// #region read-model
const OrderSummary = Schema.Struct({
  orderId: Schema.String,
  customer: Schema.String,
  status: Schema.String,
  items: Schema.Number,
  total: Schema.Number,
  version: Schema.Number, // the checkpoint: the last applied stream version
})

const OrderSummaries = Entity.make({
  model: OrderSummary,
  entityType: "OrderSummary",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byStatus: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["status"] },
      sk: { field: "gsi1sk", composite: ["orderId"] },
    },
  },
})

// #endregion

// ---------------------------------------------------------------------------
// 3. The projection
// ---------------------------------------------------------------------------

// #region projection
const OrderSummaryProjection = EventStore.projection({
  stream: OrderEvents,
  readModel: OrderSummaries,
  key: (streamId) => ({ orderId: streamId.orderId }),
  initial: (streamId) => ({
    orderId: streamId.orderId,
    customer: "",
    status: "new",
    items: 0,
    total: 0,
    version: 0,
  }),
  evolve: (state, event) => {
    const data = event.data
    switch (data._tag) {
      case "OrderPlaced":
        return Effect.succeed({ ...state, customer: data.customer, status: "placed" })
      case "ItemAdded":
        return Effect.succeed({ ...state, items: state.items + 1, total: state.total + data.price })
      case "OrderShipped":
        return Effect.succeed({ ...state, status: "shipped" })
    }
  },
  checkpoint: "version",
})
// #endregion

// ---------------------------------------------------------------------------
// 4. The handler
// ---------------------------------------------------------------------------

/** Stands in for a notification, a message to a bus, … */
const publish = (streamId: string, event: EventStore.StreamEvent<unknown>) =>
  Console.log(`  ${streamId} v${event.version} ${event.eventType}`)

// #region handler
type StreamBatch = { readonly Records: ReadonlyArray<EventStore.StreamRecord> }

const makeHandler = Effect.gen(function* () {
  const summaries = yield* EventStore.bindProjection(OrderSummaryProjection)
  return (batch: StreamBatch) =>
    Effect.gen(function* () {
      const result = yield* summaries.processBatch(batch.Records, { source: "lambda" })
      for (const outcome of result.outcomes) {
        if (outcome._tag === "Failed") continue
        // Side effects for the events this call applied, in version order
        for (const event of outcome.applied) yield* publish(outcome.streamId, event)
      }
      return result.response
    })
})
// #endregion

// ---------------------------------------------------------------------------
// 5. Decoding several streams and filtering the feed
// ---------------------------------------------------------------------------

// #region decoder
const decode = EventStore.decoder({ Order: OrderEvents })

const describeImage = (image: Record<string, AttributeValue>) =>
  decode(image).pipe(
    Effect.map(
      Option.match({
        onNone: () => "not an event",
        onSome: ({ stream, event }) => `${stream} v${event.version}`,
      }),
    ),
  )

// FilterCriteria for the event source mapping (or the Pipe)
const filterCriteria = {
  Filters: [{ Pattern: JSON.stringify(EventStore.eventFilterPattern([OrderEvents])) }],
}
// #endregion

// ---------------------------------------------------------------------------
// 6. Rows keyed by event fields
// ---------------------------------------------------------------------------

// #region event-keyed
class SensorPlaced extends Schema.TaggedClass<SensorPlaced>()("SensorPlaced", {
  zone: Schema.String,
}) {}
class SensorReading extends Schema.TaggedClass<SensorReading>()("SensorReading", {
  zone: Schema.String,
  celsius: Schema.Number,
}) {}

const SensorEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Sensor",
  events: [SensorPlaced, SensorReading],
  streamId: { composite: ["sensorId"] },
})

// One row per sensor and zone: the zone comes from each event
const ZoneReadings = Entity.make({
  model: Schema.Struct({
    sensorId: Schema.String,
    zone: Schema.String,
    readings: Schema.Number,
    maxCelsius: Schema.Number,
    seq: Schema.Number,
    alertKey: DynamoModel.Hidden(Schema.String), // kept for another reader
  }),
  entityType: "ZoneReading",
  primaryKey: {
    pk: { field: "pk", composite: ["sensorId"] },
    sk: { field: "sk", composite: ["zone"] },
  },
})

class ZoneNotPlaced extends Data.TaggedError("ZoneNotPlaced")<{ readonly version: number }> {}

const ZoneReadingProjection = EventStore.projection({
  stream: SensorEvents,
  readModel: ZoneReadings,
  key: (streamId, event) => ({ sensorId: streamId.sensorId, zone: event.data.zone }),
  initial: (streamId, event) => ({
    sensorId: streamId.sensorId,
    zone: event.data.zone,
    readings: -1, // not placed yet
    maxCelsius: Number.NEGATIVE_INFINITY,
    seq: 0,
    alertKey: "",
  }),
  evolve: (state, event) =>
    Effect.gen(function* () {
      const data = event.data
      if (data._tag === "SensorPlaced") return { ...state, readings: 0 }
      if (state.readings < 0) return yield* new ZoneNotPlaced({ version: event.version })
      return {
        ...state,
        readings: state.readings + 1,
        maxCelsius: Math.max(state.maxCelsius, data.celsius),
      }
    }),
  checkpoint: "seq",
  // A reading of a zone never placed is acknowledged and skipped, every time
  terminal: (error) => error._tag === "ZoneNotPlaced",
  // Recompute the attribute other readers query by, on every write
  toItem: (state) => ({ ...state, alertKey: state.maxCelsius > 30 ? "hot" : "normal" }),
})
// #endregion

const ReadTable = Table.make({ schema: AppSchema, entities: { OrderSummaries, ZoneReadings } })

// ---------------------------------------------------------------------------
// 7. One feed, several projections
// ---------------------------------------------------------------------------

// #region feed-handler
const makeFeedHandler = Effect.gen(function* () {
  const summaries = yield* EventStore.bindProjection(OrderSummaryProjection)
  const zones = yield* EventStore.bindProjection(ZoneReadingProjection)
  return (batch: StreamBatch) =>
    EventStore.processBatch(batch.Records, {
      projections: { summaries, zones },
      source: "lambda",
    }).pipe(Effect.map((result) => result.response))
})
// #endregion

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

const eventsTableName = "projections-demo-events"
const readTableName = "projections-demo-read"

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
  const keySchema = [
    { AttributeName: "pk", KeyType: "HASH" as const },
    { AttributeName: "sk", KeyType: "RANGE" as const },
  ]
  yield* client.createTable({
    TableName: eventsTableName,
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: keySchema,
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
  })
  yield* client.createTable({
    TableName: readTableName,
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: keySchema,
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

  yield* OrderEvents.append(
    { orderId: "o-1" },
    [
      new OrderPlaced({ customer: "ada" }),
      new ItemAdded({ sku: "kettle", price: 40 }),
      new ItemAdded({ sku: "mug", price: 8 }),
      new OrderShipped({}),
    ],
    0,
  )

  // The NewImage of each INSERT is the event item as stored
  const { Items: images = [] } = yield* client.query({
    TableName: eventsTableName,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: { "#pk": "pk" },
    ExpressionAttributeValues: { ":pk": { S: "$shop#v1#order#o-1" } },
  })
  assertEq(images.length, 4, "four event items")
  const [v1, v2, v3, v4] = images as Array<Record<string, AttributeValue>>

  assertEq(yield* describeImage(v2!), "Order v2", "decoder dispatch")
  assertEq(filterCriteria.Filters.length, 1, "one filter")

  const handle = yield* makeHandler

  // Batch 1: version 3 arrives first — 1 and 2 are queued behind it.
  yield* Console.log("Batch 1:")
  const first = yield* handle({ Records: [toRecord(v3!)] })
  assertEq(first, { batchItemFailures: [] }, "batch 1 applied")

  // Batch 2: the late 1 and 2 (already applied, skipped), and 4.
  yield* Console.log("Batch 2:")
  const second = yield* handle({ Records: [toRecord(v2!), toRecord(v4!), toRecord(v1!)] })
  assertEq(second, { batchItemFailures: [] }, "batch 2 applied")

  // #region catch-up
  const caughtUp = yield* OrderSummaryProjection.catchUp({ orderId: "o-1" })
  const rebuilt = yield* OrderSummaryProjection.rebuild({ orderId: "o-1" })
  // #endregion
  assertEq(caughtUp.applied.length, 0, "already current")
  assertEq(
    rebuilt.rows.map((row) => Option.getOrThrow(row.state).total),
    [48],
    "rebuild total",
  )

  const db = yield* DynamoClient.make({ entities: { OrderSummaries } })
  const summary = yield* db.entities.OrderSummaries.get({ orderId: "o-1" })
  yield* Console.log(`Summary: ${summary.status}, ${summary.items} items, ${summary.total}`)
  assertEq(
    [summary.status, summary.items, summary.total, summary.version],
    ["shipped", 2, 48, 4],
    "summary",
  )
  const shipped = yield* db.entities.OrderSummaries.byStatus({ status: "shipped" }).collect()
  assertEq(
    shipped.map((s) => s.orderId),
    ["o-1"],
    "GSI current",
  )

  const failures = yield* EventStore.batchResponse([toRecord(v1!)], { source: "pipe" })
  assertEq(failures.batchItemFailures.length, 1, "pipe response")

  // One feed carrying both streams
  yield* SensorEvents.append(
    { sensorId: "s-1" },
    [
      new SensorReading({ zone: "cold", celsius: 4 }), // zone not placed yet: rejected
      new SensorPlaced({ zone: "hot" }),
      new SensorReading({ zone: "hot", celsius: 35 }),
    ],
    0,
  )
  const { Items: sensorImages = [] } = yield* client.query({
    TableName: eventsTableName,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: { "#pk": "pk" },
    ExpressionAttributeValues: { ":pk": { S: "$shop#v1#sensor#s-1" } },
  })
  const handleFeed = yield* makeFeedHandler
  const feed = yield* handleFeed({
    Records: [...sensorImages, v1!].reverse().map((image) => toRecord(image)),
  })
  assertEq(feed, { batchItemFailures: [] }, "feed applied")
  const hot = yield* Entity.asItem(ZoneReadings.get({ sensorId: "s-1", zone: "hot" }))
  assertEq([hot.readings, hot.maxCelsius, hot.alertKey], [1, 35, "hot"], "hot zone")
  const cold = yield* Effect.flip(ZoneReadings.get({ sensorId: "s-1", zone: "cold" }).asEffect())
  assertEq(cold._tag, "ItemNotFound", "cold zone never created")

  yield* client.deleteTable({ TableName: eventsTableName })
  yield* client.deleteTable({ TableName: readTableName })
})

const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
)

Effect.runPromise(program.pipe(Effect.provide(AppLayer))).then(() => console.log("\nDone."))
