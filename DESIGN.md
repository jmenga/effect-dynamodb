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

Constraints are **sparse**: a sentinel is only written when every composing
field is present on the record. Mirrors GSI sparse semantics — a record with a
missing optional composite is silently excluded from the constraint, allowing
multiple records to coexist with the field unset (no false collision on a
literal `"undefined"` key). Update transitions claim/release the sentinel as
the field becomes set/unset.

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

**Problem.** GSI composite attributes can be owned by different writers ("hybrid GSIs"). A device-ingest writer owns `timestamp` + `alertState`; an enrichment writer owns `accountId`. A GSI with composites `[accountId, alertState]` on one half and `[timestamp]` on the other is touched by *every* ingest event (via `timestamp`), but the ingest writer can't supply `accountId` without an extra read. The library needs a way to express, per composite attribute, what an *update payload* means when it doesn't mention that attribute — and what it means when it explicitly clears it.

**Mental model — unified attribute hierarchy.** Every GSI is a single ordered hierarchy `[pk_1, ..., pk_n, sk_1, ..., sk_m]` of composite attributes. PK composites form the partition prefix; SK composites extend it for sort and `begins_with` queries. Policy is declared **per attribute**, but outcomes roll up to the two stored key fields (`gsiNpk`, `gsiNsk`). Reasoning follows position in the hierarchy: clearing a leaf SK composite is a *demotion* (item stays at coarser scope); clearing an interior PK composite is a *partition migration* (almost always wrong, hence treated unconditionally as "drop the GSI"). This single-hierarchy framing replaces the old "two halves, mostly independent" framing.

**Three-way payload classification (per composite attribute).** The runtime distinguishes three states; collapsing any two would be a footgun:

| Payload state | What library does | Policy consulted? |
|---|---|---|
| `attr: <value>` (value present) | Use the value when composing the key | No |
| `attr: null` *or* `attr: undefined` (explicit clear) | Treat as **explicit clear**. The two collapse — diluting `undefined` vs `null` was a long-running source of consumer bugs. Always cascades unconditionally; policy does not protect an explicit clear. | No (always cascade) |
| (key omitted from payload) | **Defer to policy** for this attribute | **Yes** |

This is the core change: omission is the only ambiguous signal, so it's the only signal `indexPolicy` resolves. Explicit `null`/`undefined` is now an unambiguous "remove this composite from the key" instruction.

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
      timestamp:  "sparse",     // if somehow omitted, drop from GSI
    }),
  },
}
```

- Per-attribute map of composite attr → `'sparse' | 'preserve'`.
- Default for any composite not returned by the function (or when no function is declared): `'preserve'`.
- Only `'sparse'` and `'preserve'` are valid values. There is no `'required'` policy; consumers who want strict caller-error validation enforce it in their own update layer.

**Per-attribute semantics — omission case (attr not in payload).** Policy fires.

| Policy | Composite is in PK | Composite is in SK |
|---|---|---|
| `sparse` | REMOVE `gsiNpk` + `gsiNsk` (item drops from GSI) | REMOVE `gsiNpk` + `gsiNsk` |
| `preserve` (default) | No-op — leave stored GSI key attributes untouched | No-op |

**Per-attribute semantics — explicit clear case (`attr: null` or `attr: undefined`).** Policy is bypassed; cascade is unconditional.

| Policy | Composite is in PK | Composite is in SK |
|---|---|---|
| `sparse` | REMOVE `gsiNpk` + `gsiNsk` | REMOVE `gsiNpk` + `gsiNsk` |
| `preserve` | REMOVE `gsiNpk` + `gsiNsk` (degrades to sparse on PK — see "PK/SK asymmetry" below) | **Truncate `gsiNsk`** at this composite — see §7.6 Hierarchical SK Pruning |

**PK/SK asymmetry on explicit `preserve` clear.** PK composites form the partition prefix; clearing one and then "preserving" everything else would migrate the item to a different partition, which almost no consumer wants and silently relocates data in a way that breaks queries against the prior partition. The library treats `preserve` on a PK composite, when that composite is explicitly cleared, as **degraded to `sparse`**: drop the GSI entirely. The narrow case where a consumer genuinely wants to migrate partitions can do so via `Entity.remove([attr])` on the cleared composite plus a follow-up update with the new value — but the default refuses to do it silently.

**Hole detection (write-time validation).** A "hole" is a composite at position `i` in the unified hierarchy that is cleared (or omitted-with-`sparse`) while a composite at position `j > i` is still present in the (composed) payload. Composed keys can't carry holes meaningfully — `acc#A#child#Y` with `parent` cleared would compose to a syntactically invalid prefix that no `begins_with` query would match. Hole patterns throw at write time with **EDD-9024**, naming the GSI, the cleared composite at position `i`, and the still-present trailing composite at `j`. This catches latent bugs where the consumer thought truncation was going to happen and was actually composing a broken key.

**Decision algorithm (per touched GSI).** Given merged payload `M = { ...primaryKey, ...payload }` and the explicit-clear set `C` (attrs present in payload with value `null` or `undefined`) and the cascade-remove set `R` (attrs named in `Entity.remove([...])`):

1. **Cascade override.** If any composite of this GSI is in `R`, REMOVE both key fields. Done.
2. **Per-composite outcome** for each attr `a`:
   - If `a in C` (explicit clear): cascade unconditionally — flag the GSI for full drop if `a` is a PK composite OR `a` is an SK composite AND policy is `sparse`; otherwise (SK + `preserve`) flag for SK truncation at position `a`.
   - Else if `a in M` (present with value): use value at this position.
   - Else (omitted): consult `p(a) = indexPolicy?.(M)?.[a] ?? "preserve"`. `sparse` flags the GSI for full drop. `preserve` is a no-op for this attribute.
3. **Hole check.** If any attribute at hierarchy position `i` is flagged for drop/truncation while an attribute at position `j > i` is *present* in the composed prefix, throw EDD-9024.
4. **Roll up.** If the GSI is flagged for full drop → REMOVE both keys. Else if SK truncation is flagged at position `i` → SET `gsiNsk` to the leading prefix `[pk_1..pk_n, sk_1..sk_(i-1)]` and SET `gsiNpk` from PK composites if all are present (or no-op if some are missing-preserve). Else recompose normally — SET each half whose composites are all present, no-op for halves with a missing-preserve composite.

**`Entity.remove([attr])` cascade.** When an update's REMOVE list contains a composite attribute, the whole GSI is dropped (REMOVE both keys) regardless of `indexPolicy`. This is existing behavior and takes precedence — `remove(["tenantId"])` means "the item no longer belongs in the tenant index." Cascade is the explicit *full drop* primitive; explicit-clear-with-`preserve` on an SK composite is the *demote to coarser scope* primitive (see §7.6).

**Evaluation gate.** Determines when a GSI is evaluated on update/append:

- **GSI declares `indexPolicy`** → evaluated on **every** update/append. The declaration is a statement about the GSI's membership invariant; the library applies it unconditionally so omission is consistently resolved.
- **GSI has no `indexPolicy`** → evaluated only when at least one of its composites is in the update payload (present, or explicitly cleared), or when `Entity.remove([attr])` names one of its composites. Preserves conventional DynamoDB partial-update semantics for entities that haven't opted into policy-driven indexing.

**`put()` semantics (unchanged).** `put()` does not consult `indexPolicy`. It writes a complete item from scratch — any missing composite means "this item is not in that GSI." The existing `tryComposeIndexKeys` path (omit GSI keys when any composite is absent) is preserved as-is. `indexPolicy` exists specifically to resolve the update/append ambiguity, not the put case.

**`.append()` semantics (time-series).** `indexPolicy` applies. The policy function is invoked with `item = { ...primaryKey, ...appendInput }` — not a merged current item (append intentionally does no read). Two constraints enforced at `Entity.make()`:

1. Returned policy keys must be composites of the GSI (same check as update).
2. At append, returned keys must additionally be members of `appendInput`. Composites outside `appendInput` cannot have policy at append-time — they are by contract never changed by an append, and their half is always either (a) untouched (preserve default) if partial, or (b) fully recomposed if the other half's composites are all in appendInput. This filter is justified by `appendInput` being a structural contract declared at `Entity.make()` time, not a per-call choice — so absence from `appendInput` is equivalent to "this writer does not own this composite", and policy cannot meaningfully fire for it.

The library-managed REMOVE of `gsiNpk`/`gsiNsk` on sparse-policy dropout *does* write fields outside `appendInput`, but those are key-management fields, not user data — the `appendInput` enrichment-preservation contract applies to user-data fields only.

**Decision table (worked).** GSI with `pk.composite = [A]`, `sk.composite = [B, C]`. "absent" = key not in payload; "null" = `attr: null` or `attr: undefined` in payload.

| Policy | Payload | Result |
|---|---|---|
| no policy | `{A, B, C}` (all present) | SET both halves |
| no policy | `{A}` | SET pk; sk untouched (B, C absent → preserve default) |
| no policy | `{B}` | pk untouched (A absent preserve); sk untouched (C absent preserve) |
| no policy | `{B, C}` | pk untouched (A absent preserve); SET sk |
| `A: 'sparse'` | `{B, C}` (A absent) | REMOVE both — sparse on omitted PK composite |
| `B: 'sparse', C: 'preserve'` | `{A, C}` (B absent) | REMOVE both — sparse on omitted attr drops the GSI |
| `A: 'preserve'` explicit | `{B, C}` (A absent) | pk untouched; SET sk (same as default) |
| any policy | `{A: null, B, C}` (A explicit clear) | REMOVE both — explicit clear of PK composite cascades unconditionally |
| `B: 'preserve'` | `{A, B: null, C}` (B explicit clear, C present) | **THROW EDD-9024** — hole at B with C still present |
| `B: 'preserve'` | `{A, B: null}` (B explicit clear, C absent) | SET pk; SET sk to prefix `[A]` (truncate at B) — see §7.6 |
| `B: 'preserve', C: 'preserve'` | `{A, B, C: null}` (C explicit clear) | SET both halves with sk truncated at C: `sk = [A, B]` (no hole — C is the trailing composite) |
| cascade: `Entity.remove(["A"])` | any | REMOVE both — cascade overrides policy |

**Why three states matter.** Pre-1.6, the runtime collapsed omission and explicit `null`/`undefined` into "this attribute is not in the payload", and `sparse` policy fired in both cases. The result was the well-documented footgun: a partial update payload that just happened not to mention some `sparse`-policied attribute would silently REMOVE that GSI's keys, even when the consumer's intent was "I'm not touching this index." With three states, omission means "defer to my declared invariant" and `null`/`undefined` means "I am cancelling this composite right now" — the two intents stop sharing a signal.

### Sparse Map Storage (`storedAs: DynamoModel.SparseMap()`)

> **Naming disambiguation.** This "sparse" is the *Sparse Map storage primitive* — flattening a logical `Record<K, V>` into per-entry top-level attributes. It is unrelated to the `'sparse'` value of `indexPolicy` (§7 Policy-Aware GSI Composition), which controls whether an *update* drops a *GSI* membership when a composite is omitted. The two were spelled the same in 1.5.0 and that spelling collision was a frequent source of confusion. 1.6.0 renames the storage opt-in to `DynamoModel.SparseMap()` (a typed callable) so the two concepts no longer share a string.

**Problem.** A logical `Record<K, V>` field on a domain model maps awkwardly to DynamoDB. Stored as a single Map (`M`) attribute, every entry must be addressed via nested-Map syntax (`metrics.2026-01.views`) — which requires the parent attribute to exist. There is no `if_not_exists()` ergonomic for adding the first entry to an empty map: concurrent writers race to create the parent, and a fresh item demands a read-modify-write to materialise it.

**Solution.** A field annotated `storedAs: DynamoModel.SparseMap()` is *flattened* — each map entry becomes a top-level DynamoDB attribute named `<prefix>#<key>`. Each entry is independently addressable; no parent ceremony is required.

`metrics: Record<string, { views: number; clicks: number }>` storing `{ "2026-01": { views: 5, clicks: 2 } }` is laid out on disk as:

```
metrics#2026-01 = M { views: N(5), clicks: N(2) }
```

A counter `Record<string, number>` is even simpler — the bucket attribute *is* the scalar:

```
totals#2026-01 = N(1)
```

**One level deep.** Sparseness is *exactly* one layer. The value at each entry is a normal DynamoDB attribute (scalar, `M`, `L`, `SS`, `NS`). Nested sparse Records are rejected at `Entity.make()` time.

#### Configuration

```ts
class Page extends Schema.Class<Page>('Page')({
  pageId: Schema.String,
  metrics: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({ views: Schema.Number, clicks: Schema.Number }),
  }),
  totals: Schema.Record({ key: Schema.String, value: Schema.Number }),
}) {}

const PageModel = DynamoModel.configure(Page, {
  metrics: { storedAs: DynamoModel.SparseMap() },
  totals: { storedAs: DynamoModel.SparseMap({ prefix: 't' }) }, // optional prefix override
})
```

- `storedAs: DynamoModel.SparseMap(options?)` is only valid on a `Schema.Record` field (validated at `make()`). The callable form lets options like `prefix` (and any future options such as `trackKeys`) live inside the SparseMap declaration where they belong, rather than as siblings on `ConfigureAttributes` that are only meaningful when paired with the right `storedAs` value.
- `prefix` defaults to the field name. Distinct sparse fields must have distinct prefixes; prefixes must not collide with non-sparse top-level attribute names.
- Inner value schema can be any DynamoDB-native shape (scalar / `Schema.Struct` / `Schema.Array` / `Schema.Set`). Nested `storedAs: DynamoModel.SparseMap()` is rejected.
- Sparse fields **cannot** participate in primary-key composites, GSI composites, or unique constraints — keys are not statically known at `make()` time.

#### Wire format

| Domain | Storage |
|---|---|
| `{ pageId: 'p1', metrics: {} }` | `pk, sk, __edd_e__, pageId` (no `metrics#*` attrs) |
| `{ ..., metrics: { '2026-01': { views: 5, clicks: 2 } } }` | `..., metrics#2026-01 = M { views: 5, clicks: 2 }` |
| `{ ..., totals: { '2026-01': 1, '2026-02': 3 } }` | `..., totals#2026-01 = 1, totals#2026-02 = 3` |

The `#` delimiter matches the rest of the library's key-composition convention. Keys flow through `ExpressionAttributeNames` aliasing in every read/write path so there is no lexical collision risk with user attributes. **User keys must not contain `#`** — validated at write time with a clear error (no silent escaping).

#### Reads — transparent

`get`, `query`, `scan`, batch, and stream paths all rebuild the domain `Record<K, V>` from flattened attributes by walking the marshalled item once and grouping attributes matching `<prefix>#*`. Domain consumers see the field as a normal Record.

#### Writes — record-style (whole-bucket replace)

```ts
db.entities.Pages.update({ pageId: 'p1' })
  .set({ metrics: { '2026-01': { views: 5, clicks: 2 } } })
```

Compiles to **one `SET` per bucket**. The above produces `SET #m_2026_01 = :map` (one clause). For a payload of N buckets the UpdateExpression has N `SET` clauses. There is no leaf-merging within a bucket — the whole bucket value replaces.

- Concurrent writes to **different** buckets are safe.
- Concurrent writes to the **same** bucket race (last-write-wins on that bucket).
- For finer-grained merge within a bucket, drop to path-style.

`null` in record-style input is **NOT** interpreted as REMOVE. Removal is always explicit via `removeEntries`. The `null`-as-REMOVE shortcut is too footgunny — a domain model that genuinely uses `null` as a value would lose data on every write.

#### Writes — path-style (per-leaf within a bucket)

```ts
// Counter — bucket attribute IS the scalar; works on a fresh item with no parent ceremony.
db.entities.Pages.update({ pageId: 'p1' })
  .pathAdd((t) => t.totals.entry('2026-01'), 1)
  // → ADD totals#2026-01 :1

// Inner-field update on a struct bucket — uses native DynamoDB nested-Map syntax.
db.entities.Pages.update({ pageId: 'p1' })
  .pathAdd((t) => t.metrics.entry('2026-01').views, 1)
  // → ADD metrics#2026-01.views :1
```

`PathBuilder<Model>` exposes `.entry(key)` on sparse Record fields, returning a path typed by the inner value schema. The path compiles to `<prefix>#<key>` for the bucket itself, and `<prefix>#<key>.<field>` for nested-Map field access using DynamoDB's native nested-map syntax. `ExpressionAttributeNames` aliasing handles the `#` literal.

**Caveat.** Nested-Map operations on inner fields (`metrics#2026-01.views`) require the bucket attribute to exist. Use record-style for new buckets, path-style for buckets known to exist. This mirrors DynamoDB's native semantics — the library does not paper over it.

For scalar-valued sparse maps (counter use case), there is no inner field — the bucket attribute itself is the scalar, so `ADD totals#2026-01 :1` works on a fresh item with no parent. This is the headline win.

#### Removal — explicit

```ts
db.entities.Pages.update({ pageId: 'p1' }).removeEntries('metrics', ['2026-01', '2026-02'])
// → REMOVE metrics#2026-01, metrics#2026-02
```

Compiles to a single `REMOVE` clause per call. Removing an entry that does not exist is a no-op (DynamoDB's REMOVE semantics).

#### Clearing — `clearMap(field)`

DynamoDB has no `REMOVE prefix#*` syntax, and the library does not statically know which bucket keys exist. `clearMap` is a **two-op helper**, presented as a single API call:

1. `GetItem` (consistent read, projection narrowed to the prefix where possible — falls back to full item)
2. `UpdateItem` with an explicit `REMOVE <prefix>#k1, <prefix>#k2, ...` clause derived from the read

```ts
db.entities.Pages.update({ pageId: 'p1' }).clearMap('metrics')
```

`clearMap` **chains** with other update combinators — the REMOVE list folds into the same `UpdateItem` that performs other SETs/ADDs:

```ts
db.entities.Pages.update({ pageId: 'p1' })
  .clearMap('metrics')
  .set({ status: 'reset' })
  .expectedVersion(7)
// → 1 GetItem + 1 UpdateItem (REMOVE metrics#... + SET status, with version condition)
```

**Race window.** Between read and update, a concurrent writer may add a new bucket. The new bucket survives the clear.

- For `versioned: { retain: true }` entities, the existing optimistic-lock CAS closes the race automatically — clear fails on stale version, retry resolves.
- For non-versioned entities, clear is **best-effort** (documented). If atomic clear is critical for a non-versioned entity, the user can read+update at the call site or opt into versioning.

A future enhancement (out of scope) could add an opt-in sidecar keys-set (`storedAs: { kind: 'sparse', trackKeys: true }`) to make clear a single op. The per-write attribute overhead isn't worth paying by default.

#### Conditional ops

`attribute_exists(<prefix>#<key>)` and `attribute_not_exists(<prefix>#<key>)` work natively because each entry is a top-level attribute. Exposed via the path API:

```ts
db.entities.Pages.update({ pageId: 'p1' })
  .condition((t, { exists }) => exists(t.metrics.entry('2026-01')))
  .set({ status: 'updated' })
```

#### Lifecycle interactions

- **`versioned: { retain: true }`** — snapshots preserve flattened attributes verbatim.
- **`softDelete`** — GSI keys are stripped; sparse attributes are domain data and are **preserved**. Restore is a no-op for sparse attributes.
- **Unique constraints** — sparse fields cannot be referenced. Same reason as keys — composite values aren't known at `make()` time.
- **`timeSeries`** — sparse fields are aggregate state, not event state. They live on the **current item only** and are preserved across `.append()` (untouched, since they're outside `appendInput`). Event items (`#e#<orderBy>`) **DO NOT** carry sparse attributes — same treatment as enrichment fields outside `appendInput`. Per-event snapshots of aggregate state would multiply storage by `(events × sparse-keys)` — a real cost on long event streams (e.g. 10s heartbeats × 7d TTL ≈ 60K events per device) with no read-side benefit.

#### Constraints (enforced at `Entity.make()`)

| Code | Constraint |
|---|---|
| EDD-9020 | `storedAs: DynamoModel.SparseMap()` is only valid on `Schema.Record` fields. |
| EDD-9021 | Inner value schema must be DynamoDB-native; **nested sparse Records are rejected**. |
| EDD-9022 | Sparse fields cannot participate in primary key, GSI composites, or unique constraints. |
| EDD-9023 | Multiple sparse fields on the same entity must have distinct prefixes (and not collide with non-sparse attribute names). |

User key validation at write time (no error code — runtime `ValidationError`):

- Map keys must serialize to strings.
- Keys must not contain `#` (silent escaping rejected — explicit error wins).
- `<prefix>#<key>` must satisfy DynamoDB attribute-name rules (1–255 bytes after concatenation).

#### Worked example — counter

```ts
class Page extends Schema.Class<Page>('Page')({
  pageId: Schema.String,
  views: Schema.Record({ key: Schema.String, value: Schema.Number }),
}) {}
const PageModel = DynamoModel.configure(Page, { views: { storedAs: DynamoModel.SparseMap() } })

const Pages = Entity.make({
  model: PageModel,
  entityType: 'Page',
  primaryKey: {
    pk: { field: 'pk', composite: ['pageId'] },
    sk: { field: 'sk', composite: [] },
  },
})

// Create with no buckets — `views` is just absent on disk.
yield* db.entities.Pages.put({ pageId: 'p1', views: {} })

// First view — atomic counter on a fresh item, no parent-map dance.
yield* db.entities.Pages.update({ pageId: 'p1' })
  .pathAdd((t) => t.views.entry('2026-04'), 1)
// On disk: views#2026-04 = N(1)

// Concurrent writers to different months never race.
// Concurrent writers to the same month race (last-write-wins on the increment? no —
// ADD is atomic, so concurrent ADDs on the same bucket sum correctly. Concurrent SETs race.)

// Read — transparent rebuild.
const page = yield* db.entities.Pages.get({ pageId: 'p1' })
// page.views === { '2026-04': 1 }
```

#### Worked example — struct buckets with clear

```ts
class Page extends Schema.Class<Page>('Page')({
  pageId: Schema.String,
  status: Schema.String,
  metrics: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({ views: Schema.Number, clicks: Schema.Number }),
  }),
}) {}
const PageModel = DynamoModel.configure(Page, { metrics: { storedAs: DynamoModel.SparseMap() } })
// versioned: { retain: true } makes clearMap atomic.
const Pages = Entity.make({
  model: PageModel,
  entityType: 'Page',
  primaryKey: { pk: { field: 'pk', composite: ['pageId'] }, sk: { field: 'sk', composite: [] } },
  versioned: { retain: true },
})

// Write an initial bucket.
yield* db.entities.Pages.update({ pageId: 'p1' })
  .set({ metrics: { '2026-04': { views: 100, clicks: 10 } } })
// On disk: metrics#2026-04 = M { views: 100, clicks: 10 }

// Atomic per-leaf update within a known bucket.
yield* db.entities.Pages.update({ pageId: 'p1' })
  .pathAdd((t) => t.metrics.entry('2026-04').views, 1)
// On disk: metrics#2026-04.views = 101

// Reset — two-op helper, atomic via the version CAS.
yield* db.entities.Pages.update({ pageId: 'p1' })
  .clearMap('metrics')
  .set({ status: 'reset' })
// → 1 GetItem + 1 UpdateItem (REMOVE metrics#2026-04 + SET status with version CAS)
```

### Hierarchical SK Pruning

**Mechanism.** When a consumer explicitly clears (`set({ attr: null })` / `set({ attr: undefined })`) a *trailing* SK composite whose `indexPolicy` is `preserve`, the library **truncates `gsiNsk`** at that composite — recomposes the SK from the leading prefix of present composites instead of dropping the whole GSI. The PK half is recomposed normally if its composites are all present. The item stays queryable in the GSI, just at a *coarser depth* than before.

**Why this is the right default for `preserve` on SK clear.** SK composites form a hierarchy where each leaf composite is a *refinement* of its parent context. Dropping the whole GSI on a leaf clear destroys the parent-level membership; truncating preserves it. The `preserve` annotation literally reads "preserve membership where possible" — and "where possible" means "at the coarsest scope the composed key still reaches." `sparse` continues to mean "drop on clear", and `Entity.remove([attr])` continues to be the explicit full-drop primitive — so consumers always have an escape hatch when truncation is the wrong intent.

**Real-world cases.** Each row below is the same shape — a hierarchy where a leaf clear should *demote* not *evict*:

| Domain | SK composite hierarchy | Trailing-clear meaning |
|---|---|---|
| Geographic | `[region, country, city, site]` | Asset leaves a site but stays queryable at city/country/region |
| Org | `[division, department, team, squad]` | Engineer rotates off a squad, stays queryable at team/department/division |
| Workflow | `[stage, subStage, step]` | Approval step retracted; item stays queryable at parent stage |
| Content | `[category, subcategory, tag]` | Leaf tag dropped; item stays in subcategory listings |
| Permission | `[org, project, resource]` | Resource access lost; project-level access preserved |
| Order grouping | `[customerId, orderId]` | After clearing `orderId`, group-by-customer queries via `begins_with(sk, "customer#C#")` still work |

The unifying property: leaf composites are *refinements* of the parent context; the parent context remains queryable after pruning.

**Contract — trailing clear (the supported case).** Given a GSI with SK composites `[a, b, c, d]`, "trailing clear at position `i`" means: the composite at position `i` is explicitly cleared, and no composite at any position `j > i` is present in the composed payload (after merging with the stored item). The composed `gsiNsk` becomes the leading prefix `[a_value, ..., (i-1)_value]`. PK side recomposes normally.

Consequences:
- A single trailing-clear on the deepest present composite is the canonical case — the item moves up exactly one level in the hierarchy.
- Multiple consecutive trailing clears (say, clearing `c` and `d` in `[a, b, c, d]`) compose to a prefix of `[a_value, b_value]`. This is the multi-level demotion case.
- A clear at position `i` while position `j > i` is present is a **hole** — see §7's hole detection. EDD-9024 throws at write time.

**PK/SK asymmetry.** `preserve` truncation applies to **SK composites only**. PK composites form the partition prefix; truncating the PK would migrate the item to a different partition, silently breaking queries against the prior partition. Explicit clear of a PK composite under `preserve` instead **degrades to `sparse`**: drops the GSI entirely. Consumers who genuinely want to migrate partitions can do so via `Entity.remove([attr])` followed by an update with the new value — but the default refuses to do it implicitly.

**Cascade override.** `Entity.remove([attr])` continues to drop the whole GSI for any composite — PK or SK, regardless of `indexPolicy` and regardless of position. Truncation is the meaning of *explicit clear with `preserve`*, not of `remove`. Consumers always have the explicit drop primitive.

**Worked example — geographic asset hierarchy.**

```ts
indexes: {
  byLocation: {
    name: 'gsi1',
    pk: { field: 'gsi1pk', composite: ['region'] },
    sk: { field: 'gsi1sk', composite: ['country', 'city', 'site'] },
    indexPolicy: () => ({
      region: 'preserve',
      country: 'preserve',
      city: 'preserve',
      site: 'preserve',
    }),
  },
}

// Initial state: asset is at /us/sf/datacenter-1
// Stored: gsi1pk = "$app#v1#asset#us", gsi1sk = "$app#v1#asset#us#sf#datacenter-1"

// Asset leaves the datacenter — clear `site`. Item stays queryable at city level.
yield* db.entities.Assets.update(key).set({ site: null })
// gsi1pk unchanged. gsi1sk truncated to "$app#v1#asset#us#sf"
// begins_with(gsi1sk, "$app#v1#asset#us#sf") still finds this asset.

// Asset leaves the city entirely — clear both `city` AND `site`.
yield* db.entities.Assets.update(key).set({ city: null, site: null })
// gsi1sk truncated to "$app#v1#asset#us"
// Still queryable at country level.

// Asset is being decommissioned — drop the index entirely.
yield* db.entities.Assets.update(key).remove(['country'])
// REMOVE gsi1pk, gsi1sk — full drop, cascade overrides truncation.

// Hole pattern — would throw EDD-9024:
// yield* db.entities.Assets.update(key).set({ city: null, site: 'datacenter-2' })
// → throws: city cleared at SK position 1 with site present at position 2
```

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
yield* db.Users.update({ userId: "abc-123" }).set({ displayName: "Alice B" })
```

#### Fluent bound-CRUD builders

Bound-client CRUD methods return **fluent builders** that mirror the `BoundQuery` contract on the read side. This replaces the variadic `...combinators` form used prior to v0.9.

```typescript
// Update + optimistic lock
yield* db.entities.Tasks.update({ taskId: "t-1" })
  .set({ status: "done" })
  .expectedVersion(3)

// Put with a condition
yield* db.entities.Users.put(input)
  .condition({ status: "active" })

// Create (attribute_not_exists) with a callback condition
yield* db.entities.Users.create(input)
  .condition((t, { eq }) => eq(t.status, "active"))

// Delete with a condition
yield* db.entities.Products.delete({ productId: "p-1" })
  .condition({ status: "archived" })

// Upsert — same shape as put
yield* db.entities.Counters.upsert({ counterId: "c-1", total: 0 })

// Patch — update with attribute_exists guard
yield* db.entities.Tasks.patch({ taskId: "t-1" })
  .set({ status: "blocked" })

// Composed update
yield* db.entities.Products.update({ productId: "p-1" })
  .set({ name: "Updated", price: 24.99 })
  .add({ viewCount: 1 })
  .subtract({ stock: 3 })
  .append({ tags: ["clearance"] })
  .remove(["temporaryFlag"])
  .expectedVersion(5)
```

**Yieldable, not Effect.** Builders implement `Pipeable.Pipeable` and `[Symbol.iterator]` (via `Utils.SingleShotGen`) — the same contract as the unbound `EntityOp` and `EntityDelete` intermediates. You execute them by `yield*`ing inside `Effect.gen`. For interop with Effect combinators (`Effect.map`, `Effect.flip`, etc.) use `.asEffect()`.

**Immutable accumulator.** Every chainable call returns a new builder — same semantics as `BoundQuery`.

**Method surface per builder**

| Builder | Method | Accepts |
|---|---|---|
| `BoundPut` / `BoundCreate` / `BoundUpsert` | `.condition(cond)` | callback `(t, ops) => Expr` or shorthand record |
| `BoundDelete` | `.condition(cond)` | same as above |
| `BoundDelete` | `.returnValues(mode)` | `"none"` or `"allOld"` |
| `BoundUpdate` / `BoundPatch` | `.set(updates)` | partial record |
| `BoundUpdate` / `BoundPatch` | `.remove(fields)` | `ReadonlyArray<string>` |
| `BoundUpdate` / `BoundPatch` | `.add(values)` | `Record<string, number>` |
| `BoundUpdate` / `BoundPatch` | `.subtract(values)` | `Record<string, number>` |
| `BoundUpdate` / `BoundPatch` | `.append(values)` | `Record<string, ReadonlyArray<unknown>>` |
| `BoundUpdate` / `BoundPatch` | `.deleteFromSet(values)` | `Record<string, unknown>` |
| `BoundUpdate` / `BoundPatch` | `.expectedVersion(n)` | `number` |
| `BoundUpdate` / `BoundPatch` | `.condition(cond)` | callback or shorthand |
| `BoundUpdate` / `BoundPatch` | `.returnValues(mode)` | any `ReturnValuesMode` |
| `BoundUpdate` / `BoundPatch` | `.cascade(config)` | cascade targets |
| `BoundUpdate` / `BoundPatch` | `.pathSet(op)` / `.pathRemove(segs)` / `.pathAdd(op)` / `.pathSubtract(op)` / `.pathAppend(op)` / `.pathPrepend(op)` / `.pathIfNotExists(op)` / `.pathDelete(op)` | same payloads as the unbound `Entity.path*` combinators |
| all builders | `.asEffect()` | — |

**Implementation strategy.** The builders are thin wrappers. Internally each holds an `EntityOp` (or `EntityDelete`) from the unbound entity plus a pre-resolved `provide` for `DynamoClient + TableConfig`. Every chainable method forwards into the existing `Entity.set/remove/add/condition/…` combinators. On `yield*` (or `.asEffect()`) the builder calls `op._run("record")` (or `op.asEffect()` for deletes) and pipes through `provide` so the final `Effect` has `R = never`.

**Why hard-break over dual.** Carrying both the variadic overload and the fluent builder would double the surface area of `BoundEntity`, degrade hover tooltips, and force contributors to remember two shapes. The read side settled on builders for the same reasons. The change is batched into the next major alongside other breaking changes.

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

Enforcement uses sentinel items with transactional writes. **Sparse** — a
sentinel is only written when every composing field is present on the record;
constraints whose fields are unset are silently skipped (mirrors GSI sparse
semantics):

| Operation | Transaction Items |
|-----------|-------------------|
| Put | Entity item + sentinel per unique field whose composites are all set (`condition: attribute_not_exists(pk)`) |
| Update — composites unchanged | Entity item only (no sentinel ops) |
| Update — undefined → defined | Entity item + put new sentinel |
| Update — defined → undefined | Entity item + delete old sentinel |
| Update — defined → defined (changed) | Entity item + delete old sentinel + put new sentinel |
| Delete | Entity item + delete sentinel per unique field whose composites were set |

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
