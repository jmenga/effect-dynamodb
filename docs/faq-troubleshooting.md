# FAQ & Troubleshooting

Common questions and solutions for working with effect-dynamodb.

---

## FAQ

### Why do I need `.asEffect()` on entity operations?

Entity operations (`EntityGet`, `EntityPut`, `EntityUpdate`, `EntityDelete`) implement `Effect.Yieldable` but **not** `Effect.Effect`. This distinction is intentional and has practical consequences:

**Generator style works directly** — `yield*` extracts the value from any `Yieldable`:

```typescript
const program = Effect.gen(function* () {
  const user = yield* Users.get({ userId: "123" })
  yield* Users.put({ userId: "456", name: "Alice" })
  yield* Users.delete({ userId: "789" })
})
```

**Effect combinators require `.asEffect()`** — functions like `Effect.map`, `Effect.catchTag`, `Effect.flatMap`, and `Effect.all` expect an `Effect.Effect`, not a `Yieldable`. If you try to pass an entity operation directly, you get a type error:

```typescript
// Type error: EntityGet is not assignable to Effect.Effect
Users.get({ userId: "123" }).pipe(Effect.map((u) => u.name))

// Correct: convert to Effect first
Users.get({ userId: "123" }).asEffect().pipe(Effect.map((u) => u.name))
```

This is by design. Entity operations are lazy intermediates that support decode mode selection (`.pipe(Entity.asRecord)`, `.pipe(Entity.asItem)`) and update combinators (`.pipe(Users.set(...))`) before execution. Making them silently assignable to `Effect` would allow them to be passed to combinators that cannot process these intermediate features, leading to runtime errors instead of compile-time errors.

**Rule of thumb:**
- Use `yield*` in generators (most common pattern) — no `.asEffect()` needed
- Use `.asEffect()` when passing to Effect combinators in pipe style

---

### What are the 7 derived types?

Every entity automatically derives 7 types from your domain model and configuration:

| Type | Extractor | Description |
|------|-----------|-------------|
| **Model** | `Entity.Model<E>` | Pure domain object — exactly what your `Schema.Class` defines |
| **Record** | `Entity.Record<E>` | Domain fields + system metadata (`version`, `createdAt`, `updatedAt`) |
| **Input** | `Entity.Input<E>` | Creation input — model fields without system-managed fields |
| **Update** | `Entity.Update<E>` | Mutable fields only — keys and `DynamoModel.Immutable` fields excluded, all optional |
| **Key** | `Entity.Key<E>` | Primary key attributes — the fields needed for `get`, `update`, `delete` |
| **Item** | `Entity.Item<E>` | Full unmarshalled DynamoDB item including internal fields (`__edd_e__`, key fields) |
| **Marshalled** | `Entity.Marshalled<E>` | DynamoDB `AttributeValue` format — what gets sent to/from the wire |

**Key relationships:**
- `put()` and `create()` accept `Input`
- `get()`, `update()`, `delete()` accept `Key`
- `get()` and `query` return `Record` by default (or `Model` via `yield*`)
- `set()` combinator on updates accepts `Update`

---

### How do GSI composite updates work?

When updating attributes that participate in a GSI's composite key, you must provide **all** composite attributes for that GSI — not just the ones you're changing. This is the "fetch-merge" pattern.

**Why?** GSI keys are recomposed from composite attributes on every update. If you provide only some composites, the library cannot build a complete key, and `extractComposites` will fail with an error.

```typescript
// Entity with GSI: byTenant has composite: ["tenantId", "region"]

// WRONG: partial GSI composites — will error
yield* Users.update({ userId: "u-1" }).pipe(
  Users.set({ tenantId: "t-new" }),  // Missing "region"!
)

// CORRECT: provide all composites for the GSI
yield* Users.update({ userId: "u-1" }).pipe(
  Users.set({ tenantId: "t-new", region: "us-east-1" }),
)
```

**What about `Entity.remove()`?** When you remove a GSI composite attribute, the corresponding GSI key fields (pk/sk) are automatically removed so the item drops out of the sparse index. If SET and REMOVE target composites of the same GSI, removal wins.

---

### How does single-table design work?

Multiple entity types share one physical DynamoDB table. Three mechanisms make this work:

1. **Entity type discriminator (`__edd_e__`)** — Every item carries a hidden `__edd_e__` attribute containing the entity type string (e.g., `"User"`, `"Order"`). All queries automatically include a `FilterExpression` on this field to isolate entity types.

2. **Structured key format** — Keys follow the pattern `$schema#v1#entity_type#attr_value#attr_value`. The schema name, version, and entity type prefix ensure that different entity types produce non-overlapping key spaces even when they share the same physical index.

3. **Index overloading** — Generic GSI names (`gsi1`, `gsi2`) serve different access patterns for different entity types. Each entity maps its logical index names (e.g., `byTenant`, `byProject`) to physical GSI names.

```typescript
// Both entities use gsi1 for different patterns
const Users = Entity.make({
  // ...
  indexes: {
    primary: { pk: { field: "pk", composite: ["userId"] }, sk: { field: "sk", composite: [] } },
    byTenant: { index: "gsi1", pk: { field: "gsi1pk", composite: ["tenantId"] }, sk: { field: "gsi1sk", composite: ["userId"] } },
  },
})

const Orders = Entity.make({
  // ...
  indexes: {
    primary: { pk: { field: "pk", composite: ["orderId"] }, sk: { field: "sk", composite: [] } },
    byCustomer: { index: "gsi1", pk: { field: "gsi1pk", composite: ["customerId"] }, sk: { field: "gsi1sk", composite: ["createdAt"] } },
  },
})
```

---

### What's the difference between `put`, `create`, and `upsert`?

| Operation | Behavior | On Duplicate Key | DynamoDB API |
|-----------|----------|------------------|--------------|
| **`put`** | Unconditional write — creates or overwrites | Silently replaces the existing item | PutItem |
| **`create`** | Insert-only — `put` + automatic `attribute_not_exists` condition | Fails with `ConditionalCheckFailed` | PutItem (with condition) |
| **`upsert`** | Create-or-update atomically | Creates if missing, updates if exists | UpdateItem (with `if_not_exists`) |

```typescript
// put: overwrites if exists
yield* Users.put({ userId: "u-1", name: "Alice" })

// create: fails if exists
yield* Users.create({ userId: "u-1", name: "Alice" }).pipe(
  Effect.catchTag("ConditionalCheckFailed", () =>
    Effect.fail(new Error("User already exists"))
  ),
)

// upsert: creates or updates
// - Immutable fields and createdAt use if_not_exists (only set on first creation)
// - Version is incremented atomically: if_not_exists(version, 0) + 1
// - Returns the full record (ReturnValues: ALL_NEW)
yield* Users.upsert({ userId: "u-1", name: "Alice" })
```

**Note:** `upsert` does not support unique constraints or version retention (`retain`) because it cannot determine whether the item previously existed.

---

### How do version snapshots work?

When `versioned: { retain: true }` is configured, every write operation (put, update, delete) stores a **snapshot** of the item at that version.

```typescript
const Users = Entity.make({
  // ...
  versioned: { retain: true },
})
```

**How it works:**
- Snapshots share the same partition key (PK) as the main item but use a version sort key: `$schema#v1#entity#v#0000001`
- GSI key fields are **stripped** from snapshots so they do not appear in index queries
- The `__edd_e__` entity type is preserved for filtering
- Retain-aware writes use `transactWriteItems` to atomically write both the main item and the snapshot

**Accessing versions:**

```typescript
// Get a specific version
const v2 = yield* Users.getVersion({ userId: "u-1" }, 2)

// Query version history (most recent first)
const history = yield* Users.versions({ userId: "u-1" }).pipe(
  Query.reverse,
  Query.limit(10),
  Query.execute,
)
```

---

### How does soft delete work?

When `softDelete` is configured, `entity.delete()` performs a **logical deletion** — the item becomes invisible to normal queries but remains in the table.

```typescript
const Users = Entity.make({
  // ...
  softDelete: true,
  // Or with auto-purge:
  // softDelete: { ttl: Duration.days(30) },
})
```

**What happens on delete:**

1. The sort key is modified: `$schema#v1#user` becomes `$schema#v1#user#deleted#2024-01-15T10:30:00Z`
2. All GSI keys are **removed** — the item disappears from secondary indexes and collections
3. A `deletedAt` timestamp is added to the item
4. If `ttl` is configured, a `_ttl` attribute is set for DynamoDB's auto-expiry

**Visibility:**

| Access Path | Sees Deleted Items? |
|-------------|---------------------|
| `entity.get(key)` | No |
| `entity.query.byIndex(...)` | No |
| Collection queries | No |
| `entity.deleted.get(key)` | Yes |
| `entity.deleted.list(key)` | Yes |

**Recovery and cleanup:**

```typescript
// Read a deleted item
const deleted = yield* Users.deleted.get({ userId: "u-1" })

// Restore — recomposes all keys and re-establishes unique sentinels
yield* Users.restore({ userId: "u-1" })

// Purge — permanently removes item + all versions + unique sentinels
yield* Users.purge({ userId: "u-1" })
```

When an entity has both `softDelete` and `unique` constraints, the `preserveUnique` option controls whether unique sentinels are freed on delete (default: `false`, sentinels are freed) or preserved until purge.

---

## Troubleshooting

### "Cannot use entity operation with Effect.map/catchTag/etc"

**Symptom:** Type error when passing an entity operation to an Effect combinator.

```typescript
// Type error
Users.get({ userId: "123" }).pipe(Effect.map((u) => u.name))
```

**Cause:** Entity operations implement `Yieldable` but not `Effect.Effect`. Effect combinators require `Effect.Effect`.

**Solution:** Use `.asEffect()` to convert, or use generator style:

```typescript
// Option 1: .asEffect()
Users.get({ userId: "123" }).asEffect().pipe(Effect.map((u) => u.name))

// Option 2: generator style (no conversion needed)
const name = yield* Effect.gen(function* () {
  const user = yield* Users.get({ userId: "123" })
  return user.name
})
```

---

### "GSI key composition failed"

**Symptom:** Error from `extractComposites` when updating an item.

**Cause:** You provided some but not all composite attributes for a GSI. When any composite attribute for a GSI is updated, the library must recompose the entire GSI key, which requires all composites to be present.

**Solution:** Provide all composite attributes for the affected GSI:

```typescript
// If the GSI has composite: ["tenantId", "region"]
// Provide BOTH when updating either one
yield* Users.update({ userId: "u-1" }).pipe(
  Users.set({ tenantId: "t-new", region: "us-east-1" }),
)
```

If you want to update a non-GSI field without touching the GSI, omit all GSI composites and the GSI key will not be recomposed.

---

### "ConditionalCheckFailed on create"

**Symptom:** `ConditionalCheckFailed` error when calling `entity.create()`.

**Cause:** An item with the same primary key already exists. `create()` adds an automatic `attribute_not_exists` condition that prevents overwrites.

**Solution:** Choose the appropriate operation for your intent:

```typescript
// Use put() to overwrite if exists
yield* Users.put({ userId: "u-1", name: "Alice" })

// Use upsert() for create-or-update semantics
yield* Users.upsert({ userId: "u-1", name: "Alice" })

// Or handle the duplicate explicitly
yield* Users.create({ userId: "u-1", name: "Alice" }).pipe(
  Effect.catchTag("ConditionalCheckFailed", () =>
    Effect.logWarning("User already exists, skipping")
  ),
)
```

---

### "UniqueConstraintViolation"

**Symptom:** `UniqueConstraintViolation` error on `put`, `create`, or `update`.

**Cause:** Another item already has the same value for the unique constraint fields. Uniqueness is enforced via transactional sentinel items.

**Solution:**

```typescript
yield* Users.put({ userId: "u-1", email: "alice@example.com" }).pipe(
  Effect.catchTag("UniqueConstraintViolation", (e) =>
    // e.constraint — name of the violated constraint (e.g., "email")
    // e.fields — the field values that collided (e.g., { email: "alice@example.com" })
    Effect.fail(new Error(`${e.constraint} already taken: ${JSON.stringify(e.fields)}`))
  ),
)
```

To update a unique field, provide the new value in `set()`. The library automatically deletes the old sentinel and creates a new one in a transaction. If the new value is already taken, you get `UniqueConstraintViolation`.

---

### "OptimisticLockError"

**Symptom:** `OptimisticLockError` on update with `expectedVersion`.

**Cause:** The item was modified between when you read it and when you attempted the update. The version in DynamoDB no longer matches your expected version.

**Solution:** Re-read the item and retry:

```typescript
yield* Users.update({ userId: "u-1" }).pipe(
  Users.set({ name: "Updated" }),
  Users.expectedVersion(3),
  Effect.catchTag("OptimisticLockError", (e) =>
    // e.expectedVersion — what you expected
    // e.actualVersion — what DynamoDB has
    Effect.gen(function* () {
      // Re-read and retry with the current version
      const current = yield* Users.get({ userId: "u-1" }).pipe(Entity.asRecord)
      return yield* Users.update({ userId: "u-1" }).pipe(
        Users.set({ name: "Updated" }),
        Users.expectedVersion(current.version),
      )
    })
  ),
)
```

---

### "AggregateAssemblyError"

**Symptom:** `AggregateAssemblyError` when fetching or assembling an aggregate.

**Cause:** The aggregate could not be assembled from the items in DynamoDB. Common reasons:
- **Missing items** — A required sub-entity or edge target does not exist in the partition
- **Structural violations** — Items do not match the expected aggregate shape (e.g., wrong entity type, unexpected discriminator)
- **Decode errors** — An item failed Schema validation during assembly

**Solution:**

```typescript
yield* MyAggregate.get({ rootId: "123" }).pipe(
  Effect.catchTag("AggregateAssemblyError", (e) =>
    // e.aggregate — aggregate name
    // e.reason — description of what went wrong
    // e.key — the key that was being assembled
    Effect.logError(`Assembly failed: ${e.reason}`)
  ),
)
```

Check that all items in the partition are consistent. If items were written outside the aggregate (e.g., direct entity writes), they may not match the expected structure.

---

### "ItemDeleted"

**Symptom:** `ItemDeleted` error when trying to modify or access an item.

**Cause:** The item has been soft-deleted. Normal `get()` and `query` operations will not find it — only `deleted.get()` and `deleted.list()` can access it.

**Solution:**

```typescript
// Read the deleted item
const item = yield* Users.deleted.get({ userId: "u-1" })

// Restore it to make it active again
yield* Users.restore({ userId: "u-1" })

// Or purge it permanently (removes item + versions + sentinels)
yield* Users.purge({ userId: "u-1" })
```

---

### "ItemNotDeleted"

**Symptom:** `ItemNotDeleted` error when calling `entity.restore()`.

**Cause:** The item is not soft-deleted — `restore` can only be called on items that have been soft-deleted.

**Solution:** Check the item's state before restoring. If the item is active, no action is needed.

---

### Common type errors with entity operations

**"Type 'EntityUpdate<...>' is not assignable to type 'Effect.Effect<...>'"**

Do not try to extract `A`/`E`/`R` from entity operations using `Effect.Effect<infer A, ...>`. Entity ops are not `Effect.Effect`. Use the specific entity op types:

```typescript
// WRONG
type Result = MyOp extends Effect.Effect<infer A> ? A : never  // resolves to never

// CORRECT
type Result = MyOp extends EntityOp<infer A, any, any, any> ? A : never
```

**"Property 'set' does not exist on EntityUpdate"**

Update combinators (`set`, `expectedVersion`, `remove`, `add`, etc.) are entity-scoped, not on the `EntityUpdate` interface directly. Use them from the entity:

```typescript
// WRONG
Users.update({ userId: "u-1" }).set({ name: "Alice" })

// CORRECT
Users.update({ userId: "u-1" }).pipe(Users.set({ name: "Alice" }))

// Also correct (data-first)
Entity.set(Users.update({ userId: "u-1" }), { name: "Alice" })
```
