/**
 * Starter example — effect-dynamodb
 *
 * Demonstrates the foundational building blocks:
 *   - Pure domain models with Schema.Class
 *   - DynamoSchema + Table + Entity definitions
 *   - DynamoClient.make() — the typed execution gateway
 *   - Basic CRUD: put, get, update, delete
 *   - GSI query
 *   - Table infrastructure derived from entity definitions
 *   - Layer-based dependency injection
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/starter.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Define pure domain models — no DynamoDB concepts
// ---------------------------------------------------------------------------

const Role = { Admin: "admin", Member: "member" } as const
const RoleSchema = Schema.Literals(Object.values(Role))

const TaskStatus = { Todo: "todo", InProgress: "in-progress", Done: "done" } as const
const TaskStatusSchema = Schema.Literals(Object.values(TaskStatus))

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  role: RoleSchema,
  createdBy: Schema.String,
}) {}

const UserModel = DynamoModel.configure(User, {
  createdBy: { immutable: true },
})

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  userId: Schema.String,
  title: Schema.NonEmptyString,
  status: TaskStatusSchema,
  priority: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// 2. Application namespace
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "starter", version: 1 })

// ---------------------------------------------------------------------------
// 3. Entity definitions — pure definitions, no table reference
// ---------------------------------------------------------------------------

const Users = Entity.make({
  model: UserModel,
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
// 4. Table definition — declare entities as members
// ---------------------------------------------------------------------------

const MainTable = Table.make({ schema: AppSchema, entities: { Users, Tasks } })

// ---------------------------------------------------------------------------
// 5. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // Get typed client — binds all table members
  const db = yield* DynamoClient.make(MainTable)

  // --- Create the table (derived from entity definitions) ---
  yield* Console.log("=== Setup ===\n")

  yield* db.createTable()
  yield* Console.log("Table created\n")

  // --- Put: create items ---
  yield* Console.log("=== Put ===\n")

  const alice = yield* db.Users.put({
    userId: "u-alice",
    email: "alice@example.com",
    displayName: "Alice",
    role: "admin",
    createdBy: "system",
  })
  yield* Console.log(`Created user: ${alice.displayName} (${alice.email})`)

  yield* db.Tasks.put({
    taskId: "t-1",
    userId: "u-alice",
    title: "Learn effect-dynamodb",
    status: "todo",
    priority: 1,
  })

  yield* db.Tasks.put({
    taskId: "t-2",
    userId: "u-alice",
    title: "Build something cool",
    status: "in-progress",
    priority: 2,
  })
  yield* Console.log("Created tasks: t-1, t-2\n")

  // --- Get: read by primary key ---
  yield* Console.log("=== Get ===\n")

  const user = yield* db.Users.get({ userId: "u-alice" })
  yield* Console.log(`Got user: ${user.displayName} (role: ${user.role})`)

  const task = yield* db.Tasks.get({ taskId: "t-1" })
  yield* Console.log(`Got task: "${task.title}" (status: ${task.status})\n`)

  // --- Update ---
  yield* Console.log("=== Update ===\n")

  // Note: status is a GSI composite, so we must also provide userId
  // (all composites for the GSI) so the key can be recomposed
  const updated = yield* db.Tasks.update(
    { taskId: "t-1" },
    Entity.set({ status: "done", userId: "u-alice" }),
  )
  yield* Console.log(`Updated task: "${updated.title}" -> ${updated.status}\n`)

  // --- Query: tasks by user via GSI ---
  yield* Console.log("=== Query: Tasks by User (GSI) ===\n")

  const aliceTasks = yield* db.Tasks.collect(Tasks.query.byUser({ userId: "u-alice" }))
  yield* Console.log(`Alice's tasks (${aliceTasks.length}):`)
  for (const t of aliceTasks) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.status}`)
  }
  yield* Console.log("")

  // --- Delete ---
  yield* Console.log("=== Delete ===\n")

  yield* db.Tasks.delete({ taskId: "t-1" })
  yield* db.Tasks.delete({ taskId: "t-2" })
  yield* db.Users.delete({ userId: "u-alice" })
  yield* Console.log("Deleted all items\n")

  // --- Cleanup ---
  yield* db.deleteTable
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

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
