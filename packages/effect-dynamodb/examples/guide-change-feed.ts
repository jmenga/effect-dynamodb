/**
 * Change feed guide example — effect-dynamodb
 *
 * Demonstrates `effect-dynamodb/change-feed`, a polled DynamoDB Streams
 * consumer for processes outside Lambda:
 *   - DynamoStreamsClient and CheckpointStore layers
 *   - changeFeed(): a Stream of per-shard batches, acknowledged with
 *     batch.commit() / batch.complete(response)
 *   - runChangeFeed(): the feed into EventStore projections
 *   - resuming after a restart from the DynamoDB checkpoint table
 *   - the feed ending once the table's stream is disabled and drained
 *
 * DynamoDB Local serves the Streams API, so this runs against it unchanged.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-change-feed.ts
 */

import { Config, Console, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"

// Import from source (use "effect-dynamodb" and "effect-dynamodb/change-feed" when published)
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  CheckpointStore,
  changeFeed,
  DynamoStreamsClient,
  runChangeFeed,
} from "../src/change-feed/index.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. A stream and a projection (see the projections guide)
// ---------------------------------------------------------------------------

class OrderPlaced extends Schema.TaggedClass<OrderPlaced>()("OrderPlaced", {
  customer: Schema.String,
}) {}
class ItemAdded extends Schema.TaggedClass<ItemAdded>()("ItemAdded", {
  price: Schema.Number,
}) {}

const AppSchema = DynamoSchema.make({ name: "shop", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })

const OrderEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [OrderPlaced, ItemAdded],
  streamId: { composite: ["orderId"] },
})

const OrderSummaries = Entity.make({
  model: Schema.Struct({
    orderId: Schema.String,
    customer: Schema.String,
    total: Schema.Number,
    version: Schema.Number,
  }),
  entityType: "OrderSummary",
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
})
const ReadTable = Table.make({ schema: AppSchema, entities: { OrderSummaries } })

const OrderSummaryProjection = EventStore.projection({
  stream: OrderEvents,
  readModel: OrderSummaries,
  key: (streamId) => ({ orderId: streamId.orderId }),
  initial: (streamId) => ({ orderId: streamId.orderId, customer: "", total: 0, version: 0 }),
  evolve: (state, event) => {
    const data = event.data
    return Effect.succeed(
      data._tag === "OrderPlaced"
        ? { ...state, customer: data.customer }
        : { ...state, total: state.total + data.price },
    )
  },
  checkpoint: "version",
})

// ---------------------------------------------------------------------------
// 2. Tables and layers
// ---------------------------------------------------------------------------

const suffix = Date.now()
const eventsTableName = `change-feed-demo-events-${suffix}`
const readTableName = `change-feed-demo-read-${suffix}`
const checkpointTableName = `change-feed-demo-checkpoints-${suffix}`

const endpoint = Config.String("DYNAMODB_ENDPOINT").pipe(
  Config.withDefault("http://localhost:8000"),
)
const local = {
  region: Config.succeed("us-east-1"),
  endpoint,
  credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
}

// #region layers
const ClientLive = DynamoClient.layerConfig(local)

const ChangeFeedLive = Layer.mergeAll(
  // The Streams API client — its own endpoint, its own SDK client
  DynamoStreamsClient.layerConfig(local),
  // Checkpoints and the lease, in a DynamoDB table
  CheckpointStore.layerDynamoDB({ tableName: checkpointTableName }),
).pipe(Layer.provideMerge(ClientLive))
// #endregion

const AppLayer = Layer.mergeAll(
  ChangeFeedLive,
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
)

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

/** Poll until `check` holds. */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      if (yield* check) return
      yield* Effect.sleep("50 millis")
    }
    throw new Error("condition not reached")
  })

// ---------------------------------------------------------------------------
// 3. The program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  const keys = {
    BillingMode: "PAY_PER_REQUEST" as const,
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
    ],
  }
  // #region stream-arn
  const created = yield* client.createTable({
    TableName: eventsTableName,
    ...keys,
    StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
  })
  const streamArn = created.TableDescription!.LatestStreamArn!
  // #endregion
  yield* client.createTable({ TableName: readTableName, ...keys })
  // #region checkpoint-table
  yield* client.createTable(CheckpointStore.tableDefinition(checkpointTableName))
  // #endregion

  const db = yield* DynamoClient.make({ entities: { OrderSummaries } })
  const totalOf = (orderId: string) =>
    db.entities.OrderSummaries.get({ orderId })
      .asEffect()
      .pipe(
        Effect.map((summary) => summary.total),
        Effect.orElseSucceed(() => -1),
      )

  yield* OrderEvents.append(
    { orderId: "o-1" },
    [new OrderPlaced({ customer: "ann" }), new ItemAdded({ price: 30 })],
    0,
  )

  // Consuming the feed directly: acknowledge each batch yourself.
  // #region manual
  const decode = EventStore.decoder({ Order: OrderEvents })
  const audited: Array<string> = []

  const feed = changeFeed({
    streamArn,
    consumer: "audit", // checkpoints and the lease are kept per consumer
    startingPosition: "TRIM_HORIZON",
    pollInterval: "100 millis",
  })

  yield* feed.pipe(
    Stream.mapEffect((batch) =>
      Effect.gen(function* () {
        for (const record of batch.records) {
          const image = record.dynamodb?.NewImage
          if (record.eventName !== "INSERT" || image === undefined) continue
          const decoded = yield* decode(image)
          if (Option.isSome(decoded)) {
            const { event } = decoded.value
            audited.push(`${event.streamId} v${event.version} ${event.data._tag}`)
          }
        }
        yield* batch.commit() // checkpoint at batch.lastSequenceNumber
      }),
    ),
    Stream.take(1),
    Stream.runDrain,
  )
  // #endregion
  yield* Console.log(`Audited: ${audited.join(", ")}`)
  assertEq(audited, ["o-1 v1 OrderPlaced", "o-1 v2 ItemAdded"], "audited")

  // The feed into projections.
  // #region run
  const projectAll = runChangeFeed(
    changeFeed({ streamArn, consumer: "projections", pollInterval: "100 millis" }),
    {
      projections: { summaries: OrderSummaryProjection },
      // Before each batch is acknowledged: act on what it applied
      onBatch: (batch, result) =>
        Effect.forEach(
          result.outcomes.summaries,
          (outcome) =>
            outcome._tag === "Applied"
              ? Console.log(`${batch.shardId}: ${outcome.streamId} → v${outcome.version}`)
              : Console.log(`${batch.shardId}: ${outcome.streamId} failed, re-read`),
          { discard: true },
        ),
    },
  )
  // #endregion

  const running = yield* Effect.forkChild(projectAll)
  yield* eventually(Effect.map(totalOf("o-1"), (total) => total === 30))
  // A restart resumes after the committed checkpoints.
  yield* Fiber.interrupt(running)
  yield* OrderEvents.append({ orderId: "o-1" }, [new ItemAdded({ price: 12 })], 2)
  const restarted = yield* Effect.forkChild(projectAll)
  yield* eventually(Effect.map(totalOf("o-1"), (total) => total === 42))
  yield* Fiber.interrupt(restarted)

  // Disabling the stream closes its shards: the feed drains them and ends.
  yield* OrderEvents.append({ orderId: "o-2" }, [new OrderPlaced({ customer: "bo" })], 0)
  yield* client.updateTable({
    TableName: eventsTableName,
    StreamSpecification: { StreamEnabled: false },
  })
  yield* projectAll
  assertEq(yield* totalOf("o-2"), 0, "o-2 projected")
  const summary = yield* db.entities.OrderSummaries.get({ orderId: "o-1" })
  yield* Console.log(`o-1: ${summary.customer}, total ${summary.total}, v${summary.version}`)
  assertEq([summary.customer, summary.total, summary.version], ["ann", 42, 3], "summary")

  for (const TableName of [eventsTableName, readTableName, checkpointTableName]) {
    yield* client.deleteTable({ TableName })
  }
})

Effect.runPromise(program.pipe(Effect.provide(AppLayer))).then(() => console.log("\nDone."))
