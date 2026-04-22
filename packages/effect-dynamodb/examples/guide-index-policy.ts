/**
 * indexPolicy Guide — effect-dynamodb
 *
 * Demonstrates per-GSI `indexPolicy` for controlling how `Entity.update` and
 * time-series `.append` handle missing composite attributes:
 *   - Default `preserve` — missing composites leave the GSI's keys alone.
 *   - Explicit `"sparse"` — missing composites REMOVE the GSI keys (item drops out).
 *   - Explicit `"preserve"` — same as default, declared for documentation.
 *   - Hybrid writers — ingest and enrichment each own disjoint composite attrs.
 *   - REMOVE cascade precedence — `Entity.remove(attr)` always drops the GSI.
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
import * as DynamoSchema from "../src/DynamoSchema.js"
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
// 1. Model — a telemetry-style device with attrs owned by different writers
// =============================================================================

// #region model
class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  // Owned by an enrichment writer (set once, rarely changes).
  tenantId: Schema.optional(Schema.String),
  // Owned by the ingest writer; per-event, may be absent on non-alert events.
  alertState: Schema.optional(Schema.Literals(["active", "cleared"])),
  label: Schema.optional(Schema.String),
}) {}
// #endregion

// =============================================================================
// 2. Schema + Entity with indexPolicy on each GSI
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
    // byAlert — sparse on alertState.
    // When an ingest event omits alertState (plain telemetry), the policy
    // REMOVEs the GSI keys so the device drops out of the alert view.
    byAlert: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["alertState"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      indexPolicy: () => ({ alertState: "sparse" as const }),
    },
    // byTenant — preserve on tenantId.
    // Ingest writers never touch tenantId. When an ingest-side update fires,
    // the preserve policy leaves the stored gsi2pk/gsi2sk untouched so the
    // device remains queryable via the enrichment writer's tenant assignment.
    byTenant: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["tenantId"] },
      sk: { field: "gsi2sk", composite: ["deviceId"] },
      indexPolicy: () =>
        ({ tenantId: "preserve" as const, deviceId: "preserve" as const }) as const,
    },
  },
  timestamps: true,
})
// #endregion

const AppTable = Table.make({ schema: AppSchema, entities: { Devices } })

// =============================================================================
// 3. Program — demonstrates every scenario
// =============================================================================

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Devices },
    tables: { AppTable },
  })

  // Fresh table for the demo.
  yield* db.tables.AppTable.create()

  yield* Console.log("\n=== 1. put with full composites — item indexed under both GSIs ===")

  // #region put-full
  yield* db.entities.Devices.put({
    channel: "c-1",
    deviceId: "d-1",
    tenantId: "acme",
    alertState: "active",
    label: "initial",
  })

  const alertActive = yield* db.entities.Devices.byAlert({ alertState: "active" }).collect()
  const acmeTenant = yield* db.entities.Devices.byTenant({ tenantId: "acme" }).collect()
  // →  alertActive contains d-1; acmeTenant contains d-1
  // #endregion

  assertEq(alertActive.length, 1, "byAlert has d-1")
  assertEq(acmeTenant.length, 1, "byTenant has d-1")
  yield* Console.log(`  byAlert(active): ${alertActive.length}, byTenant(acme): ${acmeTenant.length}`)

  yield* Console.log(
    "\n=== 2. sparse dropout — clearing alertState removes item from byAlert ===",
  )

  // #region sparse-drop
  // Update WITHOUT alertState in the payload. Because byAlert declares an
  // `indexPolicy` with alertState 'sparse', the GSI is always evaluated on
  // every update — alertState absent from payload is treated as "not set"
  // per the policy → REMOVE gsi1pk/gsi1sk. The item drops out of byAlert.
  yield* db.entities.Devices.update(
    { channel: "c-1", deviceId: "d-1" },
    Entity.set({ label: "quiet" }),
  )

  const afterDrop = yield* db.entities.Devices.byAlert({ alertState: "active" }).collect()
  // →  afterDrop is empty — item dropped out of the alert GSI
  // #endregion

  assertEq(afterDrop.length, 0, "d-1 dropped from byAlert")
  yield* Console.log(`  byAlert(active) after clearing: ${afterDrop.length}`)

  // byTenant preserved — the enrichment-owned half was left alone.
  const tenantStillThere = yield* db.entities.Devices.byTenant({ tenantId: "acme" }).collect()
  assertEq(tenantStillThere.length, 1, "byTenant still has d-1")
  yield* Console.log(`  byTenant(acme) preserved: ${tenantStillThere.length}`)

  yield* Console.log("\n=== 3. Re-adding the sparse composite re-indexes the item ===")

  // #region sparse-rehydrate
  yield* db.entities.Devices.update(
    { channel: "c-1", deviceId: "d-1" },
    Entity.set({ alertState: "cleared" }),
  )

  const cleared = yield* db.entities.Devices.byAlert({ alertState: "cleared" }).collect()
  // →  cleared contains d-1 under its new alertState
  // #endregion

  assertEq(cleared.length, 1, "d-1 back in byAlert(cleared)")
  yield* Console.log(`  byAlert(cleared): ${cleared.length}`)

  yield* Console.log("\n=== 4. Hybrid writers never clobber each other's GSI state ===")

  // #region hybrid
  // Start with an un-indexed device (no tenantId, no alertState).
  yield* db.entities.Devices.put({ channel: "c-2", deviceId: "d-2" })

  // Enrichment writer assigns tenantId.
  yield* db.entities.Devices.update(
    { channel: "c-2", deviceId: "d-2" },
    Entity.set({ tenantId: "initech" }),
  )

  // Later, ingest writer sets alertState. tenantId is NOT in this payload,
  // but the preserve policy on byTenant leaves its stored keys alone.
  yield* db.entities.Devices.update(
    { channel: "c-2", deviceId: "d-2" },
    Entity.set({ alertState: "active" }),
  )

  // Both indexes correct — neither writer clobbered the other's composites.
  const finalAlert = yield* db.entities.Devices.byAlert({ alertState: "active" }).collect()
  const finalTenant = yield* db.entities.Devices.byTenant({ tenantId: "initech" }).collect()
  // →  both queries return d-2
  // #endregion

  assertEq(finalAlert.some((d) => d.deviceId === "d-2"), true, "hybrid: d-2 in byAlert")
  assertEq(finalTenant.some((d) => d.deviceId === "d-2"), true, "hybrid: d-2 in byTenant")
  yield* Console.log(`  After hybrid updates: byAlert has d-2 + byTenant has d-2`)

  yield* Console.log("\n=== 5. Entity.remove() cascade — always drops the GSI ===")

  // #region cascade
  // Regardless of indexPolicy, removing a GSI composite attribute drops the
  // item out of that GSI. Cascade takes precedence over preserve/sparse.
  yield* db.entities.Devices.update(
    { channel: "c-2", deviceId: "d-2" },
    Entity.remove(["tenantId"]),
  )

  const tenantAfterRemove = yield* db.entities.Devices.byTenant({ tenantId: "initech" }).collect()
  // →  tenantAfterRemove is empty — cascade overrode the preserve policy
  // #endregion

  assertEq(
    tenantAfterRemove.some((d) => d.deviceId === "d-2"),
    false,
    "cascade: d-2 dropped from byTenant",
  )
  yield* Console.log(`  After Entity.remove(tenantId): byTenant(initech) has d-2? ${
    tenantAfterRemove.some((d) => d.deviceId === "d-2")
  }`)

  yield* Console.log("\nAll indexPolicy scenarios passed.")

  yield* db.tables.AppTable.delete()
})

// =============================================================================
// 4. Layer + run
// =============================================================================

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  AppTable.layer({ name: "indexpolicy-demo" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
