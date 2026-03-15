/**
 * CRUD example — effect-dynamodb v2
 *
 * Demonstrates the full high-level API:
 *   - Entity operations return lazy intermediates (EntityGet, EntityPut, EntityUpdate)
 *   - Terminal-selected return types: yield* returns clean model (User),
 *     pipe to asRecord/asItem/asNative for richer decode modes
 *   - Pipeable update: Entity-scoped set() + expectedVersion() compose in pipe
 *   - GSI queries with pipeable combinators
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
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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

const AppSchema = DynamoSchema.make({ name: "crud-demo", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

// ---------------------------------------------------------------------------
// 3. Entity definitions — bind models to table with index rules
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
    byRole: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["role"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
  },
  timestamps: true,
  versioned: { retain: true },
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
      pk: { field: "gsi1pk", composite: ["userId"] },
      sk: { field: "gsi1sk", composite: ["status", "taskId"] },
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: true,
})

// ---------------------------------------------------------------------------
// 4. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const client = yield* DynamoClient

  // --- Create the table ---
  yield* Console.log("=== Setup ===\n")

  yield* client.createTable({
    TableName: "crud-demo-table",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(MainTable, [Users, Tasks]),
  })
  yield* Console.log("Table created: crud-demo-table\n")

  // --- Entity.put — create items ---
  yield* Console.log("=== Entity.put — Create Items ===\n")

  // Default: yield* returns the model type (User) — clean, no system fields
  const alice = yield* Users.put({
    userId: "u-alice",
    email: "alice@example.com",
    displayName: "Alice",
    role: "admin",
    createdBy: "system",
  })
  // alice: User — has userId, email, displayName, role, createdBy
  yield* Console.log(`Created User: ${alice.userId} (role: ${alice.role})`)

  // asRecord: opt-in for system fields (createdAt, updatedAt, version)
  const bobRecord = yield* Users.put({
    userId: "u-bob",
    email: "bob@example.com",
    displayName: "Bob",
    role: "member",
    createdBy: "system",
  }).pipe(Entity.asRecord)
  // bobRecord: User + { createdAt, updatedAt, version }
  yield* Console.log(
    `Created User: ${bobRecord.userId} (version: ${bobRecord.version}, createdAt: ${bobRecord.createdAt})`,
  )

  // Tasks: bare yield* returns Task
  const task1 = yield* Tasks.put({
    taskId: "t-1",
    userId: "u-alice",
    title: "Design the API",
    status: "done",
    priority: 1,
  })
  yield* Console.log(`Created Task: ${task1.taskId} — "${task1.title}" (${task1.status})`)

  yield* Tasks.put({
    taskId: "t-2",
    userId: "u-alice",
    title: "Write tests",
    status: "in-progress",
    priority: 2,
  })
  yield* Tasks.put({
    taskId: "t-3",
    userId: "u-alice",
    title: "Deploy to production",
    status: "todo",
    priority: 3,
  })
  yield* Tasks.put({
    taskId: "t-4",
    userId: "u-bob",
    title: "Review PRs",
    status: "todo",
    priority: 1,
  })
  yield* Console.log("Created Tasks: t-2, t-3, t-4\n")

  // --- Terminal-selected return types ---
  yield* Console.log("=== Terminal-Selected Return Types ===\n")

  // asModel (default): clean domain type — no keys, no system fields, no __edd_e__
  const userModel = yield* Users.get({ userId: "u-alice" })
  // userModel: User
  yield* Console.log(`asModel (default):  ${userModel.displayName}, role=${userModel.role}`)

  // asRecord: model + system fields (createdAt, updatedAt, version)
  const userRecord = yield* Users.get({ userId: "u-alice" }).pipe(Entity.asRecord)
  yield* Console.log(
    `asRecord:           ${userRecord.displayName}, version=${userRecord.version}, updatedAt=${userRecord.updatedAt}`,
  )

  // asNative: raw DynamoDB marshalled format — Record<string, AttributeValue>
  const userNative = yield* Users.get({ userId: "u-alice" }).pipe(Entity.asNative)
  yield* Console.log(`asNative:           ${JSON.stringify(userNative).slice(0, 120)}...`)
  yield* Console.log("")

  // --- Entity.update — pipeable combinators ---
  yield* Console.log("=== Entity.update — Pipeable Updates ===\n")

  // Users.update(key) returns a lazy EntityUpdate.
  // Users.set(fields) sets the update payload — type-safe in both paths.
  // Terminal selects decode mode (default = asModel).
  const updatedAlice = yield* Users.update({ userId: "u-alice" }).pipe(
    Users.set({ role: "member", displayName: "Alice W." }),
  )
  // updatedAlice: User — clean model type
  yield* Console.log(`Updated User: ${updatedAlice.displayName} (role: ${updatedAlice.role})`)

  // Combine set + asRecord to see version increment
  const updatedRecord = yield* Users.update({ userId: "u-alice" }).pipe(
    Users.set({ displayName: "Alice Wu" }),
    Entity.asRecord,
  )
  yield* Console.log(`  version after 2nd update: ${updatedRecord.version}`)
  yield* Console.log(`  createdBy: ${updatedRecord.createdBy} (immutable — unchanged)\n`)

  // --- Optimistic locking — expectedVersion combinator ---
  yield* Console.log("=== Optimistic Locking ===\n")

  // Users.expectedVersion(n) composes with set() in the same pipe
  const lockResult = yield* Users.update({ userId: "u-alice" }).pipe(
    Users.set({ displayName: "Alice Wrong" }),
    Users.expectedVersion(1), // version is now 3 — this will fail
    (op) => op.asEffect(),
    Effect.map(() => "unexpected success"),
    Effect.catchTag("OptimisticLockError", (e) =>
      Effect.succeed(
        `Caught OptimisticLockError: expected v${e.expectedVersion}, item has been updated`,
      ),
    ),
  )
  yield* Console.log(`${lockResult}\n`)

  // --- Error handling ---
  yield* Console.log("=== Error Handling — ItemNotFound ===\n")

  // Bare yield* returns User, error types flow through pipe
  const notFoundResult = yield* Users.get({ userId: "u-nonexistent" })
    .asEffect()
    .pipe(
      Effect.map((u) => `Found: ${u.userId}`),
      Effect.catchTag("ItemNotFound", (e) =>
        Effect.succeed(`Caught ItemNotFound: entity=${e.entityType}, key=${JSON.stringify(e.key)}`),
      ),
    )
  yield* Console.log(`${notFoundResult}\n`)

  // --- Entity.query — GSI queries (unchanged) ---
  yield* Console.log("=== Entity.query — GSI Queries ===\n")

  const aliceTasks = yield* Query.collect(Tasks.query.byUser({ userId: "u-alice" }))
  yield* Console.log(`Alice's tasks (${aliceTasks.length}):`)
  for (const t of aliceTasks) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.status} (priority: ${t.priority})`)
  }

  const admins = yield* Query.collect(Users.query.byRole({ role: "admin" }))
  yield* Console.log(`\nAdmins: ${admins.length} (Alice was demoted to member)`)

  const members = yield* Query.collect(Users.query.byRole({ role: "member" }))
  yield* Console.log(`Members: ${members.length}`)
  for (const u of members) {
    yield* Console.log(`  ${u.userId}: ${u.displayName}`)
  }
  yield* Console.log("")

  // --- Query combinators — where, reverse ---
  yield* Console.log("=== Query Combinators — where, reverse ===\n")

  const reversedTasks = yield* Tasks.query
    .byUser({ userId: "u-alice" })
    .pipe(Query.reverse, Query.collect)
  yield* Console.log(`Alice's tasks (reverse order):`)
  for (const t of reversedTasks) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.status}`)
  }
  yield* Console.log("")

  const todoTasks = yield* Tasks.query
    .byUser({ userId: "u-alice" })
    .pipe(Query.where({ beginsWith: "$crud-demo#v1#task#todo" }), Query.collect)
  yield* Console.log(`Alice's "todo" tasks (SK beginsWith filter): ${todoTasks.length}`)
  for (const t of todoTasks) {
    yield* Console.log(`  ${t.taskId}: "${t.title}"`)
  }
  yield* Console.log("")

  // --- Transactions — composable API using entity intermediates ---
  yield* Console.log("=== Transactions ===\n")

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
  yield* Console.log("transactWrite: atomically created User u-charlie + Task t-5")

  // Verify — bare yield* returns model types
  const charlie = yield* Users.get({ userId: "u-charlie" })
  yield* Console.log(`  User: ${charlie.displayName} (${charlie.role})`)
  const charlieTask = yield* Tasks.get({ taskId: "t-5" })
  yield* Console.log(`  Task: "${charlieTask.title}" (${charlieTask.status})`)

  // transactGet — typed tuple return, no manual cast needed
  const [txAlice, txBob, txTask] = yield* Transaction.transactGet([
    Users.get({ userId: "u-alice" }),
    Users.get({ userId: "u-bob" }),
    Tasks.get({ taskId: "t-1" }),
  ])
  // txAlice: User | undefined, txBob: User | undefined, txTask: Task | undefined
  yield* Console.log(`\ntransactGet: fetched 3 items atomically`)
  yield* Console.log(`  User: ${txAlice?.displayName} (${txAlice?.role})`)
  yield* Console.log(`  User: ${txBob?.displayName} (${txBob?.role})`)
  yield* Console.log(`  Task: "${txTask?.title}" (${txTask?.status})\n`)

  // --- Sparse GSI — items only appear in the index when composites are present ---
  yield* Console.log("=== Sparse GSI — Put ===\n")

  // DynamoDB sparse index behavior: if the GSI key attributes aren't on an item,
  // the item doesn't appear in that GSI. Useful for optional indexes (e.g., only
  // assigned projects appear in the assignee index, only premium users by tier).
  //
  // On put: if all composites for a GSI are present, keys are composed and written.
  //         If any are missing, that GSI is skipped — the item is stored without those keys.
  //         Primary index composites are always required.

  class Project extends Schema.Class<Project>("Project")({
    projectId: Schema.String,
    name: Schema.NonEmptyString,
    // Optional — only assigned projects have these
    ownerId: Schema.optional(Schema.String),
    department: Schema.optional(Schema.String),
  }) {}

  const Projects = Entity.make({
    model: Project,
    table: MainTable,
    entityType: "Project",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["projectId"] },
        sk: { field: "sk", composite: [] },
      },
      byOwner: {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["ownerId"] },
        sk: { field: "gsi1sk", composite: ["department"] },
      },
    },
    timestamps: true,
  })

  // GOOD: Put with all GSI composites — item appears in the byOwner index
  const assigned = yield* Projects.put({
    projectId: "p-1",
    name: "Alpha",
    ownerId: "u-alice",
    department: "engineering",
  })
  yield* Console.log(`Created assigned project: ${assigned.name} (owner: ${assigned.ownerId})`)
  yield* Console.log(`  → Item appears in byOwner GSI`)

  // GOOD: Put without GSI composites — sparse, item stored without GSI keys
  const unassigned = yield* Projects.put({
    projectId: "p-2",
    name: "Beta",
    // ownerId and department omitted — GSI keys won't be written
  })
  yield* Console.log(`Created unassigned project: ${unassigned.name}`)
  yield* Console.log(`  → Item does NOT appear in byOwner GSI (sparse)`)

  // GOOD: Query the GSI — only assigned projects appear
  const ownerProjects = yield* Query.collect(Projects.query.byOwner({ ownerId: "u-alice" }))
  yield* Console.log(`\nProjects owned by Alice: ${ownerProjects.length}`)
  for (const p of ownerProjects) {
    yield* Console.log(`  ${p.projectId}: ${p.name}`)
  }
  // "Beta" is absent — that's the sparse index at work
  yield* Console.log("")

  // -------------------------------------------------------------------------
  // Update all-or-none constraint
  // -------------------------------------------------------------------------
  yield* Console.log("=== Sparse GSI — Update All-or-None ===\n")

  // On update: if the payload includes ANY composite for a GSI, ALL composites
  // for that GSI must be present. This prevents stale GSI entries where one
  // key part changes but the other stays outdated.
  //
  // The type-level constraint enforces this when GSI composites are required
  // fields in the model (the common case for updates — the item already has
  // these values, and you're changing them).

  class Employee extends Schema.Class<Employee>("Employee")({
    employeeId: Schema.String,
    name: Schema.NonEmptyString,
    tenantId: Schema.String, // required — every employee belongs to a tenant
    region: Schema.String, // required — every employee has a region
  }) {}

  const Employees = Entity.make({
    model: Employee,
    table: MainTable,
    entityType: "Employee",
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["employeeId"] },
        sk: { field: "sk", composite: [] },
      },
      byTenant: {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["region"] },
      },
    },
  })

  yield* Employees.put({
    employeeId: "e-1",
    name: "Alice",
    tenantId: "t-1",
    region: "us-east-1",
  })

  // GOOD: Update without touching GSI composites — GSI keys untouched
  yield* Employees.update({ employeeId: "e-1" }).pipe(
    Employees.set({ name: "Alice W." }), // name is not a GSI composite
  )
  yield* Console.log(`Updated name only (GSI keys unchanged)`)

  // GOOD: Update ALL composites of a GSI — GSI keys recomposed
  yield* Employees.update({ employeeId: "e-1" }).pipe(
    Employees.set({ tenantId: "t-2", region: "eu-west-1" }), // both provided
  )
  yield* Console.log(`Transferred to t-2/eu-west-1 (GSI keys recomposed)`)

  // BAD: Update with PARTIAL GSI composites — runtime error
  //
  // The update type is Partial, so { tenantId: "t-3" } passes the type checker.
  // However, runtime validation catches it: if ANY composite for a GSI is provided,
  // ALL composites for that GSI must be present. This prevents stale GSI entries
  // where one key part changes but the other stays outdated.
  //
  const partialResult = yield* Employees.update({ employeeId: "e-1" }).pipe(
    Employees.set({ tenantId: "t-3" }), // valid at type level (Partial), caught at runtime
    (op) => op.asEffect(),
    Effect.map(() => "unexpected success"),
    Effect.catchTag("ValidationError", (e) => Effect.succeed(`Caught ValidationError: ${e.cause}`)),
  )
  yield* Console.log(`\nPartial GSI update (bad): ${partialResult}`)
  yield* Console.log("  → Must provide both tenantId AND region, or neither\n")

  // --- Entity.delete (hard delete — returns void) ---
  yield* Console.log("=== Entity.delete (Hard Delete) ===\n")

  yield* Users.delete({ userId: "u-charlie" })
  yield* Console.log("Deleted User: u-charlie")

  const afterDelete = yield* Users.get({ userId: "u-charlie" })
    .asEffect()
    .pipe(
      Effect.map(() => "still exists!"),
      Effect.catchTag("ItemNotFound", () => Effect.succeed("confirmed deleted")),
    )
  yield* Console.log(`  Verification: ${afterDelete}\n`)

  // --- Version history — versioned: { retain: true } ---
  yield* Console.log("=== Version History (retain: true) ===\n")

  // Every put/update/delete creates a version snapshot in the same partition.
  // Alice was created (v1), updated twice (v2, v3). Let's check her history.

  // getVersion: fetch a specific version snapshot
  const aliceV1 = yield* Users.getVersion({ userId: "u-alice" }, 1).pipe(Entity.asRecord)
  yield* Console.log(`Version 1: ${aliceV1.displayName} (role: ${aliceV1.role})`)

  const aliceV2 = yield* Users.getVersion({ userId: "u-alice" }, 2).pipe(Entity.asRecord)
  yield* Console.log(`Version 2: ${aliceV2.displayName} (role: ${aliceV2.role})`)

  // versions: query all version snapshots (returns a Query — pipe with combinators)
  const allVersions = yield* Users.versions({ userId: "u-alice" }).pipe(Query.collect)
  yield* Console.log(`\nAll versions for Alice: ${allVersions.length} snapshots`)
  for (const v of allVersions) {
    yield* Console.log(`  v${v.version}: ${v.displayName} (role: ${v.role})`)
  }

  // Non-existent version → ItemNotFound
  const noVersion = yield* Users.getVersion({ userId: "u-alice" }, 99)
    .asEffect()
    .pipe(
      Effect.map(() => "found!"),
      Effect.catchTag("ItemNotFound", () => Effect.succeed("ItemNotFound (expected)")),
    )
  yield* Console.log(`\nVersion 99: ${noVersion}\n`)

  // --- Soft delete — softDelete: true on Tasks ---
  yield* Console.log("=== Soft Delete (Tasks) ===\n")

  // Soft-delete archives an item instead of permanently removing it.
  // The item's GSI keys are stripped, so it vanishes from index queries.

  // Delete t-1 (Design the API — already done)
  yield* Tasks.delete({ taskId: "t-1" })
  yield* Console.log("Soft-deleted Task: t-1 (Design the API)")

  // Verify: t-1 no longer appears in GSI queries
  const aliceTasksAfterDelete = yield* Query.collect(Tasks.query.byUser({ userId: "u-alice" }))
  yield* Console.log(
    `Alice's active tasks: ${aliceTasksAfterDelete.length} (was 3, now t-1 is archived)`,
  )

  // But we can still retrieve the soft-deleted item via deleted.get
  // Use asItem to access deletedAt — a system field added by soft-delete, not part of the model
  const deletedTask = yield* Tasks.deleted.get({ taskId: "t-1" }).pipe(Entity.asItem)
  yield* Console.log(`\ndeleted.get: "${deletedTask.title}" — deletedAt: ${deletedTask.deletedAt}`)

  // deleted.list: query all soft-deleted items for a partition key
  // (useful for admin views showing archived items)

  // --- Restore — un-soft-delete ---
  yield* Console.log("\n=== Restore (Un-Soft-Delete) ===\n")

  // Restore brings a soft-deleted item back to life:
  // - Recomposes all GSI keys so it reappears in index queries
  // - Increments version
  // - Creates a version snapshot (if retain is enabled)
  const restored = yield* Tasks.restore({ taskId: "t-1" }).pipe(Entity.asRecord)
  yield* Console.log(
    `Restored Task: "${restored.title}" (status: ${restored.status}, version: ${restored.version})`,
  )

  // Verify: t-1 is back in GSI queries
  const aliceTasksAfterRestore = yield* Query.collect(Tasks.query.byUser({ userId: "u-alice" }))
  yield* Console.log(`Alice's active tasks: ${aliceTasksAfterRestore.length} (t-1 is back)`)

  // Restore a non-existent soft-deleted item → ItemNotFound
  const restoreResult = yield* Tasks.restore({ taskId: "t-nonexistent" })
    .asEffect()
    .pipe(
      Effect.map(() => "restored!"),
      Effect.catchTag("ItemNotFound", () => Effect.succeed("ItemNotFound (no soft-deleted item)")),
    )
  yield* Console.log(`\nRestore non-deleted: ${restoreResult}\n`)

  // --- Purge — permanently remove all traces ---
  yield* Console.log("=== Purge (Permanent Removal) ===\n")

  // Purge deletes EVERYTHING for a partition key:
  // the current item, all version snapshots, and any soft-deleted copies.
  // This is the nuclear option — use for GDPR "right to erasure" or cleanup.
  yield* Users.purge({ userId: "u-bob" })
  yield* Console.log("Purged User: u-bob (all items, versions, and snapshots removed)")

  const purgeVerify = yield* Users.get({ userId: "u-bob" })
    .asEffect()
    .pipe(
      Effect.map(() => "still exists!"),
      Effect.catchTag("ItemNotFound", () => Effect.succeed("completely gone")),
    )
  yield* Console.log(`  Verification: ${purgeVerify}\n`)

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* client.deleteTable({ TableName: "crud-demo-table" })
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 5. Provide dependencies and run
// ---------------------------------------------------------------------------

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "crud-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer), Effect.scoped)

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
