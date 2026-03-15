# API Reference

Module-by-module reference for all public exports of `@effect-dynamodb/core`.

## DynamoModel

Provides annotations, date schemas, storage modifiers, and model configuration for effect-dynamodb.

```typescript
import { DynamoModel } from "effect-dynamodb"
```

### Annotations

| Export | Type | Description |
|--------|------|-------------|
| `Immutable` | `<S>(schema: S) => S` | Marks a field as immutable — excluded from `Entity.Update<E>`, present in `Entity.Input<E>` and `Entity.Record<E>` |
| `isImmutable` | `(schema: Schema.Top) => boolean` | Check if a schema field has the `Immutable` annotation |
| `Hidden` | `<S>(schema: S) => S` | Marks a field as hidden from `asModel`/`asRecord` decode. Still stored in DynamoDB, visible in `asItem`/`asNative` |
| `isHidden` | `(schema: Schema.Top) => boolean` | Check if a schema field has the `Hidden` annotation |
| `identifier` | `<S>(schema: S) => S` | Marks the primary business identifier on a model. Exactly one per entity. Required for entities referenced via `ref` |
| `isIdentifier` | `(schema: Schema.Top) => boolean` | Check if a schema field has the `identifier` annotation |
| `getIdentifierField` | `(model: Schema.Top) => { name, schema } \| undefined` | Find the identifier field in a model's `.fields` |
| `ref` | `<S>(schema: S) => S` | Marks a field as a denormalized reference to another entity. Transforms types in Entity (Input: ID, Record: full object, Update: optional ID) |
| `isRef` | `(schema: Schema.Top) => boolean` | Check if a schema field has the `ref` annotation |
| `getRefAnnotation` | `(schema: Schema.Top) => RefAnnotation \| undefined` | Get the full ref annotation metadata |

### Date Schemas

All date schemas carry a `DynamoEncoding` annotation that controls how the field is stored in DynamoDB.

| Export | Wire Type | Domain Type | DynamoDB Storage |
|--------|-----------|-------------|------------------|
| `DateString` | ISO 8601 string | `DateTime.Utc` | String (`S`) |
| `DateEpochMs` | epoch milliseconds | `DateTime.Utc` | Number (`N`) |
| `DateEpochSeconds` | epoch seconds | `DateTime.Utc` | Number (`N`) |
| `DateEpoch(opts)` | auto-detect ms/seconds | `DateTime.Utc` | configurable |
| `DateTimeZoned` | ISO+offset+zone string | `DateTime.Zoned` | String (`S`) |
| `UnsafeDateString` | ISO 8601 string | native `Date` | String (`S`) |
| `UnsafeDateEpochMs` | epoch milliseconds | native `Date` | Number (`N`) |
| `UnsafeDateEpochSeconds` | epoch seconds | native `Date` | Number (`N`) |
| `TTL` | epoch seconds | `DateTime.Utc` | Number (`N`) — alias for `DateEpochSeconds` |

### Storage Modifier

| Export | Type | Description |
|--------|------|-------------|
| `storedAs` | `<A>(storageSchema: Schema<A>) => (fieldSchema: Schema<A>) => Schema<A>` | Override DynamoDB storage format. Type-safe: domain types must match |

### Model Configuration

| Export | Type | Description |
|--------|------|-------------|
| `configure` | `(model, attributes) => ConfiguredModel<M>` | Wrap a model with per-field DynamoDB overrides (field renaming, storage encoding) |
| `isConfiguredModel` | `(value) => boolean` | Check if a value is a `ConfiguredModel` |

### Encoding Utilities

| Export | Type | Description |
|--------|------|-------------|
| `DynamoEncodingKey` | `symbol` | Annotation key for reading DynamoEncoding from schema AST |
| `getEncoding` | `(schema) => DynamoEncoding \| undefined` | Read the DynamoEncoding annotation from a schema |

### Types

| Type | Description |
|------|-------------|
| `DynamoEncoding` | `{ storage: "string" \| "epochMs" \| "epochSeconds", domain: "DateTime.Utc" \| "DateTime.Zoned" \| "Date" }` |
| `ConfiguredModel<M>` | Wrapper carrying original model + per-field attribute overrides |
| `RefAnnotation` | `{ _tag: "Ref", refSchemaId?: string }` — annotation metadata for ref fields |

### Usage

```typescript
// Annotations
class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String,
  createdBy: Schema.String.pipe(DynamoModel.Immutable),
  internalId: Schema.String.pipe(DynamoModel.Hidden),
}) {}

// Date schemas
class Event extends Schema.Class<Event>("Event")({
  eventId: Schema.String,
  startedAt: DynamoModel.DateString,               // ISO string ↔ DateTime.Utc
  expiresAt: DynamoModel.DateEpochSeconds,          // epoch seconds (for TTL)
  scheduledAt: DynamoModel.DateTimeZoned,            // with timezone
}) {}

// storedAs — override storage format
class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  // Wire: ISO string, stored in DynamoDB as epoch seconds (for TTL)
  expiresAt: DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
}) {}

// configure — field renaming + storage overrides
const OrderModel = DynamoModel.configure(Order, {
  expiresAt: { field: "ttl", storedAs: DynamoModel.DateEpochSeconds },
})

// identifier — marks primary business ID for ref resolution
class Team extends Schema.Class<Team>("Team")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}

// ref — denormalized reference to another entity
class Selection extends Schema.Class<Selection>("Selection")({
  team: Team.pipe(DynamoModel.ref),     // Input: teamId, Record: Team
  player: Player.pipe(DynamoModel.ref), // Input: playerId, Record: Player
}) {}
```

---

## DynamoSchema

Application namespace for key prefixing and versioning.

```typescript
import { DynamoSchema } from "effect-dynamodb"
```

| Export | Type | Description |
|--------|------|-------------|
| `make` | `(config) => DynamoSchema` | Create a schema with name, version, and optional casing |
| `prefix` | `(schema) => string` | Build schema prefix: `$name#vN` |
| `applyCasing` | `(schema, value) => string` | Apply casing rules to a structural key part |
| `composeKey` | `(schema, entityType, composites) => string` | Compose entity key: `$schema#vN#entity_type#composites` |
| `composeCollectionKey` | `(schema, collection, composites) => string` | Compose collection PK |
| `composeClusteredSortKey` | `(schema, collection, entity, composites) => string` | Compose clustered SK |
| `composeIsolatedSortKey` | `(schema, entity, composites) => string` | Compose isolated SK |
| `composeUniqueKey` | `(schema, entity, constraint, values) => { pk, sk }` | Compose unique constraint sentinel keys |
| `composeVersionKey` | `(schema, entity, version) => string` | Compose version snapshot SK |
| `composeDeletedKey` | `(schema, entity, timestamp) => string` | Compose soft-deleted item SK |
| `composeVersionKeyPrefix` | `(schema, entity) => string` | Prefix for version queries |
| `composeDeletedKeyPrefix` | `(schema, entity) => string` | Prefix for deleted queries |

### Types

| Type | Description |
|------|-------------|
| `DynamoSchema` | Interface: `{ name: string, version: number, casing: Casing }` |
| `Casing` | `"lowercase" \| "uppercase" \| "preserve"` |

### Usage

```typescript
const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
// Keys generated as: $myapp#v1#entity_type#composites
```

See [Modeling](./modeling.md) for details.

---

## Table

Minimal table definition with Layer-based name injection.

```typescript
import { Table } from "effect-dynamodb"
```

| Export | Type | Description |
|--------|------|-------------|
| `make` | `(config: { schema: DynamoSchema }) => Table` | Create a table definition bound to a schema |
| `definition` | `(table, entities) => TableDefinition` | Derive `CreateTableCommandInput` fields from entity index declarations |

### Types

| Type | Description |
|------|-------------|
| `Table` | Interface with `schema`, `layer()`, and `Tag` for DI |
| `TableConfig` | `{ name: string }` — runtime table configuration |
| `TableDefinition` | `{ KeySchema, AttributeDefinitions, GlobalSecondaryIndexes? }` |

### Usage

```typescript
const MainTable = Table.make({ schema: AppSchema })

// Runtime name injection via Layer
MainTable.layer({ name: "MyTable" })

// Derive CreateTable input for CloudFormation/CDK/testing
const def = Table.definition(MainTable, [UserEntity, TaskEntity])
await client.createTable({ TableName: "MyTable", BillingMode: "PAY_PER_REQUEST", ...def })
```

See [Modeling](./modeling.md) for details.

---

## Entity

The core module — binds models to tables, provides CRUD operations, query accessors, lifecycle management, and 7 derived types. This is the largest module.

```typescript
import { Entity } from "effect-dynamodb"
```

### Construction

| Export | Type | Description |
|--------|------|-------------|
| `make` | `(config) => Entity` | Create an entity with model, table, indexes, and optional system fields |

**`make` config:**

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `model` | `Schema.Class \| Schema.Struct \| ConfiguredModel` | Yes | Domain model schema (or configured model with field overrides) |
| `table` | `Table` | Yes | Table to bind to |
| `entityType` | `string` | Yes | Discriminator stored as `__edd_e__` |
| `indexes` | `Record<string, IndexDefinition>` | Yes | Key composition rules (must include `primary`) |
| `timestamps` | `boolean \| { created?, updated? }` | No | Auto-managed `createdAt`/`updatedAt` |
| `versioned` | `boolean \| { retain?, field?, ttl? }` | No | Auto-increment version with optional snapshot retention |
| `softDelete` | `boolean \| { ttl?, preserveUnique? }` | No | Soft delete with optional TTL |
| `unique` | `Record<string, string[]>` | No | Unique constraint definitions |
| `refs` | `Record<string, Entity>` | No | Map ref field names to their source entities for ref hydration |

### Operations

These are methods on the entity returned by `Entity.make()`:

| Operation | Signature | Description |
|-----------|-----------|-------------|
| `entity.put(input)` | `EntityPut` | Insert or overwrite an item |
| `entity.create(input)` | `EntityPut` | Insert only — fails with `ConditionalCheckFailed` if exists |
| `entity.upsert(input)` | `EntityPut` | Create or update — uses `if_not_exists()` for immutable fields, createdAt, version |
| `entity.get(key)` | `EntityGet` | Get a single item by primary key |
| `entity.update(key)` | `EntityUpdate` | Start an update operation (compose with `set`, `add`, etc.) |
| `entity.patch(key)` | `EntityUpdate` | Update with `attribute_exists` — fails with `ConditionalCheckFailed` if not exists |
| `entity.delete(key)` | `EntityDelete` | Delete an item |
| `entity.deleteIfExists(key)` | `EntityDelete` | Delete with `attribute_exists` — fails with `ConditionalCheckFailed` if not exists |
| `entity.scan()` | `Query<Record>` | Full table scan filtered by entity type |
| `entity.query.<indexName>(pk)` | `Query<Record>` | Query a specific index by partition key |
| `entity.batchGet(keys)` | See Batch module | Batch get items |
| `entity.batchPut(items)` | See Batch module | Batch put items |
| `entity.batchDelete(keys)` | See Batch module | Batch delete items |

**Lifecycle operations** (require matching config):

| Operation | Requires | Description |
|-----------|----------|-------------|
| `entity.getVersion(key, version)` | `versioned: { retain: true }` | Get a specific version snapshot |
| `entity.versions(key)` | `versioned: { retain: true }` | Query all version snapshots |
| `entity.deleted.get(key)` | `softDelete` | Get a soft-deleted item |
| `entity.deleted.list(key)` | `softDelete` | List soft-deleted items |
| `entity.restore(key)` | `softDelete` | Restore a soft-deleted item |
| `entity.purge(key)` | Any | Delete all items in the partition (main + versions + deleted) |

### Operation Combinators

These functions transform entity operations via pipe:

| Export | Works On | Description |
|--------|----------|-------------|
| `set(updates)` | `EntityUpdate` | Set fields to new values (dual API) |
| `expectedVersion(n)` | `EntityUpdate` | Optimistic lock — fail if version doesn't match |
| `consistentRead` | `EntityGet` | Enable strongly consistent reads |
| `condition(input)` | `EntityPut`, `EntityUpdate`, `EntityDelete` | Add a `ConditionExpression` |
| `remove(fields)` | `EntityUpdate` | REMOVE attributes from the item |
| `add(values)` | `EntityUpdate` | Atomically ADD to numeric attributes |
| `subtract(values)` | `EntityUpdate` | Subtract from numeric attributes (SET `#f = #f - :v`) |
| `append(values)` | `EntityUpdate` | Append to list attributes (`list_append`) |
| `deleteFromSet(values)` | `EntityUpdate` | DELETE elements from Set attributes |
| `returnValues(mode)` | `EntityUpdate`, `EntityDelete` | Control DynamoDB `ReturnValues`: `"none" \| "allOld" \| "allNew" \| "updatedOld" \| "updatedNew"` |
| `cascade(config)` | `EntityUpdate` | Propagate source entity changes to target entities that embed it via `DynamoModel.ref`. Config: `{ targets, filter?, mode? }` (dual API) |

### Decode Mode Selectors

Control what type an operation returns:

| Export | Returns | Description |
|--------|---------|-------------|
| `asModel` | `Entity.Model<E>` | Pure domain object (default for `yield*`) |
| `asRecord` | `Entity.Record<E>` | Domain + system fields (version, timestamps) |
| `asItem` | `Entity.Item<E>` | Full DynamoDB item (all keys + `__edd_e__`) |
| `asNative` | `Entity.Marshalled<E>` | Raw DynamoDB `AttributeValue` format |

### Type Extractors

| Type | Description |
|------|-------------|
| `Entity.Model<E>` | Pure domain object fields |
| `Entity.Record<E>` | Model + system metadata (version, timestamps) |
| `Entity.Input<E>` | Creation input (model fields, no system fields) |
| `Entity.Update<E>` | Mutable fields only (keys and immutable excluded) |
| `Entity.Key<E>` | Primary key attributes only |
| `Entity.Item<E>` | Full DynamoDB item (model + system + keys + `__edd_e__`) |
| `Entity.Marshalled<E>` | DynamoDB `AttributeValue` format |

### Schema & Attribute Accessors

| Export | Description |
|--------|-------------|
| `keyAttributes(entity)` | List all key attribute names (primary + GSI) |
| `keyFieldNames(entity)` | List physical field names for all keys |
| `compositeAttributes(entity)` | List all composite attribute names across indexes |
| `itemSchema(entity)` | Get the item-level decode schema |
| `marshalledSchema(entity)` | Get the marshalled decode schema (for DynamoDB Streams) |
| `decodeMarshalledItem(entity, item)` | Decode a marshalled DynamoDB item through entity schema |

### Usage

```typescript
const UserEntity = Entity.make({
  model: User,
  table: MainTable,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
    byEmail: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["email"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
  timestamps: true,
  versioned: true,
  unique: { email: ["email"] },
})

// CRUD
const user = yield* UserEntity.put({ userId: "u-1", email: "a@b.com", ... })
const found = yield* UserEntity.get({ userId: "u-1" })
yield* UserEntity.update({ userId: "u-1" }).pipe(
  UserEntity.set({ email: "new@b.com" }),
  UserEntity.expectedVersion(1),
  Entity.asRecord,
)
yield* UserEntity.delete({ userId: "u-1" })
```

See [Getting Started](./getting-started.md) and [Modeling](./modeling.md) for details.

---

## Query

Pipeable `Query<A>` data type — a lazy, immutable description of a DynamoDB query or scan.

```typescript
import { Query } from "effect-dynamodb"
```

### Combinators

| Export | Type | Description |
|--------|------|-------------|
| `where(conditions)` | Dual | Add sort key conditions (`KeyConditionExpression`) |
| `filter(conditions)` | Dual | Add post-read filter (`FilterExpression`) |
| `limit(n)` | Dual | Set max items per page |
| `maxPages(n)` | Dual | Limit total number of pages fetched |
| `reverse` | Combinator | Reverse sort order (descending) |
| `consistentRead` | Combinator | Enable strongly consistent reads |
| `ignoreOwnership` | Combinator | Skip `__edd_e__` entity type filter — for mixed-table scenarios |

### Terminals

| Export | Returns | Description |
|--------|---------|-------------|
| `execute` | `Effect<A[]>` | Execute and collect all pages |
| `paginate` | `Effect<Stream<A>>` | Execute and return a Stream for lazy pagination |
| `count` | `Effect<number>` | Execute with `SELECT COUNT` — returns total matching items (respects `maxPages`) |
| `asParams` | `Effect<Record<string, unknown>>` | Return built DynamoDB command input without executing — useful for debugging |

### Filter Operators

Used in `Query.filter()`:

| Operator | Example | Description |
|----------|---------|-------------|
| Equality | `{ status: "active" }` | Exact match |
| `gt` | `{ price: { gt: 30 } }` | Greater than |
| `gte` | `{ price: { gte: 30 } }` | Greater than or equal |
| `lt` | `{ price: { lt: 100 } }` | Less than |
| `lte` | `{ price: { lte: 100 } }` | Less than or equal |
| `between` | `{ price: { between: [10, 50] } }` | Inclusive range |
| `beginsWith` | `{ name: { beginsWith: "A" } }` | String prefix |
| `contains` | `{ name: { contains: "widget" } }` | Substring match |
| `exists` | `{ email: { exists: true } }` | Attribute exists |
| `notExists` | `{ email: { notExists: true } }` | Attribute does not exist |

### Utilities

| Export | Description |
|--------|-------------|
| `isQuery(value)` | Type guard for `Query<A>` |

### Usage

```typescript
const tasks = yield* TaskEntity.query.byProject({ projectId: "p-1" }).pipe(
  Query.where({ status: "active" }),
  Query.filter({ priority: { gt: 3 } }),
  Query.limit(25),
  Query.reverse,
  Query.execute,
)
```

See [Queries](./queries.md) for details.

---

## Collection

Multi-entity queries across a shared index.

```typescript
import { Collection } from "effect-dynamodb"
```

| Export | Type | Description |
|--------|------|-------------|
| `make` | `(name, entities) => Collection` | Create a collection from entities sharing an index |

### Return Value

`Collection.make()` returns an object with:

| Property | Description |
|----------|-------------|
| `query(pk)` | Start a collection query returning `{ entityA: A[], entityB: B[] }` |
| `<entityName>` | Per-entity selector — narrows query to one entity type |

### Usage

```typescript
const TenantMembers = Collection.make("TenantMembers", {
  employees: EmployeeEntity,
  tasks: TaskEntity,
})

const all = yield* TenantMembers.query({ tenantId: "t-1" }).pipe(Query.execute)
// { employees: Employee[], tasks: Task[] }

const emps = yield* TenantMembers.query({ tenantId: "t-1" }).pipe(
  TenantMembers.employees,
  Query.execute,
)
// Employee[]
```

See [Queries](./queries.md) for details.

---

## Transaction

Atomic multi-item operations.

```typescript
import { Transaction } from "effect-dynamodb"
```

| Export | Type | Description |
|--------|------|-------------|
| `transactGet` | `(items) => Effect<Tuple>` | Atomically get up to 100 items — returns a typed tuple |
| `transactWrite` | `(ops) => Effect<void>` | Atomically write up to 100 items (puts, deletes, condition checks) |
| `check` | `(get, condition) => ConditionCheckOp` | Create a condition-check operation for `transactWrite` (dual API) |

### transactGet

```typescript
const [user, order] = yield* Transaction.transactGet(
  UserEntity.get({ userId: "u-1" }),
  OrderEntity.get({ orderId: "o-1" }),
)
```

### transactWrite

```typescript
yield* Transaction.transactWrite(
  UserEntity.put({ userId: "u-1", ... }),
  OrderEntity.delete({ orderId: "o-old" }),
  Transaction.check(
    UserEntity.get({ userId: "u-1" }),
    { attributeExists: "email" },
  ),
)
```

### Types

| Type | Description |
|------|-------------|
| `ConditionCheckOp` | A condition-check operation for inclusion in `transactWrite` |

---

## Batch

Batch get and write with auto-chunking and unprocessed item retry.

```typescript
import { Batch } from "effect-dynamodb"
```

| Export | Type | Description |
|--------|------|-------------|
| `get` | `(...gets) => Effect<Tuple>` | Batch-get up to 100 items with typed tuple return |
| `write` | `(...ops) => Effect<void>` | Batch-write any number of items (auto-chunks at 25) |

### Usage

```typescript
// Batch get — typed positional results
const [user1, user2] = yield* Batch.get(
  UserEntity.get({ userId: "u-1" }),
  UserEntity.get({ userId: "u-2" }),
)

// Batch write — mixed puts and deletes
yield* Batch.write(
  UserEntity.put({ userId: "u-1", ... }),
  UserEntity.put({ userId: "u-2", ... }),
  OrderEntity.delete({ orderId: "o-old" }),
)
```

Auto-chunking: `get` chunks at 100 items, `write` chunks at 25 items. Both retry unprocessed items automatically.

---

## Expression

Condition, filter, and update expression builders.

```typescript
import { Expression } from "effect-dynamodb"
```

| Export | Type | Description |
|--------|------|-------------|
| `condition` | `(input: ConditionInput) => ExpressionResult` | Build `ConditionExpression` |
| `filter` | `(input: ConditionInput) => ExpressionResult` | Build `FilterExpression` |
| `update` | `(input: UpdateInput) => ExpressionResult` | Build `UpdateExpression` |

### ConditionInput Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `eq` | `{ eq: { status: "active" } }` | Equality |
| `ne` | `{ ne: { status: "deleted" } }` | Not equal |
| `gt`, `gte`, `lt`, `lte` | `{ gt: { price: 0 } }` | Comparisons |
| `between` | `{ between: { price: [10, 50] } }` | Inclusive range |
| `beginsWith` | `{ beginsWith: { name: "A" } }` | String prefix |
| `attributeExists` | `{ attributeExists: "email" }` | Attribute exists |
| `attributeNotExists` | `{ attributeNotExists: "pk" }` | Attribute does not exist |

### UpdateInput

| Property | Example | Description |
|----------|---------|-------------|
| `set` | `{ set: { name: "New" } }` | SET attribute values |
| `remove` | `{ remove: ["oldField"] }` | REMOVE attributes |
| `add` | `{ add: { count: 1 } }` | ADD to numeric/set attributes |
| `delete` | `{ delete: { tags: new Set(["old"]) } }` | DELETE from set attributes |

### Types

| Type | Description |
|------|-------------|
| `ExpressionResult` | `{ expression: string, names: Record, values: Record }` |
| `ConditionInput` | Declarative condition expression input |
| `UpdateInput` | Declarative update expression input |

### Usage

```typescript
const cond = Expression.condition({
  eq: { status: "active" },
  gt: { stock: 0 },
})
// cond.expression: "#status = :v0 AND #stock > :v1"
```

See [Advanced](./advanced.md) for details.

---

## Projection

ProjectionExpression builder for selecting specific attributes.

```typescript
import { Projection } from "effect-dynamodb"
```

| Export | Type | Description |
|--------|------|-------------|
| `projection` | `(attrs: string[]) => ProjectionResult` | Build `ProjectionExpression` from attribute names |

### Types

| Type | Description |
|------|-------------|
| `ProjectionResult` | `{ expression: string, names: Record<string, string> }` |

### Usage

```typescript
const proj = Projection.projection(["name", "email", "status"])
// proj.expression: "#proj_name, #proj_email, #proj_status"
// proj.names: { "#proj_name": "name", "#proj_email": "email", "#proj_status": "status" }
```

---

## KeyComposer

Composite key composition from index definitions. Used internally by Entity, also available for advanced use cases.

```typescript
import { KeyComposer } from "effect-dynamodb"
```

| Export | Type | Description |
|--------|------|-------------|
| `composePk` | `(schema, entity, index, record) => string` | Compose partition key value |
| `composeSk` | `(schema, entity, index, record) => string` | Compose sort key value |
| `composeIndexKeys` | `(schema, entity, index, record) => Record` | Compose all key attributes for an index |
| `tryComposeIndexKeys` | `(schema, entity, index, record) => Record \| undefined` | Non-throwing variant for sparse GSIs |
| `composeAllKeys` | `(schema, entity, indexes, record) => Record` | Compose keys for all indexes |
| `composeGsiKeysForUpdate` | `(schema, entity, indexes, record, updates) => Record` | Compose GSI keys for update payloads |
| `composeSortKeyPrefix` | `(schema, entity, index, composites) => string` | Partial SK prefix for `begins_with` queries |
| `extractComposites` | `(keyPart, record) => string[]` | Extract composite attribute values from a record |
| `tryExtractComposites` | `(keyPart, record) => string[] \| undefined` | Non-throwing variant |
| `serializeValue` | `(value) => string` | Serialize a value for key composition |

### Types

| Type | Description |
|------|-------------|
| `KeyPart` | `{ field: string, composite: string[] }` |
| `IndexDefinition` | `{ pk: KeyPart, sk: KeyPart, index?, collection?, type?, casing? }` |

---

## Marshaller

Thin wrapper around `@aws-sdk/util-dynamodb`.

```typescript
import { Marshaller } from "effect-dynamodb"
```

| Export | Type | Description |
|--------|------|-------------|
| `toAttributeMap` | `(record) => Record<string, AttributeValue>` | Marshall JS object to DynamoDB format |
| `fromAttributeMap` | `(item) => Record<string, unknown>` | Unmarshall DynamoDB format to JS object |
| `toAttributeValue` | `(value) => AttributeValue` | Marshall a single value |
| `fromAttributeValue` | `(av) => unknown` | Unmarshall a single value |

---

## DynamoClient

Effect service wrapping AWS SDK `DynamoDBClient`.

```typescript
import { DynamoClient } from "effect-dynamodb"
```

### Service Construction

| Export | Type | Description |
|--------|------|-------------|
| `DynamoClient` | `ServiceMap.Service` | Effect service class |
| `DynamoClient.layer(config)` | `Layer<DynamoClient>` | Create live layer with region + optional endpoint/credentials |
| `DynamoClient.layerConfig()` | `Layer<DynamoClient>` | Create live layer from Effect Config providers (env vars) |

### Service Methods

| Method | Description |
|--------|-------------|
| `createTable(input)` | Create a DynamoDB table |
| `deleteTable(input)` | Delete a DynamoDB table |
| `putItem(input)` | Put a single item |
| `getItem(input)` | Get a single item |
| `deleteItem(input)` | Delete a single item |
| `updateItem(input)` | Update an item with expression |
| `query(input)` | Query a table or index |
| `scan(input)` | Scan a table or index |
| `batchGetItem(input)` | Batch-get up to 100 items |
| `batchWriteItem(input)` | Batch-write up to 25 items |
| `transactGetItems(input)` | Transact-get up to 100 items |
| `transactWriteItems(input)` | Transact-write up to 100 items |

### Usage

```typescript
// Standard layer
DynamoClient.layer({ region: "us-east-1" })

// DynamoDB Local
DynamoClient.layer({
  region: "us-east-1",
  endpoint: "http://localhost:8000",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

// Config-based (reads DYNAMO_REGION, DYNAMO_ENDPOINT from env)
DynamoClient.layerConfig()
```

---

## Aggregate

Graph-based composite domain model for DynamoDB. Binds a Schema.Class hierarchy to a DAG of underlying entity types sharing a partition key.

```typescript
import { Aggregate } from "effect-dynamodb"
```

### Construction

| Export | Type | Description |
|--------|------|-------------|
| `make` | Overloaded | Create a sub-aggregate or top-level aggregate (see below) |
| `one` | `(name, { entityType }) => OneEdge` | Create a one-to-one edge descriptor |
| `many` | `(name, config) => ManyEdge` | Create a one-to-many edge descriptor |

**Sub-aggregate form** — `Aggregate.make(Schema, { root, edges })`:

Returns a `SubAggregate<TSchema>` with a `.with(config)` method for discriminator binding.

```typescript
const TeamSheetAggregate = Aggregate.make(TeamSheet, {
  root: { entityType: "MatchTeam" },
  edges: {
    coach: Aggregate.one("coach", { entityType: "MatchCoach" }),
    players: Aggregate.many("players", { entityType: "MatchPlayer" }),
  },
})
```

**Top-level form** — `Aggregate.make(Schema, { table, schema, pk, collection, root, refs?, edges })`:

Returns an `Aggregate<TSchema, TKey>` with `get`, `create`, `update`, `delete` operations.

```typescript
const MatchAggregate = Aggregate.make(Match, {
  table: MainTable,
  schema: CricketSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: ["name"] } },
  root: { entityType: "MatchItem" },
  refs: { Team: Teams, Player: Players, Coach: Coaches, Venue: Venues },
  edges: {
    venue: Aggregate.one("venue", { entityType: "MatchVenue" }),
    team1: TeamSheetAggregate.with({ discriminator: { teamNumber: 1 } }),
    team2: TeamSheetAggregate.with({ discriminator: { teamNumber: 2 } }),
  },
})
```

### Operations

| Operation | Signature | Description |
|-----------|-----------|-------------|
| `aggregate.get(key)` | `Effect<Domain, AggregateAssemblyError \| DynamoError \| ValidationError>` | Fetch and assemble by partition key |
| `aggregate.create(input)` | `Effect<Domain, AggregateWriteError>` | Create from input (ref IDs hydrated, sub-aggregate transactions) |
| `aggregate.update(key, fn)` | `Effect<Domain, AggregateWriteError>` | Fetch → mutate → diff → write changed groups. `fn` receives `(current, { plain, optic })` — see `UpdateContext` |
| `aggregate.delete(key)` | `Effect<void, AggregateAssemblyError \| DynamoError>` | Remove all items in the partition |

### Edge Types

| Type | Description |
|------|-------------|
| `OneEdge` | One-to-one edge: `{ _tag: "OneEdge", name, entityType }` |
| `ManyEdge` | One-to-many edge: `{ _tag: "ManyEdge", name, entityType, edgeAttributes?, sk? }` |
| `AggregateEdge` | Union: `OneEdge \| ManyEdge` |

### Interfaces

| Type | Description |
|------|-------------|
| `SubAggregate<TSchema>` | Composable sub-aggregate with `.with(config)` for discriminator binding |
| `BoundSubAggregate<TSchema>` | Discriminator-bound sub-aggregate, ready to embed in a parent |
| `Aggregate<TSchema, TKey>` | Top-level aggregate with CRUD operations |
| `UpdateContext<TIso>` | Context provided to `update` mutation: `{ plain: TIso, optic: Optic.Iso<TIso, TIso> }` |

### Type Extractors

| Type | Description |
|------|-------------|
| `Aggregate.Type<A>` | Assembled domain type (e.g., `Match`) |
| `Aggregate.Key<A>` | Partition key type |

### Type Guards

| Export | Description |
|--------|-------------|
| `isOneEdge(edge)` | Check if edge is `OneEdge` |
| `isManyEdge(edge)` | Check if edge is `ManyEdge` |

See [Aggregates & Refs](./aggregates.md) for details.

---

## Errors

Tagged error types for precise error handling with `catchTag`.

```typescript
import {
  DynamoError, ItemNotFound, ConditionalCheckFailed,
  ValidationError, TransactionCancelled,
  UniqueConstraintViolation, OptimisticLockError,
  ItemDeleted, ItemNotDeleted,
  RefNotFound, AggregateAssemblyError,
  AggregateDecompositionError, AggregateTransactionOverflow,
  CascadePartialFailure,
} from "effect-dynamodb"
```

| Error | Tag | Description |
|-------|-----|-------------|
| `DynamoError` | `"DynamoError"` | AWS SDK error wrapper (includes `operation` and `cause`) |
| `ItemNotFound` | `"ItemNotFound"` | `getItem` returned no item |
| `ConditionalCheckFailed` | `"ConditionalCheckFailed"` | Condition expression not met (put, update, delete, create) |
| `ValidationError` | `"ValidationError"` | Schema decode/encode failed |
| `TransactionCancelled` | `"TransactionCancelled"` | Transaction rejected (includes cancellation `reasons`) |
| `UniqueConstraintViolation` | `"UniqueConstraintViolation"` | Unique constraint violated on put/create |
| `OptimisticLockError` | `"OptimisticLockError"` | Version mismatch on `expectedVersion()` |
| `ItemDeleted` | `"ItemDeleted"` | Item is soft-deleted (get returns this instead of the item) |
| `ItemNotDeleted` | `"ItemNotDeleted"` | Restore called on an item that isn't soft-deleted |
| `RefNotFound` | `"RefNotFound"` | Referenced entity not found during ref hydration (`entity`, `field`, `refEntity`, `refId`) |
| `AggregateAssemblyError` | `"AggregateAssemblyError"` | Aggregate read path failed — missing items, structural violations, or decode errors (`aggregate`, `reason`, `key`) |
| `AggregateDecompositionError` | `"AggregateDecompositionError"` | Aggregate write path failed — schema validation or structural error (`aggregate`, `member`, `reason`) |
| `AggregateTransactionOverflow` | `"AggregateTransactionOverflow"` | Sub-aggregate exceeds 100-item transaction limit (`aggregate`, `subgraph`, `itemCount`, `limit`) |
| `CascadePartialFailure` | `"CascadePartialFailure"` | Cascade update partially failed in eventual mode (`sourceEntity`, `sourceId`, `succeeded`, `failed`, `errors`) |

### Usage

```typescript
const user = yield* UserEntity.get({ userId: "u-1" }).pipe(
  Effect.catchTag("ItemNotFound", () => Effect.succeed(null)),
  Effect.catchTag("DynamoError", (e) =>
    Effect.die(`DynamoDB ${e.operation} failed: ${e.cause}`)
  ),
)
```
