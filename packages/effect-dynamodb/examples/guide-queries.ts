/**
 * Guide: Queries — effect-dynamodb
 *
 * Demonstrates the pipeable Query API as documented in the Queries guide:
 *   - Entity query accessors (named index queries)
 *   - Sort key conditions: beginsWith, between, eq
 *   - Post-query filtering (callback and shorthand)
 *   - Pagination: collect, single page, cursor-based, streaming
 *   - Scan: basic, filtered, limited, consistent read, stream
 *   - Consistent reads on get, query, and scan
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
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as KeyComposer from "../src/KeyComposer.js"
import * as Query from "../src/Query.js"
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
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
    byProject: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["projectId"] },
      sk: { field: "gsi1sk", composite: ["status", "createdAt"] },
    },
    byAssignee: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["assigneeId"] },
      sk: { field: "gsi2sk", composite: ["status", "createdAt"] },
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
  const db = yield* DynamoClient.make(MainTable)
  const tasks = db.TaskEntity

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")
  yield* db.createTable()
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
    },
    {
      taskId: "t-002",
      projectId: "proj-alpha",
      assigneeId: "emp-alice",
      title: "Implement REST endpoints",
      status: "active" as const,
      priority: "high" as const,
      createdAt: "2025-02-01",
    },
    {
      taskId: "t-003",
      projectId: "proj-alpha",
      assigneeId: "emp-bob",
      title: "Write integration tests",
      status: "active" as const,
      priority: "medium" as const,
      createdAt: "2025-02-10",
    },
    {
      taskId: "t-004",
      projectId: "proj-alpha",
      assigneeId: "emp-bob",
      title: "Set up CI pipeline",
      status: "todo" as const,
      priority: "low" as const,
      createdAt: "2025-03-01",
    },
    {
      taskId: "t-005",
      projectId: "proj-beta",
      assigneeId: "emp-alice",
      title: "Create dashboard UI",
      status: "active" as const,
      priority: "medium" as const,
      createdAt: "2025-02-20",
    },
    {
      taskId: "t-006",
      projectId: "proj-beta",
      assigneeId: "emp-carol",
      title: "User research interviews",
      status: "done" as const,
      priority: "high" as const,
      createdAt: "2025-01-10",
    },
    {
      taskId: "t-007",
      projectId: "proj-alpha",
      assigneeId: "emp-alice",
      title: "Performance optimization",
      status: "todo" as const,
      priority: "medium" as const,
      createdAt: "2025-03-15",
    },
    {
      taskId: "t-008",
      projectId: "proj-alpha",
      assigneeId: "emp-carol",
      title: "API documentation",
      status: "active" as const,
      priority: "low" as const,
      createdAt: "2025-02-25",
    },
  ]

  for (const t of seedTasks) {
    yield* tasks.put(t)
  }
  // #endregion
  yield* Console.log(`Seeded ${seedTasks.length} tasks\n`)

  // -------------------------------------------------------------------------
  // Entity Queries — accessors live on the entity definition
  // -------------------------------------------------------------------------
  yield* Console.log("=== Entity Queries ===\n")

  // #region entity-queries
  // Primary key lookup (not a query — returns single item)
  const task = yield* tasks.get({ taskId: "t-001" })

  // Named index queries (return Query<A>) — on the entity definition
  const projectTasks = yield* tasks.collect(TaskEntity.query.byProject({ projectId: "proj-alpha" }))
  const assigneeTasks = yield* tasks.collect(
    TaskEntity.query.byAssignee({ assigneeId: "emp-alice" }),
  )
  // #endregion
  yield* Console.log(`Got task: "${task.title}" (${task.status})`)
  yield* Console.log(`Project proj-alpha: ${projectTasks.length} tasks`)
  yield* Console.log(`Assignee emp-alice: ${assigneeTasks.length} tasks\n`)

  // -------------------------------------------------------------------------
  // Sort Key Conditions — Query.where
  // -------------------------------------------------------------------------
  yield* Console.log("=== Sort Key Conditions ===\n")

  // #region begins-with
  // beginsWith — match tasks with "active" status prefix in the sort key
  const activePrefix = KeyComposer.composeSortKeyPrefix(
    AppSchema,
    "Task",
    1,
    TaskEntity.indexes.byProject,
    { status: "active" },
  )
  const activeTasks = yield* tasks.collect(
    TaskEntity.query.byProject({ projectId: "proj-alpha" }),
    Query.where({ beginsWith: activePrefix }),
  )
  // #endregion
  yield* Console.log(`Active tasks in proj-alpha (beginsWith): ${activeTasks.length}`)
  for (const t of activeTasks) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.status}`)
  }

  // #region between
  // between — range on the composed sort key
  const startDate = "2025-02-01"
  const endDate = "2025-02-28"
  const lo = KeyComposer.composeSortKeyPrefix(AppSchema, "Task", 1, TaskEntity.indexes.byProject, {
    status: "active",
    createdAt: startDate,
  })
  const hi = KeyComposer.composeSortKeyPrefix(AppSchema, "Task", 1, TaskEntity.indexes.byProject, {
    status: "active",
    createdAt: endDate,
  })
  const activeInRange = yield* tasks.collect(
    TaskEntity.query.byProject({ projectId: "proj-alpha" }),
    Query.where({ between: [lo, hi] }),
  )
  // #endregion
  yield* Console.log(
    `\nActive tasks in proj-alpha (between ${startDate} – ${endDate}): ${activeInRange.length}`,
  )
  for (const t of activeInRange) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — created ${t.createdAt}`)
  }
  yield* Console.log("")

  // -------------------------------------------------------------------------
  // Post-Query Filtering
  // -------------------------------------------------------------------------
  yield* Console.log("=== Post-Query Filtering ===\n")

  // #region filter-callback
  // Callback — type-safe, supports nested paths, OR/NOT, all operators
  const highPriActive = yield* tasks.collect(
    TaskEntity.query.byProject({ projectId: "proj-alpha" }),
    TaskEntity.filter((t, { and, eq }) => and(eq(t.status, "active"), eq(t.priority, "high"))),
  )
  // #endregion
  yield* Console.log(`High-priority active tasks (callback filter): ${highPriActive.length}`)
  for (const t of highPriActive) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.priority}`)
  }

  // #region filter-shorthand
  // Shorthand — simple AND-equality
  const activeShorthand = yield* tasks.collect(
    TaskEntity.query.byProject({ projectId: "proj-alpha" }),
    TaskEntity.filter({ status: "active" }),
  )
  // #endregion
  yield* Console.log(`\nActive tasks (shorthand filter): ${activeShorthand.length}\n`)

  // -------------------------------------------------------------------------
  // Pagination — collect, single page, cursor, streaming
  // -------------------------------------------------------------------------
  yield* Console.log("=== Pagination ===\n")

  // #region collect-all
  // Collect all items across all pages
  const allProjectTasks = yield* tasks.collect(
    TaskEntity.query.byProject({ projectId: "proj-alpha" }),
  )
  // #endregion
  yield* Console.log(`Collect all: ${allProjectTasks.length} tasks in proj-alpha`)

  // #region single-page
  // Single page with limit — returns Page<A> with items and cursor
  const page = yield* TaskEntity.query
    .byProject({ projectId: "proj-alpha" })
    .pipe(Query.limit(3), Query.execute)
  // page.items: Task[] (up to 3 items)
  // page.cursor: string | null (pass to Query.startFrom for next page)
  // #endregion
  yield* Console.log(
    `Single page (limit 3): ${page.items.length} items, cursor: ${page.cursor != null ? "present" : "null"}`,
  )

  // #region cursor-pagination
  // Cursor-based pagination
  const page1 = yield* TaskEntity.query
    .byProject({ projectId: "proj-alpha" })
    .pipe(Query.limit(3), Query.execute)

  if (page1.cursor) {
    const page2 = yield* TaskEntity.query
      .byProject({ projectId: "proj-alpha" })
      .pipe(Query.limit(3), Query.startFrom(page1.cursor), Query.execute)
    yield* Console.log(
      `Cursor pagination: page1=${page1.items.length} items, page2=${page2.items.length} items`,
    )
  }
  // #endregion

  // #region streaming
  // Streaming — automatic pagination via Stream
  const stream = tasks.paginate(TaskEntity.query.byProject({ projectId: "proj-alpha" }))

  const allFromStream = yield* Stream.runCollect(stream)
  yield* Console.log(`Stream collect: ${allFromStream.length} tasks\n`)
  // #endregion

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------
  yield* Console.log("=== Scan ===\n")

  // #region scan-basic
  // Basic scan — all items of this entity type
  const allTasks = yield* tasks.collect(TaskEntity.scan())
  // #endregion
  yield* Console.log(`Basic scan: ${allTasks.length} tasks`)

  // #region scan-filter
  // Scan with filter
  const activeScan = yield* tasks.collect(
    TaskEntity.scan(),
    TaskEntity.filter({ status: "active" }),
  )
  // #endregion
  yield* Console.log(`Scan with filter (active): ${activeScan.length} tasks`)

  // #region scan-limit
  // Scan with limit
  const firstPage = yield* tasks.collect(TaskEntity.scan(), Query.limit(3))
  // #endregion
  yield* Console.log(`Scan with limit (3): ${firstPage.length} tasks`)

  // #region scan-consistent
  // Scan with consistent read
  const consistent = yield* tasks.collect(TaskEntity.scan(), Query.consistentRead)
  // #endregion
  yield* Console.log(`Scan with consistent read: ${consistent.length} tasks`)

  // #region scan-stream
  // Stream-based scan
  const scanStream = tasks.paginate(TaskEntity.scan())
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

  // #region consistent-query
  // Consistent read on query
  const consistentQuery = yield* tasks.collect(
    TaskEntity.query.byProject({ projectId: "proj-alpha" }),
    Query.consistentRead,
  )
  // #endregion
  yield* Console.log(`Consistent query: ${consistentQuery.length} tasks`)

  // #region consistent-scan
  // Consistent read on scan
  const consistentScan = yield* tasks.collect(TaskEntity.scan(), Query.consistentRead)
  // #endregion
  yield* Console.log(`Consistent scan: ${consistentScan.length} tasks\n`)

  // -------------------------------------------------------------------------
  // Ordering
  // -------------------------------------------------------------------------
  yield* Console.log("=== Ordering ===\n")

  // #region reverse
  // Most recent tasks first (descending sort key order)
  const recent = yield* tasks.collect(
    TaskEntity.query.byProject({ projectId: "proj-alpha" }),
    Query.reverse,
    Query.limit(3),
  )
  // #endregion
  yield* Console.log("Most recent 3 tasks in proj-alpha (reversed):")
  for (const t of recent) {
    yield* Console.log(`  ${t.taskId}: "${t.title}" — ${t.status} (${t.createdAt})`)
  }

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===\n")
  yield* db.deleteTable()
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
