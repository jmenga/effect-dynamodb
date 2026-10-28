/**
 * #171 queries, aggregates and event streams over rows still under their 1.36
 * keys — connected tests against DynamoDB Local.
 *
 * Each test writes its rows as 1.36 did — written by 1.37, then rewritten
 * under the key text `KeyText136` composes (the composer the golden vectors
 * from the published 1.36.0 pin) with the raw client — next to rows under
 * their current keys, and runs a 1.37 read or write over them, asserting the
 * result (every row once, in the documented order) and where each row ends
 * up (never under both keys).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

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
// Models
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "legacy-queries", version: 1 })
const tableName = `legacy-queries-${Date.now()}`

class Reading extends Schema.Class<Reading>("Reading")({
  site: Schema.String,
  zone: Schema.Number,
  label: Schema.String,
  tag: Schema.String,
  seq: Schema.Number,
}) {}

class Alarm extends Schema.Class<Alarm>("Alarm")({
  alarmId: Schema.String,
  zone: Schema.Number,
  seq: Schema.Number,
}) {}

const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["site"] },
    sk: { field: "sk", composite: ["seq"] },
  },
  indexes: {
    byZone: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["zone"] },
      sk: { field: "gsi1sk", composite: ["label", "tag", "seq"] },
    },
    feed: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["zone"] },
      sk: { field: "gsi2sk", composite: ["seq"] },
      collection: "zoneFeed",
    },
  },
})

const Alarms = Entity.make({
  model: Alarm,
  entityType: "Alarm",
  primaryKey: {
    pk: { field: "pk", composite: ["alarmId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    feed: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["zone"] },
      sk: { field: "gsi2sk", composite: ["seq"] },
      collection: "zoneFeed",
    },
  },
})

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.Number,
  title: Schema.String,
}) {}

const Docs = Entity.make({
  model: Doc,
  entityType: "Doc",
  primaryKey: {
    pk: { field: "pk", composite: ["docId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: { retain: true },
  softDelete: true,
})

class Gauge extends Schema.Class<Gauge>("Gauge")({
  gaugeId: Schema.Number,
  at: Schema.Number,
  level: Schema.Number,
}) {}

const Gauges = Entity.make({
  model: Gauge,
  entityType: "Gauge",
  primaryKey: {
    pk: { field: "pk", composite: ["gaugeId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({ gaugeId: Schema.Number, at: Schema.Number, level: Schema.Number }),
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Readings, Alarms, Docs, Gauges } })

class Stop extends Schema.Class<Stop>("Stop")({
  label: Schema.String,
  note: Schema.String,
}) {}

class Route extends Schema.Class<Route>("Route")({
  id: Schema.Number,
  area: Schema.String,
  name: Schema.String,
  stops: Schema.Array(Stop),
}) {}

const Routes = Aggregate.make(Route, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "routes" },
  root: { entityType: "RouteItem" },
  edges: {
    stops: Aggregate.many("stops", { entityType: "RouteStop", sk: { composite: ["label"] } }),
  },
  list: {
    index: "gsi1",
    name: "routelist",
    pk: { field: "gsi1pk", composite: ["area"] },
    sk: { field: "gsi1sk", composite: ["id"] },
  },
})

// Listed by name: a list sort key composite outside the primary key.
const Lines = Aggregate.make(Route, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "lines" },
  root: { entityType: "LineItem" },
  edges: {
    stops: Aggregate.many("stops", { entityType: "LineStop", sk: { composite: ["label"] } }),
  },
  list: {
    index: "gsi1",
    name: "linelist",
    pk: { field: "gsi1pk", composite: ["area"] },
    sk: { field: "gsi1sk", composite: ["name"] },
  },
})

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}

const Ledger = EventStore.makeStream({
  table: MainTable,
  streamName: "Ledger",
  events: [Deposited],
  streamId: { composite: ["ledgerId"] },
})

/** Stream ids are typed as strings; a number — an untyped caller's — is the one whose text changed. */
const ledger = (id: number | string) =>
  ({ ledgerId: id }) as unknown as { readonly ledgerId: string }

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TestLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)

const makeDb = DynamoClient.make({
  entities: { Readings, Alarms, Docs, Gauges },
  tables: { MainTable },
})

// ---------------------------------------------------------------------------
// Rows as 1.36 wrote them
// ---------------------------------------------------------------------------

type Row = Record<string, AttributeValue>

const getRaw = (pk: string, sk: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Item } = yield* client.getItem({
      TableName: tableName,
      Key: { pk: { S: pk }, sk: { S: sk } },
      ConsistentRead: true,
    })
    return Item
  })

const partition = (pk: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Items = [] } = yield* client.query({
      TableName: tableName,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": { S: pk } },
      ConsistentRead: true,
    })
    return Items
  })

/** Replace the row at `row`'s key with `next`. */
const rewrite = (row: Row, next: Row) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.deleteItem({ TableName: tableName, Key: { pk: row.pk!, sk: row.sk! } })
    yield* client.putItem({ TableName: tableName, Item: next })
  })

/** The reading 1.37 wrote for `record`, rewritten under its 1.36 primary and GSI keys. */
const demoteReading = (record: Record<string, unknown>) =>
  Effect.gen(function* () {
    const current = KeyComposer.composeAllKeys(AppSchema, "Reading", 1, Readings.indexes, record)
    const old = KeyText136.composeAllKeys(AppSchema, "Reading", 1, Readings.indexes, record)
    const row = yield* getRaw(current.pk as string, current.sk as string)
    expect(row).toBeDefined()
    yield* rewrite(row!, { ...row!, ...toAttributeMap(old) })
    return { current, old }
  })

/** Every row of partition `from`, rewritten under partition `to`. */
const demotePartition = (from: string, to: string, change: (row: Row) => Row = (row) => row) =>
  Effect.gen(function* () {
    expect(to).not.toBe(from)
    const rows = yield* partition(from)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) yield* rewrite(row, change({ ...row, pk: { S: to } }))
    return rows.length
  })

const reading = (zone: number, label: string, tag: string, seq: number, site = `s${seq}`) => ({
  site,
  zone,
  label,
  tag,
  seq,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("#171 queries over rows still under their 1.36 keys — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
      }).pipe(provide),
    )
  }, 60_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 30_000)

  describe("entity accessors and collections", () => {
    /** Zone `zone`: readings 1 and 2 under their 1.36 keys, 3 and 4 under their current keys. */
    const seed = (zone: number) =>
      Effect.gen(function* () {
        const db = yield* makeDb
        for (const seq of [1, 2, 3, 4]) {
          yield* db.entities.Readings.put(reading(zone, "a b", "t", seq)).asEffect()
        }
        for (const seq of [1, 2]) yield* demoteReading(reading(zone, "a b", "t", seq))
        return db
      })

    it.effect("an accessor reads the 1.36 key, then the current key: each row once", () =>
      Effect.gen(function* () {
        const db = yield* seed(-3)
        const all = yield* db.entities.Readings.byZone({ zone: -3 }).collect()
        expect(all.map((r) => r.seq)).toEqual([1, 2, 3, 4])
        const reversed = yield* db.entities.Readings.byZone({ zone: -3 }).reverse().collect()
        expect(reversed.map((r) => r.seq)).toEqual([4, 3, 2, 1])
        const pinned = yield* db.entities.Readings.byZone({ zone: -3, label: "a b" }).collect()
        expect(pinned.map((r) => r.seq)).toEqual([1, 2, 3, 4])
        const eq = yield* db.entities.Readings.byZone({ zone: -3 })
          .where((t, { eq }) => eq(t.label, "a b"))
          .collect()
        expect(eq.map((r) => r.seq)).toEqual([1, 2, 3, 4])
        expect(yield* db.entities.Readings.byZone({ zone: -3 }).count()).toBe(4)
        // Documented: a range bound reads the current key only.
        const bounded = yield* db.entities.Readings.byZone({ zone: -3 })
          .where((t, { gte }) => gte(t.label, "a"))
          .collect()
        expect(bounded.map((r) => r.seq)).toEqual([3, 4])
      }).pipe(provide),
    )

    it.effect("pages carry the pass: every row once across both keys", () =>
      Effect.gen(function* () {
        const db = yield* seed(-4)
        for (const reverse of [false, true]) {
          const seen: Array<number> = []
          let cursor: string | null = null
          for (let page = 0; page < 10; page++) {
            const base = db.entities.Readings.byZone({ zone: -4 }).limit(1)
            const query = reverse ? base.reverse() : base
            const result: {
              readonly items: ReadonlyArray<Reading>
              readonly cursor: string | null
            } = yield* (cursor === null ? query : query.startFrom(cursor)).fetch()
            seen.push(...result.items.map((r) => r.seq))
            cursor = result.cursor
            if (cursor === null) break
          }
          expect(seen).toEqual(reverse ? [4, 3, 2, 1] : [1, 2, 3, 4])
        }
      }).pipe(provide),
    )

    it.effect("a current row the 1.36 condition also selects is left to the current key", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.entities.Readings.put(reading(5, "a", "b", 1)).asEffect()
        yield* db.entities.Readings.put(reading(5, "a#b", "x", 2)).asEffect()
        yield* demoteReading(reading(5, "a#b", "x", 2))
        const pinned = yield* db.entities.Readings.byZone({ zone: 5, label: "a#b" }).collect()
        expect(pinned.map((r) => [r.label, r.tag])).toEqual([["a#b", "x"]])
      }).pipe(provide),
    )

    it.effect("a collection reads its 1.36 partition", () =>
      Effect.gen(function* () {
        const db = yield* seed(-6)
        yield* db.entities.Alarms.put({ alarmId: "al-6", zone: -6, seq: 9 }).asEffect()
        const feed = (yield* db.collections.zoneFeed!({ zone: -6 }).collect()) as {
          readonly Readings: ReadonlyArray<Reading>
          readonly Alarms: ReadonlyArray<Alarm>
        }
        expect(feed.Readings.map((r) => r.seq)).toEqual([1, 2, 3, 4])
        expect(feed.Alarms.map((a) => a.alarmId)).toEqual(["al-6"])
      }).pipe(provide),
    )
  })

  describe("an item's history", () => {
    it.effect("time-series history reads both prefixes; the item moves on its next append", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const key = { gaugeId: -6 }
        for (const at of [1, 2]) {
          yield* db.entities.Gauges.append({ ...key, at, level: at }).asEffect()
        }
        const now = KeyComposer.composePk(AppSchema, "Gauge", Gauges.indexes.primary, key)
        const old = KeyText136.composePk(AppSchema, "Gauge", Gauges.indexes.primary, key)
        yield* demotePartition(now, old)
        const before = yield* db.entities.Gauges.history(key).collect()
        expect(before.map((e) => e.at)).toEqual([1, 2])
        yield* db.entities.Gauges.append({ ...key, at: 3, level: 3 }).asEffect()
        const after = yield* db.entities.Gauges.history(key).collect()
        expect(after.map((e) => e.at)).toEqual([1, 2, 3])
        const reversed = yield* db.entities.Gauges.history(key).reverse().collect()
        expect(reversed.map((e) => e.at)).toEqual([3, 2, 1])
        // The current item moved; its 1.36 events stay until rekey.
        const current = yield* db.entities.Gauges.get(key).asEffect()
        expect(current.at).toBe(3)
        expect((yield* partition(old)).map((row) => fromAttributeMap(row).at)).toEqual([1, 2])
      }).pipe(provide),
    )

    it.effect("versions and deleted.list read the 1.36 partition", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const key = { docId: -5 }
        yield* db.entities.Docs.put({ ...key, title: "v1" }).asEffect()
        yield* db.entities.Docs.update(key).set({ title: "v2" }).asEffect()
        yield* db.entities.Docs.delete(key).asEffect()
        const read = Effect.all({
          versions: db.entities.Docs.versions(key).collect(),
          tombstones: db.entities.Docs.deleted.list(key).collect(),
        })
        const before = yield* read
        expect(before.versions.length).toBeGreaterThan(0)
        expect(before.tombstones.map((d) => d.title)).toEqual(["v2"])
        const now = KeyComposer.composePk(AppSchema, "Doc", Docs.indexes.primary, key)
        const old = KeyText136.composePk(AppSchema, "Doc", Docs.indexes.primary, key)
        yield* demotePartition(now, old)
        expect(yield* read).toEqual(before)
      }).pipe(provide),
    )
  })

  describe("aggregates", () => {
    const route = (id: number) => ({
      id,
      area: `area${-id}`,
      name: "r",
      stops: [new Stop({ label: "a b", note: "1" }), new Stop({ label: "c", note: "2" })],
    })
    const pkNow = (id: number) =>
      DynamoSchema.composeCollectionKey(AppSchema, "routes", [KeyComposer.serializeValue(id)])
    const pk136 = (id: number) =>
      DynamoSchema.composeCollectionKey(AppSchema, "routes", [KeyText136.serializeValue(id)])
    const stopSk = (label: string) =>
      DynamoSchema.composeKey(AppSchema, "RouteStop", [KeyComposer.sortKeyText(label, "lowercase")])
    const stopSk136 = (label: string) => DynamoSchema.composeKey(AppSchema, "RouteStop", [label])
    const rootSk = DynamoSchema.composeKey(AppSchema, "RouteItem", [])

    /** The route as 1.36 wrote it: its partition, its edges' keys and its list sort key. */
    const seed = (id: number) =>
      Effect.gen(function* () {
        yield* Routes.create(route(id))
        yield* demotePartition(pkNow(id), pk136(id), (row) => {
          const edge = route(id).stops.find((stop) => stopSk(stop.label) === row.sk!.S)
          return {
            ...row,
            ...(edge === undefined ? {} : { sk: { S: stopSk136(edge.label) } }),
            ...(row.gsi1sk === undefined
              ? {}
              : {
                  gsi1sk: {
                    S: DynamoSchema.composeCollectionKey(AppSchema, "routelist", [
                      KeyText136.serializeValue(id),
                    ]),
                  },
                }),
          }
        })
      })

    it.effect("get assembles it; create refuses it; list finds it; delete removes it", () =>
      Effect.gen(function* () {
        yield* seed(-5)
        const got = yield* Routes.get({ id: -5 })
        expect(got.stops.map((s) => s.label).sort()).toEqual(["a b", "c"])
        const exists = yield* Routes.create(route(-5)).pipe(Effect.flip)
        expect(exists._tag).toBe("ConditionalCheckFailed")
        expect(yield* partition(pkNow(-5))).toEqual([])
        const listed = yield* Routes.list({ area: "area5", id: -5 })
        expect(listed.data.map((r) => r.id)).toEqual([-5])
        const all = yield* Routes.list({ area: "area5" })
        expect(all.data.map((r) => r.id)).toEqual([-5])
        yield* Routes.delete({ id: -5 })
        expect(yield* partition(pk136(-5))).toEqual([])
        expect(yield* partition(pkNow(-5))).toEqual([])
      }).pipe(provide),
    )

    it.effect("update moves every row to its current key, in its own transaction", () =>
      Effect.gen(function* () {
        yield* seed(-7)
        const updated = yield* Routes.update({ id: -7 }, ({ state }) => ({
          ...state,
          name: "r2",
          stops: [...state.stops, new Stop({ label: "d e", note: "3" })],
        }))
        expect(updated.stops).toHaveLength(3)
        expect(yield* partition(pk136(-7))).toEqual([])
        const rows = (yield* partition(pkNow(-7))).map((row) => fromAttributeMap(row))
        expect(rows.map((row) => row.sk).sort()).toEqual(
          [rootSk, stopSk("a b"), stopSk("c"), stopSk("d e")].sort(),
        )
        const root = rows.find((row) => row.sk === rootSk)!
        expect(root.gsi1sk).toBe(
          DynamoSchema.composeCollectionKey(AppSchema, "routelist", [
            KeyComposer.sortKeyText(KeyComposer.serializeValue(-7), "lowercase"),
          ]),
        )
        const got = yield* Routes.get({ id: -7 })
        expect(got.name).toBe("r2")
        expect(got.stops.map((s) => s.label).sort()).toEqual(["a b", "c", "d e"])
      }).pipe(provide),
    )

    it.effect("update recomposes a 1.36 list key of a root at its current key", () =>
      Effect.gen(function* () {
        const pk = DynamoSchema.composeCollectionKey(AppSchema, "lines", [
          KeyComposer.serializeValue(9),
        ])
        const lineSk = DynamoSchema.composeKey(AppSchema, "LineItem", [])
        const listSk = DynamoSchema.composeCollectionKey(AppSchema, "linelist", [
          KeyComposer.sortKeyText("big game", "lowercase"),
        ])
        const listSk136 = DynamoSchema.composeCollectionKey(AppSchema, "linelist", ["big game"])
        yield* Lines.create({
          id: 9,
          area: "lines9",
          name: "big game",
          stops: [new Stop({ label: "a", note: "1" })],
        })
        const root = (yield* getRaw(pk, lineSk))!
        expect(root.gsi1sk?.S).toBe(listSk)
        yield* rewrite(root, { ...root, gsi1sk: { S: listSk136 } })
        const pinned = yield* Lines.list({ area: "lines9", name: "big game" })
        expect(pinned.data.map((l) => l.id)).toEqual([9])

        yield* Lines.update({ id: 9 }, ({ state }) => state)
        expect((yield* getRaw(pk, lineSk))!.gsi1sk?.S).toBe(listSk)
        const again = yield* Lines.list({ area: "lines9", name: "big game" })
        expect(again.data.map((l) => l.id)).toEqual([9])
        const all = yield* Lines.list({ area: "lines9" })
        expect(all.data.map((l) => l.id)).toEqual([9])
      }).pipe(provide),
    )

    it.effect("concurrent updates of a 1.36 aggregate leave each row in one place", () =>
      Effect.gen(function* () {
        yield* seed(-8)
        const results = yield* Effect.all(
          [1, 2, 3].map((n) =>
            Effect.exit(Routes.update({ id: -8 }, ({ state }) => ({ ...state, name: `r${n}` }))),
          ),
          { concurrency: "unbounded" },
        )
        expect(results.some((exit) => exit._tag === "Success")).toBe(true)
        const old = (yield* partition(pk136(-8))).map((row) => row.sk?.S)
        const now = (yield* partition(pkNow(-8))).map((row) => row.sk?.S)
        // Each row is under its 1.36 key or its current key, never both.
        for (const [legacy, current] of [
          [rootSk, rootSk],
          [stopSk136("a b"), stopSk("a b")],
          [stopSk136("c"), stopSk("c")],
        ] as const) {
          expect(old.includes(legacy) !== now.includes(current), current).toBe(true)
        }
        const got = yield* Routes.get({ id: -8 })
        expect(got.stops).toHaveLength(2)
      }).pipe(provide),
    )
  })

  describe("event streams", () => {
    const streamPk = (id: number, text: (value: unknown) => string) =>
      DynamoSchema.composeKey(AppSchema, "Ledger", [text(id)])

    /** A stream 1.36 started: its events under its 1.36 partition. */
    const seed = (id: number, events: number) =>
      Effect.gen(function* () {
        yield* Ledger.append(
          ledger(id),
          Array.from({ length: events }, (_, i) => new Deposited({ amount: i + 1 })),
          0,
        )
        yield* demotePartition(
          streamPk(id, KeyComposer.serializeValue),
          streamPk(id, KeyText136.serializeValue),
        )
      })

    it.effect("a 1.36 stream is read and appended where it lives; a new one starts current", () =>
      Effect.gen(function* () {
        yield* seed(-5, 2)
        const read = yield* Ledger.read(ledger(-5))
        expect(read.map((e) => e.version)).toEqual([1, 2])
        yield* Ledger.append(ledger(-5), [new Deposited({ amount: 3 })], 2)
        expect(yield* partition(streamPk(-5, KeyComposer.serializeValue))).toEqual([])
        expect(yield* partition(streamPk(-5, KeyText136.serializeValue))).toHaveLength(3)
        const after = yield* Ledger.read(ledger(-5))
        expect(after.map((e) => e.version)).toEqual([1, 2, 3])
        const stale = yield* Ledger.append(ledger(-5), [new Deposited({ amount: 4 })], 1).pipe(
          Effect.flip,
        )
        expect(stale._tag).toBe("VersionConflict")
        yield* Ledger.append(ledger(-6), [new Deposited({ amount: 1 })], 0)
        expect(yield* partition(streamPk(-6, KeyComposer.serializeValue))).toHaveLength(1)
        expect(yield* partition(streamPk(-6, KeyText136.serializeValue))).toEqual([])
      }).pipe(provide),
    )

    it.effect("concurrent appends to a 1.36 stream: one wins, the stream stays whole", () =>
      Effect.gen(function* () {
        yield* seed(-7, 1)
        const results = yield* Effect.all(
          [1, 2, 3, 4].map((n) =>
            Effect.exit(Ledger.append(ledger(-7), [new Deposited({ amount: n })], 1)),
          ),
          { concurrency: "unbounded" },
        )
        expect(results.filter((exit) => exit._tag === "Success")).toHaveLength(1)
        expect(yield* partition(streamPk(-7, KeyComposer.serializeValue))).toEqual([])
        const read = yield* Ledger.read(ledger(-7))
        expect(read.map((e) => e.version)).toEqual([1, 2])
      }).pipe(provide),
    )
  })
})
