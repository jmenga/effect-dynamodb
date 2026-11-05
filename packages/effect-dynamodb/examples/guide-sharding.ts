/**
 * Guide: Write Sharding — effect-dynamodb
 *
 * Demonstrates the GSI write sharding API as documented in the Write Sharding guide:
 *   - Declaring `shards` on a secondary index, and the stored key it composes
 *   - `.collect()`, `.reverse()`, `.count()` and `.select()` over the merged shards
 *   - A `fetch` chain whose cursor carries one position per shard
 *   - `.concurrency()`, `.explain()` and `.onRequest()`
 *   - `by`: pruning a query to one shard, and what an update must carry
 *   - Adopting sharding on a populated index: `previous`, then `rekey`
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-sharding.ts
 */

import { Config, Console, Effect, Layer, Option, Schema, Stream } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
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
// 1. Pure domain model
// =============================================================================

// #region model
class Device extends Schema.Class<Device>("Device")({
  channel: Schema.String,
  deviceId: Schema.String,
  tenantId: Schema.String,
  groupId: Schema.String,
  status: Schema.String,
}) {}
// #endregion

// =============================================================================
// 2. A sharded index
// =============================================================================

// #region entity
const Devices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: {
    pk: { field: "pk", composite: ["channel"] },
    sk: { field: "sk", composite: ["deviceId"] },
  },
  indexes: {
    // One logical partition per tenant, stored in 8 physical ones. Each write
    // hashes the item's primary key composites to choose its shard.
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      shards: 8,
    },
    // Each group stays on one shard, so a query that pins `groupId` reads one.
    byGroup: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["tenantId"] },
      sk: { field: "gsi2sk", composite: ["groupId", "deviceId"] },
      shards: { count: 8, by: ["groupId"] },
    },
  },
})
// #endregion

const AppSchema = DynamoSchema.make({ name: "guide-sharding", version: 1 })
const MainTable = Table.make({ schema: AppSchema, entities: { Devices } })
const tableName = "guide-sharding-table"

// =============================================================================
// 3. The same index across an adoption: three deployments
// =============================================================================

const stateFields = {
  name: "gsi1",
  pk: { field: "gsi1pk", composite: ["tenantId"] },
  sk: { field: "gsi1sk", composite: ["deviceId"] },
} as const

const deviceKey = {
  pk: { field: "pk", composite: ["channel"] },
  sk: { field: "sk", composite: ["deviceId"] },
} as const

const OldDevices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: deviceKey,
  indexes: { byTenant: stateFields },
})

// #region adopt-deploy
// Step 1: the live deployment. Writes compose the new layout; reads also read the
// old one (`previous: 1`: the single unsharded partition).
const MovingDevices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: deviceKey,
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      shards: { count: 8, previous: 1 },
    },
  },
})
// #endregion

const MovedDevices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: deviceKey,
  indexes: { byTenant: { ...stateFields, shards: 8 } },
})

const OldTable = Table.make({ schema: AppSchema, entities: { Devices: OldDevices } })
const MovingTable = Table.make({ schema: AppSchema, entities: { Devices: MovingDevices } })
const MovedTable = Table.make({ schema: AppSchema, entities: { Devices: MovedDevices } })
const adoptionTableName = "guide-sharding-adoption"

// =============================================================================
// 4. Seed data
// =============================================================================

const TENANT = "t-123"
const GROUPS = ["group-a", "group-b", "group-c", "group-d"] as const

const devices = Array.from({ length: 200 }, (_, n) => ({
  channel: `channel-${n % 5}`,
  deviceId: `d-${String(n).padStart(3, "0")}`,
  tenantId: TENANT,
  groupId: GROUPS[n % GROUPS.length]!,
  status: n % 2 === 0 ? "online" : "offline",
}))

const idsOf = (items: ReadonlyArray<{ readonly deviceId: string }>) =>
  items.map((item) => item.deviceId)
const everyId = devices.map((device) => device.deviceId)

// =============================================================================
// 5. Main program
// =============================================================================

// #region program
const program = Effect.gen(function* () {
  // #region client
  const db = yield* DynamoClient.make({
    entities: { Devices },
    tables: { MainTable },
  })
  // #endregion

  // Start clean: drop the tables a failed earlier run may have left behind
  yield* db.tables.MainTable.delete().pipe(
    Effect.catchTag("ResourceNotFoundError", () => Effect.void),
  )
  yield* db.tables.MainTable.create()
  yield* Batch.write(devices.map((device) => Devices.put(device)))

  // -------------------------------------------------------------------------
  // The stored key
  // -------------------------------------------------------------------------
  yield* Console.log("=== Stored keys ===\n")

  const raw = yield* DynamoClient
  // #region stored-key
  const { Items: stored } = yield* raw.scan({ TableName: tableName, Limit: 1 })
  // stored[0].gsi1pk → { S: "$guide-sharding#v1#device#!8.3#tenantid_t-123" }
  // stored[0].gsi1sk → { S: "$guide-sharding#v1#device#deviceid_d-…" }
  // #endregion
  const storedKey = stored?.[0]?.gsi1pk?.S ?? ""
  if (!/^\$guide-sharding#v1#device#!8\.[0-7]#tenantid_t-123$/.test(storedKey)) {
    throw new Error(`Unexpected stored key: ${storedKey}`)
  }
  yield* Console.log(`gsi1pk: ${storedKey}\n`)

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------
  yield* Console.log("=== Reads ===\n")

  // #region collect
  // Reads all 8 shards and merges them into the index's order.
  const all = yield* db.entities.Devices.byTenant({ tenantId: TENANT }).collect()
  // Merging in descending order: exactly the reverse.
  const descending = yield* db.entities.Devices.byTenant({ tenantId: TENANT })
    .reverse()
    .collect()
  // Each shard is counted, and the counts summed.
  const total = yield* db.entities.Devices.byTenant({ tenantId: TENANT }).count()
  // #endregion
  assertEq(idsOf(all), everyId, "collect is in index order")
  assertEq(idsOf(descending), [...everyId].reverse(), "reverse is the exact reversal")
  assertEq(total, devices.length, "count sums the shards")
  yield* Console.log(`${all.length} devices, first ${all[0]?.deviceId}, last ${all.at(-1)?.deviceId}`)

  // #region select
  // The merge needs each row's keys, so the query reads them and strips them again.
  const statuses = yield* db.entities.Devices.byTenant({ tenantId: TENANT })
    .select(["deviceId", "status"])
    .limit(2)
    .collect()
  // statuses → [{ deviceId: "d-000", status: "online" }, { deviceId: "d-001", status: "offline" }]
  // #endregion
  assertEq(
    statuses as ReadonlyArray<unknown>,
    [
      { deviceId: "d-000", status: "online" },
      { deviceId: "d-001", status: "offline" },
    ],
    "projection strips the keys the merge borrowed",
  )

  // #region fetch-chain
  // Each page's cursor holds every shard's position; the stream ends at the page
  // without one. Rows read past the page are dropped and read again.
  const firstPages = db.entities.Devices.byTenant({ tenantId: TENANT }).limit(30)

  const paged = yield* Stream.paginate(firstPages, (query) =>
    query.fetch().pipe(
      Effect.map((page) =>
        [page.items, Option.map(page.cursor, (cursor) => firstPages.startFrom(cursor))] as const,
      ),
    ),
  ).pipe(Stream.runCollect)
  // #endregion
  assertEq(idsOf(paged), everyId, "a fetch chain equals collect")
  yield* Console.log(`Fetched ${paged.length} in pages of 30`)

  // #region inspect
  // Default: every shard at once. A resumed query may change this.
  const gentle = db.entities.Devices.byTenant({ tenantId: TENANT }).concurrency(2).limit(10)

  const explained = yield* gentle.explain()
  // explained.plan             → "key"
  // explained.keyConditions    → one per shard
  // explained.fanOut?.pruned   → false
  // explained.fanOut?.concurrency → 2
  // explained.fanOut?.partitions  → ["$guide-sharding#v1#device#!8.0#tenantid_t-123", ...]

  // One event per request, with what that request contributed.
  let requests = 0
  let accepted = 0
  yield* gentle
    .onRequest((event) =>
      Effect.sync(() => {
        requests += 1
        accepted += event.accepted
      }),
    )
    .collect()
  // requests → at least 8: one per shard, more where a short page ran dry
  // accepted → 10: rows beyond the limit were read and dropped
  // #endregion
  assertEq(explained.fanOut?.partitions.length, 8, "one partition per shard")
  assertEq(explained.fanOut?.pruned, false, "the default source never prunes")
  assertEq(explained.fanOut?.concurrency, 2, "concurrency")
  assertEq(explained.keyConditions.length, 8, "one key condition per shard")
  assertEq(requests >= 8, true, "at least one request per shard")
  assertEq(accepted, 10, "accepted counts the returned rows")
  yield* Console.log(`${requests} requests for ${accepted} items\n`)

  // -------------------------------------------------------------------------
  // `by`
  // -------------------------------------------------------------------------
  yield* Console.log("=== by ===\n")

  // #region by-prune
  // Every `by` attribute is pinned: one shard, one request.
  const pruned = yield* db.entities.Devices.byGroup({ tenantId: TENANT, groupId: "group-a" }).explain()
  // pruned.fanOut?.partitions.length → 1
  // pruned.fanOut?.pruned            → true

  // `groupId` isn't known: all 8.
  const tenantWide = yield* db.entities.Devices.byGroup({ tenantId: TENANT }).explain()
  // tenantWide.fanOut?.partitions.length → 8

  // The hash folds case, as the default key text does: this finds the same rows.
  const sameGroup = yield* db.entities.Devices.byGroup({
    tenantId: TENANT,
    groupId: "GROUP-A",
  }).collect()
  // #endregion
  assertEq(pruned.fanOut?.partitions.length, 1, "pinned by reads one shard")
  assertEq(pruned.fanOut?.pruned, true, "pruned")
  assertEq(tenantWide.fanOut?.partitions.length, 8, "unpinned by reads all shards")
  assertEq(sameGroup.length, 50, "a query in another case reaches the same shard")
  yield* Console.log(
    `group-a: ${sameGroup.length} devices from ${pruned.fanOut?.partitions.length} shard`,
  )

  const key = { channel: "channel-0", deviceId: "d-000" }

  // #region by-update
  // The new shard needs the partition key composites as well: without `tenantId` in
  // the update the key can't be composed, so nothing is written (EDD-9100).
  const refused = yield* db.entities.Devices.update(key)
    .set({ groupId: "group-b" })
    .asEffect()
    .pipe(Effect.flip)

  // With them, the entry moves to the new group's shard.
  yield* db.entities.Devices.update(key).set({ tenantId: TENANT, groupId: "group-b" })
  // #endregion
  if (refused._tag !== "ValidationError" || !String(refused.cause).includes("[EDD-9100]")) {
    throw new Error(`Expected EDD-9100, got ${String(refused)}`)
  }
  const moved = yield* db.entities.Devices.byGroup({ tenantId: TENANT, groupId: "group-b" }).collect()
  assertEq(
    moved.some((device) => device.deviceId === "d-000"),
    true,
    "the update moved the index entry to the new group's shard",
  )
  yield* Console.log("update without tenantId: EDD-9100\n")

  yield* db.tables.MainTable.delete()

  // -------------------------------------------------------------------------
  // Adoption
  // -------------------------------------------------------------------------
  yield* Console.log("=== Adoption ===\n")

  const oldDb = yield* DynamoClient.make({
    entities: { Devices: OldDevices },
    tables: { MainTable: OldTable },
  })
  yield* oldDb.tables.MainTable.delete().pipe(
    Effect.catchTag("ResourceNotFoundError", () => Effect.void),
  )
  yield* oldDb.tables.MainTable.create()
  yield* Batch.write(devices.map((device) => OldDevices.put(device)))

  // #region adopt-rekey
  const movingDb = yield* DynamoClient.make({
    entities: { Devices: MovingDevices },
    tables: { MainTable: MovingTable },
  })

  // Reads see every row in both layouts, each once.
  const during = yield* movingDb.entities.Devices.byTenant({ tenantId: TENANT }).collect()

  // Step 2: move the rows that are left. A dry run counts them first.
  const dryRun = yield* movingDb.tables.MainTable.rekey({ dryRun: true })
  const report = yield* movingDb.tables.MainTable.rekey({ segments: 2 })
  // dryRun.indexKeysRewritten → 200
  // report.indexKeysRewritten → 200
  // report.conflicts          → []
  // #endregion
  assertEq(idsOf(during), everyId, "every item once during the transition")
  assertEq(dryRun.indexKeysRewritten, devices.length, "dry run counts the old layout")
  assertEq(report.indexKeysRewritten, devices.length, "rekey moves the old layout")
  assertEq(report.conflicts.length, 0, "no conflicts")
  yield* Console.log(`rekey rewrote ${report.indexKeysRewritten} index keys`)

  // #region adopt-finish
  // Step 3: deploy without `previous`. Only the 8 shards are read now.
  const movedDb = yield* DynamoClient.make({
    entities: { Devices: MovedDevices },
    tables: { MainTable: MovedTable },
  })
  const after = yield* movedDb.entities.Devices.byTenant({ tenantId: TENANT }).collect()
  // #endregion
  assertEq(idsOf(after), everyId, "nothing is missing after the adoption")
  yield* Console.log(`${after.length} devices after removing previous`)

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===\n")
  yield* movedDb.tables.MainTable.delete()
  yield* Console.log("Tables deleted.")
})
// #endregion

// =============================================================================
// 6. Provide dependencies and run
// =============================================================================

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  MainTable.layer({ name: tableName }),
  OldTable.layer({ name: adoptionTableName }),
  MovingTable.layer({ name: adoptionTableName }),
  MovedTable.layer({ name: adoptionTableName }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(() => console.log("\nDone."))
// #endregion
