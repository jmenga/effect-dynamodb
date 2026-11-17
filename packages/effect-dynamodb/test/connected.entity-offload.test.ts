/**
 * Entity writes and reads of offloaded fields against DynamoDB Local (#179,
 * design §6, §8): the stored pointers, settlement by DynamoDB's real answers
 * (`ALL_OLD` on a refused create, `ALL_NEW` after an upsert's
 * `if_not_exists`, a cancelled time-series append), the item-size retry on
 * DynamoDB's own 400 KB rejection, lifecycle copies, and every read path per
 * mode — gets, index queries with projections and `limit`, scans, batch and
 * transactional gets, lifecycle reads and stream-image decoding. Objects go
 * to the in-memory blob store, whose call counts say what each read fetched
 * (`connected.blob-offload.test.ts` runs the same paths over the S3 store and
 * MinIO, with GC). Binary inputs (§3.8, §7):
 * streams through the store's multipart simulation, single use, handle
 * copies and source failures. Aggregates (§6.9, §8.4): offloading edges
 * hydrated eagerly and re-uploaded per edge item (only the offloaded fields
 * an element holds; none, and no store, for one that holds none), a changed
 * group's re-upload, a refused create's rollback, eager assembly.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { composeCollectionKey } from "@effect-dynamodb/schema/DynamoSchema.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { crc64nvme } from "@effect-dynamodb/schema/internal/Crc64Nvme.js"
import { Cause, Config, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { BlobStore } from "../src/BlobStore.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Offload from "../src/Offload.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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

const AppSchema = DynamoSchema.make({ name: "offload-ent", version: 1, escapeKeys: true })
const tableName = `offload-entity-${Date.now()}`

const Text = Schema.Struct({ text: Schema.String })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.optional(Text),
  notes: Schema.optional(Text),
  scan: Schema.optional(Schema.Uint8Array),
  origin: Schema.optional(Text),
}) {}

const docKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const docModel = (threshold: number) =>
  DynamoModel.configure(Doc, {
    body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold } }) },
    notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold } }) },
    scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
    origin: {
      storedAs: DynamoModel.Packed({ format: "json", external: { threshold } }),
      immutable: true,
    },
  })

const Docs = Entity.make({ model: docModel(1_024), entityType: "Doc", primaryKey: docKey })

/** Thresholds out of reach: the item budget routes. */
const Budgeted = Entity.make({
  model: docModel(400_000),
  entityType: "Budgeted",
  primaryKey: docKey,
  offload: { itemBudget: 300_000 },
})

const Kept = Entity.make({
  model: docModel(1_024),
  entityType: "Kept",
  primaryKey: docKey,
  versioned: { retain: true },
  softDelete: true,
})

/** An index to query offloading rows through. */
const Shelved = Entity.make({
  model: docModel(1_024),
  entityType: "Shelved",
  primaryKey: docKey,
  indexes: {
    byTitle: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["title"] },
      sk: { field: "gsi1sk", composite: ["docId"] },
    },
  },
})

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  at: Schema.Number,
  raw: Schema.optional(Schema.Uint8Array),
}) {}

const Readings = Entity.make({
  model: DynamoModel.configure(Reading, { raw: { storedAs: DynamoModel.External() } }),
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["sensorId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      sensorId: Schema.String,
      at: Schema.Number,
      raw: Schema.optional(Schema.Uint8Array),
    }),
  },
})

/** Docs an aggregate hydrates its edges from: hydration keys them by their identifier. */
const AlbumDocs = Entity.make({
  model: DynamoModel.configure(Doc, {
    docId: { identifier: true },
    body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 1_024 } }) },
    scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
  }),
  entityType: "AlbumSource",
  primaryKey: docKey,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Docs, Budgeted, Kept, Shelved, Readings, AlbumDocs },
})

/** An aggregate whose edges are offloading docs: a one edge, and a many edge in a sub-aggregate. */
class AlbumPage extends Schema.Class<AlbumPage>("AlbumPage")({
  label: Schema.String,
  docs: Schema.Array(Doc),
}) {}
class Album extends Schema.Class<Album>("Album")({
  albumId: Schema.String,
  owner: Schema.String,
  title: Schema.String,
  cover: Doc,
  page: AlbumPage,
}) {}
const Albums = Aggregate.make(Album, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["albumId"] },
  collection: { name: "album" },
  list: {
    index: "gsi1",
    name: "albums",
    pk: { field: "gsi1pk", composite: ["owner"] },
    sk: { field: "gsi1sk", composite: ["albumId"] },
  },
  root: { entityType: "AlbumItem" },
  edges: {
    cover: Aggregate.one("cover", { entityType: "AlbumCover", entity: AlbumDocs }),
    page: Aggregate.make(AlbumPage, {
      root: { entityType: "AlbumPageItem" },
      edges: {
        docs: Aggregate.many("docs", {
          entityType: "AlbumDoc",
          entity: AlbumDocs,
          sk: { composite: ["docId"] },
        }),
      },
    }).with({ discriminator: { pageNo: 1 } }),
  },
})

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

let blobs: MemoryBlobStore = BlobStore.memory()
beforeEach(() => {
  blobs = BlobStore.memory()
})

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }), BlobStore.layer(blobs)),
      ),
    ),
  )

const client = DynamoClient.make({
  entities: { Docs, Budgeted, Kept, Shelved, Readings, AlbumDocs },
  aggregates: { Albums },
  tables: { MainTable },
})

/** The raw stored item at a key. */
const rawItem = (pk: string, sk: string) =>
  Effect.gen(function* () {
    const raw = yield* DynamoClient
    const result = yield* raw.getItem({
      TableName: tableName,
      Key: toAttributeMap({ pk, sk }),
      ConsistentRead: true,
    })
    return result.Item as Record<string, AttributeValue> | undefined
  })
const liveDoc = (entity: string, id: string) =>
  Effect.map(
    rawItem(
      `$offload-ent#v1#${entity}#docid_${id}`.toLowerCase(),
      `$offload-ent#v1#${entity}`.toLowerCase(),
    ),
    (item) => item!,
  )
const partition = (pk: string) =>
  Effect.gen(function* () {
    const raw = yield* DynamoClient
    const result = yield* raw.query({
      TableName: tableName,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": { S: pk } },
      ConsistentRead: true,
    })
    return (result.Items ?? []) as Array<Record<string, AttributeValue>>
  })

const isOverflowPointer = (value: AttributeValue | undefined) =>
  value?.B !== undefined && BlobPointer.isPointerHeader(value.B[0]!)
const isBinaryPointer = (value: AttributeValue | undefined) =>
  value?.S !== undefined && BlobPointer.isPointerText(value.S)

const text = (n: number) => ({ text: "x".repeat(n) })
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("Entity offloaded fields (#179)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.tables.MainTable.create()
        }),
      ),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const raw = yield* DynamoClient
          yield* raw.deleteTable({ TableName: tableName })
        }),
      ).pipe(Effect.catchTag("ResourceNotFoundError", () => Effect.void)),
    )
  }, 15000)

  it.effect("put stores pointers for values over their thresholds and every binary value", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        const doc = { docId: "d-1", title: "t", body: text(2_000), notes: text(10), scan: bytes(3) }
        const result = yield* db.entities.Docs.put(doc)
        const row = yield* liveDoc("doc", "d-1")
        expect(isOverflowPointer(row.body)).toBe(true)
        expect(row.notes).toBeDefined()
        expect(isOverflowPointer(row.notes)).toBe(false)
        expect(isBinaryPointer(row.scan)).toBe(true)
        // The result reads the operation's own uploads from its read cache;
        // the binary field is a lazy handle by default.
        expect(result.body).toEqual(doc.body)
        expect(Offload.isBlobHandle(result.scan)).toBe(true)
        expect(blobs.inspect().calls).toMatchObject({ put: 2, get: 0 })
        expect(yield* result.scan!.read()).toEqual(doc.scan)
      }),
    ),
  )

  it.effect("insert() uploads as put does; a duplicate's upload is deleted (DuplicateItem)", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        const doc = { docId: "i-1", title: "t", body: text(2_000), scan: bytes(3) }
        const result = yield* db.entities.Docs.insert(doc)
        const row = yield* liveDoc("doc", "i-1")
        expect(isOverflowPointer(row.body)).toBe(true)
        expect(isBinaryPointer(row.scan)).toBe(true)
        // As `put`'s: the binary field is a lazy handle by default, read from the read cache.
        expect(result.body).toEqual(doc.body)
        expect(Offload.isBlobHandle(result.scan)).toBe(true)
        expect(blobs.inspect().calls).toMatchObject({ put: 2, get: 0, delete: 0 })
        expect(yield* result.scan!.read()).toEqual(doc.scan)
        // DynamoDB refuses the INSERT of an existing item, sent once: its uploads roll back.
        const error = yield* Effect.flip(
          db.entities.Docs.insert({ ...doc, body: text(3_000), scan: bytes(4, 1) }).asEffect(),
        )
        expect(error._tag).toBe("ItemAlreadyExists")
        // Rolled back: one delete per store, both versions in it.
        expect(blobs.inspect().calls).toMatchObject({ put: 4, delete: 1 })
        expect(blobs.inspect().versions).toHaveLength(2)
        expect((yield* liveDoc("doc", "i-1")).body).toEqual(row.body)
      }),
    ),
  )

  it.effect("a refused create's upload is deleted, settled by DynamoDB's ALL_OLD", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "d-2", title: "t", body: text(2_000) })
        const error = yield* Effect.flip(
          db.entities.Docs.create({ docId: "d-2", title: "t", body: text(3_000) }).asEffect(),
        )
        expect(error._tag).toBe("ConditionalCheckFailed")
        expect(blobs.inspect().calls).toMatchObject({ put: 2, delete: 1 })
        expect(blobs.inspect().versions).toHaveLength(1)
      }),
    ),
  )

  it.effect("an upsert keeps a stored immutable; ALL_NEW settles the losing upload away", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.upsert({ docId: "d-3", title: "t", origin: text(2_000) })
        const kept = (yield* liveDoc("doc", "d-3")).origin
        const result = yield* db.entities.Docs.upsert({
          docId: "d-3",
          title: "t2",
          origin: text(3_000),
        })
        expect((yield* liveDoc("doc", "d-3")).origin).toEqual(kept)
        expect(result.origin).toEqual(text(2_000))
        expect(blobs.inspect().calls).toMatchObject({ put: 2, delete: 1 })
      }),
    ),
  )

  it.effect("a read-merge upsert routes an immutable the row lacks, as a pointer", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Kept.put({ docId: "k-u", title: "t" })
        const result = yield* db.entities.Kept.upsert({
          docId: "k-u",
          title: "t2",
          origin: text(2_000),
        })
        expect(isOverflowPointer((yield* liveDoc("kept", "k-u")).origin)).toBe(true)
        expect(result.origin).toEqual(text(2_000))
        expect(blobs.inspect().calls.put).toBe(1)
      }),
    ),
  )

  it.effect("an update DynamoDB rejects for item size is retried, routing the merged item", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Budgeted.put({ docId: "b-1", title: "t", notes: text(250_000) })
        expect(blobs.inspect().calls.put).toBe(0)
        const result = yield* db.entities.Budgeted.update({ docId: "b-1" }).set({
          body: text(250_000),
        })
        const row = yield* liveDoc("budgeted", "b-1")
        expect(isOverflowPointer(row.body)).toBe(true)
        expect(row.notes).toBeDefined()
        expect(isOverflowPointer(row.notes)).toBe(false)
        expect(result.body).toEqual(text(250_000))
        expect(blobs.inspect().calls.put).toBe(1)
      }),
    ),
  )

  it.effect("an append uploads once, keyed by the event item; a stale one is deleted", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        const { current } = yield* db.entities.Readings.append({
          sensorId: "s-1",
          at: 5,
          raw: bytes(64),
        })
        expect(yield* current.raw!.read()).toEqual(bytes(64))
        const items = yield* partition("$offload-ent#v1#reading#sensorid_s-1")
        const head = items.find((item) => !item.sk!.S!.includes("#e#"))!
        const event = items.find((item) => item.sk!.S!.includes("#e#"))!
        expect(isBinaryPointer(head.raw)).toBe(true)
        expect(event.raw).toEqual(head.raw)
        const stale = yield* Effect.flip(
          db.entities.Readings.append({ sensorId: "s-1", at: 2, raw: bytes(64, 1) }).asEffect(),
        )
        expect(stale._tag).toBe("StaleAppend")
        expect(blobs.inspect().calls).toMatchObject({ put: 2, delete: 1 })
        expect(blobs.inspect().versions).toHaveLength(1)
      }),
    ),
  )

  it.effect("snapshots and tombstones copy the pointers without uploading", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Kept.put({
          docId: "k-1",
          title: "v1",
          body: text(2_000),
          scan: bytes(5),
        })
        const original = yield* liveDoc("kept", "k-1")
        yield* db.entities.Kept.update({ docId: "k-1" }).set({ title: "v2" })
        yield* db.entities.Kept.delete({ docId: "k-1" })
        const items = yield* partition("$offload-ent#v1#kept#docid_k-1")
        const copies = items.filter((item) => /#(v|deleted)#/.test(item.sk!.S!))
        expect(copies.length).toBeGreaterThanOrEqual(2)
        for (const copy of copies) {
          expect(copy.body).toEqual(original.body)
          expect(copy.scan).toEqual(original.scan)
        }
        const restored = yield* db.entities.Kept.restore({ docId: "k-1" })
        expect(restored.body).toEqual(text(2_000))
        expect((yield* liveDoc("kept", "k-1")).body).toEqual(original.body)
        expect(blobs.inspect().calls.put).toBe(2)
      }),
    ),
  )

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  const gets = () => blobs.inspect().calls.get
  const BODY = text(2_000)
  const SCAN = bytes(300)
  const shelve = (docId: string, title = "shelf") =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Shelved.put({ docId, title, body: BODY, notes: text(10), scan: SCAN })
    })

  it.effect("get reads overflow eagerly and binary lazily; .offloaded() picks the modes", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        yield* shelve("r-1", "get")
        const key = { docId: "r-1" }
        let before = gets()
        const doc = yield* db.entities.Shelved.get(key)
        expect(doc.body).toEqual(BODY)
        expect(doc.notes).toEqual(text(10))
        expect(gets()).toBe(before + 1)
        expect(Offload.isBlobHandle(doc.scan)).toBe(true)
        expect(yield* doc.scan!.read()).toEqual(SCAN)
        expect(gets()).toBe(before + 2)

        before = gets()
        const lazy = yield* db.entities.Shelved.get(key).offloaded("lazy")
        expect(gets()).toBe(before)
        expect(Offload.isOffloadedValue(lazy.body)).toBe(true)
        expect(lazy.body!.location).toBe("external")
        expect(lazy.notes?.location).toBe("inline")
        expect(yield* lazy.body!.read()).toEqual(BODY)
        expect(yield* lazy.notes!.read()).toEqual(text(10))
        expect(gets()).toBe(before + 1)

        before = gets()
        const eager = yield* db.entities.Shelved.get(key).offloaded("eager")
        expect(eager.scan).toEqual(SCAN)
        expect(gets()).toBe(before + 2)

        // asNative: the stored pointers, untouched.
        const native = (yield* Entity.asNative(Shelved.get(key))) as unknown as Record<
          string,
          AttributeValue
        >
        expect(isOverflowPointer(native.body)).toBe(true)
        expect(isBinaryPointer(native.scan)).toBe(true)
      }),
    ),
  )

  it.effect("index queries: projections, limit and filterBy bound what is fetched", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        for (const id of ["q-1", "q-2", "q-3"]) yield* shelve(id, "query")
        const query = () => db.entities.Shelved.byTitle({ title: "query" })

        let before = gets()
        const all = yield* query().collect()
        expect(all.map((doc) => doc.docId)).toEqual(["q-1", "q-2", "q-3"])
        for (const doc of all) expect(doc.body).toEqual(BODY)
        expect(gets()).toBe(before + 3)

        before = gets()
        const ids = yield* query().select(["docId", "title"]).collect()
        expect(ids).toHaveLength(3)
        expect(gets()).toBe(before)

        before = gets()
        const two = yield* query().limit(2).collect()
        expect(two).toHaveLength(2)
        expect(gets()).toBe(before + 2)

        before = gets()
        const lazy = yield* query()
          .offloaded("lazy")
          .filterBy((doc) => doc.docId !== "q-2")
          .collect()
        expect(lazy).toHaveLength(2)
        expect(gets()).toBe(before)
        expect(yield* lazy[0]!.body!.read()).toEqual(BODY)

        before = gets()
        const named = yield* query().select(["docId", "body"]).collect()
        for (const row of named) expect(row.body).toEqual(BODY)
        expect(gets()).toBe(before + 3)

        before = gets()
        const scanned = yield* db.entities.Shelved.scan()
          .filter({ title: "query" })
          .offloaded({ binary: "eager" })
          .collect()
        expect(scanned).toHaveLength(3)
        for (const doc of scanned) expect(doc.scan).toEqual(SCAN)
        expect(gets()).toBe(before + 6)
      }),
    ),
  )

  it.effect("Batch.get and transactGet read each get in its own modes", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        yield* shelve("g-1", "batch")
        yield* shelve("g-2", "batch")
        let before = gets()
        const [first, second] = yield* Batch.get([
          db.entities.Shelved.get({ docId: "g-1" }),
          db.entities.Shelved.get({ docId: "g-2" }).offloaded("lazy"),
        ])
        expect(first!.body).toEqual(BODY)
        expect(Offload.isOffloadedValue(second!.body)).toBe(true)
        expect(gets()).toBe(before + 1)

        before = gets()
        const [eager] = yield* Transaction.transactGet([
          db.entities.Shelved.get({ docId: "g-1" }).offloaded("eager"),
        ])
        expect(eager!.scan).toEqual(SCAN)
        expect(gets()).toBe(before + 2)
      }),
    ),
  )

  it.effect("versions, tombstones and stream images resolve their pointers per mode", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        const key = { docId: "k-2" }
        yield* db.entities.Kept.put({ ...key, title: "v1", body: BODY, scan: SCAN })
        yield* db.entities.Kept.update(key).set({ title: "v2" })
        const versions = yield* db.entities.Kept.versions(key).collect()
        expect(versions.map((v) => v.title)).toContain("v1")
        for (const v of versions) expect(v.body).toEqual(BODY)
        const lazyVersions = yield* db.entities.Kept.versions(key).offloaded("lazy").collect()
        for (const v of lazyVersions) expect(Offload.isOffloadedValue(v.body)).toBe(true)

        const image = yield* liveDoc("kept", "k-2")
        yield* db.entities.Kept.delete(key)
        const tombstone = yield* db.entities.Kept.deleted.get(key)
        expect(tombstone.body).toEqual(BODY)
        expect(yield* tombstone.scan!.read()).toEqual(SCAN)

        // A stream image decodes lazily by default, eagerly on request.
        const before = gets()
        const lazy = yield* Entity.decodeMarshalledItem(Kept, image)
        expect(gets()).toBe(before)
        expect(yield* lazy.body!.read()).toEqual(BODY)
        const eager = yield* Entity.decodeMarshalledItem(Kept, image, { offloaded: "eager" })
        expect(eager.scan).toEqual(SCAN)
        expect(eager.title).toBe("v2")
      }),
    ),
  )

  it.effect("Batch.write uploads every put before sending; DynamoDB's answer settles them", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Docs.put({ docId: "w-3", title: "t", body: text(2_000) })
        const before = blobs.inspect().calls
        yield* Batch.write([
          db.entities.Docs.put({ docId: "w-1", title: "t", body: text(2_000), scan: bytes(3) }),
          Docs.put({ docId: "w-2", title: "t", notes: text(3_000) }),
          db.entities.Docs.delete({ docId: "w-3" }),
        ])
        expect(isOverflowPointer((yield* liveDoc("doc", "w-1")).body)).toBe(true)
        expect(isBinaryPointer((yield* liveDoc("doc", "w-1")).scan)).toBe(true)
        expect(isOverflowPointer((yield* liveDoc("doc", "w-2")).notes)).toBe(true)
        // Processed: committed, nothing deleted (w-3's version is the reaper's).
        expect(blobs.inspect().calls.put - before.put).toBe(3)
        expect(blobs.inspect().calls.delete - before.delete).toBe(0)
        const [one, two] = yield* Batch.get([
          db.entities.Docs.get({ docId: "w-1" }).offloaded("eager"),
          db.entities.Docs.get({ docId: "w-2" }),
        ])
        expect(one).toMatchObject({ body: text(2_000), scan: bytes(3) })
        expect(two!.notes).toEqual(text(3_000))
      }),
    ),
  )

  it.effect(
    "transactWrite: a committed transaction keeps its uploads; a cancelled one deletes them",
    () =>
      provide(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Docs.put({ docId: "x-1", title: "t" })
          yield* Transaction.transactWrite([
            db.entities.Docs.put({ docId: "x-2", title: "t", body: text(2_000) }),
            db.entities.Docs.update({ docId: "x-1" }).set({ notes: text(2_500) }),
          ])
          expect(isOverflowPointer((yield* liveDoc("doc", "x-1")).notes)).toBe(true)
          expect((yield* db.entities.Docs.get({ docId: "x-2" })).body).toEqual(text(2_000))
          const kept = blobs.inspect().versions.length
          const before = blobs.inspect().calls

          const error = yield* Effect.flip(
            Transaction.transactWrite([
              db.entities.Docs.put({ docId: "x-3", title: "t", body: text(2_000) }),
              db.entities.Docs.update({ docId: "x-1" }).set({ notes: text(2_600) }),
              // x-2 exists: DynamoDB cancels the transaction.
              db.entities.Docs.create({ docId: "x-2", title: "t", scan: bytes(4) }),
            ]),
          )
          expect(error._tag).toBe("TransactionCancelled")
          expect(blobs.inspect().calls.put - before.put).toBe(3)
          expect(blobs.inspect().calls.delete - before.delete).toBe(1)
          expect(blobs.inspect().versions).toHaveLength(kept)
          expect((yield* db.entities.Docs.get({ docId: "x-1" })).notes).toEqual(text(2_500))
        }),
      ),
  )

  describe("aggregates (§6.9, §8.4)", () => {
    const albumPartition = (albumId: string) =>
      partition(composeCollectionKey(AppSchema, "album", [albumId]))
    const edgeRows = (albumId: string, type: string) =>
      Effect.map(albumPartition(albumId), (items) =>
        items.filter((item) => item.__edd_e__?.S === type),
      )
    const seed = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const db = yield* client
        for (const [i, docId] of ids.entries()) {
          yield* db.entities.AlbumDocs.put({
            docId,
            title: `doc ${docId}`,
            body: text(2_000 + i),
            scan: bytes(3, i + 1),
          })
        }
      })

    it.effect(
      "create hydrates offloading edges eagerly and re-uploads them under each edge item",
      () =>
        provide(
          Effect.gen(function* () {
            const db = yield* client
            yield* seed(["ag-1", "ag-2", "ag-3"])
            const entityKeys = new Set(blobs.inspect().versions.map((v) => v.ref.key))
            const before = blobs.inspect().calls
            yield* db.aggregates.Albums.create({
              albumId: "al-1",
              owner: "o-1",
              title: "Holiday",
              coverId: "ag-1",
              page: { label: "Beach", docs: ["ag-2", "ag-3"] },
            } as never)
            // Each doc's two values read once (eager), uploaded again for its edge item.
            expect(blobs.inspect().calls.get - before.get).toBe(6)
            expect(blobs.inspect().calls.put - before.put).toBe(6)
            const edges = [
              ...(yield* edgeRows("al-1", "AlbumCover")),
              ...(yield* edgeRows("al-1", "AlbumDoc")),
            ]
            expect(edges).toHaveLength(3)
            for (const row of edges) {
              expect(isOverflowPointer(row.body)).toBe(true)
              expect(isBinaryPointer(row.scan)).toBe(true)
              const pointer = BlobPointer.decodeText(row.scan!.S!)
              expect(typeof pointer === "object" && !entityKeys.has(pointer!.ref.key)).toBe(true)
            }

            // Reads resolve both kinds eagerly: one GET per pointer.
            const reads = blobs.inspect().calls.get
            const album = yield* db.aggregates.Albums.get({ albumId: "al-1" })
            expect(blobs.inspect().calls.get - reads).toBe(6)
            expect(album.cover).toMatchObject({ body: text(2_000), scan: bytes(3, 1) })
            expect(album.page.docs.map((d) => d.scan)).toEqual([bytes(3, 2), bytes(3, 3)])
            const listed = yield* db.aggregates.Albums.list({ owner: "o-1" })
            expect(listed.data.map((a) => a.page.docs[1]!.body)).toEqual([text(2_002)])
          }),
        ),
    )

    it.effect("update rewrites, and re-uploads, only the changed rows (#168)", () =>
      provide(
        Effect.gen(function* () {
          const db = yield* client
          yield* seed(["au-1", "au-2"])
          yield* db.aggregates.Albums.create({
            albumId: "al-2",
            owner: "o-2",
            title: "Trip",
            coverId: "au-1",
            page: { label: "Hills", docs: ["au-2"] },
          } as never)
          const page = (yield* edgeRows("al-2", "AlbumDoc"))[0]!
          let before = blobs.inspect().calls
          // A root-only change rewrites the root alone: the cover's values aren't uploaded again.
          yield* db.aggregates.Albums.update({ albumId: "al-2" }, ({ state }) => ({
            ...state,
            title: "Road trip",
          }))
          expect(blobs.inspect().calls.put - before.put).toBe(0)
          // The page's own row changes; its doc row doesn't, so it keeps its pointers.
          before = blobs.inspect().calls
          yield* db.aggregates.Albums.update({ albumId: "al-2" }, ({ state }) => ({
            ...state,
            page: { ...state.page, label: "Mountains" },
          }))
          expect(blobs.inspect().calls.put - before.put).toBe(0)
          expect((yield* edgeRows("al-2", "AlbumDoc"))[0]!.scan).toEqual(page.scan)

          // A doc's change re-uploads that row's values (no read pointer is reused).
          before = blobs.inspect().calls
          yield* db.aggregates.Albums.update({ albumId: "al-2" }, ({ state }) => ({
            ...state,
            page: {
              ...state.page,
              docs: state.page.docs.map((doc) => ({ ...doc, scan: bytes(3, 9) })),
            },
          }))
          expect(blobs.inspect().calls.put - before.put).toBe(2)
          const rewritten = (yield* edgeRows("al-2", "AlbumDoc"))[0]!
          expect(rewritten.scan).not.toEqual(page.scan)
          const album = yield* db.aggregates.Albums.get({ albumId: "al-2" })
          expect(album.title).toBe("Road trip")
          expect(album.page.label).toBe("Mountains")
          expect(album.page.docs[0]).toMatchObject({ body: text(2_001), scan: bytes(3, 9) })
        }),
      ),
    )

    it.effect(
      "a many element holding some of the target's offloaded fields fetches only those; one holding none needs no store",
      () => {
        class DocScan extends Schema.Class<DocScan>("DocScan")({
          docId: Schema.String,
          title: Schema.String,
          scan: Schema.optional(Schema.Uint8Array),
        }) {}
        class DocTitle extends Schema.Class<DocTitle>("DocTitle")({
          docId: Schema.String,
          title: Schema.String,
        }) {}
        const shelfOf = (element: Schema.Top, name: string) =>
          Aggregate.make(Schema.Struct({ shelfId: Schema.String, docs: Schema.Array(element) }), {
            table: MainTable,
            schema: AppSchema,
            pk: { field: "pk", composite: ["shelfId"] },
            collection: { name },
            root: { entityType: `${name}Item` },
            edges: {
              docs: Aggregate.many("docs", {
                entityType: `${name}Doc`,
                entity: AlbumDocs,
                sk: { composite: ["docId"] },
              }),
            },
          }) as unknown as {
            readonly create: (input: unknown) => Effect.Effect<any, any, any>
            readonly get: (key: unknown) => Effect.Effect<any, any, any>
          }
        const Scans = shelfOf(DocScan, "ScanShelf")
        const Titles = shelfOf(DocTitle, "TitleShelf")
        const docRows = (shelf: string, type: string) =>
          Effect.map(partition(composeCollectionKey(AppSchema, shelf, ["sh-1"])), (items) =>
            items.filter((item) => item.__edd_e__?.S === type),
          )
        return Effect.gen(function* () {
          yield* provide(seed(["as-1", "as-2"]))
          const before = blobs.inspect().calls
          // The scan only: one GET and one upload per doc; the body is never read.
          const created = yield* provide(Scans.create({ shelfId: "sh-1", docs: ["as-1", "as-2"] }))
          expect(blobs.inspect().calls.get - before.get).toBe(2)
          expect(blobs.inspect().calls.put - before.put).toBe(2)
          expect(created.docs.map((d: DocScan) => d.scan)).toEqual([bytes(3, 1), bytes(3, 2)])
          const rows = yield* provide(docRows("scanshelf", "ScanShelfDoc"))
          expect(rows).toHaveLength(2)
          for (const row of rows) {
            expect(isBinaryPointer(row.scan)).toBe(true)
            expect(row.body).toBeUndefined()
          }
          const read = yield* provide(Scans.get({ shelfId: "sh-1" }))
          expect(read.docs.map((d: DocScan) => d.scan)).toEqual([bytes(3, 1), bytes(3, 2)])

          // No offloaded field at all: no fetch, and no store in context.
          const calls = blobs.inspect().calls
          const noStore = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))
          const titles = yield* Titles.create({ shelfId: "sh-1", docs: ["as-1"] }).pipe(
            Effect.provide(noStore),
          )
          expect(titles.docs).toEqual([{ docId: "as-1", title: "doc as-1" }])
          expect(blobs.inspect().calls.get).toBe(calls.get)
          expect(
            (yield* Titles.get({ shelfId: "sh-1" }).pipe(Effect.provide(noStore))).docs,
          ).toEqual([{ docId: "as-1", title: "doc as-1" }])
        })
      },
    )

    it.effect("a create over an existing aggregate deletes its uploads (DynamoDB cancels it)", () =>
      provide(
        Effect.gen(function* () {
          const db = yield* client
          yield* seed(["ac-1", "ac-2"])
          const input = {
            albumId: "al-3",
            owner: "o-3",
            title: "Once",
            coverId: "ac-1",
            page: { label: "Only", docs: ["ac-2"] },
          }
          yield* db.aggregates.Albums.create(input as never)
          const kept = blobs.inspect().versions.length
          const before = blobs.inspect().calls
          const error = yield* Effect.flip(db.aggregates.Albums.create(input as never))
          expect(error._tag).toBe("ConditionalCheckFailed")
          expect(blobs.inspect().calls.put - before.put).toBe(4)
          expect(blobs.inspect().versions).toHaveLength(kept)
        }),
      ),
    )
  })

  describe("binary inputs (§3.8, §7)", () => {
    const content = Uint8Array.from({ length: 40 }, (_, i) => (i * 13) % 256)
    const chunked = (bytes: Uint8Array, size: number) => {
      const chunks: Array<Uint8Array> = []
      for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size))
      return Stream.fromIterable(chunks)
    }
    const causeOf = <A, E>(exit: Exit.Exit<A, E>): string => {
      if (Exit.isSuccess(exit)) throw new Error("expected a failure")
      const error = Cause.findErrorOption(exit.cause)
      return Option.isSome(error)
        ? `${String(error.value)} ${String((error.value as any).cause)}`
        : ""
    }

    it.effect(
      "a stream uploads multipart; its pointer has the bytes' checksum and reads back",
      () => {
        blobs = BlobStore.memory({ partSize: 8, uploadConcurrency: 2 })
        return provide(
          Effect.gen(function* () {
            const db = yield* client
            yield* db.entities.Docs.put({ docId: "st-1", title: "t", scan: chunked(content, 7) })
            const row = yield* liveDoc("doc", "st-1")
            expect(isBinaryPointer(row.scan)).toBe(true)
            const pointer = BlobPointer.decodeText(row.scan!.S!)
            if (pointer === undefined || typeof pointer === "string") throw new Error("no pointer")
            expect(pointer.checksum.value).toEqual(crc64nvme(content))
            expect(blobs.inspect().multipart).toMatchObject({ creates: 1, parts: 5, completes: 1 })
            const read = yield* db.entities.Docs.get({ docId: "st-1" }).offloaded("eager")
            expect(read.scan).toEqual(content)
          }),
        )
      },
    )

    it.effect("a stream is single-use: a later operation reusing it is refused (EDD-9120)", () =>
      provide(
        Effect.gen(function* () {
          const db = yield* client
          const source = chunked(content, 10)
          yield* db.entities.Docs.put({ docId: "st-2", title: "t", scan: source })
          const exit = yield* Effect.exit(
            db.entities.Docs.put({ docId: "st-3", title: "t", scan: source }).asEffect(),
          )
          expect(causeOf(exit)).toMatch(/\[EDD-9120\].*single-use/)
          expect(yield* rawItem("$offload-ent#v1#doc#docid_st-3", "$offload-ent#v1#doc")).toBe(
            undefined,
          )
          expect(blobs.inspect().calls.put).toBe(1)
        }),
      ),
    )

    it.effect("a source failure fails the write with SourceFailed; nothing is written", () =>
      provide(
        Effect.gen(function* () {
          const db = yield* client
          const source = Stream.concat(chunked(content, 10), Stream.fail("gone"))
          const exit = yield* Effect.exit(
            db.entities.Docs.put({ docId: "st-4", title: "t", scan: source }).asEffect(),
          )
          expect(causeOf(exit)).toMatch(/SourceFailed/)
          expect(yield* rawItem("$offload-ent#v1#doc#docid_st-4", "$offload-ent#v1#doc")).toBe(
            undefined,
          )
          expect(blobs.inspect().versions).toEqual([])
        }),
      ),
    )

    it.effect("a BlobHandle input is copied into a new version of the new item's key", () =>
      provide(
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Docs.put({ docId: "st-5", title: "t", scan: content })
          const handle = (yield* db.entities.Docs.get({ docId: "st-5" })).scan!
          yield* db.entities.Docs.put({
            docId: "st-6",
            title: "t",
            scan: Offload.isBlobHandle(handle) ? handle : content,
          })
          expect(blobs.inspect().calls.copy).toBe(1)
          const read = yield* db.entities.Docs.get({ docId: "st-6" }).offloaded("eager")
          expect(read.scan).toEqual(content)
          const keys = new Set(blobs.inspect().versions.map((v) => v.ref.key))
          expect(keys.size).toBe(2)
        }),
      ),
    )
  })
})
