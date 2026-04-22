# Effect DynamoDB ORM - Design Specification

## 1. Philosophy & Principles

### Motivation

effect-dynamodb provides a type-safe, Effect-native DynamoDB ORM that makes single-table design first-class. The library bridges the gap between Effect's composable programming model and DynamoDB's access-pattern-driven data modeling, delivering an API where domain models are portable, storage concerns are declarative, and queries compose via pipes.

### Six Principles

1. **Domain models are portable.** A `User` schema should work with DynamoDB, SQL, or an API response — no storage concepts leak into the model.
2. **Entity owns storage concerns.** Key composition, timestamps, versioning, soft delete — all configured at the Entity level, not annotated on model fields.
3. **Convention over configuration.** The system owns key format, delimiters, and serialization. The developer declares *which* attributes compose each key, not *how*.
4. **Composable queries.** Queries are pipeable data types with combinators, not builder patterns. They follow Effect TS idioms.
5. **Type safety from declarations.** Seven types are derived automatically from Model + Table + Entity — zero manual type maintenance.
6. **Client is the gateway.** `DynamoClient.make(table)` is the sole execution gateway — it resolves infrastructure dependencies, binds all entities and aggregates registered on the table, and returns a typed client where every operation has `R = never`. This matches `HttpApiClient.make(api)` from Effect v4 and enables clean service boundaries with layer-based testing.

### Design Evolution

The API went through two significant redesigns:

| Concern | v1 | v2 (bind pattern) | v3 (client gateway) |
|---------|----|--------------------|---------------------|
| Model base class | `DynamoModel.Class` (VariantSchema) | Standard `Schema.Class` | Standard `Schema.Class` |
| Key composition | Template strings: `"USER#${userId}"` | Attribute lists: `composite: ["userId"]` | Attribute lists: `composite: ["userId"]` |
| Entity definition | `Entity.make({ model, table, ... })` | `Entity.make({ model, table, ... })` | `Entity.make({ model, ... })` — no `table` |
| Table definition | `Table.make({ schema })` | `Table.make({ schema })` | `Table.make({ schema, entities, aggregates })` |
| Execution gateway | `repo.put`, `repo.get` (flat) | `yield* Entity.bind(e)` → `BoundEntity` | `yield* DynamoClient.make(table)` → typed client |
| Aggregate internals | N/A | Composes Entity, Collection, Transaction | Composes Entity, Collection, Transaction |
| Aggregate edges | N/A | Explicit first-class entities | Explicit first-class entities |

The v3 redesign moved the `table` parameter out of `Entity.make()` (entities are now pure definitions), had `Table.make()` declare its members (entities + aggregates) up front, and established `DynamoClient.make(table)` as the typed execution gateway — matching `HttpApiClient.make(api)` from Effect v4 where the API definition describes the shape, and the client factory returns typed access to every group and operation.

---

## 2. Architecture

### Module Structure

```
packages/effect-dynamodb/src/
├── DynamoModel.ts      # Schema annotations (Hidden, identifier, ref) and configure() for field overrides (immutable, field rename, storedAs)
├── DynamoSchema.ts     # Application namespace (name + version) for key prefixing
├── Table.ts            # Table definition: { schema, entities, aggregates } — declares members up front
├── Entity.ts           # Entity definition (pure, no table ref) + typed operations
├── Aggregate.ts        # Aggregate definition — composes Entity, Collection, Transaction
├── EventStore.ts       # EventStream definition — event sourcing on DynamoDB
├── KeyComposer.ts      # Composite key composition from index definitions
├── Collection.ts       # Multi-entity queries with per-entity Schema decode
├── Expression.ts       # Condition, filter, and update expression builders (ConditionInput / UpdateInput)
├── Transaction.ts      # TransactGetItems + TransactWriteItems (atomic multi-item ops)
├── Projection.ts       # ProjectionExpression builder for selecting specific attributes
├── DynamoClient.ts     # Context.Service wrapping AWS SDK + DynamoClient.make(table) typed gateway
├── Marshaller.ts       # Thin wrapper around @aws-sdk/util-dynamodb
├── Errors.ts           # Tagged errors
├── internal/           # Decomposed internals
│   ├── Expr.ts         # Expr ADT — type-safe expression nodes, ConditionOps, compileExpr
│   ├── PathBuilder.ts  # PathBuilder — recursive Proxy for type-safe attribute path access
│   ├── EntityOps.ts    # Entity operation intermediates (EntityGet, EntityPut, EntityUpdate, EntityDelete)
│   ├── EntityTypes.ts  # Type-level computations for Entity derived types
│   ├── EntitySchemas.ts # Schema derivation (7 derived schemas)
│   ├── EntityCombinators.ts # Terminal functions and update combinators (record + path-based)
│   └── ...             # Other internal modules
└── index.ts            # Public API barrel export

packages/effect-dynamodb-geo/src/
├── GeoIndex.ts         # GeoIndex definition — geospatial indexing on Entity
├── GeoSearch.ts        # Internal search orchestration (H3 multi-cell parallel query)
├── H3.ts               # H3 hexagonal grid utilities
├── Spherical.ts        # Great-circle distance calculations
└── index.ts            # Public API barrel export
```

### Data Flow

```
User code → yield* DynamoClient.make(MainTable)  // typed execution gateway
  → resolves DynamoClient service + TableConfig from context
  → binds ALL entities and aggregates registered on the table
  → returns typed client: { Users, Tasks, Matches, createTable, ... }

db.Users.put(inputData)
  → Schema.decode(Entity.Input) — validate input
  → compose keys (KeyComposer) for all indexes using composite attributes
  → add __edd_e__ + timestamps + version
  → marshall to DynamoDB format (Marshaller)
  → DynamoClient.putItem (or transactWriteItems for unique constraints)
  → Schema.decode(Entity.Record) — decode full item for return

db.Users.get(key)
  → compose primary key → DynamoClient.getItem
  → unmarshall → Schema.decode(Entity.Record) — validate & type

db.Users.execute(Users.query.indexName({ pk composites }))
  → compose PK/SK from composite attributes (KeyComposer)
  → build KeyConditionExpression + __edd_e__ FilterExpression
  → Stream.paginate (automatic DynamoDB pagination)
  → unmarshall → Schema.decode(Entity.Record) per item

db.Matches.get({ matchId: "m-1" })
  → internally uses Collection query to fetch all items in partition
  → discriminate by __edd_e__ into edge entity buckets
  → assemble into domain object
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Native build (not wrapping ElectroDB) | Full control over Effect integration, no impedance mismatch |
| Raw AWS SDK (not @effect-aws) | Avoid extra dependency; thin wrapper is simple enough |
| Effect Schema as sole schema system | Native Effect integration, bidirectional transforms, branded types |
| Schema.Class/Struct for models | Pure domain schemas — no DynamoDB concepts in models. Entity derives DynamoDB types |
| DynamoClient.make(table) as typed gateway | `Table.make({ entities, aggregates })` declares members; `DynamoClient.make(table)` binds them all and returns typed access. Matches `HttpApiClient.make(api)` pattern from Effect v4 |
| Entities are pure definitions | `Entity.make()` has no `table` parameter — entities carry only model, indexes, and config. Table association happens at `Table.make()` time |
| Table declares its members | `Table.make({ schema, entities: { Users, Tasks }, aggregates: { Matches } })` — the named record provides property names on the typed client |
| Aggregates compose entity operations | Aggregates never touch DynamoClient. They orchestrate Entity, Collection, and Transaction primitives |
| ElectroDB-style composite indexes | `{ pk: { field, composite }, sk: { field, composite } }` — attribute lists not templates |
| DynamoSchema for key namespacing | `$schema#v1#entity#attrs` format with `$` sentinel prefix for ORM/non-ORM coexistence |
| `__edd_e__` entity type attribute | Ugly name convention (like ElectroDB's `__edb_e__`) avoids collisions with user model fields |
| Single-table first | Most impactful DynamoDB pattern; multi-table is simpler subset |
| @aws-sdk/util-dynamodb for marshalling | Proven, maintained; Effect Schema handles validation layer above |

### Module Dependencies

```
Aggregate → Entity, Collection, Transaction, Errors (never DynamoClient directly)
Entity → DynamoClient, DynamoSchema, Table, KeyComposer, Marshaller, Expression, Errors
Collection → DynamoClient, Entity, Table, Marshaller, Errors
Transaction → DynamoClient, Entity, KeyComposer, Marshaller, Expression, Errors
Projection → (standalone, no internal deps)
Expression → Marshaller
Table → DynamoSchema, Entity (type-level for member registration)
DynamoSchema → (standalone, no internal deps)
DynamoModel → effect (Schema) — provides annotations (Hidden, identifier, ref) and configure()
DynamoClient → effect (Context, Layer), @aws-sdk/client-dynamodb, Entity (for make() binding)
KeyComposer → (standalone, no internal deps)
Marshaller → @aws-sdk/util-dynamodb
Errors → effect (Data)
```

### Layering Principle

Higher-level constructs compose lower-level primitives. No layer may bypass the one below:

```
┌─────────────────────────────────────┐
│  DynamoClient.make(table)           │  ← typed gateway (binds all members, R = never)
├─────────────────────────────────────┤
│  Aggregate / GeoIndex / EventStore  │  ← orchestration (decompose, assemble, diff)
├─────────────────────────────────────┤
│  Collection / Transaction / Batch   │  ← multi-entity coordination
├─────────────────────────────────────┤
│  Entity                             │  ← single-item CRUD, keys, validation, versioning
├─────────────────────────────────────┤
│  DynamoClient (raw service)         │  ← raw AWS SDK operations
└─────────────────────────────────────┘
```

---

## 3. Model Layer

### Pure Domain Models

Models use standard Effect Schema definitions — `Schema.Class` for class instances or `Schema.Struct` for plain objects. No DynamoDB concepts appear in the model definition. Models are portable across storage backends.

```typescript
import { Schema } from "effect"
import { DynamoModel } from "effect-dynamodb"

class User extends Schema.Class<User>("User")({
  userId:      Schema.String,
  email:       Schema.String,
  displayName: Schema.NonEmptyString,
  role:        Schema.Literals(["admin", "member"]),
}) {}
```

### DynamoModel.configure — Immutable Fields

`DynamoModel.configure` wraps a model with per-field DynamoDB overrides, keeping ORM concerns separate from pure domain models. The `immutable` option marks a field as read-only after creation — excluded from `Entity.Update<E>` alongside key-referenced fields.

```typescript
import { Schema } from "effect"
import { DynamoModel } from "effect-dynamodb"

// Pure domain model — no DynamoDB concepts
class User extends Schema.Class<User>("User")({
  userId:      Schema.String,
  email:       Schema.String,
  displayName: Schema.NonEmptyString,
  createdBy:   Schema.String,
}) {}

// DynamoDB-specific configuration — separate from model
const UserModel = DynamoModel.configure(User, {
  createdBy: { immutable: true },  // never changes after creation
})
```

The Entity reads the `immutable` flag from the configured model's attributes and excludes that field from `Entity.Update<E>`.

---

## 4. Application Namespace (DynamoSchema)

### Namespace and Versioning

`DynamoSchema` is a top-level construct that defines the application namespace. It prefixes every generated key in the system, enabling multiple applications to share the same DynamoDB table with complete isolation.

```typescript
import { DynamoSchema } from "effect-dynamodb"

const AppSchema = DynamoSchema.make({
  name: "myapp",
  version: 1,
  casing: "lowercase",  // default
})
```

### Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | *required* | Application name, used as key prefix |
| `version` | `number` | *required* | Schema version number |
| `casing` | `"lowercase" \| "uppercase" \| "preserve"` | `"lowercase"` | Casing for structural key parts |

### Casing Rules

Casing applies to **structural parts** of keys:
- Schema name
- Version prefix
- Entity type
- Collection name

**Attribute values are always preserved as-is.** If a user's `email` is `"Alice@Example.com"`, the email value in the key retains its original casing.

### Key Prefix Format

Every generated key starts with a `$` sentinel followed by the schema prefix. The `$` sentinel identifies ORM-managed keys, enabling coexistence with non-ORM items on the same table:

```
$<schema>#<version>#<entityType|collection>#<...composites>
```

Examples with `name: "myapp"`, `version: 1`, `casing: "lowercase"`:

| Context | Generated key |
|---------|---------------|
| User entity, pk `["userId"]`, value `"abc-123"` | `$myapp#v1#user#abc-123` |
| User entity, sk `[]` (empty) | `$myapp#v1#user` |
| Clustered collection "TenantItems", pk | `$myapp#v1#tenantitems#t-1` |
| Unique constraint sentinel (email) | `$myapp#v1#user.email#foo@bar.com` |
| Version snapshot (v7) | `$myapp#v1#user#v#0000007` |
| Soft-deleted item | `$myapp#v1#user#deleted#2024-01-15T10:30:00Z` |

### The `$` Sentinel

Every ORM-generated key starts with `$`. This serves two purposes:

1. **Coexistence** — A scan or stream consumer can immediately identify ORM-managed items by the `$` prefix without needing to know the schema name.
2. **Collision avoidance** — The `$` separates ORM-managed structural prefixes from user-provided attribute values, preventing ambiguity during key parsing.

### Multi-Application Isolation

Two applications sharing the same table produce completely independent key spaces:

```
$myapp#v1#user#abc-123     ← Application A
$billing#v1#user#abc-123   ← Application B (different schema name)
```

### Schema Versioning for Migration

Schema version enables blue/green deployments and gradual migration:

```
$myapp#v1#user#abc-123     ← Current production
$myapp#v2#user#abc-123     ← New version (migration in progress)
```

---

## 5. Table & Entity

### Entity — Pure Definition

An Entity binds a domain model to key composition rules, system field configuration, unique constraints, and collection membership. **Entities do not reference a Table** — they are pure definitions carrying only model, indexes, and config.

```typescript
import { Duration } from "effect"
import { Entity } from "effect-dynamodb"

const UserEntity = Entity.make({
  model: User,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
    byTenant: {
      index: "gsi1",
      collection: "TenantItems",
      type: "clustered",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["createdAt"] },
    },
    byEmail: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["email"] },
      sk: { field: "gsi2sk", composite: [] },
    },
  },
  unique: { email: ["email"] },
  timestamps: true,
  versioned: { retain: true },
  softDelete: true,
})
```

### Table — Declares Members

`Table` groups entities and aggregates that share a physical DynamoDB table and application namespace. It carries the `DynamoSchema` reference used for key prefix generation and the named records of its members. The physical table name is provided at runtime via `Table.layer()`.

```typescript
import { Table } from "effect-dynamodb"

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Users: UserEntity, Tasks: TaskEntity },
  aggregates: { Matches: MatchAggregate },
})
```

The named record keys (`Users`, `Tasks`, `Matches`) become the property names on the typed client returned by `DynamoClient.make()`.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `schema` | `DynamoSchema` | Yes | The application schema (provides key prefixing) |
| `entities` | `Record<string, Entity>` | No | Named entity definitions |
| `aggregates` | `Record<string, Aggregate>` | No | Named aggregate definitions |

### Runtime Configuration

The physical table name is injected at runtime via Effect Layers, keeping definitions pure and environment-independent:

```typescript
// Provide physical table name at the edge
MainTable.layer({ name: "my-prod-table" })

// Or from environment variables via Effect Config
MainTable.layerConfig({ name: Config.string("TABLE_NAME") })
```

### DynamoClient.make(table) — Typed Execution Gateway

`DynamoClient.make(table)` is the sole gateway for executing operations. It resolves infrastructure dependencies (`DynamoClient` service + `TableConfig`), binds all entities and aggregates registered on the table, and returns a typed client where every operation has `R = never`.

This follows the `HttpApiClient.make(api)` pattern from Effect v4: the table definition describes the shape (like `HttpApi` describes endpoints), and the client factory returns typed access to every member (like `HttpApiClient` returns typed access to every group).

```typescript
const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make(MainTable)

  // Entity operations — typed, R = never
  const user = yield* db.Users.get({ userId: "123" })
  yield* db.Users.put({ userId: "456", ... })

  // Aggregate operations — typed, R = never
  const match = yield* db.Matches.get({ matchId: "m-1" })

  // Table management
  yield* db.createTable()
  yield* db.deleteTable
  const info = yield* db.describeTable
})
```

The typed client provides:

| Property | Type | Description |
|----------|------|-------------|
| `db.<EntityName>` | `BoundEntity<...>` | Bound entity operations (get, put, create, update, delete, query, etc.) |
| `db.<AggregateName>` | `BoundAggregate<...>` | Bound aggregate operations (get, create, update, delete, list) |
| `db.createTable(options?)` | `Effect<void, DynamoClientError>` | Create the physical table (derives schema from members) |
| `db.deleteTable` | `Effect<void, DynamoClientError>` | Delete the physical table |
| `db.describeTable` | `Effect<DescribeTableOutput, DynamoClientError>` | Describe the table |

### Service Pattern

Wrap `DynamoClient.make(table)` in `Context.Service` for dependency injection and testability. Destructure to access only the entities you need:

```typescript
export class TeamService extends Context.Service<TeamService>()("@gamemanager/TeamService", {
  make: Effect.gen(function* () {
    const { Teams } = yield* DynamoClient.make(MainTable)
    return {
      create: Effect.fn(function* (input: CreateTeamInput) {
        const id = ulid() as TeamId
        return yield* Teams.put({ ...input, id })
      }),
      get: (id: TeamId) => Teams.get({ id }),
      update: (id: TeamId, updates: UpdateTeamInput) => Teams.update({ id }, updates),
      delete: (id: TeamId) => Teams.delete({ id }),
      list: (filter: TeamListFilter = {}, pagination?: PaginationOptions) =>
        Teams.execute(applyPagination(Teams.query.byAll(filter), pagination)).pipe(
          Effect.map((page) => ({
            data: page.items,
            count: page.items.length,
            cursor: page.cursor,
          })),
        ),
    }
  }),
}) {}
```

Testing — mock at the service level, no DynamoDB needed:

```typescript
program.pipe(
  Effect.provide(Layer.succeed(TeamService, {
    get: () => Effect.succeed(fakeTeam),
    create: () => Effect.succeed(fakeTeam),
    list: () => Effect.succeed({ data: [], count: 0, cursor: null }),
  }))
)
```

The entity definition still provides type derivation (`Entity.Record<typeof UserEntity>`, `Entity.Key<typeof UserEntity>`, etc.) without the client.

### Index Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `pk.field` | `string` | Yes | Physical DynamoDB attribute name |
| `pk.composite` | `string[]` | Yes | Ordered list of model attributes |
| `sk.field` | `string` | Yes | Physical DynamoDB attribute name |
| `sk.composite` | `string[]` | Yes | Ordered list of model attributes |
| `index` | `string` | No (primary only) | Physical GSI/LSI name from Table definition |
| `collection` | `string \| string[]` | No | Collection name(s) for cross-entity queries |
| `type` | `"isolated" \| "clustered"` | No | Collection type (default: `"clustered"`) |
| `casing` | `"lowercase" \| "uppercase" \| "preserve"` | No | Casing override for this index |

### System Fields

| Config | Type | Fields Added |
|--------|------|-------------|
| `timestamps: true` | `boolean \| { created: string, updated: string }` | `createdAt`, `updatedAt` (or custom names) |
| `versioned: true` | `boolean \| { field?: string, retain?: boolean, ttl?: Duration }` | `version` (or custom name) |
| `softDelete: true` | `boolean \| { ttl?: Duration, preserveUnique?: boolean }` | `deletedAt` (when soft-deleted) |

### Unique Constraints

```typescript
unique: {
  email: ["email"],                        // single-field uniqueness
  tenantEmail: ["tenantId", "email"],       // compound uniqueness
  idempotencyKey: { fields: ["idempotencyKey"], ttl: Duration.hours(1) },  // time-bounded
}
```

---

## 6. Entity-Derived Types

Seven types are automatically derived from the Model + Table + Entity declarations. Zero manual type maintenance.

### Type Hierarchy

```
Entity.Model<E>        Pure domain object (the Schema.Class itself)
    ↓ + system fields
Entity.Record<E>       Domain + system metadata (what Entity operations return)
    ↓ + key attributes
Entity.Item<E>         Full unmarshalled DynamoDB item
    ↓ + DynamoDB encoding
Entity.Marshalled<E>   DynamoDB AttributeValue format
```

### All Seven Types

```typescript
// Given UserEntity with timestamps: true, versioned: true

Entity.Model<typeof UserEntity>
// { userId: string, email: string, displayName: string, role: "admin" | "member" }

Entity.Record<typeof UserEntity>
// { userId: string, email: string, displayName: string, role: "admin" | "member",
//   version: number, createdAt: DateTime.Utc, updatedAt: DateTime.Utc }

Entity.Input<typeof UserEntity>
// { userId: string, email: string, displayName: string, role: "admin" | "member" }
// (no system fields — they are auto-managed)

Entity.Update<typeof UserEntity>
// { email?: string, displayName?: string, role?: "admin" | "member" }
// (keys excluded, immutable fields excluded, all optional)

Entity.Key<typeof UserEntity>
// { userId: string }
// (primary key composite attributes)

Entity.Item<typeof UserEntity>
// { pk: string, sk: string, gsi1pk: string, gsi1sk: string, gsi2pk: string, gsi2sk: string,
//   __edd_e__: string, userId: string, email: string, displayName: string, role: string,
//   version: number, createdAt: string, updatedAt: string }

Entity.Marshalled<typeof UserEntity>
// { pk: { S: string }, sk: { S: string }, gsi1pk: { S: string }, gsi1sk: { S: string },
//   __edd_e__: { S: string }, userId: { S: string }, email: { S: string },
//   version: { N: string }, createdAt: { S: string }, ... }
```

### Schema Accessors for Raw Data

For consuming DynamoDB Streams or working with raw items:

```typescript
Entity.itemSchema(UserEntity)
// Schema<Entity.Record<typeof UserEntity>, Entity.Item<typeof UserEntity>>

Entity.marshalledSchema(UserEntity)
// Schema<Entity.Record<typeof UserEntity>, Entity.Marshalled<typeof UserEntity>>
```

---

## 7. Key Composition

### Format Convention

**Format:** `${schema}#{version}#{prefix}#{attr1}#{attr2}`

- **Schema + version:** From `DynamoSchema` — e.g., `$myapp#v1`
- **Prefix:** Entity type (for entity keys) or collection name (for collection partition keys)
- **Attributes:** Values from composite array, in declared order, separated by `#`
- **Delimiter:** Always `#`

### Key Generation Rules

Given `DynamoSchema({ name: "myapp", version: 1, casing: "lowercase" })` and `entityType: "User"`:

| pk composite | sk composite | Generated pk | Generated sk |
|-------------|-------------|-------------|-------------|
| `[]` | `[]` | `$myapp#v1#user` | `$myapp#v1#user` |
| `["userId"]` | `[]` | `$myapp#v1#user#abc-123` | `$myapp#v1#user` |
| `[]` | `["userId"]` | `$myapp#v1#user` | `$myapp#v1#user#abc-123` |
| `["tenantId"]` | `["userId"]` | `$myapp#v1#user#t-1` | `$myapp#v1#user#abc-123` |
| `["tenantId"]` | `["status", "createdAt"]` | `$myapp#v1#user#t-1` | `$myapp#v1#user#active#2024-01-15` |

### Attribute Serialization

| Type | Serialization |
|------|---------------|
| `string` | As-is |
| `number` | Zero-padded to fixed width |
| `DateTime.Utc` | ISO 8601 string |
| `boolean` | `"true"` / `"false"` |
| Branded string | Underlying string value |

### Isolated vs Clustered Key Prefixes

**Isolated:**
```
SK = ${schema}#{version}#{entityType}_{entityVersion}#{composites}
```

**Clustered:**
```
SK = ${schema}#{version}#{collectionName}#{entityType}_{entityVersion}#{composites}
```

**Clustered with sub-collections:**
```
SK = ${schema}#{version}#{parentCollection}#{childCollection}#{entityType}_{entityVersion}#{composites}
```

### Special Key Patterns

**Unique constraint sentinel:**
```
PK: ${schema}#{version}#{entityType}.{constraintName}#{fieldValues}
SK: ${schema}#{version}#{entityType}.{constraintName}
```

**Version snapshot:**
```
PK: (same as current item)
SK: ${schema}#{version}#{entityType}#v#{zeroPaddedVersion}
```

**Soft-deleted item:**
```
PK: (same as current item)
SK: ${schema}#{version}#{entityType}#deleted#{isoTimestamp}
```

### Policy-Aware GSI Composition (update & append)

**Problem.** GSI composite attributes can be owned by different writers ("hybrid GSIs"). A device-ingest writer owns `timestamp` + `alertState`; an enrichment writer owns `accountId`. A GSI with composites `[accountId, alertState]` on one half and `[timestamp]` on the other is touched by *every* ingest event (via `timestamp`), but the ingest writer can't supply `accountId` without an extra read. Three semantically distinct intents share one signal ("composite X is absent from the update payload"):

| Intent | Library action | Stored key attr |
|---|---|---|
| **Sparse** — item no longer belongs in this GSI | `REMOVE gsiNpk, gsiNsk` | Deleted |
| **Preserve** — another writer owns this composite; leave alone | Do not touch `gsiNpk`/`gsiNsk` | Untouched |
| **Recompose** — all composites present | SET both keys | Rewritten |

**API.** Each GSI may declare an `indexPolicy`:

```ts
indexes: {
  byAccountAlert: {
    name: "gsi6",
    pk: { field: "gsi6pk", composite: ["accountId", "alertState"] },
    sk: { field: "gsi6sk", composite: ["timestamp"] },
    indexPolicy: (item) => ({
      accountId:  "preserve",   // enrichment-owned, ingest never touches
      alertState: "preserve",   // set on alert events; plain ingest doesn't touch
      timestamp:  "sparse",     // if somehow absent, drop from GSI
    }),
  },
}
```

- Per-attribute map of composite attr → `'sparse' | 'preserve'`.
- Default for any composite not returned by the function (or when no function is declared): `'preserve'`.
- Only `'sparse'` and `'preserve'` are valid values. There is no `'required'` policy; consumers who want strict caller-error validation enforce it in their own update layer.

**Decision rules.** For each GSI touched by an update/append, given merged payload `M = { ...primaryKey, ...payload }`:

1. Resolve per-composite policy: `p(a) = indexPolicy?.(M)?.[a] ?? "preserve"`.
2. Classify each composite `a`:
   - `present` if `a` in `M` and `M[a]` is not null/undefined.
   - `missing-sparse` if absent and `p(a) === "sparse"`.
   - `missing-preserve` if absent and `p(a) === "preserve"`.
3. Decide the GSI's fate:
   - **Any `missing-sparse`** → REMOVE `gsiNpk` and `gsiNsk`. Sparse wins.
   - **All composites present** → SET both halves (recompose).
   - **Mixed (some `missing-preserve`, no `missing-sparse`)** → evaluate pk and sk *independently*:
     - Half fully present → SET that half.
     - Half has a `missing-preserve` composite → leave that half alone (no SET, no REMOVE). This avoids the `acc#undefined` garbage that partial rewriting would produce.

**`Entity.remove([attr])` cascade.** When an update's REMOVE list contains a composite attribute, the whole GSI is dropped (REMOVE both keys) regardless of `indexPolicy`. This is existing behavior and takes precedence — `remove(["tenantId"])` means "the item no longer belongs in the tenant index."

**Touched gate.** A GSI is only processed if at least one of its composites is in the update payload *or* in the REMOVE list. Updates that don't touch any composite of a GSI leave it alone. `indexPolicy` is consulted only when the GSI is touched.

**`put()` semantics (unchanged).** `put()` does not consult `indexPolicy`. It writes a complete item from scratch — any missing composite means "this item is not in that GSI." The existing `tryComposeIndexKeys` path (omit GSI keys when any composite is absent) is preserved as-is. `indexPolicy` exists specifically to resolve the update/append ambiguity, not the put case.

**`.append()` semantics (time-series).** `indexPolicy` applies. The policy function is invoked with `item = { ...primaryKey, ...appendInput }` — not a merged current item (append intentionally does no read). Two constraints enforced at `Entity.make()`:

1. Returned policy keys must be composites of the GSI (same check as update).
2. At append, returned keys must additionally be members of `appendInput`. Composites outside `appendInput` cannot have policy at append-time — they are by contract never changed by an append, and their half is always either (a) untouched (preserve default) if partial, or (b) fully recomposed if the other half's composites are all in appendInput.

The library-managed REMOVE of `gsiNpk`/`gsiNsk` on sparse-policy dropout *does* write fields outside `appendInput`, but those are key-management fields, not user data — the `appendInput` enrichment-preservation contract applies to user-data fields only.

**Decision table (worked).** GSI with `pk.composite = [A]`, `sk.composite = [B, C]`:

| Policy | Payload | Result |
|---|---|---|
| no policy | `{A, B, C}` | SET both halves |
| no policy | `{A}` | SET pk; sk untouched |
| no policy | `{B}` | pk untouched; sk untouched (C missing, preserve) |
| no policy | `{B, C}` | pk untouched; SET sk |
| `A: 'sparse'` | `{B, C}` | REMOVE both (A missing sparse) |
| `B: 'sparse', C: 'preserve'` | `{A, C}` | REMOVE both (B missing sparse) |
| `A: 'preserve'` explicit | `{B, C}` | pk untouched; SET sk (same as default) |
| cascade: REMOVE `[A]` | any | REMOVE both (cascade overrides policy) |

---

## 8. Date & Time Handling

### Three-Layer Model

Every date field passes through three representations:

```
Wire (external)  →  decode  →  Domain (application)  →  encode  →  Storage (DynamoDB)
```

| Layer | What it is | Who controls it |
|-------|-----------|-----------------|
| Wire | JSON-compatible format clients send/receive | Consumer (via schema's Encoded type) |
| Domain | Rich type the application works with | Schema's Type |
| Storage | DynamoDB attribute format | Library (via annotation) |

### Domain Types

| Domain type | What it carries | Use case |
|-------------|----------------|----------|
| `DateTime.Utc` | UTC instant (immutable, Effect-native) | Default for all UTC date fields |
| `DateTime.Zoned` | UTC instant + timezone (immutable) | Scheduling, audit, TZ-aware display |
| `Date` | UTC instant (mutable, native JS) | Interop with non-Effect libraries |

### Consumer API

#### Date Schemas (domain type: `DateTime.Utc`)

```typescript
import { DynamoModel } from "effect-dynamodb"

DynamoModel.DateString              // Wire: ISO string ↔ Domain: DateTime.Utc
DynamoModel.DateEpochMs             // Wire: epoch milliseconds ↔ Domain: DateTime.Utc
DynamoModel.DateEpochSeconds        // Wire: epoch seconds ↔ Domain: DateTime.Utc
```

#### Unsafe Date Schemas (domain type: `Date`)

```typescript
DynamoModel.UnsafeDateString        // Wire: ISO string ↔ Domain: Date (mutable)
DynamoModel.UnsafeDateEpochMs       // Wire: epoch milliseconds ↔ Domain: Date (mutable)
DynamoModel.UnsafeDateEpochSeconds  // Wire: epoch seconds ↔ Domain: Date (mutable)
```

#### Timezone-Aware Schemas (domain type: `DateTime.Zoned`)

```typescript
DynamoModel.DateTimeZoned           // Wire: ISO string with offset/zone ↔ Domain: DateTime.Zoned
```

### Storage Override

When wire format ≠ storage format, use `storedAs` with a target schema:

```typescript
// Wire: ISO string, DynamoDB: epoch seconds (for TTL)
DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))

// Wire: epoch ms, DynamoDB: ISO string
DynamoModel.DateEpochMs.pipe(DynamoModel.storedAs(DynamoModel.DateString))
```

**Type safety:** `storedAs` constrains the storage schema to have the same domain type (`A`) as the field schema. Incompatible combinations are rejected at compile time.

### Auto-Detecting Epoch Schema

```typescript
DynamoModel.DateEpoch(options: {
  minimum: string | DateTime.DateTime.Input
  encode?: typeof DynamoModel.DateEpochMs | typeof DynamoModel.DateEpochSeconds
})
```

### TTL Alias

```typescript
DynamoModel.TTL                     // alias for DateEpochSeconds
```

### Usage Examples

```typescript
class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  placedAt: DynamoModel.DateString,
  expiresAt: DynamoModel.DateString.pipe(
    DynamoModel.storedAs(DynamoModel.DateEpochSeconds)
  ),
  timestamp: DynamoModel.DateEpochMs,
  ttl: DynamoModel.TTL,
  clientTimestamp: DynamoModel.DateEpoch({ minimum: "2020-01-01" }).pipe(
    DynamoModel.storedAs(DynamoModel.DateEpochSeconds)
  ),
  scheduledAt: DynamoModel.DateTimeZoned,
}) {}
```

### Sort Key Behavior

**Rule: Keys always normalize to UTC. Attributes preserve the original format.**

| Schema | In sort key | In attribute |
|--------|------------|--------------|
| `DateString` | UTC ISO string | UTC ISO string |
| `DateEpochMs` | Epoch ms number | Epoch ms number |
| `DateEpochSeconds` | Epoch seconds number | Epoch seconds number |
| `DateTimeZoned` | UTC ISO string (normalized) | Extended ISO with zone |

### Domain Model Purity

The library supports two patterns for where storage configuration lives:

**Pattern A: Annotated Model (Inline)** — DynamoModel schemas carry invisible annotations. Everything in one place.

```typescript
class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  placedAt: DynamoModel.DateString,
  expiresAt: DynamoModel.DateString.pipe(
    DynamoModel.storedAs(DynamoModel.DateEpochSeconds)
  ),
}) {}
```

**Pattern B: Pure Model + Configured Model** — Domain model uses standard Effect schemas. Storage mapping is separate.

```typescript
class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  placedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
}) {}

const OrderModel = DynamoModel.configure(Order, {
  expiresAt: { storedAs: DynamoModel.DateEpochSeconds },
})

const OrderEntity = Entity.make({
  model: OrderModel,
  entityType: "Order",
  indexes: { ... },
})
```

### Complete API Surface

#### Schemas

| Export | Wire (Encoded) | Domain (Type) | Default Storage |
|--------|---------------|---------------|-----------------|
| `DynamoModel.DateString` | `string` | `DateTime.Utc` | ISO string |
| `DynamoModel.DateEpochMs` | `number` | `DateTime.Utc` | epoch ms |
| `DynamoModel.DateEpochSeconds` | `number` | `DateTime.Utc` | epoch seconds |
| `DynamoModel.DateEpoch(opts)` | `number` | `DateTime.Utc` | matches `encode` option |
| `DynamoModel.DateTimeZoned` | `string` | `DateTime.Zoned` | extended ISO with zone |
| `DynamoModel.UnsafeDateString` | `string` | `Date` | ISO string |
| `DynamoModel.UnsafeDateEpochMs` | `number` | `Date` | epoch ms |
| `DynamoModel.UnsafeDateEpochSeconds` | `number` | `Date` | epoch seconds |
| `DynamoModel.TTL` | `number` | `DateTime.Utc` | epoch seconds |

#### Modifiers

| Export | Description |
|--------|-------------|
| `DynamoModel.storedAs(schema)` | Override DynamoDB storage format via schema annotation (Pattern A) |
| `DynamoModel.configure(model, attributes)` | Create a configured model with per-field storage overrides and field renaming (Pattern B) |
| `DynamoModel.configure({ immutable: true })` | Mark field as read-only after creation |

---

## 9. Collections

### Overview

Collections group multiple entity types for cross-entity queries. Two collection modes are supported:

| Mode | SK ownership | Query mechanism | Use case |
|------|-------------|-----------------|----------|
| **Isolated** | Each entity owns its SK prefix | PK match only (no SK condition) | High-volume single-entity queries |
| **Clustered** (default) | Collection owns SK prefix | `begins_with` on collection prefix | Cross-entity queries, relationship-dense data |

### Isolated Collections

In isolated mode, each entity's sort key starts with its own entity type prefix. The collection query uses only the partition key — no sort key condition.

### Clustered Collections

In clustered mode, the collection name sits at the top of the sort key. All entity types share this prefix, enabling efficient cross-entity queries with `begins_with`.

### Sub-Collections (Clustered Only)

Sub-collections create a hierarchy within the sort key, enabling queries at any depth. An entity declares membership in multiple collections via an array:

```typescript
collection: ["contributions", "assignments"],  // sub-collection
```

### Collection Definition

```typescript
import { Collection } from "effect-dynamodb"

const TenantItems = Collection.make("TenantItems", {
  users: UserEntity,
  orders: OrderEntity,
})
```

### Validation Rules

- All entities in a collection must share the same PK composite on that index.
- All entities sharing an index must agree on the type (cannot mix isolated and clustered).
- Sub-collection members must include parent: `["contributions", "assignments"]` means the entity is in both.
- All collection members must be on the same table.

---

## 10. Queries & Operations

### Pipeable Query API

Queries are composable data types following Effect TS idioms. A `Query<A>` is a pure description — no DynamoDB calls occur until a terminal combinator (`execute` or `paginate`) interprets it.

```typescript
// 1. Construct — sets partition key
TenantItems.query({ tenantId: "t-1" })

// 2. Narrow — entity selector
TenantItems.users

// 3. Key condition — KeyConditionExpression (efficient, uses the index)
Query.where({ status: "active", createdAt: { gte: someDate } })

// 4. Filter — FilterExpression (post-scan, doesn't reduce read capacity)
Query.filter({ email: { contains: "@company.com" } })

// 5. Shape — pagination, ordering
Query.limit(10)
Query.reverse    // scanForward = false

// 6. Execute — terminal, crosses into Effect
Query.execute    // Query<A> => Effect<A, DynamoError, DynamoClient>
Query.paginate   // Query<A> => Effect<Stream<A>, DynamoError, DynamoClient>
```

### Entity Operations (via typed client)

All operations are accessed through the typed client returned by `DynamoClient.make(table)`. The client binds all entities and aggregates, providing operations with `R = never`.

#### Read Operations

```typescript
const db = yield* DynamoClient.make(MainTable)

yield* db.Users.get({ userId: "abc-123" })

const results = yield* db.Users.execute(
  Users.query.byTenant({ tenantId: "t-1" }).pipe(
    Query.where({ createdAt: { gte: lastWeek } }),
    Query.limit(25),
  )
)
```

#### Write Operations

```typescript
yield* db.Users.put({ userId: "abc-123", email: "alice@example.com", displayName: "Alice", role: "admin" })
yield* db.Users.update({ userId: "abc-123" }, { displayName: "Alice B" })
```

#### Lifecycle Operations

```typescript
yield* db.Users.delete({ userId: "abc-123" })     // soft delete (when enabled)
yield* db.Users.restore({ userId: "abc-123" })    // restore soft-deleted item
yield* db.Users.purge({ userId: "abc-123" })      // permanent delete
yield* db.Users.getVersion({ userId: "abc-123" }, 3)  // get specific version
yield* db.Users.versions({ userId: "abc-123" })   // query version history
yield* db.Users.deleted.get({ userId: "abc-123" })    // get soft-deleted item
yield* db.Users.deleted.list()                        // list all soft-deleted items
```

### Data Integrity

#### Unique Constraints

Enforcement uses sentinel items with transactional writes:

| Operation | Transaction Items |
|-----------|-------------------|
| Put | Entity item + sentinel per unique field (`condition: attribute_not_exists(pk)`) |
| Update (unique field changed) | Entity item + delete old sentinel + put new sentinel |
| Delete | Entity item + delete sentinel per unique field |

#### Optimistic Concurrency

When `versioned` is enabled, updates can include an expected version:

```typescript
db.Users.update(key, changes, { expectedVersion: 5 })
// Adds ConditionExpression: version = :expected
// Fails with OptimisticLockError if version doesn't match
```

### Entity Lifecycle

#### Soft Delete

When `softDelete` is configured, `db.Users.delete()` performs a logical deletion:

1. Modifies the sort key: `$myapp#v1#user` → `$myapp#v1#user#deleted#<timestamp>`
2. Removes all GSI key attributes (item falls out of all indexes)
3. Adds `deletedAt` timestamp
4. Optionally sets DynamoDB TTL for auto-purge

#### Version Retention

When `versioned: { retain: true }`, every mutation stores a snapshot of the previous state as a separate item. All versions are co-located with the current item (same partition key).

### DynamoClient

The `DynamoClient` service provides:

| Operation | Used By |
|-----------|---------|
| `putItem` | Entity writes |
| `getItem` | Entity reads |
| `deleteItem` | Entity deletes |
| `query` | Entity queries, version history, soft-deleted list |
| `updateItem` | Entity updates (partial, atomic version increment) |
| `transactWriteItems` | Unique constraints, versioned writes |
| `transactGetItems` | Batch reads with consistency |
| `batchGetItem` | Batch operations |
| `batchWriteItem` | Batch operations |

Runtime configuration via Effect Layers:

```typescript
// Direct configuration
DynamoClient.layer({ region: "us-east-1" })
MainTable.layer({ name: "my-prod-table" })

// Config-based (reads from environment variables)
DynamoClient.layerConfig({ region: Config.string("AWS_REGION") })
MainTable.layerConfig({ name: Config.string("TABLE_NAME") })
```

---

## 11. Aggregates & Relational Patterns

### Problem

DynamoDB single-table designs frequently model rich domain objects as multiple denormalized items sharing a partition key. Building and maintaining these structures requires enormous manual effort:

1. **Denormalized references** — Junction items embed full copies of related entities. Creating/updating requires manual hydration.
2. **Context attribute propagation** — Parent-level attributes are copied into every child item to enable sort-key queries.
3. **Aggregate assembly** — Reading an aggregate requires a collection query followed by manual discrimination, reduction, and deep-merge.
4. **Aggregate mutation** — Updating a nested field requires deep destructuring, manual array manipulation, reconstruction, validation, and transactional write.
5. **Cascade updates** — When denormalized data changes at the source, all items that embed that entity must be found and updated.

A production cricket match management system built on ElectroDB demonstrates these patterns at scale — 17 model files, 16 service files, a ~1,100 line MatchService, and ~120 lines to update one player within a match. These patterns are universal to DynamoDB single-table designs.

### Concepts

**Edge Entity** — A first-class entity representing a relationship within an aggregate's partition. For example, `MatchVenueEntity` represents the Match<>Venue relationship, with `matchId` + `venueId` in its primary key. Edge entities may embed denormalized data from referenced entities (e.g., venue name, city). They are real entities with their own models, indexes, and configuration — not implicit decomposition targets.

**Ref** — A reference to an external entity whose data is denormalized into an edge entity at write time. The aggregate framework handles hydration: on create/update it fetches the referenced entity (e.g., `VenueEntity.get({ venueId })`) and embeds its domain data into the edge entity (e.g., `MatchVenue`). On read, the data is already materialized — no ref lookups needed.

**Context** — Fields on the aggregate's domain schema that must be propagated to every edge entity item in DynamoDB for query support. Defined once at the aggregate level.

**Aggregate** — A domain object composed of multiple entity types that share a partition key. The aggregate orchestrates Entity, Collection, and Transaction primitives — it never touches DynamoClient directly. The underlying structure is a directed acyclic graph (DAG) where nodes are entity types and edges are relationships with cardinality.

**Optics** — Effect v4's `effect/Optic` library solves aggregate mutation: instead of manual destructuring, an optic navigates to the target and produces an updated aggregate immutably.

### Edge Entities

Edges in an aggregate are **explicit first-class entities**, not implicit constructs. Each edge entity has its own model, primary key, indexes, and configuration:

```typescript
// Edge entity model — includes relationship keys + denormalized ref data
class MatchVenue extends Schema.Class<MatchVenue>("MatchVenue")({
  matchId: Schema.String,
  venueId: Schema.String,
  name: Schema.String,        // denormalized from Venue
  city: Schema.String,        // denormalized from Venue
  capacity: Schema.Number,    // denormalized from Venue
}) {}

// Edge entity — real entity with keys, timestamps, versioning
const MatchVenueEntity = Entity.make({
  model: MatchVenue,
  entityType: "MatchVenue",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["matchId"] },
      sk: { field: "sk", composite: ["venueId"] },
    },
  },
  timestamps: true,
})
```

DynamoDB partition layout for a Match aggregate:

```
PK = $cricket#v1#match#m-1

  SK = $cricket#v1#match                          → MatchEntity (root)
  SK = $cricket#v1#match_venue#v-1                → MatchVenueEntity (one-edge)
  SK = $cricket#v1#match_team#teamNumber#1        → MatchTeamEntity (one-edge, discriminated)
  SK = $cricket#v1#match_team#teamNumber#2        → MatchTeamEntity (one-edge, discriminated)
  SK = $cricket#v1#match_player#p-1               → MatchPlayerEntity (many-edge)
  SK = $cricket#v1#match_player#p-2               → MatchPlayerEntity (many-edge)
```

### DynamoModel.ref — Denormalized Reference Annotation

`DynamoModel.ref` marks a field as a denormalized reference in edge entity models:

```typescript
class MatchPlayer extends Schema.Class<MatchPlayer>("MatchPlayer")({
  matchId: Schema.String,
  playerId: Schema.String,
  player: Player.pipe(DynamoModel.ref),   // denormalized Player data
  isCaptain: Schema.Boolean,
}) {}
```

When Entity encounters a `ref`-annotated field:

| Derived Type | Behavior |
|---------|----------|
| `Entity.Input<E>` | Ref field becomes its ID type (`player: Player` → `playerId: string`) |
| `Entity.Record<E>` | Ref field is the full entity domain type (`player: Player`) |
| `Entity.Update<E>` | Ref field becomes optional ID (`playerId?: string`) |
| DynamoDB storage | Core domain data stored as embedded map attribute |
| Create/Put | Entity auto-hydrates: receives ID → fetches entity → embeds domain data |

### Aggregate.make() — Graph-Based Composite Domain Model

The consumer defines the aggregate's domain shape as a pure Schema.Class hierarchy, then `Aggregate.make` binds it to a graph of underlying edge entities:

```typescript
const MatchAggregate = Aggregate.make(Match, {
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: [...] } },
  context: ["name", "gender", "matchType", "league", "series", "season", "startDate"],
  root: MatchEntity,

  edges: {
    venue:   Aggregate.one(MatchVenueEntity, { ref: VenueEntity }),
    team1:   TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
    team2:   TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
    umpires: Aggregate.many(MatchUmpireEntity, { ref: UmpireEntity }),
  },
})
```

**Edge types:**
- `Aggregate.one(EdgeEntity, { ref? })` — one-to-one edge entity. Optional `ref` specifies the external entity to hydrate/denormalize from.
- `Aggregate.many(EdgeEntity, { ref? })` — one-to-many edge entities. One DynamoDB item per element.
- **BoundSubAggregate** — sub-tree with discriminator for reuse (e.g., `TeamSheetAggregate.with(...)`)

### Aggregate Operations via Typed Client

Aggregates registered on a table are accessible through the typed client, alongside entities:

```typescript
const MainTable = Table.make({
  schema: AppSchema,
  entities: { Teams: TeamEntity, Players: PlayerEntity, Venues: VenueEntity },
  aggregates: { Matches: MatchAggregate },
})

const db = yield* DynamoClient.make(MainTable)

// Aggregate operations — typed, R = never
const match = yield* db.Matches.get({ matchId: "m-1" })
yield* db.Matches.create({ matchId: "m-2", venueId: "v-1", ... })
```

Internally, `DynamoClient.make` resolves `DynamoClient` service + `TableConfig` once and binds:
- All entities (root + edge + ref entities from all aggregates)
- All aggregates

As a service for testability:

```typescript
class MatchService extends Context.Service<MatchService>()("@gamemanager/MatchService", {
  make: Effect.gen(function* () {
    const { Matches } = yield* DynamoClient.make(MainTable)
    return {
      get: (matchId: string) => Matches.get({ matchId }),
      create: Effect.fn(function* (input: CreateMatchInput) {
        return yield* Matches.create(input)
      }),
    }
  }),
}) {}
```

### Assembly (Read Path)

Aggregates compose entity operations for reads — they never query DynamoDB directly:

```
db.Matches.get({ matchId: "m-1" })
  → Collection query (all items in partition, decoded per entity schema)
  → Discriminate by __edd_e__ + discriminator into edge entity buckets
  → Assemble in topological order (leaves first) into domain object
  → Return as Schema.Class instance
  // No ref lookups — data already denormalized in edge entities
```

### Decomposition (Write Path)

On create/update, the aggregate decomposes the domain object into entity operations with write-time ref hydration:

```
db.Matches.create({ matchId: "m-2", venueId: "v-1", teams: [...], players: [...] })
  → Ref hydration: VenueEntity.get({ venueId: "v-1" }) → { name: "MCG", city: "Melbourne", ... }
  → Denormalize: MatchVenue = { matchId, venueId, name: "MCG", city: "Melbourne", capacity: 100000 }
  → Decompose all edges into entity inputs
  → Transaction.transactWrite(
      MatchEntity.put(rootItem),
      MatchVenueEntity.put({ matchId, venueId, name: "MCG", city: "Melbourne", capacity: 100000 }),
      MatchTeamEntity.put(team1),
      MatchTeamEntity.put(team2),
      MatchPlayerEntity.put(player1),
      ...
    )
```

**Update with diff:**

```
db.Matches.update({ matchId: "m-1" }, mutation)
  → current = db.Matches.get({ matchId: "m-1" })       // entity-based fetch
  → next = mutation(current)                              // optic-powered mutation
  → diff(current, next)
  → Re-hydrate changed refs (e.g., venueId changed → fetch new Venue)
  → Transaction.transactWrite(
      MatchVenueEntity.delete(oldVenueKey),              // removed edge
      MatchVenueEntity.put(newVenueItem),                // added edge (with denormalized data)
      MatchPlayerEntity.update(changedPlayerKey, changes), // modified edge
    )
```

**Transaction Decomposition:** Each sub-aggregate is a transactional unit, keeping transactions well within DynamoDB's 100-item limit.

### Optic-Powered Mutations

The aggregate exposes optics derived from its Schema.Class for immutable updates:

```typescript
const db = yield* DynamoClient.make(MainTable)

yield* db.Matches.update({ matchId: "match-123" }, ({ cursor }) =>
  cursor
    .key("team1").key("players").at(0)
    .modify((s) => ({ ...s, isCaptain: true }))
)
```

The `update` mutation context provides: `state` (plain object), `cursor` (pre-bound optic), `optic` (composable optic), `current` (Schema.Class instance).

### Cascade Updates

When a source entity changes, all items that embed it via `ref` must be updated:

```typescript
const { Players } = yield* DynamoClient.make(MainTable)
yield* Players.provide(
  PlayerEntity.update({ playerId: "player-smith" }).pipe(
    Entity.set({ displayName: "Steven Smith" }),
    Entity.cascade({ targets: [MatchPlayerEntity] }),
  ).asEffect()
)
```

**Explicit targets required.** No implicit discovery. Default mode is eventual consistency (batch writes). Transactional mode available for small datasets.

### Aggregate vs Collection

| Capability | Collection | Aggregate |
|-----------|-----------|-----------|
| Multi-entity query | Yes | Yes (uses Collection internally) |
| Domain shape assembly | No | Yes — returns Schema.Class instance |
| Decomposition (write) | No | Yes — walks edge entity graph |
| Write-time ref hydration | No | Yes — fetches + denormalizes ref entities |
| Context propagation | No | Yes |
| Optics | No | Yes |
| Diff-based updates | No | Yes — only changed edges written |
| Transaction boundaries | No | Yes — sub-aggregate = transaction unit |

### Implementation Notes

**Behavioral Notes:**
- `Aggregate.update` handles orphaned items when reducing a many-edge array via diff-based delete operations.
- Both `"eventual"` (default) and `"transactional"` cascade modes are supported.
- Edge entities inherit all entity features: versioning, timestamps, unique constraints, soft delete.

**Deferred Features:**
- Pre-built graph-edge optics (generic `.key()` chains cover the same use cases)
- `Aggregate.Input` type extractor (recursive ref→ID transformation)
- Computed discriminators (only static literal discriminators supported)

---

## 12. EventStore

### Overview

`EventStore` provides typed, Effect-native event sourcing on DynamoDB. It implements the Decider pattern (command → events → state) with stream-based event persistence.

### Client Gateway Pattern

EventStore definitions are registered on a table and accessed through the typed client, just like entities and aggregates:

```typescript
// Definition — no executable operations
const MatchEvents = EventStore.makeStream({
  streamName: "Match",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
})

// Register on table
const EventsTable = Table.make({
  schema: EventSchema,
  eventStores: { MatchEvents },
})

// Access through typed client
const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make(EventsTable)
  yield* db.MatchEvents.append({ matchId: "m-1" }, [new MatchStarted({ venue: "MCG" })], 0)
  const events = yield* db.MatchEvents.read({ matchId: "m-1" })
  const version = yield* db.MatchEvents.currentVersion({ matchId: "m-1" })
})
```

As a service:

```typescript
class MatchEventStream extends Context.Service<MatchEventStream>()("@gamemanager/MatchEventStream", {
  make: Effect.gen(function* () {
    const { MatchEvents } = yield* DynamoClient.make(EventsTable)
    return MatchEvents
  }),
}) {}
```

### Command Handler

The `commandHandler` combinator implements the read-decide-append cycle:

```typescript
const { MatchEvents } = yield* DynamoClient.make(EventsTable)
const handler = MatchEvents.commandHandler(MatchDecider)
const result = yield* handler({ matchId: "m-1" }, new StartMatch({ venue: "MCG" }))
// result: { state, version, events }
```

---

## 13. GeoIndex (effect-dynamodb-geo)

### Overview

`GeoIndex` provides geospatial indexing and radius-based proximity search using H3 hexagonal grid. It wraps an entity with automatic geo field enrichment on writes and multi-cell parallel query on reads.

### Client Gateway Pattern

GeoIndex definitions are registered on a table and accessed through the typed client:

```typescript
// Definition — binds geo config to entity definition
const VehicleGeo = GeoIndex.make({
  entity: VehiclesEntity,
  index: "byCell",
  coordinates: (item) => ({ latitude: item.latitude, longitude: item.longitude }),
  fields: {
    cell: { field: "cell", resolution: 15 },
    parentCell: { field: "parentCell", resolution: 3 },
    timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
  },
})

// Register on table
const MainTable = Table.make({
  schema: AppSchema,
  entities: { Vehicles: VehiclesEntity },
  geoIndexes: { VehicleGeo },
})

// Access through typed client
const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make(MainTable)
  yield* db.VehicleGeo.put({ vehicleId: "v-1", latitude: 37.77, longitude: -122.42, timestamp: now })
  const results = yield* db.VehicleGeo.nearby({ center, radius: 2000, unit: "m" })
})
```

As a service:

```typescript
class VehicleSearch extends Context.Service<VehicleSearch>()("@fleet/VehicleSearch", {
  make: Effect.gen(function* () {
    const { VehicleGeo } = yield* DynamoClient.make(MainTable)
    return VehicleGeo
  }),
}) {}
```

### Layering

GeoIndex composes Entity operations (for writes) and Query (for reads). It adds geo field enrichment and multi-cell search orchestration on top:

```
db.VehicleGeo.put(input)
  → enrich(input)           // compute H3 cell, parent cell, time partition
  → Entity.put(enriched)    // delegate to entity

db.VehicleGeo.nearby(options)
  → compute search cells    // H3 ring + prune
  → build N queries          // one per (timePartition, cell chunk)
  → execute in parallel     // via Query module
  → post-process            // distance filter + sort
```

---

## 14. Error Types

### Complete Error Taxonomy

| Error | Cause |
|-------|-------|
| `DynamoError` | AWS SDK error wrapper |
| `ItemNotFound` | GetItem returned no item |
| `ConditionalCheckFailed` | ConditionExpression failed |
| `ValidationError` | Schema decode/encode failure |
| `TransactionCancelled` | Transaction failed with cancellation reasons |
| `UniqueConstraintViolation` | Sentinel item already exists for unique field |
| `OptimisticLockError` | Version mismatch on update |
| `RefNotFound` | Referenced entity does not exist during hydration |
| `AggregateAssemblyError` | Collection query returned unexpected/incomplete data |
| `AggregateDecompositionError` | Decomposition produced items that fail schema validation |
| `AggregateTransactionOverflow` | Sub-aggregate exceeds 100-item transaction limit |
| `CascadePartialFailure` | Cascade update partially failed (eventual mode) |

### Error Type Narrowing

Operation signatures narrow error types based on Entity configuration:

```typescript
const db = yield* DynamoClient.make(MainTable)

// Entity without unique constraints or versioning
db.Users.put(input)
// Effect<Entity.Record<E>, DynamoError, never>

// Entity with unique constraints
db.Users.put(input)
// Effect<Entity.Record<E>, DynamoError | UniqueConstraintViolation, never>

// Update with optimistic locking
db.Users.update(key, changes, { expectedVersion: 5 })
// Effect<Entity.Record<E>, DynamoError | ItemNotFound | OptimisticLockError, never>
```

---

## Appendix A: Migration Guide (v1 → v2 → v3)

### v2 → v3: Client Gateway Migration

| v2 (bind pattern) | v3 (client gateway) |
|--------------------|---------------------|
| `Entity.make({ model, table: MainTable, ... })` | `Entity.make({ model, ... })` — no `table` |
| `Table.make({ schema })` | `Table.make({ schema, entities: { Users }, aggregates: { Matches } })` |
| `yield* Entity.bind(Users)` | `const { Users } = yield* DynamoClient.make(MainTable)` |
| `yield* Aggregate.bind(MatchAggregate)` | `const { Matches } = yield* DynamoClient.make(MainTable)` |
| `yield* Table.bind(MainTable)` → `table.create([Users])` | `db.createTable()` |
| `yield* EventStore.bind(MatchEvents)` | `const { MatchEvents } = yield* DynamoClient.make(EventsTable)` |
| `yield* GeoIndex.bind(VehicleGeo)` | `const { VehicleGeo } = yield* DynamoClient.make(MainTable)` |

### v1 → v2: Module-by-Module Mapping

| v1 Module | v2 Module | Changes |
|-----------|-----------|---------|
| `DynamoModel.ts` | `DynamoModel.ts` | Annotations (Hidden, identifier, ref) and `configure()` for per-field overrides (immutable, field rename, storedAs). Models use `Schema.Class`. |
| `Table.ts` | `Table.ts` | Stripped to `schema` ref only. Physical name via `Table.layer()`. Key structure derived from entities. |
| `Entity.ts` | `Entity.ts` | Major redesign: ElectroDB-style indexes, system fields, unique constraints, collections. |
| `KeyComposer.ts` | `KeyComposer.ts` | Rewritten: attribute-list composition, convention-based format, casing rules. |
| `EntityRepository.ts` | Merged into `Entity.ts` | Operations are now methods on the Entity object. No separate repository. |
| `Collection.ts` | `Collection.ts` | Typed entity selectors, pipeable queries, isolated/clustered modes. |
| `Transaction.ts` | Absorbed into Entity | Transactions are now internal to Entity operations. |
| `DynamoClient.ts` | `DynamoClient.ts` | Adds `updateItem` operation. |
| — | `DynamoSchema.ts` | **New**: Application namespace and versioning. |
| — | `Query.ts` | **New**: Pipeable query data type with combinators. |

## Appendix B: Full Walkthrough — Multi-Tenant SaaS

See `walkthrough.md` for a complete walkthrough demonstrating a multi-tenant project management system with three entities: Tenant, Employee, and Task, exercising all major features.
