/**
 * Modeling Guide example — effect-dynamodb
 *
 * Demonstrates the foundational modeling constructs covered in the Modeling guide:
 *   - Pure domain models with Schema.Class and branded types
 *   - DynamoModel.configure for field-level DynamoDB overrides
 *   - DynamoSchema for application namespace and key prefixing
 *   - Table.make for physical table declaration
 *   - Entity.make with composite key indexes, system fields, and unique constraints
 *   - Derived types: Model, Record, Input, Update, Key
 *   - Schema accessors for DynamoDB Streams consumption
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-modeling.ts
 */

import { Console, Duration, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Define pure domain models — no DynamoDB concepts
// ---------------------------------------------------------------------------

// #region model
class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String.pipe(Schema.brand("EmployeeId")),
  tenantId: Schema.String.pipe(Schema.brand("TenantId")),
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  department: Schema.String,
  hireDate: Schema.DateTimeUtcFromString,
  createdBy: Schema.String,
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. DynamoModel.configure — DynamoDB-specific overrides
// ---------------------------------------------------------------------------

// #region configure
const EmployeeModel = DynamoModel.configure(Employee, {
  createdBy: { immutable: true },
  hireDate: { field: "hd", storedAs: DynamoModel.DateEpochSeconds },
  displayName: { field: "dn" },
  employeeId: { identifier: true },
})
// #endregion

// ---------------------------------------------------------------------------
// 3. Application namespace
// ---------------------------------------------------------------------------

// #region schema
const AppSchema = DynamoSchema.make({
  name: "projmgmt",
  version: 1,
  casing: "lowercase",
})
// #endregion

// ---------------------------------------------------------------------------
// 4. Entity definition — composite indexes, system fields, unique constraints
// ---------------------------------------------------------------------------

// #region entity
const Employees = Entity.make({
  model: EmployeeModel,
  entityType: "Employee",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["employeeId"] },
      sk: { field: "sk", composite: [] },
    },
    byTenant: {
      index: "gsi1",
      collection: "TenantMembers",
      type: "clustered",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["department", "hireDate"] },
    },
    byEmail: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["email"] },
      sk: { field: "gsi2sk", composite: [] },
    },
  },
  unique: { email: ["email"] },
  timestamps: true,
  versioned: { retain: true, ttl: Duration.days(90) },
  softDelete: { ttl: Duration.days(30) },
})
// #endregion

// ---------------------------------------------------------------------------
// 5. Table — declares the physical table and its entities
// ---------------------------------------------------------------------------

// #region table
const MainTable = Table.make({ schema: AppSchema, entities: { Employees } })
// #endregion

// ---------------------------------------------------------------------------
// 6. Main program — demonstrates CRUD + derived types
// ---------------------------------------------------------------------------

// #region program
const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make(MainTable)

  // --- Setup ---
  yield* db.createTable()
  yield* Console.log("Table created\n")

  // --- Put: create an employee ---
  const alice = yield* db.Employees.put({
    employeeId: "emp-alice" as any,
    tenantId: "tenant-acme" as any,
    email: "alice@acme.com",
    displayName: "Alice Chen",
    department: "Engineering",
    hireDate: "2024-01-15T00:00:00.000Z" as any,
    createdBy: "system",
  })
  yield* Console.log(`Created: ${alice.displayName} (${alice.email})`)

  // --- Get: read by primary key ---
  const employee = yield* db.Employees.get({ employeeId: "emp-alice" as any })
  yield* Console.log(`Got: ${employee.displayName}, dept=${employee.department}`)

  // --- Update: only updateable fields ---
  // (createdBy excluded — immutable; employeeId excluded — primary key)
  const updated = yield* db.Employees.update(
    { employeeId: "emp-alice" as any },
    Entity.set({
      displayName: "Alice C.",
      department: "Platform",
      // Must provide all GSI composites for byTenant:
      tenantId: "tenant-acme" as any,
      hireDate: "2024-01-15T00:00:00.000Z" as any,
    }),
  )
  yield* Console.log(`Updated: ${updated.displayName}, dept=${updated.department}`)

  // --- Query: employees by tenant via GSI ---
  const acmeEmployees = yield* db.Employees.collect(
    Employees.query.byTenant({ tenantId: "tenant-acme" as any }),
  )
  yield* Console.log(`Acme employees: ${acmeEmployees.length}`)

  // --- Cleanup ---
  yield* db.Employees.delete({ employeeId: "emp-alice" as any })
  yield* db.deleteTable()
  yield* Console.log("\nDone — table deleted.")
})
// #endregion

// ---------------------------------------------------------------------------
// 7. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "modeling-guide-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nComplete."),
  (err) => console.error("Failed:", err),
)
// #endregion
