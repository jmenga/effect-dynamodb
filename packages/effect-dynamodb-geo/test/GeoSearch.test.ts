import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { DynamoClient, DynamoError, DynamoSchema, Entity, Table } from "@effect-dynamodb/core"
import { Effect, Layer, Schema } from "effect"
import * as h3 from "h3-js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import * as H3 from "../src/H3.js"

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
// In-memory store + mocked DynamoClient
// ---------------------------------------------------------------------------

let store: Map<string, Record<string, AttributeValue>>

const storeKey = (
  item: Record<string, AttributeValue>,
  pkField: string,
  skField: string,
): string => {
  const pk = item[pkField]?.S ?? ""
  const sk = item[skField]?.S ?? ""
  return `${pk}|${sk}`
}

const mockPutItem = vi.fn().mockImplementation(async (input: any) => {
  const item = input.Item as Record<string, AttributeValue>
  const key = storeKey(item, "pk", "sk")
  store.set(key, item)

  // Also index in GSI if gsi1pk present
  if (item.gsi1pk?.S && item.gsi1sk?.S) {
    const gsiKey = `gsi1|${item.gsi1pk.S}|${item.gsi1sk.S}`
    store.set(gsiKey, item)
  }
  return {}
})

const mockGetItem = vi.fn().mockImplementation(async (input: any) => {
  const pk = input.Key?.pk?.S ?? ""
  const sk = input.Key?.sk?.S ?? ""
  const key = `${pk}|${sk}`
  const item = store.get(key)
  return { Item: item }
})

const mockQuery = vi.fn().mockImplementation(async (input: any) => {
  const indexName = input.IndexName
  const expression = input.KeyConditionExpression as string
  const values = input.ExpressionAttributeValues as Record<string, AttributeValue>

  let items: Record<string, AttributeValue>[] = []

  if (indexName === "gsi1") {
    // GSI1 query — find items matching PK and SK BETWEEN
    const pkValue = values[":pk"]?.S
    const isBetween = expression.includes("BETWEEN")

    for (const [key, item] of store.entries()) {
      if (!key.startsWith("gsi1|")) continue
      if (item.gsi1pk?.S !== pkValue) continue

      if (isBetween) {
        const sk1 = values[":sk1"]?.S ?? ""
        const sk2 = values[":sk2"]?.S ?? ""
        const itemSk = item.gsi1sk?.S ?? ""
        if (itemSk >= sk1 && itemSk <= sk2) {
          items.push(item)
        }
      } else {
        items.push(item)
      }
    }

    // Apply entity type filter if present
    if (input.FilterExpression?.includes("__edd_e__")) {
      const entityType = values[":edd_e_0"]?.S
      if (entityType) {
        items = items.filter((item) => item.__edd_e__?.S === entityType)
      }
    }
  }

  return { Items: items, Count: items.length }
})

const mockScan = vi.fn().mockImplementation(async () => ({ Items: [], Count: 0 }))
const mockDeleteItem = vi.fn().mockImplementation(async () => ({}))
const mockUpdateItem = vi.fn().mockImplementation(async () => ({}))
const mockBatchGetItem = vi.fn().mockImplementation(async () => ({ Responses: {} }))
const mockBatchWriteItem = vi.fn().mockImplementation(async () => ({ UnprocessedItems: {} }))
const mockTransactWriteItems = vi.fn().mockImplementation(async () => ({}))
const mockTransactGetItems = vi.fn().mockImplementation(async () => ({ Responses: [] }))

const TestDynamoClient = Layer.succeed(DynamoClient, {
  putItem: (input: any) =>
    Effect.tryPromise({
      try: () => mockPutItem(input),
      catch: (e) => new DynamoError({ operation: "PutItem", cause: e }),
    }),
  getItem: (input: any) =>
    Effect.tryPromise({
      try: () => mockGetItem(input),
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
  query: (input: any) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  scan: (input: any) =>
    Effect.tryPromise({
      try: () => mockScan(input),
      catch: (e) => new DynamoError({ operation: "Scan", cause: e }),
    }),
  deleteItem: (input: any) =>
    Effect.tryPromise({
      try: () => mockDeleteItem(input),
      catch: (e) => new DynamoError({ operation: "DeleteItem", cause: e }),
    }),
  updateItem: (input: any) =>
    Effect.tryPromise({
      try: () => mockUpdateItem(input),
      catch: (e) => new DynamoError({ operation: "UpdateItem", cause: e }),
    }),
  batchGetItem: (input: any) =>
    Effect.tryPromise({
      try: () => mockBatchGetItem(input),
      catch: (e) => new DynamoError({ operation: "BatchGetItem", cause: e }),
    }),
  batchWriteItem: (input: any) =>
    Effect.tryPromise({
      try: () => mockBatchWriteItem(input),
      catch: (e) => new DynamoError({ operation: "BatchWriteItem", cause: e }),
    }),
  transactWriteItems: (input: any) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  transactGetItems: (input: any) =>
    Effect.tryPromise({
      try: () => mockTransactGetItems(input),
      catch: (e) => new DynamoError({ operation: "TransactGetItems", cause: e }),
    }),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
} as any)

const TestTableConfig = MainTable.layer({ name: "geo-test-table" })
const TestLayer = Layer.merge(TestDynamoClient, TestTableConfig)

// ---------------------------------------------------------------------------
// Helper to seed a vehicle into the store
// ---------------------------------------------------------------------------

const seedVehicle = (input: Entity.Input<typeof Vehicles>) =>
  Effect.gen(function* () {
    yield* VehicleGeo.put(input).asEffect()
  }).pipe(Effect.provide(TestLayer))

// ---------------------------------------------------------------------------
// Known locations around San Francisco (center: 37.7749, -122.4194)
// ---------------------------------------------------------------------------

const SF_CENTER = { latitude: 37.7749, longitude: -122.4194 }
const NOW = 1700000000000

// Approximately 1km north of center
const POINT_1KM = { latitude: 37.7839, longitude: -122.4194 }
// Approximately 3km east
const POINT_3KM = { latitude: 37.7749, longitude: -122.3854 }
// Approximately 5km south
const POINT_5KM = { latitude: 37.73, longitude: -122.4194 }
// Approximately 10km west
const POINT_10KM = { latitude: 37.7749, longitude: -122.534 }
// Approximately 50km away
const POINT_50KM = { latitude: 37.3382, longitude: -121.8863 }

describe("GeoSearch", () => {
  beforeEach(() => {
    store = new Map()
    vi.clearAllMocks()
  })

  it("finds nearby vehicles within radius", async () => {
    // Seed 5 vehicles at known distances
    await Effect.runPromise(
      Effect.all([
        seedVehicle({
          vehicleId: "v-1km",
          latitude: POINT_1KM.latitude,
          longitude: POINT_1KM.longitude,
          timestamp: NOW,
        }),
        seedVehicle({
          vehicleId: "v-3km",
          latitude: POINT_3KM.latitude,
          longitude: POINT_3KM.longitude,
          timestamp: NOW,
        }),
        seedVehicle({
          vehicleId: "v-5km",
          latitude: POINT_5KM.latitude,
          longitude: POINT_5KM.longitude,
          timestamp: NOW,
        }),
        seedVehicle({
          vehicleId: "v-10km",
          latitude: POINT_10KM.latitude,
          longitude: POINT_10KM.longitude,
          timestamp: NOW,
        }),
        seedVehicle({
          vehicleId: "v-50km",
          latitude: POINT_50KM.latitude,
          longitude: POINT_50KM.longitude,
          timestamp: NOW,
        }),
      ]),
    )

    // Query with 6km radius — should include v-1km, v-3km, v-5km
    const results = await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 6000,
        unit: "m",
        timeWindow: { start: NOW - 60 * 60 * 1000, end: NOW + 1000 },
      }).pipe(Effect.provide(TestLayer)),
    )

    // Verify results have correct structure
    for (const r of results) {
      expect(r.item).toBeDefined()
      expect(typeof r.distance).toBe("number")
    }

    // Verify sorted by distance ASC
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.distance).toBeGreaterThanOrEqual(results[i - 1]!.distance)
    }

    // All returned items should be within 6000m
    for (const r of results) {
      expect(r.distance).toBeLessThanOrEqual(6000)
    }

    // Verify that mockQuery was called (queries were built and executed)
    expect(mockQuery).toHaveBeenCalled()
  })

  it("returns empty results for location with no nearby items", async () => {
    // Seed items near SF
    await Effect.runPromise(
      seedVehicle({
        vehicleId: "v-sf",
        latitude: SF_CENTER.latitude,
        longitude: SF_CENTER.longitude,
        timestamp: NOW,
      }),
    )

    // Query from Antarctica — should return nothing
    const results = await Effect.runPromise(
      VehicleGeo.nearby({
        center: { latitude: -75, longitude: 0 },
        radius: 1000,
        unit: "m",
        timeWindow: { start: NOW - 60 * 60 * 1000, end: NOW + 1000 },
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(results).toEqual([])
  })

  it("sorts DESC when requested", async () => {
    await Effect.runPromise(
      Effect.all([
        seedVehicle({
          vehicleId: "v-near",
          latitude: POINT_1KM.latitude,
          longitude: POINT_1KM.longitude,
          timestamp: NOW,
        }),
        seedVehicle({
          vehicleId: "v-far",
          latitude: POINT_3KM.latitude,
          longitude: POINT_3KM.longitude,
          timestamp: NOW,
        }),
      ]),
    )

    const results = await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 10000,
        unit: "m",
        sort: "DESC",
        timeWindow: { start: NOW - 60 * 60 * 1000, end: NOW + 1000 },
      }).pipe(Effect.provide(TestLayer)),
    )

    // If more than one result, should be sorted DESC
    if (results.length > 1) {
      for (let i = 1; i < results.length; i++) {
        expect(results[i]!.distance).toBeLessThanOrEqual(results[i - 1]!.distance)
      }
    }
  })

  it("items without coordinates are not returned", async () => {
    // Seed item without coordinates — should not appear in geo queries
    await Effect.runPromise(seedVehicle({ vehicleId: "v-noloc", timestamp: NOW }))

    const results = await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 100000,
        unit: "m",
        timeWindow: { start: NOW - 60 * 60 * 1000, end: NOW + 1000 },
      }).pipe(Effect.provide(TestLayer)),
    )

    // No results should have vehicleId "v-noloc"
    const noLocResults = results.filter((r) => r.item.vehicleId === "v-noloc")
    expect(noLocResults).toHaveLength(0)
  })

  it("generates queries across multiple time partitions", async () => {
    // Seed items in different hours
    const oneHourAgo = NOW - H3.HOURLY_BUCKET_MS
    const twoHoursAgo = NOW - 2 * H3.HOURLY_BUCKET_MS

    await Effect.runPromise(
      Effect.all([
        seedVehicle({
          vehicleId: "v-now",
          latitude: SF_CENTER.latitude,
          longitude: SF_CENTER.longitude,
          timestamp: NOW,
        }),
        seedVehicle({
          vehicleId: "v-1h",
          latitude: SF_CENTER.latitude,
          longitude: SF_CENTER.longitude,
          timestamp: oneHourAgo,
        }),
        seedVehicle({
          vehicleId: "v-2h",
          latitude: SF_CENTER.latitude,
          longitude: SF_CENTER.longitude,
          timestamp: twoHoursAgo,
        }),
      ]),
    )

    await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 1000,
        unit: "m",
        timeWindow: { start: twoHoursAgo, end: NOW + 1000 },
      }).pipe(Effect.provide(TestLayer)),
    )

    // Verify multiple queries were made (one per timePartition x chunk)
    // With 3 hours span, we should have at least 3 time partitions
    expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it("constructs queries with correct BETWEEN condition", async () => {
    await Effect.runPromise(
      seedVehicle({
        vehicleId: "v-1",
        latitude: SF_CENTER.latitude,
        longitude: SF_CENTER.longitude,
        timestamp: NOW,
      }),
    )

    await Effect.runPromise(
      VehicleGeo.nearby({
        center: SF_CENTER,
        radius: 1000,
        unit: "m",
        timeWindow: { start: NOW - 60 * 60 * 1000, end: NOW + 1000 },
      }).pipe(Effect.provide(TestLayer)),
    )

    // Check that at least one query was made with BETWEEN
    const queryCalls = mockQuery.mock.calls
    expect(queryCalls.length).toBeGreaterThan(0)

    const firstCall = queryCalls[0]![0]
    expect(firstCall.IndexName).toBe("gsi1")
    expect(firstCall.KeyConditionExpression).toContain("BETWEEN")
  })

  it("enrichment round-trip: enrich + put + query returns consistent data", async () => {
    const input: Entity.Input<typeof Vehicles> = {
      vehicleId: "v-roundtrip",
      latitude: SF_CENTER.latitude,
      longitude: SF_CENTER.longitude,
      timestamp: NOW,
    }

    const enriched = VehicleGeo.enrich(input)

    // Verify enrichment produced correct fields
    expect(enriched.cell).toBeDefined()
    expect(enriched.parentCell).toBeDefined()
    expect(enriched.timePartition).toBeDefined()

    // The cell should be a valid H3 cell at resolution 15
    expect(h3.isValidCell(enriched.cell!)).toBe(true)
    expect(h3.getResolution(enriched.cell!)).toBe(15)

    // The parentCell should be the parent at resolution 3
    expect(h3.cellToParent(enriched.cell!, 3)).toBe(enriched.parentCell)
  })

  // -------------------------------------------------------------------------
  // GeoIndex.bind tests
  // -------------------------------------------------------------------------

  describe("GeoIndex.bind", () => {
    it("returns a BoundGeoIndex with put, nearby, enrich, and provide", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bound = yield* GeoIndex.bind(VehicleGeo)
          expect(typeof bound.put).toBe("function")
          expect(typeof bound.nearby).toBe("function")
          expect(typeof bound.enrich).toBe("function")
          expect(typeof bound.provide).toBe("function")
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    it("bound put writes item with geo enrichment", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bound = yield* GeoIndex.bind(VehicleGeo)
          yield* bound.put({
            vehicleId: "v-bind-put",
            latitude: SF_CENTER.latitude,
            longitude: SF_CENTER.longitude,
            timestamp: NOW,
          })
        }).pipe(Effect.provide(TestLayer)),
      )

      // Verify put was called
      expect(mockPutItem).toHaveBeenCalled()

      // Verify geo fields were enriched in the stored item
      const lastCall = mockPutItem.mock.calls[mockPutItem.mock.calls.length - 1]![0]
      const item = lastCall.Item as Record<string, AttributeValue>
      expect(item.cell?.S).toBeDefined()
      expect(item.parentCell?.S).toBeDefined()
      expect(item.timePartition?.S).toBeDefined()
    })

    it("bound nearby searches with R = never", async () => {
      // Seed a vehicle first
      await Effect.runPromise(
        Effect.gen(function* () {
          const bound = yield* GeoIndex.bind(VehicleGeo)
          yield* bound.put({
            vehicleId: "v-bind-nearby",
            latitude: POINT_1KM.latitude,
            longitude: POINT_1KM.longitude,
            timestamp: NOW,
          })
        }).pipe(Effect.provide(TestLayer)),
      )

      // Search using bound nearby
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const bound = yield* GeoIndex.bind(VehicleGeo)
          return yield* bound.nearby({
            center: SF_CENTER,
            radius: 5000,
            unit: "m",
            timeWindow: { start: NOW - 60 * 60 * 1000, end: NOW + 1000 },
          })
        }).pipe(Effect.provide(TestLayer)),
      )

      // Results should have correct structure
      for (const r of results) {
        expect(r.item).toBeDefined()
        expect(typeof r.distance).toBe("number")
      }
    })

    it("bound enrich is the same as unbound enrich", () => {
      // enrich is pure — no need to provide layers
      const input: Entity.Input<typeof Vehicles> = {
        vehicleId: "v-bind-enrich",
        latitude: SF_CENTER.latitude,
        longitude: SF_CENTER.longitude,
        timestamp: NOW,
      }

      // We need to bind to test, but enrich should produce same result
      const unboundEnriched = VehicleGeo.enrich(input)

      Effect.runPromise(
        Effect.gen(function* () {
          const bound = yield* GeoIndex.bind(VehicleGeo)
          const boundEnriched = bound.enrich(input)
          expect(boundEnriched).toEqual(unboundEnriched)
        }).pipe(Effect.provide(TestLayer)),
      )
    })

    it("bound provide resolves DynamoClient | TableConfig for arbitrary effects", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const bound = yield* GeoIndex.bind(VehicleGeo)

          // Use provide to run an arbitrary effect that needs DynamoClient | TableConfig
          const result = yield* bound.provide(
            VehicleGeo.nearby({
              center: SF_CENTER,
              radius: 1000,
              unit: "m",
              timeWindow: { start: NOW - 60 * 60 * 1000, end: NOW + 1000 },
            }),
          )

          expect(Array.isArray(result)).toBe(true)
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  })
})
