/**
 * Entity writes of offloaded fields against DynamoDB Local (#179, design §6):
 * the stored pointers, settlement by DynamoDB's real answers (`ALL_OLD` on a
 * refused create, `ALL_NEW` after an upsert's `if_not_exists`, a cancelled
 * time-series append), the item-size retry on DynamoDB's own 400 KB
 * rejection, and lifecycle copies. Objects go to the in-memory blob store
 * (the S3 store and MinIO are later commits'); reads of offloaded fields are
 * commit 8's, so rows are inspected as stored.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest"
import { BlobStore } from "../src/BlobStore.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
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

const Docs = withOffloadGate(() =>
  Entity.make({ model: docModel(1_024), entityType: "Doc", primaryKey: docKey }),
)

/** Thresholds out of reach: the item budget routes. */
const Budgeted = withOffloadGate(() =>
  Entity.make({
    model: docModel(400_000),
    entityType: "Budgeted",
    primaryKey: docKey,
    offload: { itemBudget: 300_000 },
  }),
)

const Kept = withOffloadGate(() =>
  Entity.make({
    model: docModel(1_024),
    entityType: "Kept",
    primaryKey: docKey,
    versioned: { retain: true },
    softDelete: true,
  }),
)

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  at: Schema.Number,
  raw: Schema.optional(Schema.Uint8Array),
}) {}

const Readings = withOffloadGate(() =>
  Entity.make({
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
  }),
)

const MainTable = Table.make({ schema: AppSchema, entities: { Docs, Budgeted, Kept, Readings } })

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
  entities: { Docs, Budgeted, Kept, Readings },
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

describeConnected("Entity offloaded writes (#179)", () => {
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
        expect(result.body).toEqual(doc.body)
        expect(result.scan).toEqual(doc.scan)
        expect(blobs.inspect().calls).toMatchObject({ put: 2, get: 0 })
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
        expect(result.body).toEqual(doc.body)
        expect(result.scan).toEqual(doc.scan)
        expect(blobs.inspect().calls).toMatchObject({ put: 2, get: 0, delete: 0 })
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
        expect(current.raw).toEqual(bytes(64))
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
})
