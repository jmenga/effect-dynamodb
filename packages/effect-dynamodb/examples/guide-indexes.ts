/**
 * Indexes Guide — effect-dynamodb
 *
 * Demonstrates every index pattern from the Indexes guide:
 *   - Primary key definitions on entities
 *   - Key generation (composite keys, empty composites)
 *   - Entity-level indexes for GSI access patterns
 *   - Logical query accessors via entity indexes
 *   - Isolated collections
 *   - Clustered collections
 *   - Sub-collections (clustered only)
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
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
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
// 3. Entity definitions — primary keys only
// =============================================================================

// #region task-entity
const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byProject: {
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["projectId"],
      sk: ["priority"],
    },
    byAssignee: {
      index: { name: "gsi2", pk: "gsi2pk", sk: "gsi2sk" },
      composite: ["assigneeId"],
      sk: ["priority"],
    },
  },
  timestamps: true,
})
// #endregion

// #region task-collections

// #endregion

// #region isolated-entities
const IsolatedEmployees = Entity.make({
  model: Employee,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employeeId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    departmentStaff: {
      collection: "departmentStaff",
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["department"],
      sk: ["hireDate"],
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
  primaryKey: {
    pk: { field: "pk", composite: ["equipmentId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    departmentStaff: {
      collection: "departmentStaff",
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["department"],
      sk: ["purchaseDate"],
    },
  },
  timestamps: true,
})
// #endregion

// #region isolated-collection
// #endregion

// #region clustered-entities
const ClusteredEmployees = Entity.make({
  model: Employee,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employeeId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    tenantMembers: {
      collection: "tenantMembers",
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      type: "clustered",
      composite: ["tenantId"],
      sk: ["department", "hireDate"],
    },
  },
  timestamps: true,
})

const ClusteredTasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    tenantMembers: {
      collection: "tenantMembers",
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      type: "clustered",
      composite: ["tenantId"],
      sk: ["projectId", "taskId"],
    },
  },
  timestamps: true,
})
// #endregion

// #region clustered-collection
// #endregion

// #region subcollection-entities
const SubEmployee = Entity.make({
  model: Employee,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employeeId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    contributions: {
      collection: "contributions",
      index: { name: "gsi2", pk: "gsi2pk", sk: "gsi2sk" },
      type: "clustered",
      composite: ["employeeId"],
      sk: ["department"],
    },
  },
  timestamps: true,
})

const SubTasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    assignments: {
      collection: "assignments",
      index: { name: "gsi2", pk: "gsi2pk", sk: "gsi2sk" },
      type: "clustered",
      composite: ["employeeId"],
      sk: ["projectId", "taskId"],
    },
  },
  timestamps: true,
})

const SubProjectMembers = Entity.make({
  model: ProjectMember,
  entityType: "ProjectMember",
  primaryKey: {
    pk: { field: "pk", composite: ["employeeId", "projectId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    assignments: {
      collection: "assignments",
      index: { name: "gsi2", pk: "gsi2pk", sk: "gsi2sk" },
      type: "clustered",
      composite: ["employeeId"],
      sk: ["projectId"],
    },
  },
  timestamps: true,
})
// #endregion

// #region subcollection-collections

// #endregion

// =============================================================================
// 4. Collection definitions (combined region for docs)
// =============================================================================

// #region collection-make
// (See individual collection definitions above:
//   DepartmentStaff, TenantMembers, Contributions, Assignments)
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
  const basic = yield* DynamoClient.make({
    entities: { Tasks },
  })
  yield* basic.tables["guide-indexes-basic"]!.create()
  // #endregion

  // #region basic-seed
  yield* basic.entities.Tasks.put({
    taskId: "t-001",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-alice",
    title: "Write API spec",
    priority: 1,
  })

  yield* basic.entities.Tasks.put({
    taskId: "t-002",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-bob",
    title: "Design database",
    priority: 2,
  })

  yield* basic.entities.Tasks.put({
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
  const alphaTasks = yield* basic.entities.Tasks.byProject({ projectId: "proj-alpha" }).collect()

  const aliceTasks = yield* basic.entities.Tasks.byAssignee({ assigneeId: "emp-alice" }).collect()
  // #endregion

  assertEq(alphaTasks.length, 2, "proj-alpha has 2 tasks")
  assertEq(aliceTasks.length, 2, "alice has 2 tasks")
  yield* Console.log(`  byProject (proj-alpha): ${alphaTasks.length} tasks`)
  yield* Console.log(`  byAssignee (emp-alice): ${aliceTasks.length} tasks`)

  yield* basic.tables["guide-indexes-basic"]!.delete()
  yield* Console.log("  Basic index demo — OK\n")

  // -------------------------------------------------------------------------
  // Part B: Isolated collections
  // -------------------------------------------------------------------------

  yield* Console.log("=== Part B: Isolated Collections ===\n")

  // #region isolated-setup
  const isolated = yield* DynamoClient.make({
    entities: { IsolatedEmployees, Equipments },
  })
  yield* isolated.tables["guide-indexes-isolated"]!.create()

  yield* isolated.entities.IsolatedEmployees.put({
    employeeId: "emp-alice",
    tenantId: "t-acme",
    email: "alice@acme.com",
    name: "Alice",
    department: "engineering",
    hireDate: "2020-01-15",
  })

  yield* isolated.entities.IsolatedEmployees.put({
    employeeId: "emp-bob",
    tenantId: "t-acme",
    email: "bob@acme.com",
    name: "Bob",
    department: "engineering",
    hireDate: "2023-06-01",
  })

  yield* isolated.entities.Equipments.put({
    equipmentId: "eq-laptop-1",
    department: "engineering",
    name: "MacBook Pro",
    purchaseDate: "2023-01-10",
  })

  yield* isolated.entities.Equipments.put({
    equipmentId: "eq-monitor-1",
    department: "engineering",
    name: "Dell UltraSharp",
    purchaseDate: "2023-03-15",
  })
  // #endregion

  // #region isolated-queries
  // Collection query — returns grouped results by member
  const { employees: engEmployees, equipments: engEquipment } = yield* isolated.collections
    .DepartmentStaff!({ department: "engineering" }).collect()
  // #endregion

  assertEq(engEmployees.length, 2, "engineering has 2 employees")
  assertEq(engEquipment.length, 2, "engineering has 2 equipment items")
  yield* Console.log(`  Employees in engineering: ${engEmployees.length}`)
  yield* Console.log(`  Equipment in engineering: ${engEquipment.length}`)

  yield* isolated.tables["guide-indexes-isolated"]!.delete()
  yield* Console.log("  Isolated collection demo — OK\n")

  // -------------------------------------------------------------------------
  // Part C: Clustered collections
  // -------------------------------------------------------------------------

  yield* Console.log("=== Part C: Clustered Collections ===\n")

  // #region clustered-setup
  const clustered = yield* DynamoClient.make({
    entities: { ClusteredEmployees, ClusteredTasks },
  })
  yield* clustered.tables["guide-indexes-clustered"]!.create()

  yield* clustered.entities.ClusteredEmployees.put({
    employeeId: "emp-alice",
    tenantId: "t-acme",
    email: "alice@acme.com",
    name: "Alice",
    department: "engineering",
    hireDate: "2024-01-15",
  })

  yield* clustered.entities.ClusteredEmployees.put({
    employeeId: "emp-bob",
    tenantId: "t-acme",
    email: "bob@acme.com",
    name: "Bob",
    department: "sales",
    hireDate: "2023-06-01",
  })

  yield* clustered.entities.ClusteredTasks.put({
    taskId: "t-001",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-alice",
    title: "Write API spec",
    priority: 1,
  })

  yield* clustered.entities.ClusteredTasks.put({
    taskId: "t-002",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-bob",
    title: "Design database",
    priority: 2,
  })
  // #endregion

  // #region clustered-queries
  // Cross-entity collection query — returns both entity types grouped
  const { employees: acmeEmployees, tasks: acmeTasks } = yield* clustered.collections
    .TenantMembers!({ tenantId: "t-acme" }).collect()
  // #endregion

  assertEq(acmeEmployees.length, 2, "t-acme has 2 employees")
  assertEq(acmeTasks.length, 2, "t-acme has 2 tasks")
  yield* Console.log(`  Employees in t-acme: ${acmeEmployees.length}`)
  yield* Console.log(`  Tasks in t-acme: ${acmeTasks.length}`)

  yield* clustered.tables["guide-indexes-clustered"]!.delete()
  yield* Console.log("  Clustered collection demo — OK\n")

  // -------------------------------------------------------------------------
  // Part D: Sub-collections
  // -------------------------------------------------------------------------

  yield* Console.log("=== Part D: Sub-Collections ===\n")

  // #region subcollection-setup
  const sub = yield* DynamoClient.make({
    entities: { SubEmployee, SubTasks, SubProjectMembers },
  })
  yield* sub.tables["guide-indexes-subcollection"]!.create()

  yield* sub.entities.SubEmployee.put({
    employeeId: "emp-alice",
    tenantId: "t-acme",
    email: "alice@acme.com",
    name: "Alice",
    department: "engineering",
    hireDate: "2024-01-15",
  })

  yield* sub.entities.SubTasks.put({
    taskId: "t-001",
    tenantId: "t-acme",
    projectId: "proj-alpha",
    assigneeId: "emp-alice",
    title: "Write API spec",
    priority: 1,
  })

  yield* sub.entities.SubTasks.put({
    taskId: "t-002",
    tenantId: "t-acme",
    projectId: "proj-beta",
    assigneeId: "emp-alice",
    title: "Design database",
    priority: 2,
  })

  yield* sub.entities.SubProjectMembers.put({
    employeeId: "emp-alice",
    projectId: "proj-alpha",
    role: "lead",
  })
  // #endregion

  // #region subcollection-queries
  // Top-level collection: everything for an employee
  const { employees: allContributions } = yield* sub.collections.Contributions!({
    employeeId: "emp-alice",
  }).collect()

  // Sub-collection: only assignments (tasks + project members)
  const { tasks: assignedTasks, projectMembers: projectMemberships } = yield* sub.collections
    .Assignments!({ employeeId: "emp-alice" }).collect()
  // #endregion

  assertEq(allContributions.length, 1, "contributions has 1 employee record")
  assertEq(assignedTasks.length, 2, "assignments has 2 tasks")
  assertEq(projectMemberships.length, 1, "assignments has 1 project member")
  yield* Console.log(`  Contributions (employees): ${allContributions.length}`)
  yield* Console.log(`  Assignments (tasks): ${assignedTasks.length}`)
  yield* Console.log(`  Assignments (project members): ${projectMemberships.length}`)

  yield* sub.tables["guide-indexes-subcollection"]!.delete()
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
