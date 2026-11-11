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
├── ConsumedCapacity.ts # Opt-in consumed-capacity reporting: layer, observer, withOperation, span attributes (§16)
├── Marshaller.ts       # Thin wrapper around @aws-sdk/util-dynamodb
├── Errors.ts           # Tagged errors
├── internal/           # Decomposed internals
│   ├── Expr.ts         # Expr ADT — type-safe expression nodes, ConditionOps, compileExpr
│   ├── PathBuilder.ts  # PathBuilder — recursive Proxy for type-safe attribute path access
│   ├── EntityOps.ts    # Entity operation intermediates (EntityGet, EntityPut, EntityUpdate, EntityDelete)
│   ├── EntityTypes.ts  # Type-level computations for Entity derived types
│   ├── EntitySchemas.ts # Schema derivation (7 derived schemas)
│   ├── EntityCombinators.ts # Terminal functions and update combinators (record + path-based)
│   ├── Capacity.ts     # Consumed-capacity choke point (instrumented client), operation scopes, summing (§16)
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
  → versioned / unique entities: consistent read of the current item first, to
    continue its version and rotate its sentinels (#133)
  → DynamoClient.putItem (or transactWriteItems for unique constraints / retain)
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
| Aggregates own their read and write path | Read: one partition query + assembly. Write: decompose the domain object, compose the rows, and issue one `transactWriteItems` per sub-aggregate group (`delete` uses `batchWriteItem`). They reuse Entity definitions for keys and schemas but do not route writes through Entity ops |
| ElectroDB-style composite indexes | `{ pk: { field, composite }, sk: { field, composite } }` — attribute lists not templates |
| DynamoSchema for key namespacing | `$schema#v1#entity#attrs` format with `$` sentinel prefix for ORM/non-ORM coexistence |
| `__edd_e__` entity type attribute | Ugly name convention (like ElectroDB's `__edb_e__`) avoids collisions with user model fields |
| Single-table first | Most impactful DynamoDB pattern; multi-table is simpler subset |
| @aws-sdk/util-dynamodb for marshalling | Proven, maintained; Effect Schema handles validation layer above |

### Module Dependencies

```
Aggregate → Entity, Batch (ref hydration), Table, KeyComposer, Marshaller, Errors, DynamoClient via Capacity.client (partition query, transactWriteItems per group, batchWriteItem for delete)
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
ConsumedCapacity → internal/Capacity → DynamoClient (type + service key only)
Entity, Query, Batch, Transaction, Aggregate, EventStore, ProjectionEngine, BoundVectorQuery,
  CheckpointStore → internal/Capacity (`Capacity.client`, never the raw DynamoClient — §16)
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
| `casing` | `"lowercase" \| "uppercase" \| "preserve"` | `"lowercase"` | Casing for the whole composed key, composite values included |
| `escapeKeys` | `boolean` | `false` | `true` escapes strings and gives numbers numeric key text, in every key, partition and sort (§7 "Key text"): all or nothing. Off stores exactly the 1.36 text, for strings and numbers, with accepted limitations. Off by default for all of 1.x; on by default is planned for the next major. Over existing rows, `rekey` moves them |

### Casing Rules

Casing applies to the **entire composed key** (ElectroDB parity):
- Schema name
- Entity type / collection name
- Composite attribute names
- **Composite attribute values** — under the default `"lowercase"`, `"Dev-A"` and `"dev-a"` compose the same key. Ids that must stay distinct by case need `"preserve"`.

The stored attribute keeps its original value; only the key string is cased.

**Index-level override.** `primaryKey.casing` and `indexes.<name>.casing` override the schema's casing for that index's keys: entity type / collection name and composites, both halves. The `$<schema>#v<n>` prefix always uses the schema's casing (`KeyComposer.effectiveCasing` = index's, else schema's). Every composition path goes through `KeyComposer` with the index definition, so put, query accessors (PK, `begins_with`, `.where()` operands), policy-aware updates and collection queries all honour it. Collection members must agree on the collection index's effective casing — `EDD-9055` at `DynamoClient.make()` / `Collection.make()`, since keys composed under different casings never meet in the shared partition. (Before 1.22 `normalizeGsiConfig` dropped `casing` from `indexes` entries, so it was accepted but ignored on GSIs; `primaryKey.casing` always worked.)

**Time-series exception.** The `#e#` infix and the serialized `orderBy` value in an event-item SK follow the **schema's** casing even when `primaryKey.casing` overrides it. Event SKs are already stored under that rule, so it is pinned (`TimeSeries.test.ts`) rather than aligned.

**Fixed markers are never cased:** the `v` in `#v<n>`, the `#v#` (version snapshot) and `#deleted#` (soft delete) infixes, and the `_<n>` entity/event version suffix. The time-series `#e#` infix is the exception and follows the casing. These are storage format — pinned by `packages/schema/test/DynamoSchema.test.ts` — and must not change.

**Casing is storage format.** Changing it on a populated table moves every composed key.

**EventStore streams** lower-case `streamName` in their keys by default, regardless of `casing`. `makeStream({ casing })` sets the stream's key casing like an index's `casing` does. See §12.

### Key Prefix Format

Every generated key starts with a `$` sentinel followed by the schema prefix. The `$` sentinel identifies ORM-managed keys, enabling coexistence with non-ORM items on the same table:

```
$<schema>#<version>#<entityType|collection>#<...composites>
```

Examples with `name: "myapp"`, `version: 1`, `casing: "lowercase"`:

| Context | Generated key |
|---------|---------------|
| User entity, pk `["userId"]`, value `"abc-123"` | `$myapp#v1#user#userid_abc-123` |
| User entity, sk `[]` (empty) | `$myapp#v1#user` |
| Clustered collection "TenantItems", pk `["tenantId"]` | `$myapp#v1#tenantitems#tenantid_t-1` |
| Unique constraint sentinel (email) | `$myapp#v1#user.email#foo@bar.com` |
| Version snapshot (v7) | `$myapp#v1#user#v#0000007` |
| Soft-deleted item | `$myapp#v1#user#deleted#2024-01-15T10:30:00Z` |
| Version snapshot (v7), sk `["line"]`, value `"a"` | `$myapp#v1#user#v#line_a#0000007` |

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
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byTenant: {
      name: "gsi1",
      collection: "TenantItems",
      type: "clustered",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["createdAt"] },
    },
    byEmail: {
      name: "gsi2",
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

#### Attribute names are typed from the model

Every definition position that names a model attribute is typed from the model *(owner 2026-11-01)*: the editor completes the names, and a misspelled one is a compile error on that entry. The runtime checks stay, for untyped callers.

| API | Positions |
|---|---|
| `Entity.make` | `primaryKey` and index `pk` / `sk` composites (a ref's `${ref}Id` once `refs` declares the ref); `sk.prefix` parts and `sk.zorder` entries (each entry's options typed by its field's type, §7 "Z-order Sort Keys"); `refs` keys; `unique` fields (both forms); `timeSeries.orderBy` and `appendInput`; `generatedId.field`; vector index `source.fields`, partition and filter fields |
| `DynamoModel.configure` | attribute keys |
| `Aggregate.make` | `pk.composite`, `collection.sk.composite`, `list.pk` / `list.sk` composites, `context`, `edges` keys (both forms), and each `many` edge's `sk.composite`, checked at `Aggregate.make` against the element's scalar fields and one dotted level into an object field (`"official.officialId"`) |
| `Collections.member` / `Collections.make` | a member's SK composites; the collection's composites, which every member's model must have |
| `GeoIndex.make` | `index` (an index of the entity) and `fields` |

Physical attribute names stay plain strings: key `field`s, `configure` `field` renames, timestamp / version / TTL attribute names. So do labels that name no model attribute: discriminator keys, which are written into the sort key as text. (The first argument of `Aggregate.one` / `many`, which the runtime never read, is deprecated; the `edges` key names the field.) A config declared outside the call (a shared `primaryKey` or `zorder` list) needs `as const`, or a generic helper, to keep its names literal: widened to `string`, they no longer fit the model's names.

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

**Members must agree on shared physical indexes (`[EDD-9069]`).** Several members may declare one
physical secondary index (index overloading), but one physical index has one key schema. `Table.make`
and `Table.definition` merge every declaration — each entity index, each auto-generated
`_cascade_<field>` index, an aggregate's collection index (an LSI when its `pk` is the table's
primary `pk`, a GSI otherwise) and list index (a GSI) — and throw `[EDD-9069]`, naming both
declarers and both shapes, when two declarations of one name differ in key attributes or in
GSI/LSI classification. Entities must also declare the same primary-key fields. Before 1.25.0 both
functions silently kept the first declaration: the table was created keyed the first declarer's
way, and the other declarer's items never reached the index (its queries returned nothing), or
its writes lacked the table's key attributes. The check is definition-time, so tables deployed
with CDK or Terraform get it from `Table.make` alone; a conflict introduced only by an aggregate
passed to `DynamoClient.make` but not registered on `Table.make` surfaces when `DynamoClient.make`
derives the table definition, as a vector-index conflict does.

### Runtime Configuration

The physical table name is injected at runtime via Effect Layers, keeping definitions pure and environment-independent:

```typescript
// Provide physical table name at the edge
MainTable.layer({ name: "my-prod-table" })

// Or from environment variables via Effect Config
MainTable.layerConfig({ name: Config.String("TABLE_NAME") })
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
    list: () => Effect.succeed({ data: [], count: 0, cursor: Option.none() }),
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
| `index` | `string` | No (primary only) | Physical GSI name. Entity indexes are always GSIs; only aggregate collection indexes and stream indexes can be LSIs |
| `collection` | `string \| string[]` | No | Collection name(s) for cross-entity queries |
| `type` | `"isolated" \| "clustered"` | No | Collection type (default: `"isolated"`) |
| `casing` | `"lowercase" \| "uppercase" \| "preserve"` | No | Casing override for this index |

### System Fields

| Config | Type | Fields Added |
|--------|------|-------------|
| `timestamps: true` | `boolean \| { created?: TimestampFieldConfig, updated?: TimestampFieldConfig }` | `createdAt`, `updatedAt` (or custom names) |
| `versioned: true` | `boolean \| { field?: string, retain?: boolean, ttl?: Duration \| string }` | `version` (or custom name) |
| `softDelete: true` | `boolean \| { ttl?: Duration \| string, preserveUnique?: boolean }` | `deletedAt` (when soft-deleted) |

#### Timestamp field configuration (`TimestampFieldConfig`)

```ts
type TimestampFieldConfig =
  | string                                              // field name only
  | Schema.Top                                          // storage only (default field name)
  | { field?: string; schema?: Schema.Top }             // both
```

The `schema` half is **a storage descriptor, not a codec**. System timestamps are
*generated* by the library at write time (`generateTimestampPrimitive` over the
Clock-backed `DateTime.now`), never decoded from caller input, so the only thing
the write path can read off the supplied schema is its `DynamoEncoding`
annotation — which storage form to emit (`string` / `epochMs` / `epochSeconds`).

**Make-time validation (EDD-9044).** A `schema` that carries no `DynamoEncoding`
annotation is rejected at `Entity.make()` / `Aggregate.make()` time. Before this
rule such a schema was silently discarded and the field fell back to an ISO
string — the type accepted `Schema.Number` and `Schema.DateTimeUtcFromMillis`,
both of which then stored an `S` (#97). Storing the wrong wire type is not merely
an unused attribute: a GSI declaring `AttributeType: 'N'` over that field makes
DynamoDB reject the write outright with `ValidationException: Type mismatch for
Index Key`, so the failure has to surface at definition time, not at the write.

| `schema` | Result |
|---|---|
| `DynamoModel.DateString` | ISO 8601 string (`S`) |
| `DynamoModel.DateEpochMs` | epoch millis (`N`) |
| `DynamoModel.DateEpochSeconds` / `DynamoModel.TTL` | epoch seconds (`N`) |
| `X.pipe(DynamoModel.storedAs(Y))` | `Y`'s storage form |
| `Schema.Number`, `Schema.DateTimeUtcFromMillis`, any un-annotated schema | **EDD-9044** at make() time |

A *model-declared* field of the same name still wins over `timestamps.schema`
(the existing collision rule): a date-compatible model field supplies the
encoding, and a non-date model field means the user owns the attribute outright
and the library skips timestamp management for it.

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

**`R = never` is preserved — the crux.** `DynamoClient.make(...)` returns bound methods with `R = never`, enforced by hard-typed `provide` helpers. Filling the id requires the cryptographically-secure `SecureRandom` service (`effect/crypto`), and `effect-core` ships **no default SecureRandom layer**. Yielding `SecureRandom.SecureRandom` in `put` would naively widen `R` to `… | SecureRandom` and fail at runtime with "Service not found".

The chosen solution (Option 1, the issue's recommendation): **bundle a default `SecureRandom` service into the context the typed client already captures, and widen the `provide` helpers to admit `SecureRandom`.** Concretely:

- A thin default service (`internal/DefaultCrypto.ts`) is built from `SecureRandom.make` over `globalThis.crypto.getRandomValues` — **no new dependency** (the global Web Crypto API is available on Node 19+ — Node 18 only with `--experimental-global-webcrypto` — browsers, and edge runtimes).
- `Entity.bind` (where bound `put` actually runs) and `DynamoClient.makeFromConfig` each add the default via `Context.add(ctx, SecureRandom.SecureRandom, makeDefaultCrypto())` and widen their `provide` helper's input type from `Effect<A, E, DynamoClient | TableConfig>` to `… | SecureRandom`. `Entity.bind` only fills the default when `SecureRandom` is absent (`Context.getOption`), so an override is respected.
- Bound `put` stays `R = never`; the public method signatures are unchanged. Entities **without** `generatedId` never yield `SecureRandom` (the fill helper returns early), so their unbound ops keep `R = DynamoClient | TableConfig` exactly as before.
- **Optional override:** `DynamoClient.make({ …, crypto?: SecureRandom.SecureRandom["Service"] })` accepts another implementation, built with `SecureRandom.make` or read from a platform layer, which takes precedence over the default. `SecureRandom` is **never** surfaced in the public `R` (the rejected Option 2).
- **Version 7 ids are monotonic per service.** Since Effect 4.1, each `SecureRandom` keeps its UUIDv7s in order: within a millisecond a 42-bit counter orders them, and the timestamp can run slightly ahead of the `Clock`. The default service is per client, so ordering holds within one client and not between clients or processes. The id's text form is unchanged.

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
time-bounded hold), whether a put or an update wrote it. Without a `ttl`,
sentinels are permanent. A sentinel names the item that reserved it
(`_entity_pk` / `_entity_sk`), and a write releases only sentinels its item
owns, since an expired reservation may have been claimed by another item (see
"Sentinel ownership" in §10).

Constraints are **sparse**: a sentinel is only written when every composing
field is present on the record. Mirrors GSI sparse semantics — a record with a
missing optional composite is silently excluded from the constraint, allowing
multiple records to coexist with the field unset (no false collision on a
literal `"undefined"` key). Update transitions claim/release the sentinel as
the field becomes set/unset.

**A default never creates a sentinel (#133).** A field with
`withDecodingDefault` that a write omits holds only its default, so no sentinel
is composed for it, even when it is stored. A defaulted unique field that is
also an index composite is stored (its index keys need it) and listed in a
hidden string-set attribute, `__edd_d__` (`UNSENTINELED_DEFAULTS`), which is
stripped from decoded models. `composeUniqueSentinel` returns nothing for a
constraint over a listed field, so no sentinel is composed, rotated or deleted
for it. A write that supplies the value drops the field from `__edd_d__` and
claims its sentinel. A `.remove()` of a defaulted index composite stores the
default again (`rematerializeRemovedDefaults`), keeps the item indexed under
it, re-lists a unique field in `__edd_d__` and releases the old value's
sentinel.

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
| `string` | As-is; in a sort key, code points U+0000–U+0025 escaped (sort key text, below) |
| `number` | A non-negative integer is zero-padded to 16 digits. Anything else: `String(n)` padded (off), numeric key text (`escapeKeys: true`, below) |
| `bigint` | A non-negative bigint is zero-padded to 38 digits. Anything else: `String(n)` padded (off), numeric key text (`escapeKeys: true`, below) |
| `DateTime.Utc` | ISO 8601 string |
| `boolean` | `"true"` / `"false"` |
| Branded string | Underlying string value |

#### Numeric key text

DynamoDB orders sort keys by their UTF-8 bytes, so with `escapeKeys: true`
`KeyComposer.serializeValue` writes a number or bigint as text that sorts in numeric order
(`packages/schema/src/internal/NumericKey.ts`). `x` is the magnitude, `W` the pad
width (16 for a number, 38 for a bigint):

| Value | Key text | Example |
|---|---|---|
| `0`, `-0`, integer `x < 10^W` | `x` zero-padded to `W` digits | `42` → `0000000000000042` |
| non-integer `x < 10^W` | padded integer part, `.`, fraction digits | `3.14` → `0000000000000003.14` |
| `x ≥ 10^W` | `:`, 3-digit exponent, significant digits | `1e21` → `:0211` |
| negative, `x < 10^W` | `-`, 9's complement of the positive text (`.` kept), `:` | `-3.14` → `-9999999999999996.85:` |
| negative, `x ≥ 10^W` | `-*`, complemented exponent and digits, `:` | `-1e16` → `-*9838:` |
| `Infinity` / `-Infinity` | `;` / `-)` | |

The fraction is the number's shortest round-trip decimal (`String(n)`) written out
without an exponent, so `0.1` is `.1`; trailing zeros are dropped. The leading byte
orders the forms (`-` < digits < `:` < `;`; under `-`, `)` < `*` < digits), and a
negative's `:` terminator sorts its shorter text last, so `-3.14 < -3.1 < -3`. Every
byte is above the `#` delimiter and none is a letter, so casing never changes it and
a composite that continues with `#<next>` keeps the order. `NaN` has no order, so it throws
`[EDD-9096]` (`KeyValueError`) with `escapeKeys: true`, and so does a `Schema.Number`'s with it off
(a `Schema.NumberFromString`'s keeps 1.36's text there, below). A bigint of more than 1,000 digits
overflows the exponent, and throws it with `escapeKeys: true`. Where that surfaces:

| Path | Result |
|---|---|
| Entity writes and key-taking operations: `put`, `create`, `upsert`, `update` (key, or a `.set()` index composite), `get`, `delete`, `restore`, `purge`, time-series `append` (key or `orderBy`); unique-constraint values on `put`, `create`, `upsert` and `restore` | `ValidationError` for the operation, cause the `KeyValueError`, before anything is marshalled or sent (`composeKeysOrFail`) |
| `Batch.get` / `Batch.write`, `Transaction.transactGet` / `transactWrite` | `ValidationError`, nothing sent (`composePrimaryKeyOrFail`, and the put builder's unique-value check) |
| Query accessors (`versions`, `deleted.list`, `history` and collections too), `.where()`, `.within()` and `GeoIndex.nearby`'s `pkFilter` | The builder is returned refused, and its terminal fails with a `ValidationError`, nothing sent (`Query.orRefusal`). `.explain()` returns the `empty` plan with the reason, and `asParams` fails the same way. Misuse the types catch (a missing composite, `EDD-9053`, `EDD-9093`) still throws |
| `Aggregate`, `EventStore` and every other operation | `ValidationError` for the operation, from the operation's scope (`Capacity.operation`, `delegate`; no stream composes a caller's value, a refused builder has answered first). A projection's row key is that row's `Failed` outcome, not the batch's |
| A value with no DynamoDB form outside a key: `NaN`, `±Infinity` or a number past `Number.MAX_SAFE_INTEGER` in an attribute, a condition or a filter, an empty set where absent can't stand for it | `ValidationError` over `Marshaller.UnstorableValue` (`EDD-9124`), nothing sent: refused by each path, through `marshalOrFail`, and not by these scopes (see "A caller's value is never a defect", §7) |

`Capacity.withOperation` (`ConsumedCapacity.withOperation`, the public one) doesn't convert: what the caller's effect dies of is the caller's. `Expression.condition`, a plain builder the caller invokes with no error channel, throws the tagged `UnstorableValue`. A bigint DynamoDB can't hold is DynamoDB's to refuse: `Schema.BigInt` of 1,001 digits fails with its `DynamoValidationError`, typed, with `escapeKeys` off, and a `BigIntFromString` stores as ever there.

Up to 1.36, and with `escapeKeys` off, a number's text is `String(n).padStart(16, "0")`
(38 for a bigint), which sorts `-3` above `-5`, `10.5` below `3.14`, `1e-7` above `3` and
`1e21` below `1e16`. Non-negative integers below `10^W` have the same bytes under both;
every other number (negative, fractional, `≥ 1e16`, `±Infinity`), every negative or
`≥ 1e38` bigint, and `DateEpochMs` and `DateEpochSeconds` composites before 1970 differ.

**Off composes what 1.36 composed**, so a row 1.36 stored stays where a read looks: a very long
bigint is its digits and `Infinity` is `00000000infinity` (then cased), and neither is refused.
A `NaN` is composed only where a row can hold it. A `Schema.NumberFromString` stores it as
`"NaN"`, so its row is keyed `0000000000000NaN` (then cased), written, read, queried, updated and
deleted by that key on every path, as up to 1.39.0 (`test/fixtures/stored-nan-keys-1.39.0.json`).
The composite key form tells it apart: it hands that field's `NaN` on as `NumericKey.STORED_NAN`
(`CompositeCodec.storedNaNKeyForm`, also what an aggregate's `many` edge sort key is read through),
which the composers compose by the setting, and which is a number to the type checks
(`keyFormValueKindOf`) and to arithmetic. A `Schema.Number`'s own `NaN` has no stored form (the
marshaller refuses it), so no row holds it, and it is refused (`[EDD-9096]`); 1.39.0 composed its
text, and every write of it died in the marshaller. `KeyText136.schema136` composes
`0000000000000NaN` for a number's `NaN` too, for the fixture and for `rekey`, `text136` being what
lets it. 1.37 and 1.38 refused both. With `escapeKeys` on, `rekey` names a row whose own key needs
the `NaN` as the conflict `uncomposable` (since 1.40.0; earlier it was counted in
`skipped.unrecognizedKey`), and an index key holding it has no difference to judge; with it off,
the row is where the entity composes it, and is left as it is.

**History.** 1.37.0 composed numeric text unconditionally, and 1.38.0 kept it. Since 1.39.0
it belongs to `escapeKeys: true`.

#### Key text

One setting decides the text of every key: `escapeKeys` on `DynamoSchema.make`. **It's off by
default for all of 1.x, you opt in with `escapeKeys: true`, and on by default is planned for the
next major release.** It's all or nothing, for strings and numbers, partition keys and sort keys.

| | Off (default) | `escapeKeys: true` |
|---|---|---|
| A string in a key | As it is: the text 1.36 composed | Escaped, in every key |
| A number or bigint in a key | Zero-padded: the text 1.36 composed | Numeric key text |
| A time-series event's `orderBy` segment | The attribute's encoded value | Its key form, escaped |
| A partial pin on a secondary index's sort key | `begins_with(<prefix>#)` | `BETWEEN <prefix> AND <prefix>#U+FFFF` |

**One text, one request.** Every operation composes the one text its setting chooses and looks
nowhere else: no second read, no second query, no move on first write, no row check on another
value's text, whatever the value holds. `test/KeyRequests.test.ts` pins it by request capture: a
value whose text differs under the other setting sends the same requests as one whose text doesn't,
under both settings. `rekey` is the only thing that moves a row from one text to another.

With `escapeKeys: true` a composite's text escapes every code point U+0000–U+0025 — control
characters, space, `!`, `"`, `#`, `$` and `%` — as `%` and two hex digits (`KeyComposer.keyText`,
`keyValueText`): `new york` is `new%20york`, `a#b` is `a%23b`, `50%` is `50%25`. The value is cased
first, then escaped; the hex digits follow the casing (`%0A`, or `%0a` under `"lowercase"`).

DynamoDB orders sort keys by UTF-8 bytes, and a composite that is not the last
is followed by `#`. Escaped, a composite's text holds no character below `%`, so
the `#` after it sorts below whatever an extension continues with: a value's key
sorts before every greater value's. An escape starts with `%`, below every
unescaped character, and escapes keep the order of the code points they replace,
so key order is the cased values' order. The map is per character, so a value is
a prefix of another exactly when its key text is (`begins_with` is unchanged).
With `escapeKeys: true`, then, every bound is one exact key range (§ "Accessor sort key
conditions"), and a value may hold `#`. Numbers, bigints, dates and booleans never hold an
escaped character, and a string without one has the same bytes under both settings.

| Key | Escaped, with `escapeKeys: true` |
|---|---|
| Table and index partition keys and sort keys (clustered and isolated collection members included), and every condition and prefix composed from their composites | yes |
| Time-series event sort key: the `orderBy` segment | yes |
| Version snapshot and tombstone sort keys: the item segment, taken from the escaped live key | yes |
| Aggregate: partition, collection and list key composites, many-edge composites, discriminator values (not the discriminator names) | yes |
| EventStore stream partition keys, under the stream's own casing | yes |
| Unique-constraint sentinels: the values in the sentinel's partition key | yes |
| Vector index partitions | yes |
| Z-order `sk.prefix` segments, before their length prefix or hash | yes |
| The structural parts of a key: the schema prefix, entity type, collection name, attribute labels, shard marker | no |
| EventStore event sort keys (their parts are structural and a version) and command sort keys (an id only ever read by its exact key, never by a range) | no |

The language service's params mirror it (`ParamsBuilder`, pinned by `KeyParity.test.ts` under both
settings).

Since both roles of an attribute build one text, an inverted index needs no case of its
own: `pk: { field: "sk", composite: ["groupId"] }, sk: { field: "pk", composite: ["userId"] }`
composes the same bytes the table's halves do, under either setting (canonical shape 14). That
fixes what 1.37.0 and 1.38.0 did to one ("Rows under other key text").

**What off gives up.** Off is the text `test/EscapeKeys.test.ts` compares with
`fixtures/rows-1.36.0.json`, which the published 1.36.0 stored. It has accepted limitations, the
same as up to 1.36, with no machinery and no refusal for any of them:

- Key order isn't value order when a value holds a character below `#`. A range on a sort key
  composite that isn't the last can return the wrong rows: `new york` sorts below `new#...`, so
  `lte: "new york"` leaves out `new`. `gt` under a pin on the last composite can miss a longer value
  continuing below `#` (`a b` or `a!` for `a`).
- Numbers sort as zero-padded text, and `.history()` over a `NumberFromString` or `BigIntFromString`
  `orderBy` reads in text order.
- A `#` in a value can imitate a segment: `a#b` + `c` and `a` + `b#c` compose one key, and a pin on
  `new` also returns `new#2`.
- A pin on a composite that isn't the last, on a secondary index, is `begins_with(<prefix>#)`, so a
  row truncated at that composite isn't returned (§ "A pin on a truncated row's own level"). An
  `.where(eq)` or an `eq` in `.within()` means the same.
- Skip-scan over free-form strings can hide rows, since its partition walk reads key order, and a
  probe that lands on a key it can't parse stops: the rest of the range is one filtered read.
- Z-order prefix segments hold the raw string.

The shard hash reads a value's `serializeValue` text, so a row's shard doesn't change with the flag.

A cursor names a key. One from the other setting's text finds no rows, or DynamoDB refuses it
(`DynamoValidationError`, its start key isn't in the partition), and on a `.within()` or sharded
query it fails with `EDD-9094` (the fingerprint covers the partition). One from a query 1.37.0 or
1.38.0 ran over two key texts (field `p`) fails with `EDD-9094` on any query.

#### Rows under other key text (#171, #183)

A table can hold rows under any of these. `KeyText136.forms` (`@effect-dynamodb/schema/internal/KeyText136.ts`,
internal) gives each as a pair of schemas whose composers give its partition and sort key text:

| Written by | Partition key | Sort key | Numbers | Event `orderBy` |
|---|---|---|---|---|
| Up to 1.36, and `escapeKeys` off | Raw | Raw | Zero-padded | Encoded value |
| 1.37.0 and 1.38.0 | Raw | Escaped | Numeric | Key form |
| `escapeKeys: true` | Escaped | Escaped | Numeric | Key form |

1.37.0 and 1.38.0 write the same text: the published packages' rows are compared in
`releaseRowScenarios`. They also leave a fourth form, on an index stored in the table's own key
attributes (an inverted index): each attribute holds the text of the half that wrote it last, so
`pk` is escaped and `sk` raw (`KeyText136.invertedForm137`).

Only `rekey` looks for any of these. **There is no fallback and nothing is promised until `rekey`
finishes.** With a value whose key text changed:

- No read finds its rows. `get` is `ItemNotFound`; queries, `.history()`, `versions()`, batch and
  transaction reads, aggregates, streams and projections read as if the rows weren't there.
- A write of the same key lands beside them. `rekey` then reports `bothKeys` and leaves both. An
  `update` finds no item, and a stream append starts at version 1 under the new key.
- A value can land on another value's old row. `foo bar` under `escapeKeys: true` composes the text
  `foo%20bar` was stored under, so a read of `foo bar` returns that row, a `put` overwrites it and a
  `delete` deletes it. Nothing checks whose row it is: such a check is a read on every operation.
- A unique value isn't seen as taken while its sentinel is under other text, so a duplicate can land.
  `rekey` reports the conflict and overwrites nothing.

So there's a rule: keep the setting, or set it and run `rekey` before serving traffic. A fresh table
has no rows under other text, and there two values never share a key: `test/AliasKeys.test.ts` and
`connected.alias-keys.test.ts` pin that, and that every operation is correct on `foo bar` and
`foo%20bar` after `rekey`, from real rows of every form.

**What upgrading means.** From 1.36 or earlier: nothing, the default composes the same text. From
1.37.0 or 1.38.0: the default reverses their change, so a row with an escapable character in a sort
key, a number whose text they changed, or a time-series event of a string-encoded numeric `orderBy`
needs `rekey`, under the default or with the flag set.

`KeyText136` composes exactly the bytes 1.36 wrote for every key kind (`serializeValue136`
through the same structural composers, and the time-series event sort key from the encoded
`orderBy`). Golden vectors generated once from the published 1.36.0 packages pin it
(`packages/schema/test/fixtures/key-text-1.36.0.json`), and with `escapeKeys` off the real composers
match every one. `fixtures/rows-1.36.0.json`, `rows-1.37.0.json` and `rows-1.38.0.json` hold what the
published packages stored through every key path, and `legacy-rows-1.36.0.json` their projections
and retained history. None of these is ever regenerated from this repo.

**Rows holding no values.** A projection's row tombstone or outbox item says which text its key is
by `__edd_kt__` (`KeyText136.formOfMark`, `markOf`): none is off's, `1` that of 1.37.0 and 1.38.0, `2`
that of `escapeKeys: true` when it differs from off's. `rekey` reads the key back by the mark.

#### `rekey`

`db.tables.<Table>.rekey(options?)` (`TableOperations.rekey`) is the only migration of key text. It
moves every row under text the setting doesn't compose to the text it does, in either direction: off
moves rows from 1.37.0, 1.38.0 and `escapeKeys: true` back to 1.36's text, and on moves rows from
1.36, 1.37.0, 1.38.0 and off to escaped text. Every row is moved or counted, never silently left. Run
it once every instance runs this release under the setting (another instance writes its own text
again); dry run first. It returns a `RekeyReport` (`Table.ts`) and fails with `ValidationError`
(`EDD-9098`) for a bad option or resume token, or with the `DynamoClientError` of a request that
failed.

**Driver** (`internal/Rekey.ts`). A `Scan` of the table — `segments` fibers
(`Segment` / `TotalSegments` when more than one), `pageSize` as `Limit`, a
`maxPages` budget shared by all segments — hands each row to the member owning
it by `__edd_e__` (exact types, then sentinel prefixes `<type>._unique.`), up
to `concurrency` rows of a page at once. Members are the table's entities and
aggregates, those passed to `DynamoClient.make` on the same table, and
`options.streams` (bound or unbound; `DynamoClient.make` registers no stream),
each carrying a handler under the `RekeyHandler` symbol that `Entity.make`,
`Aggregate.make` and `EventStore.makeStream` attach. A row without `__edd_e__`
is `notLibrary`; one no member claims is `unregistered`. A read model's entity
also claims its projection row tombstones (`<type>#tombstone`) and outbox
items (`<type>#outbox`); an outbox on another table is claimed on that table,
for a read model whose projection registered it (`_projectionOutboxes`, one
entry per projection defined on the read model, so a second projection doesn't
hide the first's; under the key attributes of the entry the row holds). A row of a member stored under no text its values
composed is `unrecognizedKey`. A unit that moves together (an aggregate, a
stream, a moved row's target) is claimed once per run (`claim`, `once`), so it is
moved and counted once whichever of its rows the scan reaches first, and a row
reached after it moved — by this run, or by an application write between the
scan and the move — is `unchanged`: `moved` counts what the run moved. After the
scan each member's `finish` runs (`RekeyMember.finish`): an aggregate judges the rows
it found below a root it never saw there.

**Idempotence.** A row moves only when it is stored under a key its values
composed under another form and that key differs from the one they compose now. The scan is
eventually consistent: each move acts on a consistent read and is conditioned on what it read. A rerun
finds every moved row current and moves nothing.

**The chain, in either direction.** Keys spell each other's: under `escapeKeys: true` `foo bar`
belongs where `foo%20bar` was stored. So a row in the way that is another value's old row moves
first (`clearTarget`, up to `DISPLACE_DEPTH` deep), whichever the scan reached first: `foo%20bar`'s
old row to `foo%2520bar`, then `foo bar`'s to `foo%20bar`. With the flag off it's the reverse. Nothing
is overwritten or merged. A row whose holder can't move stops retrying and reports `taken`
(`cantMoveHolder`), and `RekeyReport.conflicts` lists a row once per run.

**Resume token.** `rk1.` + base64url JSON `{ t: tableName, s: positions }`, one
position per segment: `0` not started, `1` done, or the segment's
`LastEvaluatedKey` in the cursor wire form (`internal/Cursor.ts`). A run that
stops at `maxPages` returns it as `resume` (`Some(token)`; `None` once the
whole table is covered), and `rekey({ resume })` takes the token's text; `onProgress` receives the report
so far and a token after each page, once every row of the page is handled, so
an interrupted run resumes redoing at most the pages in flight. The token's
segment count wins; a different `segments`, another table's token or a
malformed one is `EDD-9098`.

**Sharded indexes (#183).** `staleIndexKeys` has a sharded branch for the PK half. When
the stored key differs from what the values compose now and the PK composites
and source are present, the item is rewritten in place (`indexKeysRewritten`):
an `UpdateItem` on the index key attribute alone, guarded on the old key text
and the composites feeding it, including `by`. A write to an attribute feeding
no key doesn't make it retry. A stored key under another layout whose values
can't compose a current one is the conflict `uncomposable`; a row already in the
current layout that can't compose is left alone with no conflict. This is step
2 of adopting a sharded layout: deploy with `previous`, `rekey`, and remove
`previous` once a run reports no conflicts.

**Index keys, on every index: compare with what each form composed, don't parse.** Nothing
reads a value out of a stored key. An unsharded partition key, any sort key and a vector
partition are rewritten only when the stored key is exactly the text a form composed from
the row's values, and that isn't the current text. Each half is judged by itself and by
its bytes. Halves in one attribute compose the same bytes (`EDD-9106`), so no half can
look like another's text under a form, and a half in a table key attribute is never rewritten: the
table key's move carries it, and no update may set it ("Never set a table key attribute", §7,
canonical shapes 13 and 14). A sort key missing a
trailing composite is judged by the composites before the gap, which is what a truncated row
stores. Anything else is left with no conflict: a key an index
policy kept, one lagging its values, one cleared of them. A key the row doesn't have
isn't written, since under `sparse` its absence can be deliberate. A Z-order index's partition half
is a text half like any other, and its sort half is rewritten only when a prefix segment's text
differs: the address keeps its bytes. A run that moves an item reads the moved row and does
the same (`rekeyAfterMove`). The move itself recomposes index keys as an update would.

**Rows under the other numeric kind's text (EDD-9128).** A key composite that stored both
numeric kinds composed each value's own kind's text: 16 digits for `5`, 38 for `5n`. That's a
`Schema.Union([Schema.Number, Schema.BigInt])` before 1.40.0 refused it, or a `Schema.Unknown` given
a `bigint` safe integer. Declared one kind now, a row written with the other is under text its
values, as read back, don't compose. A stored key that isn't its current text is also looked for
with the row's numeric composites as the other kind (`CompositeCodec.kindReadingOf`, the other kind
read from the digits of the stored `N`). So such a row is recognised and moved to the text of its
values as read back: an item, its index keys and vector partitions, its unique sentinels
(`otherSentinelKeys`, `sentinelHeldAt`), a snapshot or tombstone, a time-series event, an
aggregate's partition (`holdsPartition`) and a `many` edge's rows (`oldPosition`). A projection's
row tombstone or outbox item holds no values, so its key is read with each numeric composite as
either kind when the declared reading fits nothing: each composite takes the kind whose value
composes its own text again (`readAsOtherNumericKind`, `KeyText136.readIndexKeys`). Two items whose
values read back as one item (`3` and `3n`) are the conflict `bothKeys`, and both are left. Two rows
of an aggregate's `many` edge that read back as one element compose one sort key, which the
decomposition refuses, as it does for a write: the aggregate is `failed` with that reason and
nothing moves, as 1.39.0 fails any elements composing one sort key. Whether such rows are one
element's or two elements' can't be told from what's stored: a changed sort key declaration, a
setting change and a kind change can each leave two rows under texts of one key. A key with no
numeric composite has one reading, and nothing changes for it.

The search costs nothing on a clean run, and never one composition per combination of kinds. A
stored key that is its current text is never looked for under another: one composition, as before.
Otherwise each field is composed once as the other kind by itself, which shows the stretch of each
key half its value lies in, and the readings are walked stretch by stretch from the left, keeping
those whose text so far begins the stored key, or one of a partition's stored sort keys; the one
left is composed to confirm it. Each field is one decision: a composite in both halves of a key
(`pk: [a, b]`, `sk: [a, b]`) has a stretch in each, and its later stretches follow its first. That
is one composition per field, plus two, under each form, and no key is split on its delimiters.
Where two fields' stretches overlap in one half, each is read as the other kind only alone. A moving row's unique sentinel is looked for before there is a stored key to compare,
so it is read at the keys of a few readings first: the values as they are, as the row's own key
gives them, each alone as the other kind, and all of them, which is every reading of a constraint
over one or two numeric fields. When none of them, and not its current key, holds a sentinel, the
other mixes are read, fewest values as the other kind first, until one does: nothing else moves a
moving row's sentinel, which names its old key. That is at most 2^k reads under each text, `k` the
constraint's numeric values, only for a row that moves and whose sentinel the first readings don't
find; a constraint over one or two numeric fields reads nothing more. `test/RekeyNumericKinds.test.ts` pins a
clean run of an 18-composite index key to its one `Scan`, and a third of them under the bigint's
text to one rewrite, each well under a quarter of a second (`f4ecbf7` took about half a second for
the clean run alone); `test/CompositeCodec.test.ts` pins the count of compositions.

An item or tombstone under its current key doesn't read its sentinels' keys under the other kind's
text, which would cost a read per item on every run: the scan reaches such a sentinel, whose stored
key is compared like any other (`sentinelHeldAt`), and its handler moves it from the key the scan
found it at, whatever mix of kinds that is (`sentinelsUnderOtherKind`). A row that moves looks
there, since its sentinels name its old key. The rows 1.39.0 stored for a constraint over four
fields, each sentinel under another mix (`fixtures/kind-sentinel-mix-1.39.0.json`), pin both, and
the reads each costs, in `test/RekeyNumericKinds.test.ts` and its connected twin.

An event's sort key is composed from the `orderBy` value `append` stored, the Encoded value: a
`Schema.BigInt` is read back below 2^53 as a number and lifted (`storedNumericForm`). Through 1.39.0
`rekey` composed it from the number under `escapeKeys: false` and moved the event to the number's
text. The other-kind reading finds such an event and moves it back.

**A number the declared kind can't hold exactly.** A field that stored both kinds also stored
`bigint`s past 2^53 and fractions. Declared `Schema.Number` now, DynamoDB hands such a `bigint` back
as a `bigint`, which no number holds exactly and `Schema.Number` doesn't read; declared
`Schema.BigInt`, a fraction is held by no `bigint`. The key form takes a stored number as the
declared kind only when that kind holds it exactly (`exactIn`), so such a row composes no key: it's
the conflict `uncomposable` (EDD-9050, "is a value no number holds exactly"), and it and its unique
sentinel stay where they are, never moved to the key of the value rounded to fit nor counted
unchanged. A dry run reports the same. 1.39.0 left them too, but said nothing about why: the
`bigint`s were `unrecognizedKey` and the fractions counted unchanged. The other-kind reading would
otherwise round such a `bigint` to a number and move the row to the rounded value's key, where no read
of it composes. The rows 1.39.0 stored pin it (`fixtures/read-back-keys-1.39.0.json`,
`test/RekeyExactKinds.test.ts` and its connected twin).

**The accepted limit.** The text rewrite leaves an index key that isn't any form's text, as when a row
cleared a composite or the key lags its values. A pin misses it if its text changed: under a sort key half a
broader query finds it where its old text sorts, and under a partition key half `get` still reads it.
Writing the composites puts it back, and so does `repairIndexKeys`, below. Telling such text apart from
current text would take parsing it, and a value can spell anything.

**Index keys that differ, and `repairIndexKeys` (`rekey-repair.md`).** Separately from the text rewrite, each
half of each secondary index of a live item at its current table key is judged against what a `put` of the row's
values writes (`KeyComposer.judgeIndexHalf`, through the key form, a ref's id read from the stored ref). Every
run counts the result in `report.indexKeys` and per member, for no read: `missing`, `truncated`, `lagging`,
`ambiguous`. `rekey({ repairIndexKeys: true })` writes it, off by default: one `UpdateItem` per row with work,
conditioned on the row existing and on each key it writes and each composite those keys come from, as read or
absent (`repairRequest`), so a writer changing any of them wins. On a failed condition it reads once
consistently, judges again and tries once more, then counts the keys in `skipped`; `repaired` counts the keys
written. A key DynamoDB refuses is a `failed` conflict. A dry run makes no write and counts `repaired` as what
it would write, judging what the move would leave for a row that moves.

| Composites on the row | Stored key | `sparse` | `preserve` |
|---|---|---|---|
| All | Equal | Nothing | Nothing |
| All | Differs | SET (`truncated` when the stored key is a leading run of them under any form, else `lagging`) | SET |
| All, and the other half's too | None | SET (`missing`), or `ambiguous` with 2+ composites outside the primary key | SET (`missing`) |
| All, but not the other half's | None | Nothing: `put` wrote no entry | Nothing |
| Trailing ones missing | None, or the truncated text | Nothing (shape 3) | Nothing |
| Trailing ones missing | Anything else | SET the truncated text (`lagging`) | Nothing |
| A hole, or none leading | None | Nothing | Nothing |
| A hole, or none leading | Any | REMOVE (`lagging`) | Nothing |

A composite stored absent (`Schema.UndefinedOr` holding nothing, §7 "Values with no stored form") is missing here
like any other. A row holding neither the value nor the key is fine and costs nothing. A key that outlived its value,
as a clear on an earlier release left it, follows the table's last row: `sparse` removes it, and `preserve` leaves it
until an update clears the field.

`ambiguous` is written by nothing: a `sparse` half with two or more composites outside the primary key and no
key is byte for byte the documented drop (§7, "Telemetry (no alert)"), so a repair could re-admit an alert a
writer ended. Stamped composites don't count towards that two: no writer leaves one out. A half holding
`timestamps.updated` is compared without that composite's text (`lagTolerated`, §7 "Composites the library
stamps"), since an update that can't compose the half leaves it: a key that only lags is no difference, on any run,
and one holding anything else is rewritten once from the row's value and is then fine whatever `updatedAt` does.
A Z-order half holding it can't be read apart, so any address is fine and only a missing one is written. Not
judged: a half in a table key attribute (no write names one); a half whose values compose no key; a sharded
partition key already stored, or without its shard source (the text rewrite owns those). Otherwise a Z-order half
compares bytes and never truncates. For the same reason a move keeps a half absent that's `ambiguous`
(`keptAbsent` in `movedRowOf`).
Aggregates compose their own rows and never called the gate; sentinels and history rows have no index keys.

**A dry run agrees with the real run.** It judges the row the move would write (`movedRowOf`), and
follows a chain: what holds a row's current key is judged by its own handler (`Rekey.displace`,
counting nothing and claiming nothing, since the scan counts it when it reaches it), and what would
stop it is reported, for it and for the row it holds up. Rootless aggregate rows are
judged after the scan, so a dry run agrees with the real run whichever order the scan met them; a run
that didn't read the whole table reports them as `rootNotSeen`, since a later page could bring the root in.

**A row under both keys.** `clearTarget` reports `bothKeys` only if the row is still
at its old key when it finds it at the new one. A page's rows run concurrently, and a
write can move one, so between the two reads another fiber may have moved it.

**Per row kind.** Every write is conditioned on what the move read: a Put
lands only where nothing is (a stream's snapshot: over an older one; a stream
row: over one whose TTL has passed), a Delete or in-place rewrite only while
the row is as read. A write that lands in between wins, and the move reads
again or reports the row (`contended`).

| Row | Move |
|---|---|
| Item under other text | `moveItem`: a consistent read of the row (the scan's may be stale: a move this run made can have taken it along), then one transaction — Put at the current key `attribute_not_exists`, every GSI half recomposed under the index policy, Delete of the old item under `deleteGuard`, unique sentinels moved or re-pointed (`sentinelRekeys`). Another value's old row at the target moves first (`clearTarget`). The same item already at the target is `bothKeys` only if it is still at its old key when read again. A Put cancelled on an existing current item while the Delete's guard passed is `bothKeys`. After the move, a half it couldn't recompose (a truncated sort key before a gap a later composite fills, which `preserve` keeps) is rewritten as for an item at its current key, in the same run (`rekeyAfterMove`, reading the item only when the predicted move, `movedRowOf`, leaves one); a dry run counts it from that prediction |
| Item at its current key | GSI halves and vector partitions whose stored text is exactly another form's text and differs from the current text are rewritten by one `UpdateItem`, conditioned on the item existing, each half still holding that text and the composites the row holds as read (`indexKeysRewritten`). A sharded index's partition key is the exception: it is composed and compared whatever it holds, which is what moves rows into the layout, and one whose values can't compose it is left, the conflict `uncomposable` unless it is already in the current layout. A Z-order sort half keeps its address, one the index policy left behind its values, one kept for a value since cleared, and a table key attribute are not touched. Unique sentinels whose text changed are put at the current key and the old one released (`rekeySentinels`, `sentinelsMoved`) |
| Unique-constraint sentinel | A sentinel the scan reaches (`rekeySentinelRow`) is read back to the row it names, under each form: a sentinel its row's values compose moves with its row or on its own. One with no row behind it and no tombstone keeping it, or whose row's values compose no such sentinel, is `unrecognizedKey`, at one or two extra reads per sentinel on every run |
| Version snapshot, soft-delete tombstone, time-series event | `moveHistoryRow`: consistent read; one transaction: Put at the current key (`attribute_not_exists`), Delete of the old row under `deleteGuard`. A history row keeps its layout (unsegmented, pre-#133, rows move their partition key only). A snapshot whose current key holds the same snapshot (`sameSnapshotAs`: version, incarnation, `updatedAt`) is a copy: one transaction checks the copy is still there and the same and deletes the old row as read, counted as moved. A cancelled transaction reads again, up to `GUARDED_PUT_ATTEMPTS` |
| Tombstone's preserved sentinels (`preserveUnique`) | They name the item's live key, not the tombstone (`restore` re-claims them by it): a sentinel held for the item's old or current live key under its old key is put at its current key and the old one released; one at its current key naming the old live key is re-pointed (`SET _entity_pk, _entity_sk`, conditioned on the pointer as read). In the tombstone's move transaction, or — a tombstone already at its current key — in their own (`sentinelsMoved`). Another item's sentinel at the current key is `taken` and nothing moves |
| Aggregate | The root row's handler (claimed once per aggregate) runs `rekeyCore`: every partition its values composed read consistently; each built row placed — under its current key, an old key, both, or (an alias chain in an unchanged partition, `placeRows`) where the chain's one free key says. A row under its old key moves (Put at the current key `attribute_not_exists`, Delete of the old row conditioned on it being as read, `asReadGuard`); a row whose collection or list index attributes hold other text is rewritten (`UpdateItem` conditioned as read); `created` and `updated` kept as stored. A built row writes what the value decomposes to, but a custom `decompose`'s row (`custom` in `locateRows`) is written as stored, its keys and collection sort key mirror replaced (`itemOf`): decomposing the value read back needn't give what it holds (a `decompose` renaming a transformed field would store it decoded once more on every run, as 1.39.0 did). A move whose target is another move's source waits for it (waves); a wave's writes go in order in transactions of up to 100 items, 4,194,304 bytes by the exact size model and 16,777,216 bytes of request body (`internal/ItemSize.ts` `packRequests`), a move's Put and Delete always in one. **The root moves last**, so a run cut short leaves it where the next run finds the aggregate. A cancelled transaction reads again, up to `REKEY_ATTEMPTS` (3), then `contended`. A row under both keys, or a placement that can't be told, is `bothKeys` and nothing is written. A write moving the aggregate between the partition reads shows its rows under both: with rows in both, the partitions are read again, and while a row read under the old partition has gone from it the attempt starts over; a row placed under both is checked under its old key the same way. An aggregate moves the rows its value decomposes to; any other row stays where it is, unreported, since another member may write rows of its entity types in the partition. With `ownsRows` (§7 "Which rows in its partition are an aggregate's") it moves exactly the same rows and sends the same requests; any other row of its types it reads can't be placed from what's stored, so it's a `failed` conflict (nothing of the aggregate moves) when its own partition key changes, and counted `unrecognizedKey` otherwise. A row below a root the scan never saw is judged after the scan (`rekeyRowBelowRoot`, `rekeyFinish`): counted `unrecognizedKey` if still there, or `rootNotSeen` when the run didn't read the whole table (`maxPages`, `resume`), since a root at its old key on a page it didn't read could still claim the row |
| Projection row tombstone, outbox item | `rekeyProjectionRow`. Its key — its own, or `__edd_row_pk__` / `__edd_row_sk__` — is read back by its mark (`valuelessMove`); no single reading is `unrecognizedKey`. When the values compose another key it moves as a row (`moveValueless`): Put, marked for the setting, at the row's current key plus the item's own suffix (`#outbox#<revision>#<n>`), `attribute_not_exists`, the row key and the sparse index sort key it holds rewritten; Delete of the old row as read (`asReadGuard`), with no claim taken since. An outbox item a drainer holds (`__edd_claimed_until__` not passed) is left: `contended`, until it is delivered. Another value's old row in the way — the row, a tombstone or an outbox item — moves first, by its own kind's handler; any other row there is `taken`. Counted as `tombstone` / `outbox` |
| Event stream | Copy → flip → delete (below), from whichever of its rows the scan reaches first (claimed once per stream) |

**Stream move.** A stream row's keys come from its `streamId` text: every way
to split it at `#` into the stream's composites (a string composite may hold
`#`; up to 256 splits), each part read as its text, number or bigint; the
readings whose key under any form is the row's partition key say where it
belongs, and readings that disagree are a `failed` conflict. `moveStream` reads
both partitions consistently; a row whose TTL attribute has passed is absent,
whether or not DynamoDB has deleted it yet. Rows of another stream id in a partition are their own,
and nothing is merged (`readOwn`). Rows under the current key that the
old partition doesn't have, or has differently (a snapshot aside), are `taken` / `bothKeys`. COPY puts
every row the current key lacks (`attribute_not_exists`, or over a row whose TTL has passed), and a
snapshot over an older one (`asOfVersion <`) — never the other way (`__edd_moved__`
stripped; a GSI stream index attribute holding the old partition rewritten). A
copy that loses to a write copies again. FLIP is one transaction: Update of
event 1 `SET __edd_moved__` (`attribute_not_exists`, and the seal state when the
head is event 1), a ConditionCheck that event N+1 is absent, one that the
head's seal state is as copied (N > 1), and one that the snapshot's
`asOfVersion` and `timestamp` are as copied (or that it is absent). A cancelled
flip copies again, up to `STREAM_MOVE_ATTEMPTS` (8) attempts in all, then `contended`. DELETE
(also the whole move, for rows left under the old key once event 1 there is
moved or gone — a run that stopped after the flip, a write beside it) reads
both partitions again: a row the current key lacks is copied (a command
sentinel), a snapshot newer than the current one copied over it, and a row the
current key holds differently is `bothKeys` and nothing is deleted. Then each
old row is deleted while it is as read (`asReadGuard`): events from the head
down, the other rows, event 1 last. A delete that loses to a write reads again.

**Conflicts** (`RekeyConflict`: member, kind, stored key, target, message):
`bothKeys` (the row is also under its current key; for a snapshot, a
different snapshot of the version), `taken` (another row
holds the target), `contended` (concurrent writes on every attempt, or the attempts exhausted),
`failed` (a `ValidationError` from the move, e.g. values that no longer decode or place a key, or an
aggregate that doesn't assemble), `uncomposable` (a sharded key from another layout whose values can't
compose a current one; a row whose own key holds a value with no key text, `NaN` under `escapeKeys: true`, or one of whose key
composites holds a value no form of its schema takes, `EDD-9050`: `message` carries the refusal). An aggregate whose root is under both
partition keys ("Multiple root items found") is `bothKeys`; one whose root or
rows are gone since the scan read them (moved or deleted by a write) is
nothing. A `DynamoClientError` fails the run.

**What it can't move.** Each is counted on every run and left. `skipped.unrecognizedKey`: a table key
that is no form's text for its row's values; a sentinel with no row behind it, or whose row's values
compose no such sentinel; an aggregate's rows below no root in their partition, including what a 1.37.0
or 1.38.0 run cut short left (root at the current key, edges at the old partition); an aggregate root
under no text; a projection tombstone or outbox item whose key reads as more than one set of values.
`conflicts`, `failed`: a row whose Z-order value no
longer places a key; a stream id whose rows read as two different ids. `conflicts`, `uncomposable`: a
row whose own key holds `NaN` under `escapeKeys: true`, or one of whose key composites holds a value no form of its schema takes. `skipped.rootNotSeen`: an aggregate's
rows below no root, met by a run that didn't read the whole table (`maxPages`, `resume`). Such a run can't
say the root isn't there, since a root at its old key on a page it didn't read could claim them, so a run
over the whole table judges them; only that run counts them `unrecognizedKey`.

**Capacity.** The run is one `Table.rekey` operation measured whatever the
`ConsumedCapacity` setting (`Capacity.measured`): every request asks for its
capacity, and `report.capacity` carries the totals; the span and the observer
follow the context's setting. Judging index keys adds no request: `repairIndexKeys` on a table with nothing to
repair is the scan alone.

**Dry run.** The same scan and consistent reads, no writes: an item's
sentinels are read to count them, a stream's both partitions to judge it.

### Composite key form

Every path composes a composite through ONE function
(`internal/CompositeCodec.ts`) — the write path, `composePrimaryKey`, the query
accessors, `.where()` operands, and the aggregate composer. An operand and a
stored key must be produced by the same code; two call sites disagreeing about
which form to use has been the root cause of every key bug in this area.

**The rule.** Compose from the **Encoded** form, EXCEPT when the domain type is
numeric (`number` / `bigint`) and the encoded form is a **string** — then
compose from the numeric **Type** form so `serializeValue` encodes it in numeric
order.

| composite | Type | Encoded | key uses |
|---|---|---|---|
| `Schema.Number` | number | number | encoded (already numeric) |
| `Schema.BigInt` | bigint | bigint | encoded (already numeric) |
| `Schema.BigIntFromString` | bigint | string | **Type** — a string would sort as text |
| `Schema.NumberFromString` | number | string | **Type** — same shape |
| `DynamoModel.DateEpochMs` | DateTime | number | encoded — epoch, numeric |
| `Schema.Date` / `DateTimeUtc` | Date | ISO string | encoded — ISO sorts correctly |
| untransformed string | string | string | encoded (identical) |

The exception exists because `serializeValue` writes numbers and bigints as
numeric key text (above), which sorts in numeric order, and leaves a string
alone. Composing the encoded `"42"` of a `BigIntFromString` stored
`txn_42` beside `txn_100` and `txn_5`, which DynamoDB orders 100 < 42 < 5 — so
`gte(42n)` returned 42 and 5 instead of 42 and 100.

Resolution per attribute:

| case | behaviour |
|---|---|
| Not a model field (ref-derived `<ref>Id`) | Pass through — already wire-shaped. |
| Numeric Type, string Encoded | Keep a `number` / `bigint`; otherwise `decode` to reach it. |
| No encoding transformation (`ast.encoding === undefined`, documented as "type and encoded forms are identical") | Pass through WITHOUT encoding, so an open bound like `gte(t.status, "d")` on a `Schema.Literals` composite is not rejected by a codec. |
| Has an encoding transformation | `encode`, with `decode -> encode` as fallback so an already-encoded value round-trips to itself; for a value neither takes, the same two from its **stored form** (below). |
| Resolves to neither | **EDD-9050**, naming the attribute, when a key is composed from it. |

Public key and composite input is always the **Type** side — the value the
domain model holds and `.where()` accepts. Internal paths (retain, restore,
soft-delete, the update and delete paths that read the item first, `rekey`) hold
whole rows read back from DynamoDB and reach the composer directly.

**An aggregate's partition key from its stored root.** An aggregate composes its
partition key from domain values: `create` from the object it assembles, `get`
from the caller's key. Its root row holds the encoded ones. `list` and `rekey`
compose the key again from the stored root, so they first decode its partition
key composites as a read decodes them (`rootKeyAsRead`), and compose the key
`create` wrote: `Schema.Option(x10)`'s `Option.some(50)`, stored as a map holding
`5`, composes `some(50)` again, as a top-level number stored divided by ten
composes its own. Through 1.39.0 they composed it from the stored form, so `list`
skipped such a root, `rekey` counted it `unrecognizedKey`, and an `escapeKeys`
change couldn't move it. It costs one synchronous decode of the partition key
composites per root read, and nothing more sent. A root 1.39.0 created under
`Schema.Option` of a transformation holds the value its `create` decoded, unencoded
(that `create` decoded its input as if it were stored), so it reads back as a
value its key wasn't composed from: `Option.some(500)` under `some(50)`. `list` and
`rekey` skip it, as on 1.39.0, and `get` with `Option.some(50)` finds it
(`test/AggregateRootKeyReadBack.test.ts` and its connected twin, over rows 1.39.0
stored).

**Stored form.** The unmarshaller hands a stored `N` back as a `number` while it
is a safe integer and as a `bigint` past 2^53 (`{N:"5"}` → `5`,
`{N:"1152921504606846977"}` → `1152921504606846977n`), whatever the field's
schema says. A field whose Encoded side is a `bigint` and whose schema transforms
(`OptionFromNullOr(BigInt)`, a `BigInt` under a decoding default) takes neither
`5` nor its decode, so the rule lifts a safe-integer `number` to a `bigint` (and,
for a numeric Encoded side, a `bigint` to a `number`). That is the value `put`
handed the rule (the write path holds encoded records), so it takes the same two
steps `put`'s value took: the key `put` composed from `5n`, byte for byte
(`storedNumericForm`). A value as given is tried first: a domain `bigint` stored
as a number is encoded, never taken for its stored form. One rule
for every path: `Batch`, `Transaction`, `Aggregate` and geo compose the same key
from the same row. Unique-constraint sentinels are composed from the Encoded
value, lifted the same way, so a sentinel released by a delete is the one `put`
reserved.

**Reader attributes.** A whole row holds attributes no key is composed from.
`Entity` builds the form with `reads` (the composites of every index, shard `by`
sources, unique fields, vector partitions and the time-series `orderBy`): a
value of any other attribute that reaches neither form is left as it is rather
than refused, since it is never key text.

**Both numeric kinds.** A field whose Encoded side admits a `number` and a
`bigint` (`Schema.Union([Schema.Number, Schema.BigInt])`, a numeric literal or
enum beside `Schema.BigInt`, `Schema.Unknown`, `Schema.Any`;
`storedNumericKinds`) stores either as `N`, and a safe integer reads back as a
`number` whichever was put, so its value alone can't say which key `put`
composed (16 digits, or 38). A field admitting one kind is lifted to it
(`Union([String, BigInt])` reads `5` as `5n`). One declaring both is never
composed into key text: `Entity.make` refuses it at load (**EDD-9128**,
`bothKindsKeyRefusal`) in the primary key, a secondary index half (a Z-order
prefix included; a dimension is refused by EDD-9088), a unique constraint, a
vector partition and a time-series `orderBy`, and `Aggregate.make` in its
partition key, its collection and list keys and a `many` edge's sort key.
A dotted composite (`nested.n`) is the field it names, followed through
whatever holds each segment: `Schema.optional`, `Schema.optionalKey`,
`Schema.NullOr` or another union with `null` or `undefined`, `Schema.suspend`,
and a `Schema.Class`. At load it's the field a row stores there
(`storedFieldAtPath`): each segment is looked up in what its holder is stored
as, so a struct storing a number at `n` and decoding it to a union of both kinds
loads, and one storing either kind there is refused, whatever it decodes to. A time-series
entity's `appendInput` is what `append` encodes and composes keys from, so its
own fields are refused too: `orderBy` and every key composite it carries, and
one declaring the other kind than the model's field, whose events would be keyed
by text no read composes. A field whose kinds can't be read at load,
`Schema.Unknown`, `Schema.Any`, an opaque `Schema.declare`, or a transform whose
stored side is one of those, is judged by value at write instead
(`readsBackOtherwise`): the value DynamoDB returns for it, the marshaller and
the unmarshaller run for real (a `number` for a `bigint` safe integer, `0` for
`-0`), is decoded through the field and compared with the value written,
decoded. A `number` past 2^53 has no stored form: the marshaller refuses it, and
the write's own marshalling reports it, as in any attribute (EDD-9124). One that reads
back as something else is refused with a `ValidationError` (EDD-9128) naming
what it reads back as, and nothing written, on every entity write
(`encodeForWrite`, and `_refuseNotReadBack` for transactions and batches) and
on an aggregate's `create` and `update` (`refuseOtherKindKeys`). A dotted
composite of a `many` edge is judged through the field holding it, never by the
value at its path alone: the top-level field's stored value is decoded as a read
decodes it, the path followed, and the text that composes compared with the text
the edge composes from the element written (`throughFieldJudge`). A row is judged
by each edge a read hands it to, against that edge's own sort key, never
another edge's of the same entity type. Which edges those are is assembly's own
walk (`assemblyWalk`), run over the whole decomposition of the value stored,
rows a diff leaves alone included: a node takes a row whose entity type and
discriminators are its own (`takesRow`), and a node with edges, the root or a
sub-aggregate, leads to them only through its one row, so an edge under an
absent sub-aggregate judges nothing. A struct storing `{ n: 5n }` and
decoding it to `{ n: 5 }` reads back `{ n: 5 }` again, the value its key was composed from, so it
is stored, as on 1.39.0; one whose decode keeps the `5` DynamoDB hands back for a
key composed from `5n` is refused.
`Schema.Unknown` reads `5n` back as `5`, so it is refused; a `Schema.Unknown`
decoded to `Schema.BigInt` by `BigInt(n)` reads it back as `5n`, so it is
stored, under the bigint's text, as on 1.39.0. A declaration's value
(`Schema.Option`, `Schema.Result`, `Schema.ReadonlySet`, an array or struct of
them) goes to DynamoDB as a map, a list or a set, and comes back a plain one:
`Option.some(5)` composes `some(5)`, and the map read back `[object Object]`.
So a key composite storing a declaration takes a value read back as its field
reads it, decoded through the field and encoded again
(`storedFormOfDeclaration`, in the key form and in `storedFormOfRead`), before
its text is composed, and composes `some(5)` again. An object is judged by that
text alone: one whose field decodes the map to the value written is stored, as
on 1.39.0, and one whose field takes the map as it is (`Schema.Duration`,
`[object Object]` for `1000 millis`) is refused. 1.39.0 composed the map's own
text: a `restore` put the item back under `[object object]`, where `get` didn't
find it, and a delete left its unique-constraint sentinel behind. A list or
struct of `Schema.BigInt` beneath a step (a decoding default, a transformation)
comes back holding numbers, `[5]` for `[5n]`, which the field refuses; every
entity read lifts them back (`legacyReads`), and the key form does the same
for a value nothing else takes, so its text is `put`'s and it is stored, where
1.39.0's `restore` couldn't compose the key at all (EDD-9050). A `bigint` inside
a declaration (`Schema.Option(Schema.BigInt)`) comes back as a map holding a
number; it is decoded as a read decodes it before the field's own decode, so
`Option.some(5n)` composes `some(5n)` from the row too, where 1.39.0's `restore`
put the item back under `[object object]` and its delete left the
unique-constraint sentinel behind. That costs two synchronous
decodes of such a value, only for a key composite whose kinds can't be read at
load, and never for a field no key reads. A field no key reads may store both,
and is read as it comes back. Since 1.40.0; 1.39.0 loaded
such a model and composed its keys from the value as read, so a `bigint` safe
integer was restored, updated and listed under the `number`'s key, and a delete
left its sentinel behind. A field once declared both and now one kind keeps rows
under the other kind's text, and `rekey` moves them ("Rows under the other
numeric kind's text", under `rekey`).

**A codec whose `encode` takes its own output is encoded twice.** `Entity.put`
encodes its input (`inputSchema`), then applies the key form, whose fallback
assumes encoding is idempotent. For a codec prepending `x:` it isn't: `"MiX"`
is stored with the key text `x:x:mix`. The entity's own `get` and `delete` do
the same (`encodeKey`, then the key form), so they find it. A multi-item op
takes the caller's DOMAIN key the same way: `composePrimaryKeyOrFail` (`Batch.get`,
`Batch.write` deletes, `transactGet`, `transactWrite` deletes and condition
checks) composes through `_domainKeyForm` =
`_keyForm ∘ makeCompositeStoredForm`, the stored form `put` encodes first
(applied to transformed, non-numeric composites only; every other composite
passes through as given, so its key is what 1.39.0 composed). Up to 1.39.0 these
paths applied the key form alone and composed `x:mix`, so they found, deleted and
checked nothing for such an item. The double encode itself is stored key text and
is left as it is: correcting it is a key-format change.

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

### Z-order Sort Keys (#171)

A secondary index's sort key half may declare `sk: { field, prefix?, zorder: [...] }` instead of `composite` (`ZOrderKeyPart`; full design in `docs/designs/zorder-indexes.md`). The physical attribute is binary (`B`):

```
gsiNsk (B) = seg(prefix_1) ‖ … ‖ seg(prefix_k) ‖ toBytes(interleave(q(dim_1), …, q(dim_m)), W)
```

- **No schema prefix, no entity type, no version byte.** Entity isolation comes from the partition key, which already carries the entity type. A Z-order index can't declare or join a collection (`EDD-9090`).
- **Entries.** Each `zorder` entry is a bare field name or `{ field, ...options }`, and its options follow the field's model type (`ZOrder.DimensionFor`): a range `{ min, max, step? }` for a `number` / `bigint` field, a time window `{ from, unit, bits }` for a date field, the bare name or `{ values?, bits? }` for a literal union or `boolean` (a string union also takes a byte width, a number union a range), a byte width `{ bytes }` or `{ values, bits? }` for a plain `string` field (a plain `number` field takes a range only: its order is the numbers', and `values` on it is `EDD-9088`). The entry never restates the type. `Entity.make` types each entry from the model, so a misspelled field, a misspelled option (a guard on each entry's keys, and on a `{ field, hash }` prefix part's), an option of another kind or a bare name on a field without members is a compile error *(owner 2026-11-01; replaces the `ZOrder.int` / `float` / `dateTime` / `literals` / `string` constructors)*. At runtime, `normalizeGsiConfig` checks each entry's form (`EDD-9086`) and options (`EDD-9087`, an unknown option included), and `Entity.make` resolves it against the field (`EDD-9088`): a range is `int` when `min`, `max` and `step` are all integers and `float` otherwise (a `bigint` field takes integers only), and a bare literal-union entry takes the schema's members in order.
- **Quantization `q`** maps a dimension's key-form value to a level: `int` / `float` (`min`..`max` in `step`s, out-of-range values clamped to the edge levels), `dateTime` (`2^bits` levels of one `unit` from `from`), `literals` (the schema's member order, or `values`), `string` (the first `bytes` UTF-8 bytes). Storage is resolved per entity and field at `Entity.make` (`EDD-9088`); `bits` per dimension at most 53 (128 for `string`), `Σ bits ≤ 512` (`EDD-9089`).
- **Interleave** is MSB-aligned over unequal widths: round `r` takes bit `bits_i - 1 - r` of every dimension still that wide, in declaration order (declaration order = priority). `B = Σ bits`, `W = ceil(B / 8)`; `toBytes` is big-endian and right-aligned (the top `8W - B` bits are zero).
- **Prefix segments** are exact-match: a bare name is `u16be(len) ‖ utf8(cased value)` (the index's effective casing; length in bytes after casing), `{ field, hash: n }` is the first `n` (1..8) bytes of FNV-1a-64 over the same bytes. Prefix-free, so skip-scan can compute successors; the order users see is the encoded order (length, then bytes), not text order.
- **Size** counts against DynamoDB's 1,024-byte sort-key limit; no client pre-check — DynamoDB's rejection is diagnosed (`WriteDiagnosis` renders `B` as `0x…` hex).
- `composeSk` stays string-only (a defect on a Z-order half); `composeZOrderSk` returns a plain `Uint8Array`, `composeSkValue` dispatches, and `composeIndexKeys` / `composeAllKeys` / `composeGsiKeysForUpdatePolicyAware` return `KeyValue = string | Uint8Array`. A value a dimension can't place (`NaN`, an unparseable date, a value outside a `literals` list) is `EDD-9092`, a `ValidationError` on the write.
- **`Table.make` / `Table.definition`** declare the attribute `B`; one attribute declared `B` by one member and `S` by another throws `EDD-9091`.
- **Changing a declaration** (dimension order, `bits`, `min` / `max` / `step`, `from`, `bytes`, a literals dimension's values or their order, the prefix list) changes what stored bytes mean: it needs a new index or a backfill, and the cursor fingerprint rejects old cursors. For a bare literal-union entry the order is the schema's, so reordering the union's members is such a change. Appending a member is safe while the values fit the declared `bits`.

**Write path.** The half's derived `composite` (prefix composites, then dimension fields) feeds the unchanged per-half skip-predicate. An evaluated Z-order half is all-or-nothing — there is no truncation, since a partial address is meaningless:

| Evaluated Z-order half | `'sparse'` | `'preserve'` |
|---|---|---|
| every prefix composite and dimension present in the merged record | SET | SET |
| any absent, none in `removedSet` | REMOVE | noop (may go stale) |
| any in `removedSet` | REMOVE | REMOVE (cascade override) |

A hierarchical prefix therefore does not truncate on the write side: `set({ agencyId }).remove(["officeId"])` on `prefix: [agencyId, officeId]` REMOVEs the half under both policies (the hierarchy is a query feature). `put` writes the half only when every field is present (sparse, as for string halves); `append` recomposes it only when `appendInput` (or the primary key) carries every field. A change within one quantization level writes identical bytes; a change of at least one level, or of a prefix composite, moves the entry (2 GSI writes on the shared GSI partition).

### Write Sharding (#183)

A secondary index's `shards` option stores one logical partition in N physical ones. A partition takes about 1,000 WCU/s, and a GSI that falls behind throttles writes to the table. Full design, reasoning and scoping: `docs/designs/gsi-write-sharding.md`. Guide: [Write Sharding](/effect-dynamodb/guides/sharding/).

```typescript
byTenant: {
  name: "gsi5",
  pk: { field: "gsi5pk", composite: ["tenantId"] },
  sk: { field: "gsi5sk", composite: ["groupId", "deviceId"] },
  shards: 20, // or { count: 20, by: ["groupId"], previous: 1 }
},
```

- **`count`**: an integer from 2 to 256. **`by`**: string-half sort key composites of this index, hashed in place of the primary key composites; checked by type and by `Entity.make`. **`previous`**: migration only, the old layout's count, `1` for the unsharded key; a positive integer, not `count`. Definition errors: `EDD-9099`, `EDD-9101`, `EDD-9102`.
- **Key text.** `!<count>.<shard>` right after the entity type or collection name, the shard zero-padded to the width of `count - 1`: `$fleet-db#v1#devicestate#!20.07#tenantid_t-123`, or `$fleet-db#v1#devicestate#!20.07` on an empty half. Under `escapeKeys: false` a value can hold `#`, so no final segment could be safe: the unsharded key for tenant `t-123#07` would equal shard 07 of tenant `t-123`. So the marker comes before all values, with the flag on or off. An unsharded key's fourth segment always holds `<label>_`, which a marker can't spell, and the count keeps two sharded layouts apart. So reading both needs no filter and no dedupe. Compact keys (#182) will carry the same marker in the same place; nothing is built for them yet.
- **Shard function** (`schema/src/internal/Shards.ts`). `FNV-1a-32(F(text(v1)) ‖ 0xFF ‖ F(text(v2)) ‖ …) mod count`, with `text` = `KeyComposer.serializeValue` over key-form values and `F(s) = s.toLowerCase().toUpperCase()` in UTF-8. Golden vectors pin it; changing it is a breaking change. The fold is fixed, whatever `casing` says, because `"GROUP-A"` and `"group-a"` are one key under `lowercase` and must reach one shard. `L∘U` would fail on `ß` / `ẞ`, which lowercase to one key but fold apart. `0xFF` never occurs in UTF-8, so `("ab", "c")` and `("a", "bc")` differ. `TextEncoder` and `Math.imul` keep it runtime-agnostic.
- **Composing is structural.** `composePk` and the truncating composer always add the marker and throw `ShardSourceError` (`EDD-9100`) when a source value is absent, which the error boundaries turn into a `ValidationError`; an index never bound to an entity throws, as an unbound Z-order half does. So `put`, `create`, `upsert`, `restore`, `Batch`, `Transaction`, `update`, `patch`, retain, `append` and `rekey`'s moves need no per-site change. A key for a sharded index can't be composed unsharded. Soft-deleted items, version snapshots and time-series events strip GSI keys; unique sentinels hold none; EventStore projection rows are entity writes; aggregates compose their own attributes and read no `entity.indexes`.
- **Reads** use `composeReadPartitions`, the only function that returns more than one key: the current shards by number (one when the accessor pins every attribute of the shard source, whether that source is `by` or the primary key), then the `previous` layout's, never pruned. The pins are a leading sort key prefix, so a default source prunes only when the sort key holds the whole primary key. Query behaviour: §10 "Fan-out Queries".
- **Key attributes.** Two key halves of one entity, sharded or not, share an attribute only with the same fields, in the same order and casing, and a sharded partition key only with one sharded the same way. A row can't show which owns the attribute, so the one written last overwrites the other, and an update corrupts even a row that only used one: a sharded index over the table's `pk` would leave the item unreachable by `get`. `EDD-9106` compares definitions: the effective casing, the shard count and source, a Z-order half's full declaration, and the text each half composes with a stand-in per exact attribute (`KeyComposer` itself), which is how a collection's label counts as well as the fields. `Entity.make` refuses what no schema can reconcile, and `Table.make` decides a casing left to the schema, before binding any member; an entity on two tables is judged by each. With one rule for every key, halves with the same definition build the same text in either role, so an inverted index is no special case (canonical shape 14 in §7). One entity can't use one physical index twice, even over the same fields (`EDD-9108`); different entities sharing one stay fine. The types refuse a sharded `pk.field` equal to the table's `pk` or `sk`, any index's `sk`, or an unsharded index's `pk`; two sharded indexes that differ, and non-literal `field`s, are runtime only, as is every pair with nothing sharded, since literals can't prove two halves the same and a type-level check that disagrees with the runtime would be worse than none.
- **Collections.** Every member must declare the same `count` and `previous` (`EDD-9103`), since the partitions read are shared. `by` may differ. A collection query always reads every shard.
- **Refused** (`EDD-9104`): `.within()`, skip-scan and `.zorder()` on a sharded accessor, and a `GeoIndex` over a sharded index. A Z-order sort key without `by` is allowed: the merge compares bytes.

### Special Key Patterns

**Unique constraint sentinel:**
```
PK: ${schema}#{version}#{entityType}.{constraintName}#{fieldValues}
SK: ${schema}#{version}#{entityType}.{constraintName}
```

**Version snapshot:**
```
PK: (same as current item)
SK: ${schema}#{version}#{entityType}#v#[{item}#]{zeroPaddedVersion}
```

**Soft-deleted item:**
```
PK: (same as current item)
SK: ${schema}#{version}#{entityType}#deleted#[{item}#]{isoTimestamp}
```

**`{item}` — history of items that share a partition (#133).** An entity whose
primary sort key has composites keeps several items in one partition, so each
item's history keys carry its identity: the composite part of its live sort key
(`KeyComposer.composeHistoryItemSegment`, e.g. `line_a`), inserted after the
marker (`DynamoSchema.HistoryKeyOptions.item`). Siblings therefore never share a
version sequence, a snapshot row or a tombstone; `versions`, `getVersion`,
`deleted.get`, `restore`, `highestRetainedVersion` and `purge` key by the item,
and `deleted.list` keeps the partition-wide prefix (every item's tombstones).
Without sort key composites there is no segment, and the keys are byte-identical
to every earlier release's. The segment sits after the marker, not after the
live sort key as time-series events do (`<currentSk>#e#…`): the marker keeps the
type-wide `begins_with` prefixes valid, so a primary-key query narrowed by sort
key composites (`begins_with($app#v1#line#line_a)`) can never reach a history
row, and a single-item entity's keys stay unchanged. `purge` of such an item
removes its live row, rows nested under it, its own history, and history an
earlier release wrote without a segment whose stored composites compose its
live key; siblings are untouched. An entity without sort key composites purges
every row of its own in the partition. Either way, only rows of its own entity
type (`__edd_e__`): another entity sharing the partition through a collection on
the primary key keeps its rows (purge used to delete every row in the
partition).

**History written before the segment stays readable.** Rows an earlier release
wrote for such an entity sit under the partition-wide keys (`#v#0000003`,
`#deleted#<ts>`), all items' in one sequence. A row there belongs to the item
whose live key its stored composites compose (`isItemsRow`), and every reader
of one item's history reads them too (`legacyHistory`: a `BETWEEN` on
`<prefix>0`…`<prefix>:` — a version or timestamp starts with a digit, a
segment with a composite name; a segment can still start with a digit if a
composite's NAME does, so rows with a `#` past the prefix are dropped. A
keys-only `Limit 1` probe of the range runs first, and only a hit reads it in
full, so a partition with no such history costs one small read):
`getVersion` falls back to the unsegmented key when the item's own is missing;
`deleted.get` / `restore` take the later of the item's own latest tombstone and
its latest unsegmented one (`latestTombstone`); `highestRetainedVersion` takes
the higher of both; `deleted.list` is partition-wide and lists them anyway.
`versions` stays a lazy `Query`: its `prepare` hook (run once per terminal)
looks for the item's unsegmented snapshots and, if there are any, widens the
`begins_with` to the partition's history and keeps the item's own rows plus
those not already held under its own key. **Precedence:** a version held both
ways is read from the segmented row; of two tombstones, the later wins (the
segmented one on a tie).

**History rows are not items.** Snapshots, tombstones and time-series event
items keep their entity's `__edd_e__` (the history readers filter on it), so the
ownership filter alone admits them to a primary-key query, a scan, or a
collection on the primary key. A row is dropped only when it is positively
history: the sort key composed from its own stored composites
(`liveSkOf(toDomainView(composites))`, only those attributes unmarshalled) is not
its stored sort key, or they don't compose, AND the sort key has a history
layout — `#v#[…#]<7+ digits>` (retain), `#deleted#[…#]<ISO timestamp>`
(softDelete), or `#e#` after the live key less its composites (timeSeries). A
live row composes its own key, whatever its values or collection names hold
(`#e#`, `deleted`, `v`); a row the current composer can't reproduce (an unpadded
number composite written by 1.15, a row missing a composite) isn't history-shaped
and is read as on main. `Entity._liveRows` (for `retain` / `softDelete` /
`timeSeries`; otherwise `undefined`, and the query is unchanged) drives
`Query`'s `liveRows`, applied to rows as they arrive, before decoding or
counting, for queries and scans alike (a query can't name a key attribute in its
filter, and a scan's filter saves no read capacity). `limit` is sent as `Limit`
on the first request and each later request asks for twice the last
(`computeRequestLimit`, capped at 100,000; `pageSize`, when set, is used as is):
a run of `n` history rows costs about `log2(n / limit)` requests, where sending
the remainder cost one per row for `limit(1)`. The surplus past `limit` is
discarded and the cursor rebuilt from the last item returned. `maxPages` still
bounds requests, so a capped query can return fewer items than `limit` when rows
are dropped — as with a filter. `count()` reads only the sort key and composites (`reads`) of each row; a
`select` also reads them. A collection on the primary key judges each row by the member its
`__edd_e__` names. GSI queries never meet history rows, which carry no index keys.

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

**Two-way payload classification.** v1.7.x collapses the v1.6 three-way classification (present / explicit-clear / omitted) to two states: **present** or **absent**. `attr: null`, an `append`'s `attr: undefined`, and "key omitted from payload" all mean "absent" for GSI-composition purposes. An update's `attr: undefined` never reaches the composer as a payload value: it is `.remove([attr])` (see "Clearing a field" below).

| Payload state | What library does for GSI composition |
|---|---|
| `attr: <value>` | Use the value as a slot in the composed half |
| `attr: null` *or* an `append`'s `attr: undefined` *or* (key omitted) | Treat as **absent** — the composition is built from the leading prefix of present values |
| An update's `attr: undefined` | In `removedSet`, not in the payload — the same as `.remove([attr])` |

`set({ attr: null })` is no longer a separate "drop signal" — it still REMOVEs the attribute from the item (the data-attribute REMOVE clause), but it does not separately cascade-drop the GSI keys. Drop-via-cascade goes through `Entity.remove([attr])` instead.

**Per-half evaluation gate (reframed in v1.7.3 as a skip-predicate — closes the empty-composite-half regression AND the class of degenerate-case bugs).** Before the structural rule even runs, each half is asked a single question: *can this half be safely skipped?* The answer depends only on whether the gate's purpose — **multi-writer protection** — actually applies. **If the half cannot be safely skipped, it is evaluated** (SET / REMOVE / noop per the structural rule). The skip predicate is:

```ts
// Skip evaluation only when multi-writer protection actually applies:
// composites exist (otherwise the half value is a constant prefix and
// nothing to multi-writer-clobber); no explicit removal of one of the
// half's composites; no composite is in `updatePayload`; AND at least one
// composite is unknown to `keyRecord` (#183). A half wholly known from the
// key record recomposes to what it already is. One composite in the key
// record is no claim on the half: the others can change, and this writer
// didn't name them.
const shouldSkip =
  halfComposites.length > 0 &&
  !halfHasRemoved &&
  halfComposites.every((c) => !(c in updatePayload)) &&
  halfComposites.some((c) => !hasValue(keyRecord[c]))
if (shouldSkip) continue  // leave this half's key attribute alone
```

**Why a skip-predicate, not a touched-predicate.** The gate exists for exactly one reason: to prevent writer A from clobbering keys for halves it doesn't own when writer B does own them. The skip-predicate states that purpose *directly* — "skip iff multi-writer protection applies." Every degenerate case (empty composite list, composites entirely entity-PK, future shapes) negates `shouldSkip` for an obvious structural reason, without enumeration. The pre-v1.7.3 framing inverted the question into a "touched" predicate that had to enumerate every case for which the half *should* be evaluated as a chain of `||` clauses. Each missed shape required another tactical patch — v1.7.1 missed the multi-writer leak (#41), v1.7.2 missed the PK-composites-only case (#43), v1.7.2 then missed the empty-composite-half case (#46). The skip-predicate closes the entire class structurally.

**Walk-through against the canonical shapes.** Each row confirms the skip-predicate is observably equivalent to the cumulative tactical fixes of v1.7.1 + v1.7.2 (no API changes, no behavior changes for existing inputs):

| Half shape | Skip-predicate evaluates to | Outcome |
|---|---|---|
| Empty composite list (`composite: []`) | `length > 0` is false → not skipped | Evaluate (constant entity prefix) — **closes #46** |
| PK-composites-only (composite ∈ keyRecord) | `some(NOT in keyRecord)` is false → not skipped | Evaluate (idempotent SET) — preserves v1.7.2 #43 fix |
| Mixed: a primary key composite and a mutable one, neither in the payload (shape 10) | `some(NOT in keyRecord)` is true → **skipped** | Skip — the stored key stays byte for byte (#183) |
| Multi-writer not touching this half | `every()` and `some()` true, length > 0, !hasRemoved → **skipped** | Skip — preserves v1.7.1 #41 fix |
| Caller asserts authority via payload | `every(NOT in payload)` is false → not skipped | Evaluate |
| Caller invalidates via `Entity.remove([...])` | `!halfHasRemoved` is false → not skipped | Evaluate (cascade override may apply under preserve) |

**Why two input sources are checked, not one** (preserved from v1.7.2). Composites that are *also* entity primary-key composites (e.g. `byChannel: { pk: [channel], sk: [deviceId] }` on an entity with `primaryKey: [channel, deviceId]`) arrive through `keyRecord`, never through `updatePayload` — the writer addresses the row by key, doesn't restate those values in `.set({...})`, and `.append()` deliberately separates structural fields from the SET clause. The skip-predicate's `some(NOT in keyRecord)` clause keeps these halves un-skipped on every write, and the structural rule composes them from the always-present PK values. The behavior is idempotent — re-SETting the same composed value from immutable PK composites produces the same key — so there is no multi-writer regression (see issue #43). That argument covers a half **every** composite of which is in `keyRecord`, and only those: from v1.7.2 through 1.38 the clause was `every(NOT in payload AND NOT in keyRecord)`, so one primary key composite was enough to wake a half whose other composites were mutable. An unrelated update then composed from what it had: a leading hole REMOVEd the key under `'sparse'` (the item left the index) and a trailing absence truncated it under `'preserve'` (`[channel, zone]` lost `zone`, moving the item to another partition). Shape 10 pins the fix.

**Why empty composite lists are always evaluated** (NEW in v1.7.3). For a half with `composite: []`, the value is a *constant* (the bare entity / collection prefix). There is nothing for another writer to clobber, no per-call decision to make. The pre-v1.7.3 touched-predicate's `.some(...)` clauses all returned `false` for an empty array, classifying the half as untouched and skipping it — leaving items with one half SET and the other missing, invisible to the GSI (#46). The skip-predicate's leading `length > 0` guard short-circuits before `every()` is ever asked, and `classifyHalf` (which already correctly handled empty composites as `{ kind: 'set', length: 0 }`) is finally reached.

**Why `'sparse'` still works.** `'sparse'`'s contract is *with the half's owner*. If the writer names none of the half's composites in the payload, and the key doesn't supply all of them, they aren't claiming ownership of this half on this call, and the skip-predicate skips the half. The writer-scope concept #38 was reaching for falls out of payload-plus-keyRecord contents naturally.

**Design history.** The gate has been progressively reframed:
- **v1.7.0** introduced the touched-predicate (`updatePayload`-only) to fix the v1.6 GSI-wide cascade. Closed the original GSI-blast bug but introduced the multi-writer leak.
- **v1.7.1** added the `removedSet` arm to the touched-predicate (multi-writer leak fix — #41).
- **v1.7.2** added the `keyRecord` arm to the touched-predicate (PK-composites-only fix — #43).
- **1.39** (#183) narrowed the `keyRecord` arm to halves wholly known from the key record, closing shape 10. The skip-predicate's `every(absent in both)` clause had evaluated any half with one composite in the key record, which is what the #43 idempotence rationale never covered. No stored key text changes; a row an earlier release already damaged stays as it is until a write names the half's composites, or `rekey({ repairIndexKeys: true })` repairs it.
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
| **noop** (leave key alone) | No composite of this half is in the payload, none in `Entity.remove([...])`, AND the key record doesn't hold every composite (per-half evaluation gate) |
| **SET full** | Half touched + all composites have values supplied in payload (or available from primary key) |
| **SET truncated** to leading prefix | Half touched + some leading composites have values, trailing absent, no hole |
| **REMOVE** this half's key | Half touched + can't compose (empty leading prefix OR hole pattern), AND policy is `'sparse'` OR a composite is in `Entity.remove([...])` (cascade override) |
| **noop** (stored key may go stale) | Half touched + can't compose, policy is `'preserve'`, AND no composite is in `Entity.remove` |

The roll-up is **per-key** — each half's outcome applies to its own key attribute only. PK dropping doesn't drop SK; SK dropping doesn't drop PK. The item may be invisible in the GSI during a single-half-dropped period (DDB needs both for projection — the projection invariant for readers, not a library behavior), but the surviving half's value persists. When the missing half is later composed again (e.g. telemetry writes `{ alertState, timestamp }` after a clear), the item rejoins the GSI under the still-current other half *without that other writer needing to re-fire* — the v1.7.0 multi-writer bug (#41 bug-1) is closed.

**A stale key and the reads that check rows.** Under `'preserve'` the noop above can leave a half's key composed from a composite's earlier value while the attribute holds the new one. A key condition judges such a row by its key, as 1.36 did; a `.within()` row check (#171 — bounds on composites after the key condition, every bound under the `filter` plan) judges it by the stored attribute. Row checks trust the attribute: a bound on a stale composite can admit a row by its key and drop it by its value, so the `key` / `skip-scan` and `filter` plans can disagree on that row. `.where()` never checks rows.

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

| Composite is... | `Entity.remove` | `set` with `undefined`, the same write |
|---|---|---|
| **One a row can lack** (`Schema.optional`, `Schema.optionalKey`, the `OptionFromOptional` family; a decoding default stores the default instead of dropping the half) | `update(key).remove(["composite"])` | `update(key).set({ composite: undefined })` |
| **One a row can't lack** (`Schema.String`, a primary-key composite) | Refused: a compile error, and a `ValidationError` before anything is sent | The same |

Naming any one composite of a half is enough — `Entity.remove` doesn't require enumerating all of them. `null` is **never** valid for a composite (EDD-9025 rejects nullable composites at make-time).

**`Entity.remove([attr])` cascade is per-half (NEW in v1.7.1).** When an update's REMOVE list contains a composite attribute, the cascade applies only to the half(s) containing that attribute. Other halves follow the per-half evaluation gate (untouched → noop). v1.7.0 issued a GSI-wide REMOVE (both `gsiNpk` AND `gsiNsk`) for any composite in the cascade set — that GSI-wide blast radius is gone in v1.7.1. The cascade still REMOVEs the affected half's key; if the surrounding `set` provides values for the half's other composites, the structural rule may still compose a truncated prefix (see set/remove asymmetry).

**Decision algorithm (per GSI).** Given merged record `M = { ...storedKeyAttrs, ...payload }` (treating `null`/`undefined` payload values as absent) and `removedSet` (composites named in `Entity.remove([...])`):

For each half (PK then SK), independently:

1. **Evaluation gate (skip-predicate, v1.7.3).** If the half's composite list is non-empty AND no composite is in `removedSet` AND no composite is in `payload` AND at least one composite is absent from `keyRecord` → `noop` (skip — leave the stored key untouched, multi-writer protection applies). Otherwise the half is **evaluated**, continue. (Halves with empty composite lists short-circuit on the leading `length > 0` guard and are always evaluated — the value is a constant prefix; closes #46. Halves whose composites are all entity-PK composites fail the `some(NOT in keyRecord)` clause and are always evaluated — the structural rule composes idempotently from the immutable PK values; closes #43. A half mixing a PK composite with a mutable one passes the clause and is skipped; shape 10.)
2. **Structural rule.** Walk the half's composite list left-to-right. Find the longest leading prefix of present values in `M`.
3. **Classify the outcome:**
   - **Compose succeeded** (leading prefix is non-empty AND no hole — i.e. all absent composites are at trailing positions): SET this half's key from the leading prefix. Done.
   - **Compose failed** (empty leading prefix OR hole pattern):
     - Policy is `'sparse'` → `REMOVE` this half's key.
     - Policy is `'preserve'` AND any composite of this half is in `removedSet` → `REMOVE` this half's key (cascade override).
     - Policy is `'preserve'` AND no composite of this half is in `removedSet` → `noop` (preserve preservation; stored key may be stale).

The two halves' outcomes are emitted independently — each affects only its own key attribute. There is no GSI-wide cascade. There is no longer a `'hole-throw'` outcome (EDD-9024 deprecated — see below).

**`put()` semantics (unchanged).** `put()` does not consult `indexPolicy`. It writes a complete item from scratch — any missing composite means "this item is not in that GSI." The existing `tryComposeIndexKeys` path (omit GSI keys when any composite is absent) is preserved as-is. `indexPolicy` exists specifically to resolve the update/append ambiguity, not the put case.

**`.append()` semantics (time-series) — same composer.** v1.7.x unifies append with update. `.append(input)` calls the same composer as `.update(...).set(...)`, with the encoded append input passed as both `updatePayload` and `keyRecord` (v1.7.2 — see #43; the v1.7.1 path filtered PK composites out of the payload, which combined with the gate-only-checks-payload bug to skip GSI evaluation for any half whose composites are entirely entity-PK composites). Composites outside `appendInput` are simply absent under the structural rule, and the per-half evaluation gate applies — a half with a composite that neither `appendInput` nor the entity primary key supplies is untouched and follows the noop branch, even when another of its composites is a primary key composite (shape 10), since `appendInput` always repeats the primary key.

For sparse GSIs with a composite outside both `appendInput` and the entity primary key, the half is untouched → noop. Sparse only fires when the writer touches the half but can't compose it. This matches the consumer-side multi-writer recommendation: sparse GSIs should be single-writer-per-half by design.

For GSIs whose composites are entirely entity-PK composites (e.g. `byChannel: { pk: [channel], sk: [deviceId] }` on a Telemetry entity with `primaryKey: [channel, deviceId]`), the half is always touched (PK composites are always in `keyRecord`), the structural rule always composes from the immutable PK values, and the resulting SET is idempotent — every write re-emits the same composed key. This is the correct behavior; v1.7.0 / v1.7.1 silently skipped these GSIs, leaving items invisible to channel-scoped queries.

**EDD-9024 (`CompositeKeyHoleError`) deprecation — runtime-irrelevant in v1.7.1.** The class is kept exported for back-compat but no longer thrown at runtime. The original v1.7.0 throw protected against an `[A, _, C]` shape under preserve — but the type system already catches the only "wrong" case the throw was guarding (required composites can't be omitted under `exactOptionalPropertyTypes` since v1.7.0 reverted the NullishOr widening; the only legitimate runtime hole is "optional leading composite absent + present trailing composite," which is a normal write the consumer expressly chose). Under v1.7.1 the hole pattern collapses into the unified can't-compose rule (drop under sparse, noop-or-cascade-override under preserve). See `Errors.ts` for the deprecation note on the class.

**EDD-9025 — composite attribute schemas must not include `null` (unchanged from v1.7.0).** At `Entity.make()` time, the library walks every composite across `primaryKey`, every entry in `indexes`, and every entry in `unique` constraints. For each composite attribute it inspects the field's Schema AST and throws `CompositeNullableError` (EDD-9025) if `null` is reachable in the type union (`Schema.NullOr`, `Schema.NullishOr`, `Schema.Union` with a Null branch, custom-named field via `DynamoModel.configure({ field })` rename that resolves to a nullable schema, etc.).

The semantic justification: composites participate in string composition (`acc#X#alert#Y`); null is not a meaningful slot value, only present-with-value or absent. Allowing `Schema.NullOr` on a composite would let `set({ composite: null })` typecheck and then immediately blow up at runtime (or worse, silently produce a key with the literal string `"null"` as a slot). EDD-9025 catches this at make-time.

The sparse pattern is still expressible — use `Schema.optional(...)`, which produces `T | undefined` (without `null`). An update's `undefined` clears the composite; an `append`'s is "absent" under the two-way classification.

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
| Telemetry (explicit clear) | `{ alertState: undefined, timestamp: T2 }` | untouched, **noop** | `alertState` in `removedSet`, can't compose → REMOVE gsi1sk, and the attribute | Same — invisible, gsi1pk preserved |
| Stamp (unrelated write) | `{ published: {...} }` | untouched, **noop** | untouched, **noop** | Unchanged — both halves preserved (the v1.7.0 leak is closed) |
| Telemetry (rejoin) | `{ alertState: "active", timestamp: T3 }` | untouched, **noop** | touched, SET full → `alert#active#ts#T3` | Re-visible under preserved gsi1pk + new gsi1sk; **no enrichment re-fire needed** |
| Hierarchical demote (different entity, multi-composite SK) | `update(key).set({ region, country, city }).remove(["site"])` | n/a | touched (set + removedSet), trailing-absent → SET truncated to `region#APAC#country#AU#city#Sydney` | Re-indexed at city scope |
| Explicit drop | `update(key).remove(["alertState"])` | untouched, **noop** | touched (alertState in removedSet), can't compose → REMOVE gsi1sk | Invisible; gsi1pk preserved (per-half cascade — no longer GSI-wide) |
| Cascade override under preserve | `{ pk: "preserve" }`, `update(key).remove(["accountId"])` (no surviving pk composites) | touched (cascade), can't compose + preserve + cascade override → REMOVE gsi1pk | untouched, **noop** | gsi1pk REMOVE'd via cascade override |

**Multi-writer entity design rule.** Each GSI half should be entirely owned by a single writer's domain. The library does not paper over cross-writer composite ownership — that's a consumer-side modeling discipline. With v1.7.1's per-half evaluation gate and the per-half outcome rule, a writer that doesn't touch a GSI's composites simply doesn't supply them, and the half no-ops regardless of policy. There is no per-composite leakage across writers like in v1.6, and no GSI-wide blast radius like in v1.7.0.

**v1.7.0 / v1.7.1 → v1.7.2 PK-composites-only regression callout (closes #43).** The v1.7.1 per-half gate consulted only `updatePayload`. For GSI halves whose composites are entity-PK composites (a common pattern: tenant-scoped queries, entity-key-projected GSIs), `updatePayload` never carried those composites — the writer addresses the row by key, never restates them in `.set({...})`, and `.append()` further filtered PK composites out of its payload before passing to the composer. The gate saw both halves as untouched, skipped GSI evaluation entirely, and never wrote `gsiNpk` / `gsiNsk`. Items written under v1.7.0 / v1.7.1 against such GSIs were invisible to GSI queries. v1.7.2 fixes this in two places: the gate now also counts `keyRecord` membership (so PK composites carried alongside the payload count as "touched"), AND `Entity.append()` no longer filters PK composites out of the payload it passes to the composer (the filter never solved a real problem and silently broke this pattern). Affected items repair on the next `Entity.update()` against them — the gate now fires, the structural rule composes the immutable PK values, and the missing GSI keys are SET. No data migration needed; reads via the GSI start returning these items as their next update lands.

**v1.7.0 / v1.7.1 / v1.7.2 → v1.7.3 empty-composite-half regression callout (closes #46).** The v1.7.2 per-half gate, even after the `keyRecord` broadening, still classified halves with **empty composite lists** as untouched. For an empty composite array, every `.some(...)` clause in the touched-predicate trivially returned `false`, so `Entity.update()` would skip composing the half entirely — leaving items with one half SET and the other missing, invisible to the GSI. The shape is common in single-table designs: a sparse "lookup" GSI like `byDeviceBinding: { pk: [deviceBinding], sk: { composite: [] } }` writes the SK as a constant entity prefix on every visible item, but the v1.7.0–v1.7.2 gate skipped the SK because no composite of an empty list can be "in" anything. v1.7.3 reframes the gate as a skip-predicate keyed on the gate's actual purpose (multi-writer protection); the leading `length > 0` guard short-circuits empty-composite halves to *always evaluated*, and `classifyHalf` (which already handled empty composites correctly as `{ kind: 'set', length: 0 }`) is finally reached. Affected items repair on the next `Entity.update()` — the next write composes the missing half from the constant prefix and the item rejoins the GSI. No data migration needed.

#### Sharded partition key halves (#183)

`by` attributes are sort key composites, and the skip-predicate looks only at a half's own composites, so an update setting only `groupId` would leave the stored shard stale and pruned queries would miss the item. **`by` attributes are therefore dependencies of the PK half, but only when the writer touches them.** `keyRecord` membership doesn't count: the retain path's `keyRecord` holds the whole item, and a default source is immutable, so neither is evidence of a change.

Over the `by` attributes only: **T** one has a value in the payload; **N** one is `null` in the payload, or `undefined` in an `append`'s (an update's `undefined` is **R**); **R** one is in `removedSet`; **A** a source attribute is absent from the merged record; **PT** a PK composite has a value in the payload.

**Gate.** The PK half is skipped iff the existing skip-predicate holds and not (T or N or R). An empty PK half with `by` is no longer a constant, so it is skipped when `by` is absent from payload and `keyRecord` and not T / N / R. An empty PK half without `by` is never skipped, as before.

**Outcome**, where P = `classifyHalf(pk composites, merged, policy.pk, hasRemoved)`:

| Case | Condition | Outcome |
|---|---|---|
| 1 | R | REMOVE, both policies |
| 2 | P = drop, T, PK composites merely omitted | Fail `EDD-9100`, both policies: a `by`-only update can't compute the new shard, and evicting the item isn't what the writer asked for |
| 3 | P = drop, otherwise | REMOVE: `sparse` can't-compose, or a removed or explicitly nulled PK composite. No unsharded key is written |
| 4 | P = noop, T | Fail `EDD-9100`: the stored shard would go stale |
| 5 | P = noop, otherwise | noop |
| 6a | P = set, not A, T, and the SK half would keep its text (a hole, under `preserve`) | Fail `EDD-9100`: the shard would follow the new value while the sort key stays at the old one, and no pin could reach the row |
| 6 | P = set, not A, otherwise | SET sharded, truncated included |
| 7 | P = set, A, N and `sparse` | REMOVE |
| 8 | P = set, A, PT or T | Fail `EDD-9100`: moves the tenant without `by`, or changes one `by` attribute without another |
| 9 | P = set, A, otherwise | noop: an unrelated `.set({ status })` must never evict or fail |

Composer option `onMissingShardSource: "keep"` turns the failing cases into a noop for the two callers that compose from partial knowledge and don't write the result as-is: the pre-check at the retain branch point (the retain and computed branches then read the full item and compose again) and the move path, which recomposes a stored row. So a `by`-only update fails on the standard path and succeeds on the retain path, which has the composites. The SK half's own outcome is unaffected; case 6a only asks what its rule would do, and under `keep` it is a noop on both halves.

A `put` missing a `by` value writes no index entry at all (`tryComposeIndexKeys`, sparse as ever), never an unsharded key.

#### Composites the library stamps

`timestamps.created`, `timestamps.updated` and, under `retain`, the `versioned` attribute can be index composites. The rule that keeps the key and the row together differs for each, because a write knows each differently.

**A write that builds a whole item stamps first and composes from what it stamped.** `put`, `create`, `upsert` of a new item, `restore`, `Batch.write`, `transactWrite`, `EventStore` additional items and a projection's rows all go through `stampsOf` or `validateAndBuildPutItem`. A value the caller supplied wins over the stamp, and the key holds it. A guarded put over an existing item carries its stored `createdAt` and next version forward, then recomposes the keys holding them (`planPut`'s `composeKeys`). A retain snapshot strips its keys as ever. A vector partition follows the same order.

**An update stamps `updatedAt`, and the stamp is not a claim on the half.** `composeGsiKeysForUpdatePolicyAware` takes `stamped` (in key form), and a half holding one is gated by `writerLeavesStampedHalf`, not the skip-predicate: only its *other* composites count. If one of them is on neither the payload nor the `keyRecord`, and none of them is cleared by name, the half is left, under either policy, and its key lags until a write can compose it. Otherwise it's evaluated with the stamp merged in, by the usual rules. Counting the stamp as touching the half would make `[status, updatedAt]` "touched but can't compose" on every unrelated `.set({ note })`, which under `sparse` drops the row: exactly what #183 stopped. Pure `[updatedAt]` has no other composite, so it always moves. A half with two others and one named (`[status, region, updatedAt]`, `.set({ status })`) is left whole rather than truncated as the same half without the stamp would be: the stamp at the end means no prefix of it is a key a query would look for. `.remove()` still cascades (`hasRemoved` runs first), and `.set({ status: undefined })` is the same clear by the time it gets here (`normalizeClears`): under either policy `[status, updatedAt]` loses its key with its value, and `[updatedAt, status]` truncates to the stamp. A clear of what isn't in the half leaves it. A clear of the stamp itself is refused: a date the library stamps is an attribute it manages, and `.set({ updatedAt: undefined })` means stamp it. An update that reads the row first (`retain`) has every composite on its `keyRecord`, so its half always moves. A caller's `updatedAt` in the payload changes nothing about any of this.

**`createdAt` is an ordinary, stable composite.** An update doesn't stamp it and can't name it (it's stripped from the update schema), so the skip-predicate applies: `[createdAt]` is left, and `[status, createdAt]` on `.set({ status })` truncates to `status_b` under both policies, the existing partial-payload rule. `rekey({ repairIndexKeys: true })` restores it. A read-first path (retain, a unique rotation) has the value, and composes the whole key.

**`version` isn't known without a read**, so an index over it is refused (`EDD-9121`, at `Entity.make` and at the type level) unless `retain`, whose every write reads the item. On that path the next version is a stamp like `updatedAt`. A primary key over `updatedAt` or `version`, and `shards.by` over either, are refused whatever `retain` says: a primary key never changes, and a shard would go stale on every write. `createdAt` is allowed in both.

**An upsert over a value it keeps.** An `upsert` writes `createdAt = if_not_exists(...)` and an immutable field likewise, so a key composed from the input can disagree with what the write keeps, and no expression can splice a stored attribute into a key. It doesn't read to find out. Each half of a secondary key is judged on its own (`upsertKeyPlan`):

| Half | Written | Stands on an existing row when |
|---|---|---|
| Holds nothing kept | SET from the input, as ever | Always |
| Holds only kept values and primary composites (`[createdAt]`, `[region]`, `[id, region]`) | `if_not_exists`: the key stays | The row has the key |
| Also holds something the upsert overwrites, and the input has every value (`[region, status]`, `[region, updatedAt]`, `[status, createdAt]` with `createdAt` supplied) | SET from the input | Each kept value is stored as the input has it, or isn't stored |
| Holds a `createdAt` the input doesn't supply, and something the upsert overwrites (`[status, createdAt]`) | `if_not_exists`: the key stays | The row has the key, and the other values are the input's: the key is then already right |

A new row takes the composed key. A write that doesn't stand is rejected with `ReturnValuesOnConditionCheckFailure: ALL_OLD`, which returns the row at no read, and the upsert composes from that row and writes again (`guardedUpsert`, through `runUpdate`'s `upsertOver`, with `fill` for what the row lacks). So a stored value always wins, and no key disagrees with its row. That second write is a fact of three cases: an input that contradicts a stored immutable value or `createdAt`, a row without the key (1.38 wrote none, and it's then there), and a changed value under an unsupplied `createdAt`. A rejected write is charged write capacity for the item, where a `GetItem` would cost less: on a definition whose upserts change `status` on every call, a read would be the cheaper request. It's deliberately not the one chosen: most upserts of such a row change nothing the key holds, and a read would be paid on every one of them, and on every new row. `unique`, `retain` and an omitted defaulted composite read first as they always did, for their own reasons, and share the merge.

With a primary key over an unsupplied `createdAt` there's no existing item to name, so an upsert creates.

**An upsert leaving out a composite.** An upsert that omits an optional composite leaves that attribute as stored, so nothing on the input alone composes a half holding it, and if that made the whole index unwritable, the other half went stale: `pk: [owner]`, `sk: [note]`, `upsert({ owner: "o2" })` stored `owner: o2` under `owner_o1`. Each half is now judged alone (`upsertKeys`, `upsertKeyPlan`, `KeyComposer.composeKnownHalves`):

| Half | Written | Stands on an existing row when |
|---|---|---|
| The input has all it holds | SET from the input | Always, or as the tables above say. On a new row this half is written alone: the row isn't in the index until the other half is, and `rekey` finds nothing to repair |
| The input has all it holds, but it's all primary composites, kept values or `composite: []` | Not written alone: it says what it always said | Always |
| The input has some of what it holds | Not written | Each value it names is what's stored. A stamped `updatedAt` isn't named, so the half lags, as on an update. One the input supplies is, and moves the key |
| The input has none of what it holds | Not written | Always: nothing it holds changed, so one write and no condition |

**An upsert clearing a composite.** A clear reads first and leaves what `.set(...).remove([...])` leaves, by "An `undefined` in an upsert's input" below. A half holding a date the library stamps goes by the same rule as an update's clear: `[status, updatedAt]` given `status: undefined` loses the key, and `[updatedAt, status]` truncates to the stamp.

So the ordinary upsert stays one write, no read and no condition. A rejected write returns the row at no read (`ALL_OLD`), and the upsert composes from the row merged with the input (`guardedUpsert`). What the row can't supply either goes through the per-half policy, as on an update: a hole in a half (`[a, b]` with `a` absent, `b` present) is `'sparse'` REMOVE or `'preserve'` noop, and a trailing absence truncates. Nothing here reads: the reads an upsert has are still those of `unique`, `retain` and an omitted defaulted composite.

A time-series `append` has no `updatedAt` (`orderBy` is its clock), and it does the same over `createdAt`: every half holding it is `if_not_exists`, and the CAS also requires the key and that the half's other values are the ones written (`keptValues`). A rejection returns the row. If the key can't stay, the append composes from the row and sends again, guarded on the `orderBy` it was handed (`appendOverRead`); otherwise the rejection was the CAS or the caller's condition, as it always was, and the row saves that follow-up read. With `skipFollowUp` an append over `createdAt` sends no read at all.

**Which field is stamped.** A model field of that name is managed if it's a date, including under `Schema.optional` (the value schema is what's read: an entity unwraps it, so `optional` agrees with `optionalKey`), with a supplied value winning. Any other is the caller's (rule b, above), and that includes `Schema.UndefinedOr` of a date with no `storedAs`: it's a union, a required key whose value may be empty, so nothing stamps it and clearing it is the caller's to do (`Marshaller`'s absent attribute, "Values with no stored form"). The types agree: `ManagedDateField` names a managed date, `WithSystemCollisions` makes only one optional, and `RemovableFields` leaves only one out. A `configure` `field:` rename of `createdAt` or `updatedAt` is written under the renamed attribute on every path (`resolveDbName`); a rename of the version attribute is refused (`EDD-9122`), and `versioned: { field }` names it.

**Aggregates.** See "Aggregate System Timestamps" (§11). An aggregate's list key and collection sort key compose from the same stamps as the root row (`buildDynamoItems`), so the key and the attribute agree. A partition key over a stamped `updatedAt` and a `many` edge's sort key over one are refused (`EDD-9121`), by the pure `Aggregate.make` in `@effect-dynamodb/schema` and the operational one alike (`refuseManySortKeysOverMovingValue`): both name rows, and neither can move.

**Repair.** `judgeIndexHalf` judges these halves like any other (see "Index keys that differ"): a row 1.38 wrote with no key is `missing`, and a key that only lags `updatedAt` is no difference.

#### Canonical GSI-composite test-fixture shapes

Test coverage for the policy-aware composer must span the canonical GSI-composite shapes. Missing one shape (as the v1.7.1 fixture matrix did with PK-composites-only, and as the v1.7.2 matrix did with empty-composite halves) leads to consumer-facing regressions. Future work in this area must verify each shape:

1. **Multi-writer GSI** — composites split across writers (e.g. enrichment-owned PK composite + telemetry-owned SK composites). The per-half gate must skip halves the current writer doesn't touch. Anchor scenario for the `'preserve'` contract.
2. **PK-composites-only GSI** — composites entirely subset of the entity primary key (e.g. `byChannel: { pk: [channel], sk: [deviceId] }` on `primaryKey: [channel, deviceId]`). The per-half gate must fire via `keyRecord` membership and SET on every write. Regression scenario for #43 — must be present in unit, entity-level integration, and connected suites.
3. **Hierarchical GSI** — composites form a parent → child hierarchy (e.g. `[region, country, city, site]`). The structural rule must truncate via `set({ parents }).remove(["leaf"])`.
4. **Hole pattern GSI** — optional leading composite + present trailing composite. Must collapse into the unified can't-compose rule (drop under `'sparse'`, noop or cascade-override under `'preserve'`).
5. **All composites mutable** — every composite is a non-PK model field, and `appendInput` / update payloads carry them all. The standard case; the gate fires through the payload.
6. **Empty-composite half** — at least one half is `composite: []` (e.g. `byDeviceBinding: { pk: [deviceBinding], sk: { composite: [] } }`, common in single-table designs where the SK is just the entity prefix). The per-half gate must always evaluate the empty half (the value is a constant prefix; multi-writer protection does not apply). Regression scenario for #46 — must be present in unit, entity-level integration, and connected suites.
7. **Z-order half** (#171) — `byFacets: { pk: [region], sk: { zorder: [price, bedrooms, listedAt] } }`, every dimension a mutable model field. Full payload → SET bytes; partial payload → `'sparse'` REMOVE / `'preserve'` noop / `'preserve'` + `remove([dim])` REMOVE; untouched → skipped; never truncated; a value change within one level writes identical bytes.
8. **Z-order half with `sk.prefix`** — `sk: { prefix: [agencyId, { field: officeId, hash: 8 }], zorder: [...] }`. A prefix change moves the entry; a prefix composite alone in the payload with dimensions missing → policy decides.

Degenerate fixtures for shapes 7 and 8 (audited against the existing shapes, notably 3 and 6):

- **7a (layout edge, single bit)** — one 2-member `literals` dimension: 1 bit, `B = 1`, `W = 1`; the byte is `0x00` or `0x01`.
- **7a′ (layout edge, mixed widths)** — a 2-member `literals` dimension plus a 13-bit `int`: `B = 14`, `W = 2`; the top two bits of the first byte are always zero.
- **7b (shape 6 analogue)** — `pk: { composite: [] }` with a Z-order sort key: the empty PK half is always evaluated and SET; under `'sparse'` a partial dimension payload gives PK SET + SK REMOVE (the item leaves the index); under `'preserve'`, PK SET + SK noop.
- **8a (#43 analogue)** — every prefix composite and dimension is also a primary-key composite: recomposed from `keyRecord` on every write, including an update that touches none of them.
- **8b (#41 analogue)** — prefix owned by one writer, dimensions by another: writer A's prefix-only update must not SET (`'preserve'` noop); writer B's full-dimension update SETs only if the prefix is also present (from `keyRecord` or payload), else policy.
- **8c (shape 3 analogue)** — hierarchical `prefix: [agencyId, officeId]`; `set({ agencyId }).remove(["officeId"])` → REMOVE under `'sparse'` and under `'preserve'` (cascade override), never a truncated SET.

Shapes 1 to 8 hold on a sharded index as well (#183). The gate's new dependency adds:

9. **Sharded half with `by`** — `pk: [tenantId], sk: [groupId, deviceId], shards: { count, by: [groupId] }`. A `by` attribute touched in the payload wakes the PK half; with the PK composites too it moves the entry, without them it fails `EDD-9100`.

- **9a (shape 6 analogue)** — an empty PK half with `by`: the half's value is no longer constant, and it is skipped unless `by` is touched or known.
- **9b (#43 analogue)** — a `by` attribute that is also a primary-key composite: it arrives through `keyRecord` on every write, which is not a touched dependency.
- **9c (shape 6 analogue)** — a default source with an empty PK half: the value differs per item though the half has no composites, and is always evaluated.
- **9d (shape 4 analogue)** — a `by` attribute after another composite: `sk: [region, group], shards: { count, by: [group] }`. An update naming `tenant` and `group` but not `region` would move the shard and keep the sort key at the old value, so no pin reaches the row: it fails `EDD-9100` under `preserve`, drops under `sparse`, cascades on `.remove(["region"])`, and composes from the whole item on the retain and computed paths. A real gap there, or in an `append`, fails too.

10. **A half mixing a primary key composite with a mutable one** (#183) — `sk: [zone, deviceId]`, `sk: [deviceId, zone]` or `pk: [channel, zone]` on `primaryKey: [channel, deviceId]`. An update naming neither composite leaves the stored key byte for byte under both policies, on the standard, retain and append paths; naming the mutable composite composes the half; `.remove(["zone"])` cascades as ever. The composites in the key record alone never wake it, whichever position they hold. **This is the regression scenario from v1.7.2 through 1.38**, reachable on an unsharded index: the half woke through `keyRecord`, so an unrelated update removed the key under `'sparse'` or truncated it under `'preserve'`.

The retain path holds the whole item in `keyRecord`, so a mixed half whose composites are all present recomposes to the key it already has. When every half of an index is skipped there, the entry stays as stored, as on the standard path.

11. **A half stored in a table key attribute** (#183) — a local index's `pk`, an inverted index, or `sk: { field: "sk", composite: ["id"] }` shared with the table. DynamoDB refuses an update that writes a table key attribute, so the composer never returns one, in `sets` or `removes`: such a half holds what the table key does, out of composites an update can't change, and dropping the index entry takes the other half. Snapshots, tombstones and events keep the attribute too.

12. **A mutable half beside one that writes nothing, on the retain path** (#183) — `pk: [note]` with `sk: { field: "sk", composite: ["id"] }` shared with the table, a local index's `sk: [note]`, an inverted index's `sk: [note]`, or `pk: [note], sk: [group]` on a row that has cleared `group`. An update that names `note` with a leading composite missing under `preserve`, or one of a row an earlier release cleared with `.set({ note: undefined })` (which composed nothing, and left the attribute's key behind), composes nothing for such an index, as the kept half is a noop and the other half is the table's or has no value. That silence isn't a drop: the entry stays through it and through any later update, on the standard, retain and transaction paths alike, until an update clears `note`, which removes the half. **This is the regression scenario from shape 11**, where filtering a table key attribute out of the composer's result took away the only sign a retained update had that the index had been evaluated, and its Put-style fallback deleted the entry. The fallback only ever deleted (an index it reached always lacked a composite), so it's gone.

13. **Two accessors storing their halves in one attribute** (#183) — `byRegion: { pk: [region], sk: [id] }` and `byGroup: { pk: [group], sk: [extra] }` on one physical index, or `byName: { pk: [name], sk: [id] }` with a sparse `byOther: { pk: [other], sk: [name] }` in one attribute. **Refused: `EDD-9106` at `Entity.make`, or at `Table.make` for a casing left to the schema.** A row can't show which accessor owns the attribute, so no composer can be right: an ordinary update replaces one half and leaves a mismatched pair, including on a row that only ever populated one accessor, and a table key move composes from the whole row with the later accessor winning. Fixing the writes would mean patching every path, which is how this kept regressing. The check runs per entity, so overloading one index across entity types is unaffected. To keep such access patterns, give each half its own attribute, which means a new index, and re-put existing rows.

14. **An index half with the same definition as the table half in its attribute** (#183) — above all an inverted index, `pk: { field: "sk", composite: ["groupId"] }, sk: { field: "pk", composite: ["userId"] }`, and also a local index's partition key and a sort key shared with the table. **Supported, not encouraged:** the library's principle is that index keys go in dedicated GSI attributes. It needs no case of its own: one rule composes every key, so both roles build identical text with `escapeKeys` on or off, and `EDD-9106` holds the rest by comparing definitions. No update writes it ("Never set a table key attribute", below). **The regression scenario from 1.37.0 and 1.38.0**, in which a sort key's escaping overwrote `pk`, so `get` failed for a value with a space, and a `put` of a value with one in `sk` failed. Cover values with a space, `%`, `#`, mixed case and non-ASCII, numbers and dates, each write path, under both flag settings, rows 1.36, 1.37.0 and 1.38.0 wrote through `rekey`, and that no other definition's bytes change.

15. **Both halves of one index over one composite, holding only what a key escapes** (#183) — `pk: [tag], sk: [tag]` with `tag` of `#`, `%`, `%23`, `%25`, a space or `# #`. Each value has its own key under both flag settings, and a value spelled like another's escape isn't it. Cover on the composer, the entity and DynamoDB Local (`test/helpers/EscapeKeyScenarios.ts`, `schema/test/EscapeKeys.test.ts`).

16. **`sk: [updatedAt]`** — the half holds only the stamp. It moves on every update, including a `.set({ note })` naming nothing of it, under both policies. A partition half over it (`pk: [updatedAt]`) does the same. Shape 2 analogue: `[id, updatedAt]` with `id` in the primary key always moves. Shape 6 analogue: an empty partition half is evaluated and the stamped sort half moves.

17. **`sk: [status, updatedAt]`** — with `status` in the payload or the `keyRecord` it moves with the new stamp; with neither, it's left under both policies, never dropped and never truncated. **This is the trap:** treating the stamp as touching the half drops the row under `sparse` on every unrelated update. `.remove(["status"])` still REMOVEs it. 17a: `[status, region, updatedAt]` with one of the two named is left whole. 17b: a Z-order half with `updatedAt` as a dimension is all-or-nothing on the same rule: every other dimension and prefix composite known means SET the address, otherwise left, under either policy.

18. **`sk: [createdAt]` and `pk: [createdAt]`** — written by whichever write builds the item, from the stamp or the supplied value, and left by every update: the key survives an update, an `upsert` (one write, no read), a guarded `put` over an existing item and a `restore`. 18a: `[status, createdAt]` on `.set({ status })` truncates to `status_b` under both policies, the partial-payload rule.

All three are covered on the composer (`schema/test/KeyComposer.test.ts`), through the entity on a recording table (`IndexPolicyV3.test.ts`) and on DynamoDB Local (`connected.test.ts`), both from `test/helpers/StampedComposites.ts`, under both `escapeKeys` settings.

#### Never set a table key attribute

**No write the library sends sets any attribute of the table's primary key to anything but the key it composed, on any write path, whatever the index structure.** DynamoDB refuses an update naming one (`Cannot update attribute sk. This attribute is part of the key`), and an index half can only be in one by having the same definition, so there's never anything to write. A `Put` would be worse: it accepts whatever key its item holds, so it could store the row at a key no read composes.

- The update composer's `sets` and `removes` never hold one (`composeGsiKeysForUpdatePolicyAware`), so every update path has it.
- Each builder that writes key attributes itself excludes them: the retain path, `upsert`, `append`, `rekey`'s in-place rewrite (`staleIndexKeys`, which guards this before judging a half, as a retry after another writer can compose new text for one), the vector backfill, and aggregate `rekey` (`indexFields`).
- A key changes only by moving the row: a `Put` under the new key and a `Delete` of the old one, in a transaction.
- `[EDD-9109]` refuses at `Entity.make` a model attribute, a system timestamp or a version field stored in a key attribute the entity writes, by rename (`payload: { field: "pk" }`) or by name: the table's, and since 1.40 each secondary index's (a local index's sort key, a Z-order address and a `refs` cascade index's included), where the value and the key the library composes replaced each other. Also since 1.40, a model attribute named as one of them under any rename: a write composes the keys before it renames the fields, so the rename moved the key into the field's attribute, and the row lost it. `[EDD-9112]` refuses at `Aggregate.make` a list key or a collection sort key stored in one.
- At run time, `.remove`, `.set`, `.add`, `.subtract`, `.append`, `.deleteFromSet` and the path operations naming a table key attribute by its stored name fail with a `ValidationError` and write nothing, as `.remove` of a primary key composite does (D63).

`test/NoTableKeyWrites.test.ts` records every `UpdateItem`, transactional `Update` and `Put` across inverted, shared `sk`, sharded shared `sk`, local and dedicated definitions, under both flag settings, through every lifecycle, `rekey` and its retry, moves over 1.36 rows, aggregates, streams and the scenarios of the other suites, and fails if an update names `pk` or `sk` or a `Put`'s key isn't the one its values compose. `test/TableKeyAttributes.test.ts` covers each definition position: refused, accepted, and the run-time check.

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

**The writer's check and the reader's predicate** (`internal/SparseKey.ts`, schema package):

- A write that flattens a whole item runs `validateSparseKey`: a non-empty key without `#`, and an attribute name of 1–255 bytes. That is `put` / `create` (and `Batch.write` / `Transaction.transactWrite` puts), and an update that reads the row and writes it whole (`refusesPutKeys`: a `versioned: { retain: true }` entity's, and one that touches a unique field or a computed index composite). Such an update checks the payload's keys, before it reads anything (`refusedSparseKey`: before the read of the row, and before the reads that hydrate a payload's refs, on update, patch, a transaction's update, put, create and upsert), and writes the row's own entries back under the attributes it read them from, whatever their keys: an entry named by its attribute under `x#y` no longer stops every later update of a retained row. A key is refused before the reads only where the operation is refused whatever the row holds (`everyRowWrites`). An immutable map's value is written by an upsert only into a row that isn't there and by an update never, so with the row present an upsert carrying a key a put refuses succeeds, as on 1.39.0, and with the row missing it is refused where the put it becomes refuses it (`test/fixtures/sparse-entry-ops-1.39.0.json`). An upsert that reads the row first (`guardedUpsert`) writes a row that isn't there as a put and one that is as the update of the upserted fields, which refuses a put's keys only where it is such an update (`refusesPutKeys`), and otherwise an empty key and one holding `#`. It refuses a key before the read only where both writes refuse it, in the put's words, and any other after the read, where the write the read leads to refuses it: a key over 255 bytes given over a row that is there is written where that update writes it, as on 1.39.0, and an empty key or one holding `#` is refused before the read, where 1.39.0 refused it after (`test/fixtures/upsert-entry-keys-1.39.0.json`). The byte limit is the library's own. DynamoDB takes an attribute name of up to 64 KB, and 255 bytes only for an index key or an attribute an index projects by name. The other writes check what they checked on 1.39.0, and send the requests they sent: an update's `.set()` and `upsert` refuse an empty key and one holding `#` (`update.sparse`, `upsert.sparse`; an update's, before it reads anything, so before a transaction's reads too), and a record or path operation naming an entry's attribute (`pathSet`, `pathAdd` or `.add()` of `data#x#y`) checks nothing, so it writes the entry the reader reads under `x#y`. Applying the writer's check to them refused writes that stored and read back (an entry under a 256-byte name; `data#x#y`). No write-time check guards a key attribute: `EDD-9140` refuses, at load, any attribute the entity writes that the reader would take as an entry. A record operation names a model field, and its stored attribute decides what it writes: `.add({ "data#x#y": 3 })` on a field named `data#x#y` and stored as `counter` adds to `counter` (`test/fixtures/sparse-entry-writes-1.39.0.json`).
- A stored row is read in one order everywhere: sparse entries leave the attribute-keyed row first (`deserializeSparseFields`), then names are mapped (`renameFromDynamo`). `decodeRecord` and the history and tombstone readers did; the update that reads a row to write it whole, the read for a vector's source text, and `toDomainView` (key, unique-sentinel and vector-partition composition from a stored row: put, update, delete, restore, purge, `rekey`) mapped names first or only. So a field named as an entry (`data#x`, stored as `counter`) landed on the entry's attribute: a retained entity's `.set()`, `.add()` or `.remove()` of any field wrote the field's value over the entry `x` and dropped `counter`, on 1.39.0 too, and a unique field the row lacked was read from the entry of its name. The same update applied a record operation naming an entry by its attribute (`.add({ "data#views": 1 })`, `.subtract`, `.append`, `.deleteFromSet`) to a key of its own beside the map, which the flattened entry then overwrote: it reported success and changed nothing, on 1.39.0 too. It now reaches the entry, as the operation sent as an expression does, and a set it shrinks is a copy, so the snapshot of the row before the update keeps the whole set. An entry's key, like any name a caller supplies, is read and written as its holder's own property: the map is looked up with `Object.hasOwn` and built with no prototype (`slot`, and `decodeSparseFields`' buckets), so `data#constructor` on an empty map is absent and not `Object`'s constructor, and an entry keyed `__proto__` is kept and read back, where assigning it on a plain object dropped it.
- Which stored attributes are entries is the reader's to say (`sparseReader`): an attribute is an entry of the field whose `<prefix>#` begins it (the longest such prefix winning) when a key follows the `#`. `<prefix>#` itself is no entry. The row's reader, `clearMap`, `removeEntries`, the refusal of `.remove` / `pathRemove` of an entry, a time-series event item's strip and `EDD-9140` all ask it. So `clearMap` never removes `<prefix>#` (which can be a key attribute), and `removeEntries` takes any key the reader reads, one holding `#` included.

#### Reads — transparent

`get`, `query`, `scan`, batch, and stream paths all rebuild the domain `Record<K, V>` from flattened attributes by walking the marshalled item once and grouping the attributes the reader takes as entries. Domain consumers see the field as a normal Record.

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

### Packed Storage (`storedAs: DynamoModel.Packed()`, #147)

> Full design: [`docs/designs/storage-encoding.md`](docs/designs/storage-encoding.md).

**Problem.** A native map is the most expensive shape DynamoDB returns: the SDK parses a type-wrapped node per value and `unmarshall` rebuilds the graph again. For bulk reads of structured values (event `data`, documents, folded state) a single JSON string reads ~2× faster through the library (downstream Lambda benchmark: 5,990 small events, 121 vs 261 ms select + fold, JIT off), at ~19% more stored bytes; a ~47 KB state compresses ~11× (zstd: 5 WCU vs 47 as JSON, 38 as a map), which also matters for the 400 KB item limit. Compressing small values is a net read loss (threshold 0: −24% RCU, ~4× slower reads), hence the 1 KB default threshold.

**Config.** One declarative config, defined in `@effect-dynamodb/schema` and shared by Entity and EventStore:

```ts
DynamoModel.Packed({ format: "json" })                                       // S
DynamoModel.Packed({ format: "json", compression: { codec: "zstd", threshold: 1024 } })

DynamoModel.configure(Order, { lines: { storedAs: DynamoModel.Packed({ format: "json" }) } })
EventStore.makeStream({ …, storedAs: { data: Packed(…) }, snapshot: { schema, storedAs: Packed(…) } })
```

`format: "binary"` (SchemaBinary) is reserved, not accepted. Metadata stays a map; the default for every attribute stays native.

**Stored form — self-describing, no marker attribute.** Readers dispatch on the stored value, never on the current config, so switching encodings needs no rewrite:

| Stored | Read as |
|---|---|
| `M` / `L` / other native | legacy native value |
| `S` | `JSON.parse` |
| `B` | byte 0 header `vvv ff ccc` (layout version `001`; format `00` json, `01` binary reserved; codec `000` none, `001` gzip, `010` brotli, `011` zstd) → decompress → `JSON.parse` |

A packed value is the attribute's wire form exactly as map storage would write it, as JSON (non-JSON values — bigint, binary, sets, dates as objects — are refused at write). Compression runs only when the JSON's UTF-8 length is ≥ `threshold` (default 1024) **and** the compressed value plus header is smaller; otherwise the value is stored as `S`.

**Compressors.** Pluggable synchronous `Compressor { codec, compress, decompress }` implementations, registered through the `Compression` service — `Compression.layer(...)` merged into the application layer (recommended), `DynamoClient.make({ compressors })`, or `DynamoClient.layer({ compressors })` (whose `Compression` output does not survive a wrapper layer that consumes it through `Layer.provide`) — and read with `Effect.serviceOption`, so no operation gains an `R`. `node:zlib`-backed implementations ship from `effect-dynamodb/compression/zlib`; any runtime can register its own. A codec a `Packed` config names is checked where the registry is first resolvable: `DynamoClient.make` (every bound entity and aggregate edge) and `EventStore.bind` fail at bind, and an unbound stream on its first operation per registry, with the `[EDD-9078]` configuration defect. Past that, a value that needs an unregistered codec (an unbound entity write over the threshold, or a read of a `B` whose header names a codec the config no longer does) fails with a `ValidationError` whose `cause` is the tagged `CompressorNotRegistered` (naming the codec, direction and attribute), so no error channel widens.

**Constraints.** A packed field's encoded side must be object/array-shaped (so `S` is unambiguous; this also excludes dates/TTL), and it cannot be a key or index composite, a unique-constraint field or a ref (EDD-9072–9075). Conditions and filters may only test `attribute_exists` / `attribute_not_exists` on the whole field; projections take it whole; updates only `.set()` / `.remove()` it whole (EDD-9076, EDD-9077). Version snapshots, soft-delete tombstones and time-series event items copy stored values as-is. The key composer is untouched.

**EventStore.** `append` / `commandHandler` pack each event's `data` (and the inline snapshot's `state`); every read path decodes by stored form; `Query.select` raw rows return `data` as plain parsed JSON whatever its stored form, through every stream-index projection; `Query.filterExpr` on `data.*` is refused (EDD-9076) in favour of `Query.filterBy`. `stream.decodeStreamImage(image)` decodes DynamoDB Streams images (B as `Uint8Array` or base64) to the read paths' `StreamEvent`; `stream.measureAppend` / `measureSnapshot` and `StorageEncoding.valueBytes` (or its synchronous twin `valueBytesSync`, with explicit compressors) give callers the exact stored sizes for chunk planning, and `measureAppend`'s `requestBytes` the exact request body the append would send (its `additionalItems` passed to it, built as `append` builds them); `StorageEncoding.limits` holds the three limits (`item`, `transaction`, `request`). Size limits are not pre-checked: the failure diagnosis measures the packed request, so it counts stored bytes.

**Entity.** Packing runs after renames and sparse flattening, before marshalling (put / create / upsert / update `.set()` / `Batch.write` / `Transaction.transactWrite` / time-series `append`, which packs once and writes the same value on the current and event item); unpacking runs after unmarshalling, before sparse rebuild and renames, in every decoder (get, queries, scans, collections, batch and transactional reads, versions, history, soft-deleted reads, `ReturnValues`). Reads also dispatch on every object/array-shaped field that is not configured packed, so turning packing off needs no rewrite. `asNative` returns the stored `S` / `B`; raw projections (`select`, `Entity.project`) return a packed field whole as its parsed JSON. The read-merge update path (retain, unique, computed composites) carries packed values the update does not name byte-identical, and a restated immutable packed field is compared by its unpacked JSON. At the type level an entity carries its packed field names (`TPackedFields`): their `PathBuilder` paths are `PackedPath`s, accepted only by `exists` / `notExists` and projections. `Entity.decodeMarshalledItem` decodes DynamoDB Streams images by stored form (`B` as bytes or base64, DynamoDB JSON or unmarshalled) and now also applies renames and sparse maps. Aggregate edges store their edge entity's packed fields packed (a `one` edge's flattened entity, a `many` element that is the entity) and, like entities, read every object/array-shaped edge attribute by its stored form, so an edge written packed still reads after the edge entity's packing is turned off; a packed field cannot be an edge discriminator or `many` sort-key composite (EDD-9072).

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
// With `escapeKeys: true`, a pin on `city` (`gsi1sk BETWEEN K AND K#U+FFFF`, K the key above)
// still finds this asset. Off, the pin is `begins_with(K#)` and doesn't.

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

The extended ISO form round-trips the zone: a named zone as `…+09:00[Asia/Tokyo]`,
an offset zone as `…+05:00` (rebuilt with that offset since #133, for both
`DynamoModel.DateTimeZoned` and a self `Schema.DateTimeZoned`; earlier versions
read it back as UTC).

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

#### Self dates nested in containers (#133)

Entity derivation substitutes every **self** date (`Schema.DateTimeUtc`,
`Schema.Date`, `storedAs(...)`) with a transform to its wire primitive. Before
#133 the walk entered Struct / Class / Array but stopped at `Union`, `Record`,
`Tuple`, `TupleWithRest` and `StructWithRest`, so `NullOr(Schema.DateTimeUtc)`,
`NullOr(ClassWithDate)`, `Array(NullOr(date))` and `Record(_, date)` stored the
`DateTime` instance itself, a marshalled `{ epochMilliseconds, … }` map.
`substituteSchemaDeep` now walks those containers in every mode
(`walkedContainer`), rebuilding each container kind with the original node's
annotations, checks and context (`withMetadataOf`). A container with its own
encoding chain is left as declared. Without `tolerantTransforms` only self-date
and `Redacted` leaves are substituted, so a transform (Pattern B) inside a
container keeps owning its wire form. A `TupleWithRest` is now derived as a
tuple; it was previously treated as an array.

**Container checks on writes (#133).** Rebuilding an `Array`, a `Struct` or a
class around substituted children with a plain constructor dropped the original
node's `.check()` refinements, so a write that broke one
(`Schema.Array(Schema.DateTimeUtc).check(Schema.isMaxLength(1))` given two
dates) was accepted. WRITE schemas are now built with `enforceChecks`, which
restores those checks (`withMetadataOf`; for a class over a checked Struct, on
the Struct its encoding leads to, `classStructAst`). That covers the entity
input / create / update / key schemas (so `put`, `create`, `update`, Batch and
Transaction), `appendInput`, the path-value schemas (`writeModelSchema`) and the
aggregate's `writeSchema`, used by `create` and `update`. READ schemas leave it
off, so a row written while the check was not enforced still reads. On an
aggregate every `update` of such a row fails until the same update makes the
value valid, because the whole mutated state is decoded through `writeSchema`;
an entity `.set()` of other fields still succeeds. The repairing `update` works
because it converts the current state through the read
schema when `toIso` rejects it (`toPlainState`), and `keyRecord` normalises only
key composites. `Union` / `Record` / `Tuple` rebuilds (`walkedContainer`) keep
their metadata in every mode. A container that holds no substituted value is
never rebuilt and keeps its own checks on reads and writes, as before.

Date leaves inside a `Union` follow the union rules below, and also rebuild
legacy maps, so rows written before #133 read back as real `DateTime`s.

**Union rules (#133).** Every member of a union learns which primitive kinds
the *other* members are stored as (`memberWireKinds`), including, for a union
nested in another (`Union([NullOr(DateTimeUtc), String])`), the outer union's
other members. A self-date member then:

- accepts only its own wire kind, its own domain, or a legacy map
  (`strictWireKind`), so it never claims a value of another kind;
- when its storage kind **collides** with another member's (ISO storage next to
  a `String`), accepts only the exact canonical string `toWirePrimitive` writes
  (`canonicalOnly`), and is decoded **first** whatever the declared order. So
  `"2000-01-01T00:00:00.000Z"` in `Union([DateTimeUtc, String])` reads back as a
  `DateTime`, while `"2020"`, `"5"` and `"hello"` stay strings. A string field
  that may legitimately hold canonical ISO instants needs a tagged or
  discriminated shape;
- when it is stored as an epoch number next to a member also stored as a number
  (`Number`, a number literal, `BigInt`, another epoch date), cannot be told
  apart from it at all: rejected at `make()` with **EDD-9058**. There is no
  fallback to ISO storage. On an entity, `NumberFromString` and
  `BigIntFromString` are stored as strings and do not collide. Under
  `tolerantTransforms` (aggregates) a member's **domain** kinds count too
  (`memberWireKinds(..., { domainSide })`), because `update` re-decodes domain
  values: their domain `5` competes with an epoch date, so aggregates reject
  them with EDD-9058 as well.

A transform date member (`DateTimeUtcFromString`) keeps the transform's own
decode inside a union, since the generic date transform accepts more than the
user's transform. A `DynamoModel.configure(..., { f: { storedAs } })` override
on a top-level union field applies to the union's single self-date member; with
several date members it is rejected with **EDD-9057**.

**Legacy reads on entities.** Entity READ schemas (model, record, item,
deleted, history) are built with `legacyReads`: a transform field also accepts
the domain-form value older path updates wrote (a `number` on a
`NumberFromString`, a safe-integer `number` or `bigint` on a `BigIntFromString`,
a marshalled map on a date transform), and a plain `Schema.BigInt` lifts the
unmarshalled `number` back to `bigint`. The transform forms are never taken
inside a union, where a lenient member could claim another member's value. Write
schemas and keys use the strict schemas, so nothing written changes.

**A `Schema.BigInt` under a union.** The lift works there, on an entity's read
schemas and an aggregate's tolerant ones. Every member gets its try as declared
first (`exactBigInts`), and only a value none of them takes reaches the members
holding a bigint, lifted, at any depth (`holdsBigInt`). A `oneOf` union refuses a
value two members take, so it becomes `Union([exact oneOf, ...lifted members])`.
Declared-first can only turn a failure into a success, so a row that read before
reads the same: a member taking a number keeps it, and `Union([Number, BigInt])`
reads `5n` as `5`, in either order. Nothing is judged from the members' kinds,
which is why a number inside another member doesn't compete with a bigint in this
one (`Union([Number, Struct({ b: BigInt })])`), and a member that takes only some
numbers takes only those (`Union([Literal(5), BigInt])`, `6n` stays `6n`).

**A `Schema.BigInt` the walk can't reach.** Under another declaration
(`Schema.Option`, `Schema.Result`, `Schema.ReadonlySet`), a `Schema.suspend` or a
transformation (`Schema.DurationFromNanos`, `Schema.ByteSizeFromBigInt`,
`Schema.OptionFromNullOr(Schema.BigInt)`, a custom one), `substituteSchemaDeep`
stops. A read schema hands what it stops at to `liftingBigIntsWithin`, the pass a
stream reads with: a number becomes a `bigint` just before the node, through the
encoded side and what's suspended. Write schemas never get it, so what's stored
can't move. `holdsUnwalkedBigInt` looks at the encoded side, so a transformation
with no bigint stored is returned as it came, and `needsDeepSubstitution` uses it to
reach a field like this one in a struct. A union reached by the walk still gives
every member its try as declared first. A union beyond it has the lift on the node,
so a member taking a number can lose to an earlier one, which is what
`hasBigintBesideANumber` refuses there, as on a stream.

**Beneath a decoding default.** A field with `withDecodingDefault` or
`withDecodingDefaultKey` carries no runtime accessors below the step, so a
substitution working from the node (`decodingDefaultField`'s `inner`) can't walk
a struct, a record, a tuple or a union there. A read walks the declared schema
(`.to`) instead: `legacyReads` on an entity, `decodeOnly` on an aggregate's read,
write and state schemas. An encoder doesn't, so what's stored stays what it was,
and it falls back to the read's reach only for a value the field's own schema
refuses. That's why `Schema.Date` and `Schema.Redacted` in such a container are
refused at load (`EDD-9125`): a read reaches them and a write doesn't. A check
added after the step isn't on `.to`, so a schema enforcing checks keeps `inner`.

**A step encoded as optional that isn't a default.** `Schema.OptionFromOptional`,
`Schema.OptionFromOptionalKey` and a step of your own end in an optional encoded
side too, so `decodingDefaultField` finds them, and `defaults` tells them apart: a
default has what the field stores on both sides of it, and a step doesn't. What's
beneath a step, its type side, is what it makes, not what's stored, so a
substitution there would hand a stored value to the wrong side. A read and an
encoder leave the step as declared, with only the lift above for a bigint on its
encoded side. A caller holds what the step makes, so an aggregate's `create` input
and mutated state (`domainValues`) go round it: a value is asked against the step's
type side, then as a stored one, and absent is read through the step
(`absentAsDeclared`). A plain bigint under an optional key stays optional when
it's lifted (`readingStored`), so an encoder gets nothing back for nothing stored,
inside a declaration or a transformation too. A `Schema.Redacted` beneath a step is
refused at load (`EDD-9125`): an encoder leaves it as declared, so its value is
lost, while a transformation ending in `Schema.Redacted` is substituted whole.

**A transformation between lists.** A list is walked from its type side whatever
it's stored as, when an element is substituted, so what's written is what its
elements store: `Array(Number)` decoded to `Array(Date)` stores strings, on an
entity and an aggregate, and the step itself never runs. Rows already written hold
that form, so an aggregate's tolerant leaf leaves such a list alone
(`isTolerantLeaf`). A list with nothing to substitute is a leaf, so an aggregate
takes either side of it. An entity only substitutes a date or a redacted value when
it writes, so what a write stores for any other list is what its step makes, and a
read walking the type side would skip the step: where the list isn't stored as one,
or a plain bigint is on the stored side or among the elements a walk would read, it's
read as declared with its bigints lifted (`readsListAsDeclared`). At load, a date or a redacted value on a list's stored
side is reached only if the type side holds the same thing (`sameElements`):
`Array(Date)` decoded to `Array(Number)` writes the dates as declared and is
refused. A step from an optional list to a list of something else isn't a decoding
default for the same reason (`sameShape` compares what the lists hold).

**`Schema.optionalKey` over a union.** `optionalField` gives the first member as
`inner`, as it always has, and the whole union as `union`. A write substitutes
`inner` only and writes the later members as declared, so what's stored for each
member is what it has always been: `Union([DateTimeUtc, String])` stores a string
for a date, `Union([String, DateTimeUtc])` stores Effect's internal form, and
moving either would be a stored-format change. A path write follows the same line
(`originalAt`'s `asDeclared`), and an `append` finds the first member holding a
list. A value of a later member is written as that member, even one the first
could read: until 1.40.0 the first member's decode took it, so `5` under
`Union([DateTimeUtc, Number])` was stored as a date in 1970. A read tries each
member in declared order with what it reads inside a union (`declaredOrder`:
`strictWireKind`, and no canonical date moved ahead), and a first `Schema.BigInt`
keeps its lift in place, since its row is a number. Whatever the first member read
as the whole field comes last, so a row it took still reads. An aggregate stores a
first date transform in its date encoding, not its wire form, so that's read in
its place too, and the same for a date in a union of nothing else but `Schema.Null`
or another date, whatever it declares (`holdsOnlyDates`). A later `Schema.Date` or `Schema.Redacted` is refused at load
(`EDD-9125`): written as declared, its value is lost. `Schema.optional(Union)` is
one member, the union, and every member of it is substituted.

**Zoned offsets.** A zoned date stored as `…+05:00` (an offset zone, no
bracket) is rebuilt with that offset; before #133 it was rebuilt as UTC. One
parser (`internal/ZonedIso.ts`, `parseZonedIso`) serves both the
`DynamoModel.DateTimeZoned` transform and the substituted date transform, so the
two cannot drift. Named zones (`…[Europe/London]`) and UTC round-trip as before,
and the stored form is unchanged. Offsets that are not whole minutes (historical
LMT offsets, a sub-minute `zoneMakeOffset`) are rounded to the minute by
`formatIsoZoned`, so the instant read back moves by the rounding difference, as
in earlier versions.

Key composition is unchanged for every
existing shape (primary, GSI, unique, version, soft-delete, time-series keys);
`Entity.nestedSelfDates.test.ts` snapshots the key attributes written.

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
Query.limit(10)    // at most 10 ITEMS (accumulates across requests)
Query.pageSize(10) // 10 rows examined per REQUEST (DynamoDB `Limit`)
Query.reverse      // scanForward = false
Query.consistentRead // the table or an LSI; on a GSI DynamoDB rejects it, diagnosed (#144)

// 6. Execute — terminal, crosses into Effect
Query.execute    // Query<A> => Effect<A, DynamoError, DynamoClient>
Query.paginate   // Query<A> => Effect<Stream<A>, DynamoError, DynamoClient>
```

### Accessor sort key conditions (#171)

An accessor that pins sort key composites sends ONE sort key condition
(`KeyComposer.composeSortKeyCondition`), and a value never matches a longer
sibling:

| Pinned | Condition |
|---|---|
| some composites, primary key | `begins_with(sk, <prefix>#)` — the delimiter ends the last value, so `done` never matches `done_archived` |
| some composites, secondary index, `escapeKeys: true` | `sk BETWEEN <prefix> AND <prefix>#U+FFFF` — the row truncated at the last pinned composite and everything under it, and still no longer sibling (#183) |
| some composites, secondary index, off | `begins_with(sk, <prefix>#)` |
| every composite | `sk = <key>` — the stored key ends at the last value, so there is no delimiter to stop on; `seq: 3` never matches `3.14` / `3.5`, `ship` never `shipped` |

Up to 1.36 a complete key was still `begins_with(<key>)` and matched those
siblings. The rule covers the primary accessor, every GSI accessor (on an
isolated or a clustered collection index too), `Entity.query.<index>` and the
language service's params (a collection query pins no sort key composites); `Aggregate.list` applies the same rule to its list sort key
(`=` when every list sk composite is given, else `begins_with` with a trailing
`#`). A full pin on a time-series entity's primary accessor reads the current item
only, never its `#e#` rows. Z-order halves pin prefix segments only and are
unaffected. An index whose sort key has no composites (an empty-composite half)
pins nothing: its accessor sends the partition key alone, and on the primary key
the history rows that extend the live key are dropped as rows (`liveRows`).

**A pin on a truncated row's own level (#183), with `escapeKeys: true`.** An update can truncate a secondary
index sort key at its last present composite (§7, shape 3), so `city_sf` is a row of
its own as well as the parent of `city_sf#block_1`. A condition on `begins_with(city_sf#)`
missed that row, and `begins_with(city_sf)` would catch the sibling `city_sfx`. So a
partial pin on a secondary index sends `BETWEEN <prefix> AND <prefix>#U+FFFF`: after a
complete value the next byte is the end of the key, `#`, or a longer sibling's next
character, and composite text escapes everything up to `%` (§7 "Key text"), so a
sibling's next byte is above `#` and outside the range. `.where(eq)` on a composite that
isn't the last, and an `eq` in `.within()`, mean the same.

- **Off, the condition is 1.36's `begins_with(<prefix>#)`** (`KeyComposer.pinCondition`), and such
  a row isn't returned. Without escaping, a sibling's next byte can be below `#`, so the range would
  return `new york` for a pin on `new`, and only a row check could drop it.
- **Why on the read side.** Stored key text doesn't change, so rows already truncated are
  found the moment the reader upgrades. A trailing `#` on truncated keys would need a
  migration of every such row and would no longer be "the key as far as it goes".
- **The primary key stays `begins_with(<prefix>#)`.** Its rows are never truncated: a
  primary key can't lose a composite. So do `Aggregate.list` (aggregates don't truncate),
  and clustered collection prefixes, event, version and tombstone prefixes, whose segments
  are names rather than values.
- **Request size.** The high operand is four bytes past the prefix where `begins_with` was
  one, so a prefix within three bytes of DynamoDB's 1,024-byte sort key limit is now refused
  by DynamoDB. There's no client check, as for any other limit DynamoDB enforces.
- **`.within()` on a sharded index** stays refused (`EDD-9104`), and the pin's condition is
  the one each partition reads.

**`beginsWith` on a numeric composite is `eq`.** Numeric key text has no textual
prefix by value (`3` is not a prefix of `35`), so `.where(beginsWith)` with a
`number` or `bigint` operand compiles to `eq` (`composeRangeUnder`, and history
`.where()`). That is also what 1.36 amounted to for a non-negative integer, whose
padded text has the full width.

**A bound is one exact key range, with `escapeKeys: true`.** A composite's key text is escaped (§7
"Key text"), so it sorts as the cased value, and the `#` that follows a
non-last composite sorts below every character the text holds: a value's subtree
(`v#…`) sorts after `v` and before every greater value (`v%20x`, `v0`). So every
`.where()` / `.within()` bound composes one condition over the composed operand
key text `K(v)` (`composeRangeUnder`, shared by both), exact whatever characters
the values hold:

| Bound | Unclamped | Clamped under pinned composites, prefix `P` |
|---|---|---|
| `eq v` | `sk = K(v)` on the last composite; on any other, `begins_with(K(v)#)` on the primary key and `BETWEEN K(v) AND K(v)#U+FFFF` on a secondary index | the same |
| `beginsWith v` | `begins_with(K(v))`; `eq` for a numeric operand | the same |
| `lt v` | `< K(v)` | `BETWEEN P AND K(v)`; `BETWEEN P AND keyJustBelow(K(v))` on the last composite |
| `lte v` | `<= K(v)#U+FFFF`; `<= K(v)` on the last | `BETWEEN P AND` the same end |
| `gt v` | `> K(v)#U+FFFF`; `> K(v)` on the last | `BETWEEN K(v)#U+FFFF AND P + U+FFFF` |
| `gte v` | `>= K(v)` | `BETWEEN K(v) AND P + U+FFFF` |
| `between a b` | `BETWEEN K(a) AND K(b)#U+FFFF`; `… K(b)` on the last | the same |

These are the conditions under either setting: a value without a character
U+0000–U+0025 composes byte-identical requests. With the flag off the text is not
escaped, so ` `, `!`, `"` and control characters sort below the delimiter
(`new york#…` < `new!#…` < `new#…` though `new` < `new york` < `new!`) and both a
bound and a stored value can sort apart (`lte: "new york"` leaves out `new`,
`gt: "new"` leaves out `new york`), and a value holding `#` splits into two
segments. With it on, `a#b` is one value (`a%23b`), and `a` neither equals nor prefixes
it.

The strict `lt` on a clamped last composite was refused up to 1.36 (`EDD-9046`,
now retired); `keyJustBelow` makes it exact. A well-formed `.within()` interval
no value satisfies (`{ gt: 3, lte: 3 }`, `{ gte: 4, lte: 3 }`), judged on the
operands' key text, composes to no condition: the plan is `empty` and nothing is
sent. A `.where(between)` given high end first keeps 1.36's request, its composed
ends reversed too, for DynamoDB to refuse (#144).

**History `.where()` stays inside `<currentSk>#e#`.** A one-sided bound would
replace the history prefix with a bare comparison and read the current item and
other items' rows in the partition (as 1.36 did), so each operator becomes a
range clamped to the prefix `P`, operand key `v` = `P` + the `orderBy` key text:

| Operator | Condition |
|---|---|
| `eq` | `sk = v` |
| `lte` / `lt` | `BETWEEN P AND v` / `BETWEEN P AND keyJustBelow(v)` |
| `gte` / `gt` | `BETWEEN v AND P + U+10FFFF` / `BETWEEN v#U+FFFF AND P + U+10FFFF` |
| `between` | unchanged (both ends carry `P`) |
| `beginsWith` | `begins_with(sk, v)`; `sk = v` for a numeric `orderBy` |

`keyJustBelow(v)` (`internal/RangePlanner.ts`) steps the last code point of `v`
down by one and appends U+10FFFF, the greatest code point, so the strict bound is
exact on the key and keeps `Limit` on the request (no row check). `gt` uses the
`#` + U+FFFF convention of `composeRangeUnder`: the `orderBy` text is escaped
like any sort key composite's, so every greater value's text extends `v` with a
character above `#`, or differs from it before its end. The open end is `P` + U+10FFFF, not
U+FFFF: the `orderBy` text follows `P` with no label before it, and a stamp that
starts with an emoji (4-byte UTF-8) sorts above U+FFFF.

**Event keys compose the `orderBy`'s key form.** An event key's last segment is
the `orderBy` value as a key holds it — its key form (§7 "Composite key form"),
serialized and escaped — the same text row checks and `liveRows` compose. For a
string-encoded number (`NumberFromString`, `BigIntFromString`) that is the
number's key text, so events sort numerically. Up to 1.36 `append` composed it
from the encoded string, which sorted `"10"` before `"9"`, while `.where()` bounds
were numeric: history read out of order and bounds missed events. Those event keys
changed in 1.37.0. **With `escapeKeys` off, the default since 1.39.0, the segment
is the encoded value again** (`KeyComposer.eventOrderByValue`), and such a history
reads in text order.

**A `.history().where()` bound composes as `append` composes the event key**: the
value encoded through the model's `orderBy` field (encode, else decode then encode:
`encodeOrderBy`), which is the value `append` stores and a read of the row takes,
then `eventOrderByValue` over it and its key form. The model's field, not
`appendInput`'s: where they differ, an `append` whose event key a read wouldn't
compose is refused (EDD-9128), and `rekey` moves an earlier one to the key its row
composes, so the model's reading is the one every event is under. Through 1.39.0
a bound was the caller's value through the key form, whatever the setting, so with
`escapeKeys` off `eq` on a string-encoded number named padded text no event had,
and with it on a value stored in another form (a number stored divided by ten)
named its stored value's text, `9` for `90`, where `append` had put that stored
value through the key form again, `0.9`: `eq` found nothing, and ranges missed. With `escapeKeys` off a string-encoded number's events
are in text order, so a range in numeric order can be reversed in text
(`between(9, 10)` is `"9"` to `"10"`): DynamoDB rejects it, diagnosed as a
`ValidationError` naming both bounds (`BetweenReversed`, #144), where 1.39.0
returned nothing. `beginsWith` on a numeric `orderBy` still compiles to `eq`
(`test/HistoryWhereOperand.test.ts` and its connected twin, over events 1.39.0
stored). An `Option` `orderBy` is stored as a map, and DynamoDB refuses `append`'s
`<` guard on a map, as it did on 1.39.0, so no such event is ever written there.

**`append` on a string-encoded numeric `orderBy`.** The stored `orderBy` is `S`,
which DynamoDB compares as text, so the CAS `attribute_not_exists(pk) OR
#orderBy < :new` refused `10` after `9` (and took `9` after `10`). For such an
`orderBy` (`compositeKeyFormKind` is `type-numeric`) `append` instead:

1. reads the current item, strongly consistent;
2. decides the CAS on the numbers: an existing item whose `orderBy` is not below
   the attempted one (or that has none) makes the append `StaleAppend`, and
   nothing is written;
3. sends the transaction guarded on what it read — `attribute_not_exists(pk)` for
   a new item, `#orderBy = :observed` otherwise — ANDed with the user's condition;
4. after a cancellation reads again: a moved `orderBy` (another append won the
   race) goes back to step 2, at most 8 attempts (`APPEND_GUARD_ATTEMPTS`), then
   the append fails with the transaction's error; an unmoved one means the user's
   condition rejected the write (`ConditionalCheckFailed`, with the current item
   when there is one) or, with no user condition, `StaleAppend`.

Cost: one strongly consistent `GetItem` before each such append, and one after
each cancellation, `.skipFollowUp()` included (its success is still `void`, and a
stale or rejected append still `StaleAppend` with no current item). Every other
`orderBy` keeps the single conditional transaction: DynamoDB orders `N`
numerically and ISO-8601 text chronologically.

**Cancellations every `append` tells apart (#171).** A transaction DynamoDB
cancels for a `TransactionConflict` alone (another transaction in flight on the
item; no condition failed, nothing written) is no verdict: on every path
(`orderBy` of any type) it is sent again, at
most 8 attempts (`APPEND_GUARD_ATTEMPTS`), then the append fails with the
transaction's error. Up to 1.36 it was read as a stale append or a user
condition's rejection, and the event dropped. A user condition that rejects an
append creating the item fails `ConditionalCheckFailed` with no current item,
for every `orderBy` type (up to 1.36, `ValidationError("append.followUp")`);
under `.skipFollowUp()` it is still `StaleAppend` with none. Both reads after
the transaction — the one that tells a cancellation's cause and the one that
returns `current` after an applied append — are strongly consistent (up to 1.36,
eventually consistent): such a read could miss the item the append had just
created (a false `ValidationError("append.followUp")`, or the user's condition
taken for rejecting its creation) or return it as it was before the append.
Each costs one read unit per 4 KB rather than half of one.

### Request Sizing (#171)

`limit(n)` is a contract on results; the `Limit` each request sends is chosen by one sizing mode per query (`QueryExplain.sizing`):

| Mode | When | Each request's `Limit` |
|---|---|---|
| `fixed` | numeric `pageSize(n)` | `n`, never adapted (with a `limit` and nothing that drops rows, `min(n, owed)`) |
| `natural` | `pageSize("natural")`, or `maxPages` on a query without a planner | 1.36's sizing: a natural 1 MB page under a filter or predicate, `limit` doubling per request over history rows, the outstanding `limit` otherwise |
| none | no `limit` | none: natural 1 MB pages |
| `adaptive` | a `limit` and something that drops rows: a filter, a `filterBy` predicate, a plan's row check, history rows | first `max(16, 2 × owed)` under a filter (`owed` when only history rows drop); doubling while nothing is accepted; then `⌈owed / rate × 1.25⌉`, `rate = min(cumulative, last request's)` acceptance; clamped to 1..100,000 |
| `budget` | a `limit` nothing filters (the `__edd_e__` ownership clause alone included) | the items still owed |

The estimator lives in the terminal's loop, never in a cursor: a resumed query starts fresh. Items returned by `collect()` / `count()` and by a `fetch()` chain end to end are unchanged; request counts, read units, `fetch()` cursor values (and whether the last page's cursor is `None`) and `Query.paginate`'s page boundaries can differ. A `.pageSize()` string other than `"natural"` throws `EDD-9095`.

### `.within()` and Skip-Scan (#171)

`.within(bounds, { maxSkips? })` on a composite accessor bounds any sort key composite the accessor left open (`{ eq }`, `{ between }`, `gt` / `gte` and / or `lt` / `lte`, compared in key form). It excludes `.where()` and a second `.within()` (`EDD-9093`). The planner (`internal/RangePlanner.ts`, pure: it turns a plan and each response into the next `Read` / `Probe` / `Done` step; `Query.ts`'s loop sends every request) picks:

- **`key`** — eq bounds extend the pinned prefix, and the first bounded composite is next: its one key condition (shared with `.where()` through `composeRangeUnder`); bounds on later composites, which no key condition can express, become row checks, which compare values (`boundHolds`), not composed key segments, and trust the stored attribute over a stale `'preserve'` key (§7). A bound no value satisfies plans `empty` and sends nothing.
- **`skip-scan`** — composites left of the first bound are unbounded (the *skip tuple*): a `Limit: 1` probe (no filter, projection of the sort key) finds the next distinct tuple, its range is read with the normal loop, then a probe from just past it (`T` with its trailing `#` replaced by `$`: every composite's text is escaped, so no key in `T`'s subtree holds a `#` or `$` there, and `$` sorts below every character a greater tuple's text can continue with). Probes inherit `.consistentRead()` on the primary index. After `maxSkips` probes (default 32) the rest is read as one filtered range; `maxSkips: 0` filters at once.
- **`filter`** — one range, every bound checked per row: on a primary accessor that shares its partition with history rows (retain, soft delete, time series), at `maxSkips: 0`, or after a probed key that doesn't parse.

Every request, probes included, counts against `maxPages`, is observed by `onRequest` and is charged to the query's consumed-capacity operation.

### Z-order Queries (#171)

On a Z-order accessor, `.within()` bounds dimensions (a `RangeBound` in the field's own type; `in` for a `literals` dimension) and pins prefix composites (`eq`); `.where()` is absent. Bounds quantize to a box of levels; exact bounds are checked by a `FilterExpression` where the stored form compares in key order, else by a row check. Unpinned prefix composites are skip-scanned over the binary prefix (exact byte parsing of the length-prefixed or hashed segments), then the box is read inside each tuple. `.zorder({ strategy, maxRanges, pageSize, concurrency })`, later calls merging over earlier ones:

| Strategy | Reads |
|---|---|
| `naive` | the box's hull `[zmin, zmax]` in one range, every row checked |
| `jump` | the hull; after a page whose last key is outside the box, BIGMIN gives the next address inside it and the next request starts there. `Limit` starts at 16 and doubles with the in-box run, up to 1,000 (`pageSize` fixes it) |
| `precise` | a capped plan of address ranges (`maxRanges`, default 16) by cell descent, with the cheapest gaps merged; ranges in flight at once: `concurrency` |
| `auto` (default) | `precise` when the exact plan fits `maxRanges`, else `jump` |

`concurrency` defaults to 4 for reads with a `limit` and 1 for drains (natural 1 MB pages against one partition). Plans are cached (LRU, 64). Results arrive in address order (prefix order, then Z-order), never sorted by any one dimension. An empty box plans `empty` and sends nothing.

### Fan-out Queries (#183)

A query on a sharded index reads its partitions (§7 "Write Sharding") and merges them, on every terminal. `Query.fanOut` (internal) installs them, and the terminals branch on them before any other plan. A pruned query takes the same path with one partition, so a cursor can't change format because of a query's pins.

**Merge** (`internal/ShardMerge.ts`, pure: `Query.ts` sends the requests). A row is emitted only when every unfinished partition has a buffered row to compare it with, which is what makes the order correct and bounds memory at one page per partition. `compareUtf8` for `S`, bytes for `B`, numeric for `N` with no float conversion. Equal sort keys on different partitions break by partition index, descending under `.reverse()`, so reverse reverses forward up to DynamoDB's unspecified order among equal sort keys within one partition; the table key can't be reached, since a tie is between heads of different partitions.

| Terminal | Behaviour |
|---|---|
| `.collect()` / `.paginate()` | Streams the merge: each pull reads every unfinished partition whose buffer is empty, then emits what is proven in order |
| `.limit(n).fetch()` | `n` merged items and a cursor, over as many rounds as it takes; rows read beyond the page are dropped and read again |
| `.fetch()` without `limit` | One round of reads: what it proves in order, and a cursor |
| `.count()` | Each partition counted (`Select: COUNT`, or the rows read where a row check judges them), summed, capped at `limit` |

There is no `.stream()` terminal.

**Rounds and refills.** A round reads every partition that has nothing buffered and more to read, all at once, and takes about as long as the slowest of them. The first round is every partition. The merge then emits until it reaches the budget or the first partition with more to read runs dry, and stops: nothing further is proven in order until that partition is read. So later rounds usually read one partition, one after another, and a `.limit(n).fetch()` takes one round trip per round, not one overall. Rows spread evenly over `N` partitions with each `Limit` near `n / N` run dry often. A measured 20-shard page of 100 took 26 requests over about 7 round trips, where the same page unsharded took 1 (`docs/designs/gsi-write-sharding.md` §12).

**Request sizing.** One estimator per partition, kept in the terminal's loop and never in a cursor. `active` = partitions not finished, `remaining` = items still owed. `none`: no `Limit`. `fixed`: `pageSize(n)` as given (`min(n, remaining)` when nothing filters). `natural`: 1.36's sizing with `remaining`. `budget`: `min(remaining, max(⌈remaining / active × 1.25⌉, last × 2))`. `adaptive`: `nextLimit(estimator, ⌈remaining / active⌉, filtered)`.

**`.maxPages(n)`** is `n` rounds: at most one request per unfinished partition per round. It does not force natural sizing here, since fan-out has no 1.36 sizing to preserve. Rows that can't be proven in order when the rounds run out are dropped; `fetch`'s cursor reads them again, and `collect` stops short.

**`Query.where`.** A replaced condition isn't the pins a pruned query chose its shard for, so the unbound `Query.where` restores every partition, `previous`'s included, and reports `pruned: false`. An accessor's own pin, `Entity.query`'s and a bound `.where()`, which stay under the pins, use the internal `Query.whereUnderPins`. No other combinator changes the sort key condition after pruning.

**`.concurrency(n)`** (`Query.concurrency`, `Function.dual`, and `BoundQuery`): requests in flight, default every partition. A value that isn't a positive integer throws `EDD-9105`. No effect on any other query.

**Projections.** `cursorProjectionFields` always borrows the keys the merge and cursor need, across every partition's key fields, and `examinePage` strips them.

**Failure.** Any partition's failure fails the terminal. `fetch` and `collect` return no partial result and interrupt requests in flight; a `paginate` stream fails at that point, having delivered only what was already proven in order.

**Capacity.** Every request runs on `Capacity.client` inside the terminal's one operation.

**`previous` and other key text.** A shard can hold a sort key under other text: an update naming the partition key and no sort key composite moves the partition key and keeps the sort key, with no read. A query reads the layouts' partitions under the one text the setting composes, so such a row isn't found until `rekey` rewrites it (`indexKeysRewritten`). `KeyText136.composePk` stays unsharded, so no partition key in a shard is under another form.

### Inspection: `explain()` and `onRequest()` (#171)

`explain()` returns a `QueryExplain` — `index`, `plan` (`PlanMode`: `key`, `skip-scan`, `filter`, `naive`, `jump`, `precise`, `empty`), `reason`, `keyConditions` (`{ lower, upper, exact }`), `filter`, `rowChecks`, `sizing`, `zorder?` (`bits`, per-dimension `box`, `fill`, `exactRanges`), `maxSkips?` — with no I/O; a `startFrom` cursor is not read. `onRequest(observer)` runs each observer, in order, in the terminal's fiber after every request with a `QueryRequestEvent` (`kind: "read" | "probe" | "count"`, `request`, `lower`, `upper`, `limit`, `scannedCount`, `count`, `accepted`, `discarded`); a failure is a defect, and DynamoDB calls an observer makes run under `Capacity.detached`, outside the query's report. `asParams` with a planner reports the first request the terminal would send.

On a fan-out, `explain()` keeps plan `key`, lists one key condition per partition and adds `fanOut: { partitions, pruned, concurrency }`; `asParams` reports the first partition's request. `onRequest` reports one event per request. A row's acceptance is known only when it is emitted, so an event fires when its page drains or at the end of the terminal, and events may arrive out of `request` order. `accepted` counts that page's rows that became items, and a page read and never used reports `discarded: true`.

### Cursors (#171)

Two formats (`internal/Cursor.ts`):

- **Legacy** — `btoa(JSON.stringify(LastEvaluatedKey))`. Every query without a planner, and `Aggregate.list`, still emits it whenever it can carry the key exactly, so their cursors are byte-identical to earlier releases.
- **v2** — `"v2." + base64url(utf8(JSON))`: emitted for keys with `B` values or text outside Latin-1, and for every planned query. It carries a fingerprint (index, entity type, partition key value, pinned and prefix values, the quantized box or bounds, the layout, `reverse`), the plan mode in force and a position: the skip tuple in progress, and either the `LastEvaluatedKey` to resume at, the last in-plan key done (*through*), or that the tuple is finished. The fingerprint excludes `maxRanges`, `concurrency`, `strategy`, `pageSize` and `maxSkips`, so a resumed query may change them; resume recomputes the plan and continues from the position, in the plan mode it recorded, with a fresh probe budget.

A page hands its cursor out as an `Option<string>`: `Query.Page.cursor` (every `fetch()` / `Query.execute`), a collection's `fetch()` and an aggregate `ListResult.cursor` are `Some(text)` while there is more and `None` once the range is exhausted. The inputs take the text: `startFrom(cursor: string)` and `list({ cursor })`, so `None` never stands for "start again". Internally the loops keep `string | null` and wrap it at the terminal.

`startFrom` never throws: the cursor is decoded when a terminal runs. A malformed cursor of either format, a fingerprint mismatch, a v2 `.within()` cursor on a query without one, a legacy cursor for any plan other than a key or naive plan (skip-scan, filter, jump, precise, empty), or a position outside the recomputed plan fails the terminal with a `ValidationError` (`EDD-9094`, `operation: "query.startFrom"`).

`Aggregate.list` writes and reads its cursor with the same codec, and has no plan to place it in. Its key goes out as the legacy bytes when they can carry it, else as a v2 cursor holding only `k`. A cursor that isn't one of those (malformed in either format, an empty string, or a v2 cursor holding anything but the key, as a planned or sharded query's does) fails with a `ValidationError` (`EDD-9094`, `operation: "list"`) before anything is sent. A well-formed key isn't checked against the list: as on a query without a planner, DynamoDB may reject it (`DynamoValidationError`) or the list resumes from it. A sharded list refuses every cursor with `EDD-9051` without decoding it.

A sharded query's v2 cursor adds `z`, one position per partition (`0` not started, `1` done, or the key to resume after, without the index partition key, which is recomposed), and `c`, an FNV checksum over them. Its fingerprint covers the index, entity types, partition texts, source, `previous`, conditions and direction, not `concurrency`, `pageSize` or `limit`. A fully consumed page with a `LastEvaluatedKey` positions at that key; a fully consumed page without one is done; a partly consumed page positions at its last consumed row; an untouched page keeps the previous position. `EDD-9094` also covers a wrong position count or shape, an unexpected attribute in a position, a position outside the query's key condition, a checksum mismatch, a plain or planned cursor on a sharded query and a sharded cursor on any other query. The checksum is an integrity check, not authentication; the security-relevant property is that the cursor doesn't carry its partitions, so it can't leave them.

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

// deleteIfExists — delete with attribute_exists guard
yield* db.entities.Tasks.deleteIfExists({ taskId: "t-1" })

// Composed update
yield* db.entities.Products.update({ productId: "p-1" })
  .set({ name: "Updated", price: 24.99 })
  .add({ viewCount: 1 })
  .subtract({ stock: 3 })
  .append({ tags: ["clearance"] })
  .remove(["temporaryFlag"])
  .expectedVersion(5)
```

**An op's own guard is structural (#133).** `create`'s
`attribute_not_exists(pk) AND attribute_not_exists(sk)`, and `patch`'s and
`deleteIfExists`'s `attribute_exists(pk)`, are not held as the op's condition:
they come from the op's kind (`putKind: "create"`, `patch: true`,
`_mustExist`) and are ANDed with the caller's condition where the request is
built — the entity's own write, `Entity.extractTransactable` (transactions,
`EventStore` additional items) and so `Batch.write`, which refuses any op with
a condition. Guard and condition compile as one `and` expression, so their
placeholders never collide; with no condition the guard is sent alone, byte
for byte as before. As on every op, a later `.condition()` replaces an earlier
one; the guard always stays. (The version, unique-sentinel and retain guards
were already separate from the caller's condition.)

**Empty conditions and filters (#133).** The `condition` combinator is the one
place an empty condition becomes none (`nonEmptyCondition`; `append`, which
takes its condition as an argument, applies it on entry): a condition that asserts nothing (`{}`, `and()`, an `and` of only such
parts — `isEmptyExpr`) is dropped, leaving the op's own guard alone; likewise
`Query.filterExpr` drops an empty filter. An empty part directly under `and` is
left out when compiled. Anywhere else — under `or` (which it would make match
everything) or `not` (nothing), or an `or()` with no parts (nothing) — it has
no reading that keeps what the caller wrote, so `emptyPartProblem` refuses it
with a `ValidationError` before anything is sent: in `EntityPut` / `Update` /
`Delete` when they run, per op in `transactWrite`, in `append`, for filters
when a query runs, and for aggregate `list` filters. An `isIn` with no values
is not refused (#144): it compiles to `IN ()`, DynamoDB rejects it as a syntax
error, and the rejection is diagnosed into a `ValidationError` naming the
`isIn()` and its attribute (filters: `operation: "query.filter"`). A
`Transaction.check()` with an empty condition is refused before sending.
`compileExpr` itself throws on anything `emptyPartProblem` refuses, so no
caller can compile one by skipping the check — reaching it is a library bug.

**`patch` and missing items (#134).** `patch()` of a missing item fails with
`ConditionalCheckFailed` on every path — including those that read first
(retain, a unique-field change), which used to report `ItemNotFound`. A plain
(unread) patch sends one exists clause: the plain write's own
`attribute_exists(#exists)` already covers patch's guard.

**`expectedVersion` needs a version (#134).** On an entity without
`versioned`, `.expectedVersion(n)` is refused with a `ValidationError` before
anything is read or sent — a silently skipped concurrency check is worse than
none.

**Yieldable, not Effect.** The *write* builders implement `Pipeable.Pipeable` and `[Symbol.iterator]` (via `Utils.SingleShotGen`) — the same contract as the unbound `EntityOp` and `EntityDelete` intermediates. You execute them by `yield*`ing inside `Effect.gen`. For interop with Effect combinators (`Effect.map`, `Effect.flip`, etc.) use `.asEffect()`.

**`BoundGet` is the exception, and must remain one.** `db.entities.X.get(key)` has returned a real `Effect` since the client gateway existed, and call sites depend on that: `db.entities.X.get(k).pipe(Effect.catchTag("ItemNotFound", …))`, `Effect.map`, `Effect.all`. So `BoundGet` is built on `Effectable.Prototype` and **is** an `Effect<A, E, never>` — the same mechanism `effect`'s own `Statement` uses for a builder that is also an Effect. It additionally carries the bound-op marker, which is what lets it be handed to `Batch.get`, `Transaction.transactGet` and `Transaction.check` (#108). Downgrading it to merely-yieldable would be a silent, wide breaking change.

**One unwrap protocol, both directions.** A bound op joins the multi-item paths by carrying `BoundOpTypeId` plus `_op`; `Entity.extractTransactable` unwraps it to the underlying `EntityOp` / `EntityDelete`. That is the whole mechanism, for reads and writes alike — there is no second one to add. Because `BoundGet` wraps the entity's own `EntityGet`, the key it composes is by construction identical to the one `db.entities.X.get(key)` composes (the multi-item paths through `entity._domainKeyForm`, which `get`'s `encodeKey` and key form agree with; see §7 "Composite key form"). A value that is not a get descriptor is rejected with a `ValidationError` carrying **EDD-9052** on the error channel.

**Immutable accumulator.** Every chainable call returns a new builder — same semantics as `BoundQuery`.

**Method surface per builder**

| Builder | Method | Accepts |
|---|---|---|
| `BoundGet` | *(no combinators — it is an `Effect`)* | — |
| `BoundPut` / `BoundCreate` / `BoundUpsert` | `.condition(cond)` | callback `(t, ops) => Expr` or equality shorthand record (`{ status: "active" }`) |
| `BoundDelete` | `.condition(cond)` | same as above |
| `BoundDelete` | `.returnValues(mode)` | `"none"` or `"allOld"` |
| `BoundUpdate` / `BoundPatch` | `.set(updates)` | partial record |
| `BoundUpdate` / `BoundPatch` | `.remove(fields)` | `ReadonlyArray<string>` |
| `BoundUpdate` / `BoundPatch` | `.add(values)` | `Record<string, number>` |
| `BoundUpdate` / `BoundPatch` | `.subtract(values)` | `Record<string, number>` |
| `BoundUpdate` / `BoundPatch` | `.append(values)` | `Record<string, ReadonlyArray<unknown>>` |
| `BoundUpdate` / `BoundPatch` | `.deleteFromSet(values)` | `Record<string, unknown>` |
| `BoundUpdate` / `BoundPatch` | `.expectedVersion(n)` | `number` |
| `BoundUpdate` / `BoundPatch` | `.condition(cond)` | callback or equality shorthand record |
| `BoundUpdate` / `BoundPatch` | `.returnValues(mode)` | any `ReturnValuesMode` |
| `BoundUpdate` / `BoundPatch` | `.cascade(config)` | cascade targets |
| `BoundUpdate` / `BoundPatch` | `.pathSet(op)` / `.pathRemove(segs)` / `.pathAdd(op)` / `.pathSubtract(op)` / `.pathAppend(op)` / `.pathPrepend(op)` / `.pathIfNotExists(op)` / `.pathDelete(op)` | same payloads as the unbound `Entity.path*` combinators |
| all builders | `.asEffect()` | — |

**Implementation strategy.** The builders are thin wrappers. Internally each holds an `EntityOp` (or `EntityDelete`) from the unbound entity plus a pre-resolved `provide` for `DynamoClient + TableConfig`. Every chainable method forwards into the existing `Entity.set/remove/add/condition/…` combinators. On `yield*` (or `.asEffect()`) the builder calls `op._run("record")` (or `op.asEffect()` for deletes) and pipes through `provide` so the final `Effect` has `R = never`.

**A path is stored under its first segment's attribute, and below it as given.**
A `field:` rename is a top-level attribute's name. Below a field a value is
stored whole, under the names its own schema has: `put` stores `meta.count` as
`count` whatever a top-level `count` is renamed to, and a `DynamoModel.ref`'s
map holds the referenced entity under that entity's own field names, not its
stored ones. `internal/PathBuilder.ts`'s `storedPath` is the one function that
says so. `compilePath` names an update's path operations and a condition's
paths by it (`Entity.condition`, a transaction's op conditions); a filter
(`renamePaths`, an entity's and a collection's) and a projection
(`selectRenamed`) map their paths through it too. So all four name the attribute
`put` stored. Through 1.39.0 `compilePath` renamed every segment: with `count`
stored as `renamed`, `pathSet(["meta", "count"], 9)` wrote a stray
`meta.renamed` and left `meta.count` as it was, and a condition on
`t.meta.count` tested `meta.renamed`, which no row holds, so it failed whatever
the row held. A filter and a projection already named `meta.count`. A first
segment holding `#` is still a literal attribute name for a path write and a
condition (a sparse map's entry). An aggregate's `list` filter compiles with no
rename at any level, and `.history().where()` is a sort-key condition, so
neither is affected. A path with no segment below the first spelled as a
renamed field sends the requests it always sent
(`test/fixtures/nested-path-requests-1.39.0.json`). A path does not follow a
nested struct's own key encoding (`Schema.encodeKeys`) on any release: below
the first segment it names the property as written. Through 1.39.0 one such
path reached the stored key by coincidence, when the nested struct encoded a
property to the name a top-level field of the same spelling was renamed to; it
now names the property, like every other path below a key-encoded struct.

**Path-addressed values are encoded (#133).** `pathSet`, `pathAppend`,
`pathPrepend`, `pathIfNotExists` and record-based `append` (including the
versioned-retain path) bypass the update schema, and used to marshal their
value as given: a `DateTime` became a map even on a plain date field, and a
`NumberFromString` value was stored as a number. `makePathValueEncoder` resolves
the schema the path addresses (`childAtSegment` through struct fields, union
members, array / tuple elements and record values; a top-level field uses the
record schema's own, so `storedAs` applies) and encodes the value through it;
list operations encode element by element. Values go through `encode`, then
`decode → encode` as `.set()` does, so a plain object on a class-typed field is
encoded as that class, and a value already in wire form is normalised
(`NumberFromString` `"05"` → `"5"`, `DateTimeUtcFromString` `"2000-01-01"` →
`"2000-01-01T00:00:00.000Z"`, `Schema.Trim`): read-back values are identical,
only stored bytes differ. A class instance is always encoded whole. A plain
object or array that neither encodes nor decode→encodes whole (it mixes wire and
domain parts), or that holds an ambiguous wire leaf, is encoded part by part
(`encodeByParts`, `holdsAmbiguousLeaf`), so every `DateTime` / `Date` /
`Redacted` inside is stored in wire form. The one pass-through is a LEAF
transform with a primitive wire form, given a value that genuinely decodes as
wire AND validates as the domain type (`StringFromBase64` given `"aGk="`,
`fromJsonString`), whose encode would double-encode it (`makeAmbiguityCheck`);
`"hi"` on `StringFromBase64` is not valid wire and is encoded. Paths into and
under a TOP-LEVEL `DynamoModel.ref` field follow the ref target's model
(`refTargets`), whose read schema is substituted, so they are encoded like any
other path. An opaque class (built with `.check()` or `.annotate()`, or a
`DynamoModel.ref` nested inside a ref target) is deliberately not followed by
`childAtSegment`: its `.fields` are gone, so the read schema keeps it
unsubstituted and decodes its leaves exactly as `put` stores them, and a path
value under it is passed through as given so the item stays readable. Known
limitation: plain dates inside such a class are still stored as maps (also by
`put` / `.set()`), as on 1.22.0. Only those and paths no schema describes (under
a dynamic key of an untyped value) are passed through. Each such operand is
encoded and checked against the schema at its path once, in `prepareUpdate`
(`encodeOperands`), and written as encoded there: one the schema refuses fails
the update with a `ValidationError` (`operation` `update.append`,
`update.pathSet`, `update.pathAppend`, `update.pathPrepend` or
`update.pathIfNotExists`) before it reads or sends anything, alone or in a
`transactWrite`. It used to be decided as the write was built, after the reads
of an update that reads first, so a failed read was reported in its place.
A copy (`pathSet` or `pathSubtract` naming another attribute, `isPath`) holds no
operand: its `value` isn't written, so nothing reads it, encodes it or checks
that it would store or read back.
Only the moment changes: the check, its verdict, its error and the bytes of an
operand it accepts are the ones the write was built with. An update refused for
a second reason reports the operand, where it reported whichever it met first
as it read and built the write: a missing item (`ItemNotFound`), a stale
`expectedVersion` (`OptimisticLockError`), an immutable field restated with
another value on a retained entity (`ValidationError` `update`), a ref whose
target isn't there (`RefNotFound`), a packed value with no compressor
(`ValidationError` `update.packed`).

**Retain entities.** The `versioned: { retain: true }` update branch builds the
new item in memory and writes it in a transaction with the snapshot; it used to
ignore path operations entirely (success, nothing written). An update that
carries path operations now reads the current item (consistent read) for the
snapshot, then sends the non-retain branch's own `UpdateExpression` (version
bump, timestamps, GSI recomposition, `expectedVersion`, user condition) as the
`Update` in one `TransactWriteItems` with the snapshot `Put`, conditioned on
the version read. DynamoDB therefore applies the path semantics itself — parity
by construction, never emulated — and a rejected expression writes no snapshot.
Path operations combined with a unique-constraint change, or with a computed
change to an index composite, are rejected with a `ValidationError`: both are
read-then-write updates that cannot carry path expressions. Record retain
updates are guarded read-then-write updates (below).

Each encoded path value is then **validated** against the write schema at its
path (`validate` / `validateElements`), as `.set()` validates its payload: a
literal outside its set, a string under `minLength` or a broken container check
fails with a `ValidationError` instead of being stored. `undefined` object
entries are dropped first (`asStored`), since the marshaller drops them too.
List `append` / `prepend` validate each element, but cannot enforce list-level
checks such as `maxLength`: DynamoDB builds the list server-side. `ADD`,
`DELETE` and `SUBTRACT` are unchanged.

**Path operations on key and unique fields (#133).** DynamoDB evaluates a path
operation, so compiling one on an index composite or unique field would change
the attribute while its keys and sentinel stayed put. `normalizeDerivedPathOps`
rewrites the ones whose result is known client-side into record operations: a
top-level `pathSet` of a value / `pathRemove` into `.set()` / `.remove()`, a
numeric `pathAdd` / `pathSubtract` into `.add()` / `.subtract()`. Those then go
through the key composer and the sentinel rotation. It refuses, with a
`ValidationError` naming the field: copies, `pathIfNotExists`, list and set
operations on such a field (DynamoDB computes their result at write time); a
path below such a field; any path operation on a primary-key composite or an
immutable field; and a second operation on the same field. `.add()` /
`.subtract()` / `.append()` / `.deleteFromSet()` on a GSI composite recompose
the index key on every entity.

**Clearing a field (#177, #178).** `.set({ f: undefined })` is `.remove(["f"])`, unless the field stores `undefined` as a value (`storesUndefined`), which is written like any other: `normalizeClears` moves it once, at the top of `runUpdate`, so the sentinel release, the composer's per-half gate and policy, the vector gate, the retain snapshot and the transactional planner (which runs this same op) see one form. A value that encodes to nothing (`Option.none()` on a `Schema.OptionFromOptional` field) clears the same way. Three names aren't clears: a library-generated `updatedAt` (`undefined` means generate it), a sparse map (`.set()` merges entries, and no entries merge nothing), and a name the model doesn't know, which the payload's schema drops.

Clearing a field a row can't lack is refused with a `ValidationError` before anything is sent, for `.set({ f: undefined })`, `.remove(["f"])`, a top-level `pathRemove(["f"])` and an `append`'s `.remove`, because the write would land and the row could not then be read. A row can lack a field if it still decodes without it (`rowCanLack`), so a decoding default can be cleared and a `NullOr` can't. Where that's decided is read from the schema (`lackDecision`), and defining an entity runs none of a model's code. With nothing of the model's taking part, the schema decides: a required field can't be lacked, an optional key can (the key as read: a missing key reaches it as missing through every step that only maps a value, whatever the stored side declares), and so can a field whose absent attribute is one of its values and is read with no check or transformation. Where a decoding default, a step handed the absent key, a middleware, a suspension, or a check or transformation on the value an absent attribute stands for takes part, the write that clears the field reads the absence once, as the next read would (a real decode of `{}`, or of that value), CPU only, and is refused if it fails. A step is taken to leave an absent key alone only if it's one of the getters that map a value they're given (`passthrough`, `transform`, `transformEffect`); any other kind, one the library doesn't know included, is decided by the write. A ref can't, whatever its model field declares: its read schema points at the required target. `pathRemove` of a property below a field is judged by walking the stored side of the field's schema (`pathIsRequired`): structs, classes and recursive schemas are followed, a record's entry and a list's element are open (a list closes up, so which element went says nothing about the row), and a union requires a property only if every member declaring it does. A `.check()` that a removal would fail, such as a minimum length on a list, is not judged. `null` follows the same line: on a field a row can lack it clears, on one it can't (a required `NullOr`) it is stored.

An update names model fields, never what the library stores. `refusedAttributeNames` refuses, in every record and path operation, another field's stored name (naming the field to use), a secondary index's key attribute, any `__edd_*` attribute, the version and timestamp attributes, `deletedAt` and the TTL attribute on an entity configured to use them, an immutable field and a sparse map; `.remove` and a single-segment `pathRemove` also refuse a sparse entry's stored name, naming `.removeEntries`, while the other path operations keep it, as that's how a counter entry is added to. A name the model simply doesn't know stays allowed, since it's the only way to clean up an attribute the model no longer declares.

The types narrow to match. `.remove` takes `RemovableFields` (`AppendRemovableFields` on an `append`, which also needs the name in `appendInput` and excludes `orderBy`), on `BoundUpdate`, `BoundAppend` and `Entity.remove`, and the unbound update's payload carries the names as a phantom so `Entity.remove` works data-last in a `pipe`. `updateSchema` declares a field a row can't lack with `optionalKey`, not `optional`, so `.set({ required: undefined })` doesn't compile under `exactOptionalPropertyTypes`, and JSON `null` for it is a decode error for anyone serving the schema over HTTP. `.pathRemove` stays `ReadonlyArray<string | number>`.

An `append`'s own `{ f: undefined }` is not a clear. The attribute stays, and it counts as naming the composite (**N**), so a half it feeds drops under `sparse` and stays under `preserve`. `.remove` clears. The exception is a field whose stored side includes `undefined`, below: there it is the value, and a REMOVE.

The names `.remove` refuses by configuration (immutable, sparse map) can't be derived from what `Entity` and `BoundEntity` otherwise carry, because `make` unwraps `ConfiguredModel<TModel, TAttrs>` to `TModel`, so each has one more type parameter, last, defaulting to `never`. Every position the names reach is a method (`_unremovableFields`, `Removable`, `BoundUpdate.remove`, `BoundAppend.remove`), whose parameter is compared both ways, so a type written with the old argument count still fits an entity with such a field. Such an annotation forgets those names: `.remove` of one compiles, and is refused at run time.

**Values with no stored form.** DynamoDB can't store `undefined` or an empty set, so on a field whose stored side includes one the value is an absent attribute, and an absent attribute reads back as that value (`absentReading`). It's one rule with a write half and a read half, and it costs nothing on any other value: no extra read, and the same bytes.

The write half is the marshaller (`Marshaller.toAttributeMap`), the single choke point every item passes. It marshals; only if that throws does it strip empty sets from maps and retry, which leaves `undefined` to `removeUndefinedValues` as before. The retry walks what marshalling walks, an object's enumerable properties with its prototype's included, because that's where an `Option`, a `Result`, an `Exit` and a `Cause` keep their tag, op and marker: a copy of the own properties alone is a row no read takes. A top-level operand (`toAttributeValue`) has no attribute to leave out, so it still throws, and the update path normalises operands first (`normalizeNoStoredForm`): `.set` of one is a clear, `.add` / `.deleteFromSet` / `pathAdd` / `pathDelete` of an empty set does nothing, and `pathSet` of one is a `pathRemove`.

The read half is `substituteSchemaDeep` under `absentReads`, which wraps a struct field with `Schema.withDecodingDefaultKey`, at any depth, in the entity read schemas and the aggregate's `decodeSchema`. A default decodes through the field, so each read gets its own set. The wrap goes by the stored side alone (`absentStored`), and nothing is decoded to place it. A `.check()` refusing the value is met by the write that would leave the attribute out: `absentReading` is `undefined` for it, `rowCanLack` is false, and clearing it is refused; a row without it fails that check when read. A step that throws on the absent value kills the decode; only then is the field looked for (`missingKeyOnDefect`: the one the row lacks whose reading of the absence dies), and the read fails on the missing key, as 1.39.0's did, on every read of an entity row (`get`, queries and scans, versions, history, `deleted.get`, `deleted.list`, stream images). Any other defect is left a defect. A lenient union member can't take a later member's row, because each member is tried strictly first; a `oneOf` union stays as declared, since a lenient copy would make two members match. What the walk can't enter, a declaration, a `Schema.suspend` or a transformation, goes to `readingStored`, which makes the same reading on the AST (`readingUnwalked`, `readingMarshalled`): a struct field gets the same default, a declaration's value reads `undefined` as the set it stands for (`readingAbsentParameter`, as an `Option.some` of an empty set is stored with no `value`), and a union tries its members as declared first (`tryingDeclaredFirst`), with a `oneOf` one whole. Only the stored side reads absent: a transformation's type side holds what the transformation made, and nothing was left out of that. An event, its metadata, a snapshot state and an outbox effect read through `readingStreamValues`, the same walk with nothing else substituted except dates (see **Dates on a stream**): the marshaller would otherwise turn an empty set in an event from a failed write into a stream that can't be read. It follows the stored side: a set stored as a list stores its empty list, and a `Schema.HashSet` can't be stored at all, empty or not.

The places the rule can't reach: a list element can't be absent without moving the elements after it, so an empty set in a list or a tuple is refused. A record entry holding an empty set loses its key. `UndefinedOr(ReadonlySet)`: absent can mean only one thing, `undefined`, so an empty set reads back `undefined`. A `.select()` is raw, so absent stays absent. In expressions, `eq` / `ne` with an empty set compile to `attribute_not_exists` / `attribute_exists`, and any other comparison with one is refused (`emptyPartProblem`).

**A caller's value is never a defect.** Whatever the marshaller still refuses (an empty set in a list, `NaN`, `Infinity`, past `MAX_SAFE_INTEGER`, a set it has no form for) throws `UnstorableValue`, with the path to the deepest part refused, and a write path turns that into a `ValidationError` naming the field (`marshalOrFail`, the counterpart of `composeKeysOrFail`), a stored attribute under its field's name. Anything else thrown stays a defect. It's found where it costs nothing: a plain `put` finds out at its one marshal, and only a path that sends something first looks ahead (`unstorableIn`, the marshaller on the values at hand): a `put` that reads, hydrates or embeds first, `upsert`, a time-series `append`, and every update operand including `.withVector` (`unstorableOperand`). That marshals an update's operands one more time. Comparison operands are judged with the rest of a condition (`emptyPartProblem`), and a vector `.filter` when it's compiled. A packed field has its own form and is left out. A `NaN` feeding a key is key composition's to refuse first, for `EDD-9096`; with `escapeKeys` off it has key text, or it may feed a half nothing composes, so what's left is refused once keys are composed (`refuseUncomposed`). The builders in `Expression.ts` are plain functions and throw it at the call. Event data, metadata, snapshot states and outbox effects pass the same marshal, as does a tombstone's kept fields.

**`undefined` in a list.** `marshall` drops it, closing the list up. In a tuple that moves the values after it or empties a required position, so the row reads back wrong or not at all, and nobody can depend on it: the write schemas (`enforceChecks`) and `writingTuplePositions`, for what the library stores without deriving (events, metadata, snapshot states, outbox effects), refuse a position holding `undefined` unless no value follows it in an optional position, or its encoded side can't hold one (an `undefined` encoding to something else has a stored form). Reads don't, so stored rows read as they did. The check sits on the Type side, because `encodingChecks` has no public constructor, so a position only its encoding makes `undefined` isn't seen. A `Schema.Array` and the rest of a `TupleWithRest` are left closing up: a put and a read of them both work, so a caller can rely on it, and refusing would need a walk of every item on every write. Pinned by a test, documented, and the owner's call.

**Relative updates aren't checked against the model.** `.set` is judged before it's sent. `.add`, `.subtract`, `.append`, `.deleteFromSet` and path operations compute from a value only DynamoDB holds, and reading it first would cost every update, so a `.check()` they break isn't seen until the row comes back. `appliedUpdate` wraps every decode after a landed write (`updateResult`, and the row a cascade reads), so the `ValidationError` says the update WAS applied, that the stored row no longer matches the model, and which field (`decodeProblem`). `allOld` / `updatedOld` report that the row it replaced doesn't match. Guard with `.condition()`. `.returnValues("none")` and a transaction return no row, so nothing reports it.

**Guarded read-then-write (#133).** Updates that read first (a unique-field
change, a computed change to an index composite, every retain update) write a
guarded `Update` of only the attributes that changed, conditioned on what they
read. A concurrent change to an unrelated attribute is preserved. A race on an
input fails without writing: `OptimisticLockError` (with the real
`actualVersion`) on a versioned entity, `ConcurrentModification` (naming the
changed `attributes`, with `current`) on an unversioned one. Soft delete, and a
hard delete of an entity with unique constraints or `retain`, are guarded the
same way: by version, or for an unversioned entity by a condition over every
attribute read. `restore` fails with `ItemNotFound` when the tombstone is gone (a
concurrent restore won) and `ItemNotDeleted` when a live item already exists.

**Wide items.** Guards are sized against DynamoDB's real limits on one
expression (`EXPRESSION_MAX_LENGTH` 4,096 characters, `EXPRESSION_MAX_OPERATORS`
300 operators and functions, `IN_MAX_OPERANDS` 100; `internal/ExpressionLimits.ts`),
computed on the actual condition, including the caller's `.condition()`
(`expressionFits`, a strategy that picks a request that fits and refuses nothing). An unversioned delete is never refused for
width: when the full guard does not fit, `deleteGuard` falls back to the
strongest guard that fits. That is `attribute_exists(pk)`, then `updatedAt`
unchanged (with timestamps), then as many attributes as fit, unique-constraint
fields first, then the model's fields, then the rest. With timestamps, every
library write changes `updatedAt`, so any concurrent library update is detected
except one in the same millisecond with an identical `updatedAt`. A writer
outside the library that leaves `updatedAt` alone can change unguarded
attributes undetected. Without timestamps only the guarded attributes are
protected. An update too wide for one expression writes the whole item, under
the version condition (versioned) or the same fallback guard (unversioned). A
concurrent write from outside the library to an attribute the guard does not
cover is lost, as 1.22.0 lost it for every such update. A caller's
`.condition()` too large to fit beside the guard is sent as built (#144): DynamoDB
rejects it, and the diagnosis (`ExpressionTooLarge`) is a `ValidationError` stating the
expression's size and the caller's share.

Operators are counted as DynamoDB counts them (`countOperators`, measured
against DynamoDB). In a condition: each comparison (`=`, `<>`, `<`, `<=`, `>`,
`>=`), `AND` / `OR` / `NOT`, `IN`, and each function; `BETWEEN` counts once,
because its own `AND` is part of it. In an update expression: each `+` / `-`
and each function (`if_not_exists`, `list_append`); a `SET` clause's `=` is not
an operator.

**Pre-versioning items.** An item written before the entity was `versioned` has
no version attribute. It reads as version 0 on every path, and
`expectedVersion(0)` addresses it. The first versioned write conditions on
`attribute_not_exists(version)` (plus the incarnation token, which it adds) and
writes version 1; the retain snapshot is `v#0000000`. A race on that first
write is an `OptimisticLockError`. Soft delete and restore handle it too.

**Items whose version was removed.** A versioned entity stamps the incarnation
token when it creates an item, so only a pre-versioning item may lack a version,
and it lacks the token too. An item with the token and no version had its
version removed outside the library. Reading it as version 0 would let the next
update rewrite its history, so `versionCorruption` refuses it with a
`ValidationError`: on every decode (`get`, queries, the `deleted` views,
`decodeMarshalledItem`), so a query over a partition holding one fails as a
whole; on the read of every read-then-write path (updates, soft delete,
hard delete with unique constraints or `retain`, `restore`, versioned `put`
other than `create`,
read-first `upsert`, transaction puts); and on a plain update and a plain
`upsert`, through a
`attribute_exists(version) OR attribute_not_exists(__edd_i__)` condition with
`ALL_OLD` on failure. A plain hard delete (no unique constraints, no `retain`)
deliberately doesn't check: it reads nothing and writes no history, so it is the
safe way to remove such an item; `purge` removes it on any entity.

**Version history is never overwritten.** Every `v#N` snapshot `Put`
(`snapshotPut`) is conditioned on `attribute_not_exists(pk)` OR the existing
row holding the same version, incarnation token and (with timestamps)
`updatedAt`.
Rewriting the same state is legitimate: a retain `put` writes
`v#0000001` and the first update snapshots that same version-1 state again, and
a restore rewrites the delete-time snapshot. Any other row is a different
history, so the update, soft or hard delete, restore or replacing `put` fails with a
`ValidationError` (`historyConflict`) and the write is not made. A new item's snapshot
(`v#0000001`, or the version after the history retained at its key) carries a
fresh incarnation token, so in effect it requires the row to be missing; one
already there means the read missed retained history, and the put is planned
again. Caveat: a write from outside the library that
changes an item without bumping its version can be captured into the next
`v#N` snapshot, because the snapshot copies the item read.

**Decoding defaults.** Read schemas keep `withDecodingDefault`, so a `put` that
omits a defaulted field returns and reads back the default (it used to write the
item and then fail with a `ValidationError`). A defaulted self date is stored as
an ISO string. A defaulted primary-key or index composite that a write omits is
stored with its default, and keys are composed from it; other defaulted fields
are not stored. A default never creates a unique sentinel: see §5 Unique
Constraints for `__edd_d__` and `.remove()` of a defaulted index composite.

**Error mapping.** Failed conditions ask DynamoDB for `ALL_OLD` and classify by
the stored item. A newer stored version is `OptimisticLockError` with the real
`actualVersion`; the same version is the user's `.condition()`, so
`ConditionalCheckFailed`; no item is `ItemNotFound`. That holds on every update
path. Before, three paths had it the other way round:

- a plain versioned update with `expectedVersion` + `.condition()` reported a
  failed condition as `OptimisticLockError(-1)`;
- a retain record update with `.condition()` did the same;
- a retain path update with `.condition()` reported a lost version race as
  `ConditionalCheckFailed`.

A versioned update of a missing item with `expectedVersion` also gave
`OptimisticLockError(-1)`. `patch()` keeps its contract: a missing item is
`ConditionalCheckFailed`.

**Incarnation token.** A version alone cannot tell an item from one deleted and
recreated at the same version. Versioned entities carry `__edd_i__`
(`INCARNATION_TOKEN`), a random UUID stamped on create (put, create, upsert,
batch / transaction put) and backfilled on the next guarded write. Every
version-checked write also checks the token (`incarnationGuard`;
`attribute_not_exists` for an item that has none yet). It is stripped from
decoded models and appears only in `asNative` / raw items.

**Return values.** `returnValues` is honoured on every update path: `"none"` →
`undefined`; `"updatedOld"` / `"updatedNew"` → only the top-level attributes
the update wrote, decoded as a partial; `"allOld"` / `"allNew"` → the whole
item. The type follows the mode (`UpdateReturn<A, M>`); repeated
`Entity.returnValues` calls are typed by the last one (`UpdateBase`). A retain
update returns exactly the item it wrote even if another writer replaced it
since. When that cannot be proven from a snapshot it fails with
`UpdateAppliedButUnreadable` (the write was applied; do not retry). `allOld`
returns the replaced item; the record retain / unique branch used to return the
new one. A cascade with `allOld` / `updatedOld` cascades exactly what the update
wrote, which needs both images; with path operations on an unversioned entity
that combination is refused.

**Missing items and refusals.** `update()` of a missing item no longer leaves an
undecodable partial row. A plain update always requires the item to exist. When
it is missing and the update is a plain `.set()` of a complete item (every
required field and primary-key composite, where a field with a decoding default
is not required) with no other operation, `expectedVersion`, `.condition()`,
cascade, `withVector` or old-image return mode, the library creates it through
`create` with the same payload (`MissingForCreate` → `updateOrCreate`), so the
item is exactly what `put` writes. If another writer creates it in between, the
update re-runs once on that item. Anything else fails with `ItemNotFound` and
writes nothing, as do retain entities and updates that read first. `.set()` of a changed primary-key composite is refused (it was silently
ignored). An immutable field may be restated with its stored value (spread
records), while a different value is refused.

**Guarded puts.** A `put` of a versioned or unique-constrained entity is planned
from a consistent read of the item (`planPut`), and written by `runGuardedPut`.
Over an existing item it continues that item: the next version, the same
incarnation token, the stored `createdAt` (unless the input supplies one — on
unique-only entities too), a retain snapshot of the replaced item at its version,
and sentinel rotation (a changed value takes the new sentinel and releases the
old one; an unchanged value is left alone). It never resets to version 1 or
orphans a sentinel. The main `Put` is guarded by `attribute_not_exists(pk)` when
the item was missing, and otherwise by `deleteGuard` over what was read (version
and incarnation when versioned, the unique attributes otherwise), with
`ReturnValuesOnConditionCheckFailure: ALL_OLD`. A soft-deleted item counts as
missing, since its tombstone has a different sort key. Entities with neither
feature keep the single `PutItem`, with no read.

A put replaces the whole item, so a lost race is retried rather than reported:
a concurrent create, replace or delete of the item between the read and the
write cancels it, and it is planned again from a fresh read — the last writer
wins, as with a plain `PutItem` (`GUARDED_PUT_ATTEMPTS` = 3; a race lost on every
attempt is an `OptimisticLockError` when versioned, else `ConcurrentModification`).
A `.condition()` failure is `ConditionalCheckFailed`, a taken unique value
`UniqueConstraintViolation`, a replaced item whose `v#N` snapshot holds other
history a `ValidationError`. `create` does not read: the item must be missing,
so its `Put` is guarded by `attribute_not_exists(pk)` and carries a fresh
incarnation; an existing item is `ConditionalCheckFailed`. A retain `create`
runs only the one `Limit: 1` history query below.

**Re-creating a deleted retain item.** A deleted (or soft-deleted) retain item's
`v#N` snapshots outlive it, and its final state is one of them: a hard delete,
like a soft delete, reads the item and snapshots it at its own version in the
same transaction as the `Delete` (guarded on the version and incarnation read,
under the `snapshotPut` guard). Without that snapshot an item deleted at `vN`
(N ≥ 2) had history only up to `v(N−1)`, came back at exactly `vN`, and a writer
still holding `vN` could overwrite the new incarnation. A retain hard delete
therefore costs a `GetItem` and a two-item `TransactWriteItems`, not one
`DeleteItem`; deleting a missing retain item writes nothing (with a
`.condition()`, a `DeleteItem` conditioned on `attribute_not_exists(pk)` and the
condition, so the condition is judged against no item and an item created since
the read is never removed unsnapshotted). A delete that reads first — retain,
unique or soft — with no `.condition()` is retried from a fresh read when it
loses a race (the item changed, was deleted — `DeletedConcurrently` — or a
sentinel it releases changed hands), up to `GUARDED_PUT_ATTEMPTS`, as a put is:
the caller asserted nothing the race could break, and the guard still keeps a
concurrent write out of the snapshot or tombstone. A retry that finds the item
gone reports what a delete of a missing item does: nothing for retain only,
`ItemNotFound` with unique constraints or soft delete. `deleteIfExists`'s
`attribute_exists(pk)` (`assertsExistenceOnly`) is already implied by these
guards, so it is judged against the read — a missing item is
`ConditionalCheckFailed` — and retried like an unconditioned delete. With any
other `.condition()`, the read is what the condition was judged against, and the
race fails. Every delete path returns, under `returnValues("allOld")`, the item
it removed: the one read (the delete is guarded on it), or `ALL_OLD` from a
plain `DeleteItem`. A put, `create`, `upsert` or transaction put of a
missing retain item reads the highest version retained for its key (a `Query` on
the `v#` prefix, reversed, `Limit: 1`) and continues after it: the new item takes
that version + 1, a new incarnation token, and its snapshot at that version.
History is never overwritten, and the key is reusable without `purge`. If
snapshots appear between the read and the write, the snapshot guard cancels the
write and it is planned again. `restore` of a tombstone while a live item exists
at the key is refused with `ItemNotDeleted`; once that item is deleted too,
`restore` brings back the latest tombstone.

**Sentinel ownership.** A sentinel names the item that reserved it
(`_entity_pk` / `_entity_sk`). An item can hold a unique value without owning its
sentinel: the constraint was added after the item was written, the item was
written outside the library, or a `ttl`'d reservation expired and another item
claimed the value. Releasing that sentinel by key would delete the other item's
reservation and let the value be taken twice. So every path that releases a
sentinel — a replacing put, an update or upsert that changes the value, a hard or
soft delete, `purge`, a transaction put — first reads it consistently
(`ownedSentinels`) and releases only those this item owns, each with a `Delete`
conditioned on `_entity_pk` / `_entity_sk` still naming it (`sentinelRelease`). A
release cancelled because the reservation changed hands in between is planned
again from a fresh read by a put, an `upsert` and a transaction put (bounded by
the same attempts), and is a `ConcurrentModification` on the unique fields from
an update or a delete with a `.condition()` (an unconditioned delete is retried
too). (`releaseRaced` marks those errors, `releaseRaces`, so
`guardedUpsert` can tell them from a change of the item itself, which fails an
upsert as it fails an update.) Each sentinel a write would release costs one consistent
`GetItem` (projecting only `_entity_pk` / `_entity_sk`). `purge` releases them
one by one with a conditional `DeleteItem`, since a batch delete cannot carry
the condition, collects them from the live item and every tombstone, and skips
a release whose reservation changed hands in between. It then batch-deletes the
item's rows in `BatchWriteItem` chunks of 25 (by count alone: 25 stored keys can't
reach the 16 MB request limit), resending `UnprocessedItems` with
`Batch.write`'s backoff (5 retries); when they run out it fails with a
`DynamoError` stating how many rows remain and exactly how many it had deleted
(#144). A sentinel an update
writes for a changed value carries its constraint's `ttl`, as a put's does.

**`upsert` that reads first.** One `UpdateItem` cannot write, rotate or check a
sentinel, snapshot the replaced item, or tell whether to store a default or keep
the stored value. So an entity with `unique` constraints or `versioned: { retain:
true }`, an input that omits a defaulted index composite, or an input clearing a
secondary index composite, takes
`guardedUpsert`: it validates the whole input (required fields included) and
reads the item once. Missing: `create`, sentinels guarded by
`attribute_not_exists`, the retain snapshot written, omitted defaults stored.
Present: an update of the upserted fields (primary-key composites, immutable
fields, `createdAt` and the version dropped, so they keep their stored values,
as do fields the input omits or leaves unset) from that same read, with sentinels rotated for
changed values only and the replaced item snapshotted, under the update's
version / incarnation guard (versioned) or attribute guard (unversioned). A
concurrent create or delete between the read and the write is retried the other
way, and a sentinel release that raced is planned again from a fresh read
(`GUARDED_PUT_ATTEMPTS` in all); a race lost on every attempt is an
`OptimisticLockError` / `ConcurrentModification`, never a
`ConditionalCheckFailed` the caller didn't ask for, and every error names the
`upsert`. Other entities keep the single `if_not_exists` `UpdateItem`.

**An `undefined` in an upsert's input means the same on either path.** The answer goes by what the input encodes to:

| The field, given `undefined` | What the upsert does | Read first? |
|---|---|---|
| Merely optional (`Schema.optional`): left unset | Keeps the attribute and any key holding it | Only if another reason says so |
| `undefined` is a value with no stored form (`Schema.UndefinedOr`): a clear | Removes the attribute | Only if a secondary index holds it |
| `undefined` is a value with a stored form (a transform writing `"none"`) | Writes that | Only if another reason says so |
| A default no key holds | Writes the default | Only if another reason says so |
| A defaulted index composite: omitted, as `omitsIndexedDefault` reads it | Keeps what the row holds; on a new row, the default | Yes |

An empty set follows the second row. **Clearing a secondary index composite reads first**, because what's left of a half depends on the row, and the result is what `.set(...).remove([...])` leaves: `[owner, und]` given `und: undefined` truncates to `owner_o1`, and `[und]` loses the half under `'sparse'` and `'preserve'` alike, a clear being the cascade override. Without it the key would outlive its value. A primary composite, an immutable field, and a date the library stamps aren't cleared this way, so those stay one write. So does a clear no key holds. This read happens only when the input clears a composite: no other upsert pays for it.

**Transaction puts.** `transactWrite` and `EventStore.append`'s
`additionalItems` plan a put of a versioned or unique-constrained entity with
the same `planPut` (`Entity._planPut`), so it creates or replaces exactly as the
entity's own `put`: it reads the item, guards the `Put` on what it read,
continues a replaced item's version, incarnation and `createdAt`, snapshots it,
rotates its sentinels (releasing only owned ones) and continues a re-created
retain item past its history. Each guarded put's items carry `"guarded"`
provenance and are judged by `judgeCancellation`: a taken unique value
(`UniqueConstraintViolation`) or a history conflict (`ValidationError`) is
final; the caller's own condition is `TransactionCancelled` from
`transactWrite` and `AdditionalItemConditionFailed` from `append` — never
reported for an op the caller set no condition on; a race with the read cancels
the transaction, which is built and written again
(`GUARDED_TRANSACTION_ATTEMPTS` = 3, then `OptimisticLockError` /
`ConcurrentModification`).

**One op per item** is DynamoDB's rule, not pre-checked (#144): DynamoDB rejects
a transaction that names one item twice, and the rejection is diagnosed against
the compiled transaction. Every compiled item carries a target — its table and
primary key, and the caller op it came from (`BuiltTransactWriteItems.targets`,
a thunk built only on failure) — including the sentinels and snapshots a
guarded put adds, so two puts that swap unique values (releasing and reserving
the same sentinels) are named too; `append` adds targets for its contiguity
check, event puts, idempotency sentinel and inline snapshot. A repeat is a
`ValidationError` naming the entity and both sources. Because DynamoDB can
report a repeat as a conditional failure (`[None, ConditionalCheckFailed]` on
DynamoDB Local, which applies the operations in order), the repeat is
diagnosed **before** the conditional mapping, and any cancellation of a
request that repeats an item is read as the repeat: never as a lost race,
never retried. **Size and count are not checked before
sending** either: a transaction over 100 items or 4 MB, or holding an item
over 400 KB or a key over its size limit, is sent, rejected whole by
DynamoDB, and diagnosed from that rejection by the same targets — see
[Write Limits](#write-limits-and-request-rules--diagnosed-not-pre-checked-144). Deletes of `unique` / retain / `softDelete`
entities, and updates, are planned by `Transaction.transactWrite` from the
entity's own op (`Entity._planUpdate` / `_planDelete`): the op runs with its
write recorded instead of sent (`internal/TransactPlan.planWrite`), and its
items join the transaction as a guarded write, read by the same verdict
contract as a guarded put. `EventStore.append` plans none, and still refuses
those deletes (EDD-9048). Every op is checked and composed before any op reads
(`prepareTransactWriteOps`): what an op can't carry, a put's item, a delete's,
a check's or a planned op's key, what an update decides from its own operands
(its payload, and the keys the payload composes: `Entity._prepareUpdate`, which
its plan reuses) and a nested stream append are refused or built first, and
reused, so a value a schema refuses, one that reads back otherwise, a key with
no text or an append op with no events fails the transaction with nothing read,
wherever the op sits in it. An update whose payload hydrates refs has those
keys checked after the reads that hydrate them, as on its own.

**`Batch.write` of a `versioned` entity.** A `PutRequest` would reset an
existing item to version 1 under a new incarnation. So `Batch.write` sends these
puts first, before any other request, as create-only `TransactWriteItems` Puts
(`attribute_not_exists(pk)`) in chunks of up to 100 items, at most 4,194,304
bytes and at most 16,777,216 bytes of request body — DynamoDB's own limits,
exactly — each item measured by `transactItemBytes` (the item, plus the
create-only condition and the attribute name it substitutes) and the body by
`jsonBytes` (the JSON the SDK sends, with its `ClientRequestToken` and, when
capacity reporting is on, `ReturnConsumedCapacity`). Should DynamoDB still reject a chunk for its size, the batch fails
with a `ValidationError` giving both the library's measure and DynamoDB's
reported size, and saying exactly what was already written; the chunk is not
re-split or retried. There
is no read, and so no window between a check and the write. A batch that
touches a versioned put's item more than once — a delete and a put, or two
puts — is refused before anything is sent: the put runs in its own
transaction, so the order couldn't be kept (and two puts of one item in one
transaction would be misreported as a replace). Each chunk is atomic: a put that would
replace an existing item cancels it, nothing in the chunk is written, and the
batch fails with a `ValidationError` without sending later chunks or the plain
requests. The message says exactly what earlier chunks wrote; `Batch.write` was
never atomic across chunks. A cancellation whose reasons are only
`TransactionConflict` / throttling is retried with the batch's `maxRetries` /
`baseDelayMs` backoff, and any other cancellation is a `DynamoError`. Each
chunk costs twice the write capacity of a batch write. Puts of other entities,
and deletes, stay plain `BatchWriteItem` requests. (`unique` and retain
entities are still refused by EDD-9049.)

**`Batch.write`'s request size.** A `BatchWriteItem` holds up to 25 requests and
16 MB of request body. The body is the JSON text the SDK sends, which is larger
than the items: a control character is 1 byte in an item and 6 as JSON (`\u0000`),
`"` and `\` are 2, and `B` values are base64. So 25 items within 400 KB each can
pass 16 MB. DynamoDB Local accepts a body of exactly 16,777,216 bytes and refuses
16,777,217 with HTTP 413, on every operation (AWS documents 16 MB for
`BatchWriteItem`; its exact measure is unverified). `Batch.write` splits its plain
requests and its versioned-put transactions with one greedy packer
(`internal/ItemSize.ts` `packRequests`), which an aggregate's `rekey` uses for its
waves too: a request takes the next unit (one write request, or one transaction's
actions, a `rekey` move's Put and Delete together) while every limit holds, and a
unit over a limit by itself goes alone. A batch within all limits splits exactly as
it did by count alone, so its requests are byte-identical.

**Known limitations** (inherent):

- On unversioned entities, nothing can prove an unguarded attribute unchanged.
  So the item a unique-field update returns may show stale values for
  attributes it neither reads nor writes, wide items use the fallback guard,
  and the wide-update whole-item write can overwrite outside writers.
- A plain `.expectedVersion(n)` cannot detect a delete-and-recreate that has
  climbed back to version `n` on an entity without `retain` (its versions
  restart at 1, so it takes `n − 1` updates; a retain item continues after its
  retained history).

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
| Put — new item | Entity item + sentinel per unique field whose composites are all set (`condition: attribute_not_exists(pk)`) |
| Put — over an existing item | Entity item (guarded by what was read) + for each changed value, release old sentinel + put new sentinel |
| Update — composites unchanged | Entity item only (no sentinel ops) |
| Update — undefined → defined | Entity item + put new sentinel |
| Update — defined → undefined | Entity item + release old sentinel |
| Update — defined → defined (changed) | Entity item + release old sentinel + put new sentinel |
| Delete | Entity item + release sentinel per unique field whose composites were set |

A release is a `Delete` conditioned on the sentinel still naming this item
(`_entity_pk` / `_entity_sk`), emitted only for a sentinel this item owns — see
"Sentinel ownership" under §10 Fluent bound-CRUD builders.

#### Optimistic Concurrency

When `versioned` is enabled, updates can include an expected version:

```typescript
db.Users.update(key, changes, { expectedVersion: 5 })
// Adds ConditionExpression: version = :expected
// Fails with OptimisticLockError if version doesn't match
```

#### Write Limits and Request Rules — Diagnosed, Not Pre-checked (#144)

Full design: [`docs/designs/eventstore-event-metadata.md`](docs/designs/eventstore-event-metadata.md) §6 and §6A.
**Library-wide rule: a limit or request rule DynamoDB enforces itself is never checked
before sending.** That covers 400 KB per item, 100 items and 4 MB per transaction, 16 MB
per request body, 2048
bytes per partition key and 1024 bytes per sort key, one operation per item (transactions
and batch requests, `BatchGetItem` included), 4,096 characters / 300 operators per
expression and 100 operands per `IN`, an `IN ()` with no operands (an `isIn` with no
values), empty key values (a write's, or a query's key bound), a `BETWEEN` whose lower
bound sorts after its upper bound, a consistent read of a GSI (an aggregate's assembly
read included), a table's vector-index limits (dimensions in 1..4096, 18 inline filters
per index, vector indexes per table) and a vector search's `TopK` (1..100). DynamoDB rejects an over-limit request whole, so a pre-check adds no safety; it only
costs every passing write a sizing pass, and mirrors DynamoDB's approximate item-size
rules imperfectly. What the library adds is **attribution**, needed only once the write
has failed: DynamoDB's message names neither the item nor which of a transaction's items
is at fault, and the library built the request.

Every site wraps its DynamoDB call with `diagnoseFailure`
(`internal/WriteDiagnosis.ts`, the one module holding the logic, for writes, reads and
table management), placed after the site's own conditional-failure mapping — except a
**repeated item**, which a site whose mapping reads conditional failures (and may retry
them) diagnoses *before* it (`only: ["RepeatedItem"]`): DynamoDB can report a repeat as a
conditional failure, which would read as a lost race. On failure only, it:

1. **Recognises** the rejection by a stable message fragment: a request-wide
   `ValidationException` (`DynamoValidationError`) or `LimitExceededException`, or a
   `TransactionCanceledException` whose positional reason carries
   `Code: "ValidationError"` (or, for a request that repeats an item, any reason). A
   request body over its limit is recognised by HTTP 413 (DynamoDB Local refuses it
   before parsing, with no message) or a request-size message.
2. **Confirms** it by measuring the request that was sent (`internal/ItemSize.ts`).
   Exact measures confirm only when over the limit: an item count over 100, a key's
   UTF-8 bytes over its limit — 2048 for a partition key, 1024 for a sort key, measured on
   the table's and the indexes' key attributes the request writes (DynamoDB Local's "Size
   limit exceeded" and "Hash primary key values must be under 2048 bytes, and range
   primary key values must be under 1024 bytes" are confirmed against both kinds; AWS's
   "Aggregated size of all range keys …" against sort keys and "Size of hashkey has
   exceeded …" — unverified — against partition keys), two entries naming one item, an
   expression's length, operators or `IN` operands over the limit, an `IN ()` in the
   condition or filter DynamoDB named, an empty value written to (or compared with) the
   key attribute DynamoDB named, a `BETWEEN` out of DynamoDB's UTF-8 order, a consistent
   read naming an index, a vector index with dimensions outside 1..4096 or over 18 inline
   filters, a `CreateTable` with more vector indexes than DynamoDB stated (else 5), a
   search whose `TopK` is not an integer in 1..100, or a write's request body over
   16,777,216 bytes as JSON (`jsonBytes`, matching the SDK's body byte for byte), measured
   on the request as sent: the input the client received, `ReturnConsumedCapacity`
   included, which `Capacity`'s instrumented client records when a request fails
   (`internal/SentRequest.ts`) and `diagnoseFailure` carries in `SentWrite.input`. A 413
   whose measured body is within the limit passes through. For item size and
   transaction payload, which DynamoDB itself counts approximately, the recognised message
   is the evidence and the request must hold something it can apply to (a `Put` / `Update`,
   a transaction); the measurement attributes.
3. **Attributes** it to the culprit using the targets the site built (thunks, built only
   on failure): the entity and key, or for `EventStore` the event (`the event at
   version 4`), the inline snapshot, the idempotency sentinel or the additional item
   (`operation 2 (User)`). A request-wide oversized-item rejection is attributed to the
   `Put` over 409,600 bytes by the exact size model, or else the largest `Put`, named as
   the *likely* culprit; a 4 MB rejection names the three largest items (a `retain` put
   counts twice: its item and its snapshot) alongside DynamoDB's reported `Payload Size`;
   a request-body rejection names the three largest items by their JSON bytes.
4. **Rewrites** a confirmed diagnosis into the site's existing tagged error, with
   DynamoDB's error kept as the cause, or **passes through** anything unrecognised or
   unconfirmed unchanged, as the bare `DynamoValidationError` / `DynamoError` it was.

| Site | Count over 100 | Item size, 4 MB, 16 MB body, key size |
|------|----------------|---------------------------|
| `Entity` single-item writes (`PutItem` / `UpdateItem` / `DeleteItem`) | — | `ValidationError` |
| `Entity` transactional writes (guarded put, retain/unique update, retain/soft delete, `restore`) | `TransactionOverflow` | `ValidationError` |
| `Entity` transactional cascade | `CascadePartialFailure` (`succeeded: 0`) | `CascadePartialFailure` |
| `Transaction.transactWrite` / `transactGet` | `DynamoError` (same message as before) | `ValidationError` |
| `Batch.write` (versioned-put transactions and `BatchWriteItem`) | — | `ValidationError`; the message says exactly what the batch had already written (its versioned-put transactions, its non-versioned requests) and what was not sent |
| `Aggregate` create / update (one transaction per group) | `AggregateTransactionOverflow` | `ValidationError` |
| `EventStore.append` / `commandHandler` | `AppendTooLarge` (expanded `count`) | `ValidationError`; a stream-index key: `operation: "EventStore.append.indexes"` |
| `EventStore` snapshot `PutItem` | — | `ValidationError` naming the snapshot |

The request rules map to the same sites' errors: a repeated item is a `ValidationError`
(`transactGet`: `DynamoError`; `Batch.write`: saying exactly what the batch had already written); an
expression over its limits is a `ValidationError` naming the caller's share of it; an
empty key is a `ValidationError` (a stream-index key: `operation:
"EventStore.append.indexes"`); an `isIn` with no values is a `ValidationError` naming
it; a read's rejection is a `ValidationError` (`operation: "query.consistentRead"`;
`"query.filter"` for an `IN ()`; for a key bound, `"query"` named by the accessor —
`User.byTenant`, `collection "assignments"` — or `"EventStore.readIndex"` for
`readIndex`); an aggregate's assembly read rejected for a consistent read of a GSI is a
`ValidationError` (`"<op>.consistentRead"`) naming the aggregate and index, or for
`delete`, whose union has no `ValidationError`, DynamoDB's own `DynamoValidationError`,
explained; a `BatchGetItem` repeating a key (`Batch.get`) is a `DynamoError` naming both
positions; a vector-index rejection keeps DynamoDB's tag (`DynamoValidationError` /
`DynamoError`), its message naming the index and the entities sharing it; a search's
`TopK` is a `ValidationError` (`operation: "vectorSearch.<index>.topK"`).
`Aggregate` names the groups already committed (`AggregateTransactionOverflow.committed`
and its `message`, or the `ValidationError`'s text), since each group is its own
transaction; a failed `create` says the root may be committed, so a retried create fails
its root guard: update or delete the partial aggregate.

An eventual cascade's per-item diagnosed `ValidationError` lands in
`CascadePartialFailure.errors`, as any per-item failure does. `Aggregate` delete's
`BatchWriteItem` of stored keys is not wrapped: deleting keys that were stored cannot meet
these limits (25 keys are at most about 0.5 MB as JSON), and its error union has no
`ValidationError` to carry a diagnosis.

A diagnosed `ValidationError` / `DynamoError` sets `cause` to an `Error` whose message is
the explanation and whose own `cause` is DynamoDB's error; `AppendTooLarge`,
`TransactionOverflow` and `AggregateTransactionOverflow` carry DynamoDB's error in an
optional `cause`. No public error union widens. A diagnosed error is terminal: guarded-write
retry loops do not retry it, and `EventStore`'s `sendAppendTransaction` still treats only
`ConditionalCheckFailed` reasons as conflicts. Nothing is measured on success.

**What stays a pre-check** (design §6A.8): only what DynamoDB cannot see, or would accept
with another meaning — the library's own invariants (option shapes and lengths; a
stream-index `key` result that is not a string; `readIndex`'s one-of and string bounds and
its `limit`; empty condition parts under `or` / `not` and an `or()` with no parts; a vector
index's non-integer `dimensions` (`[EDD-9070]`: DynamoDB reads integers leniently, so it
could accept another, immutable dimensionality); a versioned put's item touched again in `Batch.write`;
the aggregate sort-key collision check), configuration and definition checks (EDD-90xx,
including `[EDD-9069]` and `[EDD-9063]`), and strategies that measure to choose, refusing
nothing (`expressionFits`; `Batch.write`'s chunking at 25 / 100 items, exactly
4,194,304 bytes and exactly 16,777,216 bytes of request body, as `rekey` packs its
waves). A caller's own request (`transactWrite`, `append`, an aggregate's group) is never
split or pre-checked against the request limit; it is sent and diagnosed. "It prevents a partial multi-request write" is not a reason to keep a
pre-check: `Aggregate` groups and `Batch` chunks were never atomic, and the diagnosis says
exactly what was already written.

**Trade-offs.** A rejected write now costs a round trip. AWS wording may differ from
DynamoDB Local's; a missed wording degrades to pass-through, never to a wrong diagnosis,
because exact measures must confirm.

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
DynamoClient.layerConfig({ region: Config.String("AWS_REGION") })
MainTable.layerConfig({ name: Config.String("TABLE_NAME") })

// Passed to the SDK client. No defaults here, and no platform handler imported.
DynamoClient.layer({
  region: "us-east-1",
  requestHandler: { connectionTimeout: 1_000, socketTimeout: 5_000 },
  maxAttempts: 2,
})
DynamoClient.layerConfig({
  region: Config.String("AWS_REGION"),
  requestHandler: { socketTimeout: Config.Int("DYNAMODB_SOCKET_TIMEOUT_MS") },
  maxAttempts: Config.Int("DYNAMODB_MAX_ATTEMPTS"),
})
```

**Options passed to the SDK (#190).** `requestHandler` is a handler or the options of the runtime's handler: the SDK's build for the runtime constructs its own from a plain object (`NodeHttpHandler` on Node and Bun, `FetchHttpHandler` in browsers and Workers). The type excludes the SDK's `Record<string, unknown>` arm, under which a misspelt `socketTimout` would compile and leave the call with no timeout. In `layerConfig`, `maxAttempts` and the four handler scalars (`connectionTimeout`, `socketTimeout`, `requestTimeout`, `throwOnRequestTimeout`) are read per field through `Config`, because an operator tunes them per environment: a missing one stays unset, and a malformed one is a `ConfigError`. A handler instance holds code (agents, a logger), so it is passed as itself, as `compressors` is. A handler passed in is destroyed with the layer.

**Interruption ends the request (#190).** Every `send` passes `Effect.tryPromise`'s signal as `abortSignal` (guarded by `test/abort-signal-guard.test.ts`, which fails on a `.send(` without one). An interrupted fiber's request closes its connection and the SDK makes no further attempt: `AbortError` isn't retried, and a retry waiting out its backoff finds the signal aborted and sends nothing. The fiber has never waited for the promise, before or after this. It ends the wait, not the request: a write already sent may still be applied, and the caller settles that with a conditional write or an idempotency token. An interrupted request counts once in consumed capacity, under `unreportedRequests`.

A timeout from the handler and an `AbortError` both classify as `DynamoError` with the SDK's error as `cause`, through `redactCredentialRefusal` like any other. The feed's retries tell a request timeout (`name: "TimeoutError"`, `code` unset or `ETIMEDOUT`) from a dropped connection, which Node's handler also names `TimeoutError` (`code: "ECONNRESET"` or `"EPIPE"`).

**Closing the layer.** `destroy()` closes in-flight sockets, which the SDK takes for dropped connections and retries on new ones, with no timeout unless one is configured, and a write goes out again. So each layer's client carries a `finalizeRequest` middleware (`internal/ClientOptions.acquireSdkClient`, inside the retry loop) that fails a further attempt of a request sent before the close with `ClientClosedError`. A request sent after the close still goes out, since the SDK client stays usable. `layerFromSdkClient` owns nothing and adds nothing.

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

**Aggregate** — A domain object composed of multiple entity types that share a partition key. The aggregate reuses its edge entities' definitions for keys and schemas, and reads its partition and writes its rows through the DynamoClient itself (one partition query to read, one `transactWriteItems` per sub-aggregate group to write). The underlying structure is a directed acyclic graph (DAG) where nodes are entity types and edges are relationships with cardinality.

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
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: ["name"] } },
  context: ["name", "gender", "matchType", "league", "series", "season", "startDate"],
  root: { entityType: "MatchItem" },

  edges: {
    venue:   Aggregate.one({ entityType: "MatchVenue", entity: Venues }),
    team1:   TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
    team2:   TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
    umpires: Aggregate.many({ entityType: "MatchUmpire", entity: Umpires }),
  },
})
```

**Edge types** (each `edges` key names a schema field, typed from the schema):
- `Aggregate.one({ entityType, entity?, discriminator? })` — one-to-one edge: one item per aggregate. Optional `entity` is the external entity to hydrate/denormalize from.
- `Aggregate.many({ entityType, entity?, inputField?, sk?, assemble?, decompose? })` — one-to-many edge: one DynamoDB item per element.
- `Aggregate.ref(entity)` — inline ref: stays in the parent item, hydrated on write.
- **BoundSubAggregate** — sub-tree with discriminator for reuse (e.g., `TeamSheetAggregate.with(...)`)

The `(name, config)` forms of `one` / `many` and `many`'s `edgeAttributes` are deprecated *(owner 2026-11-01)*: neither the name nor `edgeAttributes` is read. Both are removed in the next major release.

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
      MatchEntity.create(rootItem),          // attribute_not_exists — first item of the first transaction
      MatchVenueEntity.put({ matchId, venueId, name: "MCG", city: "Melbourne", capacity: 100000 }),
      MatchTeamEntity.put(team1),
      MatchTeamEntity.put(team2),
      MatchPlayerEntity.put(player1),
      ...
    )
```

**`create` is guarded on the root (#134).** The root item is the first Put of
the first transaction, conditioned on `attribute_not_exists(pk)`. An existing
aggregate cancels that transaction — nothing is written — and its cancellation
reason maps to `ConditionalCheckFailed` (the root's `entityType`, `key`
`{ pk, sk }`), never a raw `TransactionCancelled`. Edge, `many` and nested
sub-aggregate rows carry no guard: they are written only after the root's
transaction commits. Each sub-aggregate group remains its own transaction, so a
later group that fails leaves the earlier groups written — exactly as before;
the guard only makes the first transaction refuse. `update` and `delete` are
unchanged. The guard sees the root only: orphan edge rows (a root-less
partition left by a partial earlier write) don't stop `create`, and `get`
merges them in; detecting them would cost a partition read on every create, so
it is documented instead (`delete` the key first). `delete` retries the
`UnprocessedItems` of its `BatchWriteItem`s with `Batch.write`'s backoff and
bound (5 retries), then fails with a `DynamoError`.

**What `create` hydrates, and by what key.** An edge with an `entity` is given
ids where its input takes them: a `one` or `ref` edge's `${field}Id`, the
elements of a `many` edge given as ids, and the `${field}Id` of a `many`
element wrapping the entity in a field of its own (`PlayerSheet.player`, the
field `deriveEntityFieldName` names, as `deriveElementInputSchema` derives the
input). Whether a `many` element takes an id of the key composite's type is
decided from the element's definition alone, never from the value given or a
guess at what a field's schema can hold:

- **The element is the entity** (`isEntityElement`): its schema is the
  entity's own model (`isEntityModel`): the schema the entity was made with,
  its `DynamoModel.configure` wrapper taken off, or a copy of it that changes
  only its annotations, its checks or its brand, compared by reference. An
  identifier is never identity: a class of the entity's identifier (wrapping
  the entity, or declaring its fields again) is another schema, judged as any
  other element. Every question of whether a schema is the entity is asked of
  `isEntityModel`. Its values are an id of the key composite's type, or the
  entity whole. Given whole, it holds no ref in its own key: where the entity
  is keyed by `${field}Id` (`lineId` of a `Line`), that is the entity's own
  value (`elementHoldsRef`). Up to 1.39.0 it was taken for a ref because its
  name was `${field}Id`, and `create` died composing the key, or refused the
  element without its key. It is left unfetched exactly where 1.39.0 failed.
  Where 1.39.0 fetched it and completed, it is fetched: the key is the
  model's identifier, the entity's one key composite, and optional in the
  model, so 1.39.0 took it out of the element (`fetchedByOwnKey139`). A string
  in any other field of that name is fetched, as on 1.39.0.
- **The element names the field holding the entity** (`entityFieldOf`): a plain
  `Schema.Struct` or `Schema.Class` (no union, transformation, `suspend` or
  declaration at the element) whose field of the entity's name is the entity's
  own model schema, by AST identity, under `Schema.optional` /
  `Schema.optionalKey` at most, and which doesn't declare `${field}Id` itself (a
  declared one is the element's own data). A copy of the model's node that
  changes only its annotations (`DynamoModel.ref`), its checks or its key's
  optionality is the model; an `Option`, a `NullOr` or a `Result` of it, and a
  struct declared again with the same fields, are not. Its `${field}Id` is an
  id of the key composite's type (`elementHoldsRef`), unless the element is
  given the entity whole. Its input is the element whole, `${field}Id` beside
  it or not, or with `${field}Id` of the key composite's own schema
  (`refIdInput`) in that field's place: neither refuses the other's key, and
  given both, both are kept.
- **Every other element is judged as 1.39.0 judged it.** A string given as the
  element, or a string `${field}Id` in an object element, is an id `create`
  fetches, whatever the element declares, and nothing else is; the hydrated
  value is then decoded as declared. Its input is 1.39.0's: the field of the
  entity's name, if it has one, as `${field}Id: Schema.String`, and an element
  with no fields of its own as declared. That covers every union element
  (through a transformation or `suspend` too), an element through a
  transformation, one whose field of the entity's name is a scalar, an
  `Option`, a `Result`, another struct or the entity under `NullOr`, and one
  declaring `${field}Id`. The one change is the id's type: a string of no type
  of the key composite fails with `EDD-9131`, below.

One rule decides whether a `${field}Id` is an id `create` fetches, for a `one`
or `ref` edge (`field` the edge's name, read off the model's fields) and a
`many` element (`field` the entity's name, read off the element's fields)
alike (`holdsRefId`):

1. `null` and `undefined` give no id.
2. A string is fetched, exactly as on 1.39.0, whatever the definition
   declares: it replaces an entity given whole in `field` with the one
   fetched, and a `${field}Id` the definition declares is taken out of the
   value, as 1.39.0 took it.
3. Any other id is fetched only where `field` holds the entity's own model
   (under `optional` at most), the definition doesn't declare `${field}Id`
   (then it is the definition's own data, stored as given), and `field` isn't
   given whole (then it is stored as given, never replaced or read again).
   1.39.0 fetched none of these.

The id, and the entity given whole, are read off the caller's payload as
1.39.0 read them (`given`, `payload[name]`): the payload's own property, one
its class gives it (a getter, a property of a prototype), or one a proxy
answers for. A function is not given: 1.39.0 took a string for an id, a list
for a `many` edge and an object for a sub-aggregate, so a method of the
payload's class named like an id is no id, and neither is a member every
object inherits (`constructor`, `toString`). A definition's fields, which the
library reads off a schema, are looked up among what the schema declares
itself (`Object.hasOwn`).

A managed timestamp is optional in every element's input.

The input type (`AggregateTypes`) follows the same rule, read from the
element's *schema* type, never its domain type, so a union whose members have
one domain type is still a union. For an entity one id names, it only adds to
1.39.0's: every element is
typed as 1.39.0 typed it (a field whose type has an `id: string` by id,
whatever its name, an element with one as an id), and the id forms are added
beside that. An element of the entity's model schema type (with fields of its
own) takes an id or the entity whole. A `Schema.Struct` or `Schema.Class`
element whose field of the entity's name is of the entity's model schema type,
under `optional` at most, and which declares no `${field}Id`, takes the element
whole (its id beside it or not) or by id: the id form is added, the declared
form never removed, and neither refuses the other's key. The type sees
that field's name only for a `Schema.Struct` model (in a
`DynamoModel.configure` wrapper or not) whose `entityType` is one string
literal: `create` takes a `Schema.Class` model's own identifier, which the
type sees only as `string`, and the `entityType` for a class in a `configure`
wrapper, which the type can't tell apart from a bare class. Every other element
is typed exactly as on 1.39.0. Two schemas of one type
are one to the type, so a struct declared again with the entity's fields is
typed as the entity, where `create` takes only a string id for it.

Each id is a value of the entity's primary key's only distinct composite
(`refKeyComposite`; an attribute in both halves of the key is one attribute),
of that attribute's type (`refIdValue`): the value itself (`5` of a number,
`5n` of a bigint, a `Date`), or what its stored form or JSON form decodes to
(`"5"` of a `NumberFromString` or of a bigint, an ISO string of a date), for a
codec inside a wrapper (`Schema.optional(Schema.NumberFromString)`) too. Up to
1.39.0 only a string was taken: a number or bigint id was dropped, so a
required edge failed decoding and an optional one was created without it. Each
id is fetched by `Batch.get` of the entity's own `get`, so the key is the key
`Entity.put` wrote (`composePrimaryKeyOrFail`, through `_domainKeyForm`),
once per distinct key. An entity with no `DynamoModel.identifier` is fetched
too, and one whose identifier names another field is fetched by its key. Up to
1.39.0 the fetch named the identifier, or `id` without one, and died composing
the key (`Missing composite attribute`).

Every id is judged before anything is fetched. An entity keyed by more than
one distinct composite, or none, has nothing one id names: `create` fails with
a `ValidationError` (`EDD-9129`) naming the edge. An id of no type of the key
composite (`"5"` for a number key, whose key text `put` never writes), or one
`put` refuses, fails with a `ValidationError` (`EDD-9131`) naming where it was
given and what it was given (an object by its JSON). An id given more than once
is judged once: one composing the key text of an id already judged and equal to
it as a value of the key composite (`Schema.toEquivalence`), so three ISO
strings of one instant are judged once; the key text alone is not enough, as
below. The second is `put`'s own
judgement (`Entity._unstorableKey`: the composite encoded through
`inputSchema`'s own field as `put` encodes its input, an encode that fails
being `put`'s refusal too, an infinity through a digits-only string codec, then
the check `put` runs on what it encoded, `unstorableOf`), so a
`NumberFromString` id given `"Infinity"`, which `put` stores as that string, is
fetched, and an infinite number is refused anywhere in the id, in a struct, an
`Option` or a `Result`: its key text can name an item of another value
(`{ a: Infinity }` and `{ a: 5 }` compose one), which was fetched in its place. Nothing is fetched or written. Rows already stored are untouched: nothing here changes a
key.

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

### Attribute Encoding (#72, #133)

Decomposition works from the schema-decoded domain object, so every attribute it
produces is a Type-side value. Each attribute is put into its schema's **wire
form** before marshalling, through per-attribute encoders built at `make()` time.
Marshalling a domain value directly stores a shape the read path cannot decode:
a `DateTime` becomes a `{ epochMilliseconds, <type-id>, _tag }` map, a `Date`
becomes `{M:{}}`, and a `bigint` becomes `{N:"5"}`.

| Rule | Behaviour |
|------|-----------|
| **Which attributes** | Any field holding a wire transform **at any depth** (`containsWireTransform`): a leaf transform, a `Schema.Class`, a self date or `Redacted`, or an `Array` / `Struct` / `Union` / `Record` / `Tuple` containing one. Gating on the top-level AST (pre-#133) skipped every container, since an `Arrays` / `Objects` / `Union` node carries no encoding of its own; that included `Schema.optional(X)` and `NullOr(X)` around a transform. Fields with nothing to encode get no encoder and their bytes are unchanged. |
| **One encoder per field** | A `storedAs` annotation or inferred date default wins, except for a union mixing a date with a non-date member (`Union([DateTimeUtcFromString, Number])`, `isMixedDateUnion`), whose non-date values a date encoder would throw on. Otherwise the field is encoded through the same substituted, tolerant schema the read path decodes it with (`substituteSchemaDeep` + the aggregate's ref resolver), falling back to the field's own `encode`, then `decode → encode`. |
| **Which schema** | The schema the decomposed value actually has: the root model's fields for the root, a `one` edge's entity model (or the model field's own class when the edge has no entity), the array **element** for a `many` edge (`PlayerSheet`, not `Player`), a sub-aggregate's own schema for its root item. Encoders are keyed by the element's field names, so a custom `decompose` that **renames** fields escapes them: the renamed values are stored in domain form (a `DateTime` as a map). This is a known limitation; the read path still lifts those maps. |
| **Per attribute, not per aggregate** | The aggregate is never encoded as a whole before decomposition: key composition needs Type-side values (`numericTypeWithStringEncoding`). |
| **Union members** | `substituteSchemaDeep` walks `Union`, `Record`, `Tuple`, `TupleWithRest` and `StructWithRest` in every mode (`walkedContainer`), rebuilding each container kind around substituted children with the original node's annotations and `.check()` refinements (`withMetadataOf`). Under `tolerantTransforms` (aggregates) every transformed leaf is substituted; for entity derivation only self-date and `Redacted` leaves are. Union members follow the union rules in §8 (Self dates nested in containers): a self date accepts only its own wire kind, its domain or a legacy map; on a storage-kind collision only its exact canonical form, decoded first; an epoch date next to a numeric member is rejected (**EDD-9058**). The collision set propagates into nested unions. A transform date member keeps its own decode, so a stored `5` in `Union([DateTimeUtcFromString, Number])` stays a number. |
| **Keys unchanged** | A `many` edge's `sk.composite` and the root's list-index composites are read from a second encoder set (`buildKeyAttrEncoders`) that keeps the pre-#133 top-level-only behaviour. Composed keys are therefore byte-identical to earlier versions; only stored attribute values gained the deeper encoding. |

**Ref resolution.** `DynamoModel.ref` annotates with `Schema.annotate`, which
drops a `Schema.Class`'s `.fields`, so the schema walker cannot recurse into an
annotated ref. `collectRefTargets` registers each such field with the model it
should be read (and encoded) as: root `one`/`ref` edge fields, opaque ref fields
inside sub-aggregate edges and `many` elements (found by
`deriveEntityFieldName`), a `many` field whose element *is* an opaque ref
(`Schema.Array(X.pipe(DynamoModel.ref))`, re-pointed as a whole at
`Schema.Array(<entity model>)` because the walker re-points fields, not
elements), and refs nested in an edge entity's own model (#116). A
plain-class element field is walked directly and needs no registration. Targets
are keyed by **field schema identity**, not field name: the resolver is
consulted at every depth, and a name-keyed table re-pointed any same-named field
anywhere in the model.

**Legacy maps on read.** Versions ≤1.22.0 stored nested `DateTime`s as marshalled
maps. The tolerant date decoder (`liftToDomain`) rebuilds any plain object with a
finite numeric `epochMilliseconds` and `_tag: "Utc"`, or `_tag: "Zoned"` with a
recoverable named or offset `zone`, into a real `DateTime`. The type-id key is
deliberately not inspected (`~effect/time/DateTime` on the rc, `~effect/DateTime`
on 4.0.0). An object that duck-types as a `DateTime` but carries no recoverable
instant is rejected rather than passed to the domain. There is no backfill: a
legacy row is rewritten in wire form only when an `update` changes its
decomposed group, because the diff compares decomposed (re-encoded) groups and a
no-op update writes nothing.

**Dates on a stream.** Nothing substitutes a date in an event, metadata, a
snapshot state or an outbox effect, so it's stored as the map the marshaller makes
of it (a class instance is marshalled with `for...in`, which skips functions), and
Effect's guard (`DateTime.isDateTime`) looks only for the marker, so the plain map
passed as a `DateTime` and threw once used. `readingStreamValues` adds a second
pass after the absent-read one, `readingMarshalled`, at the AST level so nothing about
the write side or an entity path can change: each `Schema.DateTimeUtc` /
`Schema.DateTimeZoned` declaration, kept through brand, check and annotate, in any
struct, list, record, union, class, `Schema.suspend` (lazily, memoised, so
recursion ends) or declaration's type parameters such as `Schema.Option`, becomes
`Unknown` decoding through a rebuild into the declaration. The rebuild takes a
plain object with the right `_tag` and the `~effect/DateTime` or
`~effect/time/DateTime` marker, and hands anything else on unchanged, so the
declaration's guard, checks and message still decide, and a union member that
doesn't take the value still loses it to the next one. That also means a struct
member listed first takes a date's fields, as it always did. `Schema.Unknown`
isn't touched: nothing declares a date there.

A real date then has to be accepted wherever a read date was. Under
`DynamoModel.Packed`, `stringifyStrict` refused an instance and let the plain
look-alike through, so a read date packed and a new one was refused; `JSON.stringify`
would call its `toJSON` and store ISO text, which the declaration refuses on read.
So `check` accepts a real `DateTime` and `storingDates` stores it as `storedDate`:
the same keys, in the order DynamoDB Local hands the map back, so what's packed from
a date a read returned doesn't move by a byte (`fixtures/stream-dates-1.39.0.json`,
stored by the published 1.39.0, pins this). Real DynamoDB's map order isn't
guaranteed, so that text was never fixed on that path. Anything else JSON can't
represent is refused as before, beside a date too.

**BigInts on a stream.** `Schema.BigInt` goes through the same pass: a number
becomes a `bigint` before the node (`liftingMarshalledBigInt`, using the entity rule
`legacyBigInt`), and anything else, a fraction included, is handed on for the guard
to refuse. It's stored as a number, as it was, so nothing moves and rows already
stored read. A union member that takes the number keeps it, since each member gets
its own try, so a union in which something else is stored as a number can't be
told apart: `5n` and `5` are the same row. `hasBigintBesideANumber` refuses those at
load (`EDD-9125`, `BIGINT_BESIDE_A_NUMBER`), for every ordered pair of members and
for a stream's events as one union, looking through the encoded side and forcing
what's suspended. A pair is judged in the order a read tries it (`confusesItsBigint`,
`first`): the earlier member takes what the later one stored if it has every field
the earlier one requires (`hasFieldsOf`), so
`Union([Struct({ a: BigInt }), Struct({ a: Number, c: String })])` is refused and the
reverse order isn't. A `oneOf` is judged both ways, as two members taking one value
fail it. Beside an object, Effect's `Schema.Option` and `Schema.Result` are judged as
the maps they store (`STORED_MAPS`), so `Union([Option(BigInt), Struct({ x:
optional(String) })])` is taken: a value lost to an earlier member with no place for
it is what any union does, and has nothing to do with a bigint. A declaration that
doesn't say what it takes (a custom one, `Schema.IpAddress`, which has no
representation id) is treated as taking anything, and other declarations are treated
as maps of unknown fields, so a bigint beside them stays refused even when the values
would have read back. Packed storage doesn't change: `stringifyStrict` refuses a
`bigint`, so a packed stream's append fails with nothing written, as it did, and a
number already packed reads lifted.

**Effect's look-alike declarations on a read.** `Schema.Duration`, `Schema.BigDecimal`,
the time zones, `Schema.Cookie` / `Schema.Cookies`, `Schema.UrlParams`, `Schema.SemVer` /
`Schema.SemVerRange`, the network and DNS record types, and a `DateTime` in a
`Schema.Option` or a `Schema.Result` are stored as the map the marshaller makes of an
instance, and each declaration's guard takes that map back. `readingInstances`
(`internal/InstanceReads.ts`, schema package) gives the entity read fields, the
aggregate's assembly schema and a stream's read schemas a copy of each such declaration
whose parser decides exactly as before and then returns the instance the map stands
for (`readingDeclaration`, `rebuildStored` in `internal/EffectInstances.ts`). The
rules: a row is decoded once, and everything a schema runs runs as often as it did;
the rebuild sits on the declaration node whose parser let the map through, with or
without an encoding, except behind one of Effect's own codecs, whose step made the
instance; code inspecting the value (a check, a transformation, a class or declaration
holding it) sees the instance, which is the one intended change; a union takes the
member it took. The instance carries every stored property the rebuild made no use of,
and a value whose instance wouldn't write back what was stored stays the map, so
writing a row again stores what was read. A schema holding none of these is returned
as the same object. `effectDeclarationOf` recognises a declaration by its parse
function, so a `.check()`, an annotation and a brand keep it, and a `Schema.declare`
of one's own doesn't have it.

**What the marshaller does beyond marshalling** (`Marshaller.ts`). It marshals first,
exactly as `@aws-sdk/util-dynamodb` does. Only if that throws does it look for empty
sets to leave out, and for a `BigDecimal` whose cached `normalized` form leads into a
cycle, which it writes as a fresh decimal (`holdsCachedCycle` reads data descriptors
and calls no getter, so an item holding none is handled as it always was). Then
`datingCookies` looks through the marshalled output for a cookie's marker and writes
the expiry of each of Effect's cookies (by prototype) as ISO text, where a `Date`
marshals to an empty map; it finds the source cookie by descriptors, calls no getter,
and touches nothing else. A typed cookie reads the text back as the `Date`
(`cookieOptions`). Cookies are held to the write-back check like every kind but a
date, comparing an expiry as the marshaller writes it (`optionsWriteAs`), so a cookie
1.39.0 wrote with an expiry (an empty map), one holding properties of its own inside
it, and a jar keyed other than by its cookies' names stay the map.

**Custom declarations at write (`EDD-9126`).** A `Schema.instanceOf` and a duck-typed
`Schema.declare` have the same AST, so `EDD-9125` can't judge them, and only values
can. `holdsCustomDeclaration` finds a declaration with no `representation` id (and
not a `Schema.Class`, which has an encoding) on the stored side when a member is
built, and `internal/RoundTrip.ts` holds the check: the real marshaller and
unmarshaller, then the read schema. The test is whether it decodes, never whether
it's an instance, since `Schema.Cause`, `Schema.Graph`, `Schema.TimeZone` and an
empty `Schema.HashSet` all are instances and read back, and a duck-typed declaration
that takes the map keeps writing. A value the marshaller refuses is left to
`marshalOrFail` (`EDD-9124`). The choke points are `encodeForWrite` and
`_refuseNotReadBack` on an entity (`validateAndBuildPutItem` for Batch and
`TransactWriteOps`), `notReadBackOperand` for an update's stored operands
(`.append`, `pathSet`, `pathAppend`, `pathPrepend`, `pathIfNotExists`; `.add`,
`.subtract` and `.deleteFromSet` apply a value, they don't store it),
`refuseNotReadBack` on an aggregate, which runs the real `assembleAggregate` over the
marshalled groups so a custom `decompose` and packed edges are covered,
`encodeToWire` on a stream and `outboxItems` for an outbox. A member holding no custom
declaration has no check object at all, so its requests don't change and it pays
for the scan alone. The check decodes what the write marshalled, so a custom
declaration's parser runs once more on a write of its value than the write's own
encode runs it: CPU only, with no request (`CustomDeclarationParserRuns.test.ts`). `CustomDeclarationWrites.test.ts` fails on a write path that isn't
in `test/helpers/CustomDeclarationPaths.ts`, and on a new `Schema.encode` call
anywhere that writes. Rows already stored aren't touched and still fail on read.

**Stored-type change.** Because the gate now looks through `optional` /
`NullOr` and into refs, some attributes that ≤1.22.0 stored in domain form are
now encoded: a top-level `optional` / `NullOr` around a non-date transform, and
a `NumberFromString` inside a hydrated ref (`{N:"5"}` → `{S:"5"}`). Keys are
unaffected (they use `buildKeyAttrEncoders`), and both forms decode, but a
`list` `filter` / `filterBy` on such an attribute can match old and new rows
differently, and Streams consumers see the type change. An `optional` /
`NullOr` `BigIntFromString` stored as `{N}` by ≤1.22.0 was never readable,
because unmarshalling yields a `number`. The tolerant transform
(`buildTolerantTransform`) now lifts a safe-integer `number` to `bigint` for a
bigint domain, so those rows read. Domain objects with no enumerable state
(`Schema.Date`, `URL`, `Duration`, `BigDecimal`) were stored as maps holding no
value and cannot be recovered.

**A caller's value is a domain value.** `create`'s input and `update`'s mutated state hold what a
caller holds, so `writeSchema` and `mutatedStateSchema` set `domainValues` and a tolerant leaf asks
its domain side first. Assembly keeps `decodeSchema`, which asks the wire side first, because that's
what it's reading. Up to 1.39.0 both asked the wire side first, which can't be right where a
transformation has one type on both sides: `create(50)` on a field multiplying by 10 on decode stored
50 and read 500, and every `update` did it again to every such field in every row, because `state`
holds what a read gave and the decode transformed it once more. Wire values no longer reach that decode
from the library: `hydrateAggregateRefs` used to encode a hydrated ref back for it, and now hands over
the decoded record. A caller can still give one where it can't be a domain value, such as `"5"` for a
`Schema.NumberFromString`.

What both sides take is the domain value, and comes out as a read of its stored form, so
`SchemaTransformation.toLowerCase()` given `"A"` returns and stores `"a"`, as it did. An entity stores
`"A"` there and reads `"a"`. A decoding default is in the stored form, so it's read through the field as
declared and what's beneath it gets the domain value that gives (`absentAsDeclared`). A step encoded as
optional that isn't a default, such as `Schema.OptionFromOptional`, turns what it's given into something
else, so it's gone round (`tolerantLeaf`). Keys come from the domain value through the key form, so a
one-type composite keys on its encoded form and `get` finds it.

`update`'s mutated state also holds a declaration as its plain form, wherever it sits in what a transformation
decodes to. That's asked after the domain value and before the stored side (`plainForm`), so a set held as a
list isn't taken for a stored list and transformed again.

**A custom `decompose` is handed a write's value as 1.39.0 handed it.** What a `many` edge's
`decompose` returns is stored and keyed as given: its fields go through the element's attribute
encoders, and its `sk.composite` is read off it (through `buildKeyAttrEncoders`, which an edge with no
entity doesn't have). On 1.39.0 a write's value reached `decompose` read stored form first, so one
written for it encodes a one-type field itself from a value decoded once more: on a field multiplying by
10, `f / 10` was handed 500 for `create(50)`, returned 50, which was encoded to 5 and keyed as 50.
Handed the domain value, the same function returns 5, encoded again to 0.5 and keyed as 5, and every
`update` compounded it and added a row; an `update` of a 1.39.0 row left it and wrote a second. So on a
write (`create`, update's new state) `decompose` is handed the caller's own value of the edge, as given
and before the write decodes it, read stored form first once (`storedFormFirst`: the field's tolerant
`decodeOnly` substitution, without `domainValues`, only where the field `containsWireTransform` beneath
its classes, `throughClasses`), and what was read (update's old state, `rekey`) is handed as it was
read, as on 1.39.0. Never the value the write already decoded: read again, a decoding default (5, read
as 50) or a stored form the domain side refuses (`"5"` on a union of a number and a string, read as 50)
is decoded twice, to 500, and a row 1.39.0 wrote collides with the one an update adds. Its rows store,
key and read exactly as on 1.39.0. A field with two types (`NumberFromString`) or none reads the same
either way. Two things stay as on 1.39.0: a `decompose` that hands a one-type field back unchanged
stores it decoded once more on every write (`create(50)` stores 50 under 500 and reads 500), and since
the old state composes other keys than the new, every `update` of an edge whose `decompose` encodes the
field rewrites its rows, even one that changes nothing. That is the 1.x contract: `decompose` is handed
what 1.39.0 handed it. The next major hands it the edge's decoded value, as the rest of a write sees it,
and a `decompose` that encodes a field itself drops that step then.

**Which rows in its partition are an aggregate's (`ownsRows`).** By default an aggregate's rows are the
ones its value keys. `update` deletes the keys its old value decomposes to and its new value doesn't,
and `rekey` moves the rows its value decomposes to, displacement included. Both behave as the base
does: 1.39.0 with this release's decomposition fixes (#211's, and decision A: a custom `decompose`'s
result is stored as 1.39.0 stored it). The base isn't 1.39.0 request for request. On 1.39.0, an
`update` that left an ordinary transformed edge field alone stored it transformed once more (a field
that multiplies by 10 on decode, stored as 50, was rewritten as 500 under a new key); the base leaves
it as stored. An `update` is a no-op when its new value's decomposition equals its old value's, compared
as the base compares them (`sameItems`): each item's entity type and stored attributes, in order, not
its keys. A field whose codec stores every number as 0 decomposes 50 and 60 alike, so changing one to
the other is a no-op, whatever key the stored row is under. A no-op writes nothing, with the option or
without it.

Neither `update` nor `rekey` deletes or moves a row the value doesn't key (`delete` has its own rule):
a row a custom `decompose` left under a key it no longer composes, or an edge row its `assemble` drops.
An encoding `decompose`'s rows are such rows: decomposing the value read keys them elsewhere (`f / 10`
once more: a row stored under 50 reads as 50, which is keyed 5). So an `update` that removes such an
element sends a `Delete` for a key no row holds and leaves the row, which `get` still returns. One that
changes the keyed value leaves both rows, and `rekey` leaves such rows under the old partition key,
unreported. All of this is as on 1.39.0 (`AggregateDecomposeRows.test.ts`,
`fixtures/aggregate-decompose-reads-1.39.0.json`). They stay because another member may write rows of
the same entity type into the partition, and nothing in a row says which member wrote it. For the same
reason, two aggregates that share a partition and an entity type can delete each other's rows where
their keys collide, as on 1.39.0 (`AggregateSharedPartition.test.ts`,
`connected.aggregate-shared-partition.test.ts`, and the fixtures `aggregate-shared-partition`,
`aggregate-ownership`, `aggregate-decompose-rename`, `aggregate-foreign-rows` and
`aggregate-claimed-rows`, each `-1.39.0.json`).

`ownsRows: true` on `Aggregate.make` declares that every row of the aggregate's entity types in its
partition is its own: its root's, its edges' and its sub-aggregates' types (`ownedTypes`). Ownership
rests on that declaration. The bind check below is a safety net for it, not a proof.

**The bind check (`EDD-9130`).** `DynamoClient.make` refuses an aggregate declaring `ownsRows` when
another member it can see can write a row of one of its types into its partition (`ownershipConflict`).
The refusal is a defect, as `EDD-9037` is. The check counts every attribute a member writes on a row,
the library's own included, as the row holds it after the last write of each: an attribute written
after a key replaces it. It reads no schema: a model attribute is any name holding any text. So a
member's row can hold the aggregate's `pk.field` unless the library writes that attribute on the row
after every model attribute. A member can write such a row when one of its rows, on the same physical
table, can hold both of these:
- Under the aggregate's `pk.field`, text that can be the aggregate's partition key. Most text the
  library composes as a key there begins with a head `$<schema>#v<version>#<label>`. It's exactly the
  head, or it continues the head after `#`. Such text is an entity's primary or secondary partition
  key, a unique sentinel's key, a vector index's partition, another aggregate's partition key, list key
  or collection sort key, or the back-pointer to an entity's partition key. Not every key the library
  writes has such a head: a projection outbox's index keys are `<type>#outbox` and the like, and count
  as any text. Any other attribute stored under that name can be any text too: a model attribute, a
  sort key, a timestamp, `deletedAt`, a back-pointer to a sort key, a projection outbox's metadata
  (`effect`, `source`, `streamId`, `eventType`, its claim) or index keys, or a projection tombstone's
  markers.
  - When the aggregate's partition key has composites, composed text can be it when the two heads are
    equal, or one continues the other after `#`.
  - When it has none (a singleton), composed text can be it only when it can equal it. An entity's
    partition key with composites always continues its head with `#`, so it can't equal
    `$x#v1#line`.
- Under `__edd_e__`, a type that collides with one of the aggregate's (`typesCollide`). Two types
  collide when they're the same, or when one's sort key head `$<schema>#v<version>#<type>` overlaps the
  other's after `#`. Each head is cased as its member's keys are. Under `lowercase` or `uppercase`,
  `line` collides with `Line`; under `preserve` it doesn't. `Line#Profile` collides with `Line` under
  every casing. A member that stores another attribute under `__edd_e__` writes any type there, and
  every type collides with it: an aggregate's timestamp so named, which it writes after its
  `__edd_e__`. An entity can't: `Entity.make` refuses a model field named or renamed `__edd_e__`, and
  a timestamp or the version so named (`EDD-9140`).

These two comparisons belong to the bind check only. They never widen the rows the aggregate owns, or
the rows assembly hands a node; both match `__edd_e__` exactly.

The members it sees are the entities and aggregates the aggregate's table declares, those the client
binds, and those of every table the client binds. The aggregates checked come from the same list: an
aggregate the client sees only as a bound table's is checked too, since `rekey` runs its handler. Which table a row is on is decided per row a member
writes, not per member: a read model's outbox items are on its outbox's table, which can be the
aggregate's when the entity's own table isn't. A row's table is the same physical table when it is the
aggregate's table, has its key, or resolves to the same table name. The aggregate itself isn't
counted. A refusal names a member of a table the client binds as `<table>.<key>`. A member's rows
are these (`entityWriters`, and an aggregate's `_attributeWriters`):
- An entity's live rows, version snapshots, soft-delete tombstones and time-series events, under its
  primary key, and the projection tombstones (`<type>#tombstone`) and outbox items (`<type>#outbox`) a
  read model writes beside its rows. Every projection defined on the read model counts, each with its
  own outbox's table and index keys (`_projectionOutboxes`).
- Its unique sentinels (type `<type>._unique.<name>`, under the sentinel key), with the back-pointers
  `_entity_pk` and `_entity_sk` naming the owning row.
- Each secondary index's and vector index's partition attribute, on its live rows. A secondary index
  half stored in a table key attribute holds the primary key's text there (`EDD-9106`), so it's
  counted as the primary key.
- Its model attributes, on its rows and kept on its projection tombstones: any name but `__edd_e__`
  and its table key attributes, which it writes after them. `EDD-9109` and `EDD-9140` refuse a model
  attribute stored under those (or under any key attribute it writes), a sparse map's entries included (any attribute a row's reader takes
  as one, `<prefix>#` and a non-empty key, so `<prefix>#` itself is allowed). So an entity of a node's type on the
  same table is refused when the aggregate's partition key attribute isn't one of that entity's table
  key attributes.
- None of an entity's rows is a node's row, so all of them count. An entity composes each composite
  with its field's name (`$x#v1#line#id_p`), which an aggregate never does, and its primary key has at
  least one composite.
- An entity whose keys can't be read is taken to write any attribute and any type.
- Another aggregate's rows: its `pk.field`, `sk` and collection sort-key mirror on every row (the
  root's mirror is its collection key, every other row's a copy of its `sk`), its list index keys on its
  root, its timestamps, which it writes last, and its rows' own attributes (model, context and
  discriminator attributes, or what a custom `decompose` returns): any name but its `pk.field`, `sk`,
  `__edd_e__` and the mirror, which it writes after them. Its list keys aren't among those: a root row
  whose list composites are absent has none, so an attribute of that name stays.

**`update` with `ownsRows`.** Its group transactions are exactly the ones it sends without the option.
After the last of them commits, it deletes the other rows it read of each node that changed, where the
new value doesn't write their sort key.
- A node changed when the update writes its group (the base's diff) and the node's items of the old
  value and of the new one differ by the base's comparison (`sameItems`: types and attributes in order,
  not keys).
- A row is a node's by its type and static discriminator (`slotsOf`), as assembly hands rows. A row
  handed to two nodes is neither's alone: it gets no such `Delete`. No row is deleted twice.
- The retention contract: with `ownsRows`, after an update changes node N, N's rows are exactly what
  its decomposition writes for the new value, but for rows handed to another node too, which stay. A
  custom `decompose` that doesn't write an element it keeps loses that element. The rows of a node that
  didn't change stay, whatever happened to its group.
- These `Delete`s go in their own `TransactWriteItems` requests, up to 100 to a request. Each is
  conditioned `attribute_not_exists(#pk) OR #e = :e`: the row is gone, or still of the type read. A
  concurrent removal is fine. A row replaced with one of another type is left.
- When a request is cancelled, the `Delete`s whose condition failed (from the cancellation reasons)
  are dropped and the rest are resent once. The mutation is never run again, and nothing is read
  again.
- A cleanup request that fails is reported the way a later group's failure is
  (`TransactionCancelled`, or the client's error). By then the update's groups have committed, and the
  rows it didn't delete stay until the next update that changes their node.
- A no-op update writes nothing, cleanup included. Nothing more is read, assembled or decomposed.

**`rekey` with `ownsRows`.** It moves exactly what it moves without the option: the rows its value
decomposes to, displacement included (another aggregate stored where this one goes moves first, and
only a destination that can't be vacated stops it). Where any other row of its types it reads would go
can't be told from what's stored, so none is moved: a lossy codec stores `f = 0` under the key a write
of 50 composed, and a custom `assemble` or `decompose` can hand a row's values to a different element.
- When such a row's own partition key changes, moving the rest would leave it behind: the aggregate is
  a `failed` conflict naming the row, and nothing of it moves.
- Otherwise the row is left where the aggregate reads it, and counted under `skipped.unrecognizedKey`.
  Another row's key change doesn't fail the aggregate.
- No other request is sent: with nothing failed, the requests are the ones sent without the option.
- An aggregate failed this way is repaired by an `update` that changes the row's node, which deletes
  the row. A row handed to two nodes isn't deleted, so such an update doesn't repair it.
- The dry run reports the same. Nothing more is read, assembled or decomposed.

**Limits.** A writer the client doesn't see isn't checked: a member only another client binds, in this
process or another, or a writer outside the library's members. Its rows of the aggregate's types in the
partition are taken for the aggregate's, so every process that writes the table must bind every member
that writes it. The check runs in `DynamoClient.make` only: an aggregate whose operations are run
without it, given a `DynamoClient` and its table's layer directly, is never checked. A row of another type is never the aggregate's: the cleanup's condition leaves one that
replaced an owned row. Aggregate updates have no concurrency control. So a concurrent update's row at a
key the cleanup deletes can be deleted, as a value-key `Delete` can be on 1.39.0. A row handed to two
nodes is never cleaned up. Without `ownsRows`, stale rows stay, and two aggregates sharing a partition
and an entity type can delete each other's rows where their keys collide, both as on 1.39.0
(`AggregateOwnsRows.test.ts`).

**A custom `assemble` is handed rows as read, before decoding.** A `many` edge's `assemble` is handed
the rows read, unmarshalled, with packed attributes unpacked (by their stored form), under their stored
names. Stripped from each: `__edd_e__`, the attributes named `pk` and `sk`, every attribute whose name
begins with `gsi` or `lsi`, and the library's timestamps the node's value doesn't declare. Everything
else stays, the collection sort-key mirror under another name and discriminator and context attributes
included. Nothing is decoded: a field that multiplies by 10 on decode is handed 5 where `get` returns
50. What it returns is decoded with the rest of the aggregate.

On a `Schema.Record` edge without an `entity`, a date field's attribute encoder stores a value already
in the field's stored form as it is (`storedDates`): one its date encodings decode
(`storedDateForm`), such as the ISO text a `decompose` returns for a `DateTimeUtcFromString`. Its key
encoder already composed from such a value as given. 1.39.0 gave such an edge no encoders and stored
its attributes as `decompose` returned them, so such a `decompose` worked there; once keyed edges took
their element's encoders (#201) it failed `create` with a defect, and every `update` of the rows
1.39.0 wrote. There a value in neither form is stored as given and reported (`asGiven`), so the write
refuses it unless it reads back (`EDD-9127`). On an array edge, and on a keyed edge with an `entity`,
1.39.0 had the encoders and failed `create` with a defect, and still does.

A caller who passed the stored form on 1.39.0 had the only input that read back as meant (`create(5)` on
that field read 50). It's a valid domain value too, so it can't be told apart or warned about: it now
stores 0.5 and reads 5, and the guide and the changeset say what such a caller changes.

Rows already stored stay. Nothing can tell what they should have held, so they keep what they store and
read as they did: a row that went through `update` has compounded, once per update. An `update` no longer
adds to it, because a value read back encodes to what's stored, so the diff finds nothing.
`test/fixtures/aggregate-same-type-1.39.0.json` holds such rows, generated once from the published
package.

**A value no encoder takes (`EDD-9127`).** A domain value asked first is taken when it passes the type
side, without encoding it, since the attribute encoders encode it next anyway and an encode here would be
paid on every write. A schema that can't encode a value it decodes to, such as a transformation over
itself (`s.pipe(Schema.decodeTo(s, passthrough))` where `s` holds a transformation), passes that check and
reaches an encoder that can't put it in its stored form, neither the substituted schema nor the field's
own encode nor decode then encode (`ownAttrEncoder`). Up to 1.39.0 the wire side was asked first and
refused it. That value is stored as given, and the encoder reports it (`asGiven`, the item's
`storedAsGiven`), so the write runs `refuseNotReadBack` over its rows: the real marshaller, unmarshaller
and `assembleAggregate`, as a `get` reads them. Rows that don't read back are refused with a
`ValidationError` naming each field as `"field" of "member"`, on `create` and `update`, and nothing is
written: a bigint stored as given reads back as a number, and a class as a map. Rows that do read back
are written, such as a one-way transformation's value, whose decode takes what's stored. A write that
stores nothing as given pays nothing, since nothing reaches the fallback, and the key encoders compose
from the value as it is, as before. `rekey` decomposes too, but rewrites only what a read returned.

**Create input cloning.** `replaceRefIds` deep-copies the create input with
`cloneInput` rather than `structuredClone`, which reduced every Effect data type
to a bare object (a `DateTime` to `{ epochMilliseconds }`, a `Redacted` to `{}`,
an `Option` lost its variant). Values implementing `Equal` are immutable and are
kept by reference; built-ins `structuredClone` knows still go through it; plain
objects, arrays and other class instances are copied to plain objects; cycles
are preserved.

### Nested Sub-Aggregates (#133)

A `BoundSubAggregate` inside another sub-aggregate inherits the parent's
discriminator, as a `one` edge does: `resolveNode` merges
`{ ...parentDiscriminator, ...bound.discriminator }`, so the inner rows carry
both attributes and assembly, which matches on the merged set, can tell the
parent's bindings apart. On the write side the inner sort keys are prefixed with
the parent's `name#value` pairs, and each nested sub-aggregate is its own
transaction group, named by its path (`club2.squad`):

```
SK = $app#v1#leagueclub#clubno#1                        → club1 root
SK = $app#v1#leaguesquad#clubno#1#squadno#1             → club1.squad root
SK = $app#v1#leaguesquadplayer#clubno#1#squadno#1#p-1   → club1.squad.players[*]
```

(numeric values zero-padded in real keys). A sub-aggregate bound on the root has
no parent discriminator, so depth-1 keys are unchanged. Before #133 depth-2 rows
were written without the parent's values and could not be assembled
(`Missing key at ["club"]["squad"]`); they are not read under the new keys.

**EDD-9056.** `validateNestedDiscriminators` runs at `make()` and rejects a
nested binding that declares a discriminator attribute it already inherits: the
inner value would overwrite the outer one on the inner rows, so both bindings of
the parent would key and assemble the inner sub-aggregate identically.

### Aggregate System Timestamps

`Aggregate.make(schema, { timestamps })` takes the same `TimestampsConfig` as
`Entity.make`, and applies it to **every row the aggregate writes** — the root
item and all edge items, including those inside sub-aggregate transaction groups.

```typescript
const MatchAggregate = Aggregate.make(Match, {
  …,
  timestamps: {
    created: { field: "created", schema: DynamoModel.DateEpochMs },
    updated: { field: "updated", schema: DynamoModel.DateEpochMs },
  },
})
```

Aggregates compose their DynamoDB items directly (`buildDynamoItems`) rather than
routing through `Entity` write ops, so Entity's timestamp machinery never reached
these rows — in a single-table design where aggregates hold most of the data that
left the majority of the table with no modification timestamp, and no
configuration that could add one (#98).

**Four rules govern the implementation:**

1. **Injected after the diff, never during decomposition.** `update` diffs
   *decomposed* groups (`deepEqualGroups`) to decide which sub-aggregate
   transactions to rewrite. A timestamp added in `decomposeAggregate` would
   differ on every comparison and silently collapse the diff into a
   full-partition rewrite on every update. Timestamps are therefore stamped in
   `buildDynamoItems`, downstream of the diff.
2. **`created` is carried forward.** Aggregate writes are `Put`, not
   `UpdateItem`, so a freshly generated `created` would clobber the original on
   every update. `update` already fetches the whole partition to assemble current
   state, so the stored `created` is read back from those raw items, keyed by
   `sk`, and re-emitted verbatim. A row that is new in this write gets `created`
   = `updated` = now.
3. **Per-row semantics.** `updated` records when *that row* last changed. A
   diff-based update rewrites only the groups whose content changed, so rows the
   mutation did not touch keep their stored `updated` — which is what a
   downstream sync guarding writes with
   `attribute_exists(updated) and updated < :updated` needs. There is
   deliberately no forced rewrite of the root item to give the aggregate a
   single "modified" marker: it would cost an extra item in an extra transaction
   on every update, and the per-row stamp already answers the question the marker
   was standing in for.
4. **Generated values win over `context`.** Context fields are merged onto edge
   items during decomposition; timestamp injection runs later, so a root field
   propagated via `context` under the same name is overwritten by the generated
   value rather than racing it.
5. **What a row declares is decided per row, as on an entity.** Each node (root,
   sub-aggregate root, `one` edge, `many` element) resolves the stamps against its
   own value's fields (`rowStampsOf`). A date that value declares, under
   `Schema.optional` as well, is managed: the input doesn't need it, and `create`
   stamps it whether or not the input holds a value, in the row and in any key holding
   it. Up to 1.39.0 `create` failed with `Missing key` without one and then stored the
   stamp in its place, so a value there is a placeholder, never stored
   (`test/fixtures/aggregate-create-stamps-1.39.0.json`). The exception is also
   1.39.0's: a date the root declares `Schema.optional` was the caller's then, so
   `create` stores a value supplied for it, on every row (`createdReplaces` /
   `updatedReplaces`, read by `fillStamps`); without one it's stamped. An entity's
   `put` differs: a value supplied for a colliding timestamp field wins there, as it
   did. A field of that name of another type is the caller's, on that row.
   Undeclared, the row is stamped and it's stripped from what's read. A root field of
   that name that isn't a date turns the stamp off for every row, as it always did
   (`resolveAggregateStamps`).
6. **What `create` and `update` return is what they stored.** `create` fills the
   declared dates before it validates (`fillStamps`), so the value it returns holds
   them. `update` keeps `createdAt` whatever the mutation did, as an entity's update
   has no `createdAt` to name. A mutation that changes `updatedAt` wins; otherwise a
   rewritten row is stamped, and a row the diff left keeps its value. When a node
   declares a stamp, the result is assembled from the rows written, with no I/O. When
   none does, it's the decoded value, and nothing extra runs.
7. **A `many` edge with a custom `decompose`.** `fillStamps` works on the value as the model has it, before it's decoded (`fillRows`). With `decompose` and `assemble` it takes the value apart, fills each row and puts it back, so a `Schema.Record` of rows is stamped like an array, and its rows' fields are read from the record's value schema (`manyElementFields`, `extractKeyedValue`), so a date in one is stored in its own form. A value they can't take apart or put back is left for the schema to report. Two can't be filled: a value with `decompose` and no `assemble` that isn't an array (there's no way to put its rows back, nor does it read back), and an opaque field (`Schema.Unknown`) with no `entity`, where nothing says what its rows hold, so they're stamped and it's stripped on read, as a row that doesn't declare the date. A `Schema.ReadonlyMap`, `Schema.HashMap` or `Schema.Chunk` field works here, as it doesn't anywhere else (`EDD-9125`), because its collection is rows and is never stored itself.
8. **The input matches what `create` takes, at every row.** A `one` or `ref` edge whose `entity` one id names takes an id (`venueId`), of the type of the entity's key composite (`refIdInput`, `_EdgeIdValue`: a number, a bigint, a `Date`, a brand), which `create` fetches and denormalises. One with no `entity`, or whose `entity` is keyed by more than one attribute (or none), has nothing to fetch by, so it takes the value under its field name, with its stamps optional: the derived `inputSchema` (`deriveWithStamps`, `rowInput`) and the type (`AggregateInputType`, `_IsValueEdge`) agree. A `many` edge's elements follow the same rule: ids of that type for an element that is the entity, `${field}Id` for the field of an element that holds it (`deriveElementInputSchema`, `_TransformManyEdge`), an element declared a union as 1.39.0 took it (the union as declared; its type 1.39.0's, `_UnionElementInput`), and the elements as given for an edge with nothing to fetch. A `Schema.Record` `many` edge's values have optional stamps too (`keyedInput`, `_TransformManyEdge`), and its `sk.composite` names are checked against them (`ManyEdgeSkPaths`). Any other object field takes any name there: its rows are whatever its `decompose` makes, and a scalar field has no rows and takes none.

**A key with no value.** A composite of an aggregate key can be optional. What happens without a value depends on what the key does:

- **List key: the row is left out of that list**, as a sparse index on an entity leaves it out. An aggregate is fully there without its list entry: `get` reads the partition, and a later write with the value lists it. Whole index or nothing: half a list key writes neither attribute, as on an entity, and aggregate writes are whole-row `Put`s, so a row that loses the value leaves the list. Sharded lists do the same.
- **Collection sort key or partition key: a `ValidationError` (`EDD-9123`) before anything is written.** A root missing from a collection index can't be assembled (`Missing root item`), so leaving it out would write an aggregate nothing can read. The partition key is how the aggregate is found at all. `delete` says the same through `AggregateAssemblyError`, since its error channel has no `ValidationError`.

A `list` filter that leaves out a composite of the list's partition key is the same `ValidationError`: there's no partition to query.

**Read path.** The configured timestamp attribute names are stripped from
assembled items alongside the other DynamoDB metadata (`__edd_e__`, keys, index
mirrors), so they never leak into the decoded domain object. A root model that
declares the field itself follows the same collision rule as Entity, and in that
case the value is kept and decoded normally.

The `schema` half of each field config obeys **EDD-9044** exactly as it does on
`Entity.make` — the aggregate shares the `resolveSystemFields` resolver.

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

Each target item found through the target's `_cascade_<field>` GSI is updated under the **target entity's own primary-key fields** (`primaryKey.pk.field` / `sk.field`), and a rejected update is diagnosed under those fields, so one transactional cascade may span targets keyed differently. Before 1.25.0 the cascade read the hard-coded `pk` / `sk` attributes, so on a table keyed otherwise (e.g. `PK` / `SK`) every eventual-mode update failed (`CascadePartialFailure` with `succeeded: 0`) and a transactional cascade was rejected whole.

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

### Stream Definition and Binding

A stream is bound to a table at definition time. Its operations require
`DynamoClient | TableConfig`; `EventStore.bind` resolves both and returns a
`BoundEventStream` with `R = never` for use inside `Context.Service` make effects:

```typescript
const MatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Match",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
})

const program = Effect.gen(function* () {
  const stream = yield* EventStore.bind(MatchEvents)
  yield* stream.append({ matchId: "m-1" }, [new MatchStarted({ venue: "MCG" })], 0)
  const events = yield* stream.read({ matchId: "m-1" })
  const version = yield* stream.currentVersion({ matchId: "m-1" })
})
```

### Consistent Reads (#139)

`read`, `readFrom`, `currentVersion` and `readLatest` take an optional
`ReadOptions` (`{ consistentRead?: boolean }`, default `false`; `readLatest`'s
`ReadLatestOptions` adds `verifySnapshot`);
`consistentRead: true` sets `ConsistentRead` on every `Query` page for
read-your-writes. `query.events` composes with `Query.consistentRead` instead.
`commandHandler` loads state strongly consistently **by default**
(`CommandHandlerOptions.consistentRead: false` opts out): an eventually
consistent load can hand `decide` stale state, which then fails the append with
`VersionConflict`.

### Key Layout

```
pk           $<schema>#v<n>#<stream>#<streamId composites>
sk (event)   $<schema>#v<n>#<stream>.event_1#<10-digit version>
sk (command) $<schema>#v<n>#<stream>.command#<commandId>     (idempotency sentinel)
sk (snapshot)$<schema>#v<n>#<stream>.snapshot
__edd_e__    "<stream>.event" | "<stream>.command" | "<stream>.snapshot"
```

Stream-id composites carry no `name_` prefix (unlike entity keys). Without
`makeStream({ casing })`, `<stream>` is `streamName` lower-cased and the rest of
the key follows the schema's casing — the layout streams have always had. With
`casing`, the stream name is taken as written and that casing applies to the
whole key except the schema prefix, as an index's `casing` does. On a
`"lowercase"`/`"uppercase"` schema, `casing` equal to the schema's reproduces the
default layout. The `__edd_e__` values are always lower-cased. In the next major,
omitting `casing` will mean the schema's casing.

### Command Handler

The `commandHandler` combinator implements the read-decide-append cycle:

```typescript
const handler = EventStore.commandHandler(MatchDecider, MatchEvents)
const result = yield* handler({ matchId: "m-1" }, new StartMatch({ venue: "MCG" }))
// result: { state, version, events }
```

Full design of the command path: [`docs/designs/eventstore-command-path.md`](docs/designs/eventstore-command-path.md)
(#136–#140; #141 was not implemented — see [Large Commands](#large-commands--stepped-commands)).
Each invocation runs:

```
load → [expectedVersion check] → decide → fold new events → derive items → append → [snapshot]
```

- **Load (#139).** Strongly consistent by default;
  `CommandHandlerOptions.consistentRead: false` opts out. A snapshot-configured
  stream loads through `readLatest` (one `Query` for the snapshot and its
  delta), so the option covers the snapshot too. On a `mode: "inline"` stream
  without `every`, `CommandHandlerOptions.verifySnapshot: false` loads the
  snapshot item alone (one `GetItem`), with verified fallbacks — see
  [Unverified snapshot loads](#unverified-snapshot-loads--verifysnapshot-false).
- **Caller expected version — If-Match (#136).** Per call,
  `handle(streamId, command, { expectedVersion })`. A loaded version other than
  `expectedVersion` fails with `VersionConflict` carrying
  `actualVersion` (the loaded version) **before `decide` runs**; otherwise the
  append is conditioned on it, and a writer that slips in between fails the
  append with `VersionConflict` (no `actualVersion`). Neither is retried. With
  `idempotency`, a pre-decide mismatch first probes the command's sentinel (one
  consistent `GetItem`, on the mismatch path only): a redelivered command that
  already committed fails with `DuplicateCommand`, matching `append`'s
  precedence. A value that is not a non-negative integer is a
  `ValidationError`, raised before anything is read.
- **Fold before append (#137).** The new events are folded into state before
  the append, so the returned, snapshotted and projected state is always the
  `evolve` fold — never anything produced inside `decide`.
- **Decision-derived items (#137).** `CommandOptions.additionalItems` takes a
  static array or a function of the `Decision`
  (`{ events, state, previous, version }`) returning the ops or an `Effect` of
  them — an inline projection. See below.
- **Decision-derived event metadata (#144).** `CommandOptions.eventMetadata`
  takes a function of the same `Decision` returning one metadata entry per event
  (or an `Effect` of them), passed to `append` as `eventMetadata`. See
  [Event Metadata](#event-metadata-144).
- **Decision-derived event timestamps (#144).** `CommandOptions.eventTimestamps`
  takes a function of the same `Decision` returning one `DateTime` (or
  `undefined`) per event, or an `Effect` of them — evaluated after
  `eventMetadata` and passed to `append` as `eventTimestamps`. See
  [Per-event timestamps](#per-event-timestamps).
- **One atomic append.** One command → one decision → one atomic append. A
  decision too large for one transaction is rejected by DynamoDB, so nothing is
  written, and fails with `AppendTooLarge` — see
  [Large Commands — Stepped Commands](#large-commands--stepped-commands).

#### Decision-derived `additionalItems` — inline projections (#137)

```typescript
yield* handle({ matchId }, command, {
  additionalItems: ({ state, previous, events, version }) => [
    MatchStatus.put({ matchId, status: state.status }),
  ],
})
```

- `events` is what `decide` returned (never empty — the function is not called
  for a no-op decision); `state` is the `evolve` fold of `previous` with
  `events`; `previous` is the state `decide` was given; `version` is the version
  the events are appended after.
- The function may return the ops directly or an `Effect` of them. The effect's
  `E2` / `R2` join the handler's error channel and requirements (both default to
  `never`, so the static and pure forms add nothing).
- The items commit in the **same** `TransactWriteItems` as the events. They
  count towards DynamoDB's 100-item and 4 MB transaction limits (`AppendTooLarge`
  and a `ValidationError` naming the item when DynamoDB rejects the append), and a failing item
  condition is `AdditionalItemConditionFailed`, with `indices` into the
  returned array.
- The function runs after `decide` and the fold, and is re-run on every retry
  attempt against the fresh decision.

**The evolve-fold state contract.** The state the handler returns, writes as a
snapshot and passes to `additionalItems` is always the `evolve` fold of stored
and new events. `evolve` **may mutate state in place** — the library does not
require immutable state, and does not enforce `decide` purity (#142 is a design
decision left to the application; see the design doc §8). When `evolve` mutates
and returns the same object, `previous` and `state` are the same reference and
`previous` already reflects the new events; a projection that needs a pristine
`previous` needs an `evolve` that returns new state.

### Event Metadata (#144)

Full design: [`docs/designs/eventstore-event-metadata.md`](docs/designs/eventstore-event-metadata.md).
An event item's `metadata` attribute holds metadata decoded and encoded through the
stream's `metadata` schema (raw without one). `append` takes it in one of two forms,
mutually exclusive (`AppendMetadataOptions`, a two-branch union, so both together is a
compile error):

```typescript
// One value per append, copied onto every event
yield* stream.append(streamId, [e1, e2], v, { metadata: { requestId } })
// One entry per event, in order: item i stores entry i
yield* stream.append(streamId, [e1, e2, e3], v, { eventMetadata: [m1, undefined, m3] })
```

- **`eventMetadata` on `append`.** `ReadonlyArray<M | undefined>`, paired with
  `events` by position. An `undefined` entry writes no `metadata` attribute on that
  event. Each defined entry is encoded like `metadata`; an encode failure is a
  `ValidationError` with `operation: "EventStore.append.eventMetadata[<i>]"`.
- **Validation runs first.** Both options given (`undefined` counts as absent) or a
  length other than `events.length` is a `ValidationError`
  (`operation: "EventStore.append.eventMetadata"`) before anything is read or written,
  ahead of the zero-event fast path: `append(id, [], v, { eventMetadata: [m] })` fails,
  and `{ eventMetadata: [] }` keeps the no-op.
- **Size.** Each item carries only its own entry, so a per-event id costs N entries,
  not the N² of a list packed into `metadata`. Items count towards DynamoDB's 4 MB
  transaction and 400 KB item limits as built; an append DynamoDB rejects for either fails
  with a `ValidationError` naming the event (see
  [Write Limits](#write-limits-and-request-rules--diagnosed-not-pre-checked-144)).
- **`eventMetadata` on `commandHandler`.** Function-only (`EventMetadataInput`): a
  static array cannot know the event count before `decide`. It takes the `Decision`
  (`{ events, state, previous, version }`) and returns the entries or an `Effect` of
  them, whose `E3` / `R3` join the handler's error channel and requirements (separate
  from `additionalItems`' `E2` / `R2`, so the two may fail differently). It is
  exclusive with per-call `metadata` (a compile error; a `ValidationError` before
  anything is read for untyped callers, as is a non-function).
- **When it runs.** After `decide` and the fold, **before** `additionalItems`; never
  for a no-op decision; re-run on every `VersionConflict` retry and on the
  re-decision a stale unverified snapshot triggers under `verifySnapshot: false`.
  Ids minted per attempt are safe: a failed attempt writes nothing.
- **Length mismatch.** A returned array whose length differs from `events.length`, or
  a result that is not an array, is a `ValidationError`
  (`operation: "EventStore.commandHandler.eventMetadata"`), never retried; nothing is
  written.

The read side is unchanged: `StreamEvent.metadata` decodes each item's own attribute,
so `read`, `readFrom`, `readLatest` and stream-index queries return each event's entry.

#### Per-event timestamps

An event item's `timestamp` is the append's `DateTime.now` (from the `Clock`) unless the
append sets it per event. Nothing in the library reads `timestamp` for ordering,
snapshots or expiry, so an import can carry each event's original time instead of
pinning the `Clock` per chunk (design doc §7):

```typescript
// Entry i is written as event i's timestamp; undefined keeps the append's `now`
yield* stream.append(streamId, [e1, e2, e3], v, {
  eventMetadata: [m1, m2, m3],
  eventTimestamps: [t1, undefined, t3],
})
```

- **`eventTimestamps` on `append`.** `ReadonlyArray<DateTime.DateTime | undefined>`, on
  `AppendOptionsBase`, outside the exclusive metadata union: it combines with
  `metadata`, `eventMetadata` or neither. Each entry is written with
  `DateTime.formatIso` — the format `now` is written in — so a zoned `DateTime` is
  stored as its UTC instant.
- **Validation runs first**, with the metadata checks and ahead of the zero-event fast
  path: a value that is not an array, a length other than `events.length`, or an entry
  that is neither a valid `DateTime` (finite epoch) nor `undefined` is a `ValidationError`
  (`operation: "EventStore.append.eventTimestamps"`) before anything is read or written.
- **Event items only.** The idempotency sentinel, its TTL and the inline snapshot keep
  `now`: they record when the append was written.
- **No ordering constraint.** `version` orders a stream; timestamps may repeat, run
  backwards or lie in the future, as imported history can.
- **`eventTimestamps` on `commandHandler`.** A function of the `Decision` on
  `CommandOptionsBase` (`EventTimestampsInput`) returning the array directly or an
  `Effect` of it, mirroring `eventMetadata`, so times can come from a service (an
  import's source log) or the `Clock`. The effect's error and requirements join the
  handler's through their own trailing type parameters, `E4` / `R4`, not `eventMetadata`'s
  `E3` / `R3`: with one shared pair, an `eventMetadata` effect and an `eventTimestamps`
  effect with different error types fail to infer (TypeScript fixes the parameter from one
  candidate and rejects the other instead of inferring a union); the separate pair infers
  the union, as the type tests prove. Evaluated after `eventMetadata` and before
  `additionalItems`; never for a no-op decision; re-run on every attempt and on the
  unverified-snapshot re-decision. A wrong-length or malformed result, plain or from the
  `Effect`, is a `ValidationError` (`operation: "EventStore.commandHandler.eventTimestamps"`);
  neither that nor a failure of the returned `Effect` is retried; a non-function value is
  refused before anything is read. No error union widens beyond the effect's own `E4`.

### Snapshots

Full design: `docs/designs/eventstore-snapshots.md` (#84). Opt-in via `snapshot` on
`makeStream`:

```typescript
const MatchEvents = EventStore.makeStream({
  table: EventsTable,
  streamName: "Match",
  events: [MatchStarted, InningsCompleted, MatchEnded],
  streamId: { composite: ["matchId"] },
  snapshot: { schema: MatchStateSchema, every: 100 },
})
```

**Storage.** One snapshot item per stream, in the stream partition, overwritten in place:

```
pk           <stream partition key>                     (same as events)
sk           $<schema>#v<n>#<stream>.snapshot           (never collides with event SKs)
__edd_e__    "<stream>.snapshot"                        (excluded by event queries' filter)
streamId     "<composites joined with #>"
asOfVersion  event version the state reflects
state        Schema.encodeEffect(snapshot.schema) output
timestamp    ISO (Clock-backed)
```

Event read paths (`read`, `readFrom`, `currentVersion`, `query.events`) are additionally
SK-range-hardened (`begins_with` on the event prefix / `BETWEEN` on versions) so the
snapshot is excluded at the key-condition level, not just by the `__edd_e__` filter.
Writes are monotonic: `attribute_not_exists(pk) OR asOfVersion < :new` — a stale
concurrent snapshot write is a successful no-op.

**Primitives** (also on `BoundEventStream` with `R = never`):

```typescript
stream.writeSnapshot(streamId, state, asOfVersion)  // Effect<void, ValidationError | DynamoClientError, ...>
stream.readSnapshot(streamId)                       // Effect<Option<Snapshot<State>>, ...>
// Snapshot<State> = { state, asOfVersion, timestamp }
```

State round-trips through the user-supplied `snapshot.schema` — `Schema.encodeEffect`
on write, `Schema.decodeUnknownEffect` on read — so transforming schemas work.

**`writeSnapshot` on a sealed stream (#166).** `writeSnapshot` stays one plain conditional
`PutItem`: it does not know whether the stream is sealed and never writes the seal marker,
so it **must not target a sealed head with an unmarked snapshot**. The residual when it
does: a closer on a definition without the inline-without-`every` snapshot config seals at
`S` (the snapshot stays unmarked below `S`), a `writeSnapshot(id, state, S)` then puts an
unmarked snapshot at `S`, and a `headProof: "snapshot"` append at `S` passes its proof and
lands `S + 1`, reopening the stream. Sealing through the writers' definition writes the
marked snapshot at `S`, which the monotonic `writeSnapshot` never replaces.

**Snapshot-aware commandHandler.** When the stream declares `snapshot`, each handler
invocation loads state with `readLatest` (the snapshot plus its delta in one `Query`,
below) instead of a full replay, then runs the command path above. In the default
`mode: "after-append"`, with `every: N`, the handler writes a fresh snapshot of the
post-fold state after a successful append once ≥ N events accumulated since the last
snapshot (best-effort — a snapshot-write failure is logged and never fails the command).

### Inline Snapshots and `readLatest` (#138)

```typescript
snapshot: { schema: StateSchema, mode: "inline" }             // every append
snapshot: { schema: StateSchema, mode: "inline", every: 10 }  // inline, at a cadence
snapshot: { schema: StateSchema, every: 100 }                 // "after-append" (default)
```

`SnapshotConfig.mode` (`SnapshotMode`: `"after-append" | "inline"`) defaults to
`"after-append"`; any other value throws `[EDD-9062]` at `makeStream`. In `"inline"`
mode the handler passes the post-fold state as `AppendOptions.snapshot`, and `append`
adds an unconditional snapshot `Put` (`asOfVersion = expectedVersion + events.length`)
to the **same transaction**, after the idempotency sentinel. It commits if and only if
the events do; the event puts already prove the writer owns `asOfVersion`, so it cannot
regress. It counts towards the item and size limits, requires at least one event
(`ValidationError` otherwise), and on a stream without `snapshot` dies with
`[EDD-9026]`.

```typescript
stream.readLatest(streamId, { consistentRead? })
// Effect<LatestState<State, Event>, DynamoClientError | ValidationError, …>
// LatestState = { snapshot: Option<Snapshot<State>>; events; version }
```

`readLatest` issues one reverse `Query` over `sk BETWEEN <event SK prefix> AND
<snapshot SK>` filtered to the stream's event and snapshot items. The snapshot SK sorts
after every event and command sentinels sort before events under every casing, so the
range holds exactly the events plus the snapshot. The first page's `Limit` is
`(every ?? 1) + 1`; it pages on (each further page sized to the events still missing)
until the event at `asOfVersion + 1` is in hand or the partition is exhausted, then
returns the events after `asOfVersion` ascending. A current inline snapshot loads in one
request; a snapshot lagging by up to `every` events also loads in one, otherwise two.
The first page is read whatever the lag, so an `"after-append"` stream with a large
`every` reads up to `every + 1` items per load — the `SnapshotConfig.every` JSDoc says
so. On a stream without `snapshot`, `readLatest` is `read` plus the head.

#### Unverified snapshot loads — `verifySnapshot: false`

```typescript
stream.readLatest(streamId, { verifySnapshot: false })          // ReadLatestOptions
EventStore.commandHandler(decider, stream, { verifySnapshot: false })
```

`verifySnapshot` (default `true`) is a `readLatest` option (`ReadLatestOptions`, which
extends `ReadOptions`; `read` / `readFrom` / `currentVersion` do not take it) and a
`CommandHandlerOptions` field. With an inline snapshot written in every append, the
snapshot is normally at the head, yet the verified `Query` still reads the snapshot
**and** the newest event (`Limit: 2`). A `Query`'s read capacity counts every item it
reads; a `GetItem` reads only the snapshot — with large events, roughly half the read
capacity per command. `false` therefore reads the snapshot item alone with one `GetItem`
(consistent per `consistentRead`, so strongly consistent in `commandHandler` by
default):

- **`readLatest`** returns `{ snapshot, events: [], version: snapshot.asOfVersion }` —
  `version` is **unverified** (events appended without a snapshot may follow it). With no
  snapshot item it falls back to the verified read and returns that.
- **Accepted only on `mode: "inline"` without `every`** — the only mode in which the
  snapshot is normally at the head. Any other snapshot config: `commandHandler` throws
  `[EDD-9068]` when the handler is created (data-first and data-last, `EventStream` and
  `BoundEventStream`), and `readLatest` dies with `[EDD-9068]` (a defect, like
  `[EDD-9026]`). On a stream without `snapshot` the option is ignored (the full verified
  read, as before).

A snapshot can still lag the head (events appended raw, or data predating
`mode: "inline"`), and then **every** answer made on it is stale — a domain error and a
no-op as much as an append. So `commandHandler` returns no answer made on an unverified
snapshot until the head confirms it. A successful append confirms it by itself (its
version condition held); anything else is checked with one more read, and a stale load
falls back to a verified one:

| Situation | Behaviour |
|---|---|
| No snapshot item | `readLatest` falls back to the verified read at once; `decide` runs once |
| `expectedVersion`, snapshot `asOfVersion` ≠ it | Verified `readLatest`, then the normal If-Match check: `VersionConflict.actualVersion` is the **verified** head; the `DuplicateCommand` probe keeps its precedence. `decide` does not run |
| `expectedVersion`, snapshot `asOfVersion` = it | The snapshot is exactly the state the caller saw: decide on it. An append confirms the head. A domain error, a no-op or an append `VersionConflict` is checked with one head `Query` above the If-Match (it reads no items while the stream is still there): a head at the If-Match returns the answer; a head past it discards the decision and answers as the verified load would — `DuplicateCommand` for a committed redelivery, else `VersionConflict` with the head as `actualVersion`. Never re-decided or retried (the If-Match rule) |
| No `expectedVersion`, a domain error or a no-op | One head `Query` above the snapshot's version. Head at the snapshot → the answer stands. Head past it → the decision was made on stale state: a verified `readLatest` and **decide again once** on that state (its outcome is final for the attempt) |
| No `expectedVersion`, the append fails with `VersionConflict` | One verified `readLatest`. Events past the current snapshot → the load was stale: **decide again once** on the verified state and append (outside, and in addition to, the `retry` policy; its own conflict follows the policy). Snapshot at the head → a genuine race: the `VersionConflict` goes to the `retry` policy as always, and a retried attempt loads unverified again |

`decide` can therefore run **twice for one call** (the last two rows), and so can a
function-form `additionalItems` when both decisions append. This is the price of skipping
the verification read — the same price a `VersionConflict` retry pays: a decision is only
as current as the state it was made on, and one made on stale state cannot be patched,
only made again. Without the re-decision a lagging snapshot would fail or mis-answer every
command on the stream, because only a successful inline append rewrites it; the
re-decision's append repairs it. With an If-Match, `decide` may run on a snapshot whose
version the stream has since moved past — on exactly the state the caller saw, as in a
verified load that loses a race — but that decision is never returned. A decision that
appends nothing adds one head `Query` bounded below by the snapshot's version (reverse,
`Limit: 1`). While the snapshot is current that range is empty, so the `Query` reads no
items and costs only DynamoDB's per-request minimum, however large the events are; only a
lagging snapshot makes it read an event (the head). The trade-off for such decisions is
one extra round trip, not extra item reads.

### Head Proof and `loadState` (#164)

Every append after version 0 carries the version-contiguity `ConditionCheck` on the event
at `expectedVersion`. Inside a transaction DynamoDB bills it at 2 WCU per KB of the
checked item, so with large events it is a sizeable share of every append. The event
puts' `attribute_not_exists(pk)` already rejects a stale `expectedVersion`; the check
rejects one ahead of the head. An item whose own condition holds only at
`expectedVersion` proves the head is at least that, the event put at
`expectedVersion + 1` that it is at most that — so it can replace the check.

- **`append({ headProof })`** — `HeadProof = { additionalItem: n } | "snapshot" | "none"`.
  Omitted: the check is written, exactly as before.
  - `{ additionalItem: n }`: `additionalItems[n]` must carry a condition of its own
    (`.condition()`, `create()`, `Transaction.check`; a guarded put's read guard does not
    count) — else, or for an `n` out of range, `ValidationError` before anything is
    written. Its own condition failing is `VersionConflict` (judged through a guarded
    put's verdict, so a lost race is still rewritten), ranked after `DuplicateCommand` and
    the event puts, ahead of the other additional items.
  - `"snapshot"`: the inline snapshot `Put` is conditioned on `asOfVersion = :expected`
    (`attribute_not_exists(pk)` at 0); a failure at its position is `VersionConflict`.
    Needs `snapshot` (`ValidationError`) and a `mode: "inline"` stream without `every`
    (`[EDD-9085]`, a defect). A lagging snapshot fails the condition — a conflict, never a
    gap.
  - `"none"` (#173): no check and no proof. **The caller guarantees the head**, taking over
    both duties of the check: (1) no gap — `expectedVersion` never ahead of the head, which
    holds for the version of any event read from the stream (`read`, `readFrom`,
    `currentVersion`, `readLatest` without a snapshot config: nothing deletes events, so the
    head only grows; such a version can be stale, never ahead). A snapshot's `asOfVersion`
    (`readLatest` with a snapshot) is only as sound as the `writeSnapshot` callers, which
    are not checked against the events; (2) the seal — refuse to append when the last event
    read is sealed, since nothing else stops an append at `S`. A writer that read the head
    just before a one-event seal (`S - 1`) still gets `StreamSealed` (its first put lands on
    the sealing event, `ALL_OLD`); one further behind, or just before a seal of several
    events, gets `VersionConflict` and must apply duty 2 on reload. The event puts still
    reject a stale version (`VersionConflict`). Combines with every other option; `append`
    and `measureAppend` only.
  - `measureAppend` accepts it and leaves the check out of `transactionBytes`.
  - **The caller's contract** (`{ additionalItem }`): every writer of the stream writes
    the item, conditioned the same way, in the same transaction as its events. An append
    without it leaves the record behind the head (a `VersionConflict` loop, not a gap); a
    record version written without its events moves it ahead of the head — the one way to
    open a gap.
- **`commandHandler({ loadState })`** — `(streamId) => Effect<Option<{ state, version }>,
  EL, RL>` replaces the stream load; `None` is version 0 with the initial state. If-Match,
  `decide`, the fold and the append are unchanged; a `VersionConflict` re-runs it under
  `retry`; a no-op or domain error is answered from the record. `EL` / `RL` join the
  handler's channels (`LoadStateError` / `LoadStateContext` of the inferred `TConfig`,
  which therefore has no default type: a default fixed `TConfig` before an inline
  `(streamId) => …` was contextually typed). A bad `version` or a non-`Option` result is a
  `ValidationError` (`EventStore.commandHandler.loadState`), never retried. The snapshot is
  not read: inline without `every` still writes it every append; with `every`, a snapshot
  is written when an append crosses a multiple of `every`.
- **`commandHandler({ headProof })`** — the handler-level proof for every append.
  `{ additionalItem }` is passed as is (a call that appends must return the item).
  `"snapshot"` is applied per attempt only when the load found the snapshot at the head
  (`loaded.version === snapshotAsOfVersion`: a verified load with no event after it, an
  unverified load, or an empty stream); otherwise that append writes the check, and a
  conflict takes the existing stale-snapshot path. `"none"` is not accepted (#173):
  `Exclude<HeadProof, "none">` in the type, and for an untyped caller every call fails with
  `ValidationError` (`EventStore.commandHandler.headProof`) before anything is read or
  written; construction does not throw for it.
- **Refused at construction (`[EDD-9085]`)**: `loadState` with `verifySnapshot: false`
  (no stream load to skip), `loadState` with `headProof: "snapshot"` (the snapshot is never
  read), `headProof: "snapshot"` on any other snapshot config, a malformed `headProof`.

- **Single-item fast path (#173).** In `sendAppendTransaction`, a request of exactly one
  item that is the append's one event `Put` (no check, sentinel, snapshot or additional
  item: a one-event append at version 0, or a one-event `"none"` append) is sent by
  `sendAppendPut` as a `PutItem` with the same `Item`, `ConditionExpression` and
  `ReturnValuesOnConditionCheckFailure: ALL_OLD`: 1 WCU per KB instead of 2, the same
  atomicity and result. **Retry idempotency:** the SDK fills a transaction's
  `ClientRequestToken`, so its resend after a lost response succeeds; a `PutItem` has no
  token, so the fast path writes its own — `__edd_wt__`, 128 random bits from Web Crypto
  per `append` call (`WRITE_TOKEN_ATTRIBUTE`, stream-owned) — and a failed condition whose
  `ALL_OLD` item carries this call's token is the call's own commit: success. Any other
  failed condition goes through `streamAppendVerdict` with the one reason (`StreamSealed`
  from a marked returned item, else `VersionConflict`); a rejection the diagnosis names is
  rewritten by the same `rewrite` against the item sent (`SentWrite` `_tag: "Item"`); a
  failure a transaction reports as its item's reason is `TransactionCancelled`
  (`operation: "PutItem"`) with that reason (`putItemReason`):
  `ProvisionedThroughputExceededException` → `ProvisionedThroughputExceeded`,
  `ThrottlingException` → `ThrottlingError`, `ItemCollectionSizeLimitExceededException` →
  `ItemCollectionSizeLimitExceeded`, `TransactionConflictException` →
  `TransactionConflict`, a key-type mismatch (`/Type mismatch/`) → `ValidationError`;
  anything else passes through, as from the transaction. `measureAppend` counts the token
  (a placeholder of its length) when the append would take this path. `appendOp` is never
  sent this way.

Design: `docs/designs/eventstore-head-proof.md`, `docs/designs/eventstore-head-proof-none.md`.

### Sealing a Stream (#166)

A table restore makes version numbers reusable, so an application keys streams by
generation (`{ accountId, generation }`) and moves writers to the next generation after a
restore. A stale writer whose `expectedVersion` happens to equal the restored head could
still append to the old generation, where nobody reads. **Sealing** closes that: a sealed
stream accepts no further events. The library owns no notion of generations; it provides
the seal, a way to carry another stream's append, `StreamSealed`, and read results that
report the seal.

- **`append(..., { seal: true })`** marks the append's **last** event (`S = expectedVersion
  + n`) with the native `BOOL` attribute `__edd_sealed__`, and the inline snapshot of the
  same append when it writes one. Never on the idempotency sentinel, nor on a snapshot from
  `writeSnapshot` or the after-append path; never removed (no unseal). The marker is in
  `STREAM_OWNED_ATTRIBUTES`, so an index attribute of that name is `[EDD-9064]`. It sits
  outside `data` / `state`, so packed storage never touches it. Zero events or a
  non-boolean `seal` is a `ValidationError` (`EventStore.append.seal`); so is a sealing
  append without `snapshot` on a `mode: "inline"` stream without `every` (that check binds
  only the definition that seals). `measureAppend` counts the marker.
- **Enforcement — no pre-read, no extra items.** The contiguity check becomes
  `attribute_exists(#pk) AND attribute_not_exists(#sealed)` with
  `ReturnValuesOnConditionCheckFailure: ALL_OLD`; the **first** event put gains `ALL_OLD`;
  the snapshot proof becomes `#asOfVersion = :expectedVersion AND
  attribute_not_exists(#sealed)` with `ALL_OLD` (`attribute_not_exists(pk)` at 0, also
  `ALL_OLD`). A writer at `S` fails the check; one at `S - 1` fails its first put on the
  sealing event; both are `StreamSealed`. Further behind is `VersionConflict` (a handler's
  retry reloads and reports the seal). Zero-event appends write no check, so side writes
  still land.
- **Attribution precedence** (`sendAppendTransaction`): `RepeatedItem` diagnosis →
  sentinel (`DuplicateCommand`) → own stream sealed (a marked item returned at the check,
  the first event put or the snapshot proof: `StreamSealed`, `sealedVersion` from the
  item's `version` / `asOfVersion`) → other event-range failures (`VersionConflict`) →
  head proof (`VersionConflict`) → additional items via `judgeCancellation`: nested stream
  verdicts in op order, then guarded-put `fail`, then `conditions`
  (`AdditionalItemConditionFailed`), then `retry` → `TransactionCancelled`.
- **`stream.appendOp(id, events, v, options?)`** (`EventStream` and `BoundEventStream`)
  returns a `StreamAppendOp`, accepted only by `append`'s and the handler's
  `additionalItems` (`AppendWriteOp = TransactWriteOp | StreamAppendOp`).
  `buildTransactWriteItems(ops, operation, { streams: true })` runs its lazy `_build`
  (the inner stream's own `buildAppend`), pushes the items with `provenance.kind:
  "stream"`, records a `streams` range with a verdict, and leaves it out of `conditioned`
  (so it can't be a `headProof` target). Without `streams: true` it is refused
  (`ValidationError`), so `Transaction.transactWrite` is unchanged. Options are
  `NestedAppendOptions` (no `additionalItems`, `idempotency`, `headProof`; refused at
  runtime with `EventStore.appendOp`, as are zero events, when the outer append builds).
  The verdict over the nested slice: a marked item → `StreamSealed`, another failure of its
  check or event puts → `VersionConflict`, both naming the inner stream. A bound op builds
  under its captured `TableConfig` / `Compression`, but every item goes through the outer
  append's `DynamoClient` (one transaction, one client). Without `seal` it is an atomic
  multi-stream append.
- **Changeover rule.** The seal's `expectedVersion` is the version the carried-over state
  was read at (the same `readLatest`, or the decided opening event's back link), never a
  fresh read of the head: a fresh read seals over a stale append the opening event never
  carried. A chain-index item rides as a whole-item Entity put under an application
  `revision` condition (read-modify-write; Entity updates in `append`'s `additionalItems`
  are a follow-up). A record the sealed stream's writers load goes in the **outer**
  append's `additionalItems`, with `sealedVersion`.
- **Reads.** `decodeStreamEvent` sets `StreamEvent.sealed: true` on a marked event (`read`,
  `readFrom`, `query.events`, `decodeStreamImage`, index reads except
  `"withoutMetadata"`, whose `INCLUDE` list is unchanged). `LatestState.seal` is the
  sealing event, set from **any** marked event the read fetched (the oldest when several
  are marked), kept out of `events` when the snapshot already folds it in. With
  `verifySnapshot: false`, a marked snapshot costs one `GetItem` of `event(asOfVersion)`;
  an unmarked one (a seal through a definition without the inline config) reports nothing.
  `currentVersion` stays a number.
- **`commandHandler`.** After every load (and the unverified flow's verified reload) a
  seal — `LatestState.seal`, or `LoadedState.sealedVersion` from `loadState` — fails with
  `StreamSealed` before `decide`, after probing the idempotency sentinel
  (`DuplicateCommand` first) and ahead of the If-Match check. A load with events past the
  seal still fails, logging the post-seal versions. `sealedVersion` must be a non-negative
  integer not below `version` (`ValidationError`). The handler never seals.
- **Head proofs.** `"snapshot"`: the marked snapshot at `S` refuses the proof; seal
  through a definition sharing the writers' inline-without-`every` config.
  `{ additionalItem }`: unenforced by the library; the recommended pattern is a one-event
  seal that keeps the record at `S - 1` with a sealed flag and `sealedVersion: S`, so every
  record-proof writer's first put lands on the sealing event. Advancing the record to `S`
  is safe only if every writer's condition tests the flag. `"none"` (#173): unenforced by
  the library; refusing on a sealed last event read is the caller's duty, and a writer
  that read the head just before a one-event seal still fails its first put with
  `StreamSealed` (one further behind gets `VersionConflict`).
- **Residuals (documented).** A pre-1.33 writer can append past a seal; so can a
  record-proof writer whose record was advanced to `S`, a `headProof: "none"` writer
  that does not refuse on the seal it read, and a `headProof: "snapshot"`
  writer after a `writeSnapshot` put an unmarked snapshot at `S` (below). One such write
  reopens the stream for every writer, because the check is on the event at the writer's
  `expectedVersion`. Reads report it (`seal.version < version`) while the sealing event is
  among the items they fetch; the handler refuses to decide.

Design: `docs/designs/stream-seal.md`.

### Large Commands — Stepped Commands

An append is always one `TransactWriteItems`: it is never split. An append receives
**one decision** — many events and the one state after all of them — so split across
transactions it would have no valid intermediate states to put at the boundaries (no
snapshot, projection or sentinel that is true there). Only the application's decider can
produce a valid state for each boundary. An append over 100 items is rejected by
DynamoDB, so nothing is written, and fails with `AppendTooLarge` carrying the expanded
`count` and DynamoDB's error as its `cause` (over 4 MB, or with any item over 400 KB, with
a `ValidationError` naming the culprit item) — see
[Write Limits](#write-limits-and-request-rules--diagnosed-not-pre-checked-144).

A large command — an import, a bulk correction, a compensating undo — is therefore run
as **stepped commands**:

1. The application plans the steps (newest first for an undo), each covering at most a
   configured number of entities. A fixed size is preferable to one computed from the
   events, because event content varies.
2. Each step is an ordinary `commandHandler` call — decide → fold → one atomic append
   with its own snapshot, projections and sentinel — with `expectedVersion` set to the
   version the previous step returned.
3. A failure partway leaves the stream at a real, consistent intermediate state: the
   last committed step.

With `idempotency`, each step needs its own `commandId` (e.g. `` `${commandId}#step-${n}` ``),
which is also what lets a **redelivered** large command — same `commandId`, same original
`expectedVersion` — resume after a partial failure. Its first step's If-Match is stale, so
the handler consults that step's sentinel before deciding: a committed step is a
`DuplicateCommand`. The application skips it **keeping the stale If-Match**, so each
following step is checked the same way, without `decide` running; the first step not
committed is a `VersionConflict` whose `actualVersion` is the head, and runs from there,
chaining as usual. Every step committed → every step skipped, nothing written.
(`DuplicateCommand` carries no version: chaining the next step from the head instead
would make `decide` run against the steps already applied — a compensating undo would
fail its own validation.) The tutorial's helper does exactly this. An
`AppendTooLarge` on a step carries `count` and `limit`: the signal that the configured
step size is too large. Rule of thumb: **one command → one decision → one atomic
append.** The tutorial's `stepped-command` example region runs a 150-event import and
its compensating undo in fixed 50-entity steps.

### Stream Indexes (#140)

```typescript
const Entries = EventStore.makeStream({
  …,
  indexes: {
    byEntry: { index: "lsi1", sk: "lsi1sk", key: (event, version) => … },          // LSI (default)
    byDay: { type: "gsi", index: "gsi1", pk: "gsi1pk", sk: "gsi1sk", key: … },     // GSI
  },
})

stream.readIndex("byEntry", streamId, { beginsWith?, between?, reverse?, limit?, consistentRead? })
stream.query.index("byEntry", streamId)            // Query<StreamEvent<…>>
EventStore.indexDefinitions(...streams)             // CreateTable fragments

// A GSI with a derived partition, shared by several streams, with snapshots (#149)
byOrder: {
  type: "gsi", index: "gsi1", pk: "gsi1pk", sk: "gsi1sk",
  partition: (event, version, streamId) => `ORDER#${streamId.orderId}`,          // string | undefined
  key: (event, version, streamId) => `LINE#${streamId.lineId}#EVT#…`,   // string | undefined
  snapshot: (state, asOfVersion, streamId) => ({ partition, key }),     // | undefined
}
stream.readIndex("byOrder", streamId, { partition: "ORDER#o-1", … })  // partition required
stream.query.index("byOrder", streamId, { partition: "ORDER#o-1" })
```

A stream index is a sub-stream of the stream's events ordered by a key derived from
each event. `key(event, version)` returns the sort key, stored **raw** (no casing, no
prefix), or `undefined` to leave the event out (sparse); a non-string key or a throwing `key`
fails the append with `ValidationError` before anything is written. An empty key, or a key
over DynamoDB's 1024-byte sort-key limit, is not pre-checked: DynamoDB rejects the append,
so nothing is written, and the rejection is confirmed against the key sent (empty, or over
1024 UTF-8 bytes) and reported as a `ValidationError` (`operation: "EventStore.append.indexes"`) naming the index
and the event's version. Event items carry index attributes, and the snapshot item an
entry in a GSI that derives its partition and declares `snapshot` (below) — sentinels are
never indexed. `key` also receives the stream id (`key(event, version, streamId)`). Index names are a type parameter (`TIndexName`) inferred from
`indexes`, with each index's `projection` alongside (`TIndexProjections`); an undeclared
name at runtime is a defect (`[EDD-9066]`). Definition errors: `[EDD-9063]` malformed
entry (including an unknown `projection` and a member an entry does not declare, such
as a misspelled `projection`, which is also a type error), `[EDD-9064]` attribute owned
by the stream, `[EDD-9065]` indexes sharing a physical index or attribute.

- **LSI** (`type: "lsi"`, default) uses the table's `pk`, so it holds exactly the
  stream's indexed events and supports strongly consistent reads. An LSI **must be
  created with the table**, and a table with any LSI caps the item collection of
  **every** partition key value at **10 GB** — every stream's partitions and every
  entity partition sharing the table, not only the indexed stream's.
- **GSI** (`type: "gsi"`) names a `pk` attribute that `append` fills with the stream's
  partition key value, so it is the eventually consistent, uncapped equivalent scoped
  to the same stream. `consistentRead` on it is sent as asked; DynamoDB rejects it, and the
  read fails with a `ValidationError` naming the index (#144). An empty `beginsWith` /
  `between` bound, or a `between` whose lower bound sorts after its upper bound (UTF-8 byte
  order), is likewise rejected by DynamoDB and diagnosed (`operation: "EventStore.readIndex"`).
- **Projection** — `projection: "all" | "withoutMetadata" | "keys"` per index,
  default `"all"` (design: `docs/designs/index-projection.md`).
  `EventStore.indexDefinitions(...streams)` returns `AttributeDefinitions`,
  `LocalSecondaryIndexes` and `GlobalSecondaryIndexes` to merge into the caller's
  `CreateTable` input; event tables are not derived by `Table.definition`. Each index's
  `Projection` follows its declaration:

  | `projection` | Emitted `Projection` | Read |
  |---|---|---|
  | `"all"` | `ALL` | one query |
  | `"withoutMetadata"` | `INCLUDE ["__edd_e__", "data", "eventType", "streamId", "timestamp", "version"]` | one query; `metadata` dropped, typed `undefined` per index name |
  | `"keys"` | `INCLUDE ["__edd_e__"]` (not `KEYS_ONLY`) | LSI: `Select: ALL_ATTRIBUTES`. GSI: query, then `BatchGetItem` per page (chunks of 100, `UnprocessedKeys` retried, missing keys re-read once consistently, index order kept) |

  `__edd_e__` is always projected: every read filters on it, and DynamoDB refuses a
  filter on an attribute an index does not project (even on an LSI read with
  `Select: ALL_ATTRIBUTES`). `query.index` reads a `"keys"` index the same way through
  an internal `Query` hydration hook; `Query.count` never fetches. Conflicting
  definitions of one physical index, including different projections, throw
  `[EDD-9067]`. The library migrates nothing: the declared projection must match the
  deployed index (CDK / Terraform copy `indexDefinitions`' `Projection`). A decode
  failure on an `"all"` / `"withoutMetadata"` index row lacking an envelope attribute is
  diagnosed as a `ValidationError` (`operation: "EventStore.index.decode"`) naming the
  index; DynamoDB's own "does not project one or more filter attributes" rejection passes
  through.
- Index attributes are written only by `append` and events are never rewritten, so an
  index added to a stream that already holds events (a GSI added by `UpdateTable`), or
  a changed `key`, covers only events appended from then on. The library does not
  backfill.
- **Derived partition (#149).** A GSI's optional `partition(event, version, streamId)` replaces
  the stream's partition key with a derived value, stored raw, so several streams
  declaring the same GSI write one partition of it (an order's line, payment and
  shipment streams under `ORDER#<orderId>`) and one `Query` of it reads the group. The
  partition may come from the event (a stream keyed by something other than its group). Both
  `partition` and `key` run for every appended event; the event is indexed only when both
  return a string. Within one append, every string `partition` must be equal, and the
  inline snapshot's entry must have it too — otherwise `ValidationError`
  (`"EventStore.append.indexes"` / `"EventStore.append.snapshot"`) before anything is
  written. Non-string values and throwing functions fail the same way; an empty or
  over-long (2048-byte) partition is DynamoDB's to reject, diagnosed naming the index and
  the event. Names of such indexes are a type parameter (`TPartitionedIndexName`), so
  `readIndex` / `query.index` require `options.partition` for them; the read filters on
  the table `pk` (projected into every index) to keep the given stream id's events. A
  missing `partition` (or one passed for a stream-scoped index) at runtime is a
  `ValidationError` from `readIndex` and `[EDD-9080]` from `query.index`; the types keep
  `partition` optional on stream-scoped indexes so that a stream with derived partitions
  stays assignable to a plain `EventStream<E, F, M, S>`.
- **Snapshot entry (#149).** `snapshot(state, asOfVersion, streamId)` (requires
  `partition` and a stream `snapshot` config, else `[EDD-9063]`) returns the snapshot
  item's `{ partition, key }`, written on the item by the same `Put` — `writeSnapshot`,
  the inline snapshot of `append` / `commandHandler`, and counted by `measureSnapshot` /
  `measureAppend`. `undefined` leaves the snapshot out; the `Put` replaces the item, so
  that also removes it from the index. A snapshot is current only with `mode: "inline"`
  and no `every`; readers fold the indexed events after `asOfVersion` otherwise.
- **Sharing.** `indexDefinitions` emits a physical index several streams declare once.
  Whether a declaration derives its partition or indexes its snapshot is not part of the
  definition; a `"withoutMetadata"` index that any declarer indexes snapshots in also
  projects `asOfVersion` and `state`. `[EDD-9067]` still covers type, key attributes and
  projection kind. There is no typed cross-stream read: external readers query the
  partition raw (items are copied as stored, packed `data` / `state` included).

### Packed Storage (#147)

```typescript
const Ledger = EventStore.makeStream({
  table, streamName: "Ledger", events: [Recorded, Voided], streamId: { composite: ["ledgerId"] },
  storedAs: { data: DynamoModel.Packed({ format: "json" }) },
  snapshot: {
    schema: LedgerState, mode: "inline",
    storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
  },
})
```

Event `data` and snapshot `state` may be stored packed (§7 "Packed Storage"); metadata
always stays a map (`storedAs` admits only `data`, `[EDD-9079]`; a packed state schema
must be object/array-shaped, `[EDD-9073]`). `stream.storedAs` exposes `{ data, state }`.

- **Write.** `append` (and so `commandHandler`) packs each event's `data` after the
  schema encode and before marshalling, and the inline snapshot's `state` the same way
  (as does `writeSnapshot`). The `TransactWriteItems` request carries the stored bytes,
  so the 400 KB / 4 MB failure diagnosis attributes stored sizes — nothing is
  pre-checked.
- **Read.** Every event decode reads `data` by its stored form (always: an event's native
  `data` is a map), and a snapshot's `state` when it is configured packed or its schema
  is object/array-shaped — so a stream holding native, JSON and compressed items reads
  through any of its definitions: `read`, `readFrom`, `currentVersion`, `readLatest`,
  `readSnapshot`, `readIndex`, `query.events`, `query.index` (all projections, including
  the `"keys"` GSI `BatchGetItem` hydration) and `decodeStreamImage`.
- **Raw rows.** `Query.make({ rawRow })` gives `select` / `selectPaths` a row hook; a
  stream's queries set it to "read `data` by its stored form", so a raw row's `data` is
  plain parsed JSON (not schema-decoded) whether the item stored `M`, `S` or `B`.
- **Filters.** `Query.make({ packed })` lists the packed attributes; with
  `storedAs.data`, `Query.filterExpr` on `data.*` (or any operator but
  `attribute_exists` / `attribute_not_exists` on `data`) and a projection inside `data`
  throw `[EDD-9076]`, pointing to `Query.filterBy`.
- **Planning (caller-side).** `measureAppend(streamId, events, expectedVersion, options)`
  builds the request `append` would send for the same arguments, through the same code
  (`buildAppend`, then `buildAppendTransaction`, which compiles `additionalItems` and lays
  the transaction out), and returns each event item's size, the sentinel's, the inline
  snapshot's, the transaction bytes (its every item, the additional items' included) and
  `requestBytes`, the exact request body (the JSON text, with a transaction's
  `ClientRequestToken` and, when capacity reporting is on, `ReturnConsumedCapacity`; 0 for
  a no-op). It is measured on the request, never summed from parts: adding an item to a
  lone event turns its `PutItem` into a `TransactWriteItems`, another envelope with a
  token. `measureSnapshot` sizes a snapshot item. `R = TableConfig`,
  `E = ValidationError`, and no request is sent, with or without `additionalItems`: the
  transaction is built against a client that sends nothing (`Capacity.withoutRequests`).
  An additional item `append` reads the table to build (a put of a versioned or
  unique-constrained entity, a `create` over a projection tombstone) has no size without
  that read, so it fails the measurement with a `ValidationError` naming the read.
- **Streams.** `decodeStreamImage(image)` returns the read paths' `StreamEvent` for one of
  the stream's event images — DynamoDB JSON (`B` / `BS` as bytes or base64, as Lambda and
  EventBridge Pipes deliver them) or unmarshalled — and `Option.none()` for any other
  item (snapshot, sentinel, foreign). `decodeStreamImage(image, { raw: true })` returns
  a `RawStreamEvent`: the same event plus `rawData`, the `data` wire form the decode read
  (unmodelled fields included), so a consumer never parses an image twice.
- **Codecs.** Read from the `Compression` service in context (no new `R`); `bind`
  captures it with the rest of the context and refuses a registry without the codecs
  `storedAs` names (`[EDD-9078]`, a defect); an unbound stream checks the registry its
  first operation runs with the same way. A stored value whose codec is missing anyway
  fails with the operation's existing `ValidationError`, whose `cause` is a
  `CompressorNotRegistered` — no error channel changes.

### Change-feed Projections (#151)

DynamoDB Streams orders records per item only, and a transaction's records carry no
grouping or order, so a stream's events reach a change-feed consumer in any order.
Waiting for a predecessor's delivery stalls whenever it is queued behind its successor
(one lane, or a shared hash lane). Projections take their order from the event store
instead. Design: `docs/designs/eventstore-projections.md`.

```typescript
const Summaries = EventStore.projection({
  stream: OrderEvents,            // one source stream
  readModel: OrderSummaries,      // a plain Entity
  key: (id, event) => ({ orderId: id.orderId }),   // event fields allowed: several rows per stream
  initial: (id, event) => ({ orderId: id.orderId, status: "new", total: 0, version: 0 }),
  evolve: (state, event) => Effect.succeed(next(state, event)),
  checkpoint: "version",          // or { field, offset }: the field stores version + offset
  terminal: (error) => error._tag === "NotCreated",  // reject the event instead of failing the row
  toItem: (state) => ({ ...state, lookup: lookupOf(state) }),  // the row as written
})
const bound = yield* EventStore.bindProjection(Summaries)   // R = never
const { response } = yield* bound.processBatch(records, { source: "lambda" })
// one feed, several projections:
yield* EventStore.processBatch(records, { projections: { a: pA, b: pB }, source: "lambda" })
```

- **Rows.** `key(streamId, event)` names the row an event folds into (an `Option`:
  none addresses no row — acknowledged, listed in `ignored`, and `apply` then returns
  an `Option`); each row is fed by
  one stream instance and keeps its own checkpoint, meaning every stream version up to
  it has been considered for the row. When an event addresses another row, the earlier
  row keeps what it had.
- **`applyBatch(events)`.** Per row (concurrently, default 10):
  1. sort and deduplicate the row's events;
  2. read the row strongly consistent (`asItem`: `Hidden` fields and `createdAt`
     included); events at or below its checkpoint `c` are `alreadyApplied`;
  3. if the rest are not exactly `c + 1 …` their highest version, one strongly
     consistent `readFrom(c, { toVersion })` bounded at that version fills the gaps,
     keeping the row's events (sound because `append` is a contiguity-checked
     transaction);
  4. fold through `evolve`, skipping events whose failure `terminal` accepts
     (`rejected`; rejected events alone never create a row) and events for which
     `evolve` returns `EventStore.skipEvent` (`skipped`, #162: no outbox effects;
     a row whose events are all skipped or already applied is not written), map
     through `toItem`, set the checkpoint to the last applied or rejected event
     (a skipped event above it is read and decided again later);
  5. write once, with `put` conditioned on `checkpoint = c + offset` and carrying the
     row's `createdAt` (an internal `put` option), or `create` for a new row. A failed
     condition is a lost race — a private signal, retried under `retry` (default:
     jittered, growing from 5 ms by 1.5×, 12 times), then `ConcurrentModification`.

  Per-row failures are outcome values, so the effect never fails; a throwing `key`,
  `initial` or `toItem` is the row's `ValidationError`. `apply(event)` =
  `applyBatch([event])`, failure in the error channel.
- **Side effects.** Each event is in exactly one call's `applied` (the one whose write
  won), so side effects off `applied` are at most once. Republishing `alreadyApplied`
  on redelivery gives at least once (duplicates on every reordering).
- **`catchUp(streamId)`** brings the row of the stream's latest event to the head.
  **`rebuild(streamId)`** re-derives every row from version 1 and returns no events;
  live delivery for the instance must be paused while it runs (a row already at the
  head keeps its checkpoint, so a concurrent applier's condition still holds). Neither
  reads the stream's snapshot, because it is decider state.
- **Stream id.** `StreamEvent.streamId` is the composites joined with `#`.
  `stream.parseStreamId` splits it, and a part count other than the field count (a `#`
  in a value) is a `ValidationError`. `stream.streamIdFields` and `stream.eventMarker`
  are public.
- **Feed helpers.**
  - `EventStore.decoder({ name: stream })` dispatches on `__edd_e__`
    (`[EDD-9082]` for a shared marker).
  - `EventStore.eventFilterPattern(streams)` is the ESM/Pipe filter for the event
    `INSERT`s.
  - `EventStore.batchResponse(records, { source } | { identifier })` keys by
    `dynamodb.SequenceNumber` (Lambda), `eventID` (Pipes) or an accessor; a missing
    identifier fails with `StreamRecordIdentifierMissing`.
  - `projection.processBatch` / `EventStore.processBatch({ projections })` decode
    each record once (an `image` accessor for other shapes; a bound projection
    decodes under its own context), route it to the projections of its stream
    (`streams` decodes others without one, into `unrouted`), and report the earliest record of each failed row plus
    each undecodable record (`onDecodeFailure: "skip"` acknowledges those). Outcome
    `positions` index the records.
- **Refused read models** (`[EDD-9081]`): `versioned`, `softDelete`, `timeSeries`, a
  checkpoint that is not a model field, a non-integer offset.
- **Not covered:** a row fed by several streams (per-source checkpoints), row
  deletion, an ordered outbox. A polled change-feed `Stream` is the subpath below.

### Polled Change Feed (#156)

Outside Lambda and Pipes, a process polls DynamoDB Streams itself. The subpath
`effect-dynamodb/change-feed` (optional peer `@aws-sdk/client-dynamodb-streams`, never
imported by the main entry — guarded by a test) turns a table's stream into an Effect
`Stream` whose batches feed `EventStore.processBatch` unchanged. Design:
`docs/designs/change-feed.md`.

```typescript
const feed = changeFeed({ streamArn, consumer: "projections", startingPosition: "TRIM_HORIZON" })
// Stream<ChangeFeedBatch, ChangeFeedError, DynamoStreamsClient | CheckpointStore>
yield* runChangeFeed(feed, { projections: { summaries: OrderSummaryProjection } })
// or by hand: batch.commit() / batch.complete(result.response)
```

- **Services.** `DynamoStreamsClient` (`Context.Service`; `DescribeStream`,
  `GetShardIterator`, `GetRecords`, `ListStreams`; `layer` / `layerConfig` /
  `layerFromSdkClient`, the first two taking `requestHandler` and `maxAttempts`, §10) and
  `CheckpointStore` (`Context.Service`; `load`, `commit`,
  `acquireLease` / `renewLease` / `releaseLease`; `layerMemory`, `layerDynamoDB({ tableName })`
  over `DynamoClient` (`finishedTtl` at least 28 h, `[EDD-9084]`), `tableDefinition(name)`
  for its `pk`/`sk` table).
- **Shards.** Full paginated `DescribeStream` at start and every `describeInterval`;
  a drained shard's children via `ShardFilter: CHILD_SHARDS`, falling back to a full
  describe where the filter is rejected (`ValidationException`, remembered) or finds none
  (DynamoDB Local) — the describer's next describe, shared by shards drained meanwhile.
  Children are filtered by `ParentShardId`. A shard starts once its
  parent is finished or gone from the stream — per-item order across splits. At a
  restart, a checkpointed shard or an unread shard's unfinished parent gone from the
  stream fails with `ChangeFeedTrimmed` before anything is read; a fresh start
  checkpoints already-gone parents `Finished`. A shard missing at startup counts as gone
  only after a second describe and a `GetShardIterator(TRIM_HORIZON)` probe (not found or
  trimmed); one that exists is read, a parent first. An open shard without an iterator is
  retried after a refresh, never finished. A
  `GetRecords` without `NextShardIterator` ends a shard: after its last batch is
  acknowledged it is checkpointed `Finished` and dropped. The feed ends once the stream
  is `DISABLED` and every shard is finished.
- **Positions.** Checkpoint → `AFTER_SEQUENCE_NUMBER`; `Finished` → skipped; otherwise
  `TRIM_HORIZON`, except at a fresh `LATEST` start (no checkpoints at all), where the open
  shards start at `LATEST` and closed ones are checkpointed `Finished` unread.
  `ExpiredIteratorException` re-acquires from the shard's position;
  `TrimmedDataAccessException` is `ChangeFeedTrimmed`.
- **Batches and acknowledgement.** One `GetRecords` (`batchSize`, default 100) per batch,
  one batch in flight per shard: the shard waits for `commit()` / `complete(response)`
  (pull-based backpressure; shards concurrent). `complete` follows Lambda's partial batch
  response contract keyed by `SequenceNumber`: checkpoint at the record before the
  earliest failure, re-read `AT_SEQUENCE_NUMBER` it after a growing backoff; an unknown
  identifier fails the whole batch. Checkpoints follow acknowledgements — at least once.
  Acknowledgements are serialised; the first whose write succeeds settles the batch, and a
  failed write can be retried.
- **Throttling.** `LimitExceededException` maps to `ThrottlingError`; it and
  `InternalServerError` retry without limit on a jittered exponential backoff (100 ms →
  10 s). Idle open shards poll every `pollInterval` (1 s). One reader per shard per feed;
  `maxConcurrentReads` (16) bounds the reads in flight across shards, a permit per call.
  AWS's two-readers-per-shard guidance counts every consumer name, Lambda mapping and Pipe.
- **Lease.** One item per `(consumer, streamArn)` in the checkpoint store: conditional
  acquire (absent, expired or ours), renewed every `duration / 3` (`renewEvery` must be
  below `duration / 2`, `[EDD-9083]`; store failures retried until `renewEvery` before it
  lapses), released on exit; `ChangeFeedLeaseHeld` (or
  `onHeld: "wait"`), `ChangeFeedLeaseLost` when taken over. Once lost, acknowledgements
  fail with `ChangeFeedLeaseLost` instead of committing.
  Guards against an accidental second consumer; writes are not fenced.
- **Errors** (`Data.TaggedError`, in the subpath): `ShardIteratorExpired`,
  `StreamDataTrimmed` (client), `ChangeFeedTrimmed`, `ChangeFeedLeaseHeld`,
  `ChangeFeedLeaseLost`, `CheckpointStoreError`.
- **Not covered:** per-shard leases and rebalancing across processes, Kinesis Data
  Streams for DynamoDB, a retry limit / dead-letter for a batch that keeps failing.

### Multi-source Projections, Tombstones and the Outbox (#153–#155)

Design: `docs/designs/eventstore-projections-2.md`. One row engine
(`internal/ProjectionEngine.ts`) serves `projection` (one source, a scalar
checkpoint) and `multiProjection` (several sources, a checkpoint per source
instance).

- **The engine.** It reads the row raw (strongly consistent; a tombstone reads as
  one), works out each instance's checkpoint slot and run (gap-filled in `fold`
  mode, newest-only in `latest`), and folds in declared source order, then
  stream id, then version. It writes once — through the entity's `put` (keeping
  `createdAt`), as a raw tombstone, or with outbox items in one
  `TransactWriteItems` — conditioned on the revision (or the scalar
  checkpoint). A lost race retries with a jittered backoff.
- **`revision`** is a library-owned numeric field: `+1` on every write, which is
  conditioned on the value read (`attribute_not_exists` when absent). One
  comparison serialises every writer, whatever its source, and closes
  `rebuild`'s ABA case. It is required by `multiProjection` and `outbox`.
- **Checkpoints** are a `Record<string, number>` map keyed `<source>#<streamId>`,
  and/or per-source `{ field, offset, instanceField }` for legacy rows.
  `instanceField` records the owning instance; an empty one is adopted by the
  first instance that arrives. Another instance goes to the map, or fails with
  `ProjectionSourceConflict`. Within one attempt, a field goes to the first
  instance in fold order, which is how `rebuild` repairs a wrong owner. There
  is no cap: an oversized row fails in DynamoDB and is diagnosed there.
- **Optional fields** (#158). A checkpoint, `instanceField`, map or revision
  field may be optional in the model, for rows written before the projection.
  Absent reads as no checkpoint, unowned, no entries or no revision, and the
  write's guard is `attribute_not_exists`. An existing row without a revision
  gets `initial` on its first write (not `initial + 1`). The map is written only when it has
  entries or the row already had it, so a row gains only the fields the
  projection set.
- **Tombstones** (`removal`, `EventStore.removeRow`) are raw items at the row's
  key (`<entityType>#tombstone`) keeping the checkpoint fields and revision;
  TTL is opt-in. Entity `get`, `Batch.get` and `Transaction.transactGet`
  report them as absent. A later event restarts from `initial`. Removal is
  refused for read models with `unique` / `retain` / `softDelete` features.
  The entity's `create` (single-item and transactional) takes a tombstone's
  place, carrying the checkpoints of the projection that wrote it over, with
  its revision one higher. Every projection records its layout on the read
  model (`_projectionLayouts`), with or without `removal`: each attribute it
  keeps on a row (checkpoint, checkpoint map, checkpoint owner, revision) with
  its role, whether it has `removal`, and whether its tombstones set the TTL
  attribute. One entry per distinct layout, the one defined last at the end
  (a layout defined again moves there). Whether `create` reads first is a flag
  of its own (`_projectionTombstones`: some projection has `removal`), so a
  read model whose projections have none sends `create`'s put alone, as
  before.
  - **A tombstone keeps the remover's attributes.** Its checkpoints and
    revision, nothing of another projection's, and a projection's row written
    over a tombstone holds what its own state gives it, as on 1.39.0. On a row
    several projections share, another projection's checkpoint doesn't survive
    the row's removal, so its redelivery applies again, as on 1.39.0. Whether
    a field on a row is the writer's own data or another projection's
    bookkeeping can't be told without a record of which projections wrote the
    row, which this release doesn't keep.
  - **`create` over a tombstone** consults the projections with `removal`,
    the one defined last first: each attribute one of them names that the
    tombstone holds is carried, a checkpoint (or map, or owner) as it is and a
    revision one higher, and an attribute two of them name takes the role the
    one defined last gives it. A tombstone holds its writer's attributes, so
    those are what's carried, whichever projection with `removal` wrote it.
    1.39.0 took the layout of the projection with `removal` defined last
    alone, so over another projection's tombstone it carried nothing, and a
    late redelivery of the removal applied again and removed the created row.
    A projection without `removal` writes no tombstone and isn't consulted.
    When a projection's tombstones set the table's TTL attribute, it is never
    carried, so the row doesn't expire with the tombstone. Over a tombstone of
    the projection with `removal` defined last, `create` sends and stores what
    1.39.0 did (`test/fixtures/projection-tombstones-shared-1.39.0.json`).
  - **One role per attribute in a projection (`EDD-9133`), on a read model
    whose rows may be tombstones.** When a projection on the read model has
    `removal`, a stored attribute (compared through the entity's renames, as
    writes name it) that one projection gives two roles is refused: its
    tombstone carries a checkpoint as it is and raises a revision, so the two
    would overwrite each other. The refusal comes at whichever definition
    completes the conflict, the projection's own or the first `removal`,
    before anything is recorded, so the order projections are defined in
    doesn't decide it. Without `removal` nothing is refused. Two projections
    may keep one attribute in different roles: projections writing disjoint
    rows (`a#<id>` and `b#<id>`, say) can't be told at definition from
    projections sharing rows, and each projection writes only its own
    attributes, so on its own rows they keep their roles, as on 1.39.0.
    Projections that share rows and swap an attribute's roles are broken, as
    on 1.39.0, and can't be detected.
    The table's TTL attribute is known only when a projection runs: one a
    projection keeps (by its stored name) while a projection's tombstones set
    it (`removal.ttl`) refuses every projection on the read model with a
    `ValidationError`. Every entry point that writes a row (`apply`,
    `applyBatch` and `processBatch` per row, `catchUp`, `rebuild`,
    single-source and multi-source) runs that check first (`preflight`),
    before it sends anything, whatever the data. The table is resolved for it
    only when a projection's tombstones set the TTL attribute. `drain` and
    `drainPending` write no row and don't run it, so a worker providing only
    its outbox's table delivers as on 1.39.0. Projections may share an
    attribute in one role, such as a revision.
  - **A sparse-map checkpoint field.** Its keys (`<source>#<streamId>`) hold
    `#`, which a sparse map can't store. A tombstone's write is checked as the
    row's write is (`serializeSparseOrFail`, on a copy), so both refuse such a
    key with a `ValidationError`, after the reads and before anything is
    written. What's stored is the tombstone as 1.39.0 stored it: a map left
    empty is kept whole, `{"M":{}}`. A write that adds no key (every event
    skipped, or an instance holding its source's own field) isn't refused.
- **The outbox** writes effects as items (`<entityType>#outbox`, sort key
  `<rowSk>#outbox#<revision>#<n>`) in the row's partition or in `outbox.table`,
  in the row's transaction. `drain` claims the head item (a conditional update
  with an expiring claim), delivers it, deletes it on its claim, and repeats:
  in order per row, at least once. `deliver` on `applyBatch` / `processBatch`
  drains after the write; `drainPending` sweeps through a sparse
  `outbox.index`.
- **`EventStore.processBatch`** routes through each projection's internal
  routes (one per source stream; `bindProjection` wraps their decode and apply
  in its context), so single- and multi-source projections share one feed.

### Command Handler Retry

```typescript
const handler = EventStore.commandHandler(matchDecider, matchEvents, { retry: 3 })
// or an Effect Schedule:
EventStore.commandHandler(matchDecider, matchEvents, {
  retry: Schedule.exponential("50 millis").pipe(Schedule.compose(Schedule.recurs(5))),
})
```

On `VersionConflict` the **full read–decide–append cycle re-runs** — never a blind
re-append of stale events, and a function-form `additionalItems` is re-derived from
the fresh decision. Only `VersionConflict` is retried; domain errors,
`DuplicateCommand`, `StreamSealed` (#166) and infrastructure errors fail
immediately. A call that supplies `expectedVersion` is never retried on its own
stream's `VersionConflict` — that is the answer to a conditional write. A
`VersionConflict` naming **another** stream (a nested `appendOp`'s, told apart by
`streamName` and `streamId`) is retried by the schedule even under an
`expectedVersion`, whose If-Match is checked again on the reload, and is never
taken for this stream's lagging snapshot (`returnAppendConflict` catches only
own-stream conflicts). Without a schedule it is returned as-is, naming that
stream. A number `n` is shorthand for
`Schedule.recurs(n)` (n retries after the initial attempt). Default: no retry.

`commandHandler` dispatches data-first vs data-last on the `EventStreamTypeId` brand of
its second argument, so all four call shapes work:

```typescript
EventStore.commandHandler(decider, stream)
EventStore.commandHandler(decider, stream, { retry: 3 })
stream.pipe(EventStore.commandHandler(decider))
stream.pipe(EventStore.commandHandler(decider, { retry: 3 }))
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

## 14. Vector Search

### Overview

DynamoDB native vector search (GA 2026-08-05) adds approximate-nearest-neighbour
retrieval to the table itself: a **vector index** is declared on `CreateTable` /
`UpdateTable`, DynamoDB maintains it from an ordinary list-of-number attribute on
each item, and `SearchVectors` returns the top-K most similar items with a score.

effect-dynamodb models this the same way it models GSIs — **declaratively on the
entity**, with library-managed attributes so the domain model stays pure:

```typescript
const Products = Entity.make({
  model: Product,
  entityType: "product",
  primaryKey: { pk: { field: "pk", composite: ["productId"] }, sk: { field: "sk", composite: [] } },
  vectorIndexes: {
    byDescription: {
      name: "vec1",                      // physical vector index on the table
      dimensions: 1024,                  // immutable after CreateTable
      distance: "cosine",                // cosine | euclidean | dotProduct — immutable
      source: { fields: ["name", "description"] },
      partition: ["tenantId"],           // optional extra HASH composites
      filters: ["category", "status"],   // INLINE_FILTER attributes (equality-only)
    },
  },
})
```

Two library-managed attributes back each entity/index pair:

| Attribute | Purpose |
|---|---|
| `__edd_v_<physicalName>__` | The stored embedding (DynamoDB `L` of `N`). |
| `__edd_vp_<physicalName>__` | The composed HASH partition value (always present). |

INLINE_FILTER attributes are ordinary model fields — no wrapper attribute. The
naming mirrors `__edd_e__`: deliberately ugly so it cannot collide with a user
field, and never surfaced in the domain model or the decoded record.

### Partition composition — entity scoping for free

The vector index HASH attribute is **always** declared and **always** composed by
`KeyComposer`, using exactly the same prefixing and casing rules as every other
key:

```
$schema#v1#<entityType>[#<partition composite values>]
```

Two consequences fall out of this, both deliberate:

1. **Entity scoping is automatic.** The entity type is baked into the partition
   value, so a `SearchVectors` call on a shared physical index only ever sees one
   entity type's items. This is the vector-search analogue of the `__edd_e__`
   FilterExpression that scopes every Query/Scan — but it costs nothing at read
   time because it is the partition key, not a filter.
2. **Multiple entities can share one physical vector index.** The default quota of 5
   vector indexes per table (adjustable through AWS Support) is tight for single-table
   designs; sharing is the norm rather than the
   exception. `Table.make` validates that every entity sharing a physical index
   agrees on `dimensions` and `distance` (they are immutable at the DynamoDB level,
   so disagreement is unrepresentable). `filters`, by contrast, are per-entity
   access patterns rather than a shared physical property, so they are **unioned**
   across sharers when the `SearchSchema` is emitted — keeping only the first
   declarer's set would silently leave the other sharers' filter attributes
   un-indexed. The 18-filter limit is checked against the union.

With `partition: ["tenantId"]`, tenant scoping composes into the same attribute,
and DynamoDB's per-partition-value throughput ceilings (1 GBps search, 10 MBps
write) distribute per tenant rather than per table.

**Sparse semantics.** DynamoDB indexes an item only when it carries BOTH the
vector attribute and (when declared) the HASH attribute. Removing either removes
the index entry. The library relies on this for lifecycle stripping (below) —
there is no "delete from index" operation to call.

### Embedder service

Embedding generation is entirely the application's responsibility (DynamoDB never
computes or refreshes a vector). The library models the generator as a service:

```typescript
// @effect-dynamodb/schema — AWS-free
export interface EmbedderService {
  readonly embed: (text: string) => Effect.Effect<ReadonlyArray<number>, EmbeddingError>
  readonly dimensions: number
}
export class Embedder extends Context.Service<Embedder, EmbedderService>()(
  "@effect-dynamodb/Embedder",
) {}
```

`Embedder.layerTest({ dimensions })` ships in-library: a deterministic
hash-based embedder used by the test suite, the connected suite, and the runnable
examples. A Bedrock-backed implementation is documented as an **example**, not
shipped — that would drag `@aws-sdk/client-bedrock-runtime` into the runtime graph
for every consumer.

`DynamoClient.make({ ..., embedder })` accepts an explicit service; otherwise the
`Embedder` service is resolved from context if present. Resolution mirrors the
`SecureRandom` bundling pattern exactly, so bound entity operations stay `R = never`.
Dimension agreement between the layer and every bound vector index is validated at
`DynamoClient.make` time — a mismatch is a construction-time failure, never a
runtime surprise on the thousandth write.

### Write path

| Operation | Embedder invoked? |
|---|---|
| `put` / `create` | Always (the full item is being written). |
| `upsert` | Always — emitted as plain `SET`, never `if_not_exists`, so an upsert that overwrites the source overwrites the vector derived from it. |
| `update` / `patch` | **Only** when the write touches a `source.fields` member. |
| `.withVector(name, vector)` | Never — the caller supplies a pre-computed embedding. |
| `.append()` (time-series) | Never on event items; vector attributes are stripped. |

"Touches" spans every channel that can change the source, not just the `set()`
payload: a `remove([...])` clearing a source field, a null/undefined payload
entry, and a path-based operation whose root segment names a source field all
fire the gate. This is the same discipline the policy-aware GSI composer applies
to `removedSet` (§7) — a clear IS a change, and an embedding that survives its
source is worse than no embedding at all.

Otherwise the gate mirrors §7 exactly: a writer that touches none of the source
must not pay for an embedding call, and must not clobber a vector another writer
owns. No source change ⇒ no Embedder call ⇒ stored vector untouched.

**Clearing the source removes the item from the index.** When the gate fires but
the post-update record has no source text left, the write emits `REMOVE` for the
vector AND partition attributes. Sparse semantics then drop the item out of the
index — which is the only way to delete a vector index entry. `.withVector()` on
the same write wins over this, since an explicit vector is not derived from the
source at all.

The partition attribute is composed on every write that composes keys, exactly
like a GSI half whose composites are all primary-key members.

**Out-of-band refresh.** `db.entities.Products.reembed({ concurrency })` streams
the entity's items (Scan scoped by `__edd_e__`), re-derives source text, embeds,
and writes the vector back. This is the migration path when the embedding model
changes — DynamoDB will never recompute a vector for you.

### Lifecycle integration

Version snapshots and soft-delete tombstones already strip GSI key attributes so
they cannot appear in index queries. Vector and partition attributes join the same
strip set, and sparse semantics do the rest:

- **Version snapshots** (`versioned: { retain: true }`) — vector + partition
  attributes stripped. A snapshot is never an ANN hit.
- **Soft delete** — vector + partition attributes stripped, but the vector is
  **stashed** under `__edd_vs_<physicalName>__` (a non-indexed attribute).
  `restore()` un-stashes it, so restoring never costs an Embedder call.
- **Time-series event items** — vector + partition attributes stripped, like GSI
  keys. Only the current item is searchable.
- **Purge / hard delete** — nothing to do; deleting the item deletes the entry.

### Query path — `BoundVectorQuery`

Each declared vector index becomes an accessor on the bound entity, in the same
family as index query accessors:

```typescript
const hits = yield* db.entities.Products
  .byDescription("waterproof hiking boots")   // string ⇒ Embedder; number[] accepted directly
  .partition({ tenantId })                     // required by the types iff partition composites declared
  .filter({ category: "footwear" })            // equality-only shorthand
  .topK(25)                                    // 1..100, sent as given; default 10
  .select(["name", "price"])
  .collect()
// Array<{ item: Product; similarity: Similarity; rawScore: number }>
```

Deliberate shape decisions:

- **`.collect()` is the only terminal.** `SearchVectors` has no pagination and no
  cursor, so `.fetch()`, `.paginate()`, `.startFrom()`, `.maxPages()`, and
  `.reverse()` are *structurally absent* from the type rather than present and
  failing. The builder cannot express an operation the API does not have.
- **`.filter()` is equality-only, over declared attributes only.** The API
  Reference restricts `SearchConditionExpression` to `=` for both HASH and
  INLINE_FILTER attributes; that restriction lives in exactly one type alias
  (`VectorFilterInput`) so that when AWS relaxes it — the SDK JSDoc already
  advertises range operators for INLINE_FILTER — one edit widens the surface.
  Separately, only attributes listed in the index's `filters: [...]` are
  filterable: the accessor types the filter keys as that declared tuple, the
  terminal re-checks at runtime with a `ValidationError`, and the emulation layer
  rejects an undeclared attribute the way real DynamoDB does. All three exist so
  an undeclared filter cannot pass locally and fail in production.
- **`.partition()` is required iff partition composites are declared.** Mirrors
  the "PK composites required" rule on index query accessors, enforced at the type
  level via a conditional on the declared `partition` tuple.
- **`Similarity` is branded and normalized higher-is-more-similar**, regardless of
  distance function. `rawScore` preserves the wire value.

| Distance function | Wire score | Direction | `Similarity` |
|---|---|---|---|
| `cosine` | 0 … 2 | lower is closer | `1 - raw / 2` → 0 … 1 |
| `euclidean` | 0 … ∞ | lower is closer | `1 / (1 + raw)` → 0 … 1 |
| `dotProduct` | −∞ … ∞ | higher is closer | `raw` (already correct) |

Reference ranking for query `[1, 0, 0, 0]` (from the DynamoDB developer guide) —
reproduced verbatim by the emulation layer's unit tests:

| Stored vector | cosine | euclidean | dotProduct |
|---|---|---|---|
| `[1, 0, 0, 0]` | 0.0 | 0.0 | 1.0 |
| `[10, 0, 0, 0]` | 0.0 | 9.0 | 10.0 |
| `[0.7071, 0.7071, 0, 0]` | 0.29 | 0.77 | 0.71 |
| `[-1, 0, 0, 0]` | 2.0 | 2.0 | −1.0 |

**Backfill.** `SearchVectors` errors while a newly added index is backfilling.
That failure is surfaced as `VectorIndexBackfilling`, whose message points at
`db.tables.MainTable.waitForVectorIndex(name)`.

### Table operations

- `db.tables.MainTable.create()` emits merged `VectorIndexes` derived from every
  registered entity's vector index declarations (deduplicated by physical name).
- `db.tables.MainTable.addVectorIndex(name)` / `.removeVectorIndex(name)` emit
  `UpdateTable` with `VectorIndexUpdates`.
- `db.tables.MainTable.waitForVectorIndex(name, options?)` polls `DescribeTable`
  until the index reports `ACTIVE` and `Backfilling: false`.

Vector search is **on-demand capacity only** and the raw operation needs the new
`dynamodb:SearchVectors` IAM action — it is NOT covered by existing read policies.
Endpoint routing to `search-dynamodb.{region}.amazonaws.com` happens automatically
inside the standard `DynamoDBClient` (an explicit `endpoint` override wins), so
there is no second client to configure.

**AttributeDefinitions carry the SearchSchema** (verified against the live
service, 2026-08-17): `CreateTable`/`UpdateTable` reject a vector index whose
SearchSchema elements are not declared in `AttributeDefinitions` ("One element in
SearchSchema is not defined in attribute definitions"). `Table.definition` and
`addVectorIndex` therefore emit an `S` definition for the composed HASH partition
attribute and a per-field definition for every INLINE_FILTER attribute. Since
`AttributeDefinitions` admits only scalar types, a filter field must encode to a
string (`S`) or number (`N`) — derived from the model schema at `Entity.make`
(EDD-9039; EDD-9040 when entities sharing an index disagree on a stored filter
attribute's type). DynamoDB Local inverts the requirement — it discards
`VectorIndexes` and rejects the now-"unreferenced" definitions — so
`VectorSearchEmulation` strips vector-only `AttributeDefinitions` and
`VectorIndexes`/`VectorIndexUpdates` before forwarding table operations.

### Local emulation

DynamoDB Local does **not** support vector search: `CreateTable` silently accepts
and discards `VectorIndexes`, and `SearchVectors` fails with
`UnknownOperationException`. LocalStack wraps DynamoDB Local and inherits the gap.

`VectorSearchEmulation.layer` wraps a `DynamoClient` layer and replaces
`searchVectors` with a Scan + brute-force implementation: all three distance
functions with faithful score directions, HASH/INLINE_FILTER equality predicates,
projection, and TopK. Connected tests and the runnable example execute through it.
It is the only way to exercise the full write→search round trip without an AWS
account, and its ranking output is unit-tested against the developer-guide table
above.

```typescript
const DdbLocal = DynamoClient.layer({ region: "us-east-1", endpoint: "http://localhost:8000" })
const Emulated = VectorSearchEmulation.layer(DdbLocal)
```

### Limits enforced

| Limit | Value | Enforced at |
|---|---|---|
| Dimensions | 1 … 4096 | DynamoDB; the rejection is diagnosed by `db.tables.*.create()` / `addVectorIndex`, naming the index and its sharers (#144). A non-integer is refused at `Entity.make` (`[EDD-9070]`) |
| Vector indexes per table | 5 by default, adjustable through AWS Support | DynamoDB; the rejection is diagnosed by `db.tables.*.create()` / `addVectorIndex`, naming the index and the entities sharing it (#144) |
| INLINE_FILTER attributes per index (after the union across sharers) | 18 | DynamoDB; diagnosed as above (#144). Unverified on DynamoDB Local, which supports no vector indexes |
| HASH attributes per index | 1 (library-composed) | by construction |
| `TopK` | 1 … 100 (default 10) | DynamoDB; sent as given, never clamped, and the rejection diagnosed as a `ValidationError` naming the topK (#144). `VectorSearchEmulation` rejects it likewise |
| Capacity mode | on-demand only | documented |

---

## 15. Error Types

### Complete Error Taxonomy

| Error | Cause |
|-------|-------|
| `DynamoError` | AWS SDK error wrapper |
| `ItemNotFound` | No item: `get`, `update` of a missing item (unless a plain `.set()` of a complete item, which is created), `restore` without a tombstone |
| `ConditionalCheckFailed` | A user `.condition()` failed, or an op's own guard did: `create()` of an existing item (or aggregate), `patch()` or `deleteIfExists()` of a missing item |
| `ValidationError` | Schema decode/encode failure, or a refused operation: an item with an incarnation token but no version, a write that would overwrite a different `v#N` snapshot, a replacing put in `Batch.write`, a condition or filter with an empty part under `or` / `not` (or an `or()` with no parts), `expectedVersion` on an unversioned entity; or a request DynamoDB rejected — an item over 400 KB, a transaction over 4 MB, a partition key over 2048 or a sort key over 1024 bytes, one item touched twice, a condition over its expression limits, an `isIn` with no values, an empty key value, a consistent read of a GSI, a reversed `between`, a vector search's `TopK` outside 1..100 — diagnosed and naming the culprit (`cause`: DynamoDB's error) |
| `TransactionCancelled` | Transaction failed with cancellation reasons |
| `UniqueConstraintViolation` | Sentinel item already exists for unique field (from the entity's write, `transactWrite`, or an `append`'s `additionalItems`) |
| `OptimisticLockError` | A versioned write lost a version race (`expectedVersion` mismatch, a concurrent write between a read-then-write update's read and write, or a guarded put / upsert / transaction put that lost the race on every attempt); carries the real `actualVersion` |
| `ConcurrentModification` | An unversioned read-then-write write found an attribute it read changed before its write landed (or lost a guarded put's race on every attempt), or a unique sentinel it was releasing changed hands; nothing written (`attributes`, `current`) |
| `TransactionOverflow` | DynamoDB rejected a write's own transaction (item, sentinels, snapshot) for exceeding 100 items; nothing written (`cause`: DynamoDB's error) |
| `UpdateAppliedButUnreadable` | A retain update was applied at `version` but its result could not be read back provably; do not retry (`version`, `reason`) |
| `ItemNotDeleted` | `restore` found a live item under the key alongside the tombstone |
| `RefNotFound` | Referenced entity does not exist during hydration |
| `AggregateAssemblyError` | Collection query returned unexpected/incomplete data |
| `AggregateDecompositionError` | Decomposition produced items that fail schema validation |
| `AggregateTransactionOverflow` | Sub-aggregate exceeds 100-item transaction limit — diagnosed from DynamoDB's rejection of that group (`cause`), never pre-checked (#144); `committed` names the sub-aggregates earlier groups of the write already committed, and `message` says so (for a failed `create`, `operation: "create"`, that the root may be committed: update or delete the partial aggregate) |
| `CascadePartialFailure` | Cascade update partially failed (eventual mode) |
| `EmbeddingError` | `Embedder.embed` failed, or no `Embedder` was provided for an entity with vector indexes |
| `VectorIndexBackfilling` | `SearchVectors` called while the vector index is still backfilling |
| `VersionConflict` | An `EventStore` append's version guard failed — the stream moved past `expectedVersion` (or is behind it) — or a `commandHandler` call's caller-supplied `expectedVersion` (If-Match, #136) did not match the loaded version. `actualVersion?` is set by the pre-decide check (the loaded version — after an unverified snapshot load, `verifySnapshot: false`, the verified head re-read before the check) and by an unverified-snapshot If-Match whose decision is confirmed against the head (the head read), and unset on any other append-time conflict, where the actual version is unknown without another read. `streamName` / `streamId` name the stream whose check failed: a nested `appendOp`'s failure (#166) names that op's stream, not the appending one |
| `DuplicateCommand` | An `EventStore` `commandId` was already applied to the stream |
| `StreamSealed` | An `EventStore` append's stream is sealed (`streamName`, `streamId`, `sealedVersion`): an append or nested `appendOp` found a marked item, or a command handler's load found the seal (#166). Terminal, never retried. Precedence is per stream: within one stream's items it ranks after `DuplicateCommand` and ahead of that stream's `VersionConflict`; across streams the appending stream's own verdict comes first, then nested `appendOp`s in op order (the first failing op wins), then the other additional items |
| `AdditionalItemConditionFailed` | A condition the caller set on an `EventStore` `additionalItems` op failed (`indices` into the caller's array) — not a version conflict |
| `CompressorNotRegistered` | Never in an error channel: the `cause` of the `ValidationError` a packed value fails with when it needs a compression codec with no registered `Compressor` — a write whose JSON crossed its `compression.threshold`, or a read of a `B` value whose header names the codec (`codec`, `direction`, `entityType`, `attribute`, `operation`) |
| `AppendTooLarge` | DynamoDB rejected an `EventStore` append for exceeding 100 transact items (`count` is the items sent, `cause` DynamoDB's error); nothing is written and an append is never split. For a stepped command, `count` against `limit` means the step size is too large |

### Credential Refusal Replies

AWS's reply to a signature or credential refusal can quote the signed request, including `x-amz-security-token`, the caller's session token. A tagged error keeps what the SDK threw as its `cause`, and tracers, loggers and `JSON.stringify` all render a cause's message, so every SDK classifier (`classifyError`, `classifyStreamsError`) passes what it catches through `redactCredentialRefusal` (`internal/CredentialRefusal.ts`, #186).

- **Redacted:** the names listed there, and any error whose text mentions `x-amz-security-token`. The cause becomes a new error with fixed `message` and `stack`, keeping `name`, `$fault`, `$metadata` and the SDK error's prototype, so classification by name, `instanceof` and troubleshooting by request id still work. It is a new error because the SDK's `$response` can't be removed from the original.
- **Kept whole:** every other error. `internal/WriteDiagnosis.ts` reads request-shape refusals' wording, and `AccessDeniedException`'s names the principal and action.
- **`$response` on a kept error:** it is non-enumerable and reaches the request's headers, session token and `Authorization` included. It is left in place because exporters don't send it: span exception events copy enumerable fields only, and span attributes and logs format an `Error` by `toString()` and its cause chain. An application that puts `$response` itself on a span does export it. `test/CredentialRefusal.test.ts` guards this against the real SDK and OTLP exporter.

### Declared Errors per Operation

Each operation declares a fixed error union, whatever the entity's
configuration: a `put` declares `UniqueConstraintViolation` even on an entity
without unique constraints. Every union also includes `DynamoClientError`,
plus `RefErrors` / `VectorErrors` where the entity has refs or vector indexes.

Packed storage (#147) adds no member to any union: a packed value that needs a
compression codec the process has not registered — on write over the
threshold, or on read of a value an earlier writer compressed — fails with the
operation's existing `ValidationError`, whose `cause` is a
`CompressorNotRegistered` (`codec`, `direction`, `entityType`, `attribute`,
`operation`). Packing is opt-in, so a caller that never packs sees exactly the
pre-#147 unions.

| Operation | Declared errors (besides `DynamoClientError`) |
|-----------|-----------------------------------------------|
| `put` | `ValidationError`, `UniqueConstraintViolation`, `OptimisticLockError`, `ConcurrentModification`, `TransactionOverflow` |
| `create` | as `put`, plus `ConditionalCheckFailed` |
| `upsert` | as `put`, plus `ItemNotFound`, `ConditionalCheckFailed` |
| `update` | `ItemNotFound`, `OptimisticLockError`, `ConcurrentModification`, `UpdateAppliedButUnreadable`, `UniqueConstraintViolation`, `ValidationError`, `TransactionOverflow` |
| `patch` | as `update`, plus `ConditionalCheckFailed` |
| `delete` | `ItemNotFound`, `OptimisticLockError`, `ConcurrentModification`, `ValidationError`, `TransactionOverflow`, `DeleteAppliedButUnreadable` |
| `deleteIfExists` | as `delete`, plus `ConditionalCheckFailed` |
| `restore` | `ItemNotFound`, `ItemNotDeleted`, `ValidationError`, `UniqueConstraintViolation`, `TransactionOverflow`, `ConcurrentModification` |
| `append` | `ValidationError`, `StaleAppend`, `ConcurrentModification`, plus `ConditionalCheckFailed` with `.condition()` |
| `purge` | `ValidationError` |
| `Transaction.transactWrite` | `ValidationError`, `TransactionCancelled`, `UniqueConstraintViolation`, `OptimisticLockError`, `ConcurrentModification`, `ConditionalCheckFailed`, `ItemNotFound`, `TransactionOverflow`, `RefNotFound` |
| Aggregate `create` | `AggregateWriteError` plus `ConditionalCheckFailed` |
| `EventStore` `append` / `commandHandler` (plus the decider's errors, and a function-form `additionalItems` effect's `E2`) | `AppendError`: `VersionConflict`, `StreamSealed`, `DuplicateCommand`, `AdditionalItemConditionFailed`, `AppendTooLarge`, `ValidationError`, `TransactionCancelled`, `UniqueConstraintViolation`, `OptimisticLockError`, `ConcurrentModification` |
| `EventStore` `read` / `readFrom` / `currentVersion` / `readLatest` / `readIndex` | `ValidationError` |
| `EventStore` projection `apply` / `catchUp` / `rebuild` (`applyBatch` / `processBatch` carry them per instance, never failing) | `evolve`'s `E`, the read model's `get` / `put` errors (not `ItemNotFound` / `ConditionalCheckFailed`), `ValidationError`, `ConcurrentModification` |
| `EventStream.parseStreamId` | `ValidationError` |
| `EventStore` multi-source projection `catchUp` / `rebuild` (`applyBatch` / `processBatch` per row) | the sources' `evolve` errors, the read model's errors, `ValidationError`, `ConcurrentModification`, `ProjectionSourceConflict` |
| `EventStore.batchResponse`, `projection.processBatch`, `EventStore.processBatch` | `StreamRecordIdentifierMissing` (per-row errors are outcome values) |
| `EventStore` `measureAppend` / `measureSnapshot` / `decodeStreamImage`, `StorageEncoding.*`, `Entity.decodeMarshalledItem` (no `DynamoClientError`: nothing is read or written) | `ValidationError` |

`.condition()` adds `ConditionalCheckFailed` to an operation that lacks it.

---

### Key encoding: one rule for every path

Both paths compose keys through the same rule:

> Compose from the **Encoded** form, EXCEPT when the domain type is numeric
> (`number`/`bigint`) and the encoded form is a **string** — then compose from the
> numeric **Type** form so `serializeValue` encodes it in numeric order.

`serializeValue` writes numbers and bigints as numeric key text ("Numeric key text"
above) so they sort correctly; a numeric composite stored via its string wire form
would skip that encoding and sort lexicographically (`100 < 42 < 5`).
`DynamoModel.DateEpochMs` composites use the encoded epoch, which is encoded as a
number.

Every composition site routes through this one function. `test/KeyFormInvariant.test.ts`
reads each module as source text and fails if a `KeyComposer` call receives a record
that did not — the guard exists because eleven modules each deciding independently is
what produced the divergence it replaced.

**This changed stored keys in 1.16.0, and rows written before it are orphaned.**

- Entity keys and GSIs with a `Schema.BigIntFromString` or `Schema.NumberFromString`
  composite: previously written unpadded (`…#seq_420`), now padded
  (`…#seq_000…0420`). `put` succeeded and wrote those rows on 1.15.0 — only `get` was
  broken — so **this data exists and must be rewritten** (read by scan, re-`put`).
- Aggregate partition and collection keys with a `DateEpochMs` / `DateEpochSeconds`
  composite: ISO form → padded epoch. Same migration.

An earlier draft of this section argued the entity change needed no migration because
"no data existed in either format". That was wrong: on 1.15.0 `put({seq: 420n})`
succeeds and writes `seq_420`. Only reads were broken, so callers do have rows in the
old format.

Composites of every other shape — plain numbers, bigints, strings, `Schema.Date`,
`DateTimeUtc`, literals — are byte-identical and need no migration. (1.37.0 later
changed the text of negative, fractional and large numbers, and 1.39.0 made that
`escapeKeys: true`'s: see "Numeric key text".)
### Diagnostic Code Registry (`EDD-xxxx`)

Configuration and usage mistakes carry a stable `EDD-xxxx` code in the message, so an
error can be searched for without matching on prose that may be reworded. Codes are
allocated in bands by subject area; **the number is permanent once released** — retire a
code rather than reusing it for a different condition.

**Before allocating a new code, add the row here first.** The registry is the allocation
record, not a summary written afterwards. Codes had been allocated by grepping the source,
which does not see other branches in flight: two parallel branches both took `EDD-9046`
for unrelated errors and the collision was caught only at review.

| Band | Subject |
|------|---------|
| 9001–9008 | Entity definition: keys, indexes, `configure()` |
| 9010–9016 | Time-series (`timeSeries`) |
| 9020–9027 | Sparse maps, composite nullability, EventStore snapshots |
| 9030–9040 | Vector search |
| 9041–9044 | Aggregates, timestamps |
| 9045–9050 | Query sort-key conditions, `purge`, multi-item write paths, key encoding |
| 9051–9058 | Aggregate cursors, read-path descriptors, sort-key pins, client predicates, collection casing, nested aggregates, self dates |
| 9059–9061 | Planned `transactWrite` updates and deletes: cascade, return values, vector indexes |
| 9062–9067 | EventStore command path: snapshot mode, stream indexes |
| 9068–9070 | EventStore `verifySnapshot`, table shared-index agreement, vector index `dimensions` |
| 9071–9079 | Packed storage encoding (`DynamoModel.Packed`, compressors) |
| 9080–9085 | EventStore `query.index`, projections, change feed, head proof |
| 9086–9095 | Z-order indexes, range planning, skip-scan, cursors |
| 9096 | Numeric key text |
| 9097 | Retired: transactions over rows under 1.36 keys |
| 9098 | `rekey` options and resume tokens |

| Code | Raised in | Condition |
|------|-----------|-----------|
| `EDD-9001` | `Entity.ts` | Primary key declares no composite attribute in either `pk` or `sk` |
| `EDD-9002` | `Entity.ts`, `DynamoClient.ts` | An index composite names an attribute the model doesn't have (incl. Z-order prefix composites and dimensions), a `unique` constraint names one, or a required partition-key composite is missing for an index (accessor) |
| `EDD-9003` | `KeyComposer.ts` | Malformed `GsiConfig` — missing `name`/`pk`/`sk`, or the pre-v3 `index` property |
| `EDD-9004` | `DynamoClient.ts` | Sort-key composite supplied without its prior composites (prefix ordering) |
| `EDD-9005` | `Entity.ts` | TTL string is not a valid duration, or resolves to a non-finite duration |
| `EDD-9006` | `DynamoClient.ts` | Unknown composite attribute named for an index |
| `EDD-9007` | `DynamoModel.ts` | `configure()` field rename collides with an existing model field |
| `EDD-9008` | `Entity.ts` | `generatedId.field` does not name a model field, or does not participate in the key |
| `EDD-9010` | `Entity.ts` | `.history()` called on an entity with no `timeSeries` config |
| `EDD-9011` | `Entity.ts` | `timeSeries.orderBy` also appears as a primary-key composite |
| `EDD-9012` | `Entity.ts` | `timeSeries` and `versioned` are mutually exclusive |
| `EDD-9013` | `Entity.ts` | `timeSeries.appendInput` omits `orderBy` or a primary-key composite, or names a field the model doesn't have (`.append()` writes each `appendInput` field to the current item) |
| `EDD-9014` | `Entity.ts` | `timeSeries.orderBy` names a ref field |
| `EDD-9015` | `Entity.ts` | `timeSeries` and `softDelete` are mutually exclusive |
| `EDD-9016` | `Entity.ts` | `timeSeries.appendInput` is required and was not supplied |
| `EDD-9020` | `Entity.ts` | Sparse field does not exist on the model, or is not a `Schema.Record` |
| `EDD-9021` | `Entity.ts` | Sparse field has a Record-typed value schema |
| `EDD-9022` | `Entity.ts` | Sparse field is also a primary-key or GSI composite (incl. Z-order prefix composites and dimensions) |
| `EDD-9023` | `Entity.ts` | Sparse-field prefixes collide with each other or with a non-sparse field |
| `EDD-9024` | — | **Retired** in v1.7.1. Do not reuse |
| `EDD-9025` | `Errors.ts` | Composite attribute schema admits `null` (incl. Z-order prefix composites and dimensions) |
| `EDD-9026` | `EventStore.ts` | Snapshot operation on a stream with no snapshot config |
| `EDD-9027` | `EventStore.ts` | `snapshot.every` is not a positive integer |
| `EDD-9030` | — | **Retired** in #144 (vector index `dimensions` outside 1..4096): DynamoDB's rejection is diagnosed by `db.tables.*.create()` / `addVectorIndex` instead; a non-integer is `EDD-9070`. Do not reuse |
| `EDD-9031` | `VectorIndex.ts` | Vector index declares no `source.fields`, or references an unknown field |
| `EDD-9032` | `VectorIndex.ts` | Vector index lists a filter more than once. (Until #144 also: more INLINE_FILTER entries than DynamoDB allows — no longer pre-checked; DynamoDB's rejection is diagnosed by `db.tables.*.create()` / `addVectorIndex`) |
| `EDD-9033` | `VectorIndex.ts` | Two vector indexes on one entity resolve to the same physical index |
| `EDD-9034` | — | **Retired** in #144 (too many vector indexes on an entity or table): the per-table quota is adjustable, so DynamoDB's rejection is diagnosed instead. Do not reuse |
| `EDD-9035` | `Table.ts` | Entities sharing a vector index disagree on `dimensions` or `distance` |
| `EDD-9036` | `DynamoClient.ts` | No registered entity declares the requested vector index |
| `EDD-9037` | `DynamoClient.ts` | Vector index declaration mismatch at bind time |
| `EDD-9038` | `DynamoClient.ts` | Vector index name collides with an existing index |
| `EDD-9039` | `VectorIndex.ts` | Vector filter field's encoded type is not derivable from the model |
| `EDD-9040` | `Table.ts` | Vector index filter attribute is not a stored attribute |
| `EDD-9041` | `Aggregate.ts` | Aggregate collection PK field conflicts with the table's |
| `EDD-9042` | — | **Retired** in #144 (`consistentRead` against a GSI-backed aggregate collection): the assembly read is sent, and DynamoDB's rejection diagnosed, naming the aggregate and the index. Do not reuse |
| `EDD-9043` | `Aggregate.ts` | `collection.index` and `collection.sk` must be supplied together |
| `EDD-9044` | `internal/EntitySchemas.ts` | Timestamp `schema` carries no `DynamoEncoding` annotation |
| `EDD-9045` | `DynamoClient.ts` | `.where()` used on an index whose sort key has no composites — unreachable from well-typed code since the `ResolveSkFields` repair (#121); retained for untyped and cast call sites |
| `EDD-9046` | — | **Retired** in #171 (`.where()` with a strict `lt` on the last sort-key composite with an earlier composite pinned): the bound is a `BETWEEN` ending at `keyJustBelow` of the value, exact on the key. Do not reuse |
| `EDD-9047` | `Entity.ts` | `.condition()` applied to `purge()`, which spans batched writes and cannot be guarded atomically |
| `EDD-9048` | `internal/TransactableOps.ts` | A multi-item write path cannot compile a **delete** for an entity with `unique`, `versioned: { retain: true }` or `softDelete` — those side items derive from the *stored* row, which these paths never read |
| `EDD-9049` | `Batch.ts` | `Batch.write` cannot compile a write for those same configs — `BatchWriteItem` has no `ConditionExpression` (the whole basis of a uniqueness sentinel), no `UpdateRequest`, and no atomicity across chunks |
| `EDD-9050` | `internal/CompositeCodec.ts` | A key composite's value cannot be encoded to its wire form, so it cannot be placed in a key — raised rather than composing a string that silently matches nothing. A stored number its declared kind can't hold exactly (a `bigint` past 2^53 under `Schema.Number`, a fraction under `Schema.BigInt`) is one too, "is a value no number holds exactly": `rekey` reports its row as the conflict `uncomposable`, and a query operand or accessor key holding one fails the query with a `ValidationError`, sending nothing, as a value with no key text does (`refuseInexact` throws a `KeyValueError`) |
| `EDD-9051` | `Aggregate.ts` | `list({ cursor })` on a **sharded** aggregate (`list.cardinality`) — a fan-out over N partitions has no resumable position, so the cursor is rejected rather than silently ignored |
| `EDD-9052` | `Batch.ts`, `Transaction.ts` | A read path (`Batch.get`, `Transaction.transactGet`, `Transaction.check`) was handed something that is not a get descriptor — pass `Entity.get(key)` or the bound `db.entities.X.get(key)` |
| `EDD-9053` | `DynamoClient.ts` | `.where()` targets a sort-key composite the accessor already pinned — `Query.where` REPLACES the accessor's sort key condition, so the condition would discard the pin and return rows outside it rather than narrowing within it |
| `EDD-9054` | `Query.ts` | A client-side predicate (`.filterBy()`) and a projection (`.select()`) are both active — the predicate is an opaque closure, so its attribute reads cannot be borrowed into the `ProjectionExpression` the way key attributes are, and it would be handed items missing the fields it tests |
| `EDD-9055` | `KeyComposer.ts` (via `DynamoClient.ts`, `Collection.ts`) | A collection's members compose its keys with different casings (index `casing` vs schema `casing`) — they share one physical index, so their keys would never meet |
| `EDD-9056` | `Aggregate.ts` | A nested sub-aggregate binding declares a discriminator attribute it already inherits from an enclosing binding — the inner value would overwrite the outer one on the inner rows, so the parent's bindings could no longer be told apart. Use a distinct attribute name (e.g. `{ squadNo: 1 }` inside `{ clubNo: 1 }`) |
| `EDD-9057` | `internal/EntitySchemas.ts` | A `DynamoModel.configure` `storedAs` override on a union field with more than one self-date member — the override cannot say which member it applies to. Annotate the intended member with `.pipe(DynamoModel.storedAs(...))` instead |
| `EDD-9058` | `internal/EntitySchemas.ts` | A union's self-date member is stored as an epoch number next to a member also stored as a number (`Number`, a number literal, `BigInt`, another epoch date) — a stored number could belong to either, so it cannot be read back reliably. On aggregates a member whose DOMAIN is numeric (`NumberFromString`, `BigIntFromString`) is rejected too, since `update` re-decodes domain values. Store the date as a string, or remove the numeric member |
| `EDD-9059` | `internal/TransactableOps.ts` | An `update` with `.cascade(...)` in a transaction — a cascade is a follow-up write to other entities after the update commits, so it cannot share the transaction |
| `EDD-9060` | `internal/TransactableOps.ts` | `.returnValues(...)` returning an item on an `update` or `delete` in a transaction — a transaction returns no item attributes, so the mode would be dropped |
| `EDD-9061` | `internal/TransactableOps.ts` | An `update` of an entity with `vectorIndexes` in a transaction — recomputing the embedding needs the `Embedder` service, which the transact path does not provide |
| `EDD-9062` | `EventStore.ts` | `snapshot.mode` is neither `"after-append"` nor `"inline"` |
| `EDD-9063` | `EventStore.ts` | Malformed stream index: a `type` other than `"lsi"` / `"gsi"`, a `gsi` without `pk`, an `lsi` with `pk`, `partition` or `snapshot`, an empty `index` / `sk` / `pk`, a `key` / `partition` / `snapshot` that is not a function, a `snapshot` without `partition` or on a stream without a snapshot config, a `projection` other than `"all"` / `"withoutMetadata"` / `"keys"`, or a member an index entry does not declare |
| `EDD-9064` | `EventStore.ts` | A stream index attribute collides with an attribute the stream writes itself (`pk`, `sk`, `__edd_e__`, `streamId`, `version`, `eventType`, `data`, `metadata`, `timestamp`, `asOfVersion`, `state`, `commandId`, `_ttl`, `__edd_sealed__`) |
| `EDD-9065` | `EventStore.ts` | Two indexes of one stream share a physical index name or an attribute, or a GSI's `pk` and `sk` are the same attribute |
| `EDD-9066` | `EventStore.ts` | `readIndex` / `query.index` called with a name the stream does not declare (a defect; unreachable from typed code) |
| `EDD-9067` | `EventStore.ts` | `indexDefinitions` given two streams that define the same physical index differently (type, key attributes or projection); a derived partition or snapshot entry is not part of the definition |
| `EDD-9068` | `EventStore.ts` | `verifySnapshot: false` on a stream whose snapshot config is not `mode: "inline"` without `every` — thrown by `commandHandler` at handler construction, a defect from `readLatest` |
| `EDD-9069` | `Table.ts` | Table members disagree on one physical secondary index's key attributes or GSI/LSI classification (entity indexes, `_cascade_<field>` indexes, aggregate collection and list indexes), or entities declare different primary-key fields — thrown by `Table.make` and `Table.definition` |
| `EDD-9070` | `VectorIndex.ts` | Vector index `dimensions` is not an integer — DynamoDB reads an integer member leniently, so it could create the index with another, immutable dimensionality |
| `EDD-9071` | `DynamoModel.ts` | `DynamoModel.Packed(...)` options invalid: `format` other than `"json"` (`"binary"` is reserved, not yet supported), unknown `compression.codec`, `threshold` not a non-negative safe integer, or an unknown option key |
| `EDD-9072` | `Entity.ts` (schema), `Aggregate.ts`, `DynamoClient.ts` | A packed field is a key or index attribute source: a primary-key or secondary-index composite (incl. collection-injected indexes), `timeSeries.orderBy`, a vector index filter field, or an aggregate discriminator / list / collection composite (incl. Z-order prefix composites and dimensions) |
| `EDD-9073` | `Entity.ts` (schema), `EventStore.ts` | A packed field's (or packed snapshot state's) encoded side is not object/array-shaped — a scalar, a date (so never a TTL attribute), binary, a set, or a union with such a member — or the packed field does not exist on the model |
| `EDD-9074` | `Entity.ts` (schema) | A unique constraint names a packed field |
| `EDD-9075` | `Entity.ts` (schema) | A packed field is a `DynamoModel.ref` field |
| `EDD-9076` | `Query.ts`, `Entity.ts`, `internal/BoundCrud.ts`, `Transaction.ts` | A condition, filter or projection addresses a path inside a packed attribute, or applies anything but `attribute_exists` / `attribute_not_exists` to it (thrown when the expression is built; EventStore messages point to `Query.filterBy`) |
| `EDD-9077` | `Entity.ts` | An update applies anything but a whole-value `.set()` / `.remove()` to a packed field (`add`, `subtract`, `append`, `deleteFromSet`, any `path*` op) — a `ValidationError` at execution |
| `EDD-9078` | `Compression.ts`, `DynamoClient.ts`, `EventStore.ts` | A compressor registry is given two compressors for one codec, or a compressor whose `codec` is not `gzip` / `brotli` / `zstd`; or a codec a bound entity / aggregate edge / stream's `Packed` config names is not in the registry it binds with (`DynamoClient.make`, `EventStore.bind`), or in the registry an unbound stream's first operation runs with |
| `EDD-9079` | `EventStore.ts` | `makeStream` `storedAs` declares a key other than `data`, or a `storedAs` / `snapshot.storedAs` value that is not a `DynamoModel.Packed(...)` config |
| `EDD-9080` | `EventStore.ts` | `query.index` without `partition` for an index that derives its partition, or with one for a stream-scoped index (a defect; the first is unreachable from typed code) |
| `EDD-9081` | `internal/EventProjection.ts`, `internal/MultiProjection.ts` | A projection the library cannot run: a `versioned`, `softDelete` or `timeSeries` read model, a checkpoint field the model lacks, a non-integer checkpoint offset, `removal` / `outbox` on a read model with `unique` constraints, `outbox` without `revision`, `checkpoints` declaring neither `field` nor `sources`, or an `outbox` operation on a projection without one |
| `EDD-9082` | `internal/EventProjection.ts` | Two streams given to `processBatch` / `decoder` store events under the same `__edd_e__` marker |
| `EDD-9083` | `change-feed/ChangeFeed.ts` | `changeFeed` options it cannot honour: `lease.renewEvery` of half the lease `duration` or more, a `batchSize` outside 1–1000, or a `maxConcurrentReads` that is not a positive integer |
| `EDD-9084` | `change-feed/CheckpointStore.ts` | `CheckpointStore.layerDynamoDB` / `makeDynamoDB` given a `finishedTtl` under 28 hours (`CheckpointStore.minFinishedTtl`) |
| `EDD-9085` | `EventStore.ts` | A head proof that cannot work (#164): `headProof: "snapshot"` on a stream whose snapshot config is not `mode: "inline"` without `every` (a defect from `append`, thrown by `commandHandler` at handler construction); and, at handler construction, a malformed handler `headProof`, a `loadState` that is not a function, `loadState` with `verifySnapshot: false`, or `loadState` with `headProof: "snapshot"` |
| `EDD-9086` | `KeyComposer.ts` (`normalizeGsiConfig`), `Entity.ts` (schema) | Malformed Z-order sort key: `zorder` on the primary key; `zorder` / `prefix` on a partition key half; `zorder` empty, or holding an entry that is neither a field name nor an object naming its `field`; `composite` together with `zorder` / `prefix`; `prefix` without `zorder`, or not an array of fields; `type: "clustered"`; a field listed twice (two dimensions, two prefix composites, or both) |
| `EDD-9087` | `internal/ZOrderDimension.ts` (`declareDimension` through `normalizeGsiConfig`; `resolveDimension` at `Entity.make`), `KeyComposer.ts` (`prefix` `hash`) | Entry or prefix options invalid: a bound, `step`, `bits`, `from`, `bytes` or `values` list an entry can't use, options of two kinds, an option no entry of its kind takes (a misspelled option is refused, not ignored), fractional options over a `bigint` field, a float range over 2^53 levels, or a prefix `hash` outside 1..8 or a prefix part key other than `field` and `hash` |
| `EDD-9088` | `Entity.ts` (schema) | An entry doesn't fit its field, or the field's storage can't be resolved: a range on a non-numeric key form, a time window on an un-annotated number or a plain string (unknown format, so unknown order), a bare name on a field without literal members, `values` or `bits` on a plain `number` field (it takes a range), `values` of another type than the field's key form or missing a member of its literal union, a byte width on a non-string key form |
| `EDD-9089` | `Entity.ts` (schema) | Bit budget: a dimension over its kind's limit (53 bits for `int` / `float` / `dateTime` / `literals`, 128 for `string`), or `Σ bits > 512` (64 address bytes) |
| `EDD-9090` | `Entity.ts` (schema, runtime `_injectIndex`) | A Z-order index declares `collection`, or a collection injects one |
| `EDD-9091` | `Table.ts` (`Table.make`, `Table.definition`) | One physical attribute is declared with two types across table members: a Z-order (`B`) half and a string (`S`) key half, or a key attribute and a vector filter attribute |
| `EDD-9092` | `internal/ZOrderCurve.ts`: through the write paths as a `ValidationError` (put, update, upsert, restore, append, transactional and batch writes); for a query bound, `.within()` returns the builder refused and its terminal fails with a `ValidationError`, nothing sent (`Query.orRefusal`) | A value a Z-order dimension can't place: `NaN`, an unparseable date, a value outside a `literals` list |
| `EDD-9093` | `DynamoClient.ts` (accessor, accessor `.within()`), `internal/BoundQuery.ts`, `Entity.ts` (legacy `query` namespace) | Misuse reachable from untyped code. On a Z-order accessor: a dimension or prefix composite passed as an accessor composite, or `.where()` (a binary address has no text order to compare). In `.within()`: an unknown or partition key field, a composite the accessor already pinned, a composite the item doesn't store (its bound can't be checked on the row; a ref-derived `${ref}Id` is read from the stored ref), a bound that is not one of `{ eq }`, `{ between: [low, high] }`, `{ gt \| gte }` and / or `{ lt \| lte }`, a range bound on a Z-order prefix composite, `in` on a dimension that is not `literals`, a bound of the wrong key-form type, `.within()` together with `.where()` or a second `.within()`, or `.within()` on a query with no sort key composites to bound |
| `EDD-9094` | `Query.ts` (`ValidationError` at the terminal, operation `query.startFrom`), `Aggregate.ts` (`ValidationError`, operation `list`) | On `Aggregate.list`: a cursor it can't decode, or a v2 cursor holding anything but a key (#197). On a query: a cursor that doesn't belong to the query: a malformed cursor of either format, a fingerprint mismatch (other bounds, partition or direction), a v2 `.within()` cursor on a query without one, a legacy cursor for any plan other than a key or naive plan (skip-scan, filter, jump, precise, empty), or a position outside the recomputed plan (`docs/designs/zorder-indexes.md` §10.2, §10.3). On a sharded index (#183): also a wrong position count or shape, an unexpected attribute in a position, a checksum mismatch, a plain or planned cursor on a sharded query and a sharded cursor on any other query (`docs/designs/gsi-write-sharding.md` §6.6). `startFrom` itself never throws: the cursor is decoded when a terminal runs |
| `EDD-9095` | `Query.ts`, `internal/BoundQuery.ts` | Invalid library option: unknown `strategy`; `maxRanges` or `concurrency` not a positive integer; `maxSkips` not a non-negative integer; a `.pageSize()` string other than `"natural"`; `.zorder()` on a query without a Z-order accessor. Numeric `pageSize` values are not checked (DynamoDB enforces `Limit`) |
| `EDD-9096` | `internal/NumericKey.ts` (schema, via `KeyComposer.serializeValue`), and `KeyComposer.compositeText` for a `number`'s `NaN` with `escapeKeys` off: a `ValidationError` before anything is sent, on every path that composes a key ("Numeric key text"). Off refuses a `Schema.Number`'s `NaN` and composes the 1.36 text of everything else, a `Schema.NumberFromString`'s `NaN` included (`NumericKey.STORED_NAN`); `KeyText136.schema136` (`text136`) has text for a number's too | A key composite or bound with no numeric key text: `NaN` (no order), with `escapeKeys: true`, or with it off a `NaN` no row can hold (a `Schema.Number`'s); with `escapeKeys: true`, a bigint of more than 1,000 digits (past the 3-digit exponent) |
| `EDD-9097` | — | **Retired** in #183 (`ItemNotMoved`, a transaction over an item still under its 1.36 key): nothing reads or moves a row under other text but `rekey`. Do not reuse |
| `EDD-9098` | `internal/Rekey.ts` (`ValidationError`, `entityType: "Table"`, `operation: "rekey"`) | A `rekey` option that is not a positive integer (`segments`, `concurrency`, `pageSize`, `maxPages`), a malformed resume token, a token of another table, or a `segments` other than the token's. Nothing is read |

| `EDD-9099` | `KeyComposer.ts` (schema, `normalizeGsiConfig`), through `Entity.make` | Malformed `shards` (#183): `count` not an integer from 2 to 256, `previous` not a positive integer or equal to `count`, an unknown key, or `shards` on the primary key |
| `EDD-9100` | `KeyComposer.ts` (schema, `ShardSourceError` from `composePk`, the truncating composer and the update gate): a `ValidationError` on every write path; nothing is sent | A shard source value is missing when a sharded partition key half is composed. There is no unsharded fallback (§7 "Sharded partition key halves") |
| `EDD-9101` | `Entity.ts` (schema, `bindShards`) | Nothing to spread: every primary key composite is also a PK composite of the sharded index, with or without `by` |
| `EDD-9102` | `Entity.ts` (schema, `bindShards`), and the type-level guard | `by` is empty, duplicated, not a sort key composite of this index, or on a Z-order half |
| `EDD-9103` | `KeyComposer.ts` (schema, `assertCollectionShardsAgreement`), through `DynamoClient.make` and `Collections.make` | Collection members disagree on `count` or `previous`; undeclared differs from declared |
| `EDD-9104` | `Query.ts` (`refuseShardedPlan`, thrown at the call), `effect-dynamodb-geo`'s `GeoIndex.make` | Unsupported on a sharded index: `.within()`, skip-scan, `.zorder()`, `GeoIndex` |
| `EDD-9105` | `Query.ts` (`Query.concurrency`, thrown at the call) | `concurrency` not a positive integer |
| `EDD-9106` | `internal/SharedKeyAttribute.ts` (schema), through `Entity.make` and `Table.make`, and the type-level guard for a sharded half where literals show it | Two key halves of one entity stored in one attribute, sharded or not, without the same fields, in the same order and casing, or a sharded partition key with one sharded differently |
| `EDD-9108` | `internal/SharedKeyAttribute.ts` (schema), through `Entity.make` | One entity uses one physical index twice, even over the same fields |
| `EDD-9109` | `internal/SharedKeyAttribute.ts` (schema, `refuseStoredInKeyAttribute`), through `Entity.make` | A model attribute, a system timestamp or a version field is stored in a key attribute the entity writes (`writtenKeyAttributes`: the table's, and since 1.40 each secondary index's), by rename or by name; or, since 1.40, a model attribute is named as one under a rename, which moved the composed key into the field's attribute |
| `EDD-9112` | `internal/SharedKeyAttribute.ts` (schema), through `Aggregate.make` | An aggregate's list key or collection sort key is stored in a table key attribute |
| `EDD-9113` | `Entity.ts` (schema, `refuseAppendThatCannotShard`), through `Entity.make`, and the type-level guard where literals show it | A `timeSeries.appendInput` carrying a `shards.by` attribute of an index, no append of which can compose the index's key: none can hold what the key needs beside it (the partition key's composites, the other `by` attributes, or under `preserve` a sort key composite before it), and none can leave the index alone. Every append would fail with `EDD-9100`. Judged by composing each append the input allows, with and without the composites it may leave out (an optional key, or a value that may be `undefined` or `null`): an input one append of which composes loads, as up to 1.39.0, and an append that can't compose fails with `EDD-9100` when it's made |
| `EDD-9121` | `Entity.ts` (schema, `Entity.make`), and the type-level guard for a secondary index's composites; `Aggregate.make`, pure and operational (`AggregateSchemas.refuseAggregateKeyOverMovingValue`, `refuseManySortKeysOverMovingValue`) | A key over a value the library changes on every write: the `versioned` attribute in a secondary index without `retain`, or in a primary key; `timestamps.updated` in a primary key; either in `shards.by`; a stamped `updatedAt` in an aggregate's partition key or a `many` edge's sort key (§7 "Composites the library stamps") |
| `EDD-9122` | `Entity.ts` (schema, `Entity.make`) | A `configure` `field:` rename of the attribute `versioned` keeps the version in. Every read and write of the item reads the version from the attribute by that name, so the first write stored it elsewhere and every later one failed; `versioned: { field }` names the attribute. |
| `EDD-9123` | `Aggregate.ts` (`keyCompositesOrThrow`), through `composeKeysOrFail` | An aggregate's partition key or collection sort key has no value for a composite, on a write or a read, or a `list` filter leaves out a composite of the list's partition key. A `ValidationError`, before anything is written (`delete`: `AggregateAssemblyError`, its channel has no `ValidationError`). A list key with no value isn't this: the row is left out of the list. |
| `EDD-9124` | `Marshaller.ts` (`UnstorableValue`), through `marshalOrFail` and `unstorableIn`; `internal/Expr.ts` | A value has no DynamoDB form: a number that's `NaN`, `±Infinity` or past `Number.MAX_SAFE_INTEGER`, an unsupported type, an empty set in a list or tuple, or one a comparison other than `eq` / `ne` holds. A `ValidationError`, on any write, condition or filter, with nothing sent. Was a defect. An empty set on a field that can read as one isn't refused: it's stored absent (§7). |
| `EDD-9125` | `internal/SchemaAccessors.ts` (schema, `refuseUnreadable`), through `Entity.make` and `Aggregate.make`, pure and operational, `EventStore.makeStream`, and `EventStore.projection` / `multiProjection` | A model's stored side holds something its owner can't read back, at any depth, or a stream's event, `metadata` or snapshot state does, or a projection's `outbox.schema`. On every owner: `Schema.ReadonlyMap`, `Schema.HashMap`, `Schema.Chunk`, `Schema.URL`, `Schema.URLSearchParams`, `Schema.RegExp`, `Schema.FormData`, `Schema.Headers`, `Schema.File`, `Schema.ByteSize`, `Schema.ErrorInstance`, a bigint literal. On a stream, a snapshot and an outbox, and on an entity or an aggregate under another declaration, a `Schema.suspend` or a transformation over a container, other than one between lists holding the same type: `Schema.Date`, `Schema.Redacted`. `Schema.Redacted` beneath a transformation onto another type, such as `Schema.OptionFromOptional`, on every owner. A union a read can't tell a bigint from something else stored as a number in (`Schema.Number`, a number literal, `Schema.Unknown`, `Schema.Json`, a struct with a number in the same field that a read would try first, or another event), since `5n` and `5` are stored the same: on a stream, a snapshot and an outbox, and on an entity or an aggregate under another declaration, a `Schema.suspend` or a transformation. `Schema.Date` and `Schema.Redacted` also in a struct, a record, a tuple or a union with a decoding default, on an entity, and on an aggregate except for an attribute's own nullable plain date, which its date encoder stores. `Schema.Date` and `Schema.Redacted` as a later member of a `Schema.optionalKey` union, in a struct or a list there too, on an entity and an aggregate, except for an aggregate attribute's own nullable plain date. A transformation over `Schema.Date`: on an entity, a stream, a snapshot and an outbox, and on an aggregate under a union or when it decodes to something other than a date. Refused at load, naming the path and the replacement. A type is refused when any value of it is written and can't be read, whatever others do: `Schema.Literals([1n, "a"])` reads back `"a"`. Whatever's stored as something else (a transform from a record, `Schema.toCodecJson`) isn't refused, nor is the collection of a `many` edge, which is rows. `Schema.Duration`, `Schema.BigDecimal`, `Schema.HashSet` and a custom `Schema.instanceOf` aren't refused: rows of the first three read, and the last can't be told from a duck-typed `Schema.declare`, which reads back, so its values are judged at write (`EDD-9126`). |
| `EDD-9126` | `internal/RoundTrip.ts` (`notReadBack`), through `Entity.ts` (`encodeForWrite`, `notReadBackOperand`, `_refuseNotReadBack`), `Aggregate.ts` (`refuseNotReadBack`), `EventStore.ts` (`encodeToWire`) and `internal/ProjectionEngine.ts` (outbox) | A write's value of a custom declaration (a `Schema.instanceOf`, a `Schema.declare`) wouldn't read back: what the marshaller makes of it, unmarshalled, doesn't decode through the schema a read uses. A `ValidationError`, with nothing written. Only a schema holding one pays for the check (`holdsCustomDeclaration`), and a duck-typed `declare` that takes what's stored keeps writing. Rows already stored stay as they are, and still fail on read. |
| `EDD-9127` | `internal/RoundTrip.ts` (`notStoredForm`), through `Aggregate.ts` (`refuseNotReadBack`) | An aggregate write's value its field's schema can't put in its stored form, neither encoding it nor decoding then encoding it, that wouldn't read back stored as given: such a value is stored as given only when the rows read back through the read a `get` takes. A `ValidationError` naming the member and the field, on `create` and `update`, with nothing written. Only a write that stored something as given pays for the check. |
| `EDD-9128` | `internal/CompositeCodec.ts` (schema, `bothKindsKeyRefusal`, `readsBackOtherwise`, `fieldAtPath`, `storedFieldAtPath`), through `Entity.make` and `Aggregate.make`, pure and operational, and at write through `Entity.ts` (`refuseOtherKindRead`, in `encodeForWrite` and `_refuseNotReadBack`) and `Aggregate.ts` (`refuseOtherKindKeys`) | A value composed into key text from a field storing both numeric kinds: DynamoDB stores `5` and `5n` alike and a safe integer reads back as a `number`, while the two compose different key text, so a key composed again from a stored row wouldn't be the one written. Refused at load where the field declares both (`Schema.Union([Schema.Number, Schema.BigInt])`, a numeric literal or enum beside `Schema.BigInt`): on an entity, in the primary key, a secondary index half (a Z-order prefix included), a unique constraint, a vector partition and a time-series `orderBy`; on an aggregate, in its partition key, its collection and list keys and a `many` edge's sort key. A dotted composite is followed through what holds each segment, and a time-series `appendInput`'s own fields are refused as the model's are, as is one declaring the other kind than the model. In the same places, the value of a field whose kinds can't be read at load (`Schema.Unknown`, `Schema.Any`, an opaque declaration, a transform whose stored side is one) that reads back as something else is refused at write with a `ValidationError` naming the field, with nothing written; an aggregate's dotted `many` edge composite is judged at write through the field holding it (`throughFieldJudge`), never by the value at its path alone. A field no key reads may store both (§7 "Both numeric kinds"). |
| `EDD-9129` | `Aggregate.ts` (`hydrateAggregateRefs`, `refKeyComposite`) | An aggregate `create` is given an id for an edge whose `entity` is keyed by more than one distinct primary-key composite, or none, so no one id names one item to fetch (an attribute in both halves of the key is one composite). A `ValidationError` naming the edge and the key's composites, judged for every edge before anything is fetched or written. Up to 1.39.0 the fetch died composing the key (`Missing composite attribute`). |
| `EDD-9130` | `DynamoClient.ts` (`make`), through `Aggregate.ts` (`ownershipConflict`) | An aggregate declaring `ownsRows` beside another member the client sees that can write a row of one of its entity types into its partition: the message names the aggregate, the member, the type and the channel. A defect from `DynamoClient.make`, as `EDD-9037` is (§7 "Which rows in its partition are an aggregate's"). |
| `EDD-9131` | `Aggregate.ts` (`hydrateAggregateRefs`, `refIdValue`) | An aggregate `create` is given an id that is no value of the edge's entity's key composite, neither of its type nor its stored or JSON form (`"5"` for a number key), so it names no item; or an id of its type `put` refuses, as DynamoDB can't store it (`Infinity`, anywhere in a struct, an `Option` or a `Result`) or as it doesn't encode as the composite is stored (an infinity through a digits-only string codec), judged by `put`'s own rule (`Entity._unstorableKey`). A `ValidationError` naming where the id was given, what it was given, the composite and the entity, judged before anything is fetched or written. Up to 1.39.0 a string was fetched under a key no `put` writes (`RefNotFound`), and anything else was dropped. |
| `EDD-9133` | `internal/TransactableOps.ts` (`addProjectionLayout`, `projectionTtlConflict`), through `internal/ProjectionEngine.ts` (`EventStore.projection` / `multiProjection`, `preflight`) | On a projection read model one of whose projections has `removal`, one stored attribute one projection keeps in two roles: a checkpoint, checkpoint map, checkpoint owner or revision it also uses in another role, compared by stored name. Thrown by the definition that completes the conflict (the projection's own, or the first `removal`), with nothing recorded. Without `removal` nothing is refused, nor are two projections keeping one attribute in different roles. The table's TTL attribute, known only at run time, is checked by every entry point that writes a row (not the drains) before it sends anything: an attribute a projection keeps that is stored as it, while a projection's tombstones set it (`removal.ttl`), fails every projection on the read model with a `ValidationError`. |
| `EDD-9140` | `internal/SharedKeyAttribute.ts` (schema, `refuseStoredUnderLibraryAttribute` and `refuseReadAsSparseEntry`), through `Entity.make`, pure and operational, and through `DynamoClient.make` for the table's TTL attribute | An entity that would store an attribute under one the library writes itself: a model field named (under any rename) or renamed `__edd_e__` or a vector index's attribute (`__edd_v_<index>__`, `__edd_vp_<index>__`), or a timestamp or the version field so named (every row holds its entity type in `__edd_e__`, and every read filters on it), or an attribute the entity writes, under any name other than as that map's entry, that a row's reader takes as an entry of one of its sparse maps (`sparseReader`: `<prefix>#` and a non-empty key, so `<prefix>#` itself is allowed). That is every attribute a row holds under a name a definition or a table's configuration supplies: a key attribute (`writtenKeyAttributes`: the table's, each secondary index's, each vector index's), a model field by the attribute it's stored in (so a field named `data#x#y` and stored as `counter` loads), a sparse map's prefix and, under a `field:` rename, the attribute a put stores the map whole in, the timestamps and the version by the attribute they're stored in (a timestamp the model declares and renames is stored where that field is), `deletedAt` and a vector index's stash, and the table's TTL attribute for an entity that writes one, which `DynamoClient.make` checks, as the table's configuration names it. Whether an entity writes the TTL attribute is said in one place (`ttlRows`, from the functions its writes ask: `snapshotTtl`, `tombstoneTtl`, `eventTtl`): `versioned: { ttl }` without `retain` writes no snapshot, so it isn't refused at bind, and an update naming the attribute isn't refused as naming one the library manages (`unaddressable`), which it was on the release branch and wasn't on 1.39.0. A sparse map's prefix can't hold `#` (`DynamoModel.configure` refuses one), so only its renamed attribute can be read as another map's entry. The library's own fixed names hold no `#`, so none can be an entry. The reader moves such an attribute into the map: a key gives every row a phantom entry, `clearMap` removes it, and a put of that entry replaces the key; a timestamp or a renamed field leaves the row unreadable; a version reads as an entry and the row's version as 0; a TTL reads as an entry, and a time series event's is stripped with the map's entries, so the event never expires (`test/fixtures/sparse-library-attributes-1.39.0.json`). Refused at load or at bind, naming the map and the attribute. `EDD-9130` relies on it: a model attribute can be any name holding any text, but not one of these (§7 "Which rows in its partition are an aggregate's"). |

Next free code: none below `9141` (`9132` and `9134`–`9139` are taken on branches in flight, `9110` and `9111` are reserved for #189, `9114`–`9120` are taken on branches in flight, and `9107` is retired, don't reuse it); take the first code after those once they land, or `9009`, `9017`–`9019`, `9028`–`9029` within their bands.

## 16. Consumed Capacity

Opt-in reporting of the capacity every library operation consumed (#174). The full design,
with its alternatives and the review that shaped it, is `docs/designs/consumed-capacity.md`;
this section is the contract.

### 16.1 Off by default

`ConsumedCapacity.Reporting` is a `Context.Reference` whose default is "off". Off, no request
is touched: every input reaches the client as the same object, no `ReturnConsumedCapacity` is
sent, no span is created. On (`ConsumedCapacity.layer(options)` / `layerEffect` / providing
`Reporting` directly), nothing about types changes: no return type gains a field, and every
bound operation keeps `R = never`. `ConsumedCapacity.disabled` turns a subtree off.

```ts
ConsumedCapacity.layer({
  level: "total" | "indexes",   // ReturnConsumedCapacity sent; default "total"
  spans: true,                  // a span per library operation; default true
  onOperation: (report) => Effect.Effect<void>, // one call per ROOT operation
})
```

### 16.2 The choke point

Every library code path resolves the client through `Capacity.client`: an instrumented view of
whatever `DynamoClient` is in context (the built-in layer, a decorated client, a mock,
`VectorSearchEmulation`). Its 11 data-plane methods (`getItem`, `putItem`, `updateItem`,
`deleteItem`, `query`, `scan`, `batchGetItem`, `batchWriteItem`, `transactGetItems`,
`transactWriteItems`, `searchVectors`) read the setting from the calling fiber; when on they
add `ReturnConsumedCapacity` (an explicit caller value wins) and record the request into the
current operation on exit. Table-management calls pass through. Only four files may resolve the
raw service — `internal/Capacity.ts`, `DynamoClient.ts`, `internal/TransactPlan.ts` and
`VectorSearchEmulation.ts` — enforced by `test/capacity-guard.test.ts` over both packages. A
request outside every operation lands in an implicit `DynamoClient.<Command>` root, and the
coverage test (`test/ConsumedCapacity.coverage.test.ts`) fails if any library operation
produces one.

### 16.3 Operations and nesting

Each library operation opens a scope at its public entry point (`Entity.get` … `Entity.query`,
`Batch.write`, `Transaction.transactWrite`, `Aggregate.update`, `EventStream.readFrom`,
`EventStore.commandHandler`, `Projection.*`, `MultiProjection.*`, `CheckpointStore.*`,
`GeoIndex.nearby`, …). Entity ops open it in `_exec` (public terminals) and never in `_run`,
which planning (`TransactPlan`) calls. Query terminals (`Query.collect` / `execute` / `count` /
`paginate`) are **delegates**: they open a scope only when no operation is live.

- A scope opened inside another is **nested**: its requests are charged to it and to every open
  ancestor (inclusive totals), it gets a span with `effect_dynamodb.nested = true`, and it
  appears in the root report's `nested` breakdown (direct children, grouped by name) — but it
  gets no observer call. Summing observer reports never double counts.
- Work that outlives its operation (forked out with `forkDetach` / `forkIn`) is never lost:
  what it did before the operation closed is in that operation's report; afterwards it is
  charged to the nearest still-open enclosing operation, or reported as a root of its own
  (a bare request as `DynamoClient.<Command>`). Still no double counting.
- `ConsumedCapacity.withOperation(name, { target, index })` / `withOperationStream` open an
  application scope the same way.
- Streams (`paginate()`) are one operation per run, closed by a finalizer: early termination
  reports `"success"` with the pages read.
- The observer runs after the operation on its fiber, with the current operation set to a
  "suppressed" sentinel, so anything it runs (even through a client bound with reporting on)
  is neither flagged nor reported. A failure or defect in it is logged at warning level and
  never changes the result. An interrupted operation reports from a finalizer.

### 16.4 Bind time and run time

The setting is read at run time from the operation's fiber; a client bound (`DynamoClient.make`,
`Entity.bind`, `EventStore.bind` / `bindProjection`, `Aggregate.bind`, `GeoIndex.bind`) while
a setting is in context keeps it (its captured context wins). Every bind site captures its
context through `ConsumedCapacity.detachContext`, which omits the current operation and the
tracer's parent span, so later calls neither nest under the operation that was live at bind
time nor parent their spans to the span current then.

### 16.5 Reports and spans

`OperationReport`: `operation`, `target`, `index`, `capacityUnits` / `readCapacityUnits` /
`writeCapacityUnits` (DynamoDB's split when returned, otherwise attributed by command kind),
`requests`, `unreportedRequests`, `requestsByCommand`, `tables`, `byTable` (with per-index
sums under `"indexes"`), `vectorSearchRequestBytes`, `vectorWriteRequestBytes`, `nested`,
`outcome` (`"success"` / `"failure"` / `"interrupted"`).

Spans are named `effect-dynamodb.<operation>` (kind `client` for a root operation, `internal` for a nested one, so backends that count client spans as database calls count each root once) and carry `db.system.name`,
`effect_dynamodb.operation` / `.target` / `.index` / `.nested`, `aws.dynamodb.table_names`,
`aws.dynamodb.consumed_capacity.total` / `.read` / `.write` (always), `effect_dynamodb.request_count`
(always), and `effect_dynamodb.unreported_requests` / `effect_dynamodb.vector.*` (when > 0).
`ConsumedCapacity.Attributes` exports the names.

### 16.6 Failures

No DynamoDB error shape in the AWS SDK models `ConsumedCapacity`, so a failed request
(`ConditionalCheckFailed`, a cancelled transaction) counts as a request and as
`unreportedRequests`. An error that does carry it (on the error or its `cause`) is counted. A
write `TransactPlan` records for a transaction but never sends is marked "not sent" and is not
counted.

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
