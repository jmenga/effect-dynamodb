/**
 * Indexes & Collections Guide — effect-dynamodb
 *
 * Demonstrates every index pattern from the Indexes & Collections guide:
 *   - Primary index and GSI definitions
 *   - Key generation (composite keys, empty composites)
 *   - Logical query accessors
 *   - Isolated collections
 *   - Clustered collections
 *   - Sub-collections (clustered only)
 *   - Collection.make() and entity selectors
 *   - Worked example: multi-tenant project management
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-indexes.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as Collection from "../src/Collection.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// =============================================================================
// Helpers
// =============================================================================

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

// =============================================================================
// 1. Pure domain models
// =============================================================================

// #region models
class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String,
  tenantId: Schema.String,
  email: Schema.String,
  name: Schema.String,
  department: Schema.String,
  hireDate: Schema.String,
}) {}

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  tenantId: Schema.String,
  projectId: Schema.String,
  assigneeId: Schema.String,
  title: Schema.String,
  priority: Schema.Number,
}) {}

class ProjectMember extends Schema.Class<ProjectMember>("ProjectMember")({
  employeeId: Schema.String,
  projectId: Schema.String,
  role: Schema.String,
}) {}
// #endregion

// =============================================================================
// 2. Application namespace
// =============================================================================

// #region schema
const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
// #endregion

// =============================================================================
// 3. Entity definitions — primary + GSI indexes
// =============================================================================

// #region task-entity
const Tasks = Entity.make({
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
      sk: { field: "gsi1sk", composite: ["priority"] },
    },
    byAssignee: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["assigneeId"] },
      sk: { field: "gsi2sk", composite: ["priority"] },
    },
  },
  timestamps: true,
})
// #endregion

// #region isolated-entities
const IsolatedEmployees = Entity.make({
  model: Employee,
  entityType: "Employee",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["employeeId"] },
      sk: { field: "sk", composite: [] },
    },
    byDepartment: {
      index: "gsi1",
      collection: "DepartmentStaff",
      type: "isolated",
      pk: { field: "gsi1pk", composite: ["department"] },
      sk: { field: "gsi1sk", composite: ["hireDate"] },
    },
  },
  timestamps: true,
})

class Equipment extends Schema.Class<Equipment>("Equipment")({
  equipmentId: Schema.String,
  department: Schema.String,
  name: Schema.String,
  purchaseDate: Schema.String,
}) {}

const Equipments = Entity.make({
  model: Equipment,
  entityType: "Equipment",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["equipmentId"] },
      sk: { field: "sk", composite: [] },
    },
    byDepartment: {
      index: "gsi1",
      collection: "DepartmentStaff",
      type: "isolated",
      pk: { field: "gsi1pk", composite: ["department"] },
      sk: { field: "gsi1sk", composite: ["purchaseDate"] },
    },
  },
  timestamps: true,
})
// #endregion

// #region clustered-entities
const ClusteredEmployees = Entity.make({
  model: Employee,
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
  },
  timestamps: true,
})

const ClusteredTasks = Entity.make({
  model: Task,
  entityType: "Task",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
    byTenant: {
      index: "gsi1",
      collection: "TenantMembers",
      type: "clustered",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["projectId", "taskId"] },
    },
  },
  timestamps: true,
})
// #endregion

// #region subcollection-entities
const SubEmployee = Entity.make({
  model: Employee,
  entityType: "Employee",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["employeeId"] },
      sk: { field: "sk", composite: [] },
    },
    byEmployee: {
      index: "gsi2",
      collection: "contributions",
      type: "clustered",
      pk: { field: "gsi2pk", composite: ["employeeId"] },
      sk: { field: "gsi2sk", composite: ["department"] },
    },
  },
  timestamps: true,
})

const SubTasks = Entity.make({
  model: Task,
  entityType: "Task",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
    byAssignee: {
      index: "gsi2",
      collection: ["contributions", "assignments"],
      type: "clustered",
      pk: { field: "gsi2pk", composite: ["assigneeId"] },
      sk: { field: "gsi2sk", composite: ["projectId", "taskId"] },
    },
  },
  timestamps: true,
})

const SubProjectMembers = Entity.make({
  model: ProjectMember,
  entityType: "ProjectMember",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["employeeId", "projectId"] },
      sk: { field: "sk", composite: [] },
    },
    byMember: {
      index: "gsi2",
      collection: ["contributions", "assignments"],
      type: "clustered",
      pk: { field: "gsi2pk", composite: ["employeeId"] },
      sk: { field: "gsi2sk", composite: ["projectId"] },
    },
  },
  timestamps: true,
})
// #endregion

// =============================================================================
// 4. Collection definitions
// =============================================================================

// #region collection-make
const DepartmentStaff = Collection.make("DepartmentStaff", {
  employees: IsolatedEmployees,
  equipments: Equipments,
})

const TenantMembers = Collection.make("TenantMembers", {
  employees: ClusteredEmployees,
  tasks: ClusteredTasks,
})

const Contributions = Collection.make("contributions", {
  employees: SubEmployee,
  tasks: SubTasks,
  projectMembers: SubProjectMembers,
})

const Assignments = Collection.make("assignments", {
  tasks: SubTasks,
  projectMembers: SubProjectMembers,
})
// #endregion

// =============================================================================
// 5. Tables — one per demo section
// =============================================================================

// #region tables
const BasicTable = Table.make({
  schema: AppSchema,
  entities: { Tasks },
})

const IsolatedTable = Table.make({
  schema: AppSchema,
  entities: { IsolatedEmployees, Equipments },
})

const ClusteredTable = Table.make({
  schema: AppSchema,
  entities: { ClusteredEmployees, ClusteredTasks },
})

const SubCollectionTable = Table.make({
  schema: AppSchema,
  entities: { SubEmployee, SubTasks, SubProjectMembers },
})
// #endregion

// =============================================================================
// 6. Main program
// =============================================================================

const program = Effect.gen(function* () {
  // -------------------------------------------------------------------------
  // Part A: Primary index + GSI queries
  // -------------------------------------------------------------------------

  yield* Console.log("=== Part A: Primary + GSI Indexes ===\n")

  // #region basic-setup
  const basic = yield* DynamoClient.make(BasicTable)
  yield* basic.createTable()
  // #endregion

  // #region basic-seed
  yield* basic.Tasks.put({
    taskId: "t-001",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-alice",
    title: "Write API spec",
    priority: 1,
  })

  yield* basic.Tasks.put({
    taskId: "t-002",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-bob",
    title: "Design database",
    priority: 2,
  })

  yield* basic.Tasks.put({
    taskId: "t-003",
    tenantId: "t-acme",
    projectId: "proj-beta",
    assigneeId: "emp-alice",
    title: "Build dashboard",
    priority: 1,
  })
  // #endregion

  // #region query-accessors
  // Logical names become query accessors — no physical index names in code
  const alphaTasks = yield* basic.Tasks.collect(Tasks.query.byProject({ projectId: "proj-alpha" }))

  const aliceTasks = yield* basic.Tasks.collect(Tasks.query.byAssignee({ assigneeId: "emp-alice" }))
  // #endregion

  assertEq(alphaTasks.length, 2, "proj-alpha has 2 tasks")
  assertEq(aliceTasks.length, 2, "alice has 2 tasks")
  yield* Console.log(`  byProject (proj-alpha): ${alphaTasks.length} tasks`)
  yield* Console.log(`  byAssignee (emp-alice): ${aliceTasks.length} tasks`)

  yield* basic.deleteTable()
  yield* Console.log("  Basic index demo — OK\n")

  // -------------------------------------------------------------------------
  // Part B: Isolated collections
  // -------------------------------------------------------------------------

  yield* Console.log("=== Part B: Isolated Collections ===\n")

  // #region isolated-setup
  const isolated = yield* DynamoClient.make(IsolatedTable)
  yield* isolated.createTable()

  yield* isolated.IsolatedEmployees.put({
    employeeId: "emp-alice",
    tenantId: "t-acme",
    email: "alice@acme.com",
    name: "Alice",
    department: "engineering",
    hireDate: "2020-01-15",
  })

  yield* isolated.IsolatedEmployees.put({
    employeeId: "emp-bob",
    tenantId: "t-acme",
    email: "bob@acme.com",
    name: "Bob",
    department: "engineering",
    hireDate: "2023-06-01",
  })

  yield* isolated.Equipments.put({
    equipmentId: "eq-laptop-1",
    department: "engineering",
    name: "MacBook Pro",
    purchaseDate: "2023-01-10",
  })

  yield* isolated.Equipments.put({
    equipmentId: "eq-monitor-1",
    department: "engineering",
    name: "Dell UltraSharp",
    purchaseDate: "2023-03-15",
  })
  // #endregion

  // #region isolated-queries
  // Entity-scoped queries — each entity owns its sort key prefix
  const engEmployees = yield* isolated.IsolatedEmployees.collect(
    IsolatedEmployees.query.byDepartment({ department: "engineering" }),
  )

  const engEquipment = yield* isolated.Equipments.collect(
    Equipments.query.byDepartment({ department: "engineering" }),
  )

  // Collection query via entity selectors
  const deptEmployees = yield* Query.collect(
    DepartmentStaff.employees({ department: "engineering" }),
  )

  const deptEquipment = yield* Query.collect(
    DepartmentStaff.equipments({ department: "engineering" }),
  )
  // #endregion

  assertEq(engEmployees.length, 2, "engineering has 2 employees")
  assertEq(engEquipment.length, 2, "engineering has 2 equipment items")
  assertEq(deptEmployees.length, 2, "dept selector returns 2 employees")
  assertEq(deptEquipment.length, 2, "dept selector returns 2 equipment items")
  yield* Console.log(`  Employees in engineering: ${engEmployees.length}`)
  yield* Console.log(`  Equipment in engineering: ${engEquipment.length}`)
  yield* Console.log(`  Collection selector (employees): ${deptEmployees.length}`)
  yield* Console.log(`  Collection selector (equipment): ${deptEquipment.length}`)

  yield* isolated.deleteTable()
  yield* Console.log("  Isolated collection demo — OK\n")

  // -------------------------------------------------------------------------
  // Part C: Clustered collections
  // -------------------------------------------------------------------------

  yield* Console.log("=== Part C: Clustered Collections ===\n")

  // #region clustered-setup
  const clustered = yield* DynamoClient.make(ClusteredTable)
  yield* clustered.createTable()

  yield* clustered.ClusteredEmployees.put({
    employeeId: "emp-alice",
    tenantId: "t-acme",
    email: "alice@acme.com",
    name: "Alice",
    department: "engineering",
    hireDate: "2024-01-15",
  })

  yield* clustered.ClusteredEmployees.put({
    employeeId: "emp-bob",
    tenantId: "t-acme",
    email: "bob@acme.com",
    name: "Bob",
    department: "sales",
    hireDate: "2023-06-01",
  })

  yield* clustered.ClusteredTasks.put({
    taskId: "t-001",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-alice",
    title: "Write API spec",
    priority: 1,
  })

  yield* clustered.ClusteredTasks.put({
    taskId: "t-002",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-bob",
    title: "Design database",
    priority: 2,
  })
  // #endregion

  // #region clustered-queries
  // Entity-scoped queries within the clustered collection
  const acmeEmployees = yield* clustered.ClusteredEmployees.collect(
    ClusteredEmployees.query.byTenant({ tenantId: "t-acme" }),
  )

  const acmeTasks = yield* clustered.ClusteredTasks.collect(
    ClusteredTasks.query.byTenant({ tenantId: "t-acme" }),
  )

  // Cross-entity collection queries
  const allTenantEmployees = yield* Query.collect(TenantMembers.employees({ tenantId: "t-acme" }))

  const allTenantTasks = yield* Query.collect(TenantMembers.tasks({ tenantId: "t-acme" }))
  // #endregion

  assertEq(acmeEmployees.length, 2, "t-acme has 2 employees")
  assertEq(acmeTasks.length, 2, "t-acme has 2 tasks")
  assertEq(allTenantEmployees.length, 2, "collection employees = 2")
  assertEq(allTenantTasks.length, 2, "collection tasks = 2")
  yield* Console.log(`  Employees in t-acme: ${acmeEmployees.length}`)
  yield* Console.log(`  Tasks in t-acme: ${acmeTasks.length}`)
  yield* Console.log(`  Collection (employees): ${allTenantEmployees.length}`)
  yield* Console.log(`  Collection (tasks): ${allTenantTasks.length}`)

  yield* clustered.deleteTable()
  yield* Console.log("  Clustered collection demo — OK\n")

  // -------------------------------------------------------------------------
  // Part D: Sub-collections
  // -------------------------------------------------------------------------

  yield* Console.log("=== Part D: Sub-Collections ===\n")

  // #region subcollection-setup
  const sub = yield* DynamoClient.make(SubCollectionTable)
  yield* sub.createTable()

  yield* sub.SubEmployee.put({
    employeeId: "emp-alice",
    tenantId: "t-acme",
    email: "alice@acme.com",
    name: "Alice",
    department: "engineering",
    hireDate: "2024-01-15",
  })

  yield* sub.SubTasks.put({
    taskId: "t-001",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-alice",
    title: "Write API spec",
    priority: 1,
  })

  yield* sub.SubTasks.put({
    taskId: "t-002",
    tenantId: "t-acme",
    projectId: "proj-beta",
    assigneeId: "emp-alice",
    title: "Design database",
    priority: 2,
  })

  yield* sub.SubProjectMembers.put({
    employeeId: "emp-alice",
    projectId: "proj-alpha",
    role: "lead",
  })
  // #endregion

  // #region subcollection-queries
  // Top-level collection: everything for an employee
  const allContributions = yield* Query.collect(
    Contributions.employees({ employeeId: "emp-alice" }),
  )

  // Sub-collection: only assignments (tasks + project members)
  const assignedTasks = yield* Query.collect(Assignments.tasks({ employeeId: "emp-alice" }))

  const projectMemberships = yield* Query.collect(
    Assignments.projectMembers({ employeeId: "emp-alice" }),
  )
  // #endregion

  assertEq(allContributions.length, 1, "contributions has 1 employee record")
  assertEq(assignedTasks.length, 2, "assignments has 2 tasks")
  assertEq(projectMemberships.length, 1, "assignments has 1 project member")
  yield* Console.log(`  Contributions (employees): ${allContributions.length}`)
  yield* Console.log(`  Assignments (tasks): ${assignedTasks.length}`)
  yield* Console.log(`  Assignments (project members): ${projectMemberships.length}`)

  yield* sub.deleteTable()
  yield* Console.log("  Sub-collection demo — OK\n")

  yield* Console.log("All index & collection patterns passed.")
})

// =============================================================================
// 7. Layer + run
// =============================================================================

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  BasicTable.layer({ name: "guide-indexes-basic" }),
  IsolatedTable.layer({ name: "guide-indexes-isolated" }),
  ClusteredTable.layer({ name: "guide-indexes-clustered" }),
  SubCollectionTable.layer({ name: "guide-indexes-subcollection" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
