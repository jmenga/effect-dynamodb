# Modeling

This guide covers how to define domain models, application schemas, tables, and entities in effect-dynamodb. These four constructs form the foundation of every application.

## Models — Pure Domain Schemas

Models use standard Effect Schema definitions — `Schema.Class` for class instances or `Schema.Struct` for plain objects. They contain only domain fields — no DynamoDB concepts, no key composition, no timestamps.

```typescript
import { Schema } from "effect"

class Employee extends Schema.Class<Employee>("Employee")({
  employeeId:  Schema.String,
  tenantId:    Schema.String,
  email:       Schema.String,
  displayName: Schema.NonEmptyString,
  department:  Schema.String,
  hireDate:    Schema.DateTimeUtcFromString,
}) {}
```

Models are portable. The same `Employee` schema can be used with DynamoDB, SQL, API responses, or any other storage backend.

### Immutable Fields

Some fields should never change after creation (beyond key fields, which are inherently immutable). Mark these with `DynamoModel.Immutable`:

```typescript
import { DynamoModel } from "effect-dynamodb"

class Employee extends Schema.Class<Employee>("Employee")({
  employeeId:  Schema.String,
  tenantId:    Schema.String,
  email:       Schema.String,
  displayName: Schema.NonEmptyString,
  department:  Schema.String,
  hireDate:    Schema.DateTimeUtcFromString,
  createdBy:   Schema.String.pipe(DynamoModel.Immutable),  // never changes
}) {}
```

`DynamoModel.Immutable` is a schema annotation. The Entity inspects it and excludes the field from `Entity.Update<E>`. The field is still present in `Entity.Input<E>` (you provide it on creation) and `Entity.Record<E>` (you can read it).

### Branded Types

Use Effect Schema's branded types for type-safe identifiers:

```typescript
class Employee extends Schema.Class<Employee>("Employee")({
  employeeId:  Schema.String.pipe(Schema.brand("EmployeeId")),
  tenantId:    Schema.String.pipe(Schema.brand("TenantId")),
  email:       Schema.String,
  displayName: Schema.NonEmptyString,
  department:  Schema.String,
  hireDate:    Schema.DateTimeUtcFromString,
}) {}
```

This prevents accidentally passing an `EmployeeId` where a `TenantId` is expected.

## DynamoSchema — Application Namespace

`DynamoSchema` defines the application-level namespace that prefixes every generated key.

```typescript
import { DynamoSchema } from "effect-dynamodb"

const AppSchema = DynamoSchema.make({
  name: "projmgmt",
  version: 1,
  casing: "lowercase",  // default
})
```

### Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | *required* | Application name, used as key prefix |
| `version` | `number` | *required* | Schema version for migration support |
| `casing` | `"lowercase" \| "uppercase" \| "preserve"` | `"lowercase"` | Casing for structural key parts |

### Why Schema Versioning?

Schema versioning enables safe migrations. Items with `$projmgmt#v1#...` keys are completely isolated from `$projmgmt#v2#...` keys:

```
$projmgmt#v1#employee#emp-alice    ← current production
$projmgmt#v2#employee#emp-alice    ← new schema version (migration in progress)
```

This supports blue/green deployments and gradual rollback.

### Why Application Namespace?

Multiple applications can share the same DynamoDB table with complete key isolation:

```
$projmgmt#v1#employee#emp-alice    ← Project Management app
$billing#v1#customer#cust-alice    ← Billing app
```

### Casing

Casing applies to **structural parts** of generated keys: schema name, version prefix, entity type, and collection name. Attribute values are always preserved as-is.

```typescript
// With casing: "lowercase" and entityType: "Employee"
// Key: $projmgmt#v1#employee#emp-alice
//      ^^^^^^^^ ^^ ^^^^^^^^            ← structural parts (lowercased)
//                           ^^^^^^^^^  ← attribute value (preserved)
```

## Table — Physical Infrastructure

`Table` declares the physical DynamoDB table: name, primary key structure, and secondary indexes.

```typescript
import { Table } from "effect-dynamodb"

const MainTable = Table.make({ schema: AppSchema })
```

The Table owns "what exists physically." The Entity owns "how I use it." Multiple entities can share the same table (single-table design).

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `schema` | `DynamoSchema` | Application schema for key prefixing |

The physical table name is provided at runtime via `MainTable.layer({ name: "ProjectManagement" })`. See [Advanced](./advanced.md) for configuration details.

## Entity — Storage Binding

The Entity binds a model to a table. It defines:
- **Indexes** — How model attributes compose into DynamoDB keys
- **System fields** — Timestamps, versioning, soft delete
- **Unique constraints** — Field-level uniqueness enforcement
- **Collections** — Cross-entity query groups

```typescript
import { Duration } from "effect"
import { Entity } from "effect-dynamodb"

const EmployeeEntity = Entity.make({
  model: Employee,
  table: MainTable,
  entityType: "Employee",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["employeeId"] },
      sk: { field: "sk", composite: [] },
    },
    byTenant: {
      index: "gsi1",
      collection: "TenantMembers",
      type: "clustered",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["department", "hireDate"] },
    },
    byEmail: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["email"] },
      sk: { field: "gsi2sk", composite: [] },
    },
  },
  unique: { email: ["email"] },
  timestamps: true,
  versioned: { retain: true, ttl: Duration.days(90) },
  softDelete: { ttl: Duration.days(30) },
})
```

### Index Definition

Each index has a logical name (e.g., `byTenant`) that becomes a query accessor on the entity. Indexes follow the ElectroDB pattern:

```typescript
byTenant: {
  index: "gsi1",              // Physical GSI name (omit for primary index)
  collection: "TenantMembers", // Collection membership (see Indexes guide)
  type: "clustered",           // "clustered" (default) or "isolated"
  pk: {
    field: "gsi1pk",           // Physical DynamoDB attribute name
    composite: ["tenantId"],   // Model attributes that compose this key
  },
  sk: {
    field: "gsi1sk",
    composite: ["department", "hireDate"],
  },
}
```

The `composite` array is an ordered list of model attribute names. The system generates the key value automatically: `$projmgmt#v1#employee#engineering#2024-01-15`.

See [Indexes & Collections](./indexes.md) for full details.

### System Fields

Configure automatic metadata at the Entity level:

```typescript
// Timestamps
timestamps: true
timestamps: { created: "registeredAt", updated: "modifiedAt" }

// Versioning
versioned: true
versioned: { retain: true }
versioned: { field: "revision", retain: true, ttl: Duration.days(90) }

// Soft delete
softDelete: true
softDelete: { ttl: Duration.days(30) }
softDelete: { ttl: Duration.days(30), preserveUnique: true }
```

See [Lifecycle](./lifecycle.md) for details on versioning and soft delete.

### Unique Constraints

```typescript
unique: {
  email: ["email"],                    // single-field
  tenantEmail: ["tenantId", "email"],  // compound
}
```

See [Data Integrity](./data-integrity.md) for details.

## Entity-Derived Types

Seven types are automatically derived from your Model + Table + Entity declarations. No manual type maintenance required.

```typescript
// Given EmployeeEntity with timestamps: true, versioned: true

Entity.Model<typeof EmployeeEntity>
// { employeeId, tenantId, email, displayName, department, hireDate, createdBy }

Entity.Record<typeof EmployeeEntity>
// Model + { version, createdAt, updatedAt }

Entity.Input<typeof EmployeeEntity>
// { employeeId, tenantId, email, displayName, department, hireDate, createdBy }

Entity.Update<typeof EmployeeEntity>
// { email?, displayName?, department?, hireDate? }
// (employeeId, tenantId excluded — primary key composites)
// (createdBy excluded — DynamoModel.Immutable)

Entity.Key<typeof EmployeeEntity>
// { employeeId }

Entity.Item<typeof EmployeeEntity>
// All physical DynamoDB attributes (pk, sk, gsi1pk, gsi1sk, __edd_e__, ...)

Entity.Marshalled<typeof EmployeeEntity>
// DynamoDB AttributeValue format ({ pk: { S: "..." }, ... })
```

### Type Hierarchy

```
Entity.Model      ← Pure domain object
    ↓ + system fields (version, timestamps)
Entity.Record     ← What the entity returns
    ↓ + key attributes (pk, sk, gsi1pk, ...)
Entity.Item       ← Full DynamoDB item (unmarshalled)
    ↓ + DynamoDB encoding
Entity.Marshalled ← DynamoDB AttributeValue format
```

`Entity.Record` extends `Entity.Model` — anywhere that accepts `Employee` also accepts a Record.

### Schema Accessors

For consuming raw DynamoDB data (e.g., DynamoDB Streams):

```typescript
// Decode an unmarshalled DynamoDB item to a Record
Entity.itemSchema(EmployeeEntity)

// Decode a marshalled (AttributeValue) DynamoDB item to a Record
Entity.marshalledSchema(EmployeeEntity)
```

See [Advanced](./advanced.md) for DynamoDB Streams usage.

## What's Next?

- [Indexes & Collections](./indexes.md) — Define access patterns with primary and secondary indexes
- [Queries](./queries.md) — Use the pipeable Query API
- [Data Integrity](./data-integrity.md) — Unique constraints and optimistic concurrency
- [Lifecycle](./lifecycle.md) — Soft delete, versioning, TTL
