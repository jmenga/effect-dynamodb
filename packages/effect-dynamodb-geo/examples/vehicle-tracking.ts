/**
 * Vehicle Tracking — End-to-end example of GeoIndex + GeoSearch.
 *
 * Run against DynamoDB Local:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   npx tsx examples/vehicle-tracking.ts
 */

import { DynamoClient, DynamoSchema, Entity, Table } from "@effect-dynamodb/core"
import { Config, Effect, Layer, Schema } from "effect"
import { GeoIndex, H3 } from "../src/index.js"

// ---------------------------------------------------------------------------
// Schema + Entity
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "vehicles", version: 1 })

class Vehicle extends Schema.Class<Vehicle>("Vehicle")({
  vehicleId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
  driver: Schema.optional(Schema.String),
}) {}

const Vehicles = Entity.make({
  model: Vehicle,
  entityType: "Vehicle",
  primaryKey: {
    pk: { field: "pk", composite: ["vehicleId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCell: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "timePartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
  },
  timestamps: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Vehicles } })

// ---------------------------------------------------------------------------
// GeoIndex Declaration
// ---------------------------------------------------------------------------

const VehicleGeo = GeoIndex.make({
  entity: Vehicles,
  index: "byCell",
  coordinates: (item) =>
    item.latitude !== undefined && item.longitude !== undefined
      ? { latitude: item.latitude, longitude: item.longitude }
      : undefined,
  fields: {
    cell: { field: "cell", resolution: 15 },
    parentCell: { field: "parentCell", resolution: 3 },
    timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
  },
})

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const client = yield* DynamoClient

  // Create table
  console.log("Creating table...")
  yield* client.createTable({
    TableName: "vehicle-tracking",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(MainTable),
  })

  const now = Date.now()

  // Seed vehicles around San Francisco
  const vehicles: Entity.Input<typeof Vehicles>[] = [
    { vehicleId: "v-1", latitude: 37.7749, longitude: -122.4194, timestamp: now, driver: "Alice" },
    { vehicleId: "v-2", latitude: 37.7839, longitude: -122.409, timestamp: now, driver: "Bob" },
    {
      vehicleId: "v-3",
      latitude: 37.7649,
      longitude: -122.4294,
      timestamp: now,
      driver: "Charlie",
    },
    { vehicleId: "v-4", latitude: 37.3382, longitude: -121.8863, timestamp: now, driver: "Diana" }, // San Jose (~50km)
    { vehicleId: "v-5", latitude: 37.7749, longitude: -122.4194, timestamp: now }, // No driver
    { vehicleId: "v-6", timestamp: now }, // No location
  ]

  console.log(`Seeding ${vehicles.length} vehicles...`)
  for (const vehicle of vehicles) {
    yield* VehicleGeo.put(vehicle).asEffect()
    const enriched = VehicleGeo.enrich(vehicle)
    if (enriched.cell) {
      console.log(
        `  ${vehicle.vehicleId}: cell=${enriched.cell?.slice(0, 8)}... parent=${enriched.parentCell?.slice(0, 8)}...`,
      )
    } else {
      console.log(`  ${vehicle.vehicleId}: no location (sparse GSI)`)
    }
  }

  // Search within 2km of SF center
  console.log("\nSearching within 2km of SF center...")
  const results = yield* VehicleGeo.nearby({
    center: { latitude: 37.7749, longitude: -122.4194 },
    radius: 2000,
    unit: "m",
    timeWindow: { start: now - H3.HOURLY_BUCKET_MS, end: now + 1000 },
  })

  console.log(`Found ${results.length} vehicles:`)
  for (const { item, distance } of results) {
    console.log(`  ${item.vehicleId} (${item.driver ?? "unknown"}): ${distance.toFixed(0)}m away`)
  }

  // Cleanup
  yield* client.deleteTable({ TableName: "vehicle-tracking" })
  console.log("\nDone! Table cleaned up.")
})

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.string("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  MainTable.layer({ name: "vehicle-tracking" }),
)

Effect.runPromise(program.pipe(Effect.provide(AppLayer))).catch(console.error)
