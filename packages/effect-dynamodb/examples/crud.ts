/**
 * CRUD example — effect-dynamodb
 *
 * Demonstrates the full high-level API:
 *   - Entity-level indexes for GSI access patterns
 *   - DynamoClient.make({ entities }) returns typed gateway
 *   - Terminal-selected return types: yield* returns clean model (User),
 *     pipe to asRecord/asItem/asNative for richer decode modes
 *   - Simplified updates: db.entities.Users.update(key, fields) with pipeable combinators
 *   - Collection queries with fluent combinators
 *   - Atomic transactions
 *   - Version history: versioned: { retain: true } creates snapshots on every mutation
 *   - Soft delete: tasks can be archived and restored
 *   - Purge: permanently remove all traces of an entity
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/crud.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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

// #region entities
const AppSchema = DynamoSchema.make({ name: "crud-demo", version: 1 })

const Users = Entity.make({
  model: UserModel,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byRole: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["role"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
  },
  timestamps: true,
  versioned: { retain: true },
})

const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byUser: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["userId"] },
      sk: { field: "gsi1sk", composite: ["status", "taskId"] },
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: true,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Users, Tasks },
})
// #endregion

// --- Sparse GSI demonstration entities ---

// #region sparse-models
class Project extends Schema.Class<Project>("Project")({
  projectId: Schema.String,
  name: Schema.NonEmptyString,
  // Optional — only assigned projects have these
  ownerId: Schema.optional(Schema.String),
  department: Schema.optional(Schema.String),
}) {}

const Projects = Entity.make({
  model: Project,
  entityType: "Project",
  primaryKey: {
    pk: { field: "pk", composite: ["projectId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byOwner: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["ownerId"] },
      sk: { field: "gsi1sk", composite: ["department"] },
    },
  },
  timestamps: true,
})
// #endregion

// #region sparse-employee
class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String,
  name: Schema.NonEmptyString,
  tenantId: Schema.String, // required — every employee belongs to a tenant
  region: Schema.String, // required — every employee has a region
}) {}

const Employees = Entity.make({
  model: Employee,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employeeId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["region"] },
    },
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 4. Table definition — declares all members
// ---------------------------------------------------------------------------

// #region table
const ProjectTable = Table.make({
  schema: AppSchema,
  entities: { Projects, Employees },
})
// #endregion

// ---------------------------------------------------------------------------
// 5. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // #region client
  // Typed execution gateway — binds all entities and collections
  const db = yield* DynamoClient.make({
    entities: { Users, Tasks, Projects, Employees },
  })
  // #endregion

  // --- Create the table ---
  yield* Console.log("=== Setup ===\n")

  yield* db.tables["crud-demo-table"]!.create()
  yield* Console.log("Table created: crud-demo-table\n")

  // --- Entity.put — create items ---
  yield* Console.log("=== Entity.put — Create Items ===\n")

  // #region put
  // Default: yield* returns the model type (User) — clean, no system fields
  const alice = yield* db.entities.Users.put({
    userId: "u-alice",
    email: "alice@example.com",
    displayName: "Alice",
    role: "admin",
    createdBy: "system",
  })
  // alice: User — has userId, email, displayName, role, createdBy

  // For asRecord decode mode, use entity definitions with Effect.provide
  const bob = yield* db.entities.Users.put({
    userId: "u-bob",
    email: "bob@example.com",
    displayName: "Bob",
    role: "member",
    createdBy: "system",
  })
  // #endregion
  yield* Console.log(`Created User: ${alice.userId} (role: ${alice.role})`)
  yield* Console.log(`Created User: ${bob.userId}`)

  // #region put-tasks
  // Tasks: bare yield* returns Task
  const task1 = yield* db.entities.Tasks.put({
    taskId: "t-1",
    userId: "u-alice",
    title: "Design the API",
    status: "done",
    priority: 1,
  })

  yield* db.entities.Tasks.put({
    taskId: "t-2",
    userId: "u-alice",
    title: "Write tests",
    status: "in-progress",
    priority: 2,
  })
  // #endregion
  yield* Console.log(`Created Task: ${task1.taskId} — "${task1.title}" (${task1.status})`)

  yield* db.entities.Tasks.put({
    taskId: "t-3",
    userId: "u-alice",
    title: "Deploy to production",
    status: "todo",
    priority: 3,
  })
  yield* db.entities.Tasks.put({
    taskId: "t-4",
    userId: "u-bob",
    title: "Review PRs",
    status: "todo",
    priority: 1,
  })
  yield* Console.log("Created Tasks: t-2, t-3, t-4\n")

  // --- Terminal-selected return types ---
  yield* Console.log("=== Terminal-Selected Return Types ===\n")

  // #region get
  // Default: clean domain type — no keys, no system fields, no __edd_e__
  const userModel = yield* db.entities.Users.get({ userId: "u-alice" })
  // userModel: User
  // #endregion
  yield* Console.log(`Default (model):  ${userModel.displayName}, role=${userModel.role}`)
  yield* Console.log("")

  // --- Entity.update — pipeable combinators ---
  yield* Console.log("=== Entity.update — Pipeable Updates ===\n")

  // #region update
  // db.entities.Users.update(key, ...combinators) — update via bound entity
  const updatedAlice = yield* db.entities.Users.update(
    { userId: "u-alice" },
    Entity.set({ role: "member", displayName: "Alice W." }),
  )
  // updatedAlice: User — clean model type

  // Second update
  const updatedAlice2 = yield* db.entities.Users.update(
    { userId: "u-alice" },
    Entity.set({ displayName: "Alice Wu" }),
  )
  // updatedAlice2.createdBy → "system" (immutable — unchanged)
  // #endregion
  yield* Console.log(`Updated User: ${updatedAlice.displayName} (role: ${updatedAlice.role})`)
  yield* Console.log(`  displayName after 2nd update: ${updatedAlice2.displayName}`)
  yield* Console.log(`  createdBy: ${updatedAlice2.createdBy} (immutable — unchanged)\n`)

  // --- Optimistic locking — expectedVersion combinator ---
  yield* Console.log("=== Optimistic Locking ===\n")

  // #region locking
  // expectedVersion(n) composes with update
  const lockResult = yield* db.entities.Users.update(
    { userId: "u-alice" },
    Entity.set({ displayName: "Alice Wrong" }),
    Entity.expectedVersion(1), // version is now 3 — this will fail
  ).pipe(
    Effect.catchTag("OptimisticLockError", (e) =>
      Effect.succeed(`Expected v${e.expectedVersion}, item has been updated`),
    ),
  )
  // #endregion
  yield* Console.log(`${lockResult}\n`)

  // --- Error handling ---
  yield* Console.log("=== Error Handling — ItemNotFound ===\n")

  // #region error-handling
  // Bound methods return Effects — error types flow through pipe
  const notFoundResult = yield* db.entities.Users.get({ userId: "u-nonexistent" }).pipe(
    Effect.map((u) => `Found: ${u.userId}`),
    Effect.catchTag("ItemNotFound", (e) =>
      Effect.succeed(`Not found: entity=${e.entityType}, key=${JSON.stringify(e.key)}`),
    ),
  )
  // #endregion
  yield* Console.log(`${notFoundResult}\n`)

  // --- Collection queries — GSI queries ---
  yield* Console.log("=== Collection Queries — GSI Queries ===\n")

  // #region query
  const aliceTasks = yield* db.entities.Tasks.byUser({ userId: "u-alice" }).collect()

  const admins = yield* db.entities.Users.byRole({ role: "admin" }).collect()
  // #endregion
  yield* Console.log(`Alice's tasks (${aliceTasks.length}):`)
  for (const t of aliceTasks) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.status} (priority: ${t.priority})`)
  }

  yield* Console.log(`\nAdmins: ${admins.length} (Alice was demoted to member)`)

  const members = yield* db.entities.Users.byRole({ role: "member" }).collect()
  yield* Console.log(`Members: ${members.length}`)
  for (const u of members) {
    yield* Console.log(`  ${u.userId}: ${u.displayName}`)
  }
  yield* Console.log("")

  // --- Query combinators — filter, reverse ---
  yield* Console.log("=== Query Combinators — filter, reverse ===\n")

  // #region query-combinators
  // Reverse sort order
  const reversedTasks = yield* db.entities.Tasks.byUser({ userId: "u-alice" }).reverse().collect()

  // Filter expression (post-read filter)
  const todoTasks = yield* db.entities.Tasks.byUser({ userId: "u-alice" })
    .filter({ status: "todo" })
    .collect()
  // #endregion
  yield* Console.log(`Alice's tasks (reverse order):`)
  for (const t of reversedTasks) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.status}`)
  }
  yield* Console.log("")

  yield* Console.log(`Alice's "todo" tasks (filter): ${todoTasks.length}`)
  for (const t of todoTasks) {
    yield* Console.log(`  ${t.taskId}: "${t.title}"`)
  }
  yield* Console.log("")

  // --- Transactions — composable API using entity intermediates ---
  yield* Console.log("=== Transactions ===\n")

  // #region transact-write
  yield* Transaction.transactWrite([
    Users.put({
      userId: "u-charlie",
      email: "charlie@example.com",
      displayName: "Charlie",
      role: "member",
      createdBy: "admin",
    }),
    Tasks.put({
      taskId: "t-5",
      userId: "u-charlie",
      title: "Onboarding checklist",
      status: "todo",
      priority: 1,
    }),
  ])
  // #endregion
  yield* Console.log("transactWrite: atomically created User u-charlie + Task t-5")

  // Verify — bound methods return model types
  const charlie = yield* db.entities.Users.get({ userId: "u-charlie" })
  yield* Console.log(`  User: ${charlie.displayName} (${charlie.role})`)
  const charlieTask = yield* db.entities.Tasks.get({ taskId: "t-5" })
  yield* Console.log(`  Task: "${charlieTask.title}" (${charlieTask.status})`)

  // #region transact-get
  // transactGet — typed tuple return, no manual cast needed
  const [txAlice, txBob, txTask] = yield* Transaction.transactGet([
    Users.get({ userId: "u-alice" }),
    Users.get({ userId: "u-bob" }),
    Tasks.get({ taskId: "t-1" }),
  ])
  // txAlice: User | undefined, txBob: User | undefined, txTask: Task | undefined
  // #endregion
  yield* Console.log(`\ntransactGet: fetched 3 items atomically`)
  yield* Console.log(`  User: ${txAlice?.displayName} (${txAlice?.role})`)
  yield* Console.log(`  User: ${txBob?.displayName} (${txBob?.role})`)
  yield* Console.log(`  Task: "${txTask?.title}" (${txTask?.status})\n`)

  // --- Sparse GSI — items only appear in the index when composites are present ---
  yield* Console.log("=== Sparse GSI — Put ===\n")

  // #region sparse-put
  // Assigned project — appears in ProjectsByOwner collection
  const assigned = yield* db.entities.Projects.put({
    projectId: "p-1",
    name: "Alpha",
    ownerId: "u-alice",
    department: "engineering",
  })

  // Unassigned project — does NOT appear in ProjectsByOwner (sparse)
  const unassigned = yield* db.entities.Projects.put({
    projectId: "p-2",
    name: "Beta",
    // ownerId and department omitted
  })

  // Query only returns assigned projects
  const ownerProjects = yield* db.entities.Projects.byOwner({ ownerId: "u-alice" }).collect()
  // → [{ projectId: "p-1", name: "Alpha" }]
  // "Beta" is absent — sparse index at work
  // #endregion
  yield* Console.log(`Created assigned project: ${assigned.name} (owner: ${assigned.ownerId})`)
  yield* Console.log(`  → Item appears in ProjectsByOwner collection`)
  yield* Console.log(`Created unassigned project: ${unassigned.name}`)
  yield* Console.log(`  → Item does NOT appear in ProjectsByOwner (sparse)`)

  yield* Console.log(`\nProjects owned by Alice: ${ownerProjects.length}`)
  for (const p of ownerProjects) {
    yield* Console.log(`  ${p.projectId}: ${p.name}`)
  }
  yield* Console.log("")

  // -------------------------------------------------------------------------
  // Update all-or-none constraint
  // -------------------------------------------------------------------------
  yield* Console.log("=== Sparse GSI — Update All-or-None ===\n")

  yield* db.entities.Employees.put({
    employeeId: "e-1",
    name: "Alice",
    tenantId: "t-1",
    region: "us-east-1",
  })

  // #region sparse-update
  // GOOD: Update without touching GSI composites
  yield* db.entities.Employees.update({ employeeId: "e-1" }, Entity.set({ name: "Alice W." }))

  // GOOD: Update ALL composites of a GSI
  yield* db.entities.Employees.update(
    { employeeId: "e-1" },
    Entity.set({ tenantId: "t-2", region: "eu-west-1" }),
  )

  // BAD: Partial GSI composites — runtime ValidationError
  yield* db.entities.Employees.update(
    { employeeId: "e-1" },
    Entity.set({ tenantId: "t-3" }), // missing region!
  ).pipe(
    Effect.catchTag("ValidationError", (e) =>
      Effect.succeed(`Must provide both tenantId AND region, or neither`),
    ),
  )
  // #endregion
  yield* Console.log(`Updated name only (GSI keys unchanged)`)
  yield* Console.log(`Transferred to t-2/eu-west-1 (GSI keys recomposed)\n`)

  // --- Entity.delete (hard delete — returns void) ---
  yield* Console.log("=== Entity.delete (Hard Delete) ===\n")

  // #region delete
  yield* db.entities.Users.delete({ userId: "u-charlie" })

  // Confirm deletion
  const afterDelete = yield* db.entities.Users.get({ userId: "u-charlie" }).pipe(
    Effect.map(() => "still exists!"),
    Effect.catchTag("ItemNotFound", () => Effect.succeed("confirmed deleted")),
  )
  // #endregion
  yield* Console.log("Deleted User: u-charlie")
  yield* Console.log(`  Verification: ${afterDelete}\n`)

  // --- Version history — versioned: { retain: true } ---
  yield* Console.log("=== Version History (retain: true) ===\n")

  // #region versions
  // Fetch a specific version
  const aliceV1 = yield* db.entities.Users.getVersion({ userId: "u-alice" }, 1)
  // aliceV1.displayName → "Alice", aliceV1.role → "admin"

  const aliceV2 = yield* db.entities.Users.getVersion({ userId: "u-alice" }, 2)
  // aliceV2.displayName → "Alice W.", aliceV2.role → "member"

  // Query all version snapshots
  const allVersions = yield* db.entities.Users.collect(Users.versions({ userId: "u-alice" }))
  // → [{ version: 1, ... }, { version: 2, ... }, { version: 3, ... }]

  // Non-existent version → ItemNotFound
  yield* db.entities.Users.getVersion({ userId: "u-alice" }, 99).pipe(
    Effect.catchTag("ItemNotFound", () => Effect.succeed("not found")),
  )
  // #endregion
  yield* Console.log(`Version 1: ${aliceV1.displayName} (role: ${aliceV1.role})`)
  yield* Console.log(`Version 2: ${aliceV2.displayName} (role: ${aliceV2.role})`)

  yield* Console.log(`\nAll versions for Alice: ${allVersions.length} snapshots`)
  for (const v of allVersions) {
    yield* Console.log(`  ${v.displayName} (role: ${v.role})`)
  }
  yield* Console.log("")

  // --- Soft delete — softDelete: true on Tasks ---
  yield* Console.log("=== Soft Delete (Tasks) ===\n")

  // #region soft-delete
  yield* db.entities.Tasks.delete({ taskId: "t-1" })

  // No longer in collection queries
  const aliceTasksAfterDelete = yield* db.entities.Tasks.byUser({ userId: "u-alice" }).collect()
  // t-1 is absent

  // But retrievable via deleted.get
  const deletedTask = yield* db.entities.Tasks.deleted.get({ taskId: "t-1" })
  // deletedTask.title → "Design the API"
  // #endregion
  yield* Console.log("Soft-deleted Task: t-1 (Design the API)")
  yield* Console.log(
    `Alice's active tasks: ${aliceTasksAfterDelete.length} (was 3, now t-1 is archived)`,
  )
  yield* Console.log(`\ndeleted.get: "${deletedTask.title}"`)

  // --- Restore — un-soft-delete ---
  yield* Console.log("\n=== Restore (Un-Soft-Delete) ===\n")

  // #region restore
  const restored = yield* db.entities.Tasks.restore({ taskId: "t-1" })
  // restored.title → "Design the API"
  // restored.status → "done"

  // Back in collection queries
  const aliceTasksAfterRestore = yield* db.entities.Tasks.byUser({ userId: "u-alice" }).collect()
  // t-1 is back
  // #endregion
  yield* Console.log(`Restored Task: "${restored.title}" (status: ${restored.status})`)
  yield* Console.log(`Alice's active tasks: ${aliceTasksAfterRestore.length} (t-1 is back)`)

  // Restore a non-existent soft-deleted item → ItemNotFound
  const restoreResult = yield* db.entities.Tasks.restore({ taskId: "t-nonexistent" }).pipe(
    Effect.map(() => "restored!"),
    Effect.catchTag("ItemNotFound", () => Effect.succeed("ItemNotFound (no soft-deleted item)")),
  )
  yield* Console.log(`\nRestore non-deleted: ${restoreResult}\n`)

  // --- Purge — permanently remove all traces ---
  yield* Console.log("=== Purge (Permanent Removal) ===\n")

  // #region purge
  yield* db.entities.Users.purge({ userId: "u-bob" })

  // Completely gone — no item, no versions, no snapshots
  yield* db.entities.Users.get({ userId: "u-bob" }).pipe(
    Effect.catchTag("ItemNotFound", () => Effect.succeed("completely gone")),
  )
  // #endregion
  yield* Console.log("Purged User: u-bob (all items, versions, and snapshots removed)\n")

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* db.tables["crud-demo-table"]!.delete()
  yield* Console.log("Table deleted.")
})

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
  MainTable.layer({ name: "crud-demo-table" }),
  ProjectTable.layer({ name: "crud-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("Done."),
  (err) => console.error("Failed:", err),
)
// #endregion
