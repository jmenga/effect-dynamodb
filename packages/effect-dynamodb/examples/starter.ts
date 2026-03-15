/**
 * Starter example — effect-dynamodb v2
 *
 * Demonstrates: model definition, schema/table/entity setup, table creation
 * from entity definitions, and raw key composition.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/starter.ts
 */

import { marshall } from "@aws-sdk/util-dynamodb"
import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as KeyComposer from "../src/KeyComposer.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Define pure domain models — no DynamoDB concepts
// ---------------------------------------------------------------------------

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),
  createdBy: Schema.String.pipe(DynamoModel.Immutable),
}) {}

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  userId: Schema.String,
  title: Schema.NonEmptyString,
  status: Schema.Literals(["todo", "in-progress", "done"]),
  priority: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// 2. Application namespace + table
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "starter", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

// ---------------------------------------------------------------------------
// 3. Entity definitions — bind models to table with key rules
// ---------------------------------------------------------------------------

const Users = Entity.make({
  model: User,
  table: MainTable,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
    byEmail: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["email"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
  unique: { email: ["email"] },
  timestamps: true,
  versioned: true,
})

const Tasks = Entity.make({
  model: Task,
  table: MainTable,
  entityType: "Task",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
    byUser: {
      index: "gsi1",
      collection: "UserItems",
      type: "clustered",
      pk: { field: "gsi1pk", composite: ["userId"] },
      sk: { field: "gsi1sk", composite: ["status"] },
    },
  },
  timestamps: true,
})

// ---------------------------------------------------------------------------
// 4. Derive table infrastructure from entities
// ---------------------------------------------------------------------------

const tableDefinition = Table.definition(MainTable, [Users, Tasks])

// ---------------------------------------------------------------------------
// 5. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  const tableConfig = yield* MainTable.Tag

  // --- Create the table ---
  yield* Console.log("Creating table:", tableConfig.name)
  yield* Console.log("Table definition:", JSON.stringify(tableDefinition, null, 2))

  yield* client.createTable({
    TableName: tableConfig.name,
    BillingMode: "PAY_PER_REQUEST",
    ...tableDefinition,
  })
  yield* Console.log("Table created successfully!\n")

  // --- Show key composition ---
  yield* Console.log("=== Key Composition Examples ===\n")

  const userKeys = KeyComposer.composeAllKeys(AppSchema, "User", 1, Users.indexes, {
    userId: "u-alice",
    email: "alice@example.com",
  })
  yield* Console.log("User keys:", JSON.stringify(userKeys, null, 2))

  const taskKeys = KeyComposer.composeAllKeys(AppSchema, "Task", 1, Tasks.indexes, {
    taskId: "t-1",
    userId: "u-alice",
    status: "todo",
  })
  yield* Console.log("Task keys:", JSON.stringify(taskKeys, null, 2))

  // --- Insert raw items to show what the ORM will store ---
  yield* Console.log("\n=== Inserting raw items ===\n")

  const now = new Date().toISOString()

  yield* client.putItem({
    TableName: tableConfig.name,
    Item: marshall({
      ...userKeys,
      __edd_e__: "User",
      userId: "u-alice",
      email: "alice@example.com",
      displayName: "Alice",
      role: "admin",
      createdBy: "system",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
  })
  yield* Console.log("Inserted User: u-alice")

  yield* client.putItem({
    TableName: tableConfig.name,
    Item: marshall({
      ...taskKeys,
      __edd_e__: "Task",
      taskId: "t-1",
      userId: "u-alice",
      title: "Learn effect-dynamodb",
      status: "todo",
      priority: 1,
      createdAt: now,
      updatedAt: now,
    }),
  })
  yield* Console.log("Inserted Task: t-1")

  // --- Query by GSI to show collection pattern ---
  yield* Console.log("\n=== Query: Tasks by userId (GSI1 collection) ===\n")

  const skPrefix = KeyComposer.composeSortKeyPrefix(
    AppSchema,
    "Task",
    1,
    Tasks.indexes.byUser!,
    {}, // no SK composites — gets all tasks for the user
  )
  const pkValue = DynamoSchema.composeCollectionKey(AppSchema, "UserItems", ["u-alice"], undefined)

  const queryResult = yield* client.query({
    TableName: tableConfig.name,
    IndexName: "gsi1",
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
    ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
    ExpressionAttributeValues: marshall({ ":pk": pkValue, ":skPrefix": skPrefix }),
  })
  yield* Console.log(`Found ${queryResult.Items?.length ?? 0} items`)
  for (const item of queryResult.Items ?? []) {
    yield* Console.log("  ", JSON.stringify(item))
  }

  // --- Show derived types ---
  yield* Console.log("\n=== Entity-Derived Types ===\n")
  yield* Console.log("Users.entityType:", Users.entityType)
  yield* Console.log("Users.systemFields:", JSON.stringify(Users.systemFields))
  yield* Console.log("Key attributes:", Entity.keyAttributes(Users))
  yield* Console.log("All key field names:", Entity.keyFieldNames(Users))
  yield* Console.log("All composite attrs:", Entity.compositeAttributes(Users))

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===\n")
  yield* client.deleteTable({ TableName: tableConfig.name })
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 6. Provide dependencies and run
// ---------------------------------------------------------------------------

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "starter-table" }),
)

const main = program.pipe(Effect.provide(AppLayer), Effect.scoped)

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
