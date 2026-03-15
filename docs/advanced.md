# Advanced Topics

This guide covers conditional writes, create operations, rich update operations, DynamoDB Streams integration, testing patterns, multi-table setups, and expression builders.

## DynamoDB Streams

DynamoDB Streams deliver a time-ordered sequence of item-level changes. effect-dynamodb provides schemas for decoding stream records into typed domain objects.

### The Problem

DynamoDB Stream records contain items in DynamoDB's native `AttributeValue` format:

```json
{
  "pk": { "S": "$myapp#v1#employee#emp-alice" },
  "sk": { "S": "$myapp#v1#employee" },
  "__edd_e__": { "S": "Employee" },
  "email": { "S": "alice@acme.com" },
  "version": { "N": "3" }
}
```

Manually decoding this into your domain types is error-prone. effect-dynamodb provides two schema accessors for this.

### Entity.marshalledSchema — Decode from AttributeValue Format

For Lambda functions consuming DynamoDB Stream events directly:

```typescript
import { Schema } from "effect"
import { Entity } from "effect-dynamodb"

// Get the schema for decoding marshalled items
const employeeFromMarshalled = Entity.marshalledSchema(EmployeeEntity)

// In a Lambda handler
const handler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    if (record.dynamodb?.NewImage) {
      const result = Schema.decodeUnknownEither(employeeFromMarshalled)(
        record.dynamodb.NewImage
      )
      if (result._tag === "Right") {
        const employee = result.right
        // employee is Entity.Record<typeof EmployeeEntity>
        console.log(`Updated: ${employee.displayName}`)
      }
    }
  }
}
```

### Entity.itemSchema — Decode from Unmarshalled Format

If you've already unmarshalled the item (e.g., using `@aws-sdk/util-dynamodb`):

```typescript
import { Entity } from "effect-dynamodb"

const employeeFromItem = Entity.itemSchema(EmployeeEntity)

// After unmarshalling
const unmarshalled = unmarshall(record.dynamodb.NewImage)
const employee = Schema.decodeUnknownSync(employeeFromItem)(unmarshalled)
```

### Entity.Marshalled Type

The `Entity.Marshalled<E>` type represents the exact shape of a DynamoDB item in `AttributeValue` format:

```typescript
type EmployeeMarshalled = Entity.Marshalled<typeof EmployeeEntity>
// {
//   pk: { S: string },
//   sk: { S: string },
//   gsi1pk: { S: string },
//   gsi1sk: { S: string },
//   __edd_e__: { S: string },
//   employeeId: { S: string },
//   email: { S: string },
//   displayName: { S: string },
//   version: { N: string },
//   createdAt: { S: string },
//   updatedAt: { S: string },
// }
```

### Multi-Entity Stream Processing

When processing streams from a single-table design, use `__edd_e__` to discriminate:

```typescript
const handler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage
    if (!image) continue

    const entityType = image["__edd_e__"]?.S
    switch (entityType) {
      case "Employee": {
        const emp = Schema.decodeUnknownSync(
          Entity.marshalledSchema(EmployeeEntity)
        )(image)
        yield* handleEmployeeChange(emp)
        break
      }
      case "Task": {
        const task = Schema.decodeUnknownSync(
          Entity.marshalledSchema(TaskEntity)
        )(image)
        yield* handleTaskChange(task)
        break
      }
    }
  }
}
```

## Testing Patterns

### Mocking DynamoClient

effect-dynamodb uses `DynamoClient` as an Effect Service (`ServiceMap.Service`). In tests, provide a mock implementation:

```typescript
import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { DynamoClient } from "effect-dynamodb"
import { vi } from "vitest"

// Create mock functions — each returns an Effect directly
const mockPutItem = vi.fn()
const mockGetItem = vi.fn()
const mockQuery = vi.fn()
const mockUpdateItem = vi.fn()
const mockDeleteItem = vi.fn()
const mockTransactWriteItems = vi.fn()

// Create a mock DynamoClient layer — mock functions assigned directly
const MockDynamoClient = Layer.succeed(DynamoClient, {
  putItem: mockPutItem,
  getItem: mockGetItem,
  query: mockQuery,
  updateItem: mockUpdateItem,
  deleteItem: mockDeleteItem,
  transactWriteItems: mockTransactWriteItems,
  // ... other operations
})
```

### Test Example

```typescript
it.effect("creates an employee", () =>
  Effect.gen(function* () {
    // Arrange — mock functions return Effects
    mockPutItem.mockReturnValue(Effect.succeed({}))
    mockGetItem.mockReturnValue(Effect.succeed({
      Item: marshall({
        pk: "$myapp#v1#employee#emp-1",
        sk: "$myapp#v1#employee",
        __edd_e__: "Employee",
        employeeId: "emp-1",
        email: "alice@acme.com",
        displayName: "Alice",
        department: "Engineering",
        hireDate: "2024-01-15T00:00:00.000Z",
        version: 1,
        createdAt: "2024-01-15T10:30:00.000Z",
        updatedAt: "2024-01-15T10:30:00.000Z",
      }),
    }))

    // Act
    const result = yield* EmployeeEntity.put({
      employeeId: "emp-1",
      email: "alice@acme.com",
      displayName: "Alice",
      department: "Engineering",
      hireDate: DateTime.unsafeMake("2024-01-15"),
      createdBy: "admin",
    })

    // Assert
    expect(result.employeeId).toBe("emp-1")
    expect(result.displayName).toBe("Alice")
    expect(mockPutItem).toHaveBeenCalledOnce()
  }).pipe(Effect.provide(MockDynamoClient))
)
```

### Testing Error Paths

```typescript
it.effect("handles unique constraint violation", () =>
  Effect.gen(function* () {
    // Simulate TransactionCanceledException — return a failed Effect
    mockTransactWriteItems.mockReturnValue(
      Effect.fail(new DynamoError({ operation: "TransactWriteItems", cause: new Error("TransactionCanceledException") }))
    )

    const result = yield* UserEntity.put({
      userId: "u-1",
      email: "taken@example.com",
      displayName: "Test",
    }).pipe(Effect.flip)

    expect(result._tag).toBe("UniqueConstraintViolation")
  }).pipe(Effect.provide(MockDynamoClient))
)
```

### Testing Queries

```typescript
it.effect("queries tasks by project", () =>
  Effect.gen(function* () {
    mockQuery.mockReturnValue(Effect.succeed({
      Items: [
        marshall({
          pk: "$myapp#v1#task#t-1",
          __edd_e__: "Task",
          taskId: "t-1",
          projectId: "proj-alpha",
          status: "active",
          // ...
        }),
      ],
      LastEvaluatedKey: undefined,
    }))

    const tasks = yield* TaskEntity.query.byProject({ projectId: "proj-alpha" }).pipe(
      Query.where({ status: "active" }),
      Query.execute,
    )

    expect(tasks).toHaveLength(1)
    expect(tasks[0].taskId).toBe("t-1")
  }).pipe(Effect.provide(MockDynamoClient))
)
```

## Multi-Table Design

While single-table design is the default pattern, effect-dynamodb supports entities on different tables.

### Multiple Tables

```typescript
const UserTable = Table.make({ schema: AppSchema })
const AuditTable = Table.make({ schema: AppSchema })

const UserEntity = Entity.make({
  model: User,
  table: UserTable,     // ← different table
  entityType: "User",
  // ...
})

const AuditEntity = Entity.make({
  model: AuditEntry,
  table: AuditTable,    // ← different table
  entityType: "AuditEntry",
  // ...
})

// Provide physical table names at runtime
program.pipe(
  Effect.provide(
    Layer.mergeAll(
      DynamoClient.layer({ region: "us-east-1" }),
      UserTable.layer({ name: "Users" }),
      AuditTable.layer({ name: "AuditLog" }),
    )
  ),
)
```

### When to Use Multiple Tables

| Single Table | Multiple Tables |
|-------------|-----------------|
| Related entities queried together | Independent entity groups |
| Need cross-entity queries (collections) | No cross-entity query need |
| Fewer provisioned tables to manage | Different capacity settings per table |
| Index overloading (one GSI serves many patterns) | Simpler, entity-specific indexes |

### Considerations

- **Collections require the same table.** All entities in a collection must share a table.
- **Transactions can span tables.** DynamoDB transactions work across tables.
- **Each table is a separate DynamoDB resource.** Separate provisioning, backups, and billing.

## Conditional Writes

`Entity.condition()` adds a `ConditionExpression` to any mutation (put, update, delete). The condition is evaluated server-side — if it fails, the operation is rejected with `ConditionalCheckFailed`.

```typescript
import { Entity, Expression } from "effect-dynamodb"

// Conditional put — only if item doesn't already exist
yield* UserEntity.put(newUser).pipe(
  Entity.condition({ attributeNotExists: "pk" }),
)

// Conditional delete — only if stock is zero
yield* ProductEntity.delete({ productId: "p-1" }).pipe(
  Entity.condition({ eq: { stock: 0 } }),
)

// Conditional update — only if status is "active"
yield* TaskEntity.update({ taskId: "t-1" }).pipe(
  TaskEntity.set({ status: "done" }),
  Entity.condition({ eq: { status: "active" } }),
  Entity.asRecord,
)
```

### Conditions compose with optimistic locking

When using `Entity.condition()` on an update that also has `Entity.expectedVersion()`, the user condition is ANDed with the version check:

```typescript
yield* ProductEntity.update({ productId: "p-1" }).pipe(
  ProductEntity.set({ price: 24.99 }),
  ProductEntity.expectedVersion(3),
  Entity.condition({ gt: { stock: 0 } }),
  Entity.asRecord,
)
// ConditionExpression: (#version = :v_lock) AND (#stock > :v0)
```

### Handling ConditionalCheckFailed

```typescript
const result = yield* UserEntity.put(newUser)
  .pipe(Entity.condition({ attributeNotExists: "pk" }))
  .asEffect()
  .pipe(
    Effect.catchTag("ConditionalCheckFailed", () =>
      Effect.succeed("already exists")
    ),
  )
```

## Create Operation

`Entity.create()` is a convenience for "put if not exists" — it's `Entity.put()` with an automatic `attribute_not_exists` condition on the primary key:

```typescript
// Create — fails with ConditionalCheckFailed if item already exists
const user = yield* UserEntity.create({
  userId: "u-1",
  email: "alice@example.com",
  displayName: "Alice",
})

// Equivalent to:
yield* UserEntity.put({...}).pipe(
  Entity.condition({ attributeNotExists: "pk" }),
)
```

## Rich Update Operations

Beyond `Entity.set()`, effect-dynamodb provides combinators for all DynamoDB update expression types. All compose in a single pipe and execute as one `UpdateItem` call.

### Entity.remove — REMOVE attributes

Deletes attributes entirely from the item:

```typescript
yield* ProductEntity.update({ productId: "p-1" }).pipe(
  Entity.remove(["description", "temporaryFlag"]),
  Entity.asRecord,
)
```

### Entity.add — Atomic increment (ADD)

Atomically increments numeric attributes. Thread-safe — no read-modify-write cycle:

```typescript
yield* ProductEntity.update({ productId: "p-1" }).pipe(
  Entity.add({ viewCount: 1, stock: 50 }),
  Entity.asRecord,
)
```

### Entity.subtract — Atomic decrement

Synthesizes `SET #field = #field - :val` (DynamoDB has no native subtract):

```typescript
yield* ProductEntity.update({ productId: "p-1" }).pipe(
  Entity.subtract({ stock: 3 }),
  Entity.asRecord,
)
```

### Entity.append — List append

Appends elements to the end of a list attribute using `list_append`:

```typescript
yield* ProductEntity.update({ productId: "p-1" }).pipe(
  Entity.append({ tags: ["on-sale", "featured"] }),
  Entity.asRecord,
)
```

### Entity.deleteFromSet — Remove elements from a Set

Removes specific elements from a DynamoDB Set attribute (StringSet, NumberSet):

```typescript
yield* ProductEntity.update({ productId: "p-1" }).pipe(
  Entity.deleteFromSet({ categories: new Set(["obsolete"]) }),
  Entity.asRecord,
)
```

### Composing multiple update types

All update combinators compose in a single pipe — they are merged into one `UpdateItem` call:

```typescript
yield* ProductEntity.update({ productId: "p-1" }).pipe(
  ProductEntity.set({ name: "Premium Mouse", price: 39.99 }),
  Entity.add({ viewCount: 10 }),
  Entity.subtract({ stock: 5 }),
  Entity.append({ tags: ["premium"] }),
  Entity.remove(["temporaryNote"]),
  ProductEntity.expectedVersion(3),
  Entity.asRecord,
)
```

## Expression Builders

For advanced use cases, the `Expression` module provides condition, filter, and update expression builders:

```typescript
import { Expression } from "effect-dynamodb"

// Condition expression (for conditional writes)
const cond = Expression.condition({
  email: { attributeExists: true },
  status: { ne: "deleted" },
})

// Filter expression (for query post-filtering)
const filter = Expression.filter({
  priority: { in: ["high", "critical"] },
  title: { contains: "urgent" },
})

// Update expression
const update = Expression.update({
  set: { displayName: "New Name", updatedAt: new Date().toISOString() },
  remove: ["temporaryFlag"],
  add: { loginCount: 1 },
})
```

These are used internally by the entity but available for advanced operations.

## Batch Operations

The entity provides batch operations that automatically handle DynamoDB limits (chunking) and retry unprocessed items:

```typescript
// Batch get (auto-chunks at 100 items)
const users = yield* UserEntity.batchGet([
  { userId: "u-1" },
  { userId: "u-2" },
  { userId: "u-3" },
])

// Batch write (auto-chunks at 25 items)
yield* UserEntity.batchPut([
  { userId: "u-1", email: "a@b.com", displayName: "A" },
  { userId: "u-2", email: "b@c.com", displayName: "B" },
])

yield* UserEntity.batchDelete([
  { userId: "u-1" },
  { userId: "u-2" },
])
```

Note: Batch operations do **not** enforce unique constraints (no transactional guarantees). Use individual `put`/`delete` for entities with unique constraints.

## Working Around ElectroDB Gaps

Some ElectroDB features are intentionally not implemented in effect-dynamodb because Effect TS provides equivalent or better mechanisms. This section documents concrete workarounds for each.

### Getter/Setter Hooks → Schema.transform

ElectroDB's `get`/`set` callbacks transform values on read/write. Effect Schema transforms provide the same capability declaratively:

```typescript
import { Schema } from "effect"

// ElectroDB: { get: (val) => val.toLowerCase(), set: (val) => val.trim() }
// effect-dynamodb: Schema.transform
const NormalizedEmail = Schema.transform(
  Schema.String, // wire format
  Schema.String, // domain format
  {
    decode: (s) => s.toLowerCase().trim(),  // equivalent to "get"
    encode: (s) => s.toLowerCase().trim(),  // equivalent to "set"
  },
)

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: NormalizedEmail,  // transforms applied automatically
}) {}
```

### Calculated/Virtual Attributes → Application Layer

ElectroDB uses `watch` + `set`/`get` for computed fields. In effect-dynamodb, compute these in your application layer:

```typescript
// Calculated attribute (persisted): compute on write
const createOrder = (input: OrderInput) =>
  OrderEntity.put({
    ...input,
    totalWithTax: input.subtotal * (1 + input.taxRate),  // calculated before write
  })

// Virtual attribute (never persisted): compute on read
const enrichUser = (user: typeof UserEntity.Type) => ({
  ...user,
  displayLabel: `${user.displayName} (${user.role})`,  // computed from stored fields
})

// Or use Schema.transform for automatic enrichment
const UserWithLabel = Schema.transform(
  User,
  Schema.Struct({ ...User.fields, displayLabel: Schema.String }),
  {
    decode: (u) => ({ ...u, displayLabel: `${u.displayName} (${u.role})` }),
    encode: ({ displayLabel, ...rest }) => rest,
  },
)
```

### Find/Match → Explicit Index Queries

ElectroDB's `find()` auto-selects an index based on provided attributes. In effect-dynamodb, use explicit index names — this is more predictable and avoids ElectroDB's own warning that the selection algorithm may change:

```typescript
// ElectroDB: entity.find({ email: "alice@acme.com" }).go()
// effect-dynamodb: explicitly name the index
const users = yield* UserEntity.query.byEmail({ email: "alice@acme.com" }).pipe(
  Query.execute,
)

// ElectroDB: entity.match({ status: "active", department: "eng" }).go()
// effect-dynamodb: query the right index + filter
const users = yield* UserEntity.query.byDepartment({ department: "eng" }).pipe(
  Query.filter({ status: "active" }),
  Query.execute,
)
```

### Attribute Padding → Schema.transform

ElectroDB's `padding: { length, char }` pads values in sort keys. Use Schema transforms:

```typescript
const PaddedNumber = Schema.transform(
  Schema.String,     // wire: "42"
  Schema.Number,     // domain: 42
  {
    decode: (s) => Number.parseInt(s, 10),
    encode: (n) => String(n).padStart(10, "0"),  // "0000000042" in DynamoDB
  },
)

class Invoice extends Schema.Class<Invoice>("Invoice")({
  customerId: Schema.String,
  invoiceNumber: PaddedNumber,  // padded automatically in keys
}) {}
```

### Data Callback → Pipe Composition

ElectroDB's `.data((attrs, ops) => ...)` allows arbitrary update logic. In effect-dynamodb, compose update operations in a pipe:

```typescript
// ElectroDB: entity.update(key).data((attrs, { set, add, remove }) => { ... }).go()
// effect-dynamodb: compose individual operations
yield* ProductEntity.update({ productId: "p-1" }).pipe(
  ProductEntity.set({ name: "Updated Name", status: "active" }),
  Entity.add({ viewCount: 1 }),
  Entity.subtract({ stock: 3 }),
  Entity.remove(["temporaryFlag"]),
  Entity.append({ tags: ["featured"] }),
  Entity.asRecord,
)
```

### Nested Property Updates → Full Object or DynamoClient

ElectroDB supports dot-notation for nested map updates. In effect-dynamodb, either update the full object or use `DynamoClient` directly:

```typescript
// Option 1: Update the full nested object via Entity.set
yield* UserEntity.update({ userId: "u-1" }).pipe(
  UserEntity.set({
    preferences: { theme: "dark", language: "en", notifications: true },
  }),
  Entity.asRecord,
)

// Option 2: Use DynamoClient directly for surgical nested updates
const client = yield* DynamoClient
yield* client.updateItem({
  TableName: "MyTable",
  Key: { pk: { S: "$myapp#v1#user#u-1" }, sk: { S: "$myapp#v1#user" } },
  UpdateExpression: "SET #prefs.#theme = :theme",
  ExpressionAttributeNames: { "#prefs": "preferences", "#theme": "theme" },
  ExpressionAttributeValues: { ":theme": { S: "dark" } },
})
```

### DynamoDB Native Set → Arrays or DynamoClient

DynamoDB native Sets (StringSet, NumberSet) are less common than lists. Use arrays in most cases:

```typescript
// Use arrays — works with standard Schema types
class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  tags: Schema.Array(Schema.String),        // stored as DynamoDB List (L)
  categories: Schema.Array(Schema.String),   // stored as DynamoDB List (L)
}) {}

// For true DynamoDB Set operations (if needed for atomic set math):
const client = yield* DynamoClient
yield* client.updateItem({
  TableName: "MyTable",
  Key: { /* ... */ },
  UpdateExpression: "ADD #tags :newTags",
  ExpressionAttributeNames: { "#tags": "tags" },
  ExpressionAttributeValues: { ":newTags": { SS: ["new-tag-1", "new-tag-2"] } },
})
```

### Hydrate (KEYS_ONLY GSI) → Query + Batch.get

ElectroDB's `hydrate: true` auto-fetches full items after a KEYS_ONLY GSI query. Compose this in a pipe:

```typescript
import { Batch, Query } from "effect-dynamodb"

// Step 1: Query GSI (returns items with keys only)
const partialItems = yield* UserEntity.query.byStatus({ status: "active" }).pipe(
  Query.execute,
)

// Step 2: Batch-get full items using the keys
const keys = partialItems.map((item) => ({ userId: item.userId }))
const fullItems = yield* UserEntity.batchGet(keys)
```

### Conversion Utilities → KeyComposer

ElectroDB provides utilities to convert between composites, keys, and cursors. Use `KeyComposer` functions directly:

```typescript
import { KeyComposer, DynamoSchema } from "effect-dynamodb"

const schema = DynamoSchema.make({ name: "myapp", version: 1 })

// Compose a partition key from attributes
const pk = KeyComposer.composePk(schema, "User", primaryIndex, { userId: "u-1" })
// → "$myapp#v1#user#u-1"

// Compose a sort key
const sk = KeyComposer.composeSk(schema, "User", primaryIndex, {})
// → "$myapp#v1#user"

// Compose all keys for an index
const keys = KeyComposer.composeIndexKeys(schema, "User", primaryIndex, { userId: "u-1" })
// → { pk: "...", sk: "..." }
```

## What's Next?

- [Getting Started](./getting-started.md) — Quick start guide
- [Modeling](./modeling.md) — Model, schema, table, entity definitions
- [Indexes & Collections](./indexes.md) — Access pattern design
