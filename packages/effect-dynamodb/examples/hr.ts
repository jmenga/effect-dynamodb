/**
 * Human Resources Example — Complex Single-Table Design
 *
 * Adapted from the ElectroDB Human Resources example:
 * https://electrodb.dev/en/examples/human-resources/
 *
 * Demonstrates advanced effect-dynamodb patterns:
 * - 3 entities (Employee, Task, Office) in one table — Employee with soft delete
 * - 5 GSIs with index overloading
 * - Cross-entity collection patterns via shared GSI indexes
 * - 10 access patterns including sort key range queries
 * - Entity-scoped set() with all-or-none GSI constraints
 * - Atomic onboarding via Transaction.transactWrite
 * - Employee termination via soft delete + rehire via restore
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/hr.ts
 */

import { Console, Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as KeyComposer from "../src/KeyComposer.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// =============================================================================
// 1. Pure domain models — no DynamoDB concepts
// =============================================================================

class Employee extends Schema.Class<Employee>("Employee")({
  employee: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  office: Schema.String,
  title: Schema.String,
  team: Schema.Literals(["jupiter", "mercury", "saturn", "venus", "mars", "neptune"]),
  salary: Schema.String, // Zero-padded "000150.00" for lexicographic SK ordering
  manager: Schema.String,
  dateHired: Schema.String,
  birthday: Schema.String,
}) {}

class Task extends Schema.Class<Task>("Task")({
  task: Schema.String,
  project: Schema.String,
  employee: Schema.String,
  description: Schema.String,
}) {}

class Office extends Schema.Class<Office>("Office")({
  office: Schema.String,
  country: Schema.String,
  state: Schema.String,
  city: Schema.String,
  zip: Schema.String,
  address: Schema.String,
}) {}

// =============================================================================
// 2. Schema + Table
// =============================================================================

const HrSchema = DynamoSchema.make({ name: "hr", version: 1 })
const HrTable = Table.make({ schema: HrSchema })

// =============================================================================
// 3. Entity definitions — 3 entities, 5 GSIs, 2 collections
// =============================================================================

/**
 * Employee — 5 indexes (primary + 4 GSIs)
 *
 * Adaptation from ElectroDB:
 * - Removed `teams` (gsi2) to stay within the 5-GSI plan budget
 * - `roles` (gsi4) and `directReports` (gsi5) are non-collection indexes
 */
const Employees = Entity.make({
  model: Employee,
  table: HrTable,
  entityType: "Employee",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["employee"] },
      sk: { field: "sk", composite: [] },
    },
    coworkers: {
      index: "gsi1",
      collection: "workplaces",
      pk: { field: "gsi1pk", composite: ["office"] },
      sk: { field: "gsi1sk", composite: ["team", "title", "employee"] },
    },
    employeeLookup: {
      index: "gsi3",
      collection: "assignments",
      pk: { field: "gsi3pk", composite: ["employee"] },
      sk: { field: "gsi3sk", composite: [] },
    },
    roles: {
      index: "gsi4",
      pk: { field: "gsi4pk", composite: ["title"] },
      sk: { field: "gsi4sk", composite: ["salary", "employee"] },
    },
    directReports: {
      index: "gsi5",
      pk: { field: "gsi5pk", composite: ["manager"] },
      sk: { field: "gsi5sk", composite: ["team", "office", "employee"] },
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: true,
})

/**
 * Task — 3 indexes (primary + 2 GSIs)
 *
 * gsi1 is used standalone (project), not part of a collection.
 * gsi3 is shared with Employee via the "assignments" collection.
 */
const Tasks = Entity.make({
  model: Task,
  table: HrTable,
  entityType: "Task",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["task"] },
      sk: { field: "sk", composite: ["project", "employee"] },
    },
    project: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["project"] },
      sk: { field: "gsi1sk", composite: ["employee", "task"] },
    },
    assigned: {
      index: "gsi3",
      collection: "assignments",
      pk: { field: "gsi3pk", composite: ["employee"] },
      sk: { field: "gsi3sk", composite: ["project", "task"] },
    },
  },
  timestamps: true,
})

/**
 * Office — 3 indexes (primary + 2 GSIs)
 *
 * Adaptation from ElectroDB:
 * - Primary key changed from pk=[country, state] to pk=[office] (identity key).
 *   This is necessary because Entity.query does not expose the primary index,
 *   and single-table design typically uses identity-based primary keys.
 * - Location query moved to gsi2 (byLocation) instead of primary.
 * - gsi1 is shared with Employee via the "workplaces" collection.
 */
const Offices = Entity.make({
  model: Office,
  table: HrTable,
  entityType: "Office",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["office"] },
      sk: { field: "sk", composite: [] },
    },
    workplace: {
      index: "gsi1",
      collection: "workplaces",
      pk: { field: "gsi1pk", composite: ["office"] },
      sk: { field: "gsi1sk", composite: [] },
    },
    byLocation: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["country", "state"] },
      sk: { field: "gsi2sk", composite: ["city", "zip", "office"] },
    },
  },
  timestamps: true,
})

// =============================================================================
// 4. Collections — cross-entity queries on shared GSIs
//
// Collection.make groups entities sharing a GSI index for cross-entity queries.
// The individual access patterns below use each entity's own typed query methods
// (which hit the same GSIs), demonstrating both approaches:
//
//   workplaces (gsi1): Employees.query.coworkers + Offices.query.workplace
//   assignments (gsi3): Employees.query.employeeLookup + Tasks.query.assigned
//
// =============================================================================

// =============================================================================
// 5. Seed data
// =============================================================================

const offices = {
  gwZoo: {
    office: "gw-zoo",
    country: "US",
    state: "OK",
    city: "Wynnewood",
    zip: "73098",
    address: "25803 N County Road 3250",
  },
  bigCatRescue: {
    office: "big-cat-rescue",
    country: "US",
    state: "FL",
    city: "Tampa",
    zip: "33625",
    address: "12802 Easy St",
  },
} as const

const employees = {
  jlowe: {
    employee: "jlowe",
    firstName: "Joe",
    lastName: "Lowe",
    office: "gw-zoo",
    title: "Zookeeper",
    team: "jupiter" as const,
    salary: "000045.00",
    manager: "jlowe", // self-managed
    dateHired: "2020-01-01",
    birthday: "1970-06-15",
  },
  cbaskin: {
    employee: "cbaskin",
    firstName: "Carole",
    lastName: "Baskin",
    office: "big-cat-rescue",
    title: "Director",
    team: "saturn" as const,
    salary: "000150.00",
    manager: "cbaskin", // self-managed
    dateHired: "1992-06-01",
    birthday: "1961-06-06",
  },
  dfinlay: {
    employee: "dfinlay",
    firstName: "Don",
    lastName: "Finlay",
    office: "gw-zoo",
    title: "Handler",
    team: "jupiter" as const,
    salary: "000035.00",
    manager: "jlowe",
    dateHired: "2021-03-15",
    birthday: "1985-11-20",
  },
  hschreibvogel: {
    employee: "hschreibvogel",
    firstName: "Howard",
    lastName: "Schreibvogel",
    office: "big-cat-rescue",
    title: "Volunteer",
    team: "saturn" as const,
    salary: "000000.00",
    manager: "cbaskin",
    dateHired: "2019-08-01",
    birthday: "1955-03-22",
  },
}

const tasks = {
  feedCats: {
    task: "feed-cats",
    project: "feeding",
    employee: "dfinlay",
    description: "Feed the big cats their daily meals",
  },
  feedCubs: {
    task: "feed-cubs",
    project: "feeding",
    employee: "hschreibvogel",
    description: "Feed the cubs their special diet",
  },
  planGala: {
    task: "plan-gala",
    project: "fundraiser",
    employee: "cbaskin",
    description: "Plan the annual fundraiser gala",
  },
  sellMerch: {
    task: "sell-merch",
    project: "fundraiser",
    employee: "jlowe",
    description: "Sell merchandise at the gift shop",
  },
}

// =============================================================================
// 6. Helpers
// =============================================================================

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

// =============================================================================
// 7. Main program — 9 access patterns with assertions
// =============================================================================

const program = Effect.gen(function* () {
  const client = yield* DynamoClient

  // --- Setup: create table ---
  yield* client.createTable({
    TableName: "hr-table",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(HrTable, [Employees, Tasks, Offices]),
  })

  // --- Seed data ---
  for (const office of Object.values(offices)) {
    yield* Offices.put(office)
  }
  for (const emp of Object.values(employees)) {
    yield* Employees.put(emp)
  }
  for (const task of Object.values(tasks)) {
    yield* Tasks.put(task)
  }

  // -------------------------------------------------------------------------
  // Pattern 1: CRUD — get, put, update, delete
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 1: CRUD")

  const joe = yield* Employees.get({ employee: "jlowe" })
  assertEq(joe.firstName, "Joe", "get firstName")
  assertEq(joe.lastName, "Lowe", "get lastName")
  assertEq(joe.title, "Zookeeper", "get title")
  assertEq(joe.office, "gw-zoo", "get office")

  const updated = yield* Employees.update({ employee: "jlowe" }).pipe(
    Employees.set({
      office: "gw-zoo",
      team: "jupiter",
      title: "Head Zookeeper",
      salary: "000055.00",
      manager: "jlowe",
    }),
  )
  assertEq(updated.title, "Head Zookeeper", "update title")
  assertEq(updated.salary, "000055.00", "update salary")
  assertEq(updated.firstName, "Joe", "update preserves unchanged fields")

  yield* Employees.delete({ employee: "jlowe" })
  const deleted = yield* Employees.get({ employee: "jlowe" })
    .asEffect()
    .pipe(
      Effect.map(() => false),
      Effect.catchTag("ItemNotFound", () => Effect.succeed(true)),
    )
  assert(deleted, "delete removes item")

  // Re-create for subsequent patterns
  yield* Employees.put(employees.jlowe)
  yield* Console.log("  CRUD: get, update, delete, re-put — OK")

  // -------------------------------------------------------------------------
  // Pattern 2: Workplaces — office info + employees at an office (gsi1)
  //
  // This is the "workplaces" collection pattern. Both entities share gsi1
  // with the same PK (office). Entity.query methods hit the same index.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 2: Workplaces (gsi1 collection)")

  const gwZooEmployees = yield* Query.collect(Employees.query.coworkers({ office: "gw-zoo" }))
  assertEq(gwZooEmployees.length, 2, "gw-zoo has 2 employees")
  const gwZooIds = gwZooEmployees.map((e) => e.employee).sort()
  assertEq(gwZooIds, ["dfinlay", "jlowe"], "gw-zoo employee IDs")

  const gwZooOffice = yield* Query.collect(Offices.query.workplace({ office: "gw-zoo" }))
  assertEq(gwZooOffice.length, 1, "gw-zoo has 1 office record")
  assertEq(gwZooOffice[0]!.city, "Wynnewood", "gw-zoo city")
  assertEq(gwZooOffice[0]!.state, "OK", "gw-zoo state")
  yield* Console.log("  Workplaces: coworkers + office lookup — OK")

  // -------------------------------------------------------------------------
  // Pattern 3: Assignments — employee info + their tasks (gsi3)
  //
  // The "assignments" collection. Employee and Task share gsi3 with PK=employee.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 3: Assignments (gsi3 collection)")

  const dfinlayTasks = yield* Query.collect(Tasks.query.assigned({ employee: "dfinlay" }))
  assertEq(dfinlayTasks.length, 1, "dfinlay has 1 task")
  assertEq(dfinlayTasks[0]!.task, "feed-cats", "dfinlay task ID")
  assertEq(dfinlayTasks[0]!.project, "feeding", "dfinlay task project")

  const dfinlayInfo = yield* Query.collect(Employees.query.employeeLookup({ employee: "dfinlay" }))
  assertEq(dfinlayInfo.length, 1, "employeeLookup returns 1")
  assertEq(dfinlayInfo[0]!.firstName, "Don", "employeeLookup firstName")
  yield* Console.log("  Assignments: tasks + employee lookup — OK")

  // -------------------------------------------------------------------------
  // Pattern 4: Tasks by project (gsi1 — standalone, no collection)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 4: Tasks by Project (gsi1)")

  const feedingTasks = yield* Query.collect(Tasks.query.project({ project: "feeding" }))
  assertEq(feedingTasks.length, 2, "feeding project has 2 tasks")
  const feedingTaskIds = feedingTasks.map((t) => t.task).sort()
  assertEq(feedingTaskIds, ["feed-cats", "feed-cubs"], "feeding task IDs")

  const fundraiserTasks = yield* Query.collect(Tasks.query.project({ project: "fundraiser" }))
  assertEq(fundraiserTasks.length, 2, "fundraiser project has 2 tasks")
  yield* Console.log("  Tasks by project: feeding (2), fundraiser (2) — OK")

  // -------------------------------------------------------------------------
  // Pattern 5: Offices by location (gsi2)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 5: Offices by Location (gsi2)")

  const flOffices = yield* Query.collect(Offices.query.byLocation({ country: "US", state: "FL" }))
  assertEq(flOffices.length, 1, "Florida has 1 office")
  assertEq(flOffices[0]!.office, "big-cat-rescue", "FL office ID")
  assertEq(flOffices[0]!.city, "Tampa", "FL office city")

  const okOffices = yield* Query.collect(Offices.query.byLocation({ country: "US", state: "OK" }))
  assertEq(okOffices.length, 1, "Oklahoma has 1 office")
  assertEq(okOffices[0]!.office, "gw-zoo", "OK office ID")
  yield* Console.log("  Offices by location: FL (1), OK (1) — OK")

  // -------------------------------------------------------------------------
  // Pattern 6: Employees by title + salary range (gsi4)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 6: Salary Range Query (gsi4)")

  const zookeepers = yield* Query.collect(Employees.query.roles({ title: "Zookeeper" }))
  assertEq(zookeepers.length, 1, "1 Zookeeper")
  assertEq(zookeepers[0]!.employee, "jlowe", "Zookeeper is jlowe")
  assertEq(zookeepers[0]!.salary, "000045.00", "Zookeeper salary")

  // Salary range query using sort key between.
  // Compose lo/hi prefixes programmatically via KeyComposer.
  const rolesIndex = Employees.indexes.roles
  const loPrefix = KeyComposer.composeSortKeyPrefix(HrSchema, "Employee", 1, rolesIndex, {
    salary: "000000.00",
  })
  const hiPrefix = KeyComposer.composeSortKeyPrefix(HrSchema, "Employee", 1, rolesIndex, {
    salary: "999999.99",
  })

  const directorsBySalary = yield* Employees.query
    .roles({ title: "Director" })
    .pipe(Query.where({ between: [loPrefix, hiPrefix] }), Query.collect)
  assertEq(directorsBySalary.length, 1, "1 Director in salary range")
  assertEq(directorsBySalary[0]!.employee, "cbaskin", "Director is cbaskin")
  assertEq(directorsBySalary[0]!.salary, "000150.00", "Director salary")
  yield* Console.log("  Roles + salary range: Zookeeper (1), Director between (1) — OK")

  // -------------------------------------------------------------------------
  // Pattern 7: Direct reports (gsi5)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 7: Direct Reports (gsi5)")

  const jloweReports = yield* Query.collect(Employees.query.directReports({ manager: "jlowe" }))
  // jlowe manages dfinlay + himself (self-managed)
  assertEq(jloweReports.length, 2, "jlowe has 2 reports (including self)")
  const jloweReportIds = jloweReports.map((e) => e.employee).sort()
  assertEq(jloweReportIds, ["dfinlay", "jlowe"], "jlowe report IDs")

  const cbaskinReports = yield* Query.collect(Employees.query.directReports({ manager: "cbaskin" }))
  assertEq(cbaskinReports.length, 2, "cbaskin has 2 reports (including self)")
  const cbaskinReportIds = cbaskinReports.map((e) => e.employee).sort()
  assertEq(cbaskinReportIds, ["cbaskin", "hschreibvogel"], "cbaskin report IDs")
  yield* Console.log("  Direct reports: jlowe (2), cbaskin (2) — OK")

  // -------------------------------------------------------------------------
  // Pattern 8: Employee transfer — all-or-none GSI constraints
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 8: Employee Transfer (All-or-None)")

  // Transfer dfinlay from gw-zoo to big-cat-rescue.
  // This touches composites for multiple GSIs:
  //   gsi1 (coworkers): office, team, title — all 3 or none
  //   gsi4 (roles):     title, salary       — both or neither
  //   gsi5 (directReports): manager, team, office — all 3 or none
  //
  // Since office + team are changing, gsi1 and gsi5 are affected.
  // Providing title (for gsi1) also triggers gsi4, requiring salary.
  // We must provide ALL composites for EACH affected GSI.
  const transferred = yield* Employees.update({ employee: "dfinlay" }).pipe(
    Employees.set({
      office: "big-cat-rescue",
      team: "saturn",
      title: "Handler", // required: gsi1 needs all of office, team, title
      salary: "000035.00", // required: gsi4 needs both title and salary
      manager: "cbaskin", // required: gsi5 needs all of manager, team, office
    }),
  )
  assertEq(transferred.office, "big-cat-rescue", "transfer office")
  assertEq(transferred.team, "saturn", "transfer team")
  assertEq(transferred.manager, "cbaskin", "transfer manager")
  assertEq(transferred.firstName, "Don", "transfer preserves unchanged")

  // Verify: dfinlay now appears in cbaskin's direct reports
  const newReports = yield* Query.collect(Employees.query.directReports({ manager: "cbaskin" }))
  // cbaskin + hschreibvogel + dfinlay (transferred)
  assertEq(newReports.length, 3, "cbaskin now has 3 reports after transfer")
  const newReportIds = newReports.map((e) => e.employee).sort()
  assertEq(
    newReportIds,
    ["cbaskin", "dfinlay", "hschreibvogel"],
    "cbaskin report IDs after transfer",
  )

  // Verify: dfinlay no longer in jlowe's reports
  const jloweReportsAfter = yield* Query.collect(
    Employees.query.directReports({ manager: "jlowe" }),
  )
  assertEq(jloweReportsAfter.length, 1, "jlowe has 1 report after transfer")
  assertEq(jloweReportsAfter[0]!.employee, "jlowe", "jlowe's only report is self")

  // Demonstrate the all-or-none constraint: partial GSI update fails.
  // The type system catches this — { office } alone violates:
  //   gsi1 (coworkers): needs office + team + title
  //   gsi5 (directReports): needs manager + team + office
  // The `as any` bypasses the type check to show the runtime guard.
  const partialError = yield* Employees.update({ employee: "dfinlay" }).pipe(
    Employees.set({ office: "gw-zoo" } as any),
    (op) => op.asEffect(),
    Effect.flip,
  )
  assertEq(partialError._tag, "ValidationError", "partial GSI update fails with ValidationError")
  assert(
    String((partialError as any).cause).includes("coworkers"),
    "error references the violating index",
  )
  yield* Console.log("  Transfer + all-or-none runtime guard — OK")

  // -------------------------------------------------------------------------
  // Pattern 9: Atomic onboarding — transactWrite
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 9: Atomic Onboarding (Transaction)")

  yield* Transaction.transactWrite([
    Employees.put({
      employee: "rstarr",
      firstName: "Rick",
      lastName: "Starr",
      office: "gw-zoo",
      title: "Trainee",
      team: "jupiter",
      salary: "000025.00",
      manager: "jlowe",
      dateHired: "2024-01-15",
      birthday: "1995-04-10",
    }),
    Tasks.put({
      task: "orientation",
      project: "onboarding",
      employee: "rstarr",
      description: "Complete new-hire orientation and safety training",
    }),
  ])

  // Verify both items created atomically
  const newHire = yield* Employees.get({ employee: "rstarr" })
  assertEq(newHire.firstName, "Rick", "transaction employee firstName")
  assertEq(newHire.title, "Trainee", "transaction employee title")
  assertEq(newHire.office, "gw-zoo", "transaction employee office")

  const onboardingTasks = yield* Query.collect(Tasks.query.assigned({ employee: "rstarr" }))
  assertEq(onboardingTasks.length, 1, "transaction created 1 task")
  assertEq(onboardingTasks[0]!.task, "orientation", "transaction task ID")
  assertEq(onboardingTasks[0]!.project, "onboarding", "transaction task project")
  yield* Console.log("  Atomic onboarding: employee + task in transaction — OK")

  // -------------------------------------------------------------------------
  // Pattern 10: Employee termination + rehire (soft delete + restore)
  //
  // Soft delete archives the employee record instead of destroying it.
  // GSI keys are stripped, so the employee vanishes from all index queries
  // (coworkers, roles, direct reports) while the record is preserved for
  // audit and compliance. Restore brings them back with all GSI keys
  // recomposed — perfect for rehires.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 10: Termination + Rehire (Soft Delete + Restore)")

  // Terminate hschreibvogel
  yield* Employees.delete({ employee: "hschreibvogel" })

  // Verify: gone from all GSI queries
  const cbaskinReportsAfterTermination = yield* Query.collect(
    Employees.query.directReports({ manager: "cbaskin" }),
  )
  // cbaskin + dfinlay remain, hschreibvogel is archived
  const terminatedReportIds = cbaskinReportsAfterTermination.map((e) => e.employee).sort()
  assert(
    !terminatedReportIds.includes("hschreibvogel"),
    "terminated employee gone from direct reports",
  )

  // But the record is still retrievable via deleted.get (for HR audit)
  const terminatedRecord = yield* Employees.deleted
    .get({ employee: "hschreibvogel" })
    .pipe(Entity.asRecord)
  assertEq(terminatedRecord.firstName, "Howard", "terminated record preserved")
  assertEq(terminatedRecord.lastName, "Schreibvogel", "terminated last name")
  assert((terminatedRecord as any).deletedAt !== undefined, "has deletedAt timestamp")

  // Rehire: restore brings the employee back with all GSI keys recomposed
  const rehired = yield* Employees.restore({ employee: "hschreibvogel" })
  assertEq(rehired.firstName, "Howard", "rehired firstName")
  assertEq(rehired.office, "big-cat-rescue", "rehired office preserved")

  // Verify: back in direct reports query
  const reportsAfterRehire = yield* Query.collect(
    Employees.query.directReports({ manager: "cbaskin" }),
  )
  assert(
    reportsAfterRehire.some((e) => e.employee === "hschreibvogel"),
    "rehired employee back in direct reports",
  )
  yield* Console.log("  Terminate + rehire: soft-delete, audit lookup, restore — OK")

  // -------------------------------------------------------------------------
  // Known limitation: Query.filter() supports equality only.
  // ElectroDB's .where(({ birthday }, { between }) => ...) for date range
  // filtering on non-key attributes cannot be replicated with the current
  // Query.filter() API. A future enhancement could add rich filter operators.
  // -------------------------------------------------------------------------

  // --- Cleanup ---
  yield* client.deleteTable({ TableName: "hr-table" })
  yield* Console.log("\nAll 10 patterns passed.")
})

// =============================================================================
// 7. Provide dependencies and run
// =============================================================================

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  HrTable.layer({ name: "hr-table" }),
)

const main = program.pipe(Effect.provide(AppLayer), Effect.scoped)

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)

export { program, HrTable, HrSchema, Employees, Tasks, Offices, Employee, Task, Office }
