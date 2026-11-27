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
 *   - Time buckets other than hourly, and two geo indexes on one entity
 *   - A geo entity with an offloaded (binary) field
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-geospatial.ts
 */

import { Config, Console, Duration, Effect, Layer, Schema } from "effect"
// Import from geo package source (use "@effect-dynamodb/geo" when published)
import { GeoIndex, H3 } from "../../effect-dynamodb-geo/src/index.js"
// Import from source (use "effect-dynamodb" when published)
import { BlobStore } from "../src/BlobStore.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
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
// Time buckets: an hourly and a daily geo index on one entity
// ---------------------------------------------------------------------------

// #region time-buckets
class Sighting extends Schema.Class<Sighting>("Sighting")({
  sightingId: Schema.String,
  latitude: Schema.Number,
  longitude: Schema.Number,
  seenAt: Schema.Number,
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  hourPartition: Schema.optional(Schema.String),
  dayPartition: Schema.optional(Schema.String),
}) {}

const Sightings = Entity.make({
  model: Sighting,
  entityType: "Sighting",
  primaryKey: {
    pk: { field: "pk", composite: ["sightingId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    sightingsByHour: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "hourPartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
    sightingsByDay: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["parentCell", "dayPartition"] },
      sk: { field: "gsi2sk", composite: ["cell"] },
    },
  },
})

// Each index writes its own partition attribute; both share the cell fields,
// at the same resolutions.
const SightingsByHour = GeoIndex.make({
  entity: Sightings,
  index: "sightingsByHour",
  coordinates: (item) => ({ latitude: item.latitude, longitude: item.longitude }),
  fields: {
    cell: { field: "cell", resolution: 15 },
    parentCell: { field: "parentCell", resolution: 3 },
    timePartition: { field: "hourPartition", source: "seenAt", bucket: "hourly" },
  },
})

const SightingsByDay = GeoIndex.make({
  entity: Sightings,
  index: "sightingsByDay",
  coordinates: (item) => ({ latitude: item.latitude, longitude: item.longitude }),
  fields: {
    cell: { field: "cell", resolution: 15 },
    parentCell: { field: "parentCell", resolution: 3 },
    timePartition: { field: "dayPartition", source: "seenAt", bucket: "1 day" },
  },
})

const SightingsTable = Table.make({ schema: AppSchema, entities: { Sightings } })
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

// A second geo entity, whose photo is kept in the blob store
// #region offloaded-geo
class Landmark extends Schema.Class<Landmark>("Landmark")({
  landmarkId: Schema.String,
  latitude: Schema.Number,
  longitude: Schema.Number,
  timestamp: Schema.Number,
  photo: Schema.Uint8Array,
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
}) {}

const Landmarks = Entity.make({
  model: DynamoModel.configure(Landmark, {
    photo: { storedAs: DynamoModel.External({ contentType: "image/jpeg" }) },
  }),
  entityType: "Landmark",
  primaryKey: {
    pk: { field: "pk", composite: ["landmarkId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    landmarksByCell: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "timePartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
  },
})

const LandmarkGeo = GeoIndex.make({
  entity: Landmarks,
  index: "landmarksByCell",
  coordinates: (item) => ({ latitude: item.latitude, longitude: item.longitude }),
  fields: {
    cell: { field: "cell", resolution: 15 },
    parentCell: { field: "parentCell", resolution: 3 },
    timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
  },
})
// #endregion

// Offloading requires escaped key text (objects are named after their row's key)
const LandmarksSchema = DynamoSchema.make({ name: "fleet", version: 1, escapeKeys: true })
const LandmarksTable = Table.make({ schema: LandmarksSchema, entities: { Landmarks } })

// ---------------------------------------------------------------------------
// 4. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Vehicles },
  })

  yield* Console.log("=== Setup ===\n")
  // Start clean: drop the table a failed earlier run may have left behind
  yield* db.tables["fleet-table"]!.delete().pipe(
    Effect.catchTag("ResourceNotFoundError", () => Effect.void),
  )
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

  // --- Time buckets ---
  yield* Console.log("=== Time Buckets ===\n")

  const sightings = yield* DynamoClient.make({ entities: { Sightings } })
  yield* sightings.tables["fleet-sightings"]!.delete().pipe(
    Effect.catchTag("ResourceNotFoundError", () => Effect.void),
  )
  yield* sightings.tables["fleet-sightings"]!.create()

  // #region time-buckets-usage
  const byHour = yield* GeoIndex.bind(SightingsByHour)
  const byDay = yield* GeoIndex.bind(SightingsByDay)

  // One write fills both indexes: each enrich adds its own partition
  yield* byHour.put(
    byDay.enrich({
      sightingId: "s-1",
      latitude: 37.7749,
      longitude: -122.4194,
      seenAt: now - Duration.toMillis(Duration.hours(20)),
    }),
  )

  // A 24-hour window reads at most two daily partitions per cell range
  const today = yield* byDay.nearby({
    center: { latitude: 37.7749, longitude: -122.4194 },
    radius: 1000,
    timeWindow: { start: now - Duration.toMillis(Duration.days(1)), end: now },
  })
  // #endregion

  if (today.length !== 1 || today[0]!.item.sightingId !== "s-1") {
    throw new Error("expected the 20-hour-old sighting from the daily index")
  }
  const lastHour = yield* byHour.nearby({
    center: { latitude: 37.7749, longitude: -122.4194 },
    radius: 1000,
    timeWindow: { start: now - H3.HOURLY_BUCKET_MS, end: now },
  })
  if (lastHour.length !== 0) {
    throw new Error("expected no sighting in the last hour")
  }
  yield* Console.log(`Daily index: ${today.length} sighting in the last 24 hours`)
  yield* Console.log(`Hourly index: ${lastHour.length} sightings in the last hour\n`)
  yield* sightings.tables["fleet-sightings"]!.delete()

  // --- Offloaded fields ---
  yield* Console.log("=== Offloaded Fields ===\n")
  const landmarks = yield* DynamoClient.make({ entities: { Landmarks } })
  yield* landmarks.tables["fleet-landmarks"]!.delete().pipe(
    Effect.catchTag("ResourceNotFoundError", () => Effect.void),
  )
  yield* landmarks.tables["fleet-landmarks"]!.create()
  const jpeg = new Uint8Array(80_000).fill(7)

  // #region offloaded-geo-usage
  // GeoIndex.bind needs a BlobStore in context for an entity that offloads
  const landmarkGeo = yield* GeoIndex.bind(LandmarkGeo)

  // A binary field takes a Uint8Array: one type is put's input and nearby's result
  yield* landmarkGeo.put({
    landmarkId: "l-1",
    latitude: 37.8199,
    longitude: -122.4783,
    timestamp: now,
    photo: jpeg,
  })

  // nearby reads offloaded fields eagerly, for every row its cell queries return
  const found = yield* landmarkGeo.nearby({
    center: { latitude: 37.82, longitude: -122.478 },
    radius: 500,
    unit: "m",
  })
  const photo: Uint8Array | undefined = found[0]?.item.photo // never a handle
  // #endregion

  if (photo?.length !== 80_000) {
    throw new Error("expected the landmark's photo")
  }
  yield* Console.log(`Landmark ${found[0]!.item.landmarkId}: ${photo.length}-byte photo\n`)
  yield* landmarks.tables["fleet-landmarks"]!.delete()

  // --- Cleanup ---
  yield* db.tables["fleet-table"]!.delete()
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 5. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  MainTable.layer({ name: "fleet-table" }),
  SightingsTable.layer({ name: "fleet-sightings" }),
  LandmarksTable.layer({ name: "fleet-landmarks" }),
  // Where Landmarks' photos live (S3 in production: effect-dynamodb/blob/s3)
  BlobStore.layerMemory(),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(() => console.log("\nDone."))
// #endregion
