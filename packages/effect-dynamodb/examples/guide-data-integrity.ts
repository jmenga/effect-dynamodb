/**
 * Data Integrity guide example — effect-dynamodb
 *
 * Demonstrates:
 *   - Unique constraints (single-field, compound, TTL-based)
 *   - UniqueConstraintViolation error handling
 *   - Versioning with auto-increment and version retention
 *   - Optimistic concurrency via expectedVersion
 *   - Idempotency key pattern using unique constraints with TTL
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-data-integrity.ts
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
  displayName: Schema.NonEmptyString,
}) {}

class Payment extends Schema.Class<Payment>("Payment")({
  paymentId: Schema.String,
  amount: Schema.Number,
  currency: Schema.String,
  idempotencyKey: Schema.String,
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Application namespace
// ---------------------------------------------------------------------------

// #region schema
const AppSchema = DynamoSchema.make({ name: "integrity-demo", version: 1 })
// #endregion

// ---------------------------------------------------------------------------
// 3. Entity definitions
// ---------------------------------------------------------------------------

// #region unique-declaration
const Users = Entity.make({
  model: User,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  unique: {
    email: ["email"], // single-field uniqueness
    tenantEmail: ["tenantId", "email"], // compound uniqueness
    username: ["username"], // another single-field
  },
})
// #endregion

// #region versioning-declaration
const VersionedUsers = Entity.make({
  model: User,
  entityType: "VersionedUser",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  versioned: {
    retain: true, // keep version history
    ttl: Duration.days(90), // auto-expire old versions
  },
  unique: {
    email: ["email"],
    username: ["username"],
  },
})
// #endregion

// #region idempotency-declaration
const Payments = Entity.make({
  model: Payment,
  entityType: "Payment",
  primaryKey: {
    pk: { field: "pk", composite: ["paymentId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  unique: {
    idempotencyKey: { fields: ["idempotencyKey"], ttl: Duration.hours(1) },
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 4. Table definition
// ---------------------------------------------------------------------------

// #region table
const MainTable = Table.make({
  schema: AppSchema,
  entities: { Users, VersionedUsers, Payments },
})
// #endregion

// ---------------------------------------------------------------------------
// 5. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({ entities: { Users, VersionedUsers, Payments } })

  yield* Console.log("=== Setup ===\n")
  yield* db.tables["integrity-demo-table"]!.create()
  yield* Console.log("Table created\n")

  // -------------------------------------------------------------------------
  // Unique Constraints — Error Handling
  // -------------------------------------------------------------------------
  yield* Console.log("=== Unique Constraints ===\n")

  // #region unique-error-handling
  yield* db.entities.Users.put({
    userId: "u-1",
    email: "alice@example.com",
    username: "alice",
    tenantId: "t-acme",
    displayName: "Alice",
  })

  // Same email → UniqueConstraintViolation
  const duplicateResult = yield* db.entities.Users.put({
    userId: "u-2",
    email: "alice@example.com",
    username: "bob",
    tenantId: "t-acme",
    displayName: "Bob",
  }).pipe(
    Effect.catchTag("UniqueConstraintViolation", (e) => {
      // e.entityType === "User"
      // e.constraint === "email" or "username"
      // e.fields === { email: "alice@example.com" }
      return Effect.succeed(
        `Blocked: constraint="${e.constraint}", fields=${JSON.stringify(e.fields)}`,
      )
    }),
  )
  // Blocked: constraint="email", fields={"email":"alice@example.com"}
  // #endregion
  yield* Console.log(`Duplicate email: ${duplicateResult}`)

  // Compound constraint allows same email in different tenants
  yield* db.entities.Users.put({
    userId: "u-3",
    email: "alice@example.com",
    username: "alice-other",
    tenantId: "t-other",
    displayName: "Alice (Other Tenant)",
  }).pipe(
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      Effect.succeed(`Blocked: constraint="${e.constraint}"`),
    ),
  )
  yield* Console.log("Same email, different tenant: blocked by single-field email constraint\n")

  // -------------------------------------------------------------------------
  // Versioning + Optimistic Concurrency
  // -------------------------------------------------------------------------
  yield* Console.log("=== Versioning + Optimistic Concurrency ===\n")

  // #region optimistic-concurrency
  // Create a versioned user
  const user = yield* db.entities.VersionedUsers.put({
    userId: "v-1",
    email: "versioned@example.com",
    username: "versioned-alice",
    tenantId: "t-acme",
    displayName: "Alice",
  })
  // user.version === 1

  // Update twice to build history
  yield* db.entities.VersionedUsers.update(
    { userId: "v-1" },
    Entity.set({ displayName: "Alice V2" }),
  )
  // version is now 2

  const current = yield* db.entities.VersionedUsers.update(
    { userId: "v-1" },
    Entity.set({ displayName: "Alice V3" }),
  )
  // current.version === 3

  // Update with optimistic lock — must match current version
  yield* db.entities.VersionedUsers.update(
    { userId: "v-1" },
    Entity.set({ displayName: "Alice V4" }),
    Entity.expectedVersion(3),
  )
  // Succeeds: version was 3, now 4
  // #endregion
  yield* Console.log(`Created versioned user: ${user.displayName} (version starts at 1)`)
  yield* Console.log(`After two updates: ${current.displayName} (version is now 3)`)

  // #region optimistic-lock-error
  // Stale version → OptimisticLockError
  const lockResult = yield* db.entities.VersionedUsers.update(
    { userId: "v-1" },
    Entity.set({ displayName: "Stale Update" }),
    Entity.expectedVersion(2),
  ).pipe(
    Effect.catchTag("OptimisticLockError", (e) =>
      Effect.succeed(`Blocked: expected version ${e.expectedVersion}, actual ${e.actualVersion}`),
    ),
  )
  // Blocked: expected version 2, actual 4
  // #endregion
  yield* Console.log(`Optimistic lock: ${lockResult}\n`)

  // -------------------------------------------------------------------------
  // Querying Versions
  // -------------------------------------------------------------------------
  yield* Console.log("=== Querying Versions ===\n")

  // #region querying-versions
  // Get a specific version snapshot
  const v1 = yield* db.entities.VersionedUsers.getVersion({ userId: "v-1" }, 1)

  // Query version history (most recent first)
  const history = yield* db.entities.VersionedUsers.collect(
    VersionedUsers.versions({ userId: "v-1" }),
  )
  // #endregion
  yield* Console.log(`Version 1 snapshot: ${v1.displayName}`)
  yield* Console.log(`Version history (${history.length} snapshots):`)
  for (const h of history) {
    yield* Console.log(`  v${h.version}: ${h.displayName}`)
  }
  yield* Console.log("")

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------
  yield* Console.log("=== Idempotency ===\n")

  // #region idempotency-usage
  const requestId = "idem-abc-123"

  // First request — succeeds
  const payment = yield* db.entities.Payments.put({
    paymentId: "pay-001",
    amount: 99.99,
    currency: "USD",
    idempotencyKey: requestId,
  })

  // Retry with same idempotency key → blocked
  const retry = yield* db.entities.Payments.put({
    paymentId: "pay-002",
    amount: 99.99,
    currency: "USD",
    idempotencyKey: requestId,
  }).pipe(
    Effect.catchTag("UniqueConstraintViolation", (e) =>
      e.constraint === "idempotencyKey"
        ? Effect.succeed("Duplicate request prevented")
        : Effect.fail(e),
    ),
  )
  // The sentinel has a TTL of 1 hour
  // After expiry, the same key can be reused
  // #endregion
  yield* Console.log(`Payment created: ${payment.paymentId} (key: ${payment.idempotencyKey})`)
  yield* Console.log(`Retry result: ${retry}`)
  yield* Console.log("  The sentinel item has a TTL of 1 hour\n")

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* db.tables["integrity-demo-table"]!.delete()
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
  MainTable.layer({ name: "integrity-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
