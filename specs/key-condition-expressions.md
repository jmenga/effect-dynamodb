# Key Condition Expressions — API Specification

> **Status:** Draft
> **Scope:** Entity query accessors, typed sort key conditions, `Query<A>` construction, `scanCollect`/`scanPaginate`, bound entity execution
> **Related:** [Condition & Filter Expressions](./condition-filter-expressions.md) (shared `PathBuilder`, shared callback pattern), [Update Expressions](./update-expressions.md)

## 1. Overview

Key condition expressions narrow query results at the storage layer — DynamoDB reads only matching items, reducing consumed read capacity. They consist of:

- **Partition key condition** — always equality (`=`), mandatory
- **Sort key condition** — optional, one of 7 operators

This spec covers:
1. **Entity query accessors** — `Tasks.query.byProject(...)` namespaced under `.query` on entity definitions
2. **Typed sort key conditions** — callback API consistent with condition/filter expressions
3. **Bound entity execution** — `tasks.collect(query)`, `tasks.paginate(query)`, `tasks.scanCollect()`, `tasks.scanPaginate()`
4. **`Query<A>` as composable data type** — returned by entity accessors, consumed by bound entity terminals

## 2. DynamoDB Grammar Reference

```
keycondition ::=
    partition-key-condition
  | partition-key-condition AND sort-key-condition

partition-key-condition ::=
    pk-name = :value                    -- always equality, mandatory

sort-key-condition ::=
    sk-name = :value                    -- exact match
  | sk-name < :value                    -- less than
  | sk-name <= :value                   -- less than or equal
  | sk-name > :value                    -- greater than
  | sk-name >= :value                   -- greater than or equal
  | sk-name BETWEEN :low AND :high     -- inclusive range
  | begins_with(sk-name, :prefix)      -- prefix match
```

**Key constraints:**
- `KeyConditionExpression` can **only** reference the partition key and sort key of the queried index
- PK condition is always `=` (equality)
- SK condition is optional — omitting it returns all items in the partition
- Unlike `FilterExpression`, key conditions reduce items read from disk (efficient, reduces RCU)
- Only one key condition expression per query

### Composed Sort Keys

In effect-dynamodb, sort keys are **composed** from multiple entity attributes:

```
SK composite: ["status", "createdAt"]
→ Composed value: "$myapp#v1#task#active#2024-03-15T10:00:00Z"
                   ^schema  ^entity ^status ^createdAt
```

The composition includes schema prefix, entity type, and composite attribute values joined by `#` delimiters. Users never see or construct these composed strings directly — the framework handles composition internally.

When partial composites are provided (e.g., only `status` but not `createdAt`), the framework composes a prefix and uses `begins_with`. When an explicit SK operator is requested (e.g., `gte` on `createdAt`), the framework composes up to the boundary composite and applies the operator to the composed string.

## 3. Entity Query Accessors

### 3.1 Query Namespace

Query accessors live under the `.query` namespace on the **entity definition**:

```typescript
Tasks.query.byProject({ projectId: "proj-alpha" })
```

Each non-primary index defined on the entity generates a named accessor under `.query`. The accessor name matches the index name.

The `.query` namespace avoids naming conflicts with other entity definition properties (`filter`, `condition`, `select`, `scan`, `set`, `versions`, `deleted`, etc.).

### 3.2 Accessor Signature

```typescript
Tasks.query.byProject(
  pk: { projectId: string; status?: string; createdAt?: string },
  skCondition?: SkCallback | SkShorthand,
): Query<Task>
```

The first argument accepts **all composites** for the index (PK + SK). PK composites are required. SK composites are optional — providing them narrows the query via `begins_with` on the composed prefix (same as current behavior).

The second argument is an optional sort key condition that overrides the default `begins_with` behavior.

### 3.3 Generated Accessor Mapping

Given:

```typescript
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
      sk: { field: "gsi1sk", composite: ["status", "createdAt"] },
    },
    byAssignee: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["assigneeId"] },
      sk: { field: "gsi2sk", composite: ["priority", "dueDate"] },
    },
  },
})
```

| Index Definition | Query Accessor | PK Argument | SK Composites |
|---|---|---|---|
| `byProject` | `Tasks.query.byProject(...)` | `{ projectId: string }` (required) | `status?: string`, `createdAt?: string` |
| `byAssignee` | `Tasks.query.byAssignee(...)` | `{ assigneeId: string }` (required) | `priority?: string`, `dueDate?: string` |

Primary index does not generate a query accessor — primary key lookups go through `tasks.get(key)`.

### 3.4 Argument Type Generation

The accessor argument type is derived from the index definition:

```typescript
// For byProject: pk.composite = ["projectId"], sk.composite = ["status", "createdAt"]
type ByProjectArg = {
  readonly projectId: string                  // PK composite — required
  readonly status?: string | undefined        // SK composite[0] — optional
  readonly createdAt?: string | undefined     // SK composite[1] — optional
}
```

PK composites are required. SK composites are optional and must be provided **in order** — you can provide `status` alone, or `status` + `createdAt`, but not `createdAt` alone. This mirrors how DynamoDB's `begins_with` works on composed sort keys.

### 3.5 Auto begins_with from SK Composites

When SK composites are provided in the first argument and no explicit SK condition (second argument) is given, the framework auto-applies `begins_with` on the composed prefix:

```typescript
// Only PK — no SK condition
Tasks.query.byProject({ projectId: "proj-alpha" })
// KeyConditionExpression: gsi1pk = :pk

// PK + first SK composite — auto begins_with
Tasks.query.byProject({ projectId: "proj-alpha", status: "active" })
// KeyConditionExpression: gsi1pk = :pk AND begins_with(gsi1sk, :skPrefix)
// where :skPrefix = "$myapp#v1#task#active"

// PK + all SK composites — auto begins_with on full composed value
Tasks.query.byProject({ projectId: "proj-alpha", status: "active", createdAt: "2024-03-15" })
// KeyConditionExpression: gsi1pk = :pk AND begins_with(gsi1sk, :skPrefix)
// where :skPrefix = "$myapp#v1#task#active#2024-03-15"
```

## 4. Sort Key Condition — Callback API

### 4.1 Callback Signature

The optional second argument to a query accessor is a sort key condition, expressed as a callback consistent with the condition/filter API:

```typescript
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
)
```

The callback receives:
1. `sk` — A typed object representing the **remaining** SK composites (those not provided in the first argument)
2. Operations object — SK-specific comparators and `between`/`beginsWith`

### 4.2 SK Path Object

The `sk` parameter provides typed access to the SK composite attributes that were **not** provided in the first argument:

```typescript
// sk.composite = ["status", "createdAt"]
// First arg provides: { status: "active" }
// → sk exposes: { createdAt: Path<string> }

Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
  //                    ^^^^^^^^^^^^^ typed as Path<string>
)
```

If the first argument provides all SK composites, the callback is not needed and its `sk` parameter would be empty.

If the first argument provides no SK composites, `sk` exposes all of them:

```typescript
Tasks.query.byProject(
  { projectId: "proj-alpha" },
  (sk, { beginsWith }) => beginsWith(sk.status, "act"),
)
```

### 4.3 Operations Object

```typescript
interface SkConditionOps {
  eq<V>(path: SkPath<V>, value: V): SkCondition
  lt<V>(path: SkPath<V>, value: V): SkCondition
  lte<V>(path: SkPath<V>, value: V): SkCondition
  gt<V>(path: SkPath<V>, value: V): SkCondition
  gte<V>(path: SkPath<V>, value: V): SkCondition
  between<V>(path: SkPath<V>, low: V, high: V): SkCondition
  beginsWith(path: SkPath<string>, prefix: string): SkCondition
}
```

**Key differences from `ConditionOps`:**
- No `ne`, `in`, `exists`, `notExists`, `type`, `contains`, `size` — DynamoDB only supports 7 operators on sort keys
- No `and`, `or`, `not` — only one SK condition per query
- No attribute-to-attribute comparison — right-hand side is always a literal value
- Returns `SkCondition`, not `Expr` — separate type for sort key conditions

### 4.4 How the Callback Composes with Provided Composites

The provided SK composites form a **prefix**. The callback operator is applied to the **next** composite after the prefix. Internally, the framework:

1. Composes the sort key prefix from provided SK composites (e.g., `status: "active"` → `"$myapp#v1#task#active"`)
2. Appends the callback's value to the prefix with `#` delimiter
3. Applies the operator to the composed string

```typescript
// Index: byProject, sk.composite: ["status", "createdAt"]

// gte on createdAt (status provided in first arg)
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
)
// Internally:
//   prefix = compose("active") → "$myapp#v1#task#active"
//   value  = prefix + "#" + serialize("2024-03-01") → "$myapp#v1#task#active#2024-03-01"
//   KeyConditionExpression: gsi1pk = :pk AND gsi1sk >= :skValue

// between on createdAt
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { between }) => between(sk.createdAt, "2024-01-01", "2024-06-30"),
)
// Internally:
//   lo = prefix + "#" + serialize("2024-01-01")
//   hi = prefix + "#" + serialize("2024-06-30")
//   KeyConditionExpression: gsi1pk = :pk AND gsi1sk BETWEEN :lo AND :hi

// beginsWith on status (no SK composites provided)
Tasks.query.byProject(
  { projectId: "proj-alpha" },
  (sk, { beginsWith }) => beginsWith(sk.status, "act"),
)
// Internally:
//   prefix = entity prefix → "$myapp#v1#task"
//   value  = prefix + "#" + "act"
//   KeyConditionExpression: gsi1pk = :pk AND begins_with(gsi1sk, :skPrefix)

// eq on createdAt (exact match)
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { eq }) => eq(sk.createdAt, "2024-03-15T10:00:00Z"),
)
// KeyConditionExpression: gsi1pk = :pk AND gsi1sk = :skValue
```

### 4.5 Constraint: Callback Operates on the Next Composite Only

The callback can only target the **first unprovided** SK composite. You cannot skip composites:

```typescript
// sk.composite: ["status", "createdAt"]

// ✅ Provide status, condition on createdAt
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { gte }) => gte(sk.createdAt, "2024-01-01"),
)

// ✅ No SK composites provided, condition on status
Tasks.query.byProject(
  { projectId: "proj-alpha" },
  (sk, { beginsWith }) => beginsWith(sk.status, "act"),
)

// ❌ Cannot skip status and condition on createdAt
// (This would not be meaningful — composed SK has status before createdAt)
Tasks.query.byProject(
  { projectId: "proj-alpha" },
  (sk, { gte }) => gte(sk.createdAt, "2024-01-01"),
  //                    ^^^^^^^^^^^^^ Type error: createdAt not in SkPath
  //                    (only sk.status available when status not provided)
)
```

This is enforced at the type level: `sk` only exposes the next unprovided composite.

## 5. Sort Key Condition — Shorthand Syntax

For simple cases, a shorthand object can be used instead of a callback:

```typescript
// Shorthand — operator on the next SK composite
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  { gte: "2024-03-01" },
)

// Equivalent callback
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
)
```

### 5.1 Shorthand Type

```typescript
type SkShorthand =
  | { readonly eq: string | number }
  | { readonly lt: string | number }
  | { readonly lte: string | number }
  | { readonly gt: string | number }
  | { readonly gte: string | number }
  | { readonly between: readonly [string | number, string | number] }
  | { readonly beginsWith: string }
```

The shorthand value is the **serialized composite value** — not the composed SK string. The framework composes the full SK value internally. Exactly one operator must be provided.

### 5.2 Shorthand Limitations

- Operates on the **next unprovided** SK composite (same as callback)
- No type checking on the value — the callback is preferred when type safety matters
- Cannot express conditions on composites deeper than the next one

### 5.3 Discrimination

- Second argument is a function → callback
- Second argument is a plain object → shorthand

## 6. Bound Entity Execution

### 6.1 Query Execution

The bound entity provides two terminals for executing queries:

```typescript
const { Tasks: tasks } = yield* DynamoClient.make(MainTable)

// collect — fetch all pages, return flat array
const results: Array<Task> = yield* tasks.collect(
  Tasks.query.byProject({ projectId: "proj-alpha" }),
  Tasks.filter((t, { eq }) => eq(t.priority, "high")),
  Query.limit(25),
)

// paginate — return Stream for lazy pagination
const stream: Stream<Task> = tasks.paginate(
  Tasks.query.byProject({ projectId: "proj-alpha" }),
  Query.reverse,
)
```

Both accept:
1. A `Query<A>` (from an entity query accessor) as the first argument
2. Variadic query combinators: `Tasks.filter(...)`, `Query.limit(n)`, `Query.reverse`, `Query.consistentRead`, `Query.startFrom(cursor)`, `Query.maxPages(n)`, `Query.project(...)`, `Query.ignoreOwnership`

### 6.2 Scan Execution

Scan operations live directly on the bound entity — no query construction needed:

```typescript
// scanCollect — fetch all pages, return flat array
const all: Array<Task> = yield* tasks.scanCollect(
  Tasks.filter((t, { eq }) => eq(t.status, "active")),
  Query.limit(100),
)

// scanPaginate — return Stream for lazy pagination
const stream: Stream<Task> = tasks.scanPaginate(
  Tasks.filter((t, { gte }) => gte(t.priority, 3)),
  Query.consistentRead,
)
```

Both accept variadic query combinators (same as `collect`/`paginate` minus the `Query<A>` first argument).

Scan automatically filters by `__edd_e__` — in a single-table design, `tasks.scanCollect()` only returns Task items.

### 6.3 Bound Entity Shape

```typescript
interface BoundEntity<E> {
  // --- CRUD ---
  get(key: Entity.Key<E>, ...combinators: GetCombinator[]): Effect<Entity.Record<E>>
  put(input: Entity.Input<E>, ...combinators: WriteCombinator[]): Effect<Entity.Record<E>>
  create(input: Entity.Input<E>, ...combinators: WriteCombinator[]): Effect<Entity.Record<E>>
  upsert(input: Entity.Input<E>, ...combinators: WriteCombinator[]): Effect<Entity.Record<E>>
  update(key: Entity.Key<E>, ...combinators: UpdateCombinator[]): Effect<Entity.Record<E>>
  delete(key: Entity.Key<E>, ...combinators: WriteCombinator[]): Effect<void>
  deleteIfExists(key: Entity.Key<E>, ...combinators: WriteCombinator[]): Effect<void>

  // --- Query execution ---
  collect(query: Query<Entity.Record<E>>, ...combinators: QueryCombinator[]): Effect<Array<Entity.Record<E>>>
  paginate(query: Query<Entity.Record<E>>, ...combinators: QueryCombinator[]): Stream<Entity.Record<E>>

  // --- Scan execution ---
  scanCollect(...combinators: QueryCombinator[]): Effect<Array<Entity.Record<E>>>
  scanPaginate(...combinators: QueryCombinator[]): Stream<Entity.Record<E>>
}
```

### 6.4 When to Use Scan vs Query

| | Query | Scan |
|---|-------|------|
| Targets | Specific partition | Entire table |
| Efficiency | Reads only matching partition | Reads every item |
| Cost | Low (proportional to results) | High (proportional to table size) |
| Use cases | Normal application queries | Admin tools, migrations, data exports, analytics |

## 7. Entity Definition Shape

The entity definition provides query construction and typed combinators:

```typescript
interface EntityDefinition<E> {
  // --- Query namespace (one accessor per non-primary index) ---
  query: {
    byProject(pk: ByProjectArg, skCondition?: SkCallback | SkShorthand): Query<Entity.Record<E>>
    byAssignee(pk: ByAssigneeArg, skCondition?: SkCallback | SkShorthand): Query<Entity.Record<E>>
  }

  // --- Typed combinators ---
  filter(cb: (t: PathBuilder<Model>, ops: ConditionOps) => Expr): QueryCombinator
  filter(shorthand: ConditionShorthand): QueryCombinator
  condition(cb: (t: PathBuilder<Model>, ops: ConditionOps) => Expr): WriteCombinator
  condition(shorthand: ConditionShorthand): WriteCombinator
  set(updates: Entity.Update<E>): UpdateCombinator
  set(pathCb: (t: PathBuilder<Model>) => Path, value: any): UpdateCombinator
  set(exprCb: (t: PathBuilder<Model>, ops: SetOps) => SetExpr): UpdateCombinator
  add(values: Record<string, number | ReadonlySet<any>>): UpdateCombinator
  subtract(values: Record<string, number>): UpdateCombinator
  append(pathCb: (t: PathBuilder<Model>) => Path, ...values: any[]): UpdateCombinator
  prepend(pathCb: (t: PathBuilder<Model>) => Path, ...values: any[]): UpdateCombinator
  remove(fields: ReadonlyArray<string>): UpdateCombinator
  remove(pathCb: (t: PathBuilder<Model>) => Path): UpdateCombinator
  delete(values: Record<string, ReadonlySet<any>>): UpdateCombinator
  ifNotExists(pathCb: (t: PathBuilder<Model>) => Path, fallback: any): UpdateCombinator
  expectedVersion(version: number): UpdateCombinator | WriteCombinator
  consistentRead: GetCombinator
  returnValues(mode: ReturnValuesMode): UpdateCombinator | WriteCombinator
  project(...fields: ReadonlyArray<string>): GetCombinator | QueryCombinator

  // --- Type helpers ---
  Model: Entity.Model<E>
  Record: Entity.Record<E>
  Input: Entity.Input<E>
  Create: Entity.Create<E>
  Update: Entity.Update<E>
  Key: Entity.Key<E>
  Item: Entity.Item<E>
  Marshalled: Entity.Marshalled<E>
}
```

## 8. SkCondition Type

Sort key conditions are a separate type from `Expr` — they represent `KeyConditionExpression` on the sort key, not `ConditionExpression`/`FilterExpression`.

### 8.1 Type Definition

```typescript
type SkCondition =
  | { readonly _tag: "sk:eq"; readonly value: unknown }
  | { readonly _tag: "sk:lt"; readonly value: unknown }
  | { readonly _tag: "sk:lte"; readonly value: unknown }
  | { readonly _tag: "sk:gt"; readonly value: unknown }
  | { readonly _tag: "sk:gte"; readonly value: unknown }
  | { readonly _tag: "sk:between"; readonly low: unknown; readonly high: unknown }
  | { readonly _tag: "sk:beginsWith"; readonly prefix: string }

type SkPath<V> = {
  readonly _tag: "SkPath"
  readonly attribute: string
  readonly _V: (_: never) => V
}
```

### 8.2 Compilation

The `SkCondition` is compiled into a `KeyConditionExpression` fragment on the sort key:

1. Resolve the composed SK prefix from the provided composites in the first argument
2. Compose the callback's value onto the prefix (with `#` delimiter and serialization)
3. Apply the operator

```typescript
// gte(sk.createdAt, "2024-03-01")
// →
// prefix = composeSortKeyPrefix(schema, entityType, version, indexDef, { status: "active" })
// composed = prefix + "#" + serializeValue("2024-03-01")
// KeyConditionExpression: gsi1sk >= :skValue
// ExpressionAttributeValues: { ":skValue": { "S": composed } }
```

For `between`:

```typescript
// between(sk.createdAt, "2024-01-01", "2024-06-30")
// →
// lo = prefix + "#" + serializeValue("2024-01-01")
// hi = prefix + "#" + serializeValue("2024-06-30")
// KeyConditionExpression: gsi1sk BETWEEN :skLo AND :skHi
```

For `beginsWith`:

```typescript
// beginsWith(sk.status, "act")
// →
// prefix = entity sort key base → "$myapp#v1#task"
// composed = prefix + "#" + "act"
// KeyConditionExpression: begins_with(gsi1sk, :skPrefix)
```

## 9. Interaction with Other Combinators

### 9.1 SK Condition + Filter

Sort key conditions and filter expressions serve different purposes and compose naturally:

```typescript
yield* tasks.collect(
  Tasks.query.byProject(
    { projectId: "proj-alpha", status: "active" },
    (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
  ),
  Tasks.filter((t, { eq }) => eq(t.priority, "high")),
  Query.limit(25),
)
// KeyConditionExpression: gsi1pk = :pk AND gsi1sk >= :skValue     ← pre-read, efficient
// FilterExpression: #priority = :v0                                ← post-read
```

### 9.2 SK Condition vs Auto begins_with

If the second argument (SK condition) is provided, it **overrides** the auto `begins_with` that would otherwise be generated from SK composites in the first argument. The provided composites still form the prefix for the condition.

```typescript
// Auto begins_with from composites (no second arg)
Tasks.query.byProject({ projectId: "proj-alpha", status: "active" })
// → begins_with(gsi1sk, "$myapp#v1#task#active")

// Explicit gte overrides auto begins_with
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
)
// → gsi1sk >= "$myapp#v1#task#active#2024-03-01"
```

### 9.3 SK Condition + Reverse + Limit

```typescript
// Most recent tasks first, up to 10
yield* tasks.collect(
  Tasks.query.byProject(
    { projectId: "proj-alpha", status: "active" },
    (sk, { gte }) => gte(sk.createdAt, "2024-01-01"),
  ),
  Query.reverse,
  Query.limit(10),
)
```

### 9.4 SK Condition + Pagination

```typescript
// First page
const page1 = yield* Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  { gte: "2024-01-01" },
).pipe(
  Query.limit(25),
  Query.execute,
)

// Next page
if (page1.cursor) {
  const page2 = yield* Tasks.query.byProject(
    { projectId: "proj-alpha", status: "active" },
    { gte: "2024-01-01" },
  ).pipe(
    Query.limit(25),
    Query.startFrom(page1.cursor),
    Query.execute,
  )
}
```

## 10. Type Safety

### 10.1 PK Composites Required

```typescript
// ✅ projectId is PK composite — required
Tasks.query.byProject({ projectId: "proj-alpha" })

// ❌ Missing required PK composite
Tasks.query.byProject({ status: "active" })
// Type error: Property 'projectId' is missing
```

### 10.2 SK Composites Optional and Ordered

```typescript
// ✅ No SK composites
Tasks.query.byProject({ projectId: "proj-alpha" })

// ✅ First SK composite
Tasks.query.byProject({ projectId: "proj-alpha", status: "active" })

// ✅ All SK composites
Tasks.query.byProject({ projectId: "proj-alpha", status: "active", createdAt: "2024-03-15" })

// ❌ Cannot skip status and provide createdAt
// (Allowed by TypeScript since both are optional, but runtime validation rejects it
//  because composed SK requires left-to-right ordering)
```

Runtime validation: if `createdAt` is provided without `status`, `composeSortKeyPrefix` stops at the first missing composite — `createdAt` is silently ignored. This matches current behavior.

### 10.3 Callback Path Typing

The `sk` parameter only exposes the **next unprovided** SK composite:

```typescript
// sk.composite: ["status", "createdAt"]

// Provide status → sk has createdAt
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),  // ✅
)

// Provide nothing → sk has status
Tasks.query.byProject(
  { projectId: "proj-alpha" },
  (sk, { beginsWith }) => beginsWith(sk.status, "act"),  // ✅
)

// Provide status → sk does NOT have status
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { eq }) => eq(sk.status, "active"),  // ❌ Type error: status not in sk
)
```

### 10.4 Value Type Checking

```typescript
// createdAt is typed as string in the model
Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),  // ✅ string
)

Tasks.query.byProject(
  { projectId: "proj-alpha", status: "active" },
  (sk, { gte }) => gte(sk.createdAt, 42),  // ❌ number ≠ string
)
```

### 10.5 beginsWith Constraint

```typescript
// beginsWith only works on string paths
(sk, { beginsWith }) => beginsWith(sk.status, "act")      // ✅ string
(sk, { beginsWith }) => beginsWith(sk.priority, "hi")     // ❌ if priority is number
```

## 11. Collection Queries

Collection queries are unaffected by this spec. They continue to use their own pattern:

```typescript
const TenantMembers = Collection.make("TenantMembers", {
  employees: Employees,
  tasks: Tasks,
})

// Collection query — returns grouped results
const data = yield* TenantMembers.query({ tenantId: "t-acme" }).pipe(
  Query.execute,
)
// { employees: Employee[], tasks: Task[] }
```

Collection queries may gain typed SK conditions in a future spec.

## 12. Migration from Current API

| Current API | Proposed API | Notes |
|---|---|---|
| `TaskEntity.query.byProject({ projectId })` | `Tasks.query.byProject({ projectId })` | Renamed entity variable |
| `TaskEntity.query.byProject({ projectId, status })` | `Tasks.query.byProject({ projectId, status })` | Same auto `begins_with` |
| `TaskEntity.scan()` | `tasks.scanCollect()` / `tasks.scanPaginate()` | On bound entity |
| `tasks.collect(TaskEntity.query.byProject({...}))` | `tasks.collect(Tasks.query.byProject({...}))` | Renamed entity variable |
| `tasks.paginate(TaskEntity.query.byProject({...}))` | `tasks.paginate(Tasks.query.byProject({...}))` | Renamed entity variable |
| `Query.where({ beginsWith: prefix })` | Auto `begins_with` from SK composites | No manual prefix needed |
| `Query.where({ gte: manualComposed })` | `(sk, { gte }) => gte(sk.attr, value)` | Typed, auto-composed |
| `KeyComposer.composeSortKeyPrefix(...)` + `Query.where(...)` | `(sk, { between }) => between(sk.attr, lo, hi)` | Framework composes internally |
| `Query.filter({ status: "active" })` | `Tasks.filter((t, { eq }) => eq(t.status, "active"))` | Typed (see condition/filter spec) |
| `Query.filter({ status: "active" })` | `Tasks.filter({ status: "active" })` | Shorthand syntax |

### What's Removed

- `Tasks.scan()` — replaced by `tasks.scanCollect()` / `tasks.scanPaginate()` on bound entity
- `Query.where(condition)` — replaced by SK callback/shorthand on query accessors
- Manual `KeyComposer.composeSortKeyPrefix()` calls — framework composes internally

### What's Preserved

- `Query.limit(n)`, `Query.reverse`, `Query.consistentRead`, `Query.startFrom(cursor)`, `Query.maxPages(n)`, `Query.project(...)`, `Query.ignoreOwnership` — unchanged query combinators
- `Query.execute` — pipe terminal for single-page execution (returns `Page<A>`)
- `tasks.collect(query, ...combs)` / `tasks.paginate(query, ...combs)` — bound entity terminals

## 13. Full Example

```typescript
import { Effect, Layer, Stream } from "effect"
import { DynamoSchema, Table, Entity, Query, DynamoClient } from "effect-dynamodb"

// --- Entity definition ---

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  projectId: Schema.String,
  status: Schema.Literal("todo", "active", "done"),
  priority: Schema.Number,
  title: Schema.NonEmptyString,
  createdAt: Schema.String,
  dueDate: Schema.optionalWith(Schema.String, { as: "Option" }),
}) {}

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

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
      sk: { field: "gsi1sk", composite: ["status", "createdAt"] },
    },
    byPriority: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["projectId"] },
      sk: { field: "gsi2sk", composite: ["priority", "dueDate"] },
    },
  },
  timestamps: true,
  versioned: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Tasks } })

// --- Usage ---

const program = Effect.gen(function* () {
  const { Tasks: tasks } = yield* DynamoClient.make(MainTable)

  // --- Basic query (PK only) ---
  const allProjectTasks = yield* tasks.collect(
    Tasks.query.byProject({ projectId: "proj-alpha" }),
  )

  // --- Auto begins_with from SK composites ---
  const activeTasks = yield* tasks.collect(
    Tasks.query.byProject({ projectId: "proj-alpha", status: "active" }),
  )

  // --- Typed SK condition: gte ---
  const recentActive = yield* tasks.collect(
    Tasks.query.byProject(
      { projectId: "proj-alpha", status: "active" },
      (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
    ),
  )

  // --- Typed SK condition: between ---
  const q1Tasks = yield* tasks.collect(
    Tasks.query.byProject(
      { projectId: "proj-alpha", status: "active" },
      (sk, { between }) => between(sk.createdAt, "2024-01-01", "2024-03-31"),
    ),
  )

  // --- SK shorthand ---
  const recentShorthand = yield* tasks.collect(
    Tasks.query.byProject(
      { projectId: "proj-alpha", status: "active" },
      { gte: "2024-03-01" },
    ),
  )

  // --- SK condition + filter + limit + reverse ---
  const topPriority = yield* tasks.collect(
    Tasks.query.byProject(
      { projectId: "proj-alpha", status: "active" },
      (sk, { gte }) => gte(sk.createdAt, "2024-01-01"),
    ),
    Tasks.filter((t, { gte }) => gte(t.priority, 3)),
    Query.reverse,
    Query.limit(10),
  )

  // --- Paginate with SK condition ---
  const stream = tasks.paginate(
    Tasks.query.byProject(
      { projectId: "proj-alpha", status: "active" },
      (sk, { gte }) => gte(sk.createdAt, "2024-01-01"),
    ),
    Query.reverse,
  )
  yield* Stream.runForEach(stream, (task) =>
    Effect.log(`Task: ${task.title}`),
  )

  // --- Single page with cursor ---
  const page1 = yield* Tasks.query.byProject(
    { projectId: "proj-alpha", status: "active" },
  ).pipe(
    Query.limit(25),
    Query.execute,
  )
  // page1.items: Task[], page1.cursor: string | null

  // --- Scan ---
  const allTasks = yield* tasks.scanCollect()

  const activeOnly = yield* tasks.scanCollect(
    Tasks.filter((t, { eq }) => eq(t.status, "active")),
    Query.limit(100),
  )

  const scanStream = tasks.scanPaginate(
    Tasks.filter((t, { gte }) => gte(t.priority, 3)),
  )

  // --- Update with typed combinators ---
  yield* tasks.update(
    { taskId: "t-1" },
    Tasks.set({ status: "done" }),
    Tasks.condition((t, { eq }) => eq(t.status, "active")),
    Tasks.expectedVersion(5),
  )

  // --- Put with condition ---
  yield* tasks.put(
    { taskId: "t-2", projectId: "proj-alpha", status: "todo", priority: 1, title: "New task", createdAt: "2024-03-19" },
    Tasks.condition((t, { notExists }) => notExists(t.taskId)),
  )
})

const main = program.pipe(
  Effect.provide(
    Layer.mergeAll(
      DynamoClient.layer({ region: "us-east-1" }),
      MainTable.layer({ name: "Main" }),
    ),
  ),
)
```

## 14. ElectroDB Comparison

Side-by-side examples showing equivalent operations:

### Basic Query

```typescript
// ElectroDB
const { data } = await Task.query.byProject({ projectId: "proj-alpha" }).go()

// effect-dynamodb
const data = yield* tasks.collect(
  Tasks.query.byProject({ projectId: "proj-alpha" }),
)
```

### Auto begins_with

```typescript
// ElectroDB
const { data } = await Task.query
  .byProject({ projectId: "proj-alpha", status: "active" })
  .go()

// effect-dynamodb
const data = yield* tasks.collect(
  Tasks.query.byProject({ projectId: "proj-alpha", status: "active" }),
)
```

### Explicit SK Operators

```typescript
// ElectroDB — gte
const { data } = await Task.query
  .byProject({ projectId: "proj-alpha", status: "active" })
  .gte({ createdAt: "2024-03-01" })
  .go()

// effect-dynamodb — callback
const data = yield* tasks.collect(
  Tasks.query.byProject(
    { projectId: "proj-alpha", status: "active" },
    (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
  ),
)

// effect-dynamodb — shorthand
const data = yield* tasks.collect(
  Tasks.query.byProject(
    { projectId: "proj-alpha", status: "active" },
    { gte: "2024-03-01" },
  ),
)
```

### Between

```typescript
// ElectroDB
const { data } = await Task.query
  .byProject({ projectId: "proj-alpha", status: "active" })
  .between(
    { createdAt: "2024-01-01" },
    { createdAt: "2024-06-30" },
  )
  .go()

// effect-dynamodb
const data = yield* tasks.collect(
  Tasks.query.byProject(
    { projectId: "proj-alpha", status: "active" },
    (sk, { between }) => between(sk.createdAt, "2024-01-01", "2024-06-30"),
  ),
)
```

### Filter + Sort + Limit

```typescript
// ElectroDB
const { data } = await Task.query
  .byProject({ projectId: "proj-alpha", status: "active" })
  .gte({ createdAt: "2024-03-01" })
  .where(({ priority }, { gte }) => gte(priority, 3))
  .go({ order: "desc", limit: 10 })

// effect-dynamodb
const data = yield* tasks.collect(
  Tasks.query.byProject(
    { projectId: "proj-alpha", status: "active" },
    (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
  ),
  Tasks.filter((t, { gte }) => gte(t.priority, 3)),
  Query.reverse,
  Query.limit(10),
)
```

### Scan

```typescript
// ElectroDB
const { data } = await Task.scan.go()
const { data } = await Task.scan
  .where(({ status }, { eq }) => eq(status, "active"))
  .go()

// effect-dynamodb
const data = yield* tasks.scanCollect()
const data = yield* tasks.scanCollect(
  Tasks.filter((t, { eq }) => eq(t.status, "active")),
)
```
