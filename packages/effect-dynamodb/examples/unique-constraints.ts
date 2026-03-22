/**
 * Unique constraints example — effect-dynamodb v3 (client gateway pattern)
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

// ---------------------------------------------------------------------------
// 2. Application namespace
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "unique-demo", version: 1 })

// ---------------------------------------------------------------------------
// 3. Entity definitions — pure, no table reference
// ---------------------------------------------------------------------------

// Users with two unique constraints:
// - email: globally unique email addresses
// - username: globally unique usernames
const Users = Entity.make({
  model: User,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
  },
  timestamps: true,
  unique: {
    email: ["email"],
    username: ["username"],
  },
})

// API requests with a TTL-based idempotency key constraint.
// The sentinel item auto-expires after the TTL, allowing the same
// idempotency key to be reused later.
const ApiRequests = Entity.make({
  model: ApiRequest,
  entityType: "ApiRequest",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["requestId"] },
      sk: { field: "sk", composite: [] },
    },
  },
  timestamps: true,
  unique: {
    idempotencyKey: {
      fields: ["idempotencyKey"],
      ttl: Duration.minutes(30),
    },
  },
})

// ---------------------------------------------------------------------------
// 4. Table definition — declares all members
// ---------------------------------------------------------------------------

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Users, ApiRequests },
})

// ---------------------------------------------------------------------------
// 5. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // Typed execution gateway — binds all table members
  const db = yield* DynamoClient.make(MainTable)

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")

  yield* db.createTable()
  yield* Console.log("Table created\n")

  // --- Create a user with unique email ---
  yield* Console.log("=== Unique Email Constraint ===\n")

  const alice = yield* db.Users.put({
    userId: "u-1",
    email: "alice@example.com",
    username: "alice",
    tenantId: "t-1",
    name: "Alice",
  })
  yield* Console.log(`Created: ${alice.name} (email: ${alice.email}, username: ${alice.username})`)

  // Try to create another user with the same email → UniqueConstraintViolation
  const duplicateEmail = yield* db.Users.put({
    userId: "u-2",
    email: "alice@example.com", // Same email as Alice!
    username: "bob",
    tenantId: "t-1",
    name: "Bob",
  }).pipe(
    Effect.map(() => "unexpected success"),
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      Effect.succeed(
        `UniqueConstraintViolation: constraint="${e.constraint}", fields=${JSON.stringify(e.fields)}`,
      ),
    ),
  )
  yield* Console.log(`Duplicate email: ${duplicateEmail}\n`)

  // --- Unique username constraint ---
  yield* Console.log("=== Unique Username Constraint ===\n")

  const bob = yield* db.Users.put({
    userId: "u-2",
    email: "bob@example.com", // Different email — OK
    username: "alice", // Same username as Alice!
    tenantId: "t-1",
    name: "Bob",
  }).pipe(
    Effect.map((u) => `Created: ${u.name}`),
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      Effect.succeed(`UniqueConstraintViolation: constraint="${e.constraint}"`),
    ),
  )
  yield* Console.log(`Duplicate username: ${bob}`)

  // Different email AND username — OK
  const charlie = yield* db.Users.put({
    userId: "u-2",
    email: "bob@example.com",
    username: "bob",
    tenantId: "t-1",
    name: "Bob",
  })
  yield* Console.log(`Created: ${charlie.name} (unique email and username)\n`)

  // --- Idempotency key pattern ---
  yield* Console.log("=== Idempotency Key Pattern (TTL) ===\n")

  // First request with idempotency key
  const req1 = yield* db.ApiRequests.put({
    requestId: "r-1",
    idempotencyKey: "idem-abc-123",
    payload: '{"action":"charge","amount":100}',
    status: "completed",
  })
  yield* Console.log(`Request 1: ${req1.requestId} (key: ${req1.idempotencyKey})`)

  // Retry with same idempotency key → UniqueConstraintViolation
  // This prevents duplicate processing of the same request
  const retry = yield* db.ApiRequests.put({
    requestId: "r-2",
    idempotencyKey: "idem-abc-123", // Same idempotency key!
    payload: '{"action":"charge","amount":100}',
    status: "pending",
  }).pipe(
    Effect.map(() => "processed (duplicate!)"),
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      Effect.succeed(`Blocked: constraint="${e.constraint}" — duplicate request prevented`),
    ),
  )
  yield* Console.log(`Retry: ${retry}`)
  yield* Console.log("  → The sentinel item has a TTL of 30 minutes")
  yield* Console.log("  → After TTL expiry, the same key can be reused\n")

  // Different idempotency key — OK
  const req2 = yield* db.ApiRequests.put({
    requestId: "r-2",
    idempotencyKey: "idem-def-456",
    payload: '{"action":"refund","amount":50}',
    status: "completed",
  })
  yield* Console.log(`Request 2: ${req2.requestId} (new key: ${req2.idempotencyKey})\n`)

  // --- Update rotation ---
  yield* Console.log("=== Unique Constraint Update Rotation ===\n")

  // Update Alice's email — should rotate the email sentinel
  yield* db.Users.update({ userId: "u-1" }, Users.set({ email: "alice-new@example.com" }))
  const updatedAlice = yield* db.Users.get({ userId: "u-1" })
  yield* Console.log(`Updated Alice's email: ${updatedAlice.email} (was alice@example.com)`)

  // The old email "alice@example.com" is now free — another user can claim it
  const newUser = yield* db.Users.put({
    userId: "u-3",
    email: "alice@example.com", // Previously Alice's — now available
    username: "charlie",
    tenantId: "t-1",
    name: "Charlie",
  })
  yield* Console.log(`Charlie claimed old email: ${newUser.email}`)

  // Try updating Bob's email to Alice's new email — should fail
  const conflict = yield* db.Users.update(
    { userId: "u-2" },
    Users.set({ email: "alice-new@example.com" }),
  ).pipe(
    Effect.map(() => "unexpected success"),
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      Effect.succeed(`Blocked: constraint="${e.constraint}", fields=${JSON.stringify(e.fields)}`),
    ),
  )
  yield* Console.log(`Update conflict: ${conflict}\n`)

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* db.deleteTable()
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 6. Provide dependencies and run
// ---------------------------------------------------------------------------

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
