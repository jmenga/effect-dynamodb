# Queries

This guide covers the pipeable Query API: how to construct queries, apply sort key conditions, filter results, paginate, and execute.

## Query\<A\> — A Composable Data Type

Queries in effect-dynamodb are **data types**, not builders. A `Query<A>` is a pure description of what to fetch — no DynamoDB calls happen until you execute it. This follows Effect TS idioms: queries are testable, inspectable, and composable via `pipe`.

```typescript
import { Query } from "effect-dynamodb"

// Construct a query (no execution yet)
const query = TaskEntity.query.byProject({ projectId: "proj-alpha" })

// Compose with combinators
const composed = query.pipe(
  Query.where({ status: "active" }),
  Query.limit(25),
  Query.reverse,
)

// Execute (crosses into Effect)
const results = yield* composed.pipe(Query.execute)
```

## Entity Queries

The Entity generates query accessors from your Entity's logical index names. The accessor argument type is derived from the index's `pk.composite`.

```typescript
// Primary key lookup (not a query — returns single item)
const task = yield* TaskEntity.get({ taskId: "t-001" })

// Named index queries (return Query<A>)
TaskEntity.query.byProject({ projectId: "proj-alpha" })
TaskEntity.query.byAssignee({ assigneeId: "emp-alice" })
```

### Generated Accessor Mapping

| Index Definition | Accessor | Argument Type |
|------------------|----------|---------------|
| `primary: { pk: { composite: ["taskId"] }, ... }` | `TaskEntity.get(...)` | `{ taskId: string }` |
| `byProject: { pk: { composite: ["projectId"] }, ... }` | `TaskEntity.query.byProject(...)` | `{ projectId: string }` |
| `byAssignee: { pk: { composite: ["assigneeId"] }, ... }` | `TaskEntity.query.byAssignee(...)` | `{ assigneeId: string }` |

## Sort Key Conditions with `Query.where`

`Query.where` maps to DynamoDB's `KeyConditionExpression`. It filters using the sort key composites, which is efficient (reduces items read from the index).

```typescript
// Index: byProject, sk.composite: ["status", "createdAt"]

// Exact match on leading composite
TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
  Query.where({ status: "active" }),
  Query.execute,
)

// Range on trailing composite
TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
  Query.where({ status: "active", createdAt: { gte: lastWeek } }),
  Query.execute,
)

// Between range
TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
  Query.where({ status: "active", createdAt: { between: [startDate, endDate] } }),
  Query.execute,
)
```

### Sort Key Filter Rules

For an index with `sk: { composite: ["status", "createdAt"] }`:

```typescript
type FilterType = {
  status?: string                          // leading: equality only
  createdAt?: SortKeyCondition<DateTime>   // trailing: range operators
}
```

| Position | Supported Operations |
|----------|---------------------|
| Leading composites | Equality only |
| Trailing (last) composite | Equality, `gte`, `lte`, `between`, `beginsWith` |

This mirrors DynamoDB's `KeyConditionExpression` semantics — leading composites must be exact matches, and only the final position supports range operators.

### SortKeyCondition Type

```typescript
type SortKeyCondition<T> =
  | T                           // exact equality
  | { gte: T }                  // >=
  | { lte: T }                  // <=
  | { between: [T, T] }        // inclusive range
  | { beginsWith: string }     // prefix match (strings only)
```

## Post-Query Filtering with `Query.filter`

`Query.filter` maps to DynamoDB's `FilterExpression`. Unlike `Query.where`, it does **not** reduce the items read from the index — it filters after reading. Use it for conditions on non-key attributes.

```typescript
TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
  Query.where({ status: "active" }),
  Query.filter({ priority: "high" }),
  Query.execute,
)
```

**When to use `where` vs `filter`:**

| Combinator | DynamoDB Mapping | Reduces Read Capacity? | Use For |
|------------|------------------|----------------------|---------|
| `Query.where` | `KeyConditionExpression` | Yes | Sort key composites |
| `Query.filter` | `FilterExpression` | No | Non-key attributes |

## Collection Queries

Collection queries return all member entity types, grouped by entity name.

```typescript
import { Collection } from "effect-dynamodb"

const TenantMembers = Collection.make("TenantMembers", {
  employees: EmployeeEntity,
  tasks: TaskEntity,
})

// All entities in the collection
const all = yield* TenantMembers.query({ tenantId: "t-acme" }).pipe(
  Query.execute,
)
// { employees: Employee[], tasks: Task[] }
```

### Entity Selectors

Narrow a collection query to a single entity type using typed selectors:

```typescript
// Only employees
const employees = yield* TenantMembers.query({ tenantId: "t-acme" }).pipe(
  TenantMembers.employees,
  Query.execute,
)
// Employee[]

// Only employees hired recently
const recent = yield* TenantMembers.query({ tenantId: "t-acme" }).pipe(
  TenantMembers.employees,
  Query.where({ hireDate: { gte: lastMonth } }),
  Query.execute,
)
// Employee[]
```

### Sub-Collection Queries

Query at different depths of the collection hierarchy:

```typescript
// All contributions (Employee + Task + ProjectMember)
yield* Contributions.query({ employeeId: "emp-alice" }).pipe(Query.execute)
// { employees: Employee[], tasks: Task[], projectMembers: ProjectMember[] }

// Only assignments (Task + ProjectMember) — sub-collection
yield* Assignments.query({ employeeId: "emp-alice" }).pipe(Query.execute)
// { tasks: Task[], projectMembers: ProjectMember[] }

// Tasks from assignments, filtered by project
yield* Assignments.query({ employeeId: "emp-alice" }).pipe(
  Assignments.tasks,
  Query.where({ projectId: "proj-alpha" }),
  Query.execute,
)
// Task[]
```

## Pagination

### Single Page

`Query.execute` returns all matching items (up to the `limit`):

```typescript
const first25 = yield* TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
  Query.limit(25),
  Query.execute,
)
// Task[] (up to 25 items)
```

### Streaming

`Query.paginate` returns an Effect that produces a `Stream`, automatically handling DynamoDB pagination:

```typescript
const stream = yield* TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
  Query.paginate,
)
// Stream<Task>

// Collect all
const all = yield* Stream.runCollect(stream)

// Process in chunks
yield* stream.pipe(
  Stream.grouped(100),
  Stream.runForEach((chunk) =>
    Effect.log(`Processing ${chunk.length} tasks`)
  ),
)
```

## Scan

`Entity.scan()` reads the entire table (or index) and returns items matching the entity type. It returns a `Query<Entity.Record>`, so all Query combinators and terminals work with scans.

```typescript
// Basic scan — all items of this entity type
const allTasks = yield* TaskEntity.scan().pipe(Query.execute)

// Scan with filter
const activeTasks = yield* TaskEntity.scan().pipe(
  Query.filter({ status: "active" }),
  Query.execute,
)

// Scan with limit
const firstPage = yield* TaskEntity.scan().pipe(
  Query.limit(25),
  Query.execute,
)

// Scan with consistent read
const consistent = yield* TaskEntity.scan().pipe(
  Query.consistentRead,
  Query.execute,
)

// Stream-based scan
const stream = yield* TaskEntity.scan().pipe(Query.paginate)
yield* Stream.runForEach(stream, (task) =>
  Effect.log(`Task: ${task.title}`)
)
```

**When to use Scan vs Query:**

| | Query | Scan |
|---|-------|------|
| Targets | Specific partition | Entire table |
| Efficiency | Reads only matching partition | Reads every item |
| Cost | Low (proportional to results) | High (proportional to table size) |
| Use cases | Normal application queries | Admin tools, migrations, data exports, analytics |

Scan automatically filters by `__edd_e__` — even in a single-table design, `Products.scan()` only returns Product items.

## Consistent Reads

By default, DynamoDB reads are eventually consistent. For strong consistency, use `consistentRead`:

```typescript
// Consistent read on get
const task = yield* TaskEntity.get({ taskId: "t-001" }).pipe(
  Entity.consistentRead,
)

// Consistent read on query
const tasks = yield* TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
  Query.consistentRead,
  Query.execute,
)

// Consistent read on scan
const all = yield* TaskEntity.scan().pipe(
  Query.consistentRead,
  Query.execute,
)
```

Consistent reads cost 2x the read capacity of eventually-consistent reads. Use them when you need read-after-write consistency (e.g., immediately after a put or update).

## Ordering

By default, results are in ascending sort key order. Use `Query.reverse` for descending:

```typescript
// Most recent tasks first
const recent = yield* TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
  Query.reverse,
  Query.limit(10),
  Query.execute,
)
```

## Complete Example

```typescript
import { Effect, Layer, Stream } from "effect"
import { Collection, Query, DynamoClient } from "effect-dynamodb"

const program = Effect.gen(function* () {
  // --- Single entity query with sort key condition ---
  const activeTasks = yield* TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
    Query.where({ status: "active" }),
    Query.limit(50),
    Query.execute,
  )

  // --- Single entity query, reversed, with filter ---
  const recentHighPriority = yield* TaskEntity.query.byAssignee({ assigneeId: "emp-alice" }).pipe(
    Query.where({ priority: "high" }),
    Query.filter({ title: { contains: "API" } }),
    Query.reverse,
    Query.limit(10),
    Query.execute,
  )

  // --- Collection query: all tenant members ---
  const allMembers = yield* TenantMembers.query({ tenantId: "t-acme" }).pipe(
    Query.execute,
  )
  // { employees: Employee[], tasks: Task[] }

  // --- Collection query: narrow to employees, stream ---
  const employeeStream = yield* TenantMembers.query({ tenantId: "t-acme" }).pipe(
    TenantMembers.employees,
    Query.where({ department: "Engineering" }),
    Query.paginate,
  )
  yield* Stream.runForEach(employeeStream, (emp) =>
    Effect.log(`Employee: ${emp.displayName}`)
  )
})

const main = program.pipe(
  Effect.provide(
    Layer.mergeAll(
      DynamoClient.layer({ region: "us-east-1" }),
      MainTable.layer({ name: "Main" }),
    )
  )
)
```

## What's Next?

- [Data Integrity](./data-integrity.md) — Unique constraints, versioning, and optimistic concurrency
- [Lifecycle](./lifecycle.md) — Soft delete, restore, purge, and version retention
- [Advanced](./advanced.md) — DynamoDB Streams, testing patterns
