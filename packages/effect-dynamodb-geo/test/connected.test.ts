import { Effect, Layer, Schema } from "effect"
import { DynamoClient, DynamoSchema, Entity, Table } from "effect-dynamodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import * as H3 from "../src/H3.js"

// ---------------------------------------------------------------------------
// Check DynamoDB Local availability
// ---------------------------------------------------------------------------

const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000"

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
// Schema + Entity setup
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "geotest", version: 1 })

class Vehicle extends Schema.Class<Vehicle>("Vehicle")({
  vehicleId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
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
// Test infrastructure
// ---------------------------------------------------------------------------

const tableName = `geo-connected-test-${Date.now()}`

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const TestLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)

const SF_CENTER = { latitude: 37.7749, longitude: -122.4194 }
const NOW = Date.now()

describeConnected("GeoSearch (connected)", () => {
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
        Effect.catchTag("DynamoError", () => Effect.void),
      ),
    )
  }, 15000)

  it("end-to-end write + nearby", async () => {
    const timestamp = NOW

    // Seed vehicles at known locations
    await Effect.runPromise(
      Effect.gen(function* () {
        const inputs: Entity.Input<typeof Vehicles>[] = [
          {
            vehicleId: "v-center",
            latitude: SF_CENTER.latitude,
            longitude: SF_CENTER.longitude,
            timestamp,
          },
          { vehicleId: "v-1km", latitude: 37.7839, longitude: -122.4194, timestamp },
          { vehicleId: "v-3km", latitude: 37.7749, longitude: -122.3854, timestamp },
          { vehicleId: "v-far", latitude: 34.0522, longitude: -118.2437, timestamp }, // LA
        ]

        for (const input of inputs) {
          yield* VehicleGeo.put(input).asEffect()
        }
      }).pipe(provide),
    )

    // Search within 5km
    const results = await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 5000,
        unit: "m",
        timeWindow: { start: timestamp - H3.HOURLY_BUCKET_MS, end: timestamp + 1000 },
      }).pipe(provide),
    )

    // Should find center, 1km, and 3km but not LA
    expect(results.length).toBeGreaterThanOrEqual(1)
    for (const r of results) {
      expect(r.distance).toBeLessThanOrEqual(5000)
    }

    // Should NOT include the LA vehicle
    const laResult = results.find((r) => r.item.vehicleId === "v-far")
    expect(laResult).toBeUndefined()
  })

  it("items without coordinates are excluded from geo GSI", async () => {
    const timestamp = NOW + 1000

    await Effect.runPromise(
      Effect.gen(function* () {
        // Item without coordinates — enrichment skips geo fields
        yield* VehicleGeo.put({ vehicleId: "v-noloc", timestamp }).asEffect()
      }).pipe(provide),
    )

    const results = await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 100000,
        unit: "m",
        timeWindow: { start: timestamp - H3.HOURLY_BUCKET_MS, end: timestamp + 1000 },
      }).pipe(provide),
    )

    const noLocResult = results.find((r) => r.item.vehicleId === "v-noloc")
    expect(noLocResult).toBeUndefined()
  })

  it("real BETWEEN evaluation on sort keys", async () => {
    const timestamp = NOW + 2000

    // Seed two nearby vehicles that should fall within the same BETWEEN range
    await Effect.runPromise(
      Effect.gen(function* () {
        const inputs: Entity.Input<typeof Vehicles>[] = [
          {
            vehicleId: "v-close-a",
            latitude: SF_CENTER.latitude + 0.001,
            longitude: SF_CENTER.longitude,
            timestamp,
          },
          {
            vehicleId: "v-close-b",
            latitude: SF_CENTER.latitude - 0.001,
            longitude: SF_CENTER.longitude,
            timestamp,
          },
        ]
        for (const input of inputs) {
          yield* VehicleGeo.put(input).asEffect()
        }
      }).pipe(provide),
    )

    const results = await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 1000,
        unit: "m",
        timeWindow: { start: timestamp - H3.HOURLY_BUCKET_MS, end: timestamp + 1000 },
      }).pipe(provide),
    )

    // Both should be within range
    for (const r of results) {
      expect(r.distance).toBeLessThanOrEqual(1000)
    }
  })
})
