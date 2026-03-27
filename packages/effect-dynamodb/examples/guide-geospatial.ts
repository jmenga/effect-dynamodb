/**
 * Geospatial guide example — effect-dynamodb + @effect-dynamodb/geo
 *
 * Demonstrates:
 *   - Defining a model with coordinate and geo fields
 *   - Entity with a geo GSI for H3-based spatial indexing
 *   - GeoIndex.make — binding geo configuration to the entity
 *   - Writing items with automatic geo field enrichment
 *   - Proximity search (nearby) with time windows
 *   - Enriching items for use in transactions/batch writes
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-geospatial.ts
 */

import { Console, Effect, Layer, Schema } from "effect"
// Import from geo package source (use "@effect-dynamodb/geo" when published)
import { GeoIndex, H3 } from "../../effect-dynamodb-geo/src/index.js"
// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Define a model with coordinate fields
// ---------------------------------------------------------------------------

// #region model
class Vehicle extends Schema.Class<Vehicle>("Vehicle")({
  vehicleId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Create entity with geo GSI
// ---------------------------------------------------------------------------

// #region entity
const AppSchema = DynamoSchema.make({ name: "fleet", version: 1 })

const Vehicles = Entity.make({
  model: Vehicle,
  entityType: "Vehicle",
  primaryKey: {
    pk: { field: "pk", composite: ["vehicleId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    vehiclesByCell: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "timePartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
  },
  timestamps: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Vehicles } })
// #endregion

// ---------------------------------------------------------------------------
// 3. Create GeoIndex
// ---------------------------------------------------------------------------

// #region geo-index
const VehicleGeo = GeoIndex.make({
  entity: Vehicles,
  index: "vehiclesByCell",
  coordinates: (item) =>
    item.latitude !== undefined && item.longitude !== undefined
      ? { latitude: item.latitude, longitude: item.longitude }
      : undefined,
  fields: {
    cell: { field: "cell", resolution: 15 },
    parentCell: { field: "parentCell", resolution: 3 },
    timePartition: {
      field: "timePartition",
      source: "timestamp",
      bucket: "hourly",
    },
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 4. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Vehicles },
  })

  yield* Console.log("=== Setup ===\n")
  yield* db.tables["fleet-table"]!.create()
  yield* Console.log("Table created\n")

  const now = Date.now()

  // --- Write with geo enrichment ---
  yield* Console.log("=== Write with Geo Enrichment ===\n")

  // #region put
  const vehicleGeo = yield* GeoIndex.bind(VehicleGeo)

  yield* vehicleGeo.put({
    vehicleId: "v-1",
    latitude: 37.7749,
    longitude: -122.4194,
    timestamp: now,
  })
  // cell, parentCell, and timePartition are computed automatically
  // #endregion

  yield* vehicleGeo.put({
    vehicleId: "v-2",
    latitude: 37.7839,
    longitude: -122.409,
    timestamp: now,
  })

  yield* vehicleGeo.put({
    vehicleId: "v-3",
    latitude: 37.7649,
    longitude: -122.4294,
    timestamp: now,
  })

  // San Jose (~50km away) — outside 2km search radius
  yield* vehicleGeo.put({
    vehicleId: "v-4",
    latitude: 37.3382,
    longitude: -121.8863,
    timestamp: now,
  })

  // No location — skips geo enrichment (sparse GSI pattern)
  yield* vehicleGeo.put({
    vehicleId: "v-5",
    timestamp: now,
  })

  yield* Console.log("Wrote 5 vehicles\n")

  // --- Nearby search ---
  yield* Console.log("=== Nearby Search ===\n")

  // #region nearby
  const results = yield* vehicleGeo.nearby({
    center: { latitude: 37.7749, longitude: -122.4194 },
    radius: 2000,
    unit: "m",
    timeWindow: {
      start: now - H3.HOURLY_BUCKET_MS,
      end: now + 1000,
    },
    sort: "ASC",
  })

  for (const { item, distance } of results) {
    console.log(`${item.vehicleId}: ${distance.toFixed(0)}m away`)
  }
  // #endregion

  yield* Console.log(`\nFound ${results.length} vehicles within 2km\n`)

  // --- Enrich for transactions ---
  yield* Console.log("=== Enrich for Transactions ===\n")

  // #region enrich
  const enriched = VehicleGeo.enrich({
    vehicleId: "v-6",
    latitude: 37.78,
    longitude: -122.41,
    timestamp: now,
  })
  // enriched now has cell, parentCell, timePartition set
  // Use in Transaction.write() or Batch.write()
  // #endregion

  yield* Console.log(`Enriched vehicle: cell=${enriched.cell?.slice(0, 12)}...`)
  yield* Console.log(`  parentCell=${enriched.parentCell?.slice(0, 12)}...`)
  yield* Console.log(`  timePartition=${enriched.timePartition}\n`)

  // --- Cleanup ---
  yield* db.tables["fleet-table"]!.delete()
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 5. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "fleet-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("Failed:", err),
)
// #endregion
