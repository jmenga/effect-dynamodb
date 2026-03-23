/**
 * Lifecycle Guide Example — effect-dynamodb v2
 *
 * Demonstrates entity lifecycle management:
 *   - Soft delete: logical deletion with GSI key removal
 *   - Accessing deleted items (deleted.get, deleted.list)
 *   - Restore: bring soft-deleted items back to active status
 *   - Purge: permanent removal of item + version history + sentinels
 *   - Version retention: snapshot history on every mutation
 *   - Querying version history (getVersion, versions)
 *   - TTL on soft-deleted items and version snapshots
 *   - Soft delete + versioning combined for full audit trail
 *   - Unique constraint policy (preserveUnique)
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-lifecycle.ts
 */

import { Console, Duration, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as Collections from "../src/Collections.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// =============================================================================
// 1. Pure domain models — no DynamoDB concepts
// =============================================================================

// #region model
class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String,
  tenantId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  department: Schema.String,
}) {}

const EmployeeModel = DynamoModel.configure(Employee, {
  tenantId: { immutable: true },
})
// #endregion

// =============================================================================
// 2. Application namespace
// =============================================================================

// #region schema
const AppSchema = DynamoSchema.make({ name: "lifecycle", version: 1 })
// #endregion

// =============================================================================
// 3. Entity definitions — soft delete + version retention
// =============================================================================

// #region entity-soft-delete
const Employees = Entity.make({
  model: EmployeeModel,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employeeId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  versioned: { retain: true, ttl: Duration.days(90) },
  softDelete: { ttl: Duration.days(30) },
})
// #endregion

// #region entity-reserve-policy
const EmployeesReserve = Entity.make({
  model: EmployeeModel,
  entityType: "EmployeeReserve",
  primaryKey: {
    pk: { field: "pk", composite: ["employeeId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  versioned: { retain: true },
  softDelete: { ttl: Duration.days(30), preserveUnique: true },
  unique: { email: ["email"] },
})
// #endregion

// =============================================================================
// 4. Table + Collections
// =============================================================================

// #region table
const MainTable = Table.make({
  schema: AppSchema,
  entities: { Employees, EmployeesReserve },
})

const EmployeesByTenant = Collections.make("employeesByTenant", {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["tenantId"] },
  sk: { field: "gsi1sk" },
  members: {
    Employees: Collections.member(Employees, { sk: { composite: ["department", "employeeId"] } }),
  },
})
// #endregion

// =============================================================================
// 5. Helpers
// =============================================================================

/** Runtime version accessor — version is a system field not reflected in ModelType */
const v = (item: unknown): number => (item as { version: number }).version

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

// =============================================================================
// 6. Main program
// =============================================================================

// #region program
const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Employees, EmployeesReserve },
    collections: { EmployeesByTenant },
  })

  yield* db.tables["lifecycle-table"]!.create()
  yield* Console.log("=== Setup Complete ===\n")

  // -------------------------------------------------------------------------
  // Soft Delete + Version Retention
  // -------------------------------------------------------------------------

  // #region create
  // Create employee (version 1)
  const alice = yield* db.entities.Employees.put({
    employeeId: "emp-alice",
    tenantId: "t-acme",
    email: "alice@acme.com",
    displayName: "Alice",
    department: "Engineering",
  })
  yield* Console.log(`Created: ${alice.displayName} (v${v(alice)})`)
  // #endregion
  assertEq(v(alice), 1, "alice version 1")

  // #region update
  // Update employee (version 2)
  const updated = yield* db.entities.Employees.update(
    { employeeId: "emp-alice" },
    Entity.set({
      displayName: "Alice Baker",
      department: "Engineering",
      tenantId: "t-acme",
    }),
  )
  yield* Console.log(`Updated: ${updated.displayName} (v${v(updated)})`)
  // #endregion
  assertEq(v(updated), 2, "alice version 2")
  assertEq(updated.displayName, "Alice Baker", "display name updated")

  // #region soft-delete
  // Soft delete (version 3) — item disappears from GSI queries
  yield* db.entities.Employees.delete({ employeeId: "emp-alice" })
  yield* Console.log("Soft-deleted alice")
  // #endregion

  // #region invisible
  // Normal get returns ItemNotFound
  const getResult = yield* db.entities.Employees.get({ employeeId: "emp-alice" }).pipe(
    Effect.map(() => "found" as const),
    Effect.catchTag("ItemNotFound", () => Effect.succeed("not-found" as const)),
  )
  yield* Console.log(`Normal get after delete: ${getResult}`)
  // #endregion
  assertEq(getResult, "not-found", "alice not found via normal get")

  // #region query-invisible
  // Collection query also returns empty — deleted items fall out of indexes
  const { Employees: tenantEmployees } = yield* db.collections
    .EmployeesByTenant({ tenantId: "t-acme" })
    .collect()
  yield* Console.log(`Tenant query after delete: ${tenantEmployees.length} results`)
  // #endregion
  assertEq(tenantEmployees.length, 0, "tenant query empty after delete")

  // #region deleted-get
  // Access the soft-deleted item directly
  const deleted = yield* db.entities.Employees.deleted.get({ employeeId: "emp-alice" })
  yield* Console.log(`Deleted item: ${deleted.displayName} (deletedAt present)`)
  // #endregion
  assertEq(deleted.displayName, "Alice Baker", "deleted record preserved")

  // #region deleted-list
  // List all deleted items in the partition
  const allDeleted = yield* db.entities.Employees.collect(
    Employees.deleted.list({ employeeId: "emp-alice" }),
    Query.limit(20),
  )
  yield* Console.log(`Deleted items in partition: ${allDeleted.length}`)
  // #endregion
  assertEq(allDeleted.length, 1, "1 deleted item in partition")

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  // #region restore
  // Restore the soft-deleted item (version 4) — recomposes all index keys
  const restored = yield* db.entities.Employees.restore({ employeeId: "emp-alice" })
  yield* Console.log(`Restored: ${restored.displayName} (v${v(restored)})`)
  // #endregion
  assertEq(v(restored), 4, "restored version 4")
  assertEq(restored.displayName, "Alice Baker", "restored display name")

  // #region restore-visible
  // Item is back in collection queries
  const { Employees: tenantAfterRestore } = yield* db.collections
    .EmployeesByTenant({ tenantId: "t-acme" })
    .collect()
  yield* Console.log(`Tenant query after restore: ${tenantAfterRestore.length} results`)
  // #endregion
  assertEq(tenantAfterRestore.length, 1, "alice back in tenant query")

  // -------------------------------------------------------------------------
  // Version History
  // -------------------------------------------------------------------------

  // #region version-history
  // Browse version history (most recent first)
  const history = yield* db.entities.Employees.collect(
    Employees.versions({ employeeId: "emp-alice" }),
    Query.reverse,
  )
  yield* Console.log(`\nVersion history (${history.length} snapshots):`)
  for (const snapshot of history) {
    yield* Console.log(`  v${v(snapshot)}: ${snapshot.displayName}`)
  }
  // #endregion
  assert(history.length >= 1, "at least 1 version snapshot")

  // #region get-version
  // Get a specific version snapshot
  const v1 = yield* db.entities.Employees.getVersion({ employeeId: "emp-alice" }, 1)
  yield* Console.log(`\nVersion 1: ${v1.displayName} (v${v(v1)})`)
  // #endregion
  assertEq(v1.displayName, "Alice", "v1 has original display name")
  assertEq(v(v1), 1, "v1 version number")

  // -------------------------------------------------------------------------
  // Purge — permanent removal
  // -------------------------------------------------------------------------

  // Create a second employee for purge demo
  yield* db.entities.Employees.put({
    employeeId: "emp-bob",
    tenantId: "t-acme",
    email: "bob@acme.com",
    displayName: "Bob",
    department: "Sales",
  })

  yield* db.entities.Employees.update(
    { employeeId: "emp-bob" },
    Entity.set({
      displayName: "Bob Smith",
      department: "Sales",
      tenantId: "t-acme",
    }),
  )

  yield* db.entities.Employees.delete({ employeeId: "emp-bob" })

  // #region purge
  // Purge permanently removes the item, all version history, and sentinels
  yield* db.entities.Employees.purge({ employeeId: "emp-bob" })
  yield* Console.log("\nPurged bob — item + version history permanently removed")
  // #endregion

  // Verify purge: deleted.get should fail
  const purgeCheck = yield* db.entities.Employees.deleted.get({ employeeId: "emp-bob" }).pipe(
    Effect.map(() => "found" as const),
    Effect.catchTag("ItemNotFound", () => Effect.succeed("not-found" as const)),
  )
  assertEq(purgeCheck, "not-found", "bob purged completely")
  yield* Console.log(`Deleted get after purge: ${purgeCheck}`)

  // -------------------------------------------------------------------------
  // Restore Error Handling
  // -------------------------------------------------------------------------

  // #region restore-error
  // Attempting to restore a non-existent deleted item
  const restoreResult = yield* db.entities.Employees.restore({ employeeId: "emp-nobody" }).pipe(
    Effect.map(() => "restored" as const),
    Effect.catchTag("ItemNotFound", () => Effect.succeed("not-in-recycle-bin" as const)),
  )
  yield* Console.log(`\nRestore non-existent: ${restoreResult}`)
  // #endregion
  assertEq(restoreResult, "not-in-recycle-bin", "restore fails for missing item")

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  yield* db.tables["lifecycle-table"]!.delete()
  yield* Console.log("\nAll lifecycle patterns passed.")
})
// #endregion

// =============================================================================
// 7. Provide dependencies and run
// =============================================================================

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "lifecycle-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
