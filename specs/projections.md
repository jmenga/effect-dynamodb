# Projections — API Specification

> **Status:** Draft
> **Scope:** `Tasks.select()` combinator, `PathBuilder` key tracking, `DeepPick` return type, `ProjectionExpression` compilation
> **Related:** [Update Expressions](./update-expressions.md) (shared `PathBuilder`), [Condition & Filter Expressions](./condition-filter-expressions.md) (shared `PathBuilder`), [Key Condition Expressions](./key-condition-expressions.md) (query execution)

## 1. Overview

Projections select specific attributes to return from DynamoDB operations, reducing read capacity and network transfer. DynamoDB supports projecting top-level attributes, nested map paths, and list elements — all using the same document path syntax as update and condition expressions.

effect-dynamodb exposes projections as a single entity-level combinator:

```typescript
Tasks.select((t) => [t.title, t.status, t.address.city])
```

The combinator:
- Uses `PathBuilder<Model>` for type-safe attribute selection (same proxy as updates/conditions)
- Supports nested map paths and list element selection
- **Narrows the return type** to only the selected attributes via `DeepPick`
- Works on gets, queries, and scans

## 2. DynamoDB Grammar Reference

```
ProjectionExpression ::= path [, path] ...

path ::=
    attribute                     -- top-level attribute
  | attribute.nested              -- nested map attribute (dot notation)
  | attribute[N]                  -- list element (bracket notation)
  | attribute[N].nested           -- nested within list element
  | attribute.nested[N]           -- list within nested map
```

All attribute names should use `ExpressionAttributeNames` (`#pN` aliases) to handle reserved words.

### Behavior

- **Read capacity**: DynamoDB reads the full item from disk regardless of projection. RCU is based on item size, not projected size. Projection reduces **network transfer** only.
- **1MB page limit**: Applies to full items before projection.
- **Missing attributes**: If a projected attribute doesn't exist on an item, it is simply omitted from the result (no error).
- **Key attributes**: Partition key and sort key are always returned, even if not included in the projection.

## 3. Callback API

### 3.1 Signature

```typescript
Tasks.select(
  callback: (t: PathBuilder<Model>) => ReadonlyArray<Path<Model, any, any>>
): SelectCombinator<Model, SelectedKeys>
```

The callback receives `t` — the same `PathBuilder<Model>` proxy used by update and condition expressions. It returns an array of `Path` objects representing the attributes to project.

### 3.2 Examples

```typescript
// Top-level fields
Tasks.select((t) => [t.title, t.status])

// Nested map path
Tasks.select((t) => [t.title, t.address.city])

// List element
Tasks.select((t) => [t.title, t.relatedItems.at(0)])

// Nested within list element
Tasks.select((t) => [t.title, t.roster.at(0).name])

// Mixed
Tasks.select((t) => [t.title, t.address.city, t.tags.at(0), t.roster.at(0).role])
```

### 3.3 Shorthand — String Array

For top-level-only projections, a string array shorthand is supported:

```typescript
Tasks.select(["title", "status", "priority"])
```

**Discrimination:** first argument is function → callback, array → shorthand.

**Shorthand limitations:**
- Top-level attributes only — no nested paths or list elements
- No type narrowing on attribute names (string array, not type-checked at compile time)
- Return type narrows to `Pick<Model, K>` based on the string literals

Prefer the callback for nested paths and full type safety.

### 3.4 Shorthand Type

```typescript
type SelectShorthand<Model> = ReadonlyArray<keyof Model & string>
```

When using the shorthand, TypeScript can infer the literal types:

```typescript
// Inferred as readonly ["title", "status"]
Tasks.select(["title", "status"] as const)
// Return: Pick<Task, "title" | "status"> = { title: string; status: string }
```

Without `as const`, the type is `string[]` and no narrowing occurs — falls back to full `Model` type.

## 4. Return Type Narrowing

### 4.1 Enhanced Path Type

The `Path` type is extended with a `Keys` tuple to track the property path at the type level:

```typescript
interface Path<Root, Value, Keys extends readonly PropertyKey[] = readonly string[]> {
  readonly _tag: "Path"
  readonly segments: ReadonlyArray<string | number>
  // Phantom types
  readonly _Root: (_: never) => Root
  readonly _Value: (_: never) => Value
  readonly _Keys: Keys
}
```

`Keys` is a tuple of string literal types representing the path from root to the selected attribute:

| Expression | Keys |
|---|---|
| `t.name` | `["name"]` |
| `t.address.city` | `["address", "city"]` |
| `t.roster.at(0)` | `["roster"]` |
| `t.roster.at(0).name` | `["roster", "name"]` |
| `t.config.features.darkMode` | `["config", "features", "darkMode"]` |

Array indices (`.at(n)`) are **not** included in `Keys` — they are runtime values, not type-level. The path stops at the array attribute or continues into the element's properties.

### 4.2 Enhanced PathBuilder Type

`PathBuilder` carries the root type and accumulated keys:

```typescript
type PathBuilder<Root, Model = Root, Keys extends readonly string[] = readonly []> = {
  [K in keyof Model & string]-?: Model[K] extends ReadonlyArray<infer E>
    ? ArrayPath<Root, E, [...Keys, K]>
    : Model[K] extends Record<string, unknown>
      ? PathBuilder<Root, Model[K], [...Keys, K]> & Path<Root, Model[K], [...Keys, K]>
      : Path<Root, Model[K], [...Keys, K]>
}

type ArrayPath<Root, Element, Keys extends readonly string[]> =
  Path<Root, ReadonlyArray<Element>, Keys> & {
    at(index: number): Element extends Record<string, unknown>
      ? PathBuilder<Root, Element, Keys> & Path<Root, Element, Keys>
      : Path<Root, Element, Keys>
  }
```

Note: `.at(n)` preserves the parent `Keys` — the array attribute is already in the path. Accessing properties on the element appends to `Keys` from there.

### 4.3 DeepPick

`DeepPick` constructs a type containing only the selected nested path:

```typescript
type DeepPick<T, Keys extends readonly PropertyKey[]> =
  Keys extends readonly [infer K extends keyof T, ...infer Rest extends readonly PropertyKey[]]
    ? Rest extends readonly []
      ? Pick<T, K>
      : { readonly [P in K]: DeepPick<T[P], Rest> }
    : never
```

Examples:

```typescript
DeepPick<Team, ["name"]>
// → { name: string }

DeepPick<Team, ["address", "city"]>
// → { address: { city: string } }

DeepPick<Team, ["config", "features", "darkMode"]>
// → { config: { features: { darkMode: boolean } } }
```

### 4.4 Projected Return Type

The `select` combinator's return type is the intersection of `DeepPick` for each path:

```typescript
type ProjectedType<Root, Paths extends ReadonlyArray<Path<Root, any, any>>> =
  UnionToIntersection<{
    [I in keyof Paths]: Paths[I] extends Path<Root, any, infer K extends readonly string[]>
      ? DeepPick<Root, K>
      : never
  }[number]>
```

Examples:

```typescript
Tasks.select((t) => [t.title, t.status])
// ProjectedType = DeepPick<Task, ["title"]> & DeepPick<Task, ["status"]>
//               = { title: string } & { status: string }
//               = { title: string; status: string }

Tasks.select((t) => [t.title, t.address.city])
// ProjectedType = { title: string } & { address: { city: string } }
//               = { title: string; address: { city: string } }

Tasks.select((t) => [t.title, t.tags.at(0)])
// ProjectedType = { title: string } & { tags: string[] }
//               = { title: string; tags: string[] }

Tasks.select((t) => [t.title, t.roster.at(0).name])
// ProjectedType = { title: string } & { roster: { name: string }[] }
//               = { title: string; roster: { name: string }[] }
```

### 4.5 Array Element Projection

When projecting a list element (`t.tags.at(0)`), the return type includes the **full array type** for that attribute. DynamoDB returns the element within its parent array structure, and narrowing to a single-element tuple isn't meaningful — the consumer accesses it as an array.

```typescript
Tasks.select((t) => [t.tags.at(0)])
// Return: { tags: string[] }
// DynamoDB returns: { "tags": ["value-at-index-0"] }

Tasks.select((t) => [t.roster.at(0).name])
// Return: { roster: { name: string }[] }
// DynamoDB returns: { "roster": [{ "name": "Alice" }] }
```

### 4.6 Type Inference in Practice

For the callback to infer literal tuple types for `Keys`, TypeScript needs to see the array as a tuple. The PathBuilder proxy produces `Path` objects with specific `Keys` tuples at each property access, so the array returned from the callback is naturally inferred as a tuple:

```typescript
// TypeScript infers this as:
// [Path<Task, string, ["title"]>, Path<Task, string, ["address", "city"]>]
(t) => [t.title, t.address.city]
```

No `as const` needed — the `Path` types carry distinct `Keys` tuples that TypeScript preserves in the array literal.

## 5. Application

### 5.1 On Get Operations

`Tasks.select()` works as a get combinator, narrowing the return type:

```typescript
const { Tasks: tasks } = yield* DynamoClient.make(MainTable)

// Without select — full model type
const task = yield* tasks.get({ taskId: "t-1" })
// task: Task (full record with system fields)

// With select — narrowed type
const partial = yield* tasks.get(
  { taskId: "t-1" },
  Tasks.select((t) => [t.title, t.status]),
)
// partial: { title: string; status: string }
```

### 5.2 On Query Operations

`Tasks.select()` works as a query combinator, narrowing the element type of the result array:

```typescript
// Without select
const results = yield* tasks.collect(
  Tasks.byProject({ projectId: "proj-alpha" }),
)
// results: Array<Task>

// With select
const results = yield* tasks.collect(
  Tasks.byProject({ projectId: "proj-alpha" }),
  Tasks.select((t) => [t.title, t.priority, t.address.city]),
  Query.limit(25),
)
// results: Array<{ title: string; priority: number; address: { city: string } }>
```

### 5.3 On Scan Operations

```typescript
const results = yield* tasks.scanCollect(
  Tasks.select((t) => [t.title, t.status]),
)
// results: Array<{ title: string; status: string }>

const stream = tasks.scanPaginate(
  Tasks.select((t) => [t.title, t.status]),
)
// stream: Stream<{ title: string; status: string }>
```

### 5.4 On Paginate Operations

```typescript
const stream = tasks.paginate(
  Tasks.byProject({ projectId: "proj-alpha" }),
  Tasks.select((t) => [t.title, t.status]),
)
// stream: Stream<{ title: string; status: string }>
```

### 5.5 On Single-Page Query Execution

```typescript
const page = yield* Tasks.byProject({ projectId: "proj-alpha" }).pipe(
  Tasks.select((t) => [t.title, t.status]),
  Query.limit(25),
  Query.execute,
)
// page.items: Array<{ title: string; status: string }>
// page.cursor: string | null
```

### 5.6 Shorthand on Get

```typescript
const partial = yield* tasks.get(
  { taskId: "t-1" },
  Tasks.select(["title", "status"] as const),
)
// partial: { title: string; status: string }
```

## 6. Composition with Other Combinators

### 6.1 Select + Filter

```typescript
yield* tasks.collect(
  Tasks.byProject({ projectId: "proj-alpha" }),
  Tasks.filter((t, { eq }) => eq(t.status, "active")),
  Tasks.select((t) => [t.title, t.priority]),
  Query.limit(25),
)
// Filter applies to full items (pre-projection)
// Select narrows what DynamoDB returns (post-filter)
// Result: Array<{ title: string; priority: number }>
```

Note: `Tasks.filter()` can reference attributes not in the `select` projection — DynamoDB evaluates `FilterExpression` on the full item before applying `ProjectionExpression`.

### 6.2 Select + SK Condition

```typescript
yield* tasks.collect(
  Tasks.byProject(
    { projectId: "proj-alpha", status: "active" },
    (sk, { gte }) => gte(sk.createdAt, "2024-03-01"),
  ),
  Tasks.select((t) => [t.title, t.priority]),
)
// Result: Array<{ title: string; priority: number }>
```

### 6.3 Select + Consistent Read

```typescript
yield* tasks.get(
  { taskId: "t-1" },
  Tasks.select((t) => [t.title]),
  Tasks.consistentRead,
)
// Result: { title: string }
```

### 6.4 Select Does Not Affect Conditions or Filters

Projection is the last step — conditions, filters, and SK conditions can reference any attribute regardless of what is selected:

```typescript
yield* tasks.collect(
  Tasks.byProject({ projectId: "proj-alpha" }),
  Tasks.filter((t, { eq }) => eq(t.status, "active")),      // status not in select
  Tasks.select((t) => [t.title]),                             // only title projected
)
// DynamoDB: FilterExpression uses status, ProjectionExpression returns title
// Result: Array<{ title: string }>
```

## 7. Expression Compilation

### 7.1 Compiler Input

`Tasks.select()` produces an array of `Path` objects. The compiler converts them to a `ProjectionExpression` string with `ExpressionAttributeNames`.

### 7.2 Compilation Rules

Each `Path`'s `segments` compile to DynamoDB document path notation using the same rules as update and condition expressions:

- String segment `"field"` → `#pN` with `ExpressionAttributeNames["#pN"] = "field"`
- Number segment `N` → `[N]` (literal, no name alias)

Multiple paths are comma-separated.

### 7.3 Examples

| Select Expression | Segments | ProjectionExpression | Names |
|---|---|---|---|
| `t.title` | `["title"]` | `#p0` | `{ "#p0": "title" }` |
| `t.title, t.status` | `["title"]`, `["status"]` | `#p0, #p1` | `{ "#p0": "title", "#p1": "status" }` |
| `t.address.city` | `["address", "city"]` | `#p0.#p1` | `{ "#p0": "address", "#p1": "city" }` |
| `t.tags.at(0)` | `["tags", 0]` | `#p0[0]` | `{ "#p0": "tags" }` |
| `t.roster.at(0).name` | `["roster", 0, "name"]` | `#p0[0].#p1` | `{ "#p0": "roster", "#p1": "name" }` |
| `t.title, t.address.city, t.tags.at(0)` | `["title"]`, `["address", "city"]`, `["tags", 0]` | `#p0, #p1.#p2, #p3[0]` | `{ "#p0": "title", "#p1": "address", "#p2": "city", "#p3": "tags" }` |

### 7.4 Name Merging

When `Tasks.select()` is used alongside `Tasks.filter()` or `Tasks.condition()`, the `ExpressionAttributeNames` from all expressions are merged into a single map. The compiler uses a shared counter to ensure unique placeholder keys across all expressions in the same operation.

### 7.5 Field Name Resolution

Top-level string segments pass through `resolveDbName()` to support `DynamoModel.configure(Model, { field: { field: "dbName" } })` renaming. Same behavior as update and condition expressions.

## 8. Schema Decode Bypass

When a `select` combinator is active, the result **bypasses entity schema decode**. Projected items may be partial — they cannot be reliably decoded through the full entity schema (required fields may be missing).

Instead, the result is:
1. Unmarshalled from DynamoDB `AttributeValue` format via `@aws-sdk/util-dynamodb`
2. Typed as the `DeepPick` intersection (compile-time safety)
3. **Not** validated against the entity schema at runtime

This matches the current behavior (`Entity.project` and `Query.select` both skip schema decode) but with a typed result instead of `Record<string, unknown>`.

## 9. Type Safety

### 9.1 Attribute Name Validation

The callback ensures only valid attribute names are accessible:

```typescript
Tasks.select((t) => [t.title, t.status])     // ✅ valid attributes
Tasks.select((t) => [t.title, t.foo])         // ❌ 'foo' does not exist on Task
Tasks.select((t) => [t.address.city])         // ✅ valid nested path
Tasks.select((t) => [t.address.foo])          // ❌ 'foo' does not exist on Address
```

### 9.2 Return Type Accuracy

```typescript
const result = yield* tasks.get(
  { taskId: "t-1" },
  Tasks.select((t) => [t.title, t.priority]),
)
result.title     // ✅ string
result.priority  // ✅ number
result.status    // ❌ Property 'status' does not exist
```

### 9.3 Shorthand Type Safety

```typescript
Tasks.select(["title", "status"] as const)        // ✅ valid attribute names
Tasks.select(["title", "nonexistent"] as const)    // ❌ 'nonexistent' not in keyof Task
```

Without `as const`:

```typescript
Tasks.select(["title", "status"])
// Type: string[] — no narrowing, return type is full Model
```

## 10. Migration from Current API

| Current API | Proposed API | Notes |
|---|---|---|
| `Entity.project(["name", "email"])` on EntityGet | `Tasks.select((t) => [t.name, t.email])` | Typed, nested paths |
| `Entity.project(["name", "email"])` on EntityGet | `Tasks.select(["name", "email"] as const)` | Shorthand equivalent |
| `Query.select(["name", "email"])` on Query | `Tasks.select((t) => [t.name, t.email])` | Unified combinator |
| `Projection.projection(["name"])` (low-level) | Preserved for raw `DynamoClient` use | Not replaced |
| Return: `Record<string, unknown>` | Return: `{ name: string; email: string }` | Type-narrowed |
| No nested path support | `Tasks.select((t) => [t.address.city])` | Full DynamoDB path syntax |
| No list element support | `Tasks.select((t) => [t.tags.at(0)])` | List element projection |

### What's Removed

- `Entity.project(attributes)` — replaced by `Tasks.select()` as a get/query/scan combinator
- `Query.select(attributes)` — replaced by `Tasks.select()` as a unified combinator

### What's Preserved

- `Projection.projection(attributes)` — low-level builder for raw `DynamoClient.getItem()` / `DynamoClient.query()` use. Not entity-aware.

## 11. Full Example

```typescript
import { Effect, Layer, Stream } from "effect"
import { DynamoSchema, Table, Entity, Query, DynamoClient } from "effect-dynamodb"

class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String,
  name: Schema.NonEmptyString,
  email: Schema.String,
  department: Schema.String,
  salary: Schema.Number,
  title: Schema.String,
  address: Schema.Struct({
    city: Schema.String,
    country: Schema.String,
    zip: Schema.String,
  }),
  skills: Schema.Array(Schema.String),
  projects: Schema.Array(Schema.Struct({
    name: Schema.String,
    role: Schema.String,
    active: Schema.Boolean,
  })),
}) {}

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

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

const program = Effect.gen(function* () {
  const { Employees: employees } = yield* DynamoClient.make(MainTable)

  // --- Get with top-level projection ---
  const nameAndEmail = yield* employees.get(
    { employeeId: "e-1" },
    Employees.select((t) => [t.name, t.email]),
  )
  // nameAndEmail: { name: string; email: string }

  // --- Get with nested projection ---
  const nameAndCity = yield* employees.get(
    { employeeId: "e-1" },
    Employees.select((t) => [t.name, t.address.city]),
  )
  // nameAndCity: { name: string; address: { city: string } }

  // --- Get with list element projection ---
  const firstSkill = yield* employees.get(
    { employeeId: "e-1" },
    Employees.select((t) => [t.name, t.skills.at(0)]),
  )
  // firstSkill: { name: string; skills: string[] }

  // --- Get with nested list element projection ---
  const firstProject = yield* employees.get(
    { employeeId: "e-1" },
    Employees.select((t) => [t.name, t.projects.at(0).name, t.projects.at(0).role]),
  )
  // firstProject: { name: string; projects: { name: string; role: string }[] }

  // --- Query with projection + filter ---
  const directory = yield* employees.collect(
    Employees.byDepartment({ department: "engineering" }),
    Employees.filter((t, { gte }) => gte(t.salary, 100000)),
    Employees.select((t) => [t.name, t.title, t.email]),
  )
  // directory: Array<{ name: string; title: string; email: string }>

  // --- Query with projection + SK condition ---
  const specific = yield* employees.collect(
    Employees.byDepartment(
      { department: "engineering" },
      (sk, { gte }) => gte(sk.employeeId, "e-100"),
    ),
    Employees.select((t) => [t.name, t.address.city]),
    Query.limit(10),
  )
  // specific: Array<{ name: string; address: { city: string } }>

  // --- Scan with projection ---
  const allNames = yield* employees.scanCollect(
    Employees.select((t) => [t.name, t.department]),
  )
  // allNames: Array<{ name: string; department: string }>

  // --- Paginate with projection ---
  const stream = employees.paginate(
    Employees.byDepartment({ department: "engineering" }),
    Employees.select((t) => [t.name, t.email]),
  )
  // stream: Stream<{ name: string; email: string }>

  yield* Stream.runForEach(stream, (emp) =>
    Effect.log(`${emp.name}: ${emp.email}`),
  )

  // --- Shorthand (top-level only) ---
  const quick = yield* employees.get(
    { employeeId: "e-1" },
    Employees.select(["name", "email"] as const),
  )
  // quick: { name: string; email: string }

  // --- Mixed projections in a real workflow ---
  // Dashboard: fetch minimal data for a summary table
  const summaryStream = employees.scanPaginate(
    Employees.select((t) => [t.name, t.department, t.title, t.address.city]),
  )
  // Stream<{ name: string; department: string; title: string; address: { city: string } }>

  yield* Stream.runForEach(summaryStream, (emp) =>
    Effect.log(`${emp.name} (${emp.department}) — ${emp.title}, ${emp.address.city}`),
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

## 12. ElectroDB Comparison

| Aspect | ElectroDB | effect-dynamodb |
|--------|-----------|-----------------|
| API | `.go({ attributes: ["name", "email"] })` | `Tasks.select((t) => [t.name, t.email])` |
| Nested paths | Not supported (root only since v1.11.0) | Full DynamoDB path syntax |
| List elements | Not supported | `t.tags.at(0)`, `t.roster.at(0).name` |
| Return type | Full `EntityItem<E>` (no narrowing) | `DeepPick` intersection (narrowed) |
| Type safety | String array, no attribute name checking | PathBuilder — compile-time attribute validation |
| Naming | `attributes` execution option | `Tasks.select()` entity-level combinator |
| Unified API | Same option on get and query | Same combinator on get, query, scan |
