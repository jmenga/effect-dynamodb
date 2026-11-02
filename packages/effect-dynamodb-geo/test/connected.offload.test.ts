/**
 * Offloaded and packed fields on a geo entity against DynamoDB Local (#147,
 * #179, design §8.4): `GeoIndex.put` stores pointers (overflow `B`, binary
 * `S` "~edbp:" text) and `nearby` reads both kinds eagerly through the
 * entity's own decoder, as it reads packed fields and renamed attributes.
 * Objects go to the in-memory blob store, whose call counts say what each
 * search fetched (the S3 store and MinIO are later commits').
 */

import { Config, Effect, Layer, Schema } from "effect"
import {
  BlobStore,
  DynamoClient,
  DynamoModel,
  DynamoSchema,
  Entity,
  type MemoryBlobStore,
  Table,
} from "effect-dynamodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import { withOffloadGate } from "./helpers/OffloadGate.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local isn't reachable
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
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "geooffload", version: 1, escapeKeys: true })

const Notes = Schema.Struct({ text: Schema.String })

class Courier extends Schema.Class<Courier>("Courier")({
  courierId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  label: Schema.optional(Schema.String),
  notes: Schema.optional(Notes),
  photo: Schema.optional(Schema.Uint8Array),
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
}) {}

const courierConfig = {
  primaryKey: {
    pk: { field: "pk", composite: ["courierId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCell: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["parentCell", "timePartition"] },
      sk: { field: "gsi1sk", composite: ["cell"] },
    },
  },
} as const

const Couriers = withOffloadGate(() =>
  Entity.make({
    ...courierConfig,
    entityType: "Courier",
    model: DynamoModel.configure(Courier, {
      notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
      photo: { storedAs: DynamoModel.External({ contentType: "image/jpeg" }) },
    }),
  }),
)

const PackedCouriers = Entity.make({
  ...courierConfig,
  entityType: "PackedCourier",
  model: DynamoModel.configure(Courier, {
    notes: { storedAs: DynamoModel.Packed({ format: "json" }) },
    label: { field: "lbl" },
  }),
})

const MainTable = Table.make({ schema: AppSchema, entities: { Couriers, PackedCouriers } })

const fields = {
  cell: { field: "cell", resolution: 15 },
  parentCell: { field: "parentCell", resolution: 3 },
  timePartition: { field: "timePartition", source: "timestamp", bucket: "hourly" },
} as const

const coordinates = (item: {
  readonly latitude?: number | undefined
  readonly longitude?: number | undefined
}) =>
  item.latitude !== undefined && item.longitude !== undefined
    ? { latitude: item.latitude, longitude: item.longitude }
    : undefined

const CourierGeo = GeoIndex.make({ entity: Couriers, index: "byCell", coordinates, fields })
const PackedGeo = GeoIndex.make({ entity: PackedCouriers, index: "byCell", coordinates, fields })

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

const tableName = `geo-offload-test-${Date.now()}`

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const TestLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))

const run = <A, E>(
  effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig>,
  store?: MemoryBlobStore,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        store === undefined ? TestLayer : Layer.merge(TestLayer, BlobStore.layer(store)),
      ),
    ),
  )

const NOW = Date.now()
const BERLIN = { latitude: 52.52, longitude: 13.405 }
const search = { center: BERLIN, radius: 1_000, timeWindow: { start: NOW - 1, end: NOW + 1 } }

describeConnected("GeoIndex offloaded fields (connected)", () => {
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

  it("put stores pointers; nearby reads overflow and binary fields eagerly", async () => {
    const store = BlobStore.memory()
    const notes = { text: "n".repeat(500) }
    const photo = (n: number) => new Uint8Array(1_000).fill(n)
    const { results, raw, fetched } = await run(
      Effect.gen(function* () {
        const geo = yield* GeoIndex.bind(CourierGeo)
        const written = yield* geo.put({
          courierId: "c-1",
          latitude: BERLIN.latitude + 0.001,
          longitude: BERLIN.longitude,
          timestamp: NOW,
          notes,
          photo: photo(1),
        })
        expect(written.photo).toEqual(photo(1))
        yield* geo.put({
          courierId: "c-2",
          latitude: BERLIN.latitude + 0.002,
          longitude: BERLIN.longitude,
          timestamp: NOW,
          notes,
          photo: photo(2),
        })
        const client = yield* DynamoClient
        const raw = yield* client.getItem({
          TableName: tableName,
          Key: {
            pk: { S: "$geooffload#v1#courier#courierid_c-1" },
            sk: { S: "$geooffload#v1#courier" },
          },
        })
        const before = store.inspect().calls.get
        const results = yield* geo.nearby(search)
        return { results, raw, fetched: store.inspect().calls.get - before }
      }),
      store,
    )
    // Two rows, two pointers each: four GETs for the search.
    expect(fetched).toBe(4)
    expect(raw.Item?.notes?.B).toBeInstanceOf(Uint8Array)
    expect(raw.Item?.photo?.S?.startsWith("~edbp:")).toBe(true)
    expect(results.map((r) => r.item.courierId)).toEqual(["c-1", "c-2"])
    expect(results.map((r) => r.item.notes)).toEqual([notes, notes])
    expect(results.map((r) => r.item.photo)).toEqual([photo(1), photo(2)])
  })

  it("nearby decodes packed fields and renamed attributes (#147 gap)", async () => {
    const results = await run(
      Effect.gen(function* () {
        const geo = yield* GeoIndex.bind(PackedGeo)
        yield* geo.put({
          courierId: "p-1",
          latitude: BERLIN.latitude - 0.001,
          longitude: BERLIN.longitude,
          timestamp: NOW,
          label: "south",
          notes: { text: "packed" },
        })
        return yield* geo.nearby(search)
      }),
    )
    expect(results).toHaveLength(1)
    expect(results[0]!.item).toMatchObject({
      courierId: "p-1",
      label: "south",
      notes: { text: "packed" },
    })
  })
})
