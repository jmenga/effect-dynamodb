/**
 * A geo entity's offloaded fields end to end (#179, design §8.4, §19.4):
 * DynamoDB Local beside a real S3 API (MinIO in CI), through the S3 store
 * (`effect-dynamodb/blob/s3`) over a versioned bucket. `GeoIndex.put` stores
 * pointers (overflow `B`, binary `S` "~edbp:" text) whose objects carry the
 * library's metadata — each pointer, decoded by a lazy read of the row, names
 * the S3 version that holds its value — and `nearby` reads both kinds
 * eagerly: one GET per pointer of the rows it returns, counted by a store
 * wrapper.
 *
 * `DYNAMODB_ENDPOINT` (default `http://localhost:8000`), `S3_ENDPOINT`
 * (default `http://localhost:9000`) and the S3 credentials (`S3_ACCESS_KEY_ID`
 * / `S3_SECRET_ACCESS_KEY`, default MinIO's `minioadmin`) are read through
 * `Config`; the suite is skipped when either endpoint is unreachable. The
 * bucket is made by the test setup (with `PutBucketVersioning`), never by the
 * library.
 */

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { Config, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  BlobStore,
  type BlobStoreService,
  DynamoClient,
  DynamoModel,
  DynamoSchema,
  Entity,
  Table,
} from "effect-dynamodb"
import * as S3BlobStore from "effect-dynamodb/blob/s3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local or the S3 endpoint isn't reachable
// ---------------------------------------------------------------------------

const settings = Effect.runSync(
  Config.all({
    dynamodb: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    s3: Config.String("S3_ENDPOINT").pipe(Config.withDefault("http://localhost:9000")),
    accessKeyId: Config.String("S3_ACCESS_KEY_ID").pipe(Config.withDefault("minioadmin")),
    secretAccessKey: Config.String("S3_SECRET_ACCESS_KEY").pipe(Config.withDefault("minioadmin")),
  }),
)

const reachable = async (url: string, init: RequestInit = {}): Promise<boolean> => {
  try {
    // Any answer (DynamoDB Local's 400, MinIO's anonymous 403) means it is up.
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(1000) }).catch(() => null)
    return res !== null
  } catch {
    return false
  }
}

const available =
  (await reachable(settings.dynamodb, { method: "POST" })) && (await reachable(settings.s3))

const describeConnected = available ? describe : describe.skip

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "geoblob", version: 1, escapeKeys: true })

const Notes = Schema.Struct({ text: Schema.String })

class Courier extends Schema.Class<Courier>("Courier")({
  courierId: Schema.String,
  latitude: Schema.optional(Schema.Number),
  longitude: Schema.optional(Schema.Number),
  timestamp: Schema.Number,
  notes: Schema.optional(Notes),
  photo: Schema.optional(Schema.Uint8Array),
  cell: Schema.optional(Schema.String),
  parentCell: Schema.optional(Schema.String),
  timePartition: Schema.optional(Schema.String),
}) {}

const Couriers = Entity.make({
  model: DynamoModel.configure(Courier, {
    notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
    photo: { storedAs: DynamoModel.External({ contentType: "image/jpeg" }) },
  }),
  entityType: "Courier",
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
})

const MainTable = Table.make({ schema: AppSchema, entities: { Couriers } })

const CourierGeo = GeoIndex.make({
  entity: Couriers,
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
// Infrastructure
// ---------------------------------------------------------------------------

const stamp = Date.now()
const tableName = `geo-blob-e2e-${stamp}`
const bucket = `edd-geo-blob-e2e-${stamp}`

const admin = new S3Client({
  region: "us-east-1",
  endpoint: settings.s3,
  forcePathStyle: true,
  credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
})

/** The S3 store over the bucket, its GETs counted. */
const counted = (): { readonly store: BlobStoreService; readonly gets: () => number } => {
  const service = Effect.runSync(
    Effect.scoped(S3BlobStore.make({ bucket, client: admin, prefix: "geo/" })),
  )
  let gets = 0
  return {
    store: {
      ...service,
      get: (ref, options) =>
        Stream.suspend(() => {
          gets++
          return service.get(ref, options)
        }),
    },
    gets: () => gets,
  }
}

const TestLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: settings.dynamodb,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: tableName }),
)

const run = <A, E>(
  effect: Effect.Effect<A, E, DynamoClient | Table.TableConfig | BlobStore>,
  store: BlobStoreService,
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(TestLayer, BlobStore.layer(store)))))

const tryS3 = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new Error(`S3 admin call failed: ${cause}`) })

const NOW = Date.now()
const BERLIN = { latitude: 52.52, longitude: 13.405 }
const search = { center: BERLIN, radius: 1_000, timeWindow: { start: NOW - 1, end: NOW + 1 } }

describeConnected("GeoIndex offloaded fields over S3 (connected)", () => {
  beforeAll(async () => {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }))
    await admin.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    )
    await run(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
      }),
      counted().store,
    )
  }, 15000)

  afterAll(async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void)),
      counted().store,
    )
    try {
      for (;;) {
        const out = await admin.send(new ListObjectVersionsCommand({ Bucket: bucket }))
        const objects = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])].map((v) => ({
          Key: v.Key!,
          VersionId: v.VersionId,
        }))
        if (objects.length === 0) break
        await admin.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
        )
      }
    } catch {
      // The bucket was never made (a failed setup): nothing to empty.
    }
    await admin.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined)
    admin.destroy()
  }, 15000)

  it("put stores pointers to S3 versions; nearby reads both kinds eagerly", async () => {
    const { store, gets } = counted()
    const notes = (n: number) => ({ text: `${n}`.repeat(500) })
    const photo = (n: number) => new Uint8Array(4_000).fill(n)
    const { results, row, lazy, notesHead, photoHead, fetched } = await run(
      Effect.gen(function* () {
        const geo = yield* GeoIndex.bind(CourierGeo)
        for (const [i, courierId] of ["c-1", "c-2"].entries()) {
          yield* geo.put({
            courierId,
            latitude: BERLIN.latitude + 0.001 * (i + 1),
            longitude: BERLIN.longitude,
            timestamp: NOW,
            notes: notes(i + 1),
            photo: photo(i + 1),
          })
        }
        const client = yield* DynamoClient
        const raw = yield* client.getItem({
          TableName: tableName,
          Key: {
            pk: { S: "$geoblob#v1#courier#courierid_c-1" },
            sk: { S: "$geoblob#v1#courier" },
          },
        })
        const row = raw.Item!
        // The row's pointers, decoded by a lazy read (no GET), and the S3 versions they name.
        const db = yield* DynamoClient.make({ entities: { Couriers }, tables: { MainTable } })
        const lazy = yield* db.entities.Couriers.get({ courierId: "c-1" }).offloaded("lazy")
        const headOf = (ref: Option.Option<{ readonly key: string; readonly version: string }>) =>
          Effect.flatMap(Effect.fromOption(ref), ({ key, version }) =>
            tryS3(() =>
              admin.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: version })),
            ),
          )
        const notesHead = yield* headOf(lazy.notes!.ref)
        const photoHead = yield* headOf(lazy.photo!.ref)
        const before = gets()
        const results = yield* geo.nearby(search)
        return { results, row, lazy, notesHead, photoHead, fetched: gets() - before }
      }),
      store,
    )
    expect(row.notes?.B).toBeInstanceOf(Uint8Array)
    expect(row.photo?.S?.startsWith("~edbp:")).toBe(true)
    // Both are pointers (an inline packed value is a `B` too), each naming its version.
    expect(lazy.notes?.location).toBe("external")
    expect(lazy.photo?.location).toBe("external")
    expect(notesHead.VersionId).toBe(Option.getOrThrow(lazy.notes!.ref).version)
    expect(notesHead.Metadata).toMatchObject({
      "edd-table": tableName,
      "edd-entity": "Courier",
      "edd-attr": "notes",
      "edd-kind": "json",
    })
    expect(photoHead.VersionId).toBe(Option.getOrThrow(lazy.photo!.ref).version)
    expect(photoHead.ContentType).toBe("image/jpeg")
    expect(photoHead.ContentLength).toBe(4_000)
    expect(photoHead.Metadata).toMatchObject({
      "edd-table": tableName,
      "edd-entity": "Courier",
      "edd-attr": "photo",
      "edd-kind": "bytes",
    })
    // Two rows, two pointers each: four GETs for the search.
    expect(fetched).toBe(4)
    expect(results.map((r) => r.item.courierId)).toEqual(["c-1", "c-2"])
    expect(results.map((r) => r.item.notes)).toEqual([notes(1), notes(2)])
    expect(results.map((r) => r.item.photo)).toEqual([photo(1), photo(2)])
  })
})
