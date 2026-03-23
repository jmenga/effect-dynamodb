/**
 * Starter example — effect-dynamodb
 *
 * Demonstrates the foundational building blocks:
 *   - Pure domain models with Schema.Class
 *   - DynamoSchema + Table + Entity definitions
 *   - Collections for GSI access patterns
 *   - DynamoClient.make() — the typed execution gateway
 *   - Basic CRUD: put, get, update, delete
 *   - GSI query via Collections and BoundQuery builder
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
import * as Collections from "../src/Collections.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Define pure domain models — no DynamoDB concepts
// ---------------------------------------------------------------------------

// #region models
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
// #endregion

// ---------------------------------------------------------------------------
// 2. Application namespace
// ---------------------------------------------------------------------------

// #region schema
const AppSchema = DynamoSchema.make({ name: "starter", version: 1 })
// #endregion

// ---------------------------------------------------------------------------
// 3. Entity definitions — primary key only, no GSIs
// ---------------------------------------------------------------------------

// #region entities
const Users = Entity.make({
  model: UserModel,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { email: ["email"] },
  timestamps: true,
  versioned: true,
})

const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Users, Tasks } })

const UsersByEmail = Collections.make("usersByEmail", {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["email"] },
  sk: { field: "gsi1sk" },
  members: {
    Users: Collections.member(Users, { sk: { composite: [] } }),
  },
})

const TasksByUser = Collections.make("tasksByUser", {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["userId"] },
  sk: { field: "gsi1sk" },
  members: {
    Tasks: Collections.member(Tasks, { sk: { composite: ["status"] } }),
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 5. Main program
// ---------------------------------------------------------------------------

// #region program
const program = Effect.gen(function* () {
  // Get typed client — binds all entities and collections
  const db = yield* DynamoClient.make({
    entities: { Users, Tasks },
    collections: { UsersByEmail, TasksByUser },
  })

  // --- Create the table (derived from entity definitions) ---
  yield* Console.log("=== Setup ===\n")

  yield* db.tables["starter-table"]!.create()
  yield* Console.log("Table created\n")

  // --- Put: create items ---
  yield* Console.log("=== Put ===\n")

  const alice = yield* db.entities.Users.put({
    userId: "u-alice",
    email: "alice@example.com",
    displayName: "Alice",
    role: "admin",
    createdBy: "system",
  })
  yield* Console.log(`Created user: ${alice.displayName} (${alice.email})`)

  yield* db.entities.Tasks.put({
    taskId: "t-1",
    userId: "u-alice",
    title: "Learn effect-dynamodb",
    status: "todo",
    priority: 1,
  })

  yield* db.entities.Tasks.put({
    taskId: "t-2",
    userId: "u-alice",
    title: "Build something cool",
    status: "in-progress",
    priority: 2,
  })
  yield* Console.log("Created tasks: t-1, t-2\n")

  // --- Get: read by primary key ---
  yield* Console.log("=== Get ===\n")

  const user = yield* db.entities.Users.get({ userId: "u-alice" })
  yield* Console.log(`Got user: ${user.displayName} (role: ${user.role})`)

  const task = yield* db.entities.Tasks.get({ taskId: "t-1" })
  yield* Console.log(`Got task: "${task.title}" (status: ${task.status})\n`)

  // --- Update ---
  yield* Console.log("=== Update ===\n")

  // Note: status is a GSI composite, so we must also provide userId
  // (all composites for the GSI) so the key can be recomposed
  const updated = yield* db.entities.Tasks.update(
    { taskId: "t-1" },
    Entity.set({ status: "done", userId: "u-alice" }),
  )
  yield* Console.log(`Updated task: "${updated.title}" -> ${updated.status}\n`)

  // --- Query: tasks by user via collection ---
  yield* Console.log("=== Query: Tasks by User (GSI) ===\n")

  const { Tasks: aliceTasks } = yield* db.collections.TasksByUser({ userId: "u-alice" }).collect()
  yield* Console.log(`Alice's tasks (${aliceTasks.length}):`)
  for (const t of aliceTasks) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.status}`)
  }
  yield* Console.log("")

  // --- Delete ---
  yield* Console.log("=== Delete ===\n")

  yield* db.entities.Tasks.delete({ taskId: "t-1" })
  yield* db.entities.Tasks.delete({ taskId: "t-2" })
  yield* db.entities.Users.delete({ userId: "u-alice" })
  yield* Console.log("Deleted all items\n")

  // --- Cleanup ---
  yield* db.tables["starter-table"]!.delete()
  yield* Console.log("Table deleted.")
})
// #endregion

// ---------------------------------------------------------------------------
// 6. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region run
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
// #endregion
