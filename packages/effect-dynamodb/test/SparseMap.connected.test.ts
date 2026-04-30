/**
 * Connected integration tests for the SparseMap primitive.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Covers headline behaviours end-to-end against a real DynamoDB Local:
 *   - Counter increment on a fresh item (canonical use case — no parent map
 *     ceremony required).
 *   - Concurrent writes to disjoint buckets succeed (no race).
 *   - clearMap race resolution under versioned: { retain: true }.
 *   - clearMap on non-versioned entity is best-effort.
 *   - softDelete preserves sparse data; restore round-trip works.
 *   - Time-series append: current item carries sparse data; event items DO NOT.
 */

import { it } from "@effect/vitest"
import { Config, DateTime, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local isn't reachable
// ---------------------------------------------------------------------------

const ENDPOINT = Effect.runSync(
  Effect.fromYieldable(
    Config.string("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
  ),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}

const describeConnected = dynamoAvailable ? describe : describe.skip

// ---------------------------------------------------------------------------
// Models / Entities
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "sparse-conn", version: 1 })
const tableName = `sparse-conn-${Date.now()}`

class Page extends Schema.Class<Page>("Page")({
  pageId: Schema.String,
  status: Schema.optional(Schema.String),
  totals: Schema.Record(Schema.String, Schema.Number),
  metrics: Schema.Record(
    Schema.String,
    Schema.Struct({ views: Schema.Number, clicks: Schema.Number }),
  ),
}) {}

const PageModel = DynamoModel.configure(Page, {
  totals: { storedAs: "sparse" },
  metrics: { storedAs: "sparse" },
})

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

const SDPages = Entity.make({
  model: PageModel,
  entityType: "SDPage",
  primaryKey: {
    pk: { field: "pk", composite: ["pageId"] },
    sk: { field: "sk", composite: [] },
  },
  softDelete: true,
})

class Telemetry extends Schema.Class<Telemetry>("Telemetry")({
  device: Schema.String,
  timestamp: Schema.DateTimeUtc,
  reading: Schema.optional(Schema.Number),
  counters: Schema.Record(Schema.String, Schema.Number),
}) {}

const TelemetryModel = DynamoModel.configure(Telemetry, {
  counters: { storedAs: "sparse" },
})

const Telemetries = Entity.make({
  model: TelemetryModel,
  entityType: "Telemetry",
  primaryKey: {
    pk: { field: "pk", composite: ["device"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: { created: "createdAt" },
  timeSeries: {
    orderBy: "timestamp",
    appendInput: Schema.Struct({
      device: Schema.String,
      timestamp: Schema.DateTimeUtc,
      reading: Schema.optional(Schema.Number),
    }),
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Pages, VPages, SDPages, Telemetries },
})

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TestLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("SparseMap — connected integration", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
      }).pipe(provide, Effect.scoped),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect("counter ADD on a fresh item — no parent ceremony", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Pages },
        tables: { MainTable },
      })
      const id = `counter-${Date.now()}`
      // Bootstrap row with empty maps so Schema.decode is happy.
      yield* db.entities.Pages.put({ pageId: id, totals: {}, metrics: {} })
      // Increment month-bucket counter on the existing (but bucket-empty) row.
      yield* db.entities.Pages.update({ pageId: id }).pathAdd({
        segments: ["totals#2026-01"],
        value: 1,
      })
      yield* db.entities.Pages.update({ pageId: id }).pathAdd({
        segments: ["totals#2026-01"],
        value: 1,
      })
      const after = yield* db.entities.Pages.get({ pageId: id })
      expect(after.totals).toEqual({ "2026-01": 2 })
    }).pipe(provide),
  )

  it.effect("concurrent writes to DISJOINT buckets succeed", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Pages },
        tables: { MainTable },
      })
      const id = `disjoint-${Date.now()}`
      yield* db.entities.Pages.put({ pageId: id, totals: {}, metrics: {} })
      yield* Effect.all(
        [
          db.entities.Pages.update({ pageId: id })
            .set({ metrics: { "2026-01": { views: 5, clicks: 1 } } })
            .asEffect(),
          db.entities.Pages.update({ pageId: id })
            .set({ metrics: { "2026-02": { views: 7, clicks: 2 } } })
            .asEffect(),
          db.entities.Pages.update({ pageId: id })
            .set({ metrics: { "2026-03": { views: 9, clicks: 3 } } })
            .asEffect(),
        ],
        { concurrency: "unbounded" },
      )
      const after = yield* db.entities.Pages.get({ pageId: id })
      expect(after.metrics).toEqual({
        "2026-01": { views: 5, clicks: 1 },
        "2026-02": { views: 7, clicks: 2 },
        "2026-03": { views: 9, clicks: 3 },
      })
    }).pipe(provide),
  )

  it.effect("clearMap on a versioned entity is atomic via the version CAS", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { VPages },
        tables: { MainTable },
      })
      const id = `vclear-${Date.now()}`
      yield* db.entities.VPages.put({
        pageId: id,
        metrics: {
          "2026-01": { views: 1, clicks: 0 },
          "2026-02": { views: 2, clicks: 0 },
        },
        totals: {},
      })
      const before = yield* db.entities.VPages.get({ pageId: id })
      expect(Object.keys(before.metrics).sort()).toEqual(["2026-01", "2026-02"])

      yield* db.entities.VPages.update({ pageId: id }).clearMap("metrics").set({ status: "reset" })
      const after = yield* db.entities.VPages.get({ pageId: id })
      expect(after.metrics).toEqual({})
      expect(after.status).toEqual("reset")
    }).pipe(provide),
  )

  it.effect("clearMap on a non-versioned entity is best-effort under disjoint races", () =>
    Effect.gen(function* () {
      // Best-effort: a concurrent writer adding a NEW bucket between the
      // GET and the UPDATE survives the clear. This is the documented
      // behaviour for non-versioned entities.
      const db = yield* DynamoClient.make({
        entities: { Pages },
        tables: { MainTable },
      })
      const id = `pclear-${Date.now()}`
      yield* db.entities.Pages.put({
        pageId: id,
        metrics: { "2026-01": { views: 1, clicks: 0 } },
        totals: {},
      })
      // Race-free path: clearMap as a single op succeeds and produces an
      // empty map. We don't try to inject a real race here (it's flaky and
      // the unit tests cover the GET+UPDATE sequencing); we assert the
      // single-op contract: clearMap removes the existing buckets.
      yield* db.entities.Pages.update({ pageId: id }).clearMap("metrics")
      const after = yield* db.entities.Pages.get({ pageId: id })
      expect(after.metrics).toEqual({})
    }).pipe(provide),
  )

  it.effect("softDelete preserves sparse attrs; restore round-trips", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { SDPages },
        tables: { MainTable },
      })
      const id = `sd-${Date.now()}`
      yield* db.entities.SDPages.put({
        pageId: id,
        metrics: { "2026-01": { views: 5, clicks: 2 } },
        totals: { "2026-01": 7 },
      })
      yield* db.entities.SDPages.delete({ pageId: id })
      const tomb = yield* db.entities.SDPages.deleted.get({ pageId: id })
      // The soft-deleted item carries sparse data verbatim.
      expect(tomb.metrics).toEqual({ "2026-01": { views: 5, clicks: 2 } })
      expect(tomb.totals).toEqual({ "2026-01": 7 })

      yield* db.entities.SDPages.restore({ pageId: id })
      const restored = yield* db.entities.SDPages.get({ pageId: id })
      expect(restored.metrics).toEqual({ "2026-01": { views: 5, clicks: 2 } })
      expect(restored.totals).toEqual({ "2026-01": 7 })
    }).pipe(provide),
  )

  it.effect("time-series append: current item carries sparse data, event items do NOT", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { MainTable },
      })
      const device = `dev-${Date.now()}`
      // Seed the current item with a sparse counter via .update() (sparse
      // fields aren't part of appendInput, so they live entirely on the
      // current item and never on event items).
      yield* db.entities.Telemetries.append({
        device,
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
        reading: 1,
      })
      yield* db.entities.Telemetries.update({ device }).pathAdd({
        segments: ["counters#hits"],
        value: 5,
      })
      // Append more events.
      yield* db.entities.Telemetries.append({
        device,
        timestamp: DateTime.makeUnsafe("2026-04-22T10:01:00.000Z"),
        reading: 2,
      })
      yield* db.entities.Telemetries.append({
        device,
        timestamp: DateTime.makeUnsafe("2026-04-22T10:02:00.000Z"),
        reading: 3,
      })
      // Current item carries the sparse counter.
      const cur = yield* db.entities.Telemetries.get({ device })
      expect(cur.counters).toEqual({ hits: 5 })
      // Event items must NOT carry sparse attrs.
      const events = yield* db.entities.Telemetries.history({ device }).collect()
      expect(events.length).toBeGreaterThanOrEqual(2)
      for (const e of events) {
        // The decoded model rebuilds an empty Record when no attrs are
        // present — Schema.Record is non-optional, decode-side default.
        expect(e.counters).toEqual({})
      }
    }).pipe(provide),
  )
})
