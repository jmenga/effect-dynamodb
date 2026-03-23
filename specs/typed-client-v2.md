# Typed Client — API Specification

> **Status:** Draft
> **Scope:** Entity-centric client, BoundQuery builder, explicit Collections.make(), multi-table support, table management, LSP diagnostics
> **Related:** [Key Condition Expressions](./key-condition-expressions.md), [Condition & Filter Expressions](./condition-filter-expressions.md), [Projections](./projections.md)

## 1. Overview

The typed client is the primary consumer-facing API. `DynamoClient.make()` accepts entities and collections, resolves their underlying tables, and returns a namespaced client where all operations have `R = never`.

### 1.1 Design Principles

| Principle | Rationale |
|---|---|
| Entity = model + primary key | Entities are pure domain objects; no GSI awareness |
| Collections = all access patterns | Every GSI is defined once in `Collections.make()`, single or multi-entity |
| Builder pattern for queries | Reads naturally, type-safe through method chaining, no `asEffect()` needed |
| Tables resolved, not specified | Each entity knows its table via `Table.make()` registration |
| Fail-fast validation | `Collections.make()` validates composite attributes at definition time |

### 1.2 Architecture

```
┌─────────────────────────────────────┐
│  DynamoClient.make(config)          │  ← typed gateway (binds all members, R = never)
├─────────────────────────────────────┤
│  Collections.make()                 │  ← ALL access patterns (GSI indexes)
├─────────────────────────────────────┤
│  Entity.make()                      │  ← domain model + primary key + CRUD
├─────────────────────────────────────┤
│  Table.make()                       │  ← physical table definition (schema + entities)
├─────────────────────────────────────┤
│  DynamoClient (raw service)         │  ← raw AWS SDK operations
└─────────────────────────────────────┘
```

## 2. Collections.make()

### 2.1 Motivation

Collections define **all GSI-based access patterns**. A collection owns the index definition — the GSI name, PK field, PK composites, and SK field — and each member entity specifies only its own SK composites.

A collection can have one member (entity-specific access pattern) or multiple members (cross-entity access pattern). This means entities only define their primary key, and all secondary index definitions live in `Collections.make()`.

This provides:
- **Single source of truth** — each GSI is defined once, not duplicated across entities
- **Structural compatibility by construction** — shared PK/SK fields are guaranteed to match
- **Explicit access patterns** — every query path is intentionally declared, analogous to how `Aggregate.make()` declares graph relationships
- **Entity purity** — entities are domain models with a primary key, nothing more

### 2.2 API

```typescript
const Assignments = Collections.make("assignments", {
  index: "gsi3",
  pk: { field: "gsi3pk", composite: ["employee"] },
  sk: { field: "gsi3sk" },
  members: {
    Employees: Collections.member(Employees, { sk: { composite: [] } }),
    Tasks: Collections.member(Tasks, { sk: { composite: ["project", "task"] } }),
  },
})
```

**Parameters:**
- `name` — Collection name (used as SK prefix in clustered mode)
- `config.index` — Physical GSI name (e.g., `"gsi3"`)
- `config.pk` — PK field and composite attributes (shared by all members)
- `config.sk` — SK field (shared by all members)
- `config.type` — `"clustered"` (default) or `"isolated"` — controls SK prefix ordering
- `config.members` — Named record mapping member names to `Collections.member()` declarations

**`Collections.member(entity, { sk: { composite } })`** binds an entity to this collection and specifies the entity's SK composites within this index. Each entity has its own SK composites — only the GSI, PK, and SK field are shared.

### 2.3 Collection Types

The `type` option controls what goes **first** in the sort key prefix. This single choice determines how items are physically ordered within a partition, which in turn determines which queries can use efficient `begins_with` matching versus full-partition reads with post-read filtering.

#### How SK Prefix Ordering Works

DynamoDB stores items sorted by sort key. A `begins_with` query reads only the contiguous range of items matching the prefix — it never touches items outside that range. The prefix ordering therefore determines which query patterns are cheap (prefix match → read only matching items) versus expensive (full partition read → filter out non-matching items).

The `type` option controls the first segment of the SK prefix:

| Type | SK prefix structure | First segment |
|---|---|---|
| `"clustered"` | `collection#entity#composites` | Collection name |
| `"isolated"` | `entity#composites` | Entity type |

#### Clustered (default)

The collection name is the first SK segment. All entities in the collection are grouped together, interleaved by their individual sort order.

```
GSI3 PK: employee = "dfinlay"
┌────────────────────────────────────────────────────────────────┐
│ SK: $hr#v1#assignments#employee#...              ← Employee   │ ← collection prefix
│ SK: $hr#v1#assignments#task#feeding#feed-cats    ← Task       │    groups all entities
│ SK: $hr#v1#assignments#task#onboarding#orient    ← Task       │    together
└────────────────────────────────────────────────────────────────┘
```

**Collection query** — `begins_with(sk, "$hr#v1#assignments")`:
Matches the collection prefix → reads only collection items → **efficient**.

**Entity query** — `begins_with(sk, "$hr#v1#assignments#task")`:
Matches the collection + entity prefix → reads only that entity's items → **efficient** (slightly longer prefix than isolated).

**Choose clustered when:** The collection query is the primary access pattern. Example: "Show me an employee and all their assigned tasks" — both entity types are almost always loaded together.

#### Isolated

The entity type is the first SK segment. Items of the same entity type are physically contiguous — they form an unbroken range in the sort order.

```
GSI3 PK: employee = "dfinlay"
┌────────────────────────────────────────────────────────────────┐
│ SK: $hr#v1#employee#...                          ← Employee   │ ← entity type groups
│                                                               │    items by type
│ SK: $hr#v1#task#feeding#feed-cats                ← Task       │
│ SK: $hr#v1#task#onboarding#orient                ← Task       │
└────────────────────────────────────────────────────────────────┘
```

**Entity query** — `begins_with(sk, "$hr#v1#task")`:
Matches the entity prefix → reads a contiguous block of just that entity's items → **maximally efficient**.

**Collection query** — no shared prefix exists, so the query reads the entire partition and filters by `__edd_e__` entity type:
PK match only + `FilterExpression` → reads **all** items, discards non-members → **less efficient** (consumes RCU for every item in the partition, not just members).

**Choose isolated when:** Entity-level queries are the dominant access pattern (>90% of reads). The collection query is secondary — used occasionally for admin dashboards or batch operations. Also preferred when entity distribution is highly uneven (e.g., 1 config item vs thousands of telemetry records — a clustered collection query pays for the config item prefix even when you only want telemetry).

#### Summary

| | Clustered | Isolated |
|---|---|---|
| SK prefix | `collection#entity#composites` | `entity#composites` |
| Collection query | `begins_with` on collection — efficient | Full partition + filter — expensive |
| Entity query | `begins_with` on collection#entity — efficient | `begins_with` on entity — maximally efficient |
| Best for | Cross-entity reads are primary | Single-entity reads are primary |
| Trade-off | Slightly longer entity prefix | Collection query reads entire partition |

#### Scoped Queries via Multiple Isolated Collections

Multiple isolated collections can share the same GSI with different member sets. This provides scoped queries without sub-collection complexity:

```typescript
// Broad scope — everything about a manager's reports
const ManagerView = Collections.make("managerView", {
  type: "isolated",
  index: "gsi2",
  pk: { field: "gsi2pk", composite: ["manager"] },
  sk: { field: "gsi2sk" },
  members: {
    Employees: Collections.member(Employees, { sk: { composite: [] } }),
    Tasks: Collections.member(Tasks, { sk: { composite: ["projectId"] } }),
    TimeEntries: Collections.member(TimeEntries, { sk: { composite: ["date", "entryId"] } }),
    PeerReviews: Collections.member(PeerReviews, { sk: { composite: ["reviewDate"] } }),
  },
})

// Narrow scope — just assignments
const ManagerAssignments = Collections.make("managerAssignments", {
  type: "isolated",
  index: "gsi2",
  pk: { field: "gsi2pk", composite: ["manager"] },
  sk: { field: "gsi2sk" },
  members: {
    Tasks: Collections.member(Tasks, { sk: { composite: ["projectId"] } }),
  },
})
```

```typescript
// Annual review — everything
const all = yield* db.collections.ManagerView({ manager: "jlowe" }).collect()
// { Employees, Tasks, TimeEntries, PeerReviews }

// Daily standup — just tasks
const { Tasks } = yield* db.collections.ManagerAssignments({ manager: "jlowe" }).collect()
```

This replaces the need for sub-collections (which ElectroDB requires due to its one-index-per-entity constraint). Since `Collections.make()` owns the index definition, an entity can participate in multiple collections on the same GSI without conflict.

| Choose | When |
|---|---|
| Clustered | Collection query is the primary read. Entities always loaded together. Roughly even distribution. |
| Isolated | Entity-level queries dominate. Collection query is secondary. Highly uneven distribution. |
| Multiple isolated (same GSI) | Different consumers need different entity subsets from the same partition. |

### 2.4 Entity Definitions — Primary Key Only

Entities define their domain model and primary key. All GSI definitions live in `Collections.make()`:

```typescript
// Entity — model + primary key, no GSIs
const Employees = Entity.make({
  model: Employee,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employee"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  softDelete: true,
})

const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["task"] },
    sk: { field: "sk", composite: ["project", "employee"] },
  },
  timestamps: true,
})

// ALL access patterns as collections (single-member = entity query, multi-member = cross-entity query)
const Assignments = Collections.make("assignments", {
  index: "gsi3",
  pk: { field: "gsi3pk", composite: ["employee"] },
  sk: { field: "gsi3sk" },
  members: {
    Employees: Collections.member(Employees, { sk: { composite: [] } }),
    Tasks: Collections.member(Tasks, { sk: { composite: ["project", "task"] } }),
  },
})

const TasksByProject = Collections.make("tasksByProject", {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["project"] },
  sk: { field: "gsi1sk" },
  members: {
    Tasks: Collections.member(Tasks, { sk: { composite: ["employee", "task"] } }),
  },
})

const EmployeesByRole = Collections.make("employeesByRole", {
  index: "gsi4",
  pk: { field: "gsi4pk", composite: ["title"] },
  sk: { field: "gsi4sk" },
  members: {
    Employees: Collections.member(Employees, { sk: { composite: ["salary", "employee"] } }),
  },
})
```

At `DynamoClient.make()` time, each collection's index definition is injected into its member entities for key composition on writes.

### 2.5 Validation

`Collections.make()` validates at definition time:

| Check | Error |
|---|---|
| At least one member | `"Collection 'assignments' requires at least 1 member"` |
| No duplicate entity types | `"Entity type 'Task' appears in multiple members"` |
| PK composite attributes exist on entity model | `"Attribute 'employee' not found on Employee model"` |
| SK composite attributes exist on entity model | `"Attribute 'project' not found on Task model"` |
| Member SK composites are compatible with shared SK field | `"SK composite 'projectId' type mismatch"` |

Structural compatibility (same GSI, same PK field, same SK field) is guaranteed by construction — there's only one definition. No cross-entity validation needed for these properties.

Single-member collections are valid — they define an entity-specific access pattern (equivalent to a GSI index on one entity). Multi-member collections define cross-entity access patterns.

### 2.6 Cross-Table Collections

Members can belong to different tables. Each table has its own physical GSI, but the collection ensures compatible PK composites:

```typescript
const ManagementTable = Table.make({ schema, entities: { DeviceMetadata } })
const TelemetryTable = Table.make({ schema, entities: { DeviceTelemetry } })

const DeviceStatus = Collections.make("deviceStatus", {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["deviceId"] },
  sk: { field: "gsi1sk" },
  members: {
    DeviceMetadata: Collections.member(DeviceMetadata, { sk: { composite: [] } }),
    DeviceTelemetry: Collections.member(DeviceTelemetry, { sk: { composite: ["timestamp", "readingId"] } }),
  },
})
```

At query time, the collection executor queries each table in parallel (`Effect.all` with unbounded concurrency) and merges the grouped results. The physical GSI name may differ between tables — the collection's `index` name is mapped to each table's physical GSI independently.

### 2.7 Entity Query Accessors from Collections

When a collection is registered on the client, each member entity also gets a query accessor for that index. The accessor name is the member key from `Collections.make()`:

```typescript
// Collection registration gives Employees and Tasks accessors on gsi3
const db = yield* DynamoClient.make({
  entities: { Employees, Tasks },
  collections: { Assignments },
})

// Collection query — all entity types
const { Employees, Tasks } = yield* db.collections.Assignments({ employee: "dfinlay" }).collect()

// Entity query accessor — single entity type (derived from collection membership)
const tasks = yield* db.entities.Tasks.assigned({ employee: "dfinlay" }).collect()
```

The entity accessor name comes from the entity's member key in the collection. If the entity participates in multiple collections on different GSIs, it gets one accessor per collection membership.

## 3. Client Construction

### 3.1 DynamoClient.make()

```typescript
const db = yield* DynamoClient.make({
  entities: { Employees, Tasks, Offices },
  collections: { Assignments, Workplaces },
})
```

**Parameters:**
- `entities` — Named record of entities to bind
- `collections` — Named record of collections to bind

`DynamoClient.make()`:
1. Resolves each entity's table (from `Table.make()` registration)
2. Collects the unique set of tables
3. Validates all collection members are present in the entities record
4. Binds entities (CRUD + query accessors with `R = never`)
5. Binds collections (cross-entity query accessors with `R = never`)
6. Builds table operations for each unique table
7. Returns the typed client

### 3.2 Convenience: Table Shortcut

```typescript
// Selects all entities from the table, no collections
const db = yield* DynamoClient.make(HrTable)
```

Equivalent to `DynamoClient.make({ entities: HrTable.entities, collections: {} })`.

### 3.3 Requirements

```typescript
DynamoClient.make(config): Effect<TypedClient<...>, never, DynamoClient | TableConfig_A | TableConfig_B | ...>
```

Each unique table contributes its `TableConfig` to the requirements.

### 3.4 Validation at Construction Time

| Check | Error |
|---|---|
| Collection member entity not in entities record | `"Collection 'Assignments' references entity 'Tasks' which is not in the entities record"` |
| Entity not registered on any table | `"Entity 'Tasks' is not registered on any Table"` |

## 4. Typed Client Shape

```typescript
type TypedClient<TEntities, TCollections, TTables> = {
  readonly entities: {
    readonly [K in keyof TEntities]: BoundEntity<...>
  }

  readonly collections: {
    readonly [K in keyof TCollections]: (composites: PkComposites) => BoundQuery<CollectionResult>
  }

  readonly tables: {
    readonly [K in keyof TTables]: TableOperations
  }
}
```

### 4.1 Usage

```typescript
const db = yield* DynamoClient.make({
  entities: { Employees, Tasks, Offices },
  collections: { Assignments, Workplaces },
})

// Entities
yield* db.entities.Employees.get({ employee: "jlowe" })
yield* db.entities.Tasks.assigned({ employee: "dfinlay" }).limit(10).collect()

// Collections
const { Employees, Tasks } = yield* db.collections
  .Assignments({ employee: "dfinlay" })
  .collect()

// Tables
yield* db.tables.HrTable.create()
```

## 5. BoundEntity

### 5.1 Interface

```typescript
interface BoundEntity<TModel, TRefs> {
  // --- CRUD ---
  get(key, ...combinators): Effect<Model>
  put(input, ...combinators): Effect<Model>
  create(input, ...combinators): Effect<Model>
  update(key, ...combinators): Effect<Model>
  delete(key, ...combinators): Effect<void>
  upsert(input, ...combinators): Effect<Model>
  patch(key, ...combinators): Effect<Model>
  deleteIfExists(key, ...combinators): Effect<void>

  // --- Lifecycle ---
  getVersion(key, version): Effect<Model>
  restore(key): Effect<Model>
  purge(key): Effect<void>
  deleted: { get(key): Effect<Model> }

  // --- Query accessors (injected from collections at client construction) ---
  tasksByProject(composites): BoundQuery<Model, SK, Model>
  assigned(composites): BoundQuery<Model, SK, Model>
  // ... one per collection membership

  // --- Scan ---
  scan(): BoundQuery<Model, never, Model>
}
```

### 5.2 Query Accessors

Query accessors on `BoundEntity` are derived from collection memberships. When an entity is a member of a collection, it gets a query accessor for that index. The accessor name matches the collection name (for single-member collections) or is derived from the member key.

```typescript
// Collection definition
const TasksByProject = Collections.make("tasksByProject", {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["project"] },
  sk: { field: "gsi1sk" },
  members: {
    Tasks: Collections.member(Tasks, { sk: { composite: ["status", "createdAt"] } }),
  },
})

// Generated accessor on BoundEntity
db.entities.Tasks.tasksByProject({ project: "proj-alpha" })
db.entities.Tasks.tasksByProject({ project: "proj-alpha", status: "active" })
```

PK composites are required. SK composites are optional — providing them narrows via auto `begins_with` on the composed prefix.

### 5.3 Scan

`scan()` returns a `BoundQuery` in scan mode (no `where` available):

```typescript
db.entities.Tasks.scan()
  .filter((t, { eq }) => eq(t.status, "active"))
  .limit(100)
  .collect()
```

## 6. BoundQuery Builder

### 6.1 Interface

`BoundQuery<Model, SkRemaining, A>` is a fluent builder. Every combinator returns a new `BoundQuery` and terminals produce `Effect` or `Stream`:

```typescript
interface BoundQuery<Model, SkRemaining, A> {
  // --- Sort key condition ---
  where(fn: (sk: SkRemaining, ops: SkConditionOps) => SkCondition): BoundQuery<Model, never, A>

  // --- Filter expression ---
  filter(fn: (t: PathBuilder<Model>, ops: ConditionOps<Model>) => Expr): BoundQuery<Model, SkRemaining, A>
  filter(shorthand: ConditionShorthand): BoundQuery<Model, SkRemaining, A>

  // --- Projection ---
  select(fn: (t: PathBuilder<Model>) => Path[]): BoundQuery<Model, SkRemaining, Record<string, unknown>>
  select(attributes: string[]): BoundQuery<Model, SkRemaining, Record<string, unknown>>

  // --- Pagination & ordering ---
  limit(n: number): BoundQuery<Model, SkRemaining, A>
  maxPages(n: number): BoundQuery<Model, SkRemaining, A>
  reverse(): BoundQuery<Model, SkRemaining, A>
  startFrom(cursor: string): BoundQuery<Model, SkRemaining, A>

  // --- Read options ---
  consistentRead(): BoundQuery<Model, SkRemaining, A>
  ignoreOwnership(): BoundQuery<Model, SkRemaining, A>

  // --- Terminals ---
  fetch(): Effect<Page<A>, DynamoClientError | ValidationError, never>
  collect(): Effect<Array<A>, DynamoClientError | ValidationError, never>
  paginate(): Stream<A, DynamoClientError | ValidationError, never>
  count(): Effect<number, DynamoClientError, never>
}
```

### 6.2 Type Parameters

| Parameter | Purpose |
|---|---|
| `Model` | Source model type — provides `PathBuilder<Model>` for type-safe `filter`/`select` callbacks |
| `SkRemaining` | Remaining SK composites — constrains `where` callback. `never` for scans and collections |
| `A` | Decoded result type — changes when `select` narrows to partial records |

### 6.3 Builder Semantics

- Every combinator returns a **new** `BoundQuery` — immutable, no mutation
- `where` consumes `SkRemaining` → returns `BoundQuery<Model, never, A>` (cannot call `where` twice)
- `where` is only callable when `SkRemaining` is not `never` (type error on scans and collections)
- Terminals produce `Effect` with `R = never` — `DynamoClient` already resolved

### 6.4 SK Type Safety in `where`

The `where` callback's `sk` parameter exposes only the remaining SK composites (those not provided in the accessor):

```typescript
// sk.composite: ["status", "createdAt"]

// Provided: { status: "active" } → sk has { createdAt }
db.entities.Tasks.byProject({ projectId: "p1", status: "active" })
  .where((sk, { gte }) => gte(sk.createdAt, "2024-03-01"))  // ✅
  .collect()

// Provided: nothing → sk has { status }
db.entities.Tasks.byProject({ projectId: "p1" })
  .where((sk, { beginsWith }) => beginsWith(sk.status, "act"))  // ✅
  .collect()

// ❌ status already provided — not in sk
db.entities.Tasks.byProject({ projectId: "p1", status: "active" })
  .where((sk, { eq }) => eq(sk.status, "active"))
  // Type error: Property 'status' does not exist on type '{ createdAt: ... }'
  .collect()

// ❌ where not available on scan
db.entities.Tasks.scan()
  .where(...)  // Type error: Property 'where' does not exist
```

See [Key Condition Expressions](./key-condition-expressions.md) §4 for full SK condition specification.

### 6.5 Examples

```typescript
const { Tasks } = db.entities

// Basic query — all items in partition
yield* Tasks.byProject({ projectId: "proj-alpha" }).collect()

// Auto begins_with from SK composites
yield* Tasks.byProject({ projectId: "proj-alpha", status: "active" }).collect()

// SK condition + filter + limit + reverse
yield* Tasks.byProject({ projectId: "proj-alpha", status: "active" })
  .where((sk, { gte }) => gte(sk.createdAt, "2024-03-01"))
  .filter((t, { gte }) => gte(t.priority, 3))
  .limit(10)
  .reverse()
  .collect()

// Single page with cursor
const page = yield* Tasks.byProject({ projectId: "proj-alpha" })
  .limit(25)
  .fetch()

if (page.cursor) {
  const next = yield* Tasks.byProject({ projectId: "proj-alpha" })
    .limit(25)
    .startFrom(page.cursor)
    .fetch()
}

// Stream
const stream = Tasks.byProject({ projectId: "proj-alpha" })
  .reverse()
  .paginate()

yield* Stream.runForEach(stream, (task) => Effect.log(task.title))

// Scan with filter
yield* Tasks.scan()
  .filter((t, { eq }) => eq(t.status, "active"))
  .limit(100)
  .collect()

// Count
const total = yield* Tasks.byProject({ projectId: "proj-alpha" }).count()
```

### 6.6 Implementation

`BoundQuery` wraps `Query<A>` with pre-resolved services:

```typescript
class BoundQueryImpl<Model, SkRemaining, A> {
  constructor(
    private readonly query: Query<A>,
    private readonly pathBuilder: PathBuilder<Model>,
    private readonly conditionOps: ConditionOps<Model>,
    private readonly provide: <X, E>(eff: Effect<X, E, DynamoClient>) => Effect<X, E, never>,
  ) {}

  limit(n: number) {
    return new BoundQueryImpl(Query.limit(this.query, n), this.pathBuilder, this.conditionOps, this.provide)
  }

  filter(fn: (t: PathBuilder<Model>, ops: ConditionOps<Model>) => Expr) {
    const expr = fn(this.pathBuilder, this.conditionOps)
    return new BoundQueryImpl(Query.filterExpr(this.query, expr), this.pathBuilder, this.conditionOps, this.provide)
  }

  fetch() { return this.provide(Query.execute(this.query)) }
  collect() { return this.provide(Query.collect(this.query)) }
  count() { return this.provide(Query.count(this.query)) }

  paginate() {
    return Stream.unwrap(this.provide(Query.paginate(this.query))).pipe(
      Stream.flatMap((page) => Stream.fromIterable(page)),
    )
  }
}
```

The existing `Query.*` functions remain unchanged — `BoundQuery` is a thin typed wrapper.

## 7. Collections on the Client

### 7.1 Collection Accessors

Each collection registered on the client generates an accessor under `db.collections`:

```typescript
const db = yield* DynamoClient.make({
  entities: { Employees, Tasks, Offices },
  collections: { Assignments, Workplaces },
})

// Collection accessor — returns BoundQuery with grouped result type
db.collections.Assignments({ employee: "dfinlay" })
  // → BoundQuery<unknown, never, { Employees: Employee[], Tasks: Task[] }>
```

### 7.2 Collection Result Type

Collection queries return grouped results keyed by the member names from `Collections.make()`:

```typescript
const { Employees, Tasks } = yield* db.collections
  .Assignments({ employee: "dfinlay" })
  .collect()
// Employees: Employee[], Tasks: Task[]
```

### 7.3 Collection Builder

Collection `BoundQuery` supports the same builder methods as entity queries except `where` (`SkRemaining` is `never` because collections span multiple entity SK patterns):

```typescript
yield* db.collections.Assignments({ employee: "dfinlay" })
  .limit(25)
  .fetch()

yield* db.collections.Workplaces({ office: "gw-zoo" })
  .filter(...)  // filter applies to raw items before grouping
  .collect()
```

### 7.4 Cross-Table Collection Execution

When collection members belong to different tables, the query executes against each table in parallel and merges results:

```typescript
const { DeviceMetadata, DeviceTelemetry } = yield* db.collections
  .DeviceStatus({ deviceId: "d-123" })
  .collect()

// Internally:
// Effect.all([queryManagementTable, queryTelemetryTable], { concurrency: "unbounded" })
// → merge results by entity type
```

### 7.5 Entity Query vs Collection Query

Both can target the same GSI but at different scopes:

```typescript
// Entity-level: single entity type, entity-specific SK filtering
const tasks = yield* db.entities.Tasks.assigned({ employee: "dfinlay" }).collect()
// → Task[]

// Collection-level: all member entities, broader SK scope
const { Employees, Tasks } = yield* db.collections
  .Assignments({ employee: "dfinlay" })
  .collect()
// → { Employees: Employee[], Tasks: Task[] }
```

## 8. Table Management

### 8.1 TableOperations Interface

```typescript
interface TableOperations {
  // Core
  create(options?: CreateTableOptions): Effect<void, DynamoClientError>
  update(input: UpdateTableInput): Effect<void, DynamoClientError>
  delete(): Effect<void, DynamoClientError>
  describe(): Effect<DescribeTableCommandOutput, DynamoClientError>

  // Backup
  backup(name: string): Effect<BackupDetails, DynamoClientError>
  restoreFromBackup(backupArn: string): Effect<void, DynamoClientError>
  listBackups(): Effect<BackupSummary[], DynamoClientError>

  // Point-in-Time Recovery
  enablePointInTimeRecovery(): Effect<void, DynamoClientError>
  disablePointInTimeRecovery(): Effect<void, DynamoClientError>
  restoreToPointInTime(timestamp: Date): Effect<void, DynamoClientError>

  // Export
  exportToS3(s3Bucket: string, options?: ExportOptions): Effect<ExportDescription, DynamoClientError>

  // TTL
  enableTTL(attributeName: string): Effect<void, DynamoClientError>
  disableTTL(attributeName: string): Effect<void, DynamoClientError>
  describeTTL(): Effect<TimeToLiveDescription, DynamoClientError>

  // Tags
  tag(tags: Record<string, string>): Effect<void, DynamoClientError>
  untag(tagKeys: string[]): Effect<void, DynamoClientError>
  tags(): Effect<Record<string, string>, DynamoClientError>
}
```

All operations are pre-bound with the resolved table name.

### 8.2 DynamoClientService Extensions

New operations added to the raw `DynamoClientService`:

```typescript
interface DynamoClientService {
  // Existing: createTable, deleteTable, describeTable, putItem, getItem, updateItem,
  //           deleteItem, query, scan, batchGetItem, batchWriteItem,
  //           transactGetItems, transactWriteItems

  // Table management
  readonly updateTable: (input) => Effect<UpdateTableCommandOutput, DynamoClientError>
  readonly listTables: (input) => Effect<ListTablesCommandOutput, DynamoClientError>

  // Backup
  readonly createBackup: (input) => Effect<CreateBackupCommandOutput, DynamoClientError>
  readonly deleteBackup: (input) => Effect<DeleteBackupCommandOutput, DynamoClientError>
  readonly listBackups: (input) => Effect<ListBackupsCommandOutput, DynamoClientError>
  readonly restoreTableFromBackup: (input) => Effect<RestoreTableFromBackupCommandOutput, DynamoClientError>

  // PITR
  readonly describeContinuousBackups: (input) => Effect<DescribeContinuousBackupsCommandOutput, DynamoClientError>
  readonly updateContinuousBackups: (input) => Effect<UpdateContinuousBackupsCommandOutput, DynamoClientError>
  readonly restoreTableToPointInTime: (input) => Effect<RestoreTableToPointInTimeCommandOutput, DynamoClientError>

  // Export
  readonly exportTableToPointInTime: (input) => Effect<ExportTableToPointInTimeCommandOutput, DynamoClientError>
  readonly describeExport: (input) => Effect<DescribeExportCommandOutput, DynamoClientError>

  // TTL
  readonly updateTimeToLive: (input) => Effect<UpdateTimeToLiveCommandOutput, DynamoClientError>
  readonly describeTimeToLive: (input) => Effect<DescribeTimeToLiveCommandOutput, DynamoClientError>

  // Tags
  readonly tagResource: (input) => Effect<TagResourceCommandOutput, DynamoClientError>
  readonly untagResource: (input) => Effect<UntagResourceCommandOutput, DynamoClientError>
  readonly listTagsOfResource: (input) => Effect<ListTagsOfResourceCommandOutput, DynamoClientError>
}
```

## 9. Type Error Analysis & LSP Diagnostics

Several type errors produced by the typed client API will be confusing to users because they stem from computed generic types rather than explicit declarations. These are candidates for custom LSP diagnostics that provide actionable error messages.

### 9.1 Confusing Type Errors

#### Missing PK Composite in Query Accessor

```typescript
// byProject requires { projectId: string }
db.entities.Tasks.byProject({ status: "active" })
```

**Raw TS error:** `Argument of type '{ status: string }' is not assignable to parameter of type '{ projectId: string; status?: string; createdAt?: string }'`. Property 'projectId' is missing.

**Why confusing:** The expected type is a computed intersection of PK (required) + SK (optional) composites. Users see an unfamiliar generated type, not a named interface.

**LSP diagnostic:** `"Query accessor 'byProject' requires PK composite 'projectId'. SK composites 'status', 'createdAt' are optional."`

#### Accessing Already-Provided SK Composite in `where`

```typescript
db.entities.Tasks.byProject({ projectId: "p1", status: "active" })
  .where((sk, { eq }) => eq(sk.status, "active"))
```

**Raw TS error:** `Property 'status' does not exist on type '{ readonly createdAt: SkPath<string> }'`

**Why confusing:** User provided `status` in the accessor and expects it to be available. The computed `SkRemaining` type is opaque — user doesn't understand why `status` disappeared.

**LSP diagnostic:** `"'status' was already provided in the query accessor composites. Only unprovided SK composites are available in 'where': 'createdAt'."`

#### Calling `where` on a Scan

```typescript
db.entities.Tasks.scan().where(...)
```

**Raw TS error:** `Property 'where' does not exist on type 'BoundQuery<Task, never, Task>'`

**Why confusing:** User sees `never` in a type parameter and doesn't understand the connection to scan mode.

**LSP diagnostic:** `"'where' is not available on scan queries. Sort key conditions only apply to index queries. Use 'filter' for post-read filtering."`

#### Calling `where` on a Collection Query

```typescript
db.collections.Assignments({ employee: "dfinlay" }).where(...)
```

**Raw TS error:** Same as scan — `Property 'where' does not exist`

**LSP diagnostic:** `"'where' is not available on collection queries. Collections span multiple entity SK patterns. Use 'filter' for post-read filtering."`

#### Wrong Composite Attribute Type

```typescript
// employee is Schema.String on the model
db.entities.Tasks.assigned({ employee: 42 })
```

**Raw TS error:** `Type 'number' is not assignable to type 'string'` inside a computed mapped type.

**Why confusing:** The error points at a generated type like `{ employee: CaseInsensitive<string> }` or a deeply nested conditional type. The user can't easily trace it back to the model field.

**LSP diagnostic:** `"Composite attribute 'employee' expects type 'string' (from Task model field 'employee'). Got 'number'."`

#### Collection Member Entity Missing from Client

```typescript
const db = yield* DynamoClient.make({
  entities: { Employees },  // Tasks missing
  collections: { Assignments },
})
```

**Raw TS error:** Complex — the type check may involve conditional types verifying all collection members are present.

**Why confusing:** Deep generic error about type mismatch between collection member types and entity record types.

**LSP diagnostic:** `"Collection 'Assignments' references entity 'Tasks' which is not in the entities record. Add 'Tasks' to entities."`

#### Entity Not Registered on Any Table

```typescript
const Orphan = Entity.make({ ... })
// Never passed to Table.make()
const db = yield* DynamoClient.make({ entities: { Orphan } })
```

**Raw TS error:** Likely a missing `TableConfig` service in `R` that produces an opaque error.

**Why confusing:** The error is about Effect requirements, not about table registration. User doesn't see the connection.

**LSP diagnostic:** `"Entity 'Orphan' is not registered on any Table. Register it via Table.make({ entities: { Orphan } })."`

#### Using `select` Then Accessing Typed Fields

```typescript
const items = yield* db.entities.Tasks.byProject({ projectId: "p1" })
  .select(["name", "price"])
  .collect()

items[0].name  // ❌ type is Record<string, unknown>
```

**Raw TS error:** `Property 'name' does not exist on type 'Record<string, unknown>'`

**Why confusing:** User selected specific fields but lost type information.

**LSP diagnostic:** `"Projection narrows to Record<string, unknown> because DynamoDB projections may return partial items. Use 'items[0]["name"]' for dynamic access, or omit 'select' for fully typed results."`

### 9.2 LSP Implementation Strategy

The language service plugin should intercept type errors at specific code patterns:

1. **Query accessor calls** — detect `db.entities.<Entity>.<indexName>(...)` and provide composite-aware diagnostics
2. **BoundQuery method chains** — detect `.where(...)`, `.filter(...)`, `.select(...)` on `BoundQuery` types and provide context-aware messages
3. **DynamoClient.make()** — detect the configuration object and validate entity/collection relationships
4. **Collections.make()** — detect member declarations and validate structural compatibility

The plugin can detect `BoundQuery<*, never, *>` (scan/collection) and surface `where` unavailability proactively via hover tooltips, even before the user attempts to call it.

### 9.3 Hover Tooltip Enhancements

In addition to error diagnostics, the LSP should provide rich hover information:

| Hover Target | Tooltip |
|---|---|
| `db.entities.Tasks.byProject` | `"Query index 'byProject' (gsi1). PK: projectId (required). SK: status, createdAt (optional). Returns BoundQuery<Task>."` |
| `db.collections.Assignments` | `"Collection 'Assignments' on gsi3. Members: Employees (employeeLookup), Tasks (assigned). PK: employee."` |
| `.where(...)` | `"Sort key condition on remaining composites: createdAt. Operators: eq, lt, lte, gt, gte, between, beginsWith."` |
| `.fetch()` | `"Execute single DynamoDB page. Returns Page<Task> with items and cursor for pagination."` |
| `.collect()` | `"Execute query and collect all pages into Array<Task>. Automatically paginates."` |
| `db.tables.HrTable` | `"Table 'hr-table'. Entities: Employees, Tasks, Offices. 5 GSIs."` |

## 10. Full Example

```typescript
import { Effect, Layer, Stream, Schema } from "effect"
import { DynamoSchema, Table, Entity, Collections, DynamoClient } from "effect-dynamodb"

// --- Domain models ---

class Employee extends Schema.Class<Employee>("Employee")({
  employee: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  office: Schema.String,
  title: Schema.String,
  team: Schema.String,
  salary: Schema.String,
  manager: Schema.String,
  dateHired: Schema.String,
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
}) {}

// --- Schema ---

const HrSchema = DynamoSchema.make({ name: "hr", version: 1 })

// --- Entities (model + primary key only) ---

const Employees = Entity.make({
  model: Employee,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employee"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  softDelete: true,
})

const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["task"] },
    sk: { field: "sk", composite: ["project", "employee"] },
  },
  timestamps: true,
})

const Offices = Entity.make({
  model: Office,
  entityType: "Office",
  primaryKey: {
    pk: { field: "pk", composite: ["office"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
})

// --- Table ---

const HrTable = Table.make({
  schema: HrSchema,
  entities: { Employees, Tasks, Offices },
})

// --- Collections (ALL access patterns — single and multi-entity) ---

// Multi-entity: employee + their assigned tasks
const Assignments = Collections.make("assignments", {
  index: "gsi3",
  pk: { field: "gsi3pk", composite: ["employee"] },
  sk: { field: "gsi3sk" },
  members: {
    Employees: Collections.member(Employees, { sk: { composite: [] } }),
    Tasks: Collections.member(Tasks, { sk: { composite: ["project", "task"] } }),
  },
})

// Multi-entity: office with its employees
const Workplaces = Collections.make("workplaces", {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["office"] },
  sk: { field: "gsi1sk" },
  members: {
    Employees: Collections.member(Employees, { sk: { composite: ["team", "title", "employee"] } }),
    Offices: Collections.member(Offices, { sk: { composite: [] } }),
  },
})

// Single-entity: tasks by project
const TasksByProject = Collections.make("tasksByProject", {
  index: "gsi2",
  pk: { field: "gsi2pk", composite: ["project"] },
  sk: { field: "gsi2sk" },
  members: {
    Tasks: Collections.member(Tasks, { sk: { composite: ["employee", "task"] } }),
  },
})

// Single-entity: employees by role/title
const EmployeesByRole = Collections.make("employeesByRole", {
  index: "gsi4",
  pk: { field: "gsi4pk", composite: ["title"] },
  sk: { field: "gsi4sk" },
  members: {
    Employees: Collections.member(Employees, { sk: { composite: ["salary", "employee"] } }),
  },
})

// Single-entity: direct reports by manager
const DirectReports = Collections.make("directReports", {
  index: "gsi5",
  pk: { field: "gsi5pk", composite: ["manager"] },
  sk: { field: "gsi5sk" },
  members: {
    Employees: Collections.member(Employees, { sk: { composite: ["team", "office", "employee"] } }),
  },
})

// --- Usage ---

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Employees, Tasks, Offices },
    collections: { Assignments, Workplaces, TasksByProject, EmployeesByRole, DirectReports },
  })

  // Table management
  yield* db.tables.HrTable.create()

  // CRUD
  yield* db.entities.Employees.put({
    employee: "jlowe", firstName: "Joe", lastName: "Lowe",
    office: "gw-zoo", title: "Zookeeper", team: "jupiter",
    salary: "000045.00", manager: "jlowe", dateHired: "2020-01-01",
  })
  const joe = yield* db.entities.Employees.get({ employee: "jlowe" })

  // Entity query (single-member collection) — builder pattern
  const feedingTasks = yield* db.entities.Tasks.tasksByProject({ project: "feeding" })
    .limit(10)
    .collect()

  // Entity query — SK condition + filter
  const highPaidDirectors = yield* db.entities.Employees.employeesByRole({ title: "Director" })
    .where((sk, { gte }) => gte(sk.salary, "000100.00"))
    .filter((t, { eq }) => eq(t.team, "saturn"))
    .collect()

  // Entity query — single page with cursor
  const page = yield* db.entities.Employees.directReports({ manager: "jlowe" })
    .limit(25)
    .fetch()

  if (page.cursor) {
    const next = yield* db.entities.Employees.directReports({ manager: "jlowe" })
      .limit(25)
      .startFrom(page.cursor)
      .fetch()
  }

  // Entity query from multi-member collection — single entity type
  const stream = db.entities.Tasks.assignments({ employee: "dfinlay" }).paginate()
  yield* Stream.runForEach(stream, (task) => Effect.log(task.description))

  // Scan with filter
  const allActiveTasks = yield* db.entities.Tasks.scan()
    .filter((t, { eq }) => eq(t.project, "feeding"))
    .collect()

  // Collection query — single DynamoDB call, grouped result
  const { Employees: emps, Tasks: tasks } = yield* db.collections
    .Assignments({ employee: "dfinlay" })
    .collect()

  const { Employees: coworkers, Offices: offices } = yield* db.collections
    .Workplaces({ office: "gw-zoo" })
    .collect()

  // Collection query — paginated
  const collPage = yield* db.collections
    .Assignments({ employee: "dfinlay" })
    .limit(25)
    .fetch()

  // Table management
  yield* db.tables.HrTable.enableTTL("_ttl")
  yield* db.tables.HrTable.backup("pre-migration")
  yield* db.tables.HrTable.tag({ environment: "production", team: "platform" })
  yield* db.tables.HrTable.delete()
})

// --- Layer ---

const main = program.pipe(
  Effect.provide(
    Layer.mergeAll(
      DynamoClient.layer({ region: "us-east-1" }),
      HrTable.layer({ name: "hr-table" }),
    ),
  ),
)
```

## 11. ElectroDB Comparison

### Entity Query

```typescript
// ElectroDB
const { data } = await Task.query.assigned({ employee: "dfinlay" }).go()

// effect-dynamodb
const data = yield* db.entities.Tasks.assigned({ employee: "dfinlay" }).collect()
```

### Collection Query

```typescript
// ElectroDB
const { data } = await EmployeeApp.collections.assignments({ employee: "dfinlay" }).go()
// data.employees: Employee[], data.tasks: Task[]

// effect-dynamodb
const { Employees, Tasks } = yield* db.collections.Assignments({ employee: "dfinlay" }).collect()
```

### SK Condition + Filter + Sort + Limit

```typescript
// ElectroDB
const { data } = await Task.query
  .byProject({ projectId: "proj-alpha", status: "active" })
  .gte({ createdAt: "2024-03-01" })
  .where(({ priority }, { gte }) => gte(priority, 3))
  .go({ order: "desc", limit: 10 })

// effect-dynamodb
const data = yield* db.entities.Tasks.byProject({ projectId: "proj-alpha", status: "active" })
  .where((sk, { gte }) => gte(sk.createdAt, "2024-03-01"))
  .filter((t, { gte }) => gte(t.priority, 3))
  .reverse()
  .limit(10)
  .collect()
```

### Scan

```typescript
// ElectroDB
const { data } = await Task.scan
  .where(({ status }, { eq }) => eq(status, "active"))
  .go()

// effect-dynamodb
const data = yield* db.entities.Tasks.scan()
  .filter((t, { eq }) => eq(t.status, "active"))
  .collect()
```

## 12. Collections — Usage Guide

### 12.1 What Collections Are

A Collection is a **read-time join** across independent entities that share an index partition. Instead of denormalizing (copying fields between entities) or joining at the application layer (multiple queries + merge in code), related entities are placed in the same index partition and DynamoDB returns them all in one read.

The relationship is expressed through shared PK composites:

```
GSI3 Partition: employee = "dfinlay"
├── Employee item   (SK: $assignments#employee#...)
├── Task item       (SK: $assignments#task#feeding#feed-cats)
└── Task item       (SK: $assignments#task#onboarding#orientation)
```

One query, one round trip, multiple entity types — no denormalization needed.

### 12.2 Collections vs Aggregates

| | Collection | Aggregate |
|---|---|---|
| Purpose | Read-time join | Write-time consistency boundary |
| Read result | Flat grouped arrays — consumer assembles | Nested graph — framework assembles |
| Write | Each entity written independently | Atomic transaction, diff-based updates |
| Consistency | Eventual (entities written separately) | Atomic (root + edges in one transaction) |
| Denormalization | None required | Write-time ref hydration |
| Entity coupling | Fully independent | Edge entities reference root/parent |
| Use case | "Employee + their tasks" | "Match with teams and players" |

**Collections** suit entities with independent lifecycles that happen to share an access pattern. Employees and Tasks are managed by different services but queried together for a dashboard.

**Aggregates** suit entities that form a consistency boundary with ownership semantics. A Match without its Teams is meaningless — they're created, updated, and deleted as a unit.

Both can coexist. An Aggregate defines write consistency; a Collection defines read convenience. They serve different access patterns on the same data.

### 12.3 SK Composites as Cheap Denormalization

When querying across a relationship, you often want attributes from the "other side" — e.g., when listing a player's match history, you want the match date and venue without a separate lookup.

SK composites provide this for free. Attributes listed in an index's SK composite are stored on the item and automatically maintained when the source value changes (because the GSI key must be recomposed). Trailing composites that you never query or sort by are still guaranteed to be present and current:

```typescript
const MatchPlayer = Entity.make({
  model: MatchPlayer,
  entityType: "MatchPlayer",
  primaryKey: {
    pk: { field: "pk", composite: ["matchId", "playerId"] },
    sk: { field: "sk", composite: [] },
  },
})

const MatchPlayersByPlayer = Collections.make("matchPlayersByPlayer", {
  index: "gsi2",
  pk: { field: "gsi2pk", composite: ["playerId"] },
  sk: { field: "gsi2sk" },
  members: {
    MatchPlayers: Collections.member(MatchPlayers, {
      sk: { composite: ["matchDate", "matchId", "venue", "matchName"] },
      //                 ^^^^^^^^^^^^^^^^  ^^^^^^^^  ^^^^^^  ^^^^^^^^^
      //                 query/sort keys   grouping  denormalized fields
    }),
  },
})
```

Querying `db.entities.MatchPlayers.matchPlayersByPlayer({ playerId: "p-123" })` returns every match the player has been in, sorted by date, with venue and match name included — all from one query, no fan-out.

If `venue` or `matchName` changes on the Match entity, the MatchPlayer items that share those attributes must have their GSI SK recomposed — the "cascade" is already handled by the index update mechanism.

**Pattern:** Use leading SK composites for query/sort (`matchDate`), middle composites for grouping/identity (`matchId`), and trailing composites for cheap denormalization of slow-changing attributes (`venue`, `matchName`). The trailing fields aren't queryable via `begins_with`, but they're guaranteed present and current.

**Trade-off:** SK values have a 1024-byte limit. For a few string fields this is negligible, but avoid putting large or high-cardinality data in SK composites.

### 12.4 Cross-Partition Fan-Out

Collections optimize one access pattern per shared partition key. When you need data that spans multiple partitions, fan-out is unavoidable:

```typescript
// Step 1: Get all match appearances for a player (one query)
const appearances = yield* db.entities.MatchPlayers
  .byPlayer({ playerId: "p-123" })
  .collect()
// Each MatchPlayer has matchId, matchDate, venue, matchName from SK composites

// Step 2: If you need full match graphs, batch-get the aggregates (fan-out)
const matches = yield* Batch.batchGet(
  appearances.map(a => Matches.get({ matchId: a.matchId })),
)
```

Design indexes so that step 1 returns enough data for the common case (player history with dates, venues, scores). Reserve step 2 for the uncommon case (full match detail drill-down). This minimizes fan-out in production read paths.

### 12.5 When to Use Collections

| Scenario | Use |
|---|---|
| Independent entities, shared access pattern | Collection |
| Parent-child ownership, atomic writes | Aggregate |
| "Show me X and all related Y" (one partition) | Collection |
| "Assemble a nested domain object" | Aggregate |
| Cross-entity query, no denormalization | Collection |
| Cross-partition lookup | Entity query + batch get (fan-out) |
| Slow-changing attributes from related entity | SK composites (cheap denormalization) |

## 13. Implementation Plan

### Phase 1: BoundQuery Builder

**Files:** `src/internal/BoundQuery.ts` (new), `src/Query.ts`

1. Create `BoundQuery<Model, SkRemaining, A>` class wrapping `Query<A>` + pre-resolved `provide`
2. Implement combinator methods delegating to existing `Query.*` functions
3. Implement terminal methods (`fetch`, `collect`, `paginate`, `count`)
4. `where` method with SK type safety (consumes `SkRemaining`)
5. `filter` method with `PathBuilder<Model>` callback
6. `select` method with projection support
7. Unit tests for BoundQuery

### Phase 2: Entity Query Accessors on BoundEntity

**Files:** `src/Entity.ts`, `src/DynamoClient.ts`

1. Generate named query accessors on `BoundEntity` (one per non-primary index)
2. Each accessor returns `BoundQuery<Model, SkRemaining, Model>`
3. Add `scan()` method returning `BoundQuery<Model, never, Model>`
4. Remove `collect(query, ...)` and `paginate(query, ...)` from `BoundEntity`
5. Update `bind()` to construct `BoundQuery` instances with resolved services
6. Update existing tests

### Phase 3: Collections.make()

**Files:** `src/Collections.ts` (new), `src/Collection.ts` (internal)

1. Implement `Collections.make(name, config)` with index definition + member declarations
2. Implement `Collections.member(entity, { sk })` for per-entity SK composite binding
3. Support single-member collections (entity-specific access pattern) and multi-member (cross-entity)
4. Support `type: "clustered"` (default) and `type: "isolated"` SK prefix ordering
5. Validate composite attributes exist on entity models at definition time
6. Collection type carries member types + index config for result grouping and key composition
7. Remove `indexes` from `Entity.make()` — replace with `primaryKey`
8. Remove `collection` property from entity index definitions
9. Support multiple collections on the same GSI (for isolated scoped queries)
10. Collection injects index definition into member entities at client construction time
11. Generate entity query accessors from collection membership
12. Unit tests for validation, type safety, and both collection types

### Phase 4: Entity-Centric Client

**Files:** `src/DynamoClient.ts`, `src/Table.ts`

1. `DynamoClient.make({ entities, collections })` accepting config object
2. Resolve tables from entities (each entity knows its table)
3. Generate typed client with `entities`, `collections`, `tables` namespaces
4. Validate collection members are in entities record
5. Preserve `DynamoClient.make(table)` as convenience overload
6. Type-level computation for `TypedClient`

### Phase 5: Extended Table Operations

**Files:** `src/DynamoClient.ts`, `src/Errors.ts`

1. Add new operations to `DynamoClientService` interface
2. Implement AWS SDK command wrappers
3. Build `TableOperations` interface with convenience methods
4. Pre-bind table name to all operations

### Phase 6: LSP Diagnostics

**Files:** `packages/language-service/src/core/`

1. Detect `BoundQuery` type patterns for `where`/`filter`/`select` diagnostics
2. Detect query accessor calls for composite attribute diagnostics
3. Detect `DynamoClient.make()` for entity/collection relationship diagnostics
4. Hover tooltips for query accessors, collection accessors, and builder methods

### Phase 7: Examples, Tests, Docs

**Files:** All examples, tests, docs

1. Update all 17 examples
2. Update all tests
3. Update documentation site
4. Update CLAUDE.md and DESIGN.md

### Dependencies

```
Phase 1 (BoundQuery) → Phase 2 (Entity accessors) → Phase 4 (Client)
Phase 3 (Collections.make) → Phase 4 (Client)
Phase 5 (Table ops) — independent, can parallel with 1-4
Phase 6 (LSP) — after Phase 4 (needs final type shapes)
Phase 7 (Migration) — after all phases complete
```
