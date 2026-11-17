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
 *   - Per-value layouts: a table of values, declared on the entity or supplied at
 *     run time by a `ShardLayouts` layer (from `Config`, or from a config item),
 *     and moving one value with `previous`, `rekey` and `rekey({ dryRun: true })`
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-sharding.ts
 */

import { Config, ConfigProvider, Console, Effect, Layer, Option, Schema, Stream } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as ShardLayouts from "@effect-dynamodb/schema/ShardLayouts.js"
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
    // This sort key holds the whole primary key, so a query can pin all of it.
    byDevice: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["tenantId"] },
      sk: { field: "gsi3sk", composite: ["groupId", "channel", "deviceId"] },
      shards: 8,
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
// 3b. Per-value layouts
// =============================================================================

// #region layouts-entity
const TenantDevices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: deviceKey,
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      // One busy tenant takes 8 shards. Every other tenant keeps one unsharded partition.
      shards: {
        layouts: {
          default: 1,
          values: [{ match: { tenantId: "t-big" }, layout: 8 }],
        },
      },
    },
  },
})
// #endregion

// #region layouts-provided
// The busy tenant's id differs per environment, so the table comes from the
// application at run time, through a ShardLayouts layer.
const ProvidedDevices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: deviceKey,
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      shards: { layouts: "provided" },
    },
  },
})
// #endregion

const LayoutsTable = Table.make({ schema: AppSchema, entities: { Devices: TenantDevices } })
const ProvidedTable = Table.make({ schema: AppSchema, entities: { Devices: ProvidedDevices } })
const layoutsTableName = "guide-sharding-layouts"

// #region layouts-layer
// BIG_TENANT_ID holds the busy tenant's id: t-big here, another id in staging.
const ShardsLayer = ShardLayouts.layer([
  ShardLayouts.of(ProvidedDevices, {
    byTenant: Config.String("BIG_TENANT_ID").pipe(
      Config.map((id) => ({ default: 1, values: [{ match: { tenantId: id }, layout: 8 }] })),
    ),
  }),
])

// Or the whole table as one JSON variable, for several tenants or one mid-migration.
const JsonShardsLayer = ShardLayouts.layer([
  ShardLayouts.of(ProvidedDevices, {
    byTenant: Config.schema(Schema.fromJsonString(ShardLayouts.Table), "DEVICE_SHARDS"),
  }),
])
// #endregion

// The example's configuration: an application reads its environment instead.
const exampleConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    BIG_TENANT_ID: "t-big",
    DEVICE_SHARDS: JSON.stringify({
      default: 1,
      values: [{ match: { tenantId: "t-big" }, layout: 8 }],
    }),
  }),
)

// #region layouts-config-item
class ShardConfig extends Schema.Class<ShardConfig>("ShardConfig")({
  name: Schema.String, // "Devices.byTenant"
  layouts: ShardLayouts.Table,
}) {}

const ShardConfigs = Entity.make({
  model: ShardConfig,
  entityType: "ShardConfig",
  primaryKey: {
    pk: { field: "pk", composite: ["name"] },
    sk: { field: "sk", composite: [] },
  },
})
const ConfigTable = Table.make({ schema: AppSchema, entities: { ShardConfigs } })
// #endregion
const configTableName = "guide-sharding-config"

// #region layouts-layer-effect
// Read once, when the layer is built. A failed read or a missing item fails the
// layer: the application doesn't start, rather than run unsharded.
const ItemShardsLayer = ShardLayouts.layerEffect(
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { ShardConfigs }, tables: { ConfigTable } })
    const devices = yield* db.entities.ShardConfigs.get({ name: "Devices.byTenant" })
    return [ShardLayouts.of(ProvidedDevices, { byTenant: devices.layouts })]
  }),
)
// #endregion

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

const BIG = "t-big"
const bigDevices = Array.from({ length: 40 }, (_, n) => ({
  channel: `channel-${n % 5}`,
  deviceId: `b-${String(n).padStart(3, "0")}`,
  tenantId: BIG,
  groupId: GROUPS[n % GROUPS.length]!,
  status: "online",
}))

const idsOf = (items: ReadonlyArray<{ readonly deviceId: string }>) =>
  items.map((item) => item.deviceId)
const everyId = devices.map((device) => device.deviceId)

// =============================================================================
// 5. Main program
// =============================================================================

// The per-value layouts section, run under the example's configuration.
const perValueLayouts = Effect.gen(function* () {
  // -------------------------------------------------------------------------
  // Per-value layouts
  // -------------------------------------------------------------------------
  yield* Console.log("\n=== Per-value layouts ===\n")

  const layoutsDb = yield* DynamoClient.make({
    entities: { Devices: TenantDevices },
    tables: { MainTable: LayoutsTable },
  })
  yield* layoutsDb.tables.MainTable.delete().pipe(
    Effect.catchTag("ResourceNotFoundError", () => Effect.void),
  )
  yield* layoutsDb.tables.MainTable.create()
  yield* Batch.write([...devices, ...bigDevices].map((device) => TenantDevices.put(device)))

  // #region layouts-explain
  // "T-BIG" composes the same key as "t-big" under the default lowercase casing,
  // so it gets the same layout.
  const busy = yield* layoutsDb.entities.Devices.byTenant({ tenantId: "T-BIG" }).explain()
  // busy.shards?.count             → 8
  // busy.shards?.partitions.length → 8

  // Any other tenant: one unsharded partition, the same keys and requests as an
  // index without shards.
  const quiet = yield* layoutsDb.entities.Devices.byTenant({ tenantId: TENANT }).explain()
  // quiet.shards?.count      → 1
  // quiet.shards?.partitions → ["$guide-sharding#v1#device#tenantid_t-123"]
  // quiet.fanOut             → undefined
  // #endregion
  assertEq(busy.shards?.count, 8, "the busy tenant's layout")
  assertEq(busy.shards?.partitions.length, 8, "8 partitions")
  assertEq(busy.fanOut?.partitions.length, 8, "a fan-out over 8")
  assertEq(quiet.shards?.count, 1, "a quiet tenant's layout")
  assertEq(
    quiet.shards?.partitions,
    ["$guide-sharding#v1#device#tenantid_t-123"],
    "the unsharded partition",
  )
  assertEq(quiet.fanOut, undefined, "a plain query")
  const busyRows = yield* layoutsDb.entities.Devices.byTenant({ tenantId: BIG }).collect()
  const quietRows = yield* layoutsDb.entities.Devices.byTenant({ tenantId: TENANT }).collect()
  assertEq(idsOf(busyRows), idsOf(bigDevices), "the busy tenant's rows, merged in order")
  assertEq(idsOf(quietRows), everyId, "the quiet tenant's rows")
  yield* Console.log(`t-big: ${busy.shards?.count} shards, t-123: ${quiet.shards?.count}`)

  // #region layouts-missing
  // Without a ShardLayouts layer, binding fails with EDD-9180, naming the entity
  // and index. Nothing falls back to a default.
  const missing = yield* DynamoClient.make({
    entities: { Devices: ProvidedDevices },
    tables: { MainTable: ProvidedTable },
  }).pipe(Effect.exit)
  // missing → a defect: "[EDD-9180] DynamoClient.make: Device.byTenant declares
  //           shards: { layouts: "provided" }, but no ShardLayouts layer supplies its table…"
  // #endregion
  if (!String(missing).includes("[EDD-9180]")) {
    throw new Error(`Expected EDD-9180, got ${String(missing)}`)
  }
  yield* Console.log("No ShardLayouts layer: EDD-9180")

  // #region layouts-provided-use
  // The layer goes in the application layer, beside the client. Bound operations
  // keep the table DynamoClient.make read, so their types don't change.
  const providedDb = yield* DynamoClient.make({
    entities: { Devices: ProvidedDevices },
    tables: { MainTable: ProvidedTable },
  }).pipe(Effect.provide(ShardsLayer))
  const fromConfig = yield* providedDb.entities.Devices.byTenant({ tenantId: BIG }).explain()
  // fromConfig.shards?.count → 8
  // #endregion
  assertEq(fromConfig.shards?.count, 8, "the layer's table")
  const providedRows = yield* providedDb.entities.Devices.byTenant({ tenantId: BIG }).collect()
  assertEq(idsOf(providedRows), idsOf(bigDevices), "the same rows as the declared table")

  const fromJson = yield* DynamoClient.make({
    entities: { Devices: ProvidedDevices },
    tables: { MainTable: ProvidedTable },
  }).pipe(Effect.provide(JsonShardsLayer))
  const jsonExplained = yield* fromJson.entities.Devices.byTenant({ tenantId: BIG }).explain()
  assertEq(jsonExplained.shards?.count, 8, "the JSON table")
  yield* Console.log(`From configuration: t-big has ${fromConfig.shards?.count} shards`)

  // A table in a config item
  const configDb = yield* DynamoClient.make({ entities: { ShardConfigs }, tables: { ConfigTable } })
  yield* configDb.tables.ConfigTable.delete().pipe(
    Effect.catchTag("ResourceNotFoundError", () => Effect.void),
  )
  yield* configDb.tables.ConfigTable.create()
  const layouts = yield* Schema.decodeUnknownEffect(ShardLayouts.Table)({
    default: 1,
    values: [{ match: { tenantId: BIG }, layout: 8 }],
  })
  yield* configDb.entities.ShardConfigs.put({ name: "Devices.byTenant", layouts })
  const itemDb = yield* DynamoClient.make({
    entities: { Devices: ProvidedDevices },
    tables: { MainTable: ProvidedTable },
  }).pipe(Effect.provide(ItemShardsLayer))
  const fromItem = yield* itemDb.entities.Devices.byTenant({ tenantId: BIG }).explain()
  assertEq(fromItem.shards?.count, 8, "the config item's table")
  yield* Console.log(`From a config item: t-big has ${fromItem.shards?.count} shards`)
  yield* configDb.tables.ConfigTable.delete()

  // #region layouts-migrate
  // Moving t-123 from its one partition to 4 shards, while t-big keeps 8. Each step
  // is a deploy or a configuration change, finished once every process runs it.
  const tablesOf = (byTenant: ShardLayouts.TypedTable<"tenantId">) =>
    ShardLayouts.layer([ShardLayouts.of(ProvidedDevices, { byTenant })])
  const bindWith = (byTenant: ShardLayouts.TypedTable<"tenantId">) =>
    DynamoClient.make({
      entities: { Devices: ProvidedDevices },
      tables: { MainTable: ProvidedTable },
    }).pipe(Effect.provide(tablesOf(byTenant)))
  const busyTenant = { match: { tenantId: "t-big" }, layout: 8 }

  // Step 1: t-123 writes 4 shards, and reads them and its old partition.
  const step1 = yield* bindWith({
    default: 1,
    values: [busyTenant, { match: { tenantId: TENANT }, layout: { count: 4, previous: 1 } }],
  })
  const pending = yield* step1.tables.MainTable.rekey({ dryRun: true })
  // pending.indexKeysRewritten → 200: t-123's rows, still in the old partition

  // Step 2: rekey, then check again.
  yield* step1.tables.MainTable.rekey()
  const settled = yield* step1.tables.MainTable.rekey({ dryRun: true })
  // settled.indexKeysRewritten → 0, settled.conflicts → []: step 3 can go out

  // Step 3: remove `previous`.
  const step3 = yield* bindWith({
    default: 1,
    values: [busyTenant, { match: { tenantId: TENANT }, layout: 4 }],
  })
  const moved = yield* step3.entities.Devices.byTenant({ tenantId: TENANT }).collect()
  // #endregion
  assertEq(pending.indexKeysRewritten, devices.length, "the dry run counts t-123's rows")
  assertEq(settled.indexKeysRewritten, 0, "nothing left to move")
  assertEq(settled.conflicts.length, 0, "no conflicts")
  assertEq(idsOf(moved), everyId, "every row of t-123 in its new layout")
  const step3Explained = yield* step3.entities.Devices.byTenant({ tenantId: TENANT }).explain()
  assertEq(step3Explained.shards?.partitions.length, 4, "4 partitions, no previous")
  const untouched = yield* step3.entities.Devices.byTenant({ tenantId: BIG }).collect()
  assertEq(idsOf(untouched), idsOf(bigDevices), "other values are untouched")
  yield* Console.log(`t-123 moved to ${step3Explained.shards?.count} shards`)

  yield* layoutsDb.tables.MainTable.delete()
})

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
  // Merging in descending order.
  const descending = yield* db.entities.Devices.byTenant({ tenantId: TENANT })
    .reverse()
    .collect()
  // Each shard is counted, and the counts summed.
  const total = yield* db.entities.Devices.byTenant({ tenantId: TENANT }).count()
  // #endregion
  assertEq(idsOf(all), everyId, "collect is in index order")
  assertEq(idsOf(descending), [...everyId].reverse(), "reverse reverses distinct sort keys")
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
  assertEq(explained.fanOut?.pruned, false, "a query that doesn't pin the source reads every shard")
  assertEq(explained.fanOut?.concurrency, 2, "concurrency")
  assertEq(explained.keyConditions.length, 8, "one key condition per shard")
  assertEq(requests >= 8, true, "at least one request per shard")
  assertEq(accepted, 10, "accepted counts the returned rows")
  yield* Console.log(`${requests} requests for ${accepted} items\n`)

  // -------------------------------------------------------------------------
  // `by`
  // -------------------------------------------------------------------------
  yield* Console.log("=== Pruning ===\n")

  // #region key-prune
  // The default source is the primary key. Pin all of it, and the query knows the shard.
  const oneDevice = db.entities.Devices.byDevice({
    tenantId: TENANT,
    groupId: "group-a",
    channel: "channel-0",
    deviceId: "d-000",
  })
  const onePin = yield* oneDevice.explain()
  // onePin.fanOut?.pruned            → true
  // onePin.fanOut?.partitions.length → 1
  const found = yield* oneDevice.collect()

  // `channel` and `deviceId` aren't known, so the shard isn't: all 8.
  const wholeGroup = yield* db.entities.Devices.byDevice({
    tenantId: TENANT,
    groupId: "group-a",
  }).explain()
  // wholeGroup.fanOut?.pruned            → false
  // wholeGroup.fanOut?.partitions.length → 8
  // #endregion
  assertEq(onePin.fanOut?.partitions.length, 1, "a full primary key pin reads one shard")
  assertEq(onePin.fanOut?.pruned, true, "pruned")
  assertEq(found.length, 1, "a full primary key pin finds the row")
  assertEq(wholeGroup.fanOut?.partitions.length, 8, "a partial pin reads every shard")
  yield* Console.log(`Whole key pinned: ${onePin.fanOut?.partitions.length} shard`)

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

  yield* perValueLayouts.pipe(Effect.provide(exampleConfig))


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
  LayoutsTable.layer({ name: layoutsTableName }),
  ProvidedTable.layer({ name: layoutsTableName }),
  ConfigTable.layer({ name: configTableName }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(() => console.log("\nDone."))
// #endregion
