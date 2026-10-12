/**
 * Connected integration tests for packed ENTITY fields (#147):
 * `DynamoModel.configure(model, { field: { storedAs: DynamoModel.Packed(...) } })`
 * against a real DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * Covers, end to end:
 *   - put / get / query round-trips with json, json + gzip and json + zstd, under
 *     and over the threshold, and the stored forms (S / B with its header).
 *   - The same item written native, then JSON, then compressed — the field's
 *     config changed between writes — read back each time by every config
 *     (map → packed migration, and packed → native rollback).
 *   - update().set / .remove of a packed field; conditions on the whole field;
 *     whole-field projections returning parsed JSON.
 *   - Batch.write / Batch.get and Transaction.transactWrite / transactGet.
 *   - Version snapshots (retain), soft delete + restore, time-series append +
 *     history.
 *   - A ~600 KB-as-JSON value that compresses under the 400 KB item limit is
 *     accepted; stored uncompressed it is rejected (diagnosed, stored bytes).
 *   - An aggregate edge whose entity has a packed field.
 *   - Entity.decodeMarshalledItem on a raw item rewritten into Lambda's
 *     DynamoDB-JSON shape (base64 B).
 *   - CompressorNotRegistered on a read without the codec.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { CompressorNotRegistered, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Config, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import * as NodeCompression from "../src/compression/node.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
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

const AppSchema = DynamoSchema.make({ name: "packed-ent", version: 1 })
const tableName = `packed-entity-${Date.now()}`

class Line extends Schema.Class<Line>("Line")({ sku: Schema.String, qty: Schema.Number }) {}

const Details = Schema.Struct({
  note: Schema.String,
  placedAt: Schema.DateTimeUtc,
})

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  customerId: Schema.String,
  status: Schema.String,
  lines: Schema.Array(Line),
  details: Schema.optional(Details),
}) {}

const json = DynamoModel.Packed({ format: "json" })
const gzip = DynamoModel.Packed({ format: "json", compression: { codec: "gzip" } })
const zstd = DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } })

const orderKeys = {
  primaryKey: {
    pk: { field: "pk", composite: ["orderId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCustomer: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["customerId"] },
      sk: { field: "gsi1sk", composite: ["status"] },
    },
  },
} as const

/** The packed configuration under test: `lines` gzip, `details` zstd stored as `d`. */
const Orders = Entity.make({
  model: DynamoModel.configure(Order, {
    lines: { storedAs: gzip },
    details: { field: "d", storedAs: zstd },
  }),
  entityType: "Order",
  ...orderKeys,
})
/** The same entity before packing was configured. */
const NativeOrders = Entity.make({
  model: DynamoModel.configure(Order, { details: { field: "d" } }),
  entityType: "Order",
  ...orderKeys,
})
/** The same entity packed as JSON only. */
const JsonOrders = Entity.make({
  model: DynamoModel.configure(Order, {
    lines: { storedAs: json },
    details: { field: "d", storedAs: json },
  }),
  entityType: "Order",
  ...orderKeys,
})

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.Struct({ text: Schema.String }),
}) {}

const Docs = Entity.make({
  model: DynamoModel.configure(Doc, {
    body: {
      storedAs: DynamoModel.Packed({
        format: "json",
        compression: { codec: "zstd", threshold: 0 },
      }),
    },
  }),
  entityType: "Doc",
  primaryKey: {
    pk: { field: "pk", composite: ["docId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: { retain: true },
  softDelete: true,
})

class Reading extends Schema.Class<Reading>("Reading")({
  deviceId: Schema.String,
  at: Schema.String,
  payload: Schema.Struct({ values: Schema.Array(Schema.Number) }),
}) {}

const Readings = Entity.make({
  model: DynamoModel.configure(Reading, {
    payload: {
      storedAs: DynamoModel.Packed({
        format: "json",
        compression: { codec: "gzip", threshold: 0 },
      }),
    },
  }),
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      deviceId: Schema.String,
      at: Schema.String,
      payload: Schema.Struct({ values: Schema.Array(Schema.Number) }),
    }),
  },
})

class Blob extends Schema.Class<Blob>("Blob")({
  blobId: Schema.String,
  content: Schema.Struct({ rows: Schema.Array(Schema.String) }),
}) {}

const blobKey = {
  pk: { field: "pk", composite: ["blobId"] },
  sk: { field: "sk", composite: [] },
} as const
const ZstdBlobs = Entity.make({
  model: DynamoModel.configure(Blob, { content: { storedAs: zstd } }),
  entityType: "Blob",
  primaryKey: blobKey,
})
const JsonBlobs = Entity.make({
  model: DynamoModel.configure(Blob, { content: { storedAs: json } }),
  entityType: "Blob",
  primaryKey: blobKey,
})

class Venue extends Schema.Class<Venue>("Venue")({
  venueId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
  layout: Schema.Struct({ stands: Schema.Array(Schema.String), capacity: Schema.Number }),
}) {}

const Venues = Entity.make({
  model: DynamoModel.configure(Venue, { layout: { storedAs: gzip } }),
  entityType: "Venue",
  primaryKey: {
    pk: { field: "pk", composite: ["venueId"] },
    sk: { field: "sk", composite: [] },
  },
})

class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  name: Schema.String,
  venue: Venue,
}) {}

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Orders, Docs, Readings, ZstdBlobs, Venues },
})
/** Alternate configurations of the same entity types, over the same physical table. */
const NativeTable = Table.make({ schema: AppSchema, entities: { NativeOrders } })
const JsonTable = Table.make({ schema: AppSchema, entities: { JsonOrders, JsonBlobs } })

const Matches = Aggregate.make(Match, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "match" },
  root: { entityType: "MatchItem" },
  edges: {
    venue: Aggregate.one("venue", { entityType: "MatchVenue", entity: Venues }),
  },
})

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials,
  compressors: [NodeCompression.gzip(), NodeCompression.zstd()],
})
const BareClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const Tables = Layer.mergeAll(
  MainTable.layer({ name: tableName }),
  NativeTable.layer({ name: tableName }),
  JsonTable.layer({ name: tableName }),
)
const provide = Effect.provide(Layer.mergeAll(ClientLayer, Tables))
const provideBare = Effect.provide(Layer.mergeAll(BareClientLayer, Tables))

const client = DynamoClient.make({
  entities: { Orders, Docs, Readings, ZstdBlobs, Venues },
  aggregates: { Matches },
  tables: { MainTable },
})
const nativeClient = DynamoClient.make({
  entities: { NativeOrders },
  tables: { NativeTable },
})
const jsonClient = DynamoClient.make({
  entities: { JsonOrders, JsonBlobs },
  tables: { JsonTable },
})

/** The raw stored live item whose partition key ends in `_<id>`. */
const rawItem = (entity: string, id: string, composite = `${entity}id`) =>
  Effect.gen(function* () {
    const raw = yield* DynamoClient
    const result = yield* raw.getItem({
      TableName: tableName,
      Key: toAttributeMap({
        pk: `$packed-ent#v1#${entity}#${composite}_${id}`.toLowerCase(),
        sk: `$packed-ent#v1#${entity}`.toLowerCase(),
      }),
      ConsistentRead: true,
    })
    return result.Item as Record<string, AttributeValue> | undefined
  })

const formOf = (value: AttributeValue | undefined) =>
  value === undefined
    ? "absent"
    : value.M !== undefined
      ? "M"
      : value.L !== undefined
        ? "L"
        : value.S !== undefined
          ? "S"
          : `B${value.B![0]}`

const placedAt = DateTime.makeUnsafe("2026-10-11T08:00:00.000Z")
const LONG = "the quick brown fox jumps over the lazy dog; ".repeat(40)
const manyLines = Array.from({ length: 60 }, (_, i) => new Line({ sku: `SKU-${i % 7}`, qty: i }))
const twoLines = [new Line({ sku: "A", qty: 1 }), new Line({ sku: "B", qty: 2 })]

const order = (orderId: string, overrides: Partial<Order> = {}) =>
  new Order({
    orderId,
    customerId: "cust-1",
    status: "open",
    lines: manyLines,
    details: { note: LONG, placedAt },
    ...overrides,
  })

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (reason === undefined || reason._tag !== "Fail") throw new Error("expected a Fail reason")
  return reason.error
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("Entity packed fields (#147)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* client
        yield* db.tables.MainTable.create()
      }).pipe(provide),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const raw = yield* DynamoClient
        yield* raw.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect("put / get round-trip: gzip and zstd over the threshold store B, under it S", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order("o-big"))
      yield* db.entities.Orders.put(
        order("o-small", { lines: twoLines, details: { note: "hi", placedAt } }),
      )
      const big = (yield* rawItem("order", "o-big"))!
      expect(formOf(big.lines)).toBe("B33") // gzip
      expect(formOf(big.d)).toBe("B35") // zstd, under the renamed attribute
      expect(big.details).toBeUndefined()
      const small = (yield* rawItem("order", "o-small"))!
      expect(formOf(small.lines)).toBe("S")
      expect(formOf(small.d)).toBe("S")

      expect(yield* db.entities.Orders.get({ orderId: "o-big" })).toEqual(order("o-big"))
      expect((yield* db.entities.Orders.get({ orderId: "o-small" })).lines).toEqual(twoLines)
      const native = yield* Entity.asNative(Orders.get({ orderId: "o-big" }))
      expect(native.d?.B).toBeInstanceOf(Uint8Array)
    }).pipe(provide),
  )

  it.effect("map → JSON → compressed → native: every config reads every stored form", () =>
    Effect.gen(function* () {
      const db = yield* client
      const nativeDb = yield* nativeClient
      const jsonDb = yield* jsonClient
      const expected = order("o-mig")

      // 1. Written before packing: native list + map.
      yield* nativeDb.entities.NativeOrders.put(expected)
      let stored = (yield* rawItem("order", "o-mig"))!
      expect([formOf(stored.lines), formOf(stored.d)]).toEqual(["L", "M"])
      expect(yield* db.entities.Orders.get({ orderId: "o-mig" })).toEqual(expected)
      expect(yield* jsonDb.entities.JsonOrders.get({ orderId: "o-mig" })).toEqual(expected)

      // 2. Rewritten as JSON.
      yield* jsonDb.entities.JsonOrders.put(expected)
      stored = (yield* rawItem("order", "o-mig"))!
      expect([formOf(stored.lines), formOf(stored.d)]).toEqual(["S", "S"])
      expect(yield* db.entities.Orders.get({ orderId: "o-mig" })).toEqual(expected)
      expect(yield* nativeDb.entities.NativeOrders.get({ orderId: "o-mig" })).toEqual(expected)

      // 3. Rewritten compressed.
      yield* db.entities.Orders.put(expected)
      stored = (yield* rawItem("order", "o-mig"))!
      expect([formOf(stored.lines), formOf(stored.d)]).toEqual(["B33", "B35"])
      // A reader that no longer packs still reads it (rollback needs no rewrite).
      expect(yield* nativeDb.entities.NativeOrders.get({ orderId: "o-mig" })).toEqual(expected)
      expect(yield* jsonDb.entities.JsonOrders.get({ orderId: "o-mig" })).toEqual(expected)
    }).pipe(provide),
  )

  it.effect("queries read a mix of stored forms; projections return parsed JSON", () =>
    Effect.gen(function* () {
      const db = yield* client
      const nativeDb = yield* nativeClient
      yield* nativeDb.entities.NativeOrders.put(order("q-1", { customerId: "cust-q" }))
      yield* db.entities.Orders.put(order("q-2", { customerId: "cust-q" }))
      yield* db.entities.Orders.put(
        order("q-3", { customerId: "cust-q", lines: twoLines, details: { note: "s", placedAt } }),
      )
      const all = yield* db.entities.Orders.byCustomer({ customerId: "cust-q" }).collect()
      expect(all.map((o) => o.orderId).sort()).toEqual(["q-1", "q-2", "q-3"])
      expect(all.find((o) => o.orderId === "q-1")!.lines).toEqual(manyLines)

      const rows = yield* db.entities.Orders.byCustomer({ customerId: "cust-q" })
        .select(["orderId", "lines", "details"])
        .collect()
      const q2 = rows.find((row) => row.orderId === "q-2")!
      expect(q2.lines).toEqual(manyLines.map((l) => ({ sku: l.sku, qty: l.qty })))
      expect(q2.details).toEqual({ note: LONG, placedAt: "2026-10-11T08:00:00.000Z" })

      const withDetails = yield* db.entities.Orders.byCustomer({ customerId: "cust-q" })
        .filter((t, { exists }) => exists(t.details))
        .collect()
      expect(withDetails).toHaveLength(3)
      expect(() =>
        db.entities.Orders.byCustomer({ customerId: "cust-q" }).filter({ lines: [] }),
      ).toThrow(/\[EDD-9076\]/)
    }).pipe(provide),
  )

  it.effect("update().set writes the packed value whole; .remove drops it", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order("u-1", { details: { note: "short", placedAt } }))
      expect(formOf((yield* rawItem("order", "u-1"))!.d)).toBe("S")
      yield* db.entities.Orders.update({ orderId: "u-1" })
        .set({ details: { note: LONG, placedAt } })
        .condition((t, { exists }) => exists(t.lines))
      expect(formOf((yield* rawItem("order", "u-1"))!.d)).toBe("B35")
      expect((yield* db.entities.Orders.get({ orderId: "u-1" })).details?.note).toBe(LONG)
      yield* db.entities.Orders.update({ orderId: "u-1" }).remove(["details"])
      expect((yield* rawItem("order", "u-1"))!.d).toBeUndefined()
      const refused = failure(
        yield* Effect.exit(
          db.entities.Orders.update({ orderId: "u-1" }).add({ lines: 1 }).asEffect(),
        ),
      )
      expect(String((refused as ValidationError).cause)).toMatch(/\[EDD-9077\]/)
    }).pipe(provide),
  )

  it.effect("Batch.write / Batch.get and transactWrite / transactGet", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* Batch.write([
        db.entities.Orders.put(order("b-1")),
        db.entities.Orders.put(order("b-2", { lines: twoLines })),
      ])
      expect(formOf((yield* rawItem("order", "b-1"))!.lines)).toBe("B33")
      const [b1, b2] = yield* Batch.get([
        db.entities.Orders.get({ orderId: "b-1" }),
        db.entities.Orders.get({ orderId: "b-2" }),
      ])
      expect(b1?.lines).toEqual(manyLines)
      expect(b2?.lines).toEqual(twoLines)

      yield* Transaction.transactWrite([db.entities.Orders.put(order("t-1"))])
      expect(formOf((yield* rawItem("order", "t-1"))!.d)).toBe("B35")
      const [t1] = yield* Transaction.transactGet([db.entities.Orders.get({ orderId: "t-1" })])
      expect(t1?.details?.note).toBe(LONG)
    }).pipe(provide),
  )

  it.effect("retain snapshots, soft delete and restore copy stored values as-is", () =>
    Effect.gen(function* () {
      const db = yield* client
      const body = { text: LONG }
      yield* db.entities.Docs.put({ docId: "d-1", title: "v1", body })
      const live = (yield* rawItem("doc", "d-1"))!
      expect(formOf(live.body)).toBe("B35")
      yield* db.entities.Docs.update({ docId: "d-1" }).set({ title: "v2" })
      const v1 = yield* db.entities.Docs.getVersion({ docId: "d-1" }, 1)
      expect(v1).toMatchObject({ title: "v1", body })
      const versions = yield* db.entities.Docs.versions({ docId: "d-1" }).collect()
      expect(versions.map((v) => v.body)).toEqual([body])
      // The live item's body was not rewritten by the title-only update.
      expect((yield* rawItem("doc", "d-1"))!.body?.B).toEqual(live.body?.B)

      yield* db.entities.Docs.delete({ docId: "d-1" })
      const tombstone = yield* db.entities.Docs.deleted.get({ docId: "d-1" })
      expect(tombstone.body).toEqual(body)
      const restored = yield* db.entities.Docs.restore({ docId: "d-1" })
      expect(restored).toMatchObject({ title: "v2", body })
      expect((yield* rawItem("doc", "d-1"))!.body?.B).toEqual(live.body?.B)
    }).pipe(provide),
  )

  it.effect("time-series append packs current and event items alike; history decodes", () =>
    Effect.gen(function* () {
      const db = yield* client
      const payload = (n: number) => ({ values: Array.from({ length: 80 }, (_, i) => i * n) })
      yield* db.entities.Readings.append({
        deviceId: "dev-1",
        at: "2026-10-11T01",
        payload: payload(1),
      })
      yield* db.entities.Readings.append({
        deviceId: "dev-1",
        at: "2026-10-11T02",
        payload: payload(2),
      })
      const current = (yield* rawItem("reading", "dev-1", "deviceid"))!
      expect(formOf(current.payload)).toBe("B33")
      expect((yield* db.entities.Readings.get({ deviceId: "dev-1" })).payload).toEqual(payload(2))
      const history = yield* db.entities.Readings.history({ deviceId: "dev-1" }).collect()
      expect(history.map((r) => r.payload)).toEqual([payload(1), payload(2)])
    }).pipe(provide),
  )

  it.effect(
    "a ~600 KB JSON value that compresses under 400 KB is accepted; uncompressed it is not",
    () =>
      Effect.gen(function* () {
        const db = yield* client
        const jsonDb = yield* jsonClient
        const content = {
          rows: Array.from({ length: 12_000 }, (_, i) => `row ${i % 50} — ${"payload ".repeat(5)}`),
        }
        expect(JSON.stringify(content).length).toBeGreaterThan(600_000)
        yield* db.entities.ZstdBlobs.put({ blobId: "huge", content })
        const stored = (yield* rawItem("blob", "huge"))!
        expect(formOf(stored.content)).toBe("B35")
        expect(stored.content!.B!.length).toBeLessThan(400 * 1024)
        expect((yield* db.entities.ZstdBlobs.get({ blobId: "huge" })).content).toEqual(content)

        const rejected = failure(
          yield* Effect.exit(
            jsonDb.entities.JsonBlobs.put({ blobId: "huge-json", content }).asEffect(),
          ),
        )
        expect(rejected).toBeInstanceOf(ValidationError)
        // The diagnosis measures the stored (JSON) bytes.
        expect(String((rejected as ValidationError).cause)).toMatch(/400 KB|409,600|item size/i)
      }).pipe(provide),
  )

  it.effect("an aggregate edge stores its entity's packed field packed", () =>
    Effect.gen(function* () {
      const db = yield* client
      const layout = {
        stands: Array.from({ length: 200 }, (_, i) => `Stand ${i % 8}`),
        capacity: 100_024,
      }
      yield* db.entities.Venues.put({ venueId: "mcg", name: "MCG", layout })
      yield* db.aggregates.Matches.create({
        matchId: "m-1",
        name: "Final",
        venueId: "mcg",
      } as never)
      const raw = yield* DynamoClient
      const partition = yield* raw.query({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: toAttributeMap({ ":pk": "$packed-ent#v1#match#m-1" }),
      })
      const edge = (partition.Items ?? []).find((item) => item.__edd_e__?.S === "MatchVenue")!
      expect(formOf(edge.layout)).toBe("B33")
      const match = yield* db.aggregates.Matches.get({ matchId: "m-1" })
      expect(match.venue.layout).toEqual(layout)
      const updated = yield* db.aggregates.Matches.update({ matchId: "m-1" }, ({ state }) => ({
        ...state,
        venue: { ...state.venue, layout: { ...layout, capacity: 1 } },
      }))
      expect(updated.venue.layout.capacity).toBe(1)
      expect((yield* db.aggregates.Matches.get({ matchId: "m-1" })).venue.layout.capacity).toBe(1)
    }).pipe(provide),
  )

  it.effect("decodeMarshalledItem reads a Lambda-shaped image (base64 B)", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order("img-1"))
      const image = (yield* rawItem("order", "img-1"))!
      const lambda = Object.fromEntries(
        Object.entries(image).map(([name, value]) => [
          name,
          value.B !== undefined ? { B: Buffer.from(value.B).toString("base64") } : value,
        ]),
      )
      const decoded = yield* Entity.decodeMarshalledItem(Orders, lambda)
      expect(decoded).toMatchObject({ orderId: "img-1", lines: manyLines })
      // Already unmarshalled (an EventBridge Pipes enrichment, say), B as base64.
      const unmarshalled = {
        ...fromAttributeMap(image),
        lines: Buffer.from(image.lines!.B!).toString("base64"),
      }
      expect(yield* Entity.decodeMarshalledItem(Orders, unmarshalled)).toEqual(decoded)
    }).pipe(provide),
  )

  it.effect("a read without the codec fails CompressorNotRegistered", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Orders.put(order("nc-1")).asEffect().pipe(provide)
      const error = failure(yield* Effect.exit(db.entities.Orders.get({ orderId: "nc-1" })))
      expect(error).toBeInstanceOf(CompressorNotRegistered)
      expect(error).toMatchObject({ direction: "decompress" })
    }).pipe(provideBare),
  )
})
