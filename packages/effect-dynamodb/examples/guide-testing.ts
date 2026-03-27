/**
 * Testing guide example — effect-dynamodb
 *
 * Demonstrates testing patterns from the Testing guide:
 *   - Setting up a mock DynamoClient via Layer.succeed
 *   - Verifying put operations against the mock
 *   - Asserting on error paths (UniqueConstraintViolation)
 *   - Testing query results with mock data
 *
 * This example shows the testing patterns as a standalone script.
 * In a real project, use @effect/vitest with it.effect for the same patterns.
 *
 * Run:
 *   npx tsx examples/guide-testing.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { DynamoError } from "../src/Errors.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

// #region models
class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  department: Schema.String,
  createdBy: Schema.String,
}) {}

const EmployeeModel = DynamoModel.configure(Employee, {
  createdBy: { immutable: true },
})

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  projectId: Schema.String,
  title: Schema.NonEmptyString,
  status: Schema.Literals(["active", "completed", "archived"]),
  assignee: Schema.String,
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Schema + Table + Entities
// ---------------------------------------------------------------------------

// #region entities
const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

const EmployeeEntity = Entity.make({
  model: EmployeeModel,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employeeId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byEmail: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["email"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
  unique: { email: ["email"] },
  timestamps: true,
  versioned: true,
})

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
      sk: { field: "gsi1sk", composite: ["status"] },
      type: "clustered",
    },
  },
  timestamps: true,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { EmployeeEntity, TaskEntity },
})

// #endregion

// ---------------------------------------------------------------------------
// 3. Mock DynamoDB Client
// ---------------------------------------------------------------------------

// #region mock-client
// Track calls for assertions
let putItemCalls: Array<unknown> = []
let getItemCalls: Array<unknown> = []
let queryCalls: Array<unknown> = []
let transactWriteItemsCalls: Array<unknown> = []

// Configurable mock responses
let putItemResponse: Effect.Effect<unknown, DynamoError> = Effect.succeed({})
let getItemResponse: Effect.Effect<unknown, DynamoError> = Effect.succeed({})
let queryResponse: Effect.Effect<unknown, DynamoError> = Effect.succeed({})
let transactWriteItemsResponse: Effect.Effect<unknown, DynamoError> = Effect.succeed({})

const resetMocks = () => {
  putItemCalls = []
  getItemCalls = []
  queryCalls = []
  transactWriteItemsCalls = []
  putItemResponse = Effect.succeed({})
  getItemResponse = Effect.succeed({})
  queryResponse = Effect.succeed({})
  transactWriteItemsResponse = Effect.succeed({})
}

const MockDynamoClient = Layer.succeed(DynamoClient, {
  putItem: (input) => {
    putItemCalls.push(input)
    return putItemResponse as any
  },
  getItem: (input) => {
    getItemCalls.push(input)
    return getItemResponse as any
  },
  query: (input) => {
    queryCalls.push(input)
    return queryResponse as any
  },
  updateItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  transactWriteItems: (input) => {
    transactWriteItemsCalls.push(input)
    return transactWriteItemsResponse as any
  },
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
  updateTable: () => Effect.die("not used"),
  listTables: () => Effect.die("not used"),
  createBackup: () => Effect.die("not used"),
  deleteBackup: () => Effect.die("not used"),
  listBackups: () => Effect.die("not used"),
  restoreTableFromBackup: () => Effect.die("not used"),
  describeContinuousBackups: () => Effect.die("not used"),
  updateContinuousBackups: () => Effect.die("not used"),
  restoreTableToPointInTime: () => Effect.die("not used"),
  exportTableToPointInTime: () => Effect.die("not used"),
  describeExport: () => Effect.die("not used"),
  updateTimeToLive: () => Effect.die("not used"),
  describeTimeToLive: () => Effect.die("not used"),
  tagResource: () => Effect.die("not used"),
  untagResource: () => Effect.die("not used"),
  listTagsOfResource: () => Effect.die("not used"),
})

const TestLayer = Layer.merge(MockDynamoClient, MainTable.layer({ name: "test-table" }))
// #endregion

// ---------------------------------------------------------------------------
// 4. Test: Verify a Put Operation
// ---------------------------------------------------------------------------

// #region test-put
const testPutOperation = Effect.gen(function* () {
  resetMocks()

  // EmployeeEntity has unique constraints, so it uses transactWriteItems
  transactWriteItemsResponse = Effect.succeed({})

  const db = yield* DynamoClient.make({
    entities: { EmployeeEntity, TaskEntity },
  })

  const result = yield* db.entities.EmployeeEntity.put({
    employeeId: "emp-1",
    email: "alice@acme.com",
    displayName: "Alice",
    department: "Engineering",
    createdBy: "admin",
  })

  // Verify the result
  console.assert(result.employeeId === "emp-1", "employeeId should be emp-1")
  console.assert(result.displayName === "Alice", "displayName should be Alice")
  console.assert(transactWriteItemsCalls.length === 1, "transactWriteItems should be called once")

  yield* Console.log("  Put operation: PASSED")
}).pipe(Effect.provide(TestLayer))
// #endregion

// ---------------------------------------------------------------------------
// 5. Test: Assert on Error Paths
// ---------------------------------------------------------------------------

// #region test-error
const testErrorPath = Effect.gen(function* () {
  resetMocks()

  // Simulate a TransactionCanceledException (unique constraint violation).
  // Index 0 = main item (succeeds), index 1 = sentinel (fails with ConditionalCheckFailed).
  transactWriteItemsResponse = Effect.fail(
    new DynamoError({
      operation: "TransactWriteItems",
      cause: {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
      },
    }),
  )

  const db = yield* DynamoClient.make({
    entities: { EmployeeEntity, TaskEntity },
  })

  const result = yield* db.entities.EmployeeEntity.put({
    employeeId: "emp-2",
    email: "taken@example.com",
    displayName: "Bob",
    department: "Sales",
    createdBy: "admin",
  }).pipe(Effect.flip)

  // The entity layer translates the DynamoDB error to a domain error
  console.assert(
    result._tag === "UniqueConstraintViolation",
    `expected UniqueConstraintViolation, got ${result._tag}`,
  )

  yield* Console.log("  Error path (UniqueConstraintViolation): PASSED")
}).pipe(Effect.provide(TestLayer))
// #endregion

// ---------------------------------------------------------------------------
// 6. Test: Query Results
// ---------------------------------------------------------------------------

// #region test-query
const testQueryResults = Effect.gen(function* () {
  resetMocks()

  // Return mock query results from the client
  queryResponse = Effect.succeed({
    Items: [
      toAttributeMap({
        pk: "$myapp#v1#task#t-1",
        sk: "$myapp#v1#task",
        gsi1pk: "$myapp#v1#task#proj-alpha",
        gsi1sk: "$myapp#v1#tasksByProject#task#active",
        __edd_e__: "Task",
        taskId: "t-1",
        projectId: "proj-alpha",
        title: "Implement feature",
        status: "active",
        assignee: "alice",
        createdAt: "2024-01-15T10:30:00.000Z",
        updatedAt: "2024-01-15T10:30:00.000Z",
      }),
      toAttributeMap({
        pk: "$myapp#v1#task#t-2",
        sk: "$myapp#v1#task",
        gsi1pk: "$myapp#v1#task#proj-alpha",
        gsi1sk: "$myapp#v1#tasksByProject#task#active",
        __edd_e__: "Task",
        taskId: "t-2",
        projectId: "proj-alpha",
        title: "Write tests",
        status: "active",
        assignee: "bob",
        createdAt: "2024-01-16T09:00:00.000Z",
        updatedAt: "2024-01-16T09:00:00.000Z",
      }),
    ],
    LastEvaluatedKey: undefined,
  })

  const db = yield* DynamoClient.make({
    entities: { EmployeeEntity, TaskEntity },
  })

  const results = yield* db.entities.TaskEntity.byProject({ projectId: "proj-alpha" })
    .filter({ status: "active" })
    .collect()

  // Verify decoded results
  console.assert(results.length === 2, `expected 2 results, got ${results.length}`)
  console.assert(results[0]!.taskId === "t-1", "first task should be t-1")
  console.assert(results[1]!.taskId === "t-2", "second task should be t-2")
  console.assert(results[0]!.title === "Implement feature", "first task title should match")
  console.assert(queryCalls.length === 1, "query should be called once")

  yield* Console.log("  Query results: PASSED")
}).pipe(Effect.provide(TestLayer))
// #endregion

// ---------------------------------------------------------------------------
// 7. Run all tests
// ---------------------------------------------------------------------------

// #region run
const program = Effect.gen(function* () {
  yield* Console.log("=== Testing Guide Examples ===\n")

  yield* testPutOperation
  yield* testErrorPath
  yield* testQueryResults

  yield* Console.log("\nAll tests passed.")
})

Effect.runPromise(program).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
// #endregion
