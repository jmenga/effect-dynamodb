# Effect DynamoDB ORM - Design Specification

## 1. Philosophy & Principles

### Motivation

effect-dynamodb provides a type-safe, Effect-native DynamoDB ORM that makes single-table design first-class. The library bridges the gap between Effect's composable programming model and DynamoDB's access-pattern-driven data modeling, delivering an API where domain models are portable, storage concerns are declarative, and queries compose via pipes.

### Five Principles

1. **Domain models are portable.** A `User` schema should work with DynamoDB, SQL, or an API response — no storage concepts leak into the model.
2. **Entity owns storage concerns.** Key composition, timestamps, versioning, soft delete — all configured at the Entity level, not annotated on model fields.
3. **Convention over configuration.** The system owns key format, delimiters, and serialization. The developer declares *which* attributes compose each key, not *how*.
4. **Composable queries.** Queries are pipeable data types with combinators, not builder patterns. They follow Effect TS idioms.
5. **Type safety from declarations.** Seven types are derived automatically from Model + Table + Entity — zero manual type maintenance.

### Design Evolution

The API went through a significant redesign that established the current architecture. Key changes:

| Concern | Original | Current |
|---------|----------|---------|
| Model base class | `DynamoModel.Class` (VariantSchema) | Standard `Schema.Class` |
| Key fields | `DynamoModel.ComposedKey`, `DynamoModel.KeyField` | `DynamoModel.Immutable` (field annotation only) |
| Key composition | Template strings: `"USER#${userId}"` | Attribute lists: `composite: ["userId"]` |
| Timestamps | `DynamoModel.DateTimeInsert`, `DynamoModel.DateTimeUpdate` | `Entity.make({ timestamps: true })` |
| Versioning | Not supported | `Entity.make({ versioned: true })` |
| Soft delete | Not supported | `Entity.make({ softDelete: true })` |
| Unique constraints | Not supported | `Entity.make({ unique: { email: ["email"] } })` |
| Index definition | `keys: { primary: { pk: "USER#${userId}", sk: "METADATA" } }` | `indexes: { primary: { pk: { field: "pk", composite: ["userId"] } } }` |
| Application namespace | Not supported | `DynamoSchema.make({ name: "myapp", version: 1 })` |
| Query API | `repo.query.gsi1({ pk: {...}, sk: {...} })` → `Stream` | `Users.query.byTenant({...}).pipe(Query.where(...), Query.execute)` |
| Collections | `Collection.query(indexName, { pk, sk })` | `TenantItems.query({...}).pipe(TenantItems.users, Query.execute)` |
| Derived types | 4 (item, insert, update, key via VariantSchema) | 7 (Model, Record, Input, Update, Key, Item, Marshalled) |
| Entity operations | Flat: `repo.put`, `repo.get`, `repo.delete` | Direct on Entity: `Users.get`, `Users.put`, `Users.update`, `Users.delete`, `Users.restore`, `Users.purge`, `Users.versions`, `Users.deleted` |

The redesign moved all DynamoDB concepts out of the model layer, replaced template-string key composition with ElectroDB-style attribute lists, introduced `DynamoSchema` for application namespacing, and made Entity the repository (operations directly on the Entity object).

---

## 2. Architecture

### Module Structure

```
packages/effect-dynamodb/src/
├── DynamoModel.ts      # DynamoModel.Immutable annotation for Schema.Class/Struct fields
├── DynamoSchema.ts     # Application namespace (name + version) for key prefixing
├── Table.ts            # Minimal table grouping ({ schema }) with Layer-based name injection
├── Entity.ts           # Model-to-table binding, index definitions, CRUD + query operations
├── KeyComposer.ts      # Composite key composition from index definitions
├── Collection.ts       # Multi-entity queries with per-entity Schema decode
├── Expression.ts       # Condition, filter, and update expression builders
├── Transaction.ts      # TransactGetItems + TransactWriteItems (atomic multi-item ops)
├── Projection.ts       # ProjectionExpression builder for selecting specific attributes
├── DynamoClient.ts     # ServiceMap.Service wrapping AWS SDK DynamoDBClient
├── Marshaller.ts       # Thin wrapper around @aws-sdk/util-dynamodb
├── Errors.ts           # Tagged errors
└── index.ts            # Public API barrel export
```

### Data Flow

```
User code → Entity.put(inputData)
  → Schema.decode(Entity.Input) — validate input
  → compose keys (KeyComposer) for all indexes using composite attributes
  → add __edd_e__ + timestamps + version
  → marshall to DynamoDB format (Marshaller)
  → DynamoClient.putItem (or transactWriteItems for unique constraints)
  → Schema.decode(Entity.Record) — decode full item for return

User code → Entity.get(key)
  → compose primary key → DynamoClient.getItem
  → unmarshall → Schema.decode(Entity.Record) — validate & type

User code → Entity.query.indexName({ pk composites }).pipe(Query.collect)
  → compose PK/SK from composite attributes (KeyComposer)
  → build KeyConditionExpression + __edd_e__ FilterExpression
  → Stream.paginate (automatic DynamoDB pagination)
  → unmarshall → Schema.decode(Entity.Record) per item

User code → Collection.query(collectionName, { pk composites })
  → build KeyConditionExpression + __edd_e__ IN FilterExpression
  → Stream.paginate (automatic DynamoDB pagination)
  → unmarshall → discriminate by __edd_e__ → decode through matching entity schema
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Native build (not wrapping ElectroDB) | Full control over Effect integration, no impedance mismatch |
| Raw AWS SDK (not @effect-aws) | Avoid extra dependency; thin wrapper is simple enough |
| Effect Schema as sole schema system | Native Effect integration, bidirectional transforms, branded types |
| Schema.Class/Struct for models | Pure domain schemas — no DynamoDB concepts in models. Entity derives DynamoDB types |
| Entity IS the repository | `Entity.make()` returns definition + operations. No separate EntityRepository step |
| ElectroDB-style composite indexes | `{ pk: { field, composite }, sk: { field, composite } }` — attribute lists not templates |
| DynamoSchema for key namespacing | `$schema#v1#entity#attrs` format with `$` sentinel prefix for ORM/non-ORM coexistence |
| Table stripped to `{ schema }` | Key structure derived from entities. Physical table name injected via Layer at runtime |
| `__edd_e__` entity type attribute | Ugly name convention (like ElectroDB's `__edb_e__`) avoids collisions with user model fields |
| Single-table first | Most impactful DynamoDB pattern; multi-table is simpler subset |
| @aws-sdk/util-dynamodb for marshalling | Proven, maintained; Effect Schema handles validation layer above |

### Module Dependencies

```
Entity → DynamoClient, DynamoSchema, Table, KeyComposer, Marshaller, Expression, Errors
Collection → DynamoClient, Entity, Table, Marshaller, Errors
Transaction → DynamoClient, Entity, KeyComposer, Marshaller, Expression, Errors
Projection → (standalone, no internal deps)
Expression → Marshaller
Table → DynamoSchema
DynamoSchema → (standalone, no internal deps)
DynamoModel → effect (Schema) — provides Immutable annotation
DynamoClient → effect (ServiceMap, Layer), @aws-sdk/client-dynamodb
KeyComposer → (standalone, no internal deps)
Marshaller → @aws-sdk/util-dynamodb
Errors → effect (Data)
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

### DynamoModel.Immutable — Field Annotation

The sole export from `DynamoModel` is `Immutable`, a schema annotation that marks a field as read-only after creation. Immutable fields are excluded from `Entity.Update<E>` alongside key-referenced fields.

```typescript
import { Schema } from "effect"
import { DynamoModel } from "effect-dynamodb"

class User extends Schema.Class<User>("User")({
  userId:      Schema.String,
  email:       Schema.String,
  displayName: Schema.NonEmptyString,
  createdBy:   Schema.String.pipe(DynamoModel.Immutable),  // never changes after creation
}) {}
```

**Implementation:**

```typescript
// DynamoModel.ts — the entire public surface
const ImmutableId: unique symbol = Symbol.for("effect-dynamodb/Immutable")

export const Immutable = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.annotate({ [ImmutableId]: true }))
```

The Entity inspects each field's schema, checks for the `ImmutableId` annotation, and excludes that field from `Entity.Update<E>`.

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

### Table — Shared Reference

`Table` groups entities that share a physical DynamoDB table and application namespace. It carries the `DynamoSchema` reference used for key prefix generation. The physical table name is not declared here — it is provided at runtime via `Table.layer()`.

```typescript
import { Table } from "effect-dynamodb"

const MainTable = Table.make({
  schema: AppSchema,
})
```

| Property | Type | Description |
|----------|------|-------------|
| `schema` | `DynamoSchema` | The application schema (provides key prefixing) |

### Runtime Configuration

The physical table name is injected at runtime via Effect Layers, keeping definitions pure and environment-independent:

```typescript
// Provide physical table name at the edge
MainTable.layer({ name: "my-prod-table" })

// Or from environment variables via Effect Config
MainTable.layerConfig({ name: Config.string("TABLE_NAME") })
```

### Table.definition — Derive Infrastructure

Since the Table no longer declares key structure, it is derived from entities:

```typescript
const createTableInput = Table.definition(MainTable, [
  UserEntity, TaskEntity, ProjectMemberEntity,
])
```

### Entity — ElectroDB-Style Index Definitions

The Entity binds a model to a table with key composition rules, system field configuration, unique constraints, and collection membership.

```typescript
import { Duration } from "effect"
import { Entity } from "effect-dynamodb"

const UserEntity = Entity.make({
  model: User,
  table: MainTable,
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

### Entity as Operations Namespace

`Entity.make()` returns both a static definition and an operations namespace. The same object provides type derivation (`Entity.Record<typeof Users>`) and DynamoDB operations (`Users.put(...)`, `Users.get(...)`, `Users.query.byTenant(...)`).

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
  table: MainTable,
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
| `DynamoModel.Immutable` | Mark field as read-only after creation |

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

### Entity Operations

`Entity.make()` returns a static object that serves as both a type-level definition and an operations namespace. There is no separate repository.

#### Read Operations

```typescript
Users.get({ userId: "abc-123" })
Users.query.byTenant({ tenantId: "t-1" })

yield* Users.query.byTenant({ tenantId: "t-1" }).pipe(
  Query.where({ createdAt: { gte: lastWeek } }),
  Query.limit(25),
  Query.execute
)
```

#### Write Operations

```typescript
Users.put({ userId: "abc-123", email: "alice@example.com", displayName: "Alice", role: "admin" })
Users.update({ userId: "abc-123" }, { displayName: "Alice B" })
Users.update({ userId: "abc-123" }, { displayName: "Alice B" }, { expectedVersion: 5 })
```

#### Lifecycle Operations

```typescript
Users.delete({ userId: "abc-123" })     // soft delete (when enabled)
Users.restore({ userId: "abc-123" })    // restore soft-deleted item
Users.purge({ userId: "abc-123" })      // permanent delete
Users.getVersion({ userId: "abc-123" }, 3)  // get specific version
Users.versions({ userId: "abc-123" })   // query version history
Users.deleted.get({ userId: "abc-123" })    // get soft-deleted item
Users.deleted.list()                        // list all soft-deleted items
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
Users.update(key, changes, { expectedVersion: 5 })
// Adds ConditionExpression: version = :expected
// Fails with OptimisticLockError if version doesn't match
```

### Entity Lifecycle

#### Soft Delete

When `softDelete` is configured, `Users.delete()` performs a logical deletion:

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
5. **Cascade updates** — When denormalized data changes at the source, every item that embeds that entity must be found and updated.

A production cricket match management system built on ElectroDB demonstrates these patterns at scale — 17 model files, 16 service files, a ~1,100 line MatchService, and ~120 lines to update one player within a match. These patterns are universal to DynamoDB single-table designs.

### Concepts

**Ref** — A schema field that stores a denormalized copy of another entity's core domain data. In DynamoDB it's stored as an embedded map. The system auto-generates ID-based DTOs and hydrates on write.

**Context** — Fields on the aggregate's domain schema that must be propagated to every member item in DynamoDB for query support. Defined once at the aggregate level.

**Aggregate** — A domain object composed of multiple DynamoDB entity types that share a partition key. The underlying structure is a directed acyclic graph (DAG) where nodes are entity types and edges are relationships with cardinality.

**Optics** — Effect v4's `effect/Optic` library solves aggregate mutation: instead of manual destructuring, an optic navigates to the target and produces an updated aggregate immutably.

### Layer 1: DynamoModel.ref — Denormalized Reference Annotation

```typescript
class TeamPlayerSelection extends Schema.Class<TeamPlayerSelection>("TeamPlayerSelection")({
  id: Schema.String,
  team: Team.pipe(DynamoModel.ref),
  player: Player.pipe(DynamoModel.ref),
  role: SelectionRoleSchema,
}) {}
```

When Entity encounters a `ref`-annotated field:

| Derived Type | Behavior |
|---------|----------|
| `Entity.Input<E>` | Ref field becomes its ID type (`team: Team` → `teamId: string`) |
| `Entity.Record<E>` | Ref field is the full entity domain type (`team: Team`) |
| `Entity.Update<E>` | Ref field becomes optional ID (`teamId?: string`) |
| DynamoDB storage | Core domain data stored as embedded map attribute |
| Create/Put | Entity auto-hydrates: receives ID → fetches entity → embeds domain data |

### Layer 2: Aggregate.make() — Graph-Based Composite Domain Model

The consumer defines the aggregate's domain shape as a pure Schema.Class hierarchy, then `Aggregate.make` binds it to a graph of underlying entities.

```typescript
const MatchAggregate = Aggregate.make(Match, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: [...] } },
  context: ["name", "gender", "matchType", "league", "series", "season", "startDate"],
  root: { entityType: "MatchItem" },
  refs: { Team: TeamEntity, Player: PlayerEntity, Venue: VenueEntity, ... },

  edges: {
    venue:   Aggregate.one("venue", { entityType: "MatchVenue" }),
    team1:   TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
    team2:   TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
    umpires: Aggregate.many("umpires", { entityType: "MatchUmpire", ... }),
  },
})
```

**Four edge types:**
- `Aggregate.one()` — decomposes to separate DynamoDB item, one-to-one relationship
- `Aggregate.many()` — one item per element, one-to-many relationship
- `Aggregate.ref()` — no decomposition, hydrates inline via entity
- **BoundSubAggregate** — sub-tree with discriminator for reuse (e.g., `TeamSheetAggregate.with(...)`)

**Assembly (Read Path):**
1. Collection query: PK = aggregateId
2. Discriminate items by `__edd_e__` + discriminator into graph node buckets
3. Assemble in topological order (leaves first)
4. Return as Schema.Class instance

**Decomposition (Write Path):**
1. Hydrate all refs via batch fetch
2. Validate assembled instance via schema decode
3. Decompose by walking graph root → leaves
4. Inject context attributes into every member item
5. Write via sub-aggregate transaction groups

**Transaction Decomposition:** Each sub-aggregate is a transactional unit, keeping transactions well within DynamoDB's 100-item limit.

### Layer 3: Optic-Powered Mutations

The aggregate exposes optics derived from its Schema.Class for immutable updates:

```typescript
yield* MatchAggregate.update({ id: "match-123" }, ({ cursor }) =>
  cursor
    .key("team1").key("players").at(0)
    .modify((s) => ({ ...s, isCaptain: true }))
)
```

The `update` mutation context provides: `state` (plain object), `cursor` (pre-bound optic), `optic` (composable optic), `current` (Schema.Class instance).

### Layer 4: Cascade Updates

When a source entity changes, all items that embed it via `ref` must be updated:

```typescript
yield* PlayerEntity.update({ playerId: "player-smith" }).pipe(
  PlayerEntity.set({ displayName: "Steven Smith" }),
  Entity.cascade({ targets: [TeamPlayerSelectionEntity, MatchPlayerEntity] }),
  Entity.asRecord,
)
```

**Explicit targets required.** No implicit discovery. Default mode is eventual consistency (batch writes). Transactional mode available for small datasets.

### Aggregate vs Collection

| Capability | Collection | Aggregate |
|-----------|-----------|-----------|
| Multi-entity query | Yes | Yes (uses Collection internally) |
| Domain shape assembly | No | Yes — returns Schema.Class instance |
| Decomposition (write) | No | Yes — walks graph |
| Context propagation | No | Yes |
| Ref hydration | No | Yes — with batching |
| Optics | No | Yes |
| Diff-based updates | No | Yes — only changed sub-aggregates written |
| Transaction boundaries | No | Yes — sub-aggregate = transaction unit |

### Implementation Notes

**API Differences from Design:**
- `DynamoModel.ref` accepts `Schema.Top` directly: `Team.pipe(DynamoModel.ref)` (simpler than the designed `Schema.propertySignature(Team).pipe(DynamoModel.ref)`)
- Ref hydration uses parallel individual `Entity.get()` calls rather than `batchGet`
- Aggregate config uses runtime validation rather than compile-time type safety for edge keys, context fields, and refs bindings
- `Aggregate.update` provides `UpdateContext` with `cursor` + `optic` rather than pre-built graph-edge optics

**Deferred Features:**
- Pre-built graph-edge optics (generic `.key()` chains cover the same use cases)
- `Aggregate.Input` type extractor (recursive ref→ID transformation)
- Computed discriminators (only static literal discriminators supported)
- `TestAggregate` helper (tests set up ref entities manually)

**Behavioral Notes:**
- `Aggregate.update` does not delete orphaned items when reducing a many-edge array. Use `delete` + `create` for structural changes that remove members.
- Both `"eventual"` (default) and `"transactional"` cascade modes are supported.

---

## 12. Error Types

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

Entity operation signatures narrow error types based on Entity configuration:

```typescript
// Entity without unique constraints or versioning
Users.put(input)
// Effect<Entity.Record<E>, DynamoError, DynamoClient | Table>

// Entity with unique constraints
Users.put(input)
// Effect<Entity.Record<E>, DynamoError | UniqueConstraintViolation, DynamoClient | Table>

// Update with optimistic locking
Users.update(key, changes, { expectedVersion: 5 })
// Effect<Entity.Record<E>, DynamoError | ItemNotFound | OptimisticLockError, DynamoClient | Table>
```

---

## Appendix A: Migration Guide (v1 → v2)

### Module-by-Module Mapping

| v1 Module | v2 Module | Changes |
|-----------|-----------|---------|
| `DynamoModel.ts` | `DynamoModel.ts` | Reduced to single `Immutable` export. Models use `Schema.Class`. |
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
