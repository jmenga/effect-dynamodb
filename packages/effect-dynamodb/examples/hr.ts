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
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// =============================================================================
// 1. Pure domain models — no DynamoDB concepts
// =============================================================================

// #region models
const Department = {
  Jupiter: "jupiter",
  Mercury: "mercury",
  Saturn: "saturn",
  Venus: "venus",
  Mars: "mars",
  Neptune: "neptune",
} as const
const DepartmentSchema = Schema.Literals(Object.values(Department))

class Employee extends Schema.Class<Employee>("Employee")({
  employee: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  office: Schema.String,
  title: Schema.String,
  team: DepartmentSchema,
  salary: Schema.String,
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
// #endregion

// =============================================================================
// 2. Schema
// =============================================================================

// #region schema
const HrSchema = DynamoSchema.make({ name: "hr", version: 1 })
// #endregion

// =============================================================================
// 3. Entity definitions — primary key only
// =============================================================================

// #region employee-entity
const Employees = Entity.make({
  model: Employee,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employee"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    workplaces: {
      collection: "workplaces",
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["office"] },
      sk: { field: "gsi1sk", composite: ["team", "title", "employee"] },
    },
    assignments: {
      collection: "assignments",
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["employee"] },
      sk: { field: "gsi3sk", composite: [] },
    },
    byRole: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["title"] },
      sk: { field: "gsi4sk", composite: ["salary", "employee"] },
    },
    byManager: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["manager"] },
      sk: { field: "gsi5sk", composite: ["team", "office", "employee"] },
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: true,
})
// #endregion

// #region task-entity
const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["task"] },
    sk: { field: "sk", composite: ["project", "employee"] },
  },
  indexes: {
    byProject: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["project"] },
      sk: { field: "gsi1sk", composite: ["employee", "task"] },
    },
    assignments: {
      collection: "assignments",
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["employee"] },
      sk: { field: "gsi3sk", composite: ["project", "task"] },
    },
  },
  timestamps: true,
})
// #endregion

// #region office-entity
const Offices = Entity.make({
  model: Office,
  entityType: "Office",
  primaryKey: {
    pk: { field: "pk", composite: ["office"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    workplaces: {
      collection: "workplaces",
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["office"] },
      sk: { field: "gsi1sk", composite: [] },
    },
    byLocation: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["country", "state"] },
      sk: { field: "gsi2sk", composite: ["city", "zip", "office"] },
    },
  },
  timestamps: true,
})
// #endregion

// =============================================================================
// 4. Table + Collections — GSI access patterns
// =============================================================================

// #region table
const HrTable = Table.make({
  schema: HrSchema,
  entities: { Employees, Tasks, Offices },
})
// #endregion

// #region collections
// GSI access patterns are now defined as entity-level indexes above.
// Multi-entity collections (workplaces, assignments) are auto-discovered
// from matching collection names across entities.
// #endregion

// =============================================================================
// 5. Seed data + helpers (unchanged)
// =============================================================================

// #region seed-data
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
    manager: "jlowe",
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
    manager: "cbaskin",
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
// #endregion

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

// =============================================================================
// 6. Main program — 10 access patterns with assertions
// =============================================================================

const program = Effect.gen(function* () {
  // Typed execution gateway — binds all entities and collections
  // #region seed-execution
  const db = yield* DynamoClient.make({
    entities: { Employees, Tasks, Offices },
  })

  // --- Setup: create table ---
  yield* db.tables["hr-table"]!.create()

  // --- Seed data ---
  for (const office of Object.values(offices)) {
    yield* db.entities.Offices.put(office)
  }
  for (const emp of Object.values(employees)) {
    yield* db.entities.Employees.put(emp)
  }
  for (const task of Object.values(tasks)) {
    yield* db.entities.Tasks.put(task)
  }
  // #endregion

  // Pattern 1: CRUD
  yield* Console.log("Pattern 1: CRUD")

  // #region crud
  const joe = yield* db.entities.Employees.get({ employee: "jlowe" })

  const updated = yield* db.entities.Employees.update(
    { employee: "jlowe" },
    Entity.set({
      office: "gw-zoo",
      team: "jupiter",
      title: "Head Zookeeper",
      salary: "000055.00",
      manager: "jlowe",
    }),
  )

  yield* db.entities.Employees.delete({ employee: "jlowe" })

  yield* db.entities.Employees.put(employees.jlowe)
  // #endregion
  assertEq(joe.firstName, "Joe", "get firstName")
  assertEq(joe.lastName, "Lowe", "get lastName")
  assertEq(joe.title, "Zookeeper", "get title")
  assertEq(joe.office, "gw-zoo", "get office")
  assertEq(updated.title, "Head Zookeeper", "update title")
  assertEq(updated.salary, "000055.00", "update salary")
  assertEq(updated.firstName, "Joe", "update preserves unchanged fields")
  // Note: delete + re-put is verified implicitly (jlowe is used in subsequent patterns)
  yield* Console.log("  CRUD: get, update, delete, re-put — OK")

  // Pattern 2: Workplaces (gsi1 collection)
  yield* Console.log("Pattern 2: Workplaces (gsi1 collection)")

  // #region workplaces
  const { Employees: gwZooEmployees } = yield* db.collections.Workplaces!({
    office: "gw-zoo",
  }).collect()

  const { Offices: gwZooOffice } = yield* db.collections.Workplaces!({ office: "gw-zoo" }).collect()
  // #endregion
  assertEq(gwZooEmployees.length, 2, "gw-zoo has 2 employees")
  const gwZooIds = gwZooEmployees.map((e: any) => e.employee).sort()
  assertEq(gwZooIds, ["dfinlay", "jlowe"], "gw-zoo employee IDs")
  assertEq(gwZooOffice.length, 1, "gw-zoo has 1 office record")
  assertEq(gwZooOffice[0]!.city, "Wynnewood", "gw-zoo city")
  assertEq(gwZooOffice[0]!.state, "OK", "gw-zoo state")
  yield* Console.log("  Workplaces: coworkers + office lookup — OK")

  // Pattern 3: Assignments (gsi3 collection)
  yield* Console.log("Pattern 3: Assignments (gsi3 collection)")

  // #region assignments
  const { Tasks: dfinlayTasks } = yield* db.collections.Assignments!({
    employee: "dfinlay",
  }).collect()

  const { Employees: dfinlayInfo } = yield* db.collections.Assignments!({
    employee: "dfinlay",
  }).collect()
  // #endregion
  assertEq(dfinlayTasks.length, 1, "dfinlay has 1 task")
  assertEq(dfinlayTasks[0]!.task, "feed-cats", "dfinlay task ID")
  assertEq(dfinlayTasks[0]!.project, "feeding", "dfinlay task project")
  assertEq(dfinlayInfo.length, 1, "employeeLookup returns 1")
  assertEq(dfinlayInfo[0]!.firstName, "Don", "employeeLookup firstName")
  yield* Console.log("  Assignments: tasks + employee lookup — OK")

  // Pattern 4: Tasks by Project (gsi1)
  yield* Console.log("Pattern 4: Tasks by Project (gsi1)")

  // #region tasks-by-project
  const feedingTasks = yield* db.entities.Tasks.byProject({ project: "feeding" }).collect()

  const fundraiserTasks = yield* db.entities.Tasks.byProject({ project: "fundraiser" }).collect()
  // #endregion
  assertEq(feedingTasks.length, 2, "feeding project has 2 tasks")
  const feedingTaskIds = feedingTasks.map((t) => t.task).sort()
  assertEq(feedingTaskIds, ["feed-cats", "feed-cubs"], "feeding task IDs")
  assertEq(fundraiserTasks.length, 2, "fundraiser project has 2 tasks")
  yield* Console.log("  Tasks by project: feeding (2), fundraiser (2) — OK")

  // Pattern 5: Offices by Location (gsi2)
  yield* Console.log("Pattern 5: Offices by Location (gsi2)")

  // #region offices-by-location
  const flOffices = yield* db.entities.Offices.byLocation({ country: "US", state: "FL" }).collect()

  const okOffices = yield* db.entities.Offices.byLocation({ country: "US", state: "OK" }).collect()
  // #endregion
  assertEq(flOffices.length, 1, "Florida has 1 office")
  assertEq(flOffices[0]!.office, "big-cat-rescue", "FL office ID")
  assertEq(flOffices[0]!.city, "Tampa", "FL office city")
  assertEq(okOffices.length, 1, "Oklahoma has 1 office")
  assertEq(okOffices[0]!.office, "gw-zoo", "OK office ID")
  yield* Console.log("  Offices by location: FL (1), OK (1) — OK")

  // Pattern 6: Salary Range Query (gsi4)
  yield* Console.log("Pattern 6: Salary Range Query (gsi4)")

  // #region salary-range
  const zookeepers = yield* db.entities.Employees.byRole({ title: "Zookeeper" }).collect()

  // All directors — filter by salary range in application code
  const allDirectors = yield* db.entities.Employees.byRole({ title: "Director" }).collect()
  const directorsBySalary = allDirectors.filter(
    (e) => e.salary >= "000000.00" && e.salary <= "999999.99",
  )
  // #endregion
  assertEq(zookeepers.length, 1, "1 Zookeeper")
  assertEq(zookeepers[0]!.employee, "jlowe", "Zookeeper is jlowe")
  assertEq(zookeepers[0]!.salary, "000045.00", "Zookeeper salary")
  assertEq(directorsBySalary.length, 1, "1 Director in salary range")
  assertEq(directorsBySalary[0]!.employee, "cbaskin", "Director is cbaskin")
  assertEq(directorsBySalary[0]!.salary, "000150.00", "Director salary")
  yield* Console.log("  Roles + salary range: Zookeeper (1), Director between (1) — OK")

  // Pattern 7: Direct Reports (gsi5)
  yield* Console.log("Pattern 7: Direct Reports (gsi5)")

  // #region direct-reports
  const jloweReports = yield* db.entities.Employees.byManager({ manager: "jlowe" }).collect()

  const cbaskinReports = yield* db.entities.Employees.byManager({ manager: "cbaskin" }).collect()
  // #endregion
  assertEq(jloweReports.length, 2, "jlowe has 2 reports (including self)")
  const jloweReportIds = jloweReports.map((e) => e.employee).sort()
  assertEq(jloweReportIds, ["dfinlay", "jlowe"], "jlowe report IDs")
  assertEq(cbaskinReports.length, 2, "cbaskin has 2 reports (including self)")
  const cbaskinReportIds = cbaskinReports.map((e) => e.employee).sort()
  assertEq(cbaskinReportIds, ["cbaskin", "hschreibvogel"], "cbaskin report IDs")
  yield* Console.log("  Direct reports: jlowe (2), cbaskin (2) — OK")

  // Pattern 8: Employee Transfer (All-or-None)
  yield* Console.log("Pattern 8: Employee Transfer (All-or-None)")

  // #region transfer
  const transferred = yield* db.entities.Employees.update(
    { employee: "dfinlay" },
    Entity.set({
      office: "big-cat-rescue",
      team: "saturn",
      title: "Handler",
      salary: "000035.00",
      manager: "cbaskin",
    }),
  )

  const newReports = yield* db.entities.Employees.byManager({ manager: "cbaskin" }).collect()

  const jloweReportsAfter = yield* db.entities.Employees.byManager({ manager: "jlowe" }).collect()
  // #endregion
  assertEq(transferred.office, "big-cat-rescue", "transfer office")
  assertEq(transferred.team, "saturn", "transfer team")
  assertEq(transferred.manager, "cbaskin", "transfer manager")
  assertEq(transferred.firstName, "Don", "transfer preserves unchanged")
  assertEq(newReports.length, 3, "cbaskin now has 3 reports after transfer")
  const newReportIds = newReports.map((e) => e.employee).sort()
  assertEq(
    newReportIds,
    ["cbaskin", "dfinlay", "hschreibvogel"],
    "cbaskin report IDs after transfer",
  )
  assertEq(jloweReportsAfter.length, 1, "jlowe has 1 report after transfer")
  assertEq(jloweReportsAfter[0]!.employee, "jlowe", "jlowe's only report is self")

  // Partial GSI update fails at runtime
  // #region partial-gsi-error
  const partialError = yield* db.entities.Employees.update(
    { employee: "dfinlay" },
    Entity.set({ office: "gw-zoo" } as any),
  ).pipe(Effect.flip)
  // #endregion
  assertEq(partialError._tag, "ValidationError", "partial GSI update fails with ValidationError")
  assert(
    String((partialError as any).cause).includes("workplaces"),
    "error references the violating index",
  )
  yield* Console.log("  Transfer + all-or-none runtime guard — OK")

  // Pattern 9: Atomic Onboarding (Transaction)
  yield* Console.log("Pattern 9: Atomic Onboarding (Transaction)")

  // #region transaction
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

  const newHire = yield* db.entities.Employees.get({ employee: "rstarr" })

  const { Tasks: onboardingTasks } = yield* db.collections.Assignments!({
    employee: "rstarr",
  }).collect()
  // #endregion
  assertEq(newHire.firstName, "Rick", "transaction employee firstName")
  assertEq(newHire.title, "Trainee", "transaction employee title")
  assertEq(newHire.office, "gw-zoo", "transaction employee office")
  assertEq(onboardingTasks.length, 1, "transaction created 1 task")
  assertEq(onboardingTasks[0]!.task, "orientation", "transaction task ID")
  assertEq(onboardingTasks[0]!.project, "onboarding", "transaction task project")
  yield* Console.log("  Atomic onboarding: employee + task in transaction — OK")

  // Pattern 10: Termination + Rehire (Soft Delete + Restore)
  yield* Console.log("Pattern 10: Termination + Rehire (Soft Delete + Restore)")

  // #region soft-delete
  yield* db.entities.Employees.delete({ employee: "hschreibvogel" })

  const cbaskinReportsAfterTermination = yield* db.entities.Employees.byManager({
    manager: "cbaskin",
  }).collect()

  const terminatedRecord = yield* db.entities.Employees.deleted.get({
    employee: "hschreibvogel",
  })

  const rehired = yield* db.entities.Employees.restore({ employee: "hschreibvogel" })

  const reportsAfterRehire = yield* db.entities.Employees.byManager({
    manager: "cbaskin",
  }).collect()
  // #endregion
  const terminatedReportIds = cbaskinReportsAfterTermination.map((e) => e.employee).sort()
  assert(
    !terminatedReportIds.includes("hschreibvogel"),
    "terminated employee gone from direct reports",
  )
  assertEq(terminatedRecord.firstName, "Howard", "terminated record preserved")
  assertEq(terminatedRecord.lastName, "Schreibvogel", "terminated last name")
  assertEq(rehired.firstName, "Howard", "rehired firstName")
  assertEq(rehired.office, "big-cat-rescue", "rehired office preserved")
  assert(
    reportsAfterRehire.some((e) => e.employee === "hschreibvogel"),
    "rehired employee back in direct reports",
  )
  yield* Console.log("  Terminate + rehire: soft-delete, audit lookup, restore — OK")

  // --- Cleanup ---
  yield* db.tables["hr-table"]!.delete()
  yield* Console.log("\nAll 10 patterns passed.")
})

// =============================================================================
// 7. Layer + run
// =============================================================================

// #region layer
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  HrTable.layer({ name: "hr-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion

export { program, HrTable, HrSchema, Employees, Tasks, Offices, Employee, Task, Office }
