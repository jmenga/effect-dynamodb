/**
 * Time buckets other than hourly (#292), against DynamoDB Local: one entity
 * with an hourly and a daily geo index, each writing its own partition
 * attribute.
 */
import { Config, Effect, Layer, Schema } from "effect"
import { DynamoClient, DynamoSchema, Entity, Table } from "effect-dynamodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"

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

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

class Sighting extends Schema.Class<Sighting>("Sighting")({
  sightingId: Schema.String,
  latitude: Schema.Number,
  longitude: Schema.Number,
  timestamp: Schema.Number,
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
    byHour: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "hourPartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
    byDay: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["parentCell", "dayPartition"] },
      sk: { field: "gsi2sk", composite: ["cell"] },
    },
  },
})

const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "geobucket", version: 1 }),
  entities: { Sightings },
})

const coordinates = (item: { readonly latitude: number; readonly longitude: number }) => ({
  latitude: item.latitude,
  longitude: item.longitude,
})
const cells = {
  cell: { field: "cell", resolution: 15 },
  parentCell: { field: "parentCell", resolution: 3 },
} as const

const HourGeo = GeoIndex.make({
  entity: Sightings,
  index: "byHour",
  coordinates,
  fields: {
    ...cells,
    timePartition: { field: "hourPartition", source: "timestamp", bucket: "hourly" },
  },
})

const DayGeo = GeoIndex.make({
  entity: Sightings,
  index: "byDay",
  coordinates,
  fields: {
    ...cells,
    timePartition: { field: "dayPartition", source: "timestamp", bucket: "1 day" },
  },
})

const tableName = `geo-time-bucket-test-${Date.now()}`

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const queriesSent: Array<{ readonly index: string | undefined }> = []
const CountingClient = Layer.effect(
  DynamoClient,
  Effect.map(Effect.service(DynamoClient), (client) => ({
    ...client,
    query: (input: Parameters<typeof client.query>[0]) => {
      queriesSent.push({ index: input.IndexName })
      return client.query(input)
    },
  })),
).pipe(Layer.provide(ClientLayer))

const TestLayer = Layer.mergeAll(CountingClient, MainTable.layer({ name: tableName }))
const run = <A, E>(effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLayer)))

const CENTER = { latitude: 48.8566, longitude: 2.3522 }
const NOW = Date.now()

describeConnected("GeoIndex time buckets (connected, #292)", () => {
  beforeAll(async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
      }),
    )
  }, 15000)

  afterAll(async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void)),
    )
  }, 15000)

  it("a daily index finds an item written 20 hours ago with a 24-hour window", async () => {
    // Written once, through both indexes.
    const sight = (sightingId: string, timestamp: number, offset: number) =>
      HourGeo.put(
        DayGeo.enrich({
          sightingId,
          latitude: CENTER.latitude + 0.0001 * offset,
          longitude: CENTER.longitude,
          timestamp,
        }),
      ).asEffect()
    await run(
      Effect.gen(function* () {
        yield* sight("s-20h", NOW - 20 * HOUR_MS, 0)
        yield* sight("s-1m", NOW - 60_000, 1)
        yield* sight("s-30h", NOW - 30 * HOUR_MS, 2)
      }),
    )

    const timeWindow = { start: NOW - DAY_MS, end: NOW }
    queriesSent.length = 0
    const daily = await run(DayGeo.nearby({ center: CENTER, radius: 500, timeWindow }))
    expect(daily.map((r) => r.item.sightingId).sort()).toEqual(["s-1m", "s-20h"])
    const dailyQueries = queriesSent.length
    expect(queriesSent.every((q) => q.index === "gsi2")).toBe(true)

    // The hourly index reads 24 or 25 hours for the same window, and finds
    // the same items.
    queriesSent.length = 0
    const hourly = await run(HourGeo.nearby({ center: CENTER, radius: 500, timeWindow }))
    expect(hourly.map((r) => r.item.sightingId).sort()).toEqual(["s-1m", "s-20h"])
    expect(queriesSent.every((q) => q.index === "gsi1")).toBe(true)
    const days = Math.floor(NOW / DAY_MS) - Math.floor((NOW - DAY_MS) / DAY_MS) + 1
    const hours = Math.floor(NOW / HOUR_MS) - Math.floor((NOW - DAY_MS) / HOUR_MS) + 1
    expect(queriesSent.length * days).toBe(dailyQueries * hours)

    // A one-hour window on the hourly index leaves the 20-hour-old item out.
    const recent = await run(
      HourGeo.nearby({
        center: CENTER,
        radius: 500,
        timeWindow: { start: NOW - HOUR_MS, end: NOW },
      }),
    )
    expect(recent.map((r) => r.item.sightingId)).toEqual(["s-1m"])
  })
})
