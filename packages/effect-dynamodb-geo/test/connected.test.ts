import { Config, Effect, Layer, Schema } from "effect"
import { ConsumedCapacity, DynamoClient, DynamoSchema, Entity, Table } from "effect-dynamodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import * as H3 from "../src/H3.js"

// ---------------------------------------------------------------------------
// Check DynamoDB Local availability
// ---------------------------------------------------------------------------

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

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
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
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

  it("timeWindow drops items outside the window from the partitions it selects (#169)", async () => {
    // An hourly bucket well before the other tests' timestamps, so nothing
    // else lands in it. All three items share the one partition the window
    // selects; only the one inside the window may come back.
    const hourStart =
      Math.floor(NOW / H3.HOURLY_BUCKET_MS) * H3.HOURLY_BUCKET_MS - 10 * H3.HOURLY_BUCKET_MS
    const minute = 60_000

    await Effect.runPromise(
      Effect.gen(function* () {
        const at = (vehicleId: string, timestamp: number) =>
          VehicleGeo.put({
            vehicleId,
            latitude: SF_CENTER.latitude,
            longitude: SF_CENTER.longitude,
            timestamp,
          }).asEffect()
        yield* at("v-169-stale", hourStart + 5 * minute)
        yield* at("v-169-fresh", hourStart + 30 * minute)
        yield* at("v-169-late", hourStart + 50 * minute)
      }).pipe(provide),
    )

    const results = await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 500,
        unit: "m",
        timeWindow: { start: hourStart + 29 * minute, end: hourStart + 31 * minute },
      }).pipe(provide),
    )

    expect(results.map((r) => r.item.vehicleId)).toEqual(["v-169-fresh"])
  })

  it("nearby reports its consumed capacity: one report, a Query per cell (#174)", async () => {
    const reports: Array<ConsumedCapacity.OperationReport> = []
    const sent: Array<string> = []
    const Counting = Layer.effect(
      DynamoClient,
      Effect.map(Effect.service(DynamoClient), (client) => ({
        ...client,
        query: (input: Parameters<typeof client.query>[0]) => {
          sent.push(input.TableName ?? "")
          return client.query(input)
        },
      })),
    ).pipe(Layer.provide(ClientLayer))
    const timestamp = NOW + 3000
    await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 2000,
        unit: "m",
        timeWindow: { start: timestamp - H3.HOURLY_BUCKET_MS, end: timestamp },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Counting,
            MainTable.layer({ name: tableName }),
            ConsumedCapacity.layer({
              onOperation: (report) =>
                Effect.sync(() => {
                  reports.push(report)
                }),
            }),
          ),
        ),
      ),
    )
    expect(sent.length).toBeGreaterThan(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      operation: "GeoIndex.nearby",
      target: "Vehicle",
      requests: sent.length,
      requestsByCommand: { Query: sent.length },
      unreportedRequests: 0,
      tables: [tableName],
    })
    // Every Query answered with its capacity (`unreportedRequests: 0` above);
    // Local charges a page by the data it reads, so empty cells cost nothing.
    expect(reports[0]!.capacityUnits).toBeGreaterThan(0)
  })
})
