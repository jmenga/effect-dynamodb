/**
 * indexPolicy v1.7.1 Guide — effect-dynamodb
 *
 * Demonstrates the three contracts of the v1.7.1 per-half model:
 *   - `'preserve'` (default) — contract with other writers ("don't disturb my
 *     key when you fire").
 *   - `'sparse'` — contract with yourself as the half's owner ("drop my key
 *     if I touch this half but can't compose it").
 *   - `Entity.remove([attr])` — explicit signal that a composite is gone;
 *     the library REMOVEs the half(s) containing the cleared attribute.
 *
 * Three runnable scenarios, each backing a worked example in the docs:
 *   1. Single-writer sparse — alert lifecycle on a hybrid GSI.
 *   2. Multi-writer preserve + sparse — full rejoin-without-re-firing flow.
 *   3. Hierarchical truncation — set surviving + remove leaf demotes the SK.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-index-policy.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// =============================================================================
// Helpers
// =============================================================================

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

// =============================================================================
// 1. Model — a hybrid telemetry-style device
// =============================================================================

// #region model
class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  // Enrichment-owned (preserve on pk).
  accountId: Schema.optional(Schema.String),
  // Telemetry-owned (sparse on sk).
  alertState: Schema.optional(Schema.Literals(["active", "cleared"])),
  timestamp: Schema.optional(Schema.String),
  // Stamp attribute — not in any GSI.
  published: Schema.optional(Schema.String),
}) {}
// #endregion

// =============================================================================
// 2. Entity with per-half indexPolicy on the canonical hybrid GSI
// =============================================================================

// #region schema
const AppSchema = DynamoSchema.make({ name: "indexpolicy-demo", version: 1 })
// #endregion

// #region entity
const Devices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    // byCurrentAlert — the canonical hybrid GSI: pk is enrichment-owned
    // (preserve so telemetry doesn't disturb it); sk is telemetry-owned
    // (sparse so an event without an alert drops the half).
    byCurrentAlert: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["accountId"] },
      sk: { field: "gsi1sk", composite: ["alertState", "timestamp"] },
      indexPolicy: { pk: "preserve", sk: "sparse" },
    },
  },
  timestamps: true,
})
// #endregion

const AppTable = Table.make({ schema: AppSchema, entities: { Devices } })

// =============================================================================
// 3. Scenario 1 — Single-writer sparse (alert lifecycle)
// =============================================================================

const scenario1 = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Devices },
    tables: { AppTable },
  })

  yield* Console.log("\n=== Scenario 1: Single-writer sparse — alert lifecycle ===")

  // #region single-writer-sparse
  // Lifecycle: alertState is the only sk composite, and it's owned by a
  // single ingest writer. Declaring sk: sparse means "if my event doesn't
  // have an alertState, drop my sk key — the item shouldn't be in this GSI."
  yield* db.entities.Devices.put({
    channel: "c-1",
    deviceId: "d-1",
    accountId: "acme",
    alertState: "active",
    timestamp: "2026-04-30T10:00:00Z",
  })

  // "No alert this event" — alertState explicitly undefined. sk touched
  // (alertState is in payload), can't compose (empty leading prefix) →
  // sparse → REMOVE sk. pk untouched → preserved.
  yield* db.entities.Devices.update({ channel: "c-1", deviceId: "d-1" }).set({
    alertState: undefined,
    timestamp: "2026-04-30T11:00:00Z",
  })
  // Item invisible in byCurrentAlert (DDB needs both keys), but gsi1pk
  // preserved. Re-adding alertState recomposes sk → item rejoins WITHOUT
  // the enrichment writer needing to re-fire.
  // #endregion

  const dropped = yield* db.entities.Devices.byCurrentAlert({
    accountId: "acme",
  }).collect()
  assertEq(
    dropped.some((d) => d.deviceId === "d-1"),
    false,
    "scenario 1 — d-1 dropped from GSI",
  )

  // Re-add alertState — item should rejoin under preserved pk.
  yield* db.entities.Devices.update({ channel: "c-1", deviceId: "d-1" }).set({
    alertState: "active",
    timestamp: "2026-04-30T12:00:00Z",
  })
  const rejoined = yield* db.entities.Devices.byCurrentAlert({
    accountId: "acme",
  }).collect()
  assertEq(
    rejoined.some((d) => d.deviceId === "d-1"),
    true,
    "scenario 1 — d-1 rejoined under preserved pk",
  )
  yield* Console.log("  d-1 dropped under sparse → rejoined under preserved pk")
})

// =============================================================================
// 4. Scenario 2 — Multi-writer preserve + sparse (full lifecycle)
// =============================================================================

const scenario2 = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Devices },
    tables: { AppTable },
  })

  yield* Console.log("\n=== Scenario 2: Multi-writer preserve + sparse — full lifecycle ===")

  // #region multi-writer
  // Item exists with all composites populated.
  yield* db.entities.Devices.put({
    channel: "c-2",
    deviceId: "d-2",
    accountId: "acme",
    alertState: "active",
    timestamp: "2026-04-30T10:00:00Z",
  })

  // Stamp writer — touches a non-composite attribute. Both halves untouched
  // → both preserved. (v1.7.0 would have REMOVE'd sk because sparse fired
  // on the untouched sk half.)
  yield* db.entities.Devices.update({ channel: "c-2", deviceId: "d-2" }).set({
    published: "2026-04-30",
  })
  // Item still visible in GSI under acme + active.

  // Enrichment writer rotates the account. pk touched → SET pk full
  // (account#newAcct). sk untouched → noop. Item re-indexes under newAcct;
  // stored gsi1sk unchanged.
  yield* db.entities.Devices.update({ channel: "c-2", deviceId: "d-2" }).set({
    accountId: "newAcct",
  })

  // Telemetry writer fires fresh. sk touched → SET sk full
  // (alert#active#ts#T2). pk untouched → noop.
  yield* db.entities.Devices.update({ channel: "c-2", deviceId: "d-2" }).set({
    alertState: "active",
    timestamp: "2026-04-30T11:00:00Z",
  })

  // Telemetry "no alert" event — sk touched, can't compose, sparse →
  // REMOVE sk. pk preserved. Item invisible in GSI but gsi1pk persists.
  yield* db.entities.Devices.update({ channel: "c-2", deviceId: "d-2" }).set({
    alertState: undefined,
    timestamp: "2026-04-30T12:00:00Z",
  })

  // Telemetry rejoins. sk touched, composes fine → SET sk full. pk
  // untouched, value still acme from way back. Item re-visible under
  // newAcct + new sk — WITHOUT the enrichment writer re-firing. This is
  // the critical multi-writer property the v1.7.1 per-key roll-up enables.
  yield* db.entities.Devices.update({ channel: "c-2", deviceId: "d-2" }).set({
    alertState: "active",
    timestamp: "2026-04-30T13:00:00Z",
  })
  // #endregion

  const final = yield* db.entities.Devices.byCurrentAlert({
    accountId: "newAcct",
  }).collect()
  assertEq(
    final.some((d) => d.deviceId === "d-2"),
    true,
    "scenario 2 — d-2 visible under newAcct after rejoin",
  )
  yield* Console.log("  Multi-writer round-trip succeeded — d-2 in GSI under newAcct")
})

// =============================================================================
// 5. Scenario 3 — Hierarchical truncation via set+remove
// =============================================================================

class Asset extends Schema.Class<Asset>("Asset")({
  assetId: Schema.String,
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  site: Schema.optional(Schema.String),
}) {}

const Assets = Entity.make({
  model: Asset,
  entityType: "Asset",
  primaryKey: {
    pk: { field: "pk", composite: ["assetId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byLocation: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", composite: ["country", "city", "site"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
})

const HierTable = Table.make({ schema: AppSchema, entities: { Assets } })

const scenario3 = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Assets },
    tables: { HierTable },
  })

  yield* Console.log("\n=== Scenario 3: Hierarchical truncation via set+remove ===")

  // #region hierarchy-demo
  // Initial state — full hierarchy populated.
  yield* db.entities.Assets.put({
    assetId: "rack-42",
    region: "americas",
    country: "us",
    city: "sf",
    site: "datacenter-1",
  })
  // gsi1sk = "$indexpolicy-demo#v1#asset#country_us#city_sf#site_datacenter-1"

  // Asset leaves the datacenter — *demote*, don't evict. Supply surviving
  // composites via set; invalidate the leaf via remove. Per the set/remove
  // asymmetry, the structural rule succeeds with the leading prefix
  // [country, city] → SET sk truncated. The cascade override only fires
  // when the rule CAN'T compose — here it composes fine.
  yield* db.entities.Assets.update({ assetId: "rack-42" })
    .set({ country: "us", city: "sf" })
    .remove(["site"])
  // gsi1sk = "$indexpolicy-demo#v1#asset#country_us#city_sf"
  // Asset still queryable at city level via begins_with.
  // #endregion

  const atRegion = yield* db.entities.Assets.byLocation({
    region: "americas",
  }).collect()
  assertEq(
    atRegion.some((a) => a.assetId === "rack-42"),
    true,
    "scenario 3 — rack-42 still in GSI after demote",
  )
  yield* Console.log("  rack-42 demoted from datacenter → still queryable at city level")
})

// =============================================================================
// 6. Layer + run
// =============================================================================

// #region run
const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: "http://localhost:8000",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const AppLayer = Layer.mergeAll(ClientLayer, AppTable.layer({ name: "indexpolicy-demo" }))
const HierLayer = Layer.mergeAll(
  ClientLayer,
  HierTable.layer({ name: "indexpolicy-demo-hier" }),
)

const main = Effect.gen(function* () {
  // Setup tables.
  const setupApp = Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Devices },
      tables: { AppTable },
    })
    yield* db.tables.AppTable.create()
  }).pipe(Effect.provide(AppLayer))
  const setupHier = Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Assets },
      tables: { HierTable },
    })
    yield* db.tables.HierTable.create()
  }).pipe(Effect.provide(HierLayer))

  yield* setupApp
  yield* setupHier

  // Run scenarios.
  yield* scenario1.pipe(Effect.provide(AppLayer))
  yield* scenario2.pipe(Effect.provide(AppLayer))
  yield* scenario3.pipe(Effect.provide(HierLayer))

  // Teardown.
  const teardownApp = Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Devices },
      tables: { AppTable },
    })
    yield* db.tables.AppTable.delete()
  }).pipe(Effect.provide(AppLayer))
  const teardownHier = Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Assets },
      tables: { HierTable },
    })
    yield* db.tables.HierTable.delete()
  }).pipe(Effect.provide(HierLayer))

  yield* teardownApp
  yield* teardownHier

  yield* Console.log("\nAll v1.7.1 indexPolicy scenarios passed.")
})

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
