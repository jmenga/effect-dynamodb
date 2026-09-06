/**
 * Guide: Queries — effect-dynamodb
 *
 * Demonstrates the query API as documented in the Queries guide:
 *   - Entity scan via BoundQuery: db.entities.Entity.scan()
 *   - Entity index queries via db.entities.Entity.indexName({...})
 *   - Post-query filtering (callback and shorthand)
 *   - Pagination: collect, single page (fetch), cursor-based, streaming
 *   - Scan: basic, filtered, limited, consistent read, stream
 *   - Consistent reads on get and scan
 *   - Reverse ordering
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-queries.ts
 */

import { Console, Effect, Layer, Schema, Stream } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

// #region models
const TaskStatus = { Todo: "todo", Active: "active", Done: "done" } as const
const TaskStatusSchema = Schema.Literals(Object.values(TaskStatus))

const Priority = { Low: "low", Medium: "medium", High: "high" } as const
const PrioritySchema = Schema.Literals(Object.values(Priority))

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  projectId: Schema.String,
  assigneeId: Schema.String,
  title: Schema.NonEmptyString,
  status: TaskStatusSchema,
  priority: PrioritySchema,
  createdAt: Schema.String,
  estimateHours: Schema.Number,
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Schema + Entity + Table
// ---------------------------------------------------------------------------

// #region entities
const AppSchema = DynamoSchema.make({ name: "guide-queries", version: 1 })

const TaskEntity = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byProject: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["projectId"] },
      sk: { field: "gsi1sk", composite: ["status", "createdAt"] },
    },
    byAssignee: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["assigneeId"] },
      sk: { field: "gsi2sk", composite: ["status", "createdAt"] },
    },
    // Numeric sort key composite — zero-padded in the key so it sorts
    // numerically, and `.where()` takes a `number`.
    byEstimate: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["projectId"] },
      sk: { field: "gsi3sk", composite: ["estimateHours"] },
    },
  },
  timestamps: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { TaskEntity } })
// #endregion

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

// #region program
const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { TaskEntity },
  })
  const tasks = db.entities.TaskEntity

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")
  yield* db.tables["guide-queries-table"]!.create()
  yield* Console.log("Table created")

  // Seed data
  // #region seed
  const seedTasks = [
    {
      taskId: "t-001",
      projectId: "proj-alpha",
      assigneeId: "emp-alice",
      title: "Design API schema",
      status: "done" as const,
      priority: "high" as const,
      createdAt: "2025-01-15",
      estimateHours: 3,
    },
    {
      taskId: "t-002",
      projectId: "proj-alpha",
      assigneeId: "emp-alice",
      title: "Implement REST endpoints",
      status: "active" as const,
      priority: "high" as const,
      createdAt: "2025-02-01",
      estimateHours: 8,
    },
    {
      taskId: "t-003",
      projectId: "proj-alpha",
      assigneeId: "emp-bob",
      title: "Write integration tests",
      status: "active" as const,
      priority: "medium" as const,
      createdAt: "2025-02-10",
      estimateHours: 13,
    },
    {
      taskId: "t-004",
      projectId: "proj-alpha",
      assigneeId: "emp-bob",
      title: "Set up CI pipeline",
      status: "todo" as const,
      priority: "low" as const,
      createdAt: "2025-03-01",
      estimateHours: 2,
    },
    {
      taskId: "t-005",
      projectId: "proj-beta",
      assigneeId: "emp-alice",
      title: "Create dashboard UI",
      status: "active" as const,
      priority: "medium" as const,
      createdAt: "2025-02-20",
      estimateHours: 21,
    },
    {
      taskId: "t-006",
      projectId: "proj-beta",
      assigneeId: "emp-carol",
      title: "User research interviews",
      status: "done" as const,
      priority: "high" as const,
      createdAt: "2025-01-10",
      estimateHours: 5,
    },
    {
      taskId: "t-007",
      projectId: "proj-alpha",
      assigneeId: "emp-alice",
      title: "Performance optimization",
      status: "todo" as const,
      priority: "medium" as const,
      createdAt: "2025-03-15",
      estimateHours: 8,
    },
    {
      taskId: "t-008",
      projectId: "proj-alpha",
      assigneeId: "emp-carol",
      title: "API documentation",
      status: "active" as const,
      priority: "low" as const,
      createdAt: "2025-02-25",
      estimateHours: 1,
    },
  ]

  for (const t of seedTasks) {
    yield* tasks.put(t)
  }
  // #endregion
  yield* Console.log(`Seeded ${seedTasks.length} tasks\n`)

  // -------------------------------------------------------------------------
  // Entity Queries — via collection accessors
  // -------------------------------------------------------------------------
  yield* Console.log("=== Entity Queries ===\n")

  // #region entity-queries
  // Primary key lookup (not a query — returns single item)
  const task = yield* tasks.get({ taskId: "t-001" })

  // Named index queries — via entity index accessors
  const projectTasks = yield* db.entities.TaskEntity.byProject({
    projectId: "proj-alpha",
  }).collect()
  const assigneeTasks = yield* db.entities.TaskEntity.byAssignee({
    assigneeId: "emp-alice",
  }).collect()
  // #endregion
  yield* Console.log(`Got task: "${task.title}" (${task.status})`)
  yield* Console.log(`Project proj-alpha: ${projectTasks.length} tasks`)
  yield* Console.log(`Assignee emp-alice: ${assigneeTasks.length} tasks\n`)

  // -------------------------------------------------------------------------
  // Sort Key Conditions
  // -------------------------------------------------------------------------
  yield* Console.log("=== Sort Key Conditions ===\n")

  // #region sk-conditions
  // byProject SK composites: ["status", "createdAt"].
  // `.where()` constrains the first composite the accessor did not pin.
  const activeTasks = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
    .where((t, { eq }) => eq(t.status, "active"))
    .collect()

  // Pin `status` on the accessor, then range over `createdAt`.
  const activeSinceFeb = yield* db.entities.TaskEntity.byProject({
    projectId: "proj-alpha",
    status: "active",
  })
    .where((t, { gte }) => gte(t.createdAt, "2025-02-10"))
    .collect()

  // `between` is inclusive at both ends.
  const activeInFeb = yield* db.entities.TaskEntity.byProject({
    projectId: "proj-alpha",
    status: "active",
  })
    .where((t, { between }) => between(t.createdAt, "2025-02-01", "2025-02-28"))
    .collect()
  // #endregion
  yield* Console.log(`Active tasks: ${activeTasks.length}`)
  yield* Console.log(`Active since 2025-02-10: ${activeSinceFeb.length}`)
  yield* Console.log(`Active in Feb: ${activeInFeb.length}\n`)

  // #region sk-typed-operands
  // `estimateHours` is a number, so `.where()` takes a number — not a string.
  // The library zero-pads it exactly as the stored key was padded.
  const bigTasks = yield* db.entities.TaskEntity.byEstimate({ projectId: "proj-alpha" })
    .where((t, { gte }) => gte(t.estimateHours, 8))
    .collect()
  // #endregion
  yield* Console.log(`Tasks estimated at 8h or more: ${bigTasks.length}\n`)

  // -------------------------------------------------------------------------
  // Post-Query Filtering
  // -------------------------------------------------------------------------
  yield* Console.log("=== Post-Query Filtering ===\n")

  // #region filter-callback
  // Shorthand — AND-equality on multiple fields
  const highPriActive = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
    .filter({ status: "active", priority: "high" })
    .collect()
  // #endregion
  yield* Console.log(`High-priority active tasks (callback filter): ${highPriActive.length}`)
  for (const t of highPriActive) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.priority}`)
  }

  // #region filter-shorthand
  // Shorthand — simple AND-equality
  const activeShorthand = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
    .filter({ status: "active" })
    .collect()
  // #endregion
  yield* Console.log(`\nActive tasks (shorthand filter): ${activeShorthand.length}\n`)

  // -------------------------------------------------------------------------
  // Pagination — collect, single page, cursor, streaming
  // -------------------------------------------------------------------------
  yield* Console.log("=== Pagination ===\n")

  // #region collect-all
  // Collect all items across all pages
  const allProjectTasks = yield* db.entities.TaskEntity.byProject({
    projectId: "proj-alpha",
  }).collect()
  // #endregion
  yield* Console.log(`Collect all: ${allProjectTasks.length} tasks in proj-alpha`)

  // #region limit-vs-pagesize
  // `limit` bounds the RESULT — at most 3 tasks come back
  const firstThree = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
    .limit(3)
    .collect()

  // `pageSize` bounds each ROUND TRIP — every match comes back, fetched in
  // requests of 2
  const inBatches = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
    .pageSize(2)
    .collect()

  // Both compose — requests of 2, accumulating until 5 items
  const batchedAndCapped = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
    .pageSize(2)
    .limit(5)
    .collect()
  // #endregion
  yield* Console.log(`limit(3): ${firstThree.length} tasks`)
  yield* Console.log(`pageSize(2): ${inBatches.length} tasks`)
  yield* Console.log(`pageSize(2).limit(5): ${batchedAndCapped.length} tasks`)

  // #region single-page
  // Single page with limit — returns page with items and cursor
  const page = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" }).limit(3).fetch()
  // page.items: Task[] (up to 3 items)
  // page.cursor: string | null — resumes after the 3rd item, or null when done
  // #endregion
  yield* Console.log(
    `Single page (limit 3): ${page.items.length} items, cursor: ${page.cursor != null ? "present" : "null"}`,
  )

  // #region cursor-pagination
  // Cursor-based pagination
  const page1 = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
    .limit(3)
    .fetch()

  if (page1.cursor) {
    const page2 = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
      .limit(3)
      .startFrom(page1.cursor)
      .fetch()
    yield* Console.log(
      `Cursor pagination: page1=${page1.items.length} items, page2=${page2.items.length} items`,
    )
  }
  // #endregion

  // #region streaming
  // Streaming — automatic pagination via Stream
  const stream = tasks.scan().paginate()
  const allFromStream = yield* Stream.runCollect(stream)
  yield* Console.log(`Stream collect: ${allFromStream.length} tasks\n`)
  // #endregion

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------
  yield* Console.log("=== Scan ===\n")

  // #region scan-basic
  // Basic scan — all items of this entity type
  const allTasks = yield* tasks.scan().collect()
  // #endregion
  yield* Console.log(`Basic scan: ${allTasks.length} tasks`)

  // #region scan-filter
  // Scan with filter
  const activeScan = yield* tasks.scan().filter({ status: "active" }).collect()
  // #endregion
  yield* Console.log(`Scan with filter (active): ${activeScan.length} tasks`)

  // #region scan-limit
  // Scan with limit — at most 3 items come back
  const firstPage = yield* tasks.scan().limit(3).collect()
  // #endregion
  yield* Console.log(`Scan with limit (3): ${firstPage.length} tasks`)

  // #region scan-page-size
  // Scan in batches — every item comes back, read 3 rows per request
  const batchedScan = yield* tasks.scan().pageSize(3).collect()
  // #endregion
  yield* Console.log(`Scan with pageSize (3): ${batchedScan.length} tasks`)

  // #region scan-consistent
  // Scan with consistent read
  const consistent = yield* tasks.scan().consistentRead().collect()
  // #endregion
  yield* Console.log(`Scan with consistent read: ${consistent.length} tasks`)

  // #region scan-stream
  // Stream-based scan
  const scanStream = tasks.scan().paginate()
  yield* Stream.runForEach(scanStream, (t) => Console.log(`  Scanned: ${t.taskId} — "${t.title}"`))
  // #endregion
  yield* Console.log("")

  // -------------------------------------------------------------------------
  // Consistent Reads
  // -------------------------------------------------------------------------
  yield* Console.log("=== Consistent Reads ===\n")

  // #region consistent-get
  // Consistent read on get — use entity definition's get + pipe
  const consistentTask = yield* TaskEntity.get({ taskId: "t-001" }).pipe(Entity.consistentRead())
  // #endregion
  yield* Console.log(`Consistent get: "${consistentTask.title}"`)

  // #region consistent-scan
  // Consistent read on scan (applies to any BoundQuery against the base table).
  // Note: DynamoDB GSIs do not support consistent reads — only the base table
  // and local secondary indexes do.
  const consistentScan = yield* tasks.scan().consistentRead().collect()
  // #endregion
  yield* Console.log(`Consistent scan: ${consistentScan.length} tasks\n`)

  // -------------------------------------------------------------------------
  // Ordering
  // -------------------------------------------------------------------------
  yield* Console.log("=== Ordering ===\n")

  // #region reverse
  // The 3 most recent tasks (descending sort key order)
  const recent = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
    .reverse()
    .limit(3)
    .collect()
  // #endregion
  yield* Console.log("Most recent 3 tasks in proj-alpha (reversed):")
  for (const t of recent) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.status} (${t.createdAt})`)
  }

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===\n")
  yield* db.tables["guide-queries-table"]!.delete()
  yield* Console.log("Table deleted.")
})
// #endregion

// ---------------------------------------------------------------------------
// 4. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "guide-queries-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
