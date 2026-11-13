/**
 * Add-only Writes Guide Example — effect-dynamodb
 *
 * Demonstrates `insert`, which writes through a PartiQL INSERT so IAM can
 * forbid overwrites:
 *   - The item `put` would write, in one request and with no reads
 *   - `ItemAlreadyExists` when the key is taken, with the stored row untouched
 *   - `unique` constraints through an INSERT-only transaction
 *   - The refusal on `versioned: { retain: true }`
 *
 * DynamoDB Local doesn't enforce IAM, so this shows the writes, not the role
 * limit. The guide has the policy.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-add-only-writes.ts
 */

import { Config, Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`Assertion failed [${label}]: ${a} !== ${b}`)
}

// =============================================================================
// 1. Domain
// =============================================================================

const AppSchema = DynamoSchema.make({ name: "audit-demo", version: 1 })

// #region entity
class AuditEntry extends Schema.Class<AuditEntry>("AuditEntry")({
  logId: Schema.String,
  at: Schema.String,
  action: Schema.String,
}) {}

const AuditLog = Entity.make({
  model: AuditEntry,
  entityType: "AuditEntry",
  primaryKey: {
    pk: { field: "pk", composite: ["logId"] },
    sk: { field: "sk", composite: ["at"] },
  },
  timestamps: true,
})
// #endregion

// #region unique-entity
class Account extends Schema.Class<Account>("Account")({
  accountId: Schema.String,
  email: Schema.String,
}) {}

const Accounts = Entity.make({
  model: Account,
  entityType: "Account",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { email: ["email"] },
})
// #endregion

class Page extends Schema.Class<Page>("Page")({
  pageId: Schema.String,
  body: Schema.String,
}) {}

const Pages = Entity.make({
  model: Page,
  entityType: "Page",
  primaryKey: {
    pk: { field: "pk", composite: ["pageId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: { retain: true },
})

const MainTable = Table.make({ schema: AppSchema, entities: { AuditLog, Accounts, Pages } })

// =============================================================================
// 2. Layers
// =============================================================================

const tableName = `add-only-demo-${Date.now()}`

const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  MainTable.layer({ name: tableName }),
)

// =============================================================================
// 3. Program
// =============================================================================

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { AuditLog, Accounts, Pages },
    tables: { MainTable },
  })
  yield* db.tables.MainTable.create()

  // #region insert
  const entry = yield* db.entities.AuditLog.insert({
    logId: "log-1",
    at: "2026-11-06T10:00:00Z",
    action: "login",
  })
  // entry.action → "login"
  // #endregion
  assertEq(entry.action, "login", "insert returns the model")
  yield* Console.log(`Inserted: ${entry.action}`)

  // #region duplicate
  const outcome = yield* db.entities.AuditLog.insert({
    logId: "log-1",
    at: "2026-11-06T10:00:00Z",
    action: "logout",
  })
    .asEffect()
    .pipe(
      Effect.as("added"),
      Effect.catchTag("ItemAlreadyExists", (e) =>
        Effect.succeed(`Already there: ${JSON.stringify(e.key)}`),
      ),
    )
  // Already there: {"logId":"log-1","at":"2026-11-06T10:00:00Z"}
  // #endregion
  assertEq(
    outcome,
    'Already there: {"logId":"log-1","at":"2026-11-06T10:00:00Z"}',
    "duplicate names the key",
  )
  yield* Console.log(outcome)

  const stored = yield* db.entities.AuditLog.get({ logId: "log-1", at: "2026-11-06T10:00:00Z" })
  assertEq(stored.action, "login", "the stored row is untouched")

  // #region unique
  yield* db.entities.Accounts.insert({ accountId: "a-1", email: "ada@example.com" })

  const taken = yield* db.entities.Accounts.insert({
    accountId: "a-2",
    email: "ada@example.com",
  })
    .asEffect()
    .pipe(
      Effect.as("added"),
      Effect.catchTag("UniqueConstraintViolation", (e) =>
        Effect.succeed(`Taken: constraint="${e.constraint}"`),
      ),
    )
  // Taken: constraint="email"
  // #endregion
  assertEq(taken, 'Taken: constraint="email"', "a taken value names its constraint")
  yield* Console.log(taken)

  // #region refused
  const refused = yield* db.entities.Pages.insert({ pageId: "p-1", body: "Hello" })
    .asEffect()
    .pipe(Effect.flip)
  // refused._tag → "ValidationError"
  // #endregion
  assertEq(refused._tag, "ValidationError", "retain is refused")
  yield* Console.log(`Refused: ${refused._tag}`)

  yield* db.tables.MainTable.delete()
})

Effect.runPromise(program.pipe(Effect.provide(AppLayer))).then(() => console.log("\nDone."))
