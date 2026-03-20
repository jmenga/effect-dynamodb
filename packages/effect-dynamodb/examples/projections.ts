/**
 * Projections example — effect-dynamodb v3 (client gateway pattern)
 *
 * Demonstrates:
 *   - Projection.projection(): build a ProjectionExpression from attribute names
 *   - Selective attribute retrieval to reduce read capacity and network transfer
 *   - Projections use ExpressionAttributeNames to handle reserved words safely
 *   - Manual projection application via DynamoClient.getItem / query
 *
 * Note: Projections bypass Entity schema decode — the result is a partial record,
 * not a fully-typed model instance. Use projections when you need raw efficiency
 * (e.g., dashboard queries that only need a few fields).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/projections.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Projection from "../src/Projection.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String,
  name: Schema.NonEmptyString,
  email: Schema.String,
  department: Schema.String,
  salary: Schema.Number,
  title: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// 2. Schema + Entity + Table
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "proj-demo", version: 1 })

const Employees = Entity.make({
  model: Employee,
  entityType: "Employee",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["employeeId"] },
      sk: { field: "sk", composite: [] },
    },
    byDepartment: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["department"] },
      sk: { field: "gsi1sk", composite: ["employeeId"] },
    },
  },
  timestamps: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Employees } })

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // Typed execution gateway — binds all table members
  const db = yield* DynamoClient.make(MainTable)

  // Raw DynamoClient + TableConfig needed for low-level projection operations
  const client = yield* DynamoClient
  const tableConfig = yield* MainTable.Tag

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")

  yield* db.createTable()
  yield* Console.log("Table created\n")

  // Seed data
  yield* db.Employees.put({
    employeeId: "e-1",
    name: "Alice",
    email: "alice@company.com",
    department: "engineering",
    salary: 120000,
    title: "Senior Engineer",
  })
  yield* db.Employees.put({
    employeeId: "e-2",
    name: "Bob",
    email: "bob@company.com",
    department: "engineering",
    salary: 95000,
    title: "Engineer",
  })
  yield* db.Employees.put({
    employeeId: "e-3",
    name: "Charlie",
    email: "charlie@company.com",
    department: "marketing",
    salary: 85000,
    title: "Marketing Lead",
  })
  yield* Console.log("Seeded 3 employees\n")

  // --- Build a projection ---
  yield* Console.log("=== Projection.projection() ===\n")

  // Build a projection to fetch only name and department
  const nameAndDept = Projection.projection(["name", "department"])
  yield* Console.log(`Expression: ${nameAndDept.expression}`)
  yield* Console.log(`Names: ${JSON.stringify(nameAndDept.names)}`)
  yield* Console.log("")

  // --- Apply projection to a GetItem ---
  yield* Console.log("=== Projected GetItem ===\n")

  // Use DynamoClient directly to apply projection.
  // ProjectionExpression tells DynamoDB to return only specified attributes,
  // reducing read capacity and network transfer.
  const projResult = yield* client.getItem({
    TableName: tableConfig.name,
    Key: toAttributeMap({
      pk: "$proj-demo#v1#employee#e-1",
      sk: "$proj-demo#v1#employee",
    }),
    ProjectionExpression: nameAndDept.expression,
    ExpressionAttributeNames: nameAndDept.names,
  })

  if (projResult.Item) {
    const item = fromAttributeMap(projResult.Item)
    yield* Console.log(`Projected result: ${JSON.stringify(item)}`)
    yield* Console.log("  → Only requested fields returned (name, department)")
    yield* Console.log("  → salary, email, title, keys all excluded\n")
  }

  // --- Projection with more fields ---
  yield* Console.log("=== Broader Projection ===\n")

  const contactInfo = Projection.projection(["name", "email", "title"])
  yield* Console.log(`Expression: ${contactInfo.expression}`)

  const contactResult = yield* client.getItem({
    TableName: tableConfig.name,
    Key: toAttributeMap({
      pk: "$proj-demo#v1#employee#e-2",
      sk: "$proj-demo#v1#employee",
    }),
    ProjectionExpression: contactInfo.expression,
    ExpressionAttributeNames: contactInfo.names,
  })

  if (contactResult.Item) {
    const item = fromAttributeMap(contactResult.Item)
    yield* Console.log(`Contact info: ${JSON.stringify(item)}`)
  }
  yield* Console.log("")

  // --- Projection with query ---
  yield* Console.log("=== Projected Query ===\n")

  const listProjection = Projection.projection(["name", "title"])
  yield* Console.log(`Fetching engineering team (name + title only)...`)

  const queryResult = yield* client.query({
    TableName: tableConfig.name,
    IndexName: "gsi1",
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: {
      "#pk": "gsi1pk",
      ...listProjection.names,
    },
    ExpressionAttributeValues: toAttributeMap({
      ":pk": "$proj-demo#v1#employee#engineering",
    }),
    ProjectionExpression: listProjection.expression,
  })

  for (const rawItem of queryResult.Items ?? []) {
    const item = fromAttributeMap(rawItem)
    yield* Console.log(`  ${item.name}: ${item.title}`)
  }
  yield* Console.log("")

  // --- Empty projection ---
  yield* Console.log("=== Edge Case: Empty Projection ===\n")

  const empty = Projection.projection([])
  yield* Console.log(`Empty projection expression: "${empty.expression}"`)
  yield* Console.log(`Empty projection names: ${JSON.stringify(empty.names)}\n`)

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* db.deleteTable
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
  MainTable.layer({ name: "proj-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
