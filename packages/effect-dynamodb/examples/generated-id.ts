/**
 * Generated IDs example — effect-dynamodb
 *
 * Demonstrates:
 *   - `generatedId` entity option: auto-fill a primary-key field with a
 *     cryptographically-secure UUID when the caller omits it
 *   - `version: "v4"` (random, default) vs `"v7"` (time-ordered/sortable)
 *   - A caller-supplied id always wins
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
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

// #region models
class Document extends Schema.Class<Document>("Document")({
  id: Schema.String,
  title: Schema.String,
}) {}

class Event extends Schema.Class<Event>("Event")({
  eventId: Schema.String,
  kind: Schema.String,
}) {}
// #endregion

const AppSchema = DynamoSchema.make({ name: "genid-demo", version: 1 })

// ---------------------------------------------------------------------------
// 2. Entity definitions with generatedId
// ---------------------------------------------------------------------------

// #region entities
// `id` is filled with a random UUIDv4 when omitted on put/create.
const Documents = Entity.make({
  model: Document,
  entityType: "Document",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
  generatedId: { field: "id" },
})

// `eventId` is filled with a time-ordered UUIDv7 (sortable by creation time).
const Events = Entity.make({
  model: Event,
  entityType: "Event",
  primaryKey: {
    pk: { field: "pk", composite: ["eventId"] },
    sk: { field: "sk", composite: [] },
  },
  generatedId: { field: "eventId", version: "v7" },
})
// #endregion

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Documents, Events },
})

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({ entities: { Documents, Events } })

  yield* db.tables["genid-demo-table"]!.create()

  // #region put-without-id
  // Omit `id` — the framework generates a crypto-secure UUIDv4.
  const doc = yield* db.entities.Documents.put({ title: "Hello, world" })
  yield* Console.log(`Generated id: ${doc.id}`) // e.g. f93de86c-1461-4163-...

  // The generated id composes the primary key, so the item is fetchable.
  const fetched = yield* db.entities.Documents.get({ id: doc.id })
  yield* Console.log(`Fetched: ${fetched.title}`)
  // #endregion

  // #region caller-supplied
  // A caller-supplied id always wins — generation only fills a missing field.
  const fixed = yield* db.entities.Documents.put({ id: "doc-fixed", title: "Pinned" })
  yield* Console.log(`Kept id: ${fixed.id}`) // doc-fixed
  // #endregion

  // #region uuidv7
  // UUIDv7 ids are time-ordered — useful as sortable keys.
  const e1 = yield* db.entities.Events.put({ kind: "created" })
  const e2 = yield* db.entities.Events.put({ kind: "updated" })
  yield* Console.log(`v7 ids: ${e1.eventId} < ${e2.eventId}: ${e1.eventId < e2.eventId}`)
  // #endregion

  yield* db.tables["genid-demo-table"]!.delete()
  yield* Console.log("Table deleted.")
})

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "genid-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
