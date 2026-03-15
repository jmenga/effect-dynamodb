# 2-Entity Walkthrough: User + Order

This walkthrough validates the full API surface with two entities sharing a single DynamoDB table.

## Table Design

Single table with 1 GSI:

| Entity | PK | SK | GSI1PK | GSI1SK |
|--------|----|----|--------|--------|
| User | `USER#${userId}` | `METADATA` | `ROLE#${role}` | `USER#${userId}` |
| Order | `ORDER#${orderId}` | `METADATA` | `USER#${userId}` | `ORDER#${orderId}` |

**Access patterns:**
- Get User by userId → primary key
- Get Order by orderId → primary key
- List Users by role → GSI1 query on `ROLE#${role}`
- List Orders by userId → GSI1 query on `USER#${userId}`

---

## Model Definitions

```typescript
import { Schema } from "effect"
import { DynamoModel } from "@effect-dynamodb"

// --- User Model ---

class User extends DynamoModel.Class<User>("User")({
  // Entity attributes
  userId: DynamoModel.KeyField(Schema.String.pipe(Schema.brand("UserId"))),
  email: Schema.String,
  name: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),

  // Composed keys (derived, not user-provided)
  pk: DynamoModel.ComposedKey(Schema.String),
  sk: DynamoModel.ComposedKey(Schema.String),
  gsi1pk: DynamoModel.ComposedKey(Schema.String),
  gsi1sk: DynamoModel.ComposedKey(Schema.String),

  // Timestamps (auto-managed)
  createdAt: DynamoModel.DateTimeInsert,
  updatedAt: DynamoModel.DateTimeUpdate,
}) {}

// Variant types:
//   User (item):    { userId, email, name, role, pk, sk, gsi1pk, gsi1sk, createdAt, updatedAt }
//   User.insert:    { userId, email, name, role }
//   User.update:    { email?, name?, role? }
//   User.key:       { userId }


// --- Order Model ---

const OrderId = Schema.String.pipe(Schema.brand("OrderId"))
type OrderId = typeof OrderId.Type

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

class Order extends DynamoModel.Class<Order>("Order")({
  // Entity attributes
  orderId: DynamoModel.KeyField(OrderId),
  userId: DynamoModel.KeyField(UserId),
  product: Schema.NonEmptyString,
  quantity: Schema.Number.pipe(Schema.int(), Schema.positive()),
  status: Schema.Literals(["pending", "shipped", "delivered"]),

  // Composed keys
  pk: DynamoModel.ComposedKey(Schema.String),
  sk: DynamoModel.ComposedKey(Schema.String),
  gsi1pk: DynamoModel.ComposedKey(Schema.String),
  gsi1sk: DynamoModel.ComposedKey(Schema.String),

  // Timestamps
  createdAt: DynamoModel.DateTimeInsert,
  updatedAt: DynamoModel.DateTimeUpdate,
}) {}

// Variant types:
//   Order (item):    { orderId, userId, product, quantity, status, pk, sk, gsi1pk, gsi1sk, createdAt, updatedAt }
//   Order.insert:    { orderId, userId, product, quantity, status }
//   Order.update:    { product?, quantity?, status? }
//   Order.key:       { orderId }
//
// Note: userId is a KeyField in Order because it's used in GSI1PK template.
// But for get/delete, only orderId is needed (primary key templates only reference orderId).
// The key variant should ideally only contain attributes referenced in the PRIMARY key templates.
// This is a design refinement — see "Key Variant Refinement" below.
```

### Key Variant Refinement

The `key` variant should contain only attributes referenced by the **primary** key templates (used for get/delete), not all KeyField attributes. `userId` in Order is a KeyField because it's immutable and part of insert, but the key variant for get/delete should only need `{ orderId }`.

**Resolution:** The `key` variant is driven by the Entity definition, not the model alone. The Entity knows which attributes compose the primary key. The EntityRepository extracts the key type from the primary key templates.

This means:
- `DynamoModel.KeyField` marks a field as immutable (present in item, insert, key — absent from update)
- `EntityRepository.get/delete` type narrows to only the primary key template attributes
- The `Model.key` variant contains all KeyField attributes, but the repository types further constrain it

```typescript
// repo.get type is narrowed by the primary key templates:
// primary: { pk: "ORDER#${orderId}", sk: "METADATA" }
// → get input: { orderId: OrderId }  (not { orderId: OrderId, userId: UserId })

// repo.query.gsi1 pk type is narrowed by gsi1 pk template:
// gsi1: { pk: "USER#${userId}", sk: "ORDER#${orderId}" }
// → query.gsi1 pk input: { userId: UserId }
// → query.gsi1 sk input (for conditions): { orderId: OrderId }
```

---

## Table + Entity Definitions

```typescript
import { Table, Entity } from "@effect-dynamodb"

const MainTable = Table.make({
  tableName: "main",
  partitionKey: { name: "pk", type: "S" },
  sortKey: { name: "sk", type: "S" },
  indexes: {
    gsi1: {
      type: "global",
      partitionKey: { name: "gsi1pk", type: "S" },
      sortKey: { name: "gsi1sk", type: "S" },
    },
  },
})

const UserEntity = Entity.make({
  model: User,
  table: MainTable,
  entityType: "User",
  keys: {
    primary: { pk: "USER#${userId}", sk: "METADATA" },
    gsi1: { pk: "ROLE#${role}", sk: "USER#${userId}" },
  },
})

const OrderEntity = Entity.make({
  model: Order,
  table: MainTable,
  entityType: "Order",
  keys: {
    primary: { pk: "ORDER#${orderId}", sk: "METADATA" },
    gsi1: { pk: "USER#${userId}", sk: "ORDER#${orderId}" },
  },
})
```

---

## CRUD Operations

```typescript
import { Effect, Stream } from "effect"
import { EntityRepository, DynamoClient } from "@effect-dynamodb"

const program = Effect.gen(function* () {
  const userRepo = yield* EntityRepository.make(UserEntity)
  const orderRepo = yield* EntityRepository.make(OrderEntity)

  // === PUT ===

  // Create a user — provide insert-variant fields only
  const alice = yield* userRepo.put({
    userId: "u-1" as UserId,
    email: "alice@example.com",
    name: "Alice",
    role: "admin",
  })
  // alice is a full User instance:
  // {
  //   userId: "u-1",
  //   email: "alice@example.com",
  //   name: "Alice",
  //   role: "admin",
  //   pk: "USER#u-1",
  //   sk: "METADATA",
  //   gsi1pk: "ROLE#admin",
  //   gsi1sk: "USER#u-1",
  //   createdAt: DateTime.Utc("2026-02-15T12:00:00Z"),
  //   updatedAt: DateTime.Utc("2026-02-15T12:00:00Z"),
  // }

  const bob = yield* userRepo.put({
    userId: "u-2" as UserId,
    email: "bob@example.com",
    name: "Bob",
    role: "member",
  })

  // Create orders
  const order1 = yield* orderRepo.put({
    orderId: "ord-1" as OrderId,
    userId: "u-1" as UserId,
    product: "Widget",
    quantity: 3,
    status: "pending",
  })
  // order1.pk === "ORDER#ord-1"
  // order1.sk === "METADATA"
  // order1.gsi1pk === "USER#u-1"
  // order1.gsi1sk === "ORDER#ord-1"

  const order2 = yield* orderRepo.put({
    orderId: "ord-2" as OrderId,
    userId: "u-1" as UserId,
    product: "Gadget",
    quantity: 1,
    status: "shipped",
  })

  // === GET ===

  // Get user by entity key attributes (not composed keys)
  const fetchedAlice = yield* userRepo.get({ userId: "u-1" as UserId })
  // fetchedAlice is User with all fields populated
  // Type: Effect<User, ItemNotFound | DynamoError | ValidationError>

  // Get order by orderId only (primary key template only references orderId)
  const fetchedOrder = yield* orderRepo.get({ orderId: "ord-1" as OrderId })
  // Type: Effect<Order, ItemNotFound | DynamoError | ValidationError>

  // === DELETE ===

  yield* orderRepo.delete({ orderId: "ord-2" as OrderId })
  // Type: Effect<void, DynamoError>

  // === QUERY ===

  // Query users by role (GSI1)
  const adminStream = userRepo.query.gsi1({
    pk: { role: "admin" },
  })
  const admins = yield* Stream.runCollect(adminStream)
  // admins: Chunk<User> containing alice
  // Type: Stream<User, DynamoError | ValidationError>

  // Query orders by userId with sort key condition (GSI1)
  const userOrderStream = orderRepo.query.gsi1({
    pk: { userId: "u-1" as UserId },
    sk: { beginsWith: { orderId: "ORDER#" as OrderId } },
  })
  // Wait — the sort key template is "ORDER#${orderId}" and beginsWith composes
  // the prefix. If orderId is "ord-", the composed prefix is "ORDER#ord-".
  // Let's use a more realistic example:

  // Query all orders for user u-1 (no sort key condition)
  const allUserOrders = orderRepo.query.gsi1({
    pk: { userId: "u-1" as UserId },
  })
  const orders = yield* Stream.runCollect(allUserOrders)
  // orders: Chunk<Order> containing order1 (order2 was deleted)

  // Query with sort key condition — orders after a certain orderId
  const recentOrders = orderRepo.query.gsi1({
    pk: { userId: "u-1" as UserId },
    sk: { gt: { orderId: "ord-0" as OrderId } },
  })

  // Query with limit and reverse order
  const latestOrder = orderRepo.query.gsi1({
    pk: { userId: "u-1" as UserId },
    scanForward: false,
    limit: 1,
  })

  // === PRIMARY KEY QUERY ===

  // Query the primary index (useful for begins_with on sort key)
  // For a hypothetical entity with composite sort key:
  // keys: { primary: { pk: "USER#${userId}", sk: "ORDER#${orderId}" } }
  // repo.query.primary({ pk: { userId: "u-1" }, sk: { beginsWith: { orderId: "" } } })
  // This queries all orders for a user using the primary key.
})

// Provide the DynamoClient layer
const main = program.pipe(
  Effect.provide(DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",  // DynamoDB Local
  }))
)
```

---

## Error Handling

```typescript
import { Effect } from "effect"
import { ItemNotFound, DynamoError, ValidationError } from "@effect-dynamodb"

const safeGet = Effect.gen(function* () {
  const repo = yield* EntityRepository.make(UserEntity)

  // Handle specific errors
  const result = yield* repo.get({ userId: "nonexistent" as UserId }).pipe(
    Effect.catchTag("ItemNotFound", () =>
      Effect.succeed(null)
    ),
  )

  // Or use catchTags for multiple error types
  const result2 = yield* repo.get({ userId: "u-1" as UserId }).pipe(
    Effect.catchTags({
      ItemNotFound: (e) => Effect.succeed(null),
      DynamoError: (e) => Effect.die(e),  // Defect — shouldn't happen
      ValidationError: (e) => Effect.die(e),  // Defect — schema mismatch
    }),
  )
})
```

---

## Type Safety Verification

### Compile-time checks:

1. **put rejects composed keys:**
   ```typescript
   userRepo.put({ userId: "u-1", email: "a@b.com", name: "A", role: "admin", pk: "x" })
   //                                                                          ^^ Error: pk not in insert variant
   ```

2. **get requires key attributes:**
   ```typescript
   userRepo.get({})           // Error: missing userId
   userRepo.get({ email: "" }) // Error: email not in key type
   ```

3. **query requires correct pk attributes per index:**
   ```typescript
   userRepo.query.gsi1({ pk: { userId: "u-1" } })  // Error: gsi1 pk template uses "role", not "userId"
   userRepo.query.gsi1({ pk: { role: "admin" } })   // OK
   ```

4. **query sk conditions use correct attributes:**
   ```typescript
   orderRepo.query.gsi1({
     pk: { userId: "u-1" },
     sk: { beginsWith: { role: "admin" } },  // Error: gsi1 sk template uses "orderId", not "role"
   })
   ```

5. **Branded types prevent ID mixing:**
   ```typescript
   userRepo.get({ userId: "u-1" as OrderId })  // Error: OrderId is not UserId
   ```

---

## DynamoDB Item Layout

After the operations above, the table contains:

| pk | sk | gsi1pk | gsi1sk | entityType | userId | email | name | role | orderId | product | quantity | status | createdAt | updatedAt |
|----|----|--------|--------|------------|--------|-------|------|------|---------|---------|----------|--------|-----------|-----------|
| USER#u-1 | METADATA | ROLE#admin | USER#u-1 | User | u-1 | alice@example.com | Alice | admin | | | | | 2026-02-15T... | 2026-02-15T... |
| USER#u-2 | METADATA | ROLE#member | USER#u-2 | User | u-2 | bob@example.com | Bob | member | | | | | 2026-02-15T... | 2026-02-15T... |
| ORDER#ord-1 | METADATA | USER#u-1 | ORDER#ord-1 | Order | | | | | ord-1 | Widget | 3 | pending | 2026-02-15T... | 2026-02-15T... |

Note: `entityType` is automatically added by the repository as a discriminator field.

---

## Validation Summary

| API Surface | Validated | Notes |
|-------------|-----------|-------|
| DynamoModel.Class definition | Yes | Both entities with all field helper types |
| DynamoModel.ComposedKey | Yes | pk, sk, gsi1pk, gsi1sk in both entities |
| DynamoModel.KeyField | Yes | userId in User, orderId + userId in Order |
| DynamoModel.DateTimeInsert | Yes | createdAt in both entities |
| DynamoModel.DateTimeUpdate | Yes | updatedAt in both entities |
| Variant extraction (insert) | Yes | Only entity attributes, no keys/timestamps |
| Variant extraction (key) | Yes | Only KeyField attributes |
| Table.make | Yes | Table with PK, SK, and GSI1 |
| Entity.make | Yes | Two entities with different key templates |
| EntityRepository.put | Yes | Insert variant → full item with composed keys |
| EntityRepository.get | Yes | Key attributes → composed PK/SK → decoded item |
| EntityRepository.delete | Yes | Key attributes → composed PK/SK → void |
| EntityRepository.query | Yes | Index-aware with pk/sk attribute composition |
| Sort key conditions | Yes | beginsWith, gt demonstrated |
| Stream pagination | Yes | Query returns Stream (auto-paginated) |
| Error handling | Yes | catchTag/catchTags with all error types |
| Type safety | Yes | 5 compile-time checks documented |
| DynamoClient.layer | Yes | Config-based layer with endpoint for local dev |
