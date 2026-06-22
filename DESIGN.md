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
| `versioned: true` | `boolean \| { field?: string, retain?: boolean, ttl?: Duration \| string }` | `version` (or custom name) |
| `softDelete: true` | `boolean \| { ttl?: Duration \| string, preserveUnique?: boolean }` | `deletedAt` (when soft-deleted) |

#### TTL configuration (`versioned.ttl`, `softDelete.ttl`, `timeSeries.ttl`, `unique[].ttl`)

Every framework TTL accepts a `Duration.Duration` **or** a humanized string
(`"7 days"`, `"24 hours"`, `"30 minutes"`), parsed via Effect's `Duration` input
grammar. Two rules are enforced:

- **No bare `number`** — the type rejects it. Effect's `Duration` grammar treats
  a number as *milliseconds*, so `3600` would mean 3.6 s, not an hour (a 1000×
  footgun). Pass `Duration.seconds(3600)` or `"3600 seconds"`.
- **No infinite / unparseable value** — an infinite TTL epoch is nonsensical;
  these (and unparseable strings) fail at `Entity.make()` time with **EDD-9005**,
  so the write path never observes an invalid TTL.

The stored TTL attribute is an absolute epoch-seconds expiry computed from the
**Clock-backed `DateTime.now`** at write time (deterministic under `TestClock`)
plus the configured duration, written to the table's configured TTL attribute
name (`TableConfig.ttlAttributeName`, default `_ttl`).

### Generated IDs

Opt into auto-generated UUID primary keys with `generatedId`:

```ts
Entity.make({ …, generatedId?: { field: string; version?: "v4" | "v7" } })  // default version: "v4"
```

| Config | Behavior |
|--------|----------|
| `generatedId: { field: "id" }` | On `put`/`create`/`upsert`, fill `id` with a UUIDv4 when the caller omits it. A caller-supplied value is always respected (never overwritten). |
| `generatedId: { field: "id", version: "v7" }` | As above, but time-ordered UUIDv7. |

**Make-time validation (EDD-9008).** The named `field` MUST exist in the model **AND** participate in the primary key (pk or sk composite). Generating an id that doesn't compose into the primary key would be a silent no-op, so both conditions are enforced at `Entity.make()` time with a thrown `[EDD-9008]` error. EDD-9008 was the next free code (9006/9007 in use; 9008/9009 free; 9010–9016 are the timeSeries range).

**Schema split — input-optional, record-required.** In the derived `inputSchema` the generated-id field is marked **optional** (caller MAY omit it and let the library fill it), reusing the same `applySystemCollisionAdjustments` / `optionalOnCollide` path that makes colliding `createdAt`/`updatedAt` optional. In the `recordSchema` it stays **required** — a decoded record always carries the id. The type-level optionality is mirrored by `WithGeneratedId<Input, TGeneratedId>` so `Entity.inputSchema.Type` and the `put`/`create`/`upsert` parameter types have the field optional.

**Injection point.** The id is filled on the raw `input` **before** the encode in `Entity.put` (the `encodeOrDecodeEncode` call). `create`/`upsert` inherit via delegation. The filled id then flows through input validation → key composition (PK/SK + any GSI composites it participates in) → stored item → returned record in a single pass.

**`R = never` is preserved — the crux.** `DynamoClient.make(...)` returns bound methods with `R = never`, enforced by hard-typed `provide` helpers. Filling the id requires the cryptographically-secure `Crypto` service (`effect/Crypto`), and `effect-core` ships **no default Crypto layer**. Yielding `Crypto.Crypto` in `put` would naively widen `R` to `… | Crypto.Crypto` and fail at runtime with "Service not found".

The chosen solution (Option 1, the issue's recommendation): **bundle a default `Crypto` service into the context the typed client already captures, and widen the `provide` helpers to admit `Crypto.Crypto`.** Concretely:

- A thin default service (`internal/DefaultCrypto.ts`) is built from `Crypto.make({ randomBytes, digest })` over `globalThis.crypto.getRandomValues` / `crypto.subtle.digest` — **no new dependency** (Web Crypto is available on Node 18+, browsers, and edge runtimes).
- `Entity.bind` (where bound `put` actually runs) and `DynamoClient.makeFromConfig` each add the default via `Context.add(ctx, Crypto.Crypto, makeDefaultCrypto())` and widen their `provide` helper's input type from `Effect<A, E, DynamoClient | TableConfig>` to `… | Crypto.Crypto`. `Entity.bind` only fills the default when Crypto is absent (`Context.getOption`), so an override is respected.
- Bound `put` stays `R = never`; the public method signatures are unchanged. Entities **without** `generatedId` never yield `Crypto` (the fill helper returns early), so their unbound ops keep `R = DynamoClient | TableConfig` exactly as before.
- **Optional platform override:** `DynamoClient.make({ …, crypto?: Crypto.Crypto })` accepts a platform implementation (e.g. from `@effect/platform-node`) which takes precedence over the default. Crypto is **never** surfaced in the public `R` (the rejected Option 2).

### Unique Constraints

```typescript
unique: {
  email: ["email"],                        // single-field uniqueness
  tenantEmail: ["tenantId", "email"],       // compound uniqueness
  idempotencyKey: { fields: ["idempotencyKey"], ttl: Duration.hours(1) },  // time-bounded
  reservation: { fields: ["code"], ttl: "30 minutes" },                    // string form
}
```

When a unique constraint declares a `ttl`, the **sentinel item** carries the TTL
attribute and auto-expires, releasing the uniqueness reservation (e.g. a
time-bounded hold). Without a `ttl`, sentinels are permanent.

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

**Problem.** GSI composite attributes can be owned by different writers ("hybrid GSIs"). A device-ingest writer owns `alertState` + `timestamp`; an enrichment writer owns `accountId`. A GSI with `pk.composite = [accountId]` and `sk.composite = [alertState, timestamp]` is touched by *every* ingest event (via `timestamp`), but the ingest writer can't supply `accountId` without an extra read. The library needs a way to express what an *update payload* means for the GSI's stored keys when only some composites are in scope — *and* must not let one writer's update silently corrupt the half another writer owns.

**Mental model — three contracts.** v1.7.1 expresses GSI maintenance as three independent contracts, all per-half:

> `'preserve'` is a contract with **other writers** ("don't disturb my key when you fire"); `'sparse'` is a contract with **yourself as the half's owner** ("drop my key if I touch this half but can't compose it"); `Entity.remove([attr])` is the explicit signal that a composite is gone — the library REMOVEs the half(s) containing the cleared attribute.

Per-half is the unifying property: declaration (`{ pk, sk }`), evaluation gate (per-half "touched?"), outcome (per-half SET / noop / REMOVE), and cascade (per-half via `removedSet`). There is no GSI-wide cascade left in the model — the v1.6 holdover that bug-1 of v1.7.0 inherited is gone.

**API — per-half policy declaration (unchanged from v1.7.0).** Each GSI may declare an `indexPolicy`:

```ts
indexes: {
  byAccountAlert: {
    name: "gsi6",
    pk: { field: "gsi6pk", composite: ["accountId"] },
    sk: { field: "gsi6sk", composite: ["alertState", "timestamp"] },
    indexPolicy: { pk: "preserve", sk: "sparse" },
  },
}
```

- `indexPolicy: { pk: 'sparse' | 'preserve', sk: 'sparse' | 'preserve' }`. Both halves default to `'preserve'` if `indexPolicy` is omitted entirely or either half is unspecified.
- The standard composition path has no per-composite information to discriminate within a half (it has only the merged payload, no read-before-write), so per-attribute policy callbacks were removed. A half is a single concatenated string; per-attribute mixing within a half has no coherent semantic.

**Two-way payload classification.** v1.7.x collapses the v1.6 three-way classification (present / explicit-clear / omitted) to two states: **present** or **absent**. `attr: null`, `attr: undefined`, and "key omitted from payload" all mean "absent" for GSI-composition purposes.

| Payload state | What library does for GSI composition |
|---|---|
| `attr: <value>` | Use the value as a slot in the composed half |
| `attr: null` *or* `attr: undefined` *or* (key omitted) | Treat as **absent** — the composition is built from the leading prefix of present values |

`set({ attr: null })` is no longer a separate "drop signal" — it still REMOVEs the attribute from the item (the data-attribute REMOVE clause), but it does not separately cascade-drop the GSI keys. Drop-via-cascade goes through `Entity.remove([attr])` instead.

**Per-half evaluation gate (reframed in v1.7.3 as a skip-predicate — closes the empty-composite-half regression AND the class of degenerate-case bugs).** Before the structural rule even runs, each half is asked a single question: *can this half be safely skipped?* The answer depends only on whether the gate's purpose — **multi-writer protection** — actually applies. **If the half cannot be safely skipped, it is evaluated** (SET / REMOVE / noop per the structural rule). The skip predicate is:

```ts
// Skip evaluation only when multi-writer protection actually applies:
// composites exist (otherwise the half value is a constant prefix and
// nothing to multi-writer-clobber); no explicit removal of one of the
// half's composites; AND every composite is absent from both
// `updatePayload` and `keyRecord` (so this writer is genuinely not
// claiming ownership of this half on this call).
const shouldSkip =
  halfComposites.length > 0 &&
  !halfHasRemoved &&
  halfComposites.every((c) => !(c in updatePayload) && !(c in keyRecord))
if (shouldSkip) continue  // leave this half's key attribute alone
```

**Why a skip-predicate, not a touched-predicate.** The gate exists for exactly one reason: to prevent writer A from clobbering keys for halves it doesn't own when writer B does own them. The skip-predicate states that purpose *directly* — "skip iff multi-writer protection applies." Every degenerate case (empty composite list, composites entirely entity-PK, future shapes) negates `shouldSkip` for an obvious structural reason, without enumeration. The pre-v1.7.3 framing inverted the question into a "touched" predicate that had to enumerate every case for which the half *should* be evaluated as a chain of `||` clauses. Each missed shape required another tactical patch — v1.7.1 missed the multi-writer leak (#41), v1.7.2 missed the PK-composites-only case (#43), v1.7.2 then missed the empty-composite-half case (#46). The skip-predicate closes the entire class structurally.

**Walk-through against the canonical shapes.** Each row confirms the skip-predicate is observably equivalent to the cumulative tactical fixes of v1.7.1 + v1.7.2 (no API changes, no behavior changes for existing inputs):

| Half shape | Skip-predicate evaluates to | Outcome |
|---|---|---|
| Empty composite list (`composite: []`) | `length > 0` is false → not skipped | Evaluate (constant entity prefix) — **closes #46** |
| PK-composites-only (composite ∈ keyRecord) | `every(NOT in keyRecord)` is false → not skipped | Evaluate (idempotent SET) — preserves v1.7.2 #43 fix |
| Multi-writer not touching this half | `every()` true, length > 0, !hasRemoved → **skipped** | Skip — preserves v1.7.1 #41 fix |
| Caller asserts authority via payload | `every(NOT in payload)` is false → not skipped | Evaluate |
| Caller invalidates via `Entity.remove([...])` | `!halfHasRemoved` is false → not skipped | Evaluate (cascade override may apply under preserve) |

**Why two input sources are checked, not one** (preserved from v1.7.2). Composites that are *also* entity primary-key composites (e.g. `byChannel: { pk: [channel], sk: [deviceId] }` on an entity with `primaryKey: [channel, deviceId]`) arrive through `keyRecord`, never through `updatePayload` — the writer addresses the row by key, doesn't restate those values in `.set({...})`, and `.append()` deliberately separates structural fields from the SET clause. The skip-predicate's `every(NOT in keyRecord)` clause keeps these halves un-skipped on every write, and the structural rule composes them from the always-present PK values. The behavior is idempotent — re-SETting the same composed value from immutable PK composites produces the same key — so there is no multi-writer regression (see issue #43).

**Why empty composite lists are always evaluated** (NEW in v1.7.3). For a half with `composite: []`, the value is a *constant* (the bare entity / collection prefix). There is nothing for another writer to clobber, no per-call decision to make. The pre-v1.7.3 touched-predicate's `.some(...)` clauses all returned `false` for an empty array, classifying the half as untouched and skipping it — leaving items with one half SET and the other missing, invisible to the GSI (#46). The skip-predicate's leading `length > 0` guard short-circuits before `every()` is ever asked, and `classifyHalf` (which already correctly handled empty composites as `{ kind: 'set', length: 0 }`) is finally reached.

**Why `'sparse'` still works.** `'sparse'`'s contract is *with the half's owner*. If the writer doesn't touch any of the half's composites — neither in payload, nor through the key-addressed structural inputs — they aren't claiming ownership of this half on this call, and the skip-predicate skips the half exactly as before. The writer-scope concept #38 was reaching for falls out of payload-plus-keyRecord contents naturally.

**Design history.** The gate has been progressively reframed:
- **v1.7.0** introduced the touched-predicate (`updatePayload`-only) to fix the v1.6 GSI-wide cascade. Closed the original GSI-blast bug but introduced the multi-writer leak.
- **v1.7.1** added the `removedSet` arm to the touched-predicate (multi-writer leak fix — #41).
- **v1.7.2** added the `keyRecord` arm to the touched-predicate (PK-composites-only fix — #43).
- **v1.7.3** reframed the predicate from "list cases for which to evaluate" to "list the single condition for which it is safe to skip." Closes the empty-composite-half regression (#46) and any future degenerate-case gap of the same shape — the skip predicate's negation is the cumulative `||`-chain of all prior tactical fixes plus the structural `length === 0` short-circuit.

End-to-end consequences for the canonical multi-writer scenarios:

- **Stamps** writing only `{ published: {...} }` → no half is touched → both halves left alone. (v1.7.0 bug-3: stamps blew away the sparse GSI half.)
- **Enrichment** writing `{ accountId: 'X' }` → pk touched, sk untouched.
- **Telemetry** writing `{ alertState: 'active', timestamp: T }` → pk untouched, sk touched.

**Structural composition — longest valid leading prefix.** For each *touched* GSI half (PK and SK independently), walk the composite list left-to-right and build the longest valid leading prefix from values present in the merged record (`{ ...storedKeyAttrs, ...payload }`). The rule is **identical for PK and SK** — the v1.6 PK-clear-degrades-to-sparse asymmetry is gone. The composed half is whatever's reachable from the leading run of present composites:

| Composite state | Result for that half |
|---|---|
| All composites present | Recompose the half with all values |
| Trailing composites absent (`[A, B, _, _]`) | Truncate to the leading prefix `[A, B]` |
| Whole half empty (no leading composites available) | Empty prefix → can't compose → see "Per-half outcome" below |
| Hole pattern (`[A, _, C]`) | Leading prefix is `[A]`, but a present trailing composite would be silently dropped → treated as can't-compose → see "Per-half outcome" below |

Truncation on PK is the same hierarchical demotion as truncation on SK — an item with `pk.composite = ['accountId', 'fleetId']` and `fleetId` cleared composes a partition key of `account#A` and stays queryable at the account scope.

#### Per-half outcome (unified can't-compose rule — NEW in v1.7.1)

When the structural rule **can compose** (leading prefix is non-empty and there's no information loss), the half SETs its key — full or truncated. When the structural rule **can't compose** (empty leading prefix, OR a hole pattern that would lose trailing data), the per-half outcome is decided by policy + cascade:

| Outcome for this half's key attribute | Conditions |
|---|---|
| **noop** (leave key alone) | No composite of this half is in the payload AND none in `Entity.remove([...])` (per-half evaluation gate) |
| **SET full** | Half touched + all composites have values supplied in payload (or available from primary key) |
| **SET truncated** to leading prefix | Half touched + some leading composites have values, trailing absent, no hole |
| **REMOVE** this half's key | Half touched + can't compose (empty leading prefix OR hole pattern), AND policy is `'sparse'` OR a composite is in `Entity.remove([...])` (cascade override) |
| **noop** (stored key may go stale) | Half touched + can't compose, policy is `'preserve'`, AND no composite is in `Entity.remove` |

The roll-up is **per-key** — each half's outcome applies to its own key attribute only. PK dropping doesn't drop SK; SK dropping doesn't drop PK. The item may be invisible in the GSI during a single-half-dropped period (DDB needs both for projection — the projection invariant for readers, not a library behavior), but the surviving half's value persists. When the missing half is later composed again (e.g. telemetry writes `{ alertState, timestamp }` after a clear), the item rejoins the GSI under the still-current other half *without that other writer needing to re-fire* — the v1.7.0 multi-writer bug (#41 bug-1) is closed.

**Cascade override under preserve.** If a half is touched via `removedSet` AND the structural rule would no-op (preserve + can't-compose), the outcome is **REMOVE** instead of noop. Rationale: the consumer's explicit signal trumps stale-data preservation. `Entity.remove(["alertState"])` means "alertState is gone" — preserving the stored key with a value derived from the now-removed composite would lie to readers.

**Hole patterns collapse into can't-compose.** A "hole" (composite at position `i` absent while a composite at position `j > i` is present, e.g. `[A, _, C]`) was a separate v1.7.0 outcome (truncate-or-throw). Under v1.7.1, holes follow the unified rule above: drop under sparse (or cascade), noop under preserve (no cascade). The previous "truncate to `[A]` and silently discard `C`" sparse behavior is gone — silent data loss is a worse failure mode than dropping the half. The previous "throw EDD-9024 under preserve" is also gone — see "EDD-9024 deprecation" below.

#### The set/remove asymmetry (worth memorising)

> `set` provides values to compose with. `remove` invalidates a composite without providing a replacement. The library has no read-before-write — so `remove` without surrounding `set` context can't truncate (it doesn't know what to truncate *to*) and instead REMOVEs the half's key entirely.

```ts
// Truncation works — surviving composites supplied via set, leaf invalidated via remove
update(key).set({ region, country, city }).remove(["site"])
// → SET gsi1sk truncated to "region#APAC#country#AU#city#Sydney"
// (site is in removedSet → cascade override fires, but the surviving leading prefix
// is non-empty → the structural rule composes the prefix and SETs.)

// REMOVE — surviving composites not supplied
update(key).remove(["site"])
// → REMOVE gsi1sk entirely (library has no way to compose [region, country, city] —
// no values supplied, and the library does not read-before-write to discover them).
```

If you want to demote (truncate) hierarchically, you must `set` the surviving composites in the same call — the `remove` invalidates the leaf without providing a replacement, but the surviving prefix is non-empty so the structural rule composes it.

#### How to drop a half (call-site syntax)

| Composite is... | Method 1: `Entity.remove` (always works) | Method 2: `set` with `undefined` |
|---|---|---|
| **Required** in model (e.g. `Schema.String`) | `update(key).remove(["composite"])` | not available — TS rejects `undefined` for non-optional fields under `exactOptionalPropertyTypes` (the v1.7.0 NullishOr revert ensures payload types match model declarations) |
| **Optional** in model (`Schema.optional(...)`) | `update(key).remove(["composite"])` | `update(key).set({ composite: undefined })` |

Naming any one composite of a half is enough — `Entity.remove` doesn't require enumerating all of them. `null` is **never** valid for a composite (EDD-9025 rejects nullable composites at make-time).

**`Entity.remove([attr])` cascade is per-half (NEW in v1.7.1).** When an update's REMOVE list contains a composite attribute, the cascade applies only to the half(s) containing that attribute. Other halves follow the per-half evaluation gate (untouched → noop). v1.7.0 issued a GSI-wide REMOVE (both `gsiNpk` AND `gsiNsk`) for any composite in the cascade set — that GSI-wide blast radius is gone in v1.7.1. The cascade still REMOVEs the affected half's key; if the surrounding `set` provides values for the half's other composites, the structural rule may still compose a truncated prefix (see set/remove asymmetry).

**Decision algorithm (per GSI).** Given merged record `M = { ...storedKeyAttrs, ...payload }` (treating `null`/`undefined` payload values as absent) and `removedSet` (composites named in `Entity.remove([...])`):

For each half (PK then SK), independently:

1. **Evaluation gate (skip-predicate, v1.7.3).** If the half's composite list is non-empty AND no composite is in `removedSet` AND every composite is absent from both `payload` AND `keyRecord` → `noop` (skip — leave the stored key untouched, multi-writer protection applies). Otherwise the half is **evaluated**, continue. (Halves with empty composite lists short-circuit on the leading `length > 0` guard and are always evaluated — the value is a constant prefix; closes #46. Halves whose composites are entity-PK composites fail the `every(NOT in keyRecord)` clause and are always evaluated — the structural rule composes idempotently from the immutable PK values; closes #43.)
2. **Structural rule.** Walk the half's composite list left-to-right. Find the longest leading prefix of present values in `M`.
3. **Classify the outcome:**
   - **Compose succeeded** (leading prefix is non-empty AND no hole — i.e. all absent composites are at trailing positions): SET this half's key from the leading prefix. Done.
   - **Compose failed** (empty leading prefix OR hole pattern):
     - Policy is `'sparse'` → `REMOVE` this half's key.
     - Policy is `'preserve'` AND any composite of this half is in `removedSet` → `REMOVE` this half's key (cascade override).
     - Policy is `'preserve'` AND no composite of this half is in `removedSet` → `noop` (preserve preservation; stored key may be stale).

The two halves' outcomes are emitted independently — each affects only its own key attribute. There is no GSI-wide cascade. There is no longer a `'hole-throw'` outcome (EDD-9024 deprecated — see below).

**`put()` semantics (unchanged).** `put()` does not consult `indexPolicy`. It writes a complete item from scratch — any missing composite means "this item is not in that GSI." The existing `tryComposeIndexKeys` path (omit GSI keys when any composite is absent) is preserved as-is. `indexPolicy` exists specifically to resolve the update/append ambiguity, not the put case.

**`.append()` semantics (time-series) — same composer.** v1.7.x unifies append with update. `.append(input)` calls the same composer as `.update(...).set(...)`, with the encoded append input passed as both `updatePayload` and `keyRecord` (v1.7.2 — see #43; the v1.7.1 path filtered PK composites out of the payload, which combined with the gate-only-checks-payload bug to skip GSI evaluation for any half whose composites are entirely entity-PK composites). Composites outside `appendInput` are simply absent under the structural rule, and the per-half evaluation gate applies — halves whose composites are entirely outside `appendInput` AND outside the entity primary key are untouched and follow the noop branch.

For sparse GSIs whose composites are entirely outside `appendInput` *and* outside the entity primary key, the half is untouched → noop. Sparse only fires when the writer touches the half but can't compose it. This matches the consumer-side multi-writer recommendation: sparse GSIs should be single-writer-per-half by design.

For GSIs whose composites are entirely entity-PK composites (e.g. `byChannel: { pk: [channel], sk: [deviceId] }` on a Telemetry entity with `primaryKey: [channel, deviceId]`), the half is always touched (PK composites are always in `keyRecord`), the structural rule always composes from the immutable PK values, and the resulting SET is idempotent — every write re-emits the same composed key. This is the correct behavior; v1.7.0 / v1.7.1 silently skipped these GSIs, leaving items invisible to channel-scoped queries.

**EDD-9024 (`CompositeKeyHoleError`) deprecation — runtime-irrelevant in v1.7.1.** The class is kept exported for back-compat but no longer thrown at runtime. The original v1.7.0 throw protected against an `[A, _, C]` shape under preserve — but the type system already catches the only "wrong" case the throw was guarding (required composites can't be omitted under `exactOptionalPropertyTypes` since v1.7.0 reverted the NullishOr widening; the only legitimate runtime hole is "optional leading composite absent + present trailing composite," which is a normal write the consumer expressly chose). Under v1.7.1 the hole pattern collapses into the unified can't-compose rule (drop under sparse, noop-or-cascade-override under preserve). See `Errors.ts` for the deprecation note on the class.

**EDD-9025 — composite attribute schemas must not include `null` (unchanged from v1.7.0).** At `Entity.make()` time, the library walks every composite across `primaryKey`, every entry in `indexes`, and every entry in `unique` constraints. For each composite attribute it inspects the field's Schema AST and throws `CompositeNullableError` (EDD-9025) if `null` is reachable in the type union (`Schema.NullOr`, `Schema.NullishOr`, `Schema.Union` with a Null branch, custom-named field via `DynamoModel.configure({ field })` rename that resolves to a nullable schema, etc.).

The semantic justification: composites participate in string composition (`acc#X#alert#Y`); null is not a meaningful slot value, only present-with-value or absent. Allowing `Schema.NullOr` on a composite would let `set({ composite: null })` typecheck and then immediately blow up at runtime (or worse, silently produce a key with the literal string `"null"` as a slot). EDD-9025 catches this at make-time.

The sparse pattern is still expressible — use `Schema.optional(...)`, which produces `T | undefined` (without `null`). `undefined` is "absent" under the two-way classification.

**Footgun closed at the type level — `set({ composite: null })` no longer compiles.** Two changes work together (both shipped in v1.7.0, kept in v1.7.1):

1. v1.7.x reverts the v1.6 update-payload type widening. The v1.6 schemas wrapped each update field in `Schema.optional(Schema.NullishOr(field))` to support the v1.6 three-way classification. v1.7.x drops the `NullishOr` wrap — update payload field types match the model's declarations exactly (just wrapped in `Schema.optional` so the key can be omitted entirely).
2. EDD-9025 prevents the model from declaring a composite as nullable in the first place.

Together: `set({ composite: null })` for a composite is a TypeScript error two ways — the model can't widen the composite to include `null`, and the update payload type isn't widened beyond the model. The stale-GSI-keys-via-`set-null` concern dissolves entirely at the type level. No runtime path is reachable from typed callers.

**Migration of v1.6 `set({attr: null})` patterns:**

```typescript
// v1.6 — `null` in payload was a per-composite drop signal under sparse,
// or an SK-truncate signal under preserve.
entity.update(key).set({ alertState: null }).asEffect()

// v1.7.x — explicit per-attribute drop (per call) — atomic remove + per-half cascade.
entity.update(key).remove(['alertState']).asEffect()

// v1.7.x — for "drop when this index has nothing to compose" intent,
// declare the GSI half as 'sparse' once at the index definition.
//   indexPolicy: { pk: 'sparse', sk: 'preserve' }
// Then any update that touches the PK half but can't compose it drops the GSI
// implicitly per the per-half can't-compose rule.
```

**Final per-half decision table (worked).** GSI with `pk.composite = [accountId]`, `sk.composite = [alertState, timestamp]`, `indexPolicy = { pk: 'preserve', sk: 'sparse' }`. Item exists with `accountId = "acme"`, `alertState = "active"`, `timestamp = T1`. Both GSI keys composed.

| Writer | Payload | pk outcome | sk outcome | Item state in GSI |
|---|---|---|---|---|
| Enrichment | `{ accountId: "newAcct" }` | touched, SET full → new `account#newAcct` | untouched, **noop** | Visible under new account, sk position unchanged |
| Telemetry (active alert) | `{ alertState: "active", timestamp: T2 }` | untouched, **noop** | touched, SET full → fresh `alert#active#ts#T2` | Visible under last accountId, fresh sk |
| Telemetry (no alert) | `{ timestamp: T2 }` (alertState omitted, optional) | untouched, **noop** | touched (timestamp), can't compose (hole) + sparse → REMOVE gsi1sk | Invisible (DDB needs both); gsi1pk preserved |
| Telemetry (explicit clear) | `{ alertState: undefined, timestamp: T2 }` | untouched, **noop** | touched, can't compose + sparse → REMOVE gsi1sk | Same — invisible, gsi1pk preserved |
| Stamp (unrelated write) | `{ published: {...} }` | untouched, **noop** | untouched, **noop** | Unchanged — both halves preserved (the v1.7.0 leak is closed) |
| Telemetry (rejoin) | `{ alertState: "active", timestamp: T3 }` | untouched, **noop** | touched, SET full → `alert#active#ts#T3` | Re-visible under preserved gsi1pk + new gsi1sk; **no enrichment re-fire needed** |
| Hierarchical demote (different entity, multi-composite SK) | `update(key).set({ region, country, city }).remove(["site"])` | n/a | touched (set + removedSet), trailing-absent → SET truncated to `region#APAC#country#AU#city#Sydney` | Re-indexed at city scope |
| Explicit drop | `update(key).remove(["alertState"])` | untouched, **noop** | touched (alertState in removedSet), can't compose → REMOVE gsi1sk | Invisible; gsi1pk preserved (per-half cascade — no longer GSI-wide) |
| Cascade override under preserve | `{ pk: "preserve" }`, `update(key).remove(["accountId"])` (no surviving pk composites) | touched (cascade), can't compose + preserve + cascade override → REMOVE gsi1pk | untouched, **noop** | gsi1pk REMOVE'd via cascade override |

**Multi-writer entity design rule.** Each GSI half should be entirely owned by a single writer's domain. The library does not paper over cross-writer composite ownership — that's a consumer-side modeling discipline. With v1.7.1's per-half evaluation gate and the per-half outcome rule, a writer that doesn't touch a GSI's composites simply doesn't supply them, and the half no-ops regardless of policy. There is no per-composite leakage across writers like in v1.6, and no GSI-wide blast radius like in v1.7.0.

**v1.7.0 / v1.7.1 → v1.7.2 PK-composites-only regression callout (closes #43).** The v1.7.1 per-half gate consulted only `updatePayload`. For GSI halves whose composites are entity-PK composites (a common pattern: tenant-scoped queries, entity-key-projected GSIs), `updatePayload` never carried those composites — the writer addresses the row by key, never restates them in `.set({...})`, and `.append()` further filtered PK composites out of its payload before passing to the composer. The gate saw both halves as untouched, skipped GSI evaluation entirely, and never wrote `gsiNpk` / `gsiNsk`. Items written under v1.7.0 / v1.7.1 against such GSIs were invisible to GSI queries. v1.7.2 fixes this in two places: the gate now also counts `keyRecord` membership (so PK composites carried alongside the payload count as "touched"), AND `Entity.append()` no longer filters PK composites out of the payload it passes to the composer (the filter never solved a real problem and silently broke this pattern). Affected items repair on the next `Entity.update()` against them — the gate now fires, the structural rule composes the immutable PK values, and the missing GSI keys are SET. No data migration needed; reads via the GSI start returning these items as their next update lands.

**v1.7.0 / v1.7.1 / v1.7.2 → v1.7.3 empty-composite-half regression callout (closes #46).** The v1.7.2 per-half gate, even after the `keyRecord` broadening, still classified halves with **empty composite lists** as untouched. For an empty composite array, every `.some(...)` clause in the touched-predicate trivially returned `false`, so `Entity.update()` would skip composing the half entirely — leaving items with one half SET and the other missing, invisible to the GSI. The shape is common in single-table designs: a sparse "lookup" GSI like `byDeviceBinding: { pk: [deviceBinding], sk: { composite: [] } }` writes the SK as a constant entity prefix on every visible item, but the v1.7.0–v1.7.2 gate skipped the SK because no composite of an empty list can be "in" anything. v1.7.3 reframes the gate as a skip-predicate keyed on the gate's actual purpose (multi-writer protection); the leading `length > 0` guard short-circuits empty-composite halves to *always evaluated*, and `classifyHalf` (which already handled empty composites correctly as `{ kind: 'set', length: 0 }`) is finally reached. Affected items repair on the next `Entity.update()` — the next write composes the missing half from the constant prefix and the item rejoins the GSI. No data migration needed.

#### Canonical GSI-composite test-fixture shapes

Test coverage for the policy-aware composer must span the canonical GSI-composite shapes. Missing one shape (as the v1.7.1 fixture matrix did with PK-composites-only, and as the v1.7.2 matrix did with empty-composite halves) leads to consumer-facing regressions. Future work in this area must verify each shape:

1. **Multi-writer GSI** — composites split across writers (e.g. enrichment-owned PK composite + telemetry-owned SK composites). The per-half gate must skip halves the current writer doesn't touch. Anchor scenario for the `'preserve'` contract.
2. **PK-composites-only GSI** — composites entirely subset of the entity primary key (e.g. `byChannel: { pk: [channel], sk: [deviceId] }` on `primaryKey: [channel, deviceId]`). The per-half gate must fire via `keyRecord` membership and SET on every write. Regression scenario for #43 — must be present in unit, entity-level integration, and connected suites.
3. **Hierarchical GSI** — composites form a parent → child hierarchy (e.g. `[region, country, city, site]`). The structural rule must truncate via `set({ parents }).remove(["leaf"])`.
4. **Hole pattern GSI** — optional leading composite + present trailing composite. Must collapse into the unified can't-compose rule (drop under `'sparse'`, noop or cascade-override under `'preserve'`).
5. **All composites mutable** — every composite is a non-PK model field, and `appendInput` / update payloads carry them all. The standard case; the gate fires through the payload.
6. **Empty-composite half** — at least one half is `composite: []` (e.g. `byDeviceBinding: { pk: [deviceBinding], sk: { composite: [] } }`, common in single-table designs where the SK is just the entity prefix). The per-half gate must always evaluate the empty half (the value is a constant prefix; multi-writer protection does not apply). Regression scenario for #46 — must be present in unit, entity-level integration, and connected suites.

### Sparse Map Storage (`storedAs: DynamoModel.SparseMap()`)

> **Naming disambiguation.** This "sparse" is the *Sparse Map storage primitive* — flattening a logical `Record<K, V>` into per-entry top-level attributes. It is unrelated to the `'sparse'` value of `indexPolicy` (§7 Policy-Aware GSI Composition), which controls whether an *update* drops a *GSI* membership when an entire half's composites are absent. The two were spelled the same in 1.5.0 and that spelling collision was a frequent source of confusion. 1.6.0 renames the storage opt-in to `DynamoModel.SparseMap()` (a typed callable) so the two concepts no longer share a string.

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

### Hierarchical Key Truncation

Hierarchical truncation — leaf composites being *refinements* that should *demote* the item, not *evict* it — is the unifying property across many real-world domains:

| Domain | Composite hierarchy | Trailing-absent meaning |
|---|---|---|
| Geographic | `[region, country, city, site]` | Asset leaves a site but stays queryable at city/country/region |
| Org | `[division, department, team, squad]` | Engineer rotates off a squad, stays queryable at team/department/division |
| Workflow | `[stage, subStage, step]` | Approval step retracted; item stays queryable at parent stage |
| Content | `[category, subcategory, tag]` | Leaf tag dropped; item stays in subcategory listings |
| Permission | `[org, project, resource]` | Resource access lost; project-level access preserved |
| Order grouping | `[customerId, orderId]` | After clearing `orderId`, group-by-customer queries still work |
| Multi-tenant fleet | `[accountId, fleetId]` (PK) | Vehicle leaves a fleet but stays queryable at account scope |

Under v1.7.1 (§7), trailing-absent truncation is part of the structural composition rule — there is no separate "pruning" code path. A trailing-absent composite simply truncates the half to its leading prefix, regardless of which half (PK or SK). PK and SK behave identically. The set/remove asymmetry (§7) governs how to invoke truncation: `set` provides surviving composites; `remove` invalidates the leaf — both must appear in the same call for truncation to happen, otherwise `remove` alone REMOVEs the half (no read-before-write).

**Worked example — geographic asset hierarchy (PK + SK, both preserve).**

```ts
indexes: {
  byLocation: {
    name: 'gsi1',
    pk: { field: 'gsi1pk', composite: ['region'] },
    sk: { field: 'gsi1sk', composite: ['country', 'city', 'site'] },
    indexPolicy: { pk: 'preserve', sk: 'preserve' },
  },
}

// Initial state: asset is at /americas/us/sf/datacenter-1
// Stored: gsi1pk = "$app#v1#asset#region_americas",
//         gsi1sk = "$app#v1#asset#country_us#city_sf#site_datacenter-1"

// Asset leaves the datacenter — *demote* (truncate, stay queryable at city scope).
// Supply the surviving composites via `set` AND invalidate the leaf via `remove`
// in the same call — the structural rule then composes the truncated leading prefix.
yield* db.entities.Assets.update(key).set({ country: 'us', city: 'sf' }).remove(['site'])
// gsi1pk unchanged (region untouched — pk half is not in the payload).
// gsi1sk truncated to "$app#v1#asset#country_us#city_sf"
// begins_with(gsi1sk, "$app#v1#asset#country_us#city_sf") still finds this asset.

// Asset leaves the datacenter — *evict* (drop the whole half).
// Without surviving composites in `set`, the library can't compose anything;
// the cascade fires and REMOVEs gsi1sk entirely.
yield* db.entities.Assets.update(key).remove(['site'])
// pk untouched, noop. sk touched via removedSet, can't-compose (no surviving values),
// preserve + removedSet → cascade override → REMOVE gsi1sk.
// gsi1pk preserved; the per-half cascade no longer drops gsi1pk.

// PK-side demotion — multi-composite PK example.
//   pk.composite = ['accountId', 'fleetId']  (preserve on both halves)
// Vehicle leaves a fleet but stays under the account scope:
yield* db.entities.Vehicles.update(key).set({ accountId: 'acct-1' }).remove(['fleetId'])
// PK truncated to "$app#v1#vehicle#accountid_acct-1" — vehicle still queryable
// by account, just not by the prior fleet. Same hierarchical demotion as SK,
// applied symmetrically to PK.

// Decommission — drop from the index entirely (sparse policy on the relevant half),
// or use Entity.remove on every composite of the half to force the cascade.
yield* db.entities.Assets.update(key).remove(['country', 'city', 'site'])
// sk touched (multiple composites in removedSet), no surviving composites → REMOVE gsi1sk.
// pk untouched (no pk composites in removedSet), noop. Item invisible in the GSI
// (DDB projection rule: needs both keys), gsi1pk value retained for future rejoin.

// Hole pattern under preserve — collapses into can't-compose, no throw, no SET.
// `city` invalidated, `site` supplied → would compose `[country_us, _, site_dc2]` (hole).
// Per v1.7.1: hole = can't-compose; preserve + removedSet contains city → cascade
// override → REMOVE gsi1sk.
// yield* db.entities.Assets.update(key).remove(['city']).set({ country: 'us', site: 'datacenter-2' })
// → REMOVE gsi1sk. (v1.7.0 would have thrown EDD-9024; that throw is now deprecated.)

// Hole pattern under sparse — same outcome, REMOVE gsi1sk:
//   indexPolicy: { pk: 'preserve', sk: 'sparse' }
// yield* db.entities.Assets.update(key).remove(['city']).set({ country: 'us', site: 'datacenter-2' })
// → REMOVE gsi1sk. Note: site value is invalidated (data loss in the index) —
// this is the unified rule's "no silent partial composition on holes" intent.
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
