/**
 * Guide: Upgrading from 1.36 — effect-dynamodb
 *
 * Demonstrates the upgrade path documented in the upgrade guide:
 *   - 1.37 runs over rows 1.36 wrote, with the key fallback on (the default)
 *   - `rekey({ dryRun: true })`: what would move, and any conflicts
 *   - `rekey()`: move every row, in parallel segments, checkpointing a resume token
 *   - A bounded run (`maxPages`) resumed until the table is done
 *   - A rerun moves nothing; the fallback can then be turned off
 *
 * The example first writes a few rows as 1.36 did — written by 1.37, then
 * rewritten under the key text 1.36 composed — standing in for a table a
 * 1.36 deployment wrote.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-upgrade.ts
 */

import { Config, Console, Effect, Layer, Option, Ref, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { toAttributeMap } from "../src/Marshaller.js"
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
// 1. Models, entities, a stream
// =============================================================================

// #region schema
// The same schema as under 1.36: the 1.36 key fallback is on by default
// throughout 1.37.x, so the deployment keeps reading and writing the rows
// 1.36 wrote while `rekey` moves them.
const AppSchema = DynamoSchema.make({ name: "upgrade", version: 1 })
// #endregion

class Sensor extends Schema.Class<Sensor>("Sensor")({
  siteId: Schema.String,
  sensorId: Schema.Number,
  label: Schema.String,
  offset: Schema.Number,
}) {}

const Sensors = Entity.make({
  model: Sensor,
  entityType: "Sensor",
  primaryKey: {
    pk: { field: "pk", composite: ["siteId"] },
    sk: { field: "sk", composite: ["sensorId"] },
  },
  indexes: {
    byLabel: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["siteId"] },
      sk: { field: "gsi1sk", composite: ["label"] },
    },
  },
  timestamps: true,
  versioned: { retain: true },
  softDelete: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Sensors } })
const tableName = "guide-upgrade-table"

class Calibrated extends Schema.TaggedClass<Calibrated>()("Calibrated", {
  offset: Schema.Number,
}) {}

const Calibrations = EventStore.makeStream({
  table: MainTable,
  streamName: "Calibrations",
  events: [Calibrated],
  streamId: { composite: ["siteId"] },
})

// =============================================================================
// 2. Rows as 1.36 wrote them
// =============================================================================

/**
 * Move a sensor's rows — its item, version snapshots and tombstone — under
 * the key text 1.36 composed for it: each row's sort key holds the sensor's
 * key segment, and the item holds its index keys too.
 */
const writeAs136 = (record: { readonly siteId: string; readonly sensorId: number }) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const current = KeyComposer.composeAllKeys(AppSchema, "Sensor", 1, Sensors.indexes, record)
    const old = KeyText136.composeAllKeys(AppSchema, "Sensor", 1, Sensors.indexes, record)
    // The sensor's segment of a sort key: `#sensorid_<text>`.
    const segment = (keys: Record<string, unknown>) => {
      const sk = String(keys.sk)
      return sk.slice(sk.lastIndexOf("#"))
    }
    const { Items = [] } = yield* client.query({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk",
      FilterExpression: "sensorId = :id",
      ExpressionAttributeValues: toAttributeMap({ ":pk": current.pk, ":id": record.sensorId }),
      ConsistentRead: true,
    })
    for (const item of Items) {
      const sk = item.sk!.S!
      yield* client.deleteItem({ TableName: tableName, Key: { pk: item.pk!, sk: item.sk! } })
      yield* client.putItem({
        TableName: tableName,
        Item: {
          ...item,
          ...(sk === current.sk ? toAttributeMap(old) : {}),
          sk: { S: sk.replace(segment(current), segment(old)) },
        },
      })
    }
  })

// =============================================================================
// 3. The upgrade
// =============================================================================

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({ entities: { Sensors }, tables: { MainTable } })

  yield* Console.log("=== Setup: a table 1.36 wrote ===\n")
  // A table left by an earlier, interrupted run is started afresh.
  yield* db.tables.MainTable.delete().pipe(Effect.ignore)
  yield* db.tables.MainTable.create()
  const sensors = [
    { siteId: "north", sensorId: -3, label: "intake valve", offset: 0.5 },
    { siteId: "north", sensorId: 1.5, label: "outlet", offset: 0.25 },
    { siteId: "north", sensorId: 7, label: "pump", offset: 0 },
  ]
  for (const sensor of sensors) {
    yield* db.entities.Sensors.put(sensor)
    yield* db.entities.Sensors.update({ siteId: "north", sensorId: sensor.sensorId }).set({
      offset: sensor.offset + 1,
    })
  }
  // The outlet sensor is soft-deleted: a tombstone beside its snapshots.
  yield* db.entities.Sensors.delete({ siteId: "north", sensorId: 1.5 })
  yield* Calibrations.append({ siteId: "north" }, [new Calibrated({ offset: 0.5 })], 0)
  for (const sensor of sensors.slice(0, 2)) yield* writeAs136(sensor)
  // 1.37 reads them where 1.36 wrote them.
  const before = yield* db.entities.Sensors.get({ siteId: "north", sensorId: -3 })
  assertEq(before.label, "intake valve", "read under its 1.36 key")
  const versionsBefore = yield* db.entities.Sensors.versions({
    siteId: "north",
    sensorId: -3,
  }).collect()
  assertEq(versionsBefore.length, 1, "its snapshot read under its 1.36 key")
  yield* Console.log(
    "Two sensors' rows under their 1.36 keys (one soft-deleted), one under its current key.",
  )

  // --- Dry run ---
  yield* Console.log("\n=== Dry run ===\n")

  // #region dry-run
  // Count what would move, writing nothing. Event streams are passed in:
  // the client does not register them.
  const plan = yield* db.tables.MainTable.rekey({ dryRun: true, streams: [Calibrations] })
  // plan.moved      → { item: 1, snapshot: 3, tombstone: 1, outbox: 0, event: 0, aggregate: 0, stream: 0 }
  // plan.conflicts  → []  (rows under both keys, or whose current key is taken)
  // plan.skipped    → { notLibrary: 0, unregistered: 0, unrecognizedKey: 0 }
  // #endregion
  assertEq(
    plan.moved,
    { item: 1, snapshot: 3, tombstone: 1, outbox: 0, event: 0, aggregate: 0, stream: 0 },
    "dry run: a sensor's item, both sensors' snapshots, a tombstone",
  )
  assertEq(plan.conflicts.length, 0, "dry run: no conflicts")
  yield* Console.log(`Would move: ${JSON.stringify(plan.moved)}`)
  yield* Console.log(`Index keys to rewrite in place: ${plan.indexKeysRewritten}`)

  // --- Run ---
  yield* Console.log("\n=== Run ===\n")

  // #region run
  // Move them: four scan segments in parallel, a resume token kept after
  // every page so an interrupted run can go on from there.
  const checkpoint = yield* Ref.make(Option.none<string>())
  const report = yield* db.tables.MainTable.rekey({
    streams: [Calibrations],
    segments: 4,
    onProgress: (progress) => Ref.set(checkpoint, progress.resume),
  })
  // report.moved     → the same counts as the dry run
  // report.capacity  → { capacityUnits, readCapacityUnits, writeCapacityUnits, requests, ... }
  // report.resume    → None: the whole table was scanned
  // #endregion
  assertEq(report.moved, plan.moved, "the run moved what the dry run counted")
  assertEq(Option.isNone(report.resume), true, "the run covered the table")
  yield* Console.log(`Moved: ${JSON.stringify(report.moved)}`)
  yield* Console.log(`Consumed: ${report.capacity.capacityUnits} units`)
  yield* Console.log(
    `Last checkpoint: ${Option.getOrElse(yield* Ref.get(checkpoint), () => "(done)")}`,
  )

  // --- A bounded run, resumed ---
  yield* Console.log("\n=== A bounded run, resumed ===\n")

  // #region resume
  // At most one page per run — a time slot — each run resuming where the
  // last stopped, until a run reports no resume token.
  let resume = Option.none<string>()
  let slices = 0
  do {
    const slice = yield* db.tables.MainTable.rekey({
      streams: [Calibrations],
      pageSize: 2,
      maxPages: 1,
      resume: Option.getOrUndefined(resume),
    })
    resume = slice.resume
    slices++
  } while (Option.isSome(resume))
  // #endregion
  yield* Console.log(`A rerun in ${slices} slices of one page each.`)

  // #region rerun
  // Every row is under its current key now: a rerun moves nothing.
  const again = yield* db.tables.MainTable.rekey({ streams: [Calibrations] })
  // again.moved      → { item: 0, snapshot: 0, ... }
  // again.unchanged  → every row of the table's members
  // #endregion
  assertEq(
    Object.values(again.moved).every((n) => n === 0),
    true,
    "a rerun moves nothing",
  )
  const moved = yield* db.entities.Sensors.get({ siteId: "north", sensorId: -3 })
  assertEq(moved.offset, 1.5, "the moved item")
  const versions = yield* db.entities.Sensors.versions({ siteId: "north", sensorId: -3 }).collect()
  assertEq(versions.length, 1, "the moved snapshot")
  const deleted = yield* db.entities.Sensors.deleted.get({ siteId: "north", sensorId: 1.5 })
  assertEq(deleted.label, "outlet", "the moved tombstone")
  const labelled = yield* db.entities.Sensors.byLabel({ siteId: "north", label: "intake valve" })
    .collect()
  assertEq(
    labelled.map((s) => s.sensorId),
    [-3],
    "found by its current index key",
  )
  yield* Console.log(`Nothing left to move; ${again.unchanged} rows already current.`)

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===\n")
  yield* db.tables.MainTable.delete()
  yield* Console.log("Table deleted.")
})

// #region fallback-off
// Once a rerun moves nothing and reports no conflicts — and no 1.36
// deployment is left to write a 1.36 key again — turn the fallback off:
// requests are then exactly those of a build without it.
const UpgradedSchema = DynamoSchema.make({ name: "upgrade", version: 1, legacyKeys: false })
// #endregion
assertEq(UpgradedSchema.legacyKeys, false, "the fallback is off")

// =============================================================================
// 4. Provide dependencies and run
// =============================================================================

const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  MainTable.layer({ name: tableName }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(() => console.log("\nDone."))
