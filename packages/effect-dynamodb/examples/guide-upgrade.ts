/**
 * Guide: Upgrading — effect-dynamodb
 *
 * Demonstrates turning `escapeKeys` on over existing data, as the upgrade guide documents:
 *   - A table written with the default, off: the key text 1.36 composed
 *   - With the flag on, a row whose key text changed isn't found until `rekey` has moved it
 *   - `rekey({ dryRun: true })`: what would move, and any conflicts
 *   - `rekey()`: move every row, in parallel segments, checkpointing a resume token
 *   - A bounded run (`maxPages`) resumed until the table is done
 *   - A rerun moves nothing
 *   - `rekey` under the default moves them back, the same way
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
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
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
// 1. The settings, models, entities, a stream
// =============================================================================

// #region schema
// The default: keys are the text 1.36 composed, for strings and for numbers.
const DefaultSchema = DynamoSchema.make({ name: "upgrade", version: 1 })
// #endregion

// #region schema-on
// Opting in. A table with rows in it needs `rekey` before it serves traffic.
const AppSchema = DynamoSchema.make({ name: "upgrade", version: 1, escapeKeys: true })
// #endregion

class Sensor extends Schema.Class<Sensor>("Sensor")({
  siteId: Schema.String,
  sensorId: Schema.Number,
  label: Schema.String,
  offset: Schema.Number,
}) {}

class Calibrated extends Schema.TaggedClass<Calibrated>()("Calibrated", {
  offset: Schema.Number,
}) {}

const tableName = "guide-upgrade-table"

/** The table's members, under one setting. */
const membersUnder = (schema: DynamoSchema.DynamoSchema) => {
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
  const MainTable = Table.make({ schema, entities: { Sensors } })
  const Calibrations = EventStore.makeStream({
    table: MainTable,
    streamName: "Calibrations",
    events: [Calibrated],
    streamId: { composite: ["siteId"] },
  })
  return { Sensors, MainTable, Calibrations }
}

const Default = membersUnder(DefaultSchema)
const { Sensors, MainTable, Calibrations } = membersUnder(AppSchema)

// =============================================================================
// 2. The upgrade
// =============================================================================

const program = Effect.gen(function* () {
  yield* Console.log("=== Setup: a table written with the default ===\n")
  const before = yield* DynamoClient.make({
    entities: { Sensors: Default.Sensors },
    tables: { MainTable: Default.MainTable },
  })
  // A table left by an earlier, interrupted run is started afresh.
  yield* before.tables.MainTable.delete().pipe(Effect.ignore)
  yield* before.tables.MainTable.create()
  const sensors = [
    { siteId: "north", sensorId: -3, label: "intake valve", offset: 0.5 },
    { siteId: "north", sensorId: 1.5, label: "outlet", offset: 0.25 },
    { siteId: "north", sensorId: 7, label: "pump", offset: 0 },
  ]
  for (const sensor of sensors) {
    yield* before.entities.Sensors.put(sensor)
    yield* before.entities.Sensors.update({ siteId: "north", sensorId: sensor.sensorId }).set({
      offset: sensor.offset + 1,
    })
  }
  // The outlet sensor is soft-deleted: a tombstone beside its snapshots.
  yield* before.entities.Sensors.delete({ siteId: "north", sensorId: 1.5 })
  yield* Default.Calibrations.append({ siteId: "north" }, [new Calibrated({ offset: 0.5 })], 0)
  yield* Console.log("Three sensors (one soft-deleted) and a stream.")

  const db = yield* DynamoClient.make({ entities: { Sensors }, tables: { MainTable } })

  // #region not-found
  // With the flag on and before `rekey`, a row whose key text changed isn't found.
  const missing = yield* db.entities.Sensors.get({ siteId: "north", sensorId: -3 }).pipe(Effect.flip)
  // missing._tag → "ItemNotFound"
  // #endregion
  assertEq(missing._tag, "ItemNotFound", "a number whose text changed isn't found before rekey")
  const unchanged = yield* db.entities.Sensors.get({ siteId: "north", sensorId: 7 })
  assertEq(unchanged.label, "pump", "a value whose text is the same is")

  // --- Dry run ---
  yield* Console.log("\n=== Dry run ===\n")

  // #region dry-run
  // Count what would move, writing nothing. Event streams are passed in:
  // the client does not register them.
  const plan = yield* db.tables.MainTable.rekey({ dryRun: true, streams: [Calibrations] })
  // plan.moved      → { item: 1, snapshot: 3, tombstone: 1, outbox: 0, event: 0, aggregate: 0, stream: 0 }
  // plan.conflicts  → []  (rows under both keys, or whose current key is taken)
  // plan.skipped    → { notLibrary: 0, unregistered: 0, unrecognizedKey: 0, rootNotSeen: 0 }
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

  // --- Back to the default ---
  yield* Console.log("\n=== Back to the default ===\n")

  // #region back
  // `rekey` moves rows to whatever the setting composes: under the default, back again.
  const backAgain = yield* before.tables.MainTable.rekey({ streams: [Default.Calibrations] })
  // backAgain.moved  → the rows the first run moved
  // #endregion
  assertEq(backAgain.moved, report.moved, "the same rows move back")
  assertEq(backAgain.conflicts.length, 0, "with no conflicts")
  const backHome = yield* before.entities.Sensors.get({ siteId: "north", sensorId: -3 })
  assertEq(backHome.label, "intake valve", "found again under the default")
  yield* Console.log(`Moved back: ${JSON.stringify(backAgain.moved)}`)

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===\n")
  yield* before.tables.MainTable.delete()
  yield* Console.log("Table deleted.")
})

// =============================================================================
// 3. Provide dependencies and run
// =============================================================================

const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  MainTable.layer({ name: tableName }),
  Default.MainTable.layer({ name: tableName }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(() => console.log("\nDone."))
