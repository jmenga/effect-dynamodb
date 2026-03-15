# Migration from ElectroDB

This guide helps ElectroDB users understand effect-dynamodb. It maps ElectroDB concepts to their effect-dynamodb equivalents with side-by-side examples.

## Concept Mapping

| ElectroDB | effect-dynamodb | Notes |
|-----------|-----------------|-------|
| `Entity` definition | `Entity.make()` | ElectroDB entities define model inline; effect-dynamodb separates model (Schema.Class) from entity binding |
| `Service` | `Collection` | ElectroDB's Service groups entities; effect-dynamodb's Collection provides multi-entity queries |
| Model attributes | `Schema.Class` / `Schema.Struct` | Pure domain schemas — no DynamoDB concepts |
| `model.version` | `DynamoSchema.version` | Application schema versioning |
| `model.service` | `DynamoSchema.name` | Application namespace |
| Attribute type definitions | Effect Schema types | `Schema.String`, `Schema.Number`, `Schema.Boolean`, etc. |
| `required: true` | Schema-level required/optional | All Schema fields required by default; use `Schema.optional()` for optional |
| `readOnly: true` | `DynamoModel.Immutable` | Excluded from update input type |
| `field: "dbName"` | `DynamoModel.configure(model, { field: { field: "dbName" } })` | Domain-to-DynamoDB field renaming |
| `hidden: true` | `DynamoModel.Hidden` | Excluded from `asModel`/`asRecord` decode |
| `default: value` | Schema defaults | `Schema.withDefault(Schema.String, () => "default")` |
| `validate: RegExp` | `Schema.pattern()` / `.check()` | Composable, named validation |
| Key templates (`"USER#${userId}"`) | `composite: ["userId"]` | Attribute-list composition, not template strings |
| `entity.put(data).go()` | `yield* entity.put(data)` | Returns Effect, not Promise |
| `entity.get(key).go()` | `yield* entity.get(key)` | Returns Effect, not Promise |
| `entity.query.<name>(key).go()` | `entity.query.<name>(key).pipe(Query.execute)` | Query is a data type — execute is separate |
| `entity.create(data).go()` | `yield* entity.create(data)` | Put with `attribute_not_exists` condition |
| `entity.upsert(data).go()` | `yield* entity.upsert(data)` | Create or update with `if_not_exists` for immutable fields |
| `entity.patch(key).set({}).go()` | `entity.patch(key).pipe(entity.set(...))` | Update with `attribute_exists` — fails if item doesn't exist |
| `entity.remove(key).go()` | `yield* entity.deleteIfExists(key)` | Delete with `attribute_exists` — fails if item doesn't exist |
| `entity.scan.go()` | `entity.scan().pipe(Query.execute)` | Scan returns Query — compose with filter, limit, etc. |
| `.where()` callback | `Entity.condition()` / `Query.filter()` | Declarative condition objects, not callbacks |
| `.set({}).go()` | `entity.update(key).pipe(entity.set(updates))` | Pipeable update combinators |
| `.remove([])` | `Entity.remove(fields)` | Pipeable REMOVE combinator |
| `.add({})` | `Entity.add(values)` | Pipeable ADD combinator |
| `.subtract({})` | `Entity.subtract(values)` | Pipeable SUBTRACT combinator |
| `.append({})` | `Entity.append(values)` | Pipeable APPEND combinator |
| `.delete({})` | `Entity.deleteFromSet(values)` | Pipeable DELETE combinator |
| `consistent: true` | `Entity.consistentRead` / `Query.consistentRead` | Composable combinator |
| `response: "all_old"` | `Entity.returnValues("allOld")` | Control DynamoDB ReturnValues on update/delete |
| `pages: N` | `Query.maxPages(n)` | Limit total pages fetched |
| `ignoreOwnership: true` | `Query.ignoreOwnership` | Skip entity type filter |
| `.params()` | `Query.asParams` | Return DynamoDB command input without executing |
| `cursor` pagination | `Query.paginate` → `Stream` | Stream-based automatic pagination |
| `ElectroError` with codes | Tagged errors with `catchTag` | `DynamoError`, `ItemNotFound`, etc. |
| `client` option | `DynamoClient.layer()` | Layer-based dependency injection |
| `table` on Entity config | `Table.make()` + `table.layer()` | Table name injected at runtime via Layer |

## Side-by-Side Examples

### Model Definition

**ElectroDB:**
```typescript
const User = new Entity({
  model: { entity: "User", version: "1", service: "myapp" },
  attributes: {
    userId: { type: "string", required: true },
    email: { type: "string", required: true },
    displayName: { type: "string", required: true },
    role: { type: ["admin", "member"], required: true },
    createdBy: { type: "string", readOnly: true },
  },
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
}, { client, table: "my-table" })
```

**effect-dynamodb:**
```typescript
// 1. Model — pure domain schema (separate from DynamoDB concerns)
class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),
  createdBy: Schema.String.pipe(DynamoModel.Immutable),
}) {}

// 2. Schema + Table (equivalent to service + table config)
const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

// 3. Entity — binds model to table
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
})
```

### CRUD Operations

**ElectroDB:**
```typescript
// Create
const user = await User.put({ userId: "u-1", email: "a@b.com", ... }).go()

// Get
const { data } = await User.get({ userId: "u-1" }).go()

// Update
await User.update({ userId: "u-1" }).set({ email: "new@b.com" }).go()

// Delete
await User.delete({ userId: "u-1" }).go()
```

**effect-dynamodb:**
```typescript
const program = Effect.gen(function* () {
  // Create
  const user = yield* UserEntity.put({
    userId: "u-1", email: "a@b.com", ...
  })

  // Get
  const found = yield* UserEntity.get({ userId: "u-1" })

  // Update
  yield* UserEntity.update({ userId: "u-1" }).pipe(
    UserEntity.set({ email: "new@b.com" }),
    Entity.asRecord,
  )

  // Delete
  yield* UserEntity.delete({ userId: "u-1" })
})

// Provide dependencies via Layer (instead of constructor options)
program.pipe(
  Effect.provide(
    Layer.mergeAll(
      DynamoClient.layer({ region: "us-east-1" }),
      MainTable.layer({ name: "my-table" }),
    )
  )
)
```

### Queries

**ElectroDB:**
```typescript
// Query by index
const { data } = await User.query.byEmail({ email: "a@b.com" }).go()

// With sort key condition and filter
const { data } = await Task.query
  .byProject({ projectId: "p-1" })
  .where(({ status }, { eq }) => eq(status, "active"))
  .go({ limit: 25 })

// Pagination with cursor
let cursor = null
do {
  const result = await Task.query.byProject({ projectId: "p-1" }).go({ cursor })
  processItems(result.data)
  cursor = result.cursor
} while (cursor)
```

**effect-dynamodb:**
```typescript
// Query by index
const users = yield* UserEntity.query.byEmail({ email: "a@b.com" }).pipe(
  Query.execute,
)

// With sort key condition and filter
const tasks = yield* TaskEntity.query.byProject({ projectId: "p-1" }).pipe(
  Query.where({ status: "active" }),
  Query.limit(25),
  Query.execute,
)

// Stream-based pagination (automatic)
const stream = yield* TaskEntity.query.byProject({ projectId: "p-1" }).pipe(
  Query.paginate,
)
yield* Stream.runForEach(stream, (task) => processItem(task))
```

### Conditional Writes

**ElectroDB:**
```typescript
await User.put(data)
  .where(({ email }, { attributeNotExists }) => attributeNotExists(email))
  .go()

await User.update({ userId: "u-1" })
  .set({ status: "active" })
  .where(({ status }, { eq }) => eq(status, "pending"))
  .go()
```

**effect-dynamodb:**
```typescript
yield* UserEntity.put(data).pipe(
  Entity.condition({ attributeNotExists: "email" }),
)

yield* UserEntity.update({ userId: "u-1" }).pipe(
  UserEntity.set({ status: "active" }),
  Entity.condition({ eq: { status: "pending" } }),
  Entity.asRecord,
)
```

### Update Expressions

**ElectroDB:**
```typescript
await Product.update({ productId: "p-1" })
  .set({ name: "New Name" })
  .add({ viewCount: 1 })
  .remove(["description"])
  .append({ tags: ["new-tag"] })
  .subtract({ stock: 3 })
  .go()
```

**effect-dynamodb:**
```typescript
yield* ProductEntity.update({ productId: "p-1" }).pipe(
  ProductEntity.set({ name: "New Name" }),
  Entity.add({ viewCount: 1 }),
  Entity.remove(["description"]),
  Entity.append({ tags: ["new-tag"] }),
  Entity.subtract({ stock: 3 }),
  Entity.asRecord,
)
```

### Collections (Service)

**ElectroDB:**
```typescript
const myService = new Service({
  user: User,
  order: Order,
})

const { data } = await myService.collections.byTenant({ tenantId: "t-1" }).go()
// data.user: User[], data.order: Order[]
```

**effect-dynamodb:**
```typescript
const TenantMembers = Collection.make("TenantMembers", {
  users: UserEntity,
  orders: OrderEntity,
})

const data = yield* TenantMembers.query({ tenantId: "t-1" }).pipe(Query.execute)
// { users: User[], orders: Order[] }
```

### Transactions

**ElectroDB:**
```typescript
await myService.transaction.write(({ user, order }) => [
  user.put(newUser).commit(),
  order.delete({ orderId: "o-1" }).commit(),
  user.check({ userId: "u-1" }).where(({ email }, { attributeExists }) =>
    attributeExists(email)
  ).commit(),
]).go()
```

**effect-dynamodb:**
```typescript
yield* Transaction.transactWrite(
  UserEntity.put(newUser),
  OrderEntity.delete({ orderId: "o-1" }),
  Transaction.check(
    UserEntity.get({ userId: "u-1" }),
    { attributeExists: "email" },
  ),
)
```

### Error Handling

**ElectroDB:**
```typescript
try {
  await User.get({ userId: "u-1" }).go()
} catch (err) {
  if (err.code === 1) { /* configuration error */ }
  if (err.code === 2) { /* invalid identifier */ }
  // ... numeric error codes
}
```

**effect-dynamodb:**
```typescript
yield* UserEntity.get({ userId: "u-1" }).pipe(
  Effect.catchTag("ItemNotFound", () => Effect.succeed(null)),
  Effect.catchTag("ValidationError", (e) => Effect.die(`Bad data: ${e.message}`)),
  Effect.catchTag("DynamoError", (e) => Effect.die(`AWS error in ${e.operation}`)),
)
```

## What effect-dynamodb Adds

Features that effect-dynamodb provides that ElectroDB does not:

| Feature | Description |
|---------|-------------|
| **Built-in versioning** | `versioned: true` auto-increments version on every write. `versioned: { retain: true }` keeps version snapshots. |
| **Built-in soft delete** | `softDelete: true` marks items as deleted instead of physical deletion. Includes `restore()` and `purge()`. |
| **Built-in unique constraints** | `unique: { email: ["email"] }` enforces field-level uniqueness via sentinel items in atomic transactions. |
| **Built-in optimistic locking** | `Entity.expectedVersion(n)` fails the write if the current version doesn't match. |
| **7 derived types** | `Model`, `Record`, `Input`, `Update`, `Key`, `Item`, `Marshalled` — all auto-derived from one entity declaration. |
| **Stream pagination** | `Query.paginate` returns an Effect `Stream` for lazy, composable pagination. |
| **Layer-based DI** | Table names and DynamoDB client injected at runtime via Effect Layers — no hardcoded config. |
| **Config-based setup** | `DynamoClient.layerConfig()` reads from environment variables via Effect Config. |
| **Table definition export** | `Table.definition()` generates `CreateTableCommandInput` for CloudFormation/CDK/testing. |
| **4 decode modes** | `asModel` (clean domain), `asRecord` (with system fields), `asItem` (with DynamoDB keys), `asNative` (raw AttributeValue). |
| **Dual APIs** | All public functions support both data-first and data-last (pipeable) calling conventions. |
| **DynamoDB Streams decode** | `Entity.marshalledSchema()` and `Entity.itemSchema()` for typed stream record processing. |

## What's Different

Features in ElectroDB that work differently or are not available in effect-dynamodb:

| Feature | ElectroDB | effect-dynamodb |
|---------|-----------|-----------------|
| **Find/Match** | Auto-selects index from attributes | Not supported — use explicit `entity.query.<indexName>()` (more predictable) |
| **Getter/setter hooks** | `get`/`set` callbacks per attribute | Use Effect `Schema.transform` for equivalent functionality |
| **Calculated/virtual attributes** | Via watch + set/get | Compute at application layer or with `Schema.transform` |
| **Key templates** | `"USER#${userId}"` template strings | Attribute-list composition (`composite: ["userId"]`) — more predictable |
| **Attribute padding** | `padding: { length, char }` | Use `Schema.transform` to pad/unpad values |
| **Fluent chaining** | `entity.query.byEmail(pk).where(...).go()` | Pipe-based: `query.pipe(Query.where(...), Query.execute)` |
| **Async/Promise** | Returns Promises | Returns Effects — run via `Effect.runPromise` at the edge |

See [Advanced Topics — Working Around ElectroDB Gaps](./advanced.md#working-around-electrodb-gaps) for concrete workaround examples.
