/**
 * Batch operations example — effect-dynamodb v2
 *
 * Demonstrates:
 *   - Batch.get: fetch multiple items across entities in one call
 *   - Batch.write: put/delete multiple items in one call
 *   - Auto-chunking: DynamoDB limits (100 get, 25 write) handled transparently
 *   - Typed tuple returns: each position matches the input entity type
 *   - Cross-entity batching: mix User and Order in the same batch
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/batch.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  name: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),
}) {}

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  userId: Schema.String,
  product: Schema.NonEmptyString,
  quantity: Schema.Number,
  status: Schema.Literals(["pending", "shipped", "delivered"]),
}) {}

// ---------------------------------------------------------------------------
// 2. Schema + Table + Entities
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "batch-demo", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

const Users = Entity.make({
  model: User,
  table: MainTable,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
  },
  timestamps: true,
})

const Orders = Entity.make({
  model: Order,
  table: MainTable,
  entityType: "Order",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["orderId"] },
      sk: { field: "sk", composite: [] },
    },
    byUser: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["userId"] },
      sk: { field: "gsi1sk", composite: ["orderId"] },
    },
  },
  timestamps: true,
})

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const client = yield* DynamoClient

  // --- Create the table ---
  yield* Console.log("=== Setup ===\n")

  yield* client.createTable({
    TableName: "batch-demo-table",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(MainTable, [Users, Orders]),
  })
  yield* Console.log("Table created: batch-demo-table\n")

  // --- Batch.write — create multiple items at once ---
  yield* Console.log("=== Batch.write — Create Items ===\n")

  // Batch.write accepts a mix of put and delete operations.
  // DynamoDB limits batch writes to 25 items per request —
  // effect-dynamodb auto-chunks larger batches transparently.
  yield* Batch.write([
    Users.put({ userId: "u-1", email: "alice@example.com", name: "Alice", role: "admin" }),
    Users.put({ userId: "u-2", email: "bob@example.com", name: "Bob", role: "member" }),
    Users.put({ userId: "u-3", email: "charlie@example.com", name: "Charlie", role: "member" }),
    Orders.put({
      orderId: "o-1",
      userId: "u-1",
      product: "Widget",
      quantity: 2,
      status: "pending",
    }),
    Orders.put({
      orderId: "o-2",
      userId: "u-1",
      product: "Gadget",
      quantity: 1,
      status: "shipped",
    }),
    Orders.put({
      orderId: "o-3",
      userId: "u-2",
      product: "Doohickey",
      quantity: 5,
      status: "pending",
    }),
  ])
  yield* Console.log("Created 3 users + 3 orders in a single batch write\n")

  // --- Batch.get — fetch multiple items at once ---
  yield* Console.log("=== Batch.get — Fetch Items ===\n")

  // Batch.get returns a typed tuple: each position matches the entity type.
  // DynamoDB limits batch gets to 100 items per request —
  // effect-dynamodb auto-chunks and retries unprocessed keys.
  const [alice, bob, order1, order2] = yield* Batch.get([
    Users.get({ userId: "u-1" }),
    Users.get({ userId: "u-2" }),
    Orders.get({ orderId: "o-1" }),
    Orders.get({ orderId: "o-2" }),
  ])

  // Each result is Model | undefined (undefined if item doesn't exist)
  yield* Console.log(`User: ${alice?.name} (${alice?.role})`)
  yield* Console.log(`User: ${bob?.name} (${bob?.role})`)
  yield* Console.log(`Order: ${order1?.product} x${order1?.quantity} (${order1?.status})`)
  yield* Console.log(`Order: ${order2?.product} x${order2?.quantity} (${order2?.status})`)
  yield* Console.log("")

  // --- Batch.get with non-existent items ---
  yield* Console.log("=== Batch.get — Missing Items Return undefined ===\n")

  const [existing, missing] = yield* Batch.get([
    Users.get({ userId: "u-1" }),
    Users.get({ userId: "u-nonexistent" }),
  ])

  yield* Console.log(`Existing: ${existing?.name ?? "undefined"}`)
  yield* Console.log(`Missing: ${missing?.name ?? "undefined (as expected)"}`)
  yield* Console.log("")

  // --- Batch.write with deletes ---
  yield* Console.log("=== Batch.write — Mixed Put + Delete ===\n")

  yield* Batch.write([
    // Add a new order
    Orders.put({
      orderId: "o-4",
      userId: "u-3",
      product: "Thingamajig",
      quantity: 1,
      status: "pending",
    }),
    // Delete an existing order
    Orders.delete({ orderId: "o-3" }),
  ])
  yield* Console.log("Added order o-4 and deleted order o-3 in one batch\n")

  // Verify: o-3 is gone, o-4 exists
  const [deleted, created] = yield* Batch.get([
    Orders.get({ orderId: "o-3" }),
    Orders.get({ orderId: "o-4" }),
  ])
  yield* Console.log(`o-3: ${deleted?.product ?? "deleted (undefined)"}`)
  yield* Console.log(`o-4: ${created?.product ?? "missing"} (${created?.status})\n`)

  // --- Cross-entity batch write ---
  yield* Console.log("=== Cross-Entity Batch Write ===\n")

  yield* Batch.write([
    Users.put({ userId: "u-4", email: "diana@example.com", name: "Diana", role: "admin" }),
    Orders.put({
      orderId: "o-5",
      userId: "u-4",
      product: "Gizmo",
      quantity: 3,
      status: "pending",
    }),
    Users.delete({ userId: "u-3" }),
  ])
  yield* Console.log("Atomically created user u-4 + order o-5, deleted user u-3\n")

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* client.deleteTable({ TableName: "batch-demo-table" })
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 4. Provide dependencies and run
// ---------------------------------------------------------------------------

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "batch-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer), Effect.scoped)

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
