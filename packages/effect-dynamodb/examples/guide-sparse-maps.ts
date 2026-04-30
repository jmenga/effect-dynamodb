/**
 * Sparse Map Guide Example — effect-dynamodb v2
 *
 * Demonstrates the `storedAs: 'sparse'` storage primitive:
 *   - Configuring a Record<K, V> field as a sparse map
 *   - Counter ADD on a fresh item (no parent-map ceremony)
 *   - Record-style writes: one SET per bucket (whole-bucket replace)
 *   - Path-style writes via PathBuilder.entry(key)
 *   - removeEntries — explicit per-key REMOVE
 *   - clearMap — chained with other combinators in one final UpdateItem
 *   - Conditional ops via attribute_exists on the entry path
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-sparse-maps.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// =============================================================================
// 1. Pure domain model — page metrics + per-month counters
// =============================================================================

// #region model
class Page extends Schema.Class<Page>("Page")({
  pageId: Schema.String,
  status: Schema.optional(Schema.String),
  // Sparse map of struct buckets — each month is a DynamoDB Map attribute.
  metrics: Schema.Record(
    Schema.String,
    Schema.Struct({ views: Schema.Number, clicks: Schema.Number }),
  ),
  // Sparse map of scalar buckets — each month is a Number attribute.
  // The bucket attribute IS the scalar, so `ADD totals#<month> :1` works on
  // a fresh item with no parent-map dance.
  totals: Schema.Record(Schema.String, Schema.Number),
}) {}

const PageModel = DynamoModel.configure(Page, {
  metrics: { storedAs: "sparse" },
  totals: { storedAs: "sparse" },
})
// #endregion

const AppSchema = DynamoSchema.make({ name: "sparse-demo", version: 1 })

// =============================================================================
// 2. Entity definition
// =============================================================================

// Non-versioned for the counter use case — counters and disjoint-bucket
// updates flow through the standard UpdateItem path (single, atomic write
// per call). For atomic `clearMap`, a separate `versioned: { retain: true }`
// entity is used below.

// #region define
const Pages = Entity.make({
  model: PageModel,
  entityType: "Page",
  primaryKey: {
    pk: { field: "pk", composite: ["pageId"] },
    sk: { field: "sk", composite: [] },
  },
})

const VPages = Entity.make({
  model: PageModel,
  entityType: "VPage",
  primaryKey: {
    pk: { field: "pk", composite: ["pageId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: { retain: true },
})
// #endregion

const MainTable = Table.make({ schema: AppSchema, entities: { Pages, VPages } })

// =============================================================================
// 3. Layers
// =============================================================================

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: "http://localhost:8000",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const MainTableLayer = MainTable.layer({ name: "sparse-demo-table" })
const AppLayer = Layer.mergeAll(ClientLayer, MainTableLayer)

// =============================================================================
// 4. Program
// =============================================================================

const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  yield* client.createTable({
    TableName: "sparse-demo-table",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(MainTable),
  })

  const db = yield* DynamoClient.make({
    entities: { Pages, VPages },
    tables: { MainTable },
  })

  // ---------- Bootstrap a row with empty sparse maps ----------
  // #region bootstrap
  yield* db.entities.Pages.put({
    pageId: "p-1",
    metrics: {},
    totals: {},
  })
  // #endregion

  // ---------- Counter increment — the headline win ----------
  // ADD totals#2026-04 :1 works on the existing row even with no `totals#*`
  // attributes — the bucket attribute IS the scalar. Concurrent ADDs on the
  // same bucket sum atomically; concurrent ADDs on different buckets never
  // race.
  // #region counter
  yield* db.entities.Pages.update({ pageId: "p-1" }).pathAdd({
    segments: ["totals#2026-04"],
    value: 1,
  })
  yield* db.entities.Pages.update({ pageId: "p-1" }).pathAdd({
    segments: ["totals#2026-04"],
    value: 1,
  })
  // #endregion

  // ---------- Record-style write — whole-bucket replace ----------
  // One SET per bucket. Concurrent writes to disjoint buckets are safe.
  // #region record-style
  yield* db.entities.Pages.update({ pageId: "p-1" }).set({
    metrics: {
      "2026-04": { views: 100, clicks: 10 },
      "2026-05": { views: 80, clicks: 8 },
    },
  })
  // #endregion

  const after1 = yield* db.entities.Pages.get({ pageId: "p-1" })
  yield* Console.log(`After record-style writes: totals=${JSON.stringify(after1.totals)}`)
  yield* Console.log(`                          metrics=${JSON.stringify(after1.metrics)}`)

  // ---------- Path-style — atomic per-leaf update within a known bucket ----------
  // Caveat: requires the bucket to already exist (DynamoDB nested-Map semantics).
  // For new buckets, use record-style first.
  // #region path-style
  yield* db.entities.Pages.update({ pageId: "p-1" }).pathAdd({
    segments: ["metrics#2026-04", "views"],
    value: 1,
  })
  // #endregion

  // ---------- removeEntries — explicit per-key REMOVE ----------
  // Removing a non-existent entry is a no-op (DynamoDB REMOVE semantics).
  // #region remove-entries
  yield* db.entities.Pages.update({ pageId: "p-1" }).removeEntries("metrics", ["2026-05"])
  // #endregion

  // ---------- clearMap chained with other combinators ----------
  // Get-then-Update helper. On a `versioned: { retain: true }` entity the
  // version CAS makes the clear atomic — concurrent writers that add a new
  // bucket between the read and the update fail on stale version, retry
  // resolves. On non-versioned entities, clearMap is best-effort (the new
  // bucket survives the clear) — pick the model that matches your needs.
  //
  // The REMOVE clauses fold into the same final UpdateItem as the SET
  // clauses — one physical write, not two.
  // #region clear-map
  yield* db.entities.VPages.put({
    pageId: "v-1",
    metrics: {
      "2026-04": { views: 100, clicks: 10 },
      "2026-05": { views: 80, clicks: 8 },
    },
    totals: {},
  })
  yield* db.entities.VPages.update({ pageId: "v-1" })
    .clearMap("metrics")
    .set({ status: "reset" })
  // #endregion

  const after2 = yield* db.entities.VPages.get({ pageId: "v-1" })
  yield* Console.log(`After clearMap: metrics=${JSON.stringify(after2.metrics)}, status=${after2.status}`)

  // Cleanup
  yield* client.deleteTable({ TableName: "sparse-demo-table" })
})

// =============================================================================
// 5. Run
// =============================================================================

Effect.runPromise(program.pipe(Effect.provide(AppLayer))).then(
  () => console.log("Done."),
  (error: unknown) => console.error("Failed:", error),
)
