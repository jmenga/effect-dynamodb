/**
 * Auto-generated UUID primary keys — effect-dynamodb
 *
 * Demonstrates `Entity.make({ generatedId })`: the named primary-key field is
 * auto-filled with a cryptographically-secure UUID at write time when the
 * caller omits it. A caller-supplied value is always respected.
 *
 * The id is sourced from the bundled `Crypto` service — `DynamoClient.make`
 * provides a default `globalThis.crypto`-backed implementation, so bound `put`
 * stays `R = never` (no Crypto layer required in your program).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/generated-id.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Define a pure domain model — `widgetId` is the primary-key field
// ---------------------------------------------------------------------------

// #region model
class Widget extends Schema.Class<Widget>("Widget")({
  widgetId: Schema.String,
  owner: Schema.String,
  label: Schema.NonEmptyString,
}) {}
// #endregion

const AppSchema = DynamoSchema.make({ name: "widgets", version: 1 })

// ---------------------------------------------------------------------------
// 2. Opt into auto-generated ids via `generatedId`
// ---------------------------------------------------------------------------
// `generatedId.field` MUST exist in the model AND participate in the primary
// key (pk or sk composite). Default version is "v4" (random); "v7" is
// time-ordered. Here `widgetId` also composes into the `byOwner` GSI.

// #region entity
const Widgets = Entity.make({
  model: Widget,
  entityType: "Widget",
  primaryKey: {
    pk: { field: "pk", composite: ["widgetId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byOwner: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["owner"] },
      sk: { field: "gsi1sk", composite: ["widgetId"] },
    },
  },
  // Auto-generate `widgetId` with a UUIDv4 when the caller omits it.
  generatedId: { field: "widgetId" },
})
// #endregion

const WidgetsTable = Table.make({ schema: AppSchema, entities: { Widgets } })

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // The typed client bundles a default Crypto service — no Crypto layer needed.
  const db = yield* DynamoClient.make({
    entities: { Widgets },
    tables: { WidgetsTable },
  })

  yield* db.tables.WidgetsTable.create()
  yield* Console.log("Table created: generated-id-demo\n")

  // #region put
  // No `widgetId` supplied — the library fills it from the Crypto service.
  const created = yield* db.entities.Widgets.put({
    owner: "alice",
    label: "Sprocket",
  })
  // created.widgetId is a freshly-generated UUID
  // #endregion
  yield* Console.log(`Generated widgetId: ${created.widgetId}`)

  // Queryable by primary key (the generated id composed into the PK).
  const fetched = yield* db.entities.Widgets.get({ widgetId: created.widgetId })
  yield* Console.log(`Fetched: ${fetched.label} (owner: ${fetched.owner})`)

  // Queryable by the GSI the generated id composes into.
  const byOwner = yield* db.entities.Widgets.byOwner({ owner: "alice" }).collect()
  yield* Console.log(`byOwner found: ${byOwner.length} widget(s)`)

  // #region explicit
  // A caller-supplied id is always respected (never overwritten).
  const explicit = yield* db.entities.Widgets.put({
    widgetId: "widget-explicit-1",
    owner: "bob",
    label: "Cog",
  })
  // explicit.widgetId === "widget-explicit-1"
  // #endregion
  yield* Console.log(`Explicit widgetId: ${explicit.widgetId}`)

  yield* db.tables.WidgetsTable.delete()
  yield* Console.log("\nTable deleted.")
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
  WidgetsTable.layer({ name: "generated-id-demo" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("Done."),
  (err) => console.error("Failed:", err),
)
