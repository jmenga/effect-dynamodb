/**
 * Pure authoring example — effect-dynamodb (#69)
 *
 * Demonstrates the schema/runtime split end-to-end:
 *   - Define entities ONCE with `@effect-dynamodb/schema` (the AWS-free package)
 *   - Reuse the derived, typed `inputSchema` as an HTTP/validation contract
 *     without pulling the AWS SDK into that module's dependency graph
 *   - Bind those SAME pure definitions to the runtime client via
 *     `DynamoClient.make` and use `db.entities.*` / `db.collections.*`
 *
 * The runtime client transparently promotes each pure definition to a full
 * operational entity at bind time — no re-authoring with the runtime
 * `Entity.make` required.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/pure-authoring.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// AWS-free authoring surface — these imports pull in NO AWS SDK.
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"

// Runtime surface — the AWS-coupled client + table management.
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Pure domain models + entity definitions (no DynamoDB / AWS concepts)
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "pure-authoring", version: 1 })

class User extends Schema.Class<User>("User")({
  orgId: Schema.String,
  userId: Schema.String,
  email: Schema.String,
  name: Schema.String,
}) {}

class Team extends Schema.Class<Team>("Team")({
  orgId: Schema.String,
  teamId: Schema.String,
  label: Schema.String,
}) {}

// `PureEntity.make` returns a pure EntityDefinition: model binding, keys,
// indexes, and derived schemas — but NO AWS operations.
const Users = PureEntity.make({
  model: User,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["orgId"] },
    sk: { field: "sk", composite: ["userId"] },
  },
  indexes: {
    usersByOrg: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["orgId"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
      collection: "members",
    },
  },
})

const Teams = PureEntity.make({
  model: Team,
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["orgId"] },
    sk: { field: "sk", composite: ["teamId"] },
  },
  indexes: {
    teamsByOrg: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["orgId"] },
      sk: { field: "gsi1sk", composite: ["teamId"] },
      collection: "members",
    },
  },
})

// ---------------------------------------------------------------------------
// 2. The derived schema is a ready-made contract — usable in an HTTP API
//    payload or for validation, WITHOUT importing effect-dynamodb's runtime.
// ---------------------------------------------------------------------------

// e.g. `HttpApiEndpoint.post("create", "/users", { payload: Users.inputSchema })`
type CreateUserPayload = typeof Users.inputSchema.Type

const decodeUserPayload = (raw: unknown): Effect.Effect<CreateUserPayload, unknown> =>
  Schema.decodeUnknownEffect(Users.inputSchema)(raw)

// ---------------------------------------------------------------------------
// 3. Register on a physical table and bind to the runtime client
// ---------------------------------------------------------------------------

const MainTable = Table.make({ schema: AppSchema, entities: { Users, Teams } })

const program = Effect.gen(function* () {
  // The SAME pure definitions feed the runtime gateway.
  const db = yield* DynamoClient.make({ entities: { Users, Teams }, tables: { MainTable } })

  yield* db.tables.MainTable.create()
  yield* Console.log("Table created.")

  // Validate an inbound payload against the pure contract, then write it.
  const payload = yield* decodeUserPayload({
    orgId: "acme",
    userId: "u1",
    email: "ann@acme.io",
    name: "Ann",
  })
  yield* db.entities.Users.put(payload)
  yield* db.entities.Users.put({ orgId: "acme", userId: "u2", email: "bob@acme.io", name: "Bob" })
  yield* db.entities.Teams.put({ orgId: "acme", teamId: "t1", label: "Engineering" })
  yield* Console.log("Put 2 users + 1 team.")

  // get
  const ann = yield* db.entities.Users.get({ orgId: "acme", userId: "u1" })
  yield* Console.log(`Got user: ${ann.name} <${ann.email}>`)

  // index query accessor
  const orgUsers = yield* db.entities.Users.usersByOrg({ orgId: "acme" }).collect()
  yield* Console.log(`usersByOrg("acme") → ${orgUsers.map((u) => u.userId).join(", ")}`)

  // auto-discovered cross-entity collection
  const members = (yield* db.collections.members!({ orgId: "acme" }).collect()) as {
    Users: User[]
    Teams: Team[]
  }
  yield* Console.log(
    `collection members("acme") → ${members.Users.length} users, ${members.Teams.length} teams`,
  )

  // update + delete
  yield* db.entities.Users.update({ orgId: "acme", userId: "u1" }).set({ name: "Annie" })
  yield* db.entities.Users.delete({ orgId: "acme", userId: "u2" })
  yield* Console.log("Updated u1, deleted u2.")

  yield* db.tables.MainTable.delete()
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 4. Provide dependencies and run
// ---------------------------------------------------------------------------

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "pure-authoring-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
