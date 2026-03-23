/**
 * Unique constraints example — effect-dynamodb v2 API
 *
 * Demonstrates:
 *   - Unique constraint declaration on Entity (unique: { email: ["email"] })
 *   - Automatic enforcement via DynamoDB transaction sentinel items
 *   - UniqueConstraintViolation error on duplicate values
 *   - Multi-field unique constraints (composite uniqueness)
 *   - Unique constraints with TTL (idempotency key pattern)
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/unique-constraints.ts
 */

import { Console, Duration, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

// #region models
class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  username: Schema.NonEmptyString,
  tenantId: Schema.String,
  name: Schema.NonEmptyString,
}) {}

const RequestStatus = { Pending: "pending", Completed: "completed", Failed: "failed" } as const
const RequestStatusSchema = Schema.Literals(Object.values(RequestStatus))

class ApiRequest extends Schema.Class<ApiRequest>("ApiRequest")({
  requestId: Schema.String,
  idempotencyKey: Schema.String,
  payload: Schema.String,
  status: RequestStatusSchema,
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Application namespace
// ---------------------------------------------------------------------------

// #region schema
const AppSchema = DynamoSchema.make({ name: "unique-demo", version: 1 })
// #endregion

// ---------------------------------------------------------------------------
// 3. Entity definitions — primary key only, no GSIs
// ---------------------------------------------------------------------------

// #region users-entity
// Users with two unique constraints:
// - email: globally unique email addresses
// - username: globally unique usernames
const Users = Entity.make({
  model: User,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  unique: {
    email: ["email"],
    username: ["username"],
  },
})
// #endregion

// #region api-requests-entity
// API requests with a TTL-based idempotency key constraint.
// The sentinel item auto-expires after the TTL, allowing the same
// idempotency key to be reused later.
const ApiRequests = Entity.make({
  model: ApiRequest,
  entityType: "ApiRequest",
  primaryKey: {
    pk: { field: "pk", composite: ["requestId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  unique: {
    idempotencyKey: {
      fields: ["idempotencyKey"],
      ttl: Duration.minutes(30),
    },
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 4. Table definition — declares all members
// ---------------------------------------------------------------------------

// #region table
const MainTable = Table.make({
  schema: AppSchema,
  entities: { Users, ApiRequests },
})
// #endregion

// ---------------------------------------------------------------------------
// 5. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // Typed execution gateway — binds all entities
  const db = yield* DynamoClient.make({ entities: { Users, ApiRequests } })

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")

  yield* db.tables["unique-demo-table"]!.create()
  yield* Console.log("Table created\n")

  // --- Create a user with unique email ---
  yield* Console.log("=== Unique Email Constraint ===\n")

  // #region create-user
  const alice = yield* db.entities.Users.put({
    userId: "u-1",
    email: "alice@example.com",
    username: "alice",
    tenantId: "t-1",
    name: "Alice",
  })

  // Same email → UniqueConstraintViolation
  const duplicateEmail = yield* db.entities.Users.put({
    userId: "u-2",
    email: "alice@example.com", // Same email as Alice!
    username: "bob",
    tenantId: "t-1",
    name: "Bob",
  }).pipe(
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      Effect.succeed(`Blocked: constraint="${e.constraint}", fields=${JSON.stringify(e.fields)}`),
    ),
  )
  // Blocked: constraint="email", fields={"email":"alice@example.com"}
  // #endregion
  yield* Console.log(`Created: ${alice.name} (email: ${alice.email}, username: ${alice.username})`)
  yield* Console.log(`Duplicate email: ${duplicateEmail}\n`)

  // --- Unique username constraint ---
  yield* Console.log("=== Unique Username Constraint ===\n")

  // #region duplicate-username
  // Different email, same username → UniqueConstraintViolation
  const bob = yield* db.entities.Users.put({
    userId: "u-2",
    email: "bob@example.com", // Different email — OK
    username: "alice", // Same username as Alice!
    tenantId: "t-1",
    name: "Bob",
  }).pipe(
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      Effect.succeed(`Blocked: constraint="${e.constraint}"`),
    ),
  )
  // Blocked: constraint="username"

  // Both different → succeeds
  const charlie = yield* db.entities.Users.put({
    userId: "u-2",
    email: "bob@example.com",
    username: "bob",
    tenantId: "t-1",
    name: "Bob",
  })
  // Created: Bob
  // #endregion
  yield* Console.log(`Duplicate username: ${bob}`)
  yield* Console.log(`Created: ${charlie.name} (unique email and username)\n`)

  // --- Idempotency key pattern ---
  yield* Console.log("=== Idempotency Key Pattern (TTL) ===\n")

  // #region idempotency
  // First request — succeeds
  const req1 = yield* db.entities.ApiRequests.put({
    requestId: "r-1",
    idempotencyKey: "idem-abc-123",
    payload: '{"action":"charge","amount":100}',
    status: "completed",
  })

  // Retry with same idempotency key → blocked
  const retry = yield* db.entities.ApiRequests.put({
    requestId: "r-2",
    idempotencyKey: "idem-abc-123", // Same idempotency key!
    payload: '{"action":"charge","amount":100}',
    status: "pending",
  }).pipe(
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      Effect.succeed(`Blocked: constraint="${e.constraint}" — duplicate request prevented`),
    ),
  )
  // The sentinel has a TTL of 30 minutes
  // After expiry, the same key can be reused

  // Different idempotency key — succeeds immediately
  const req2 = yield* db.entities.ApiRequests.put({
    requestId: "r-2",
    idempotencyKey: "idem-def-456",
    payload: '{"action":"refund","amount":50}',
    status: "completed",
  })
  // #endregion
  yield* Console.log(`Request 1: ${req1.requestId} (key: ${req1.idempotencyKey})`)
  yield* Console.log(`Retry: ${retry}`)
  yield* Console.log("  → The sentinel item has a TTL of 30 minutes")
  yield* Console.log("  → After TTL expiry, the same key can be reused\n")
  yield* Console.log(`Request 2: ${req2.requestId} (new key: ${req2.idempotencyKey})\n`)

  // --- Update rotation ---
  yield* Console.log("=== Unique Constraint Update Rotation ===\n")

  // #region sentinel-rotation
  // Update Alice's email
  yield* db.entities.Users.update({ userId: "u-1" }, Users.set({ email: "alice-new@example.com" }))

  // The old email "alice@example.com" is now free
  const newUser = yield* db.entities.Users.put({
    userId: "u-3",
    email: "alice@example.com", // Previously Alice's — now available
    username: "charlie",
    tenantId: "t-1",
    name: "Charlie",
  })
  // Created: Charlie

  // But Alice's new email is still protected
  const conflict = yield* db.entities.Users.update(
    { userId: "u-2" },
    Users.set({ email: "alice-new@example.com" }),
  ).pipe(
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      Effect.succeed(`Blocked: constraint="${e.constraint}"`),
    ),
  )
  // Blocked: constraint="email"
  // #endregion
  const updatedAlice = yield* db.entities.Users.get({ userId: "u-1" })
  yield* Console.log(`Updated Alice's email: ${updatedAlice.email} (was alice@example.com)`)
  yield* Console.log(`Charlie claimed old email: ${newUser.email}`)
  yield* Console.log(`Update conflict: ${conflict}\n`)

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* db.tables["unique-demo-table"]!.delete()
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 6. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "unique-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
