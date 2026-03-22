/**
 * Task Manager Example — ElectroDB Task Manager Adaptation
 *
 * Adapted from the ElectroDB Task Manager example:
 * https://electrodb.dev/en/examples/task-manager/
 *
 * Demonstrates patterns UNIQUE vs the HR example:
 * - 3 entities (Employee, Task, Office) in one table with 5 GSIs
 * - gsi2 `teams`: employees by team with dateHired range queries
 * - gsi4 `statuses` on Task: tasks by status across all projects
 * - Task.points: numeric field for point-based filtering
 * - Task status workflow: open -> in-progress -> closed transitions
 * - Closed task archival via soft delete (GSI keys stripped)
 * - 9 access patterns with assertions
 *
 * Shared patterns (brief, since HR covers them in depth):
 * - Workplaces collection (gsi1): Office + Employee by office
 * - Assignments collection (gsi3): Employee + Task by employee
 * - Employee roles by title + salary (gsi4 on Employee)
 * - Atomic onboarding via Transaction.transactWrite
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/task-manager.ts
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

const Department = {
  Development: "development",
  Marketing: "marketing",
  Finance: "finance",
  Product: "product",
} as const
const DepartmentSchema = Schema.Literals(Object.values(Department))

const TaskStatus = { Open: "open", InProgress: "in-progress", Closed: "closed" } as const
const TaskStatusSchema = Schema.Literals(Object.values(TaskStatus))

class Employee extends Schema.Class<Employee>("Employee")({
  employee: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  office: Schema.String,
  title: Schema.String,
  team: DepartmentSchema,
  salary: Schema.String, // Zero-padded "000100.00" for lexicographic SK ordering
  manager: Schema.String,
  dateHired: Schema.String,
}) {}

class Task extends Schema.Class<Task>("Task")({
  task: Schema.String,
  project: Schema.String,
  employee: Schema.String,
  description: Schema.String,
  status: TaskStatusSchema,
  points: Schema.Number,
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
// 2. Schema
// =============================================================================

const TmSchema = DynamoSchema.make({ name: "taskman", version: 1 })

// =============================================================================
// 3. Entity definitions — pure, no table reference
//
// Key difference vs HR: Employee has `teams` (gsi2) and Task has `statuses`
// (gsi4), plus Task includes `status` and `points` fields.
// =============================================================================

/**
 * Employee — 6 indexes (primary + 5 GSIs)
 *
 * Full ElectroDB Task Manager index set including:
 * - gsi2 `teams`: pk=[team], sk=[dateHired, title] — NOT in HR example
 */
const Employees = Entity.make({
  model: Employee,
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
    teams: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["team"] },
      sk: { field: "gsi2sk", composite: ["dateHired", "title"] },
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
      sk: { field: "gsi4sk", composite: ["salary"] },
    },
    directReports: {
      index: "gsi5",
      pk: { field: "gsi5pk", composite: ["manager"] },
      sk: { field: "gsi5sk", composite: ["team", "office"] },
    },
  },
  timestamps: true,
})

/**
 * Task — 4 indexes (primary + 3 GSIs)
 *
 * Full ElectroDB Task Manager index set including:
 * - gsi4 `statuses`: pk=[status], sk=[project, employee] — NOT in HR example
 * - `points` field (Schema.Number) for point-based filtering
 */
const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["task"] },
      sk: { field: "sk", composite: ["project", "employee"] },
    },
    project: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["project"] },
      sk: { field: "gsi1sk", composite: ["employee", "status"] },
    },
    assigned: {
      index: "gsi3",
      collection: "assignments",
      pk: { field: "gsi3pk", composite: ["employee"] },
      sk: { field: "gsi3sk", composite: ["project", "status"] },
    },
    statuses: {
      index: "gsi4",
      pk: { field: "gsi4pk", composite: ["status"] },
      sk: { field: "gsi4sk", composite: ["project", "employee"] },
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: true,
})

/**
 * Office — 2 indexes (primary + 1 GSI)
 *
 * gsi1 is shared with Employee via the "workplaces" collection.
 */
const Offices = Entity.make({
  model: Office,
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
  },
  timestamps: true,
})

// =============================================================================
// 4. Table definition — declares all members
// =============================================================================

const TmTable = Table.make({ schema: TmSchema, entities: { Employees, Tasks, Offices } })

// =============================================================================
// 5. Seed data
// =============================================================================

const offices = {
  portland: {
    office: "portland",
    country: "US",
    state: "OR",
    city: "Portland",
    zip: "97201",
    address: "123 SW Main St",
  },
  nyc: {
    office: "nyc",
    country: "US",
    state: "NY",
    city: "New York",
    zip: "10001",
    address: "456 Broadway",
  },
} as const

const employees = {
  tyler: {
    employee: "tyler",
    firstName: "Tyler",
    lastName: "Walch",
    office: "portland",
    title: "Senior Engineer",
    team: "development" as const,
    salary: "000120.00",
    manager: "tyler", // self-managed
    dateHired: "2019-03-15",
  },
  sean: {
    employee: "sean",
    firstName: "Sean",
    lastName: "Green",
    office: "portland",
    title: "Junior Engineer",
    team: "development" as const,
    salary: "000085.00",
    manager: "tyler",
    dateHired: "2022-06-01",
  },
  morgan: {
    employee: "morgan",
    firstName: "Morgan",
    lastName: "Lee",
    office: "nyc",
    title: "Product Manager",
    team: "product" as const,
    salary: "000110.00",
    manager: "morgan", // self-managed
    dateHired: "2020-09-01",
  },
  alex: {
    employee: "alex",
    firstName: "Alex",
    lastName: "Chen",
    office: "nyc",
    title: "Marketing Lead",
    team: "marketing" as const,
    salary: "000095.00",
    manager: "morgan",
    dateHired: "2021-01-15",
  },
}

const tasks = {
  buildApi: {
    task: "build-api",
    project: "platform",
    employee: "tyler",
    description: "Build the REST API for the platform",
    status: "open" as const,
    points: 8,
  },
  writeTests: {
    task: "write-tests",
    project: "platform",
    employee: "sean",
    description: "Write integration tests for the API",
    status: "in-progress" as const,
    points: 5,
  },
  designLanding: {
    task: "design-landing",
    project: "website",
    employee: "alex",
    description: "Design the landing page for the website",
    status: "open" as const,
    points: 13,
  },
  userResearch: {
    task: "user-research",
    project: "website",
    employee: "morgan",
    description: "Conduct user research interviews",
    status: "closed" as const,
    points: 3,
  },
  codeReview: {
    task: "code-review",
    project: "platform",
    employee: "tyler",
    description: "Review PRs from the team",
    status: "open" as const,
    points: 2,
  },
  deployCi: {
    task: "deploy-ci",
    project: "platform",
    employee: "sean",
    description: "Set up CI/CD pipeline",
    status: "open" as const,
    points: 5,
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
  // Typed execution gateway — binds all table members
  const db = yield* DynamoClient.make(TmTable)

  // --- Setup: create table ---
  yield* db.createTable()

  // --- Seed data ---
  for (const office of Object.values(offices)) {
    yield* db.Offices.put(office)
  }
  for (const emp of Object.values(employees)) {
    yield* db.Employees.put(emp)
  }
  for (const task of Object.values(tasks)) {
    yield* db.Tasks.put(task)
  }

  // -------------------------------------------------------------------------
  // Pattern 1: CRUD — get, put, update, delete on Employee + Task
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 1: CRUD")

  const tyler = yield* db.Employees.get({ employee: "tyler" })
  assertEq(tyler.firstName, "Tyler", "get firstName")
  assertEq(tyler.lastName, "Walch", "get lastName")
  assertEq(tyler.title, "Senior Engineer", "get title")
  assertEq(tyler.team, "development", "get team")

  const buildApi = yield* db.Tasks.get({
    task: "build-api",
    project: "platform",
    employee: "tyler",
  })
  assertEq(buildApi.description, "Build the REST API for the platform", "get task description")
  assertEq(buildApi.status, "open", "get task status")
  assertEq(buildApi.points, 8, "get task points")

  // Update employee title — must provide all GSI composites for affected indexes
  const promoted = yield* db.Employees.update(
    { employee: "tyler" },
    Entity.set({
      office: "portland",
      team: "development",
      title: "Staff Engineer",
      salary: "000140.00",
      manager: "tyler",
      dateHired: "2019-03-15",
    }),
  )
  assertEq(promoted.title, "Staff Engineer", "update title")
  assertEq(promoted.salary, "000140.00", "update salary")
  assertEq(promoted.firstName, "Tyler", "update preserves unchanged fields")

  yield* db.Employees.delete({ employee: "tyler" })
  const deleted = yield* db.Employees.get({ employee: "tyler" }).pipe(
    Effect.map(() => false),
    Effect.catchTag("ItemNotFound", () => Effect.succeed(true)),
  )
  assert(deleted, "delete removes item")

  // Re-create for subsequent patterns (with original data)
  yield* db.Employees.put(employees.tyler)
  yield* Console.log("  CRUD: get, update, delete, re-put on Employee + Task — OK")

  // -------------------------------------------------------------------------
  // Pattern 2: Workplaces collection — office + employees at an office (gsi1)
  //
  // Brief — HR covers this pattern in depth. Just verify it works here.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 2: Workplaces (gsi1 collection)")

  const portlandEmployees = yield* db.Employees.collect(
    Employees.query.coworkers({ office: "portland" }),
  )
  assertEq(portlandEmployees.length, 2, "portland has 2 employees")
  const portlandIds = portlandEmployees.map((e) => e.employee).sort()
  assertEq(portlandIds, ["sean", "tyler"], "portland employee IDs")

  const portlandOffice = yield* db.Offices.collect(Offices.query.workplace({ office: "portland" }))
  assertEq(portlandOffice.length, 1, "portland has 1 office record")
  assertEq(portlandOffice[0]!.city, "Portland", "portland city")
  yield* Console.log("  Workplaces: coworkers + office lookup — OK")

  // -------------------------------------------------------------------------
  // Pattern 3: Assignments collection — employee info + their tasks (gsi3)
  //
  // Brief — HR covers this pattern in depth. Verify with task points.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 3: Assignments (gsi3 collection)")

  const tylerTasks = yield* db.Tasks.collect(Tasks.query.assigned({ employee: "tyler" }))
  assertEq(tylerTasks.length, 2, "tyler has 2 tasks")
  const tylerTaskIds = tylerTasks.map((t) => t.task).sort()
  assertEq(tylerTaskIds, ["build-api", "code-review"], "tyler task IDs")
  // Verify points field (numeric) comes through correctly
  const totalTylerPoints = tylerTasks.reduce((sum, t) => sum + t.points, 0)
  assertEq(totalTylerPoints, 10, "tyler total points (8 + 2)")

  const tylerInfo = yield* db.Employees.collect(
    Employees.query.employeeLookup({ employee: "tyler" }),
  )
  assertEq(tylerInfo.length, 1, "employeeLookup returns 1")
  assertEq(tylerInfo[0]!.firstName, "Tyler", "employeeLookup firstName")
  yield* Console.log("  Assignments: tasks + employee lookup — OK")

  // -------------------------------------------------------------------------
  // Pattern 4: Teams query — employees by team with dateHired range (gsi2)
  //
  // NEW — not in the HR example. This is the key differentiator.
  // gsi2 pk=[team], sk=[dateHired, title]
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 4: Teams Query (gsi2) — NEW")

  // All development team members
  const devTeam = yield* db.Employees.collect(Employees.query.teams({ team: "development" }))
  assertEq(devTeam.length, 2, "development team has 2 members")
  const devNames = devTeam.map((e) => e.firstName).sort()
  assertEq(devNames, ["Sean", "Tyler"], "development team names")

  // Product team — should just be Morgan
  const productTeam = yield* db.Employees.collect(Employees.query.teams({ team: "product" }))
  assertEq(productTeam.length, 1, "product team has 1 member")
  assertEq(productTeam[0]!.employee, "morgan", "product team member")

  // Marketing team — should just be Alex
  const marketingTeam = yield* db.Employees.collect(Employees.query.teams({ team: "marketing" }))
  assertEq(marketingTeam.length, 1, "marketing team has 1 member")
  assertEq(marketingTeam[0]!.employee, "alex", "marketing team member")

  // Range query: development team members hired between 2020 and 2023
  // SK is [dateHired, title], so beginsWith on dateHired prefix works for range
  const teamsIndex = Employees.indexes.teams
  const loHired = KeyComposer.composeSortKeyPrefix(TmSchema, "Employee", 1, teamsIndex, {
    dateHired: "2020-01-01",
  })
  const hiHired = KeyComposer.composeSortKeyPrefix(TmSchema, "Employee", 1, teamsIndex, {
    dateHired: "2023-12-31",
  })

  const recentDevHires = yield* db.Employees.collect(
    Employees.query
      .teams({ team: "development" })
      .pipe(Query.where({ between: [loHired, hiHired] })),
  )
  assertEq(recentDevHires.length, 1, "1 dev hired between 2020-2023")
  assertEq(recentDevHires[0]!.employee, "sean", "recent dev hire is sean")
  assertEq(recentDevHires[0]!.dateHired, "2022-06-01", "sean's hire date")

  // Reverse sort: development team by most recently hired first
  const devReversed = yield* db.Employees.collect(
    Employees.query.teams({ team: "development" }).pipe(Query.reverse),
  )
  assertEq(devReversed.length, 2, "reversed dev team has 2 members")
  assertEq(devReversed[0]!.employee, "sean", "most recent hire first (sean)")
  assertEq(devReversed[1]!.employee, "tyler", "earliest hire second (tyler)")
  yield* Console.log(
    "  Teams: all dev (2), product (1), marketing (1), hired range (1), reversed — OK",
  )

  // -------------------------------------------------------------------------
  // Pattern 5: Task statuses — tasks by status across all projects (gsi4)
  //
  // NEW — not in the HR example. This is the other key differentiator.
  // gsi4 pk=[status], sk=[project, employee]
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 5: Task Statuses (gsi4 on Task) — NEW")

  // All open tasks across all projects
  const openTasks = yield* db.Tasks.collect(Tasks.query.statuses({ status: "open" }))
  assertEq(openTasks.length, 4, "4 open tasks total")
  const openTaskIds = openTasks.map((t) => t.task).sort()
  assertEq(
    openTaskIds,
    ["build-api", "code-review", "deploy-ci", "design-landing"],
    "open task IDs",
  )
  // Verify points are present on status-queried tasks
  const totalOpenPoints = openTasks.reduce((sum, t) => sum + t.points, 0)
  assertEq(totalOpenPoints, 28, "total open points (8+2+5+13)")

  // In-progress tasks
  const inProgressTasks = yield* db.Tasks.collect(Tasks.query.statuses({ status: "in-progress" }))
  assertEq(inProgressTasks.length, 1, "1 in-progress task")
  assertEq(inProgressTasks[0]!.task, "write-tests", "in-progress task ID")
  assertEq(inProgressTasks[0]!.points, 5, "in-progress task points")

  // Closed tasks
  const closedTasks = yield* db.Tasks.collect(Tasks.query.statuses({ status: "closed" }))
  assertEq(closedTasks.length, 1, "1 closed task")
  assertEq(closedTasks[0]!.task, "user-research", "closed task ID")
  assertEq(closedTasks[0]!.points, 3, "closed task points")

  // Open tasks in a specific project using SK prefix (beginsWith)
  const statusesIndex = Tasks.indexes.statuses
  const platformPrefix = KeyComposer.composeSortKeyPrefix(TmSchema, "Task", 1, statusesIndex, {
    project: "platform",
  })
  const openPlatformTasks = yield* db.Tasks.collect(
    Tasks.query.statuses({ status: "open" }).pipe(Query.where({ beginsWith: platformPrefix })),
  )
  assertEq(openPlatformTasks.length, 3, "3 open platform tasks")
  const openPlatformIds = openPlatformTasks.map((t) => t.task).sort()
  assertEq(openPlatformIds, ["build-api", "code-review", "deploy-ci"], "open platform task IDs")
  yield* Console.log("  Statuses: open (4), in-progress (1), closed (1), open+platform (3) — OK")

  // -------------------------------------------------------------------------
  // Pattern 6: Task status workflow — update task through lifecycle
  //
  // Demonstrates status transitions: open -> in-progress -> closed
  // with GSI recomposition (gsi1, gsi3, gsi4 all include status)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 6: Task Status Workflow")

  // Move build-api from open -> in-progress
  const inProgress = yield* db.Tasks.update(
    { task: "build-api", project: "platform", employee: "tyler" },
    Entity.set({ status: "in-progress" }),
  )
  assertEq(inProgress.status, "in-progress", "build-api now in-progress")
  assertEq(inProgress.points, 8, "points preserved after status update")

  // Verify: open tasks decreased by 1
  const openAfterTransition = yield* db.Tasks.collect(Tasks.query.statuses({ status: "open" }))
  assertEq(openAfterTransition.length, 3, "3 open tasks after transition")

  // Verify: in-progress tasks increased by 1
  const inProgressAfterTransition = yield* db.Tasks.collect(
    Tasks.query.statuses({ status: "in-progress" }),
  )
  assertEq(inProgressAfterTransition.length, 2, "2 in-progress tasks after transition")
  const inProgressIds = inProgressAfterTransition.map((t) => t.task).sort()
  assertEq(inProgressIds, ["build-api", "write-tests"], "in-progress task IDs")

  // Move build-api from in-progress -> closed
  const closed = yield* db.Tasks.update(
    { task: "build-api", project: "platform", employee: "tyler" },
    Entity.set({ status: "closed" }),
  )
  assertEq(closed.status, "closed", "build-api now closed")

  // Verify: closed tasks increased
  const closedAfterWorkflow = yield* db.Tasks.collect(Tasks.query.statuses({ status: "closed" }))
  assertEq(closedAfterWorkflow.length, 2, "2 closed tasks after full workflow")
  const closedIds = closedAfterWorkflow.map((t) => t.task).sort()
  assertEq(closedIds, ["build-api", "user-research"], "closed task IDs after workflow")

  // Restore build-api to original state for clean assertions below
  yield* db.Tasks.update(
    { task: "build-api", project: "platform", employee: "tyler" },
    Entity.set({ status: "open" }),
  )
  yield* Console.log("  Workflow: open -> in-progress -> closed with GSI recomposition — OK")

  // -------------------------------------------------------------------------
  // Pattern 7: Employee roles by title + salary (gsi4 on Employee)
  //
  // Brief — HR covers this in depth. Verify salary range queries work here.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 7: Employee Roles (gsi4)")

  const engineers = yield* db.Employees.collect(Employees.query.roles({ title: "Senior Engineer" }))
  assertEq(engineers.length, 1, "1 Senior Engineer")
  assertEq(engineers[0]!.employee, "tyler", "Senior Engineer is tyler")
  assertEq(engineers[0]!.salary, "000120.00", "Senior Engineer salary")

  // Salary range query across all Product Managers
  const rolesIndex = Employees.indexes.roles
  const loSalary = KeyComposer.composeSortKeyPrefix(TmSchema, "Employee", 1, rolesIndex, {
    salary: "000100.00",
  })
  const hiSalary = KeyComposer.composeSortKeyPrefix(TmSchema, "Employee", 1, rolesIndex, {
    salary: "000200.00",
  })
  const wellPaidPMs = yield* db.Employees.collect(
    Employees.query
      .roles({ title: "Product Manager" })
      .pipe(Query.where({ between: [loSalary, hiSalary] })),
  )
  assertEq(wellPaidPMs.length, 1, "1 PM in salary range 100-200k")
  assertEq(wellPaidPMs[0]!.employee, "morgan", "well-paid PM is morgan")
  yield* Console.log("  Roles: Senior Engineer (1), PM salary range (1) — OK")

  // -------------------------------------------------------------------------
  // Pattern 8: Atomic onboarding — create employee + first task in transaction
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 8: Atomic Onboarding (Transaction)")

  yield* Transaction.transactWrite([
    Employees.put({
      employee: "jordan",
      firstName: "Jordan",
      lastName: "Rivera",
      office: "portland",
      title: "Junior Engineer",
      team: "development",
      salary: "000080.00",
      manager: "tyler",
      dateHired: "2024-02-01",
    }),
    Tasks.put({
      task: "onboarding",
      project: "internal",
      employee: "jordan",
      description: "Complete new-hire orientation and setup dev environment",
      status: "open",
      points: 3,
    }),
  ])

  // Verify both items created atomically
  const newHire = yield* db.Employees.get({ employee: "jordan" })
  assertEq(newHire.firstName, "Jordan", "transaction employee firstName")
  assertEq(newHire.title, "Junior Engineer", "transaction employee title")
  assertEq(newHire.team, "development", "transaction employee team")

  const onboardingTasks = yield* db.Tasks.collect(Tasks.query.assigned({ employee: "jordan" }))
  assertEq(onboardingTasks.length, 1, "transaction created 1 task")
  assertEq(onboardingTasks[0]!.task, "onboarding", "transaction task ID")
  assertEq(onboardingTasks[0]!.points, 3, "transaction task points")

  // Verify new hire appears in teams query
  const devTeamAfterHire = yield* db.Employees.collect(
    Employees.query.teams({ team: "development" }),
  )
  assertEq(devTeamAfterHire.length, 3, "development team now has 3 members")

  // Verify new open task appears in statuses query
  const openAfterHire = yield* db.Tasks.collect(Tasks.query.statuses({ status: "open" }))
  assert(
    openAfterHire.some((t) => t.task === "onboarding"),
    "onboarding task appears in open status query",
  )
  yield* Console.log("  Atomic onboarding: employee + task in transaction — OK")

  // -------------------------------------------------------------------------
  // Pattern 9: Task archival — soft delete closed tasks
  //
  // Soft delete strips GSI keys, so archived tasks vanish from all status,
  // project, and assignment queries while remaining retrievable for audit.
  // This is the natural end of the task lifecycle: open -> closed -> archived.
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 9: Task Archival (Soft Delete) — NEW")

  // Archive the closed "user-research" task
  yield* db.Tasks.delete({ task: "user-research", project: "website", employee: "morgan" })

  // Verify: closed tasks no longer include the archived one
  const closedAfterArchive = yield* db.Tasks.collect(Tasks.query.statuses({ status: "closed" }))
  // build-api was restored to open in pattern 6 — user-research was the only closed task
  assertEq(closedAfterArchive.length, 0, "0 closed tasks after archiving user-research")

  // Verify: morgan's assignments no longer include the archived task
  const morganTasks = yield* db.Tasks.collect(Tasks.query.assigned({ employee: "morgan" }))
  assert(
    !morganTasks.some((t) => t.task === "user-research"),
    "archived task gone from assignment query",
  )

  // But the archived task is still retrievable via deleted.get
  const archivedTask = yield* db.Tasks.deleted.get({
    task: "user-research",
    project: "website",
    employee: "morgan",
  })
  assertEq(archivedTask.description, "Conduct user research interviews", "archived task preserved")

  // Restore if needed (e.g., task was archived by mistake)
  const unarchived = yield* db.Tasks.restore({
    task: "user-research",
    project: "website",
    employee: "morgan",
  })
  assertEq(unarchived.status, "closed", "restored task retains original status")

  // Verify: task is back in status queries
  const closedAfterRestore = yield* db.Tasks.collect(Tasks.query.statuses({ status: "closed" }))
  assert(
    closedAfterRestore.some((t) => t.task === "user-research"),
    "restored task back in status query",
  )
  yield* Console.log("  Archive + restore: soft-delete, audit lookup, restore — OK")

  // --- Cleanup ---
  yield* db.deleteTable()
  yield* Console.log("\nAll 9 patterns passed.")
})

// =============================================================================
// 8. Provide dependencies and run
// =============================================================================

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  TmTable.layer({ name: "taskman-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)

export { program, TmTable, TmSchema, Employees, Tasks, Offices, Employee, Task, Office }
