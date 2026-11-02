/**
 * Queries, aggregates and event streams over rows still under their 1.36 keys
 * (#171) — request capture.
 *
 * A query that pins a key prefix whose 1.36 text differs also reads the 1.36
 * key, as a second pass of one plan; an aggregate is read under both
 * partitions and moved by `update`; an event stream 1.36 started is read and
 * appended where it lives. These tests run them against a recording
 * in-memory table:
 *
 * - **Zero overhead.** Over keys whose text did not change, every read and
 *   write sends exactly the requests it sends with the fallback off.
 * - **Changed keys.** The passes, their order and their cursors; the rows a
 *   1.36 pass keeps; the aggregate's move inside its own transaction; the
 *   stream's partition.
 *
 * `connected.legacy-key-queries.test.ts` runs the same reads against
 * DynamoDB Local.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Option, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable, type Request } from "./helpers/RecordingTable.js"

// ---------------------------------------------------------------------------
// Fixtures — one set per schema: the fallback on, and off
// ---------------------------------------------------------------------------

class Reading extends Schema.Class<Reading>("Reading")({
  site: Schema.String,
  zone: Schema.Number,
  label: Schema.String,
  tag: Schema.String,
  seq: Schema.Number,
}) {}

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.Number,
  title: Schema.String,
}) {}

class Gauge extends Schema.Class<Gauge>("Gauge")({
  gaugeId: Schema.Number,
  at: Schema.Number,
  level: Schema.Number,
}) {}

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

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}

const world = (schema: DynamoSchema.DynamoSchema) => {
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
    },
  })
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
  const Gauges = Entity.make({
    model: Gauge,
    entityType: "Gauge",
    primaryKey: {
      pk: { field: "pk", composite: ["gaugeId"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        gaugeId: Schema.Number,
        at: Schema.Number,
        level: Schema.Number,
      }),
    },
  })
  const MainTable = Table.make({ schema, entities: { Readings, Docs, Gauges } })
  const Routes = Aggregate.make(Route, {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "routes" },
    root: { entityType: "RouteItem" },
    edges: {
      stops: Aggregate.many({ entityType: "RouteStop", sk: { composite: ["label"] } }),
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
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "lines" },
    root: { entityType: "LineItem" },
    edges: {
      stops: Aggregate.many({ entityType: "LineStop", sk: { composite: ["label"] } }),
    },
    list: {
      index: "gsi1",
      name: "linelist",
      pk: { field: "gsi1pk", composite: ["area"] },
      sk: { field: "gsi1sk", composite: ["name"] },
    },
  })
  const Ledger = EventStore.makeStream({
    table: MainTable,
    streamName: "Ledger",
    events: [Deposited],
    streamId: { composite: ["ledgerId"] },
  })
  return { schema, Readings, Docs, Gauges, MainTable, Routes, Lines, Ledger }
}

/**
 * A stream id. Typed as strings; a number, which an untyped caller can pass,
 * is the one whose key text changed in 1.37.
 */
const ledger = (id: number | string) =>
  ({ ledgerId: id }) as unknown as { readonly ledgerId: string }

const On = world(DynamoSchema.make({ name: "unitq", version: 1 }))
const Off = world(DynamoSchema.make({ name: "unitq", version: 1, legacyKeys: false }))
type World = typeof On

const clientOf = (w: World) =>
  DynamoClient.make({
    entities: { Readings: w.Readings, Docs: w.Docs, Gauges: w.Gauges },
    tables: { MainTable: w.MainTable },
  })

type Recording = ReturnType<typeof makeRecordingTable>

const freshTable = () => makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })

/** Run `body` in `w` over `table`. */
const inTable = <A, E>(w: World, table: Recording, body: Effect.Effect<A, E, any>) =>
  body.pipe(
    Effect.provide(Layer.mergeAll(table.layer, w.MainTable.layer({ name: "t" }))),
  ) as Effect.Effect<A, E>

/** The requests, with each run's random tokens (incarnations, write tokens) made equal. */
const normalized = (requests: ReadonlyArray<Request>) =>
  JSON.parse(
    JSON.stringify(requests)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<token>")
      .replace(/"[0-9a-f]{32}"/g, '"<token>"'),
  )

/** Each Query's partition key value, in order. */
const queriedPartitions = (requests: ReadonlyArray<Request>) =>
  requests
    .filter((request) => request.command === "Query")
    .map((request) => {
      const values = request.input.ExpressionAttributeValues as Record<string, AttributeValue>
      return values[":pk"]?.S ?? Object.values(values)[0]?.S
    })

// ---------------------------------------------------------------------------
// Rows as 1.36 wrote them
// ---------------------------------------------------------------------------

const at = (pk: string | undefined, sk: string | undefined) => `${pk}|${sk}`

/** Rewrite the reading the entity wrote for `record` under its 1.36 primary and GSI keys. */
const demoteReading = (table: Recording, w: World, record: Record<string, unknown>) => {
  const current = KeyComposer.composeAllKeys(w.schema, "Reading", 1, w.Readings.indexes, record)
  const old = KeyText136.composeAllKeys(w.schema, "Reading", 1, w.Readings.indexes, record)
  const item = table.items.get(at(current.pk as string, current.sk as string))!
  expect(item).toBeDefined()
  table.items.delete(at(current.pk as string, current.sk as string))
  table.items.set(at(old.pk, old.sk), { ...item, ...toAttributeMap(old) })
  return { current, old }
}

/** Move every row of partition `from` to partition `to`, as 1.36 keyed them. */
const demotePartition = (
  table: Recording,
  from: string,
  to: string,
  rewrite: (row: Record<string, AttributeValue>) => Record<string, AttributeValue> = (row) => row,
) => {
  let moved = 0
  for (const [key, row] of [...table.items.entries()]) {
    if (row.pk?.S !== from) continue
    table.items.delete(key)
    const next = rewrite({ ...row, pk: { S: to } })
    table.items.set(at(next.pk?.S, next.sk?.S), next)
    moved++
  }
  expect(moved).toBeGreaterThan(0)
  return moved
}

const rowsUnder = (table: Recording, pk: string) =>
  [...table.items.values()].filter((row) => row.pk?.S === pk).map((row) => fromAttributeMap(row))

const reading = (zone: number, label: string, tag: string, seq: number) => ({
  site: `s${seq}`,
  zone,
  label,
  tag,
  seq,
})

// ---------------------------------------------------------------------------
// Zero overhead
// ---------------------------------------------------------------------------

/** Every read the fallback reaches, and the writes around them, over unchanged key text. */
const script = (w: World) =>
  Effect.gen(function* () {
    const db = yield* clientOf(w)
    for (const seq of [1, 2, 3]) {
      yield* db.entities.Readings.put(reading(3, "ab", "t", seq)).asEffect()
    }
    const out: Array<unknown> = []
    out.push(yield* db.entities.Readings.byZone({ zone: 3 }).collect())
    out.push(yield* db.entities.Readings.byZone({ zone: 3, label: "ab" }).reverse().collect())
    out.push(yield* db.entities.Readings.byZone({ zone: 3 }).count())
    out.push(
      yield* db.entities.Readings.byZone({ zone: 3 })
        .where((t, { beginsWith }) => beginsWith(t.label, "a"))
        .collect(),
    )
    const page = yield* db.entities.Readings.byZone({ zone: 3 }).limit(1).fetch()
    out.push(page)
    out.push(
      yield* db.entities.Readings.byZone({ zone: 3 })
        .limit(1)
        .startFrom(Option.getOrThrow(page.cursor))
        .fetch(),
    )
    out.push(yield* Query.collect(w.Readings.query.byZone({ zone: 3 })))
    yield* db.entities.Docs.put({ docId: 5, title: "v1" }).asEffect()
    yield* db.entities.Docs.update({ docId: 5 }).set({ title: "v2" }).asEffect()
    out.push(yield* db.entities.Docs.versions({ docId: 5 }).collect())
    yield* db.entities.Docs.delete({ docId: 5 }).asEffect()
    out.push(yield* db.entities.Docs.deleted.list({ docId: 5 }).collect())
    for (const t of [1, 2]) {
      yield* db.entities.Gauges.append({ gaugeId: 6, at: t, level: t }).asEffect()
    }
    out.push(yield* db.entities.Gauges.history({ gaugeId: 6 }).collect())
    const route = {
      id: 5,
      area: "north",
      name: "r",
      stops: [new Stop({ label: "ab", note: "n" })],
    }
    yield* w.Routes.create(route)
    out.push(yield* w.Routes.get({ id: 5 }))
    yield* w.Routes.update({ id: 5 }, ({ state }) => ({ ...state, name: "r2" }))
    out.push(yield* w.Routes.list({ area: "north" }))
    out.push(yield* w.Routes.list({ area: "north", id: 5 }))
    yield* w.Ledger.append(ledger("l5"), [new Deposited({ amount: 1 })], 0)
    out.push(yield* w.Ledger.read(ledger("l5")))
    yield* w.Routes.delete({ id: 5 })
    return out
  })

describe("legacy key queries — zero overhead", () => {
  it.effect("pins whose text did not change: the same requests as with the fallback off", () =>
    Effect.gen(function* () {
      const onTable = freshTable()
      const offTable = freshTable()
      const on = yield* inTable(On, onTable, script(On))
      const off = yield* inTable(Off, offTable, script(Off))
      expect(JSON.parse(JSON.stringify(on))).toEqual(JSON.parse(JSON.stringify(off)))
      expect(onTable.requests.filter((r) => r.command === "Query").length).toBeGreaterThan(10)
      expect(normalized(onTable.requests)).toEqual(normalized(offTable.requests))
    }),
  )
})

// ---------------------------------------------------------------------------
// Entity accessors
// ---------------------------------------------------------------------------

describe("legacy key queries — an accessor over pins whose text changed", () => {
  /** Two readings under their 1.36 keys, two under their current keys, zone -3. */
  const seeded = (table: Recording) =>
    inTable(
      On,
      table,
      Effect.gen(function* () {
        const db = yield* clientOf(On)
        for (const seq of [1, 2, 3, 4]) {
          yield* db.entities.Readings.put(reading(-3, "a b", "t", seq)).asEffect()
        }
        const pk136 = demoteReading(table, On, reading(-3, "a b", "t", 1)).old.gsi1pk
        demoteReading(table, On, reading(-3, "a b", "t", 2))
        table.take()
        return { db, pk136 }
      }),
    )

  const pkNow = KeyComposer.composePk(On.schema, "Reading", On.Readings.indexes.byZone, {
    zone: -3,
  })

  it.effect("reads the 1.36 key first, then the current key; reverse the other way", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const { db, pk136 } = yield* seeded(table)
      expect(pk136).not.toBe(pkNow)
      const forward = yield* inTable(On, table, db.entities.Readings.byZone({ zone: -3 }).collect())
      expect(forward.map((r) => r.seq)).toEqual([1, 2, 3, 4])
      expect(queriedPartitions(table.take())).toEqual([pk136, pkNow])
      const backward = yield* inTable(
        On,
        table,
        db.entities.Readings.byZone({ zone: -3 }).reverse().collect(),
      )
      expect(backward.map((r) => r.seq)).toEqual([4, 3, 2, 1])
      expect(queriedPartitions(table.take())).toEqual([pkNow, pk136])
      // The pins' prefix extends to the sort key: `a b` was not escaped.
      const pinned = yield* inTable(
        On,
        table,
        db.entities.Readings.byZone({ zone: -3, label: "a b" }).collect(),
      )
      expect(pinned.map((r) => r.seq)).toEqual([1, 2, 3, 4])
      const conditions = table
        .take()
        .filter((r) => r.command === "Query")
        .map((r) => Object.values(r.input.ExpressionAttributeValues as object).map((v) => v.S))
      const condition136 = KeyText136.composeSortKeyCondition(
        On.schema,
        "Reading",
        1,
        On.Readings.indexes.byZone,
        { label: "a b" },
      )
      expect(conditions[0]).toContain("beginsWith" in condition136 ? condition136.beginsWith : "")
    }),
  )

  it.effect("pages across both keys: each row once, the pass in the cursor", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const { db } = yield* seeded(table)
      const seen: Array<number> = []
      let cursor = Option.none<string>()
      for (let page = 0; page < 10; page++) {
        const query = db.entities.Readings.byZone({ zone: -3 }).limit(1)
        const result: Query.Page<Reading> = yield* inTable(
          On,
          table,
          Option.match(cursor, {
            onNone: () => query,
            onSome: (resume) => query.startFrom(resume),
          }).fetch(),
        )
        seen.push(...result.items.map((r) => r.seq))
        if (Option.isSome(result.cursor) && page === 0) {
          const decoded = JSON.parse(
            Buffer.from(result.cursor.value.slice(3), "base64url").toString("utf8"),
          )
          expect(decoded.p).toBe(1)
        }
        cursor = result.cursor
        if (Option.isNone(cursor)) break
      }
      expect(seen).toEqual([1, 2, 3, 4])
      const count = yield* inTable(On, table, db.entities.Readings.byZone({ zone: -3 }).count())
      expect(count).toBe(4)
    }),
  )

  it.effect("eq and beginsWith extend the pins to the 1.36 key; a range bound does not", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const { db, pk136 } = yield* seeded(table)
      const eq = yield* inTable(
        On,
        table,
        db.entities.Readings.byZone({ zone: -3 })
          .where((t, { eq }) => eq(t.label, "a b"))
          .collect(),
      )
      expect(eq.map((r) => r.seq)).toEqual([1, 2, 3, 4])
      expect(queriedPartitions(table.take())).toEqual([pk136, pkNow])
      const begins = yield* inTable(
        On,
        table,
        db.entities.Readings.byZone({ zone: -3 })
          .where((t, { beginsWith }) => beginsWith(t.label, "a "))
          .collect(),
      )
      expect(begins.map((r) => r.seq)).toEqual([1, 2, 3, 4])
      table.take()
      const bounded = yield* inTable(
        On,
        table,
        db.entities.Readings.byZone({ zone: -3 })
          .where((t, { gte }) => gte(t.label, "a"))
          .collect(),
      )
      // Documented: a range bound reads the current key only.
      expect(bounded.map((r) => r.seq)).toEqual([3, 4])
      expect(queriedPartitions(table.take())).toEqual([pkNow])
    }),
  )

  it.effect("a current row the 1.36 condition also selects is read by the current pass only", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const db = yield* inTable(On, table, clientOf(On))
      // `a#b`'s 1.36 text is the current text of `a` then `b`.
      yield* inTable(On, table, db.entities.Readings.put(reading(3, "a", "b", 1)).asEffect())
      yield* inTable(On, table, db.entities.Readings.put(reading(3, "a#b", "x", 2)).asEffect())
      demoteReading(table, On, reading(3, "a#b", "x", 2))
      table.take()
      const pinned = yield* inTable(
        On,
        table,
        db.entities.Readings.byZone({ zone: 3, label: "a#b" }).collect(),
      )
      expect(pinned.map((r) => [r.label, r.tag])).toEqual([["a#b", "x"]])
      expect(table.take().filter((r) => r.command === "Query")).toHaveLength(2)
      // Documented: the unmoved row's 1.36 text still begins `a#`, so pins on
      // `a` — whose text did not change, and that read one key — select it,
      // as they did in 1.36, until `rekey` moves it.
      const prefix = yield* inTable(
        On,
        table,
        db.entities.Readings.byZone({ zone: 3, label: "a" }).collect(),
      )
      expect(prefix.map((r) => [r.label, r.tag])).toEqual([
        ["a#b", "x"],
        ["a", "b"],
      ])
      expect(table.take().filter((r) => r.command === "Query")).toHaveLength(1)
    }),
  )

  it.effect("the unbound entity query reads both keys too", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const { pk136 } = yield* seeded(table)
      const rows = yield* inTable(On, table, Query.collect(On.Readings.query.byZone({ zone: -3 })))
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4])
      expect(queriedPartitions(table.take())).toEqual([pk136, pkNow])
    }),
  )
})

// ---------------------------------------------------------------------------
// History, versions and tombstones
// ---------------------------------------------------------------------------

describe("legacy key queries — an item's history under its 1.36 partition", () => {
  it.effect("history reads the 1.36 event prefix, then the current one", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const db = yield* inTable(On, table, clientOf(On))
      for (const t of [1, 2]) {
        yield* inTable(
          On,
          table,
          db.entities.Gauges.append({ gaugeId: -6, at: t, level: t }).asEffect(),
        )
      }
      const key = { gaugeId: -6 }
      const now = KeyComposer.composePk(On.schema, "Gauge", On.Gauges.indexes.primary, key)
      const old = KeyText136.composePk(On.schema, "Gauge", On.Gauges.indexes.primary, key)
      demotePartition(table, now, old)
      // The first append moves the item; its event goes under the current key.
      yield* inTable(
        On,
        table,
        db.entities.Gauges.append({ gaugeId: -6, at: 3, level: 3 }).asEffect(),
      )
      table.take()
      const history = yield* inTable(On, table, db.entities.Gauges.history(key).collect())
      expect(history.map((e) => e.at)).toEqual([1, 2, 3])
      expect(queriedPartitions(table.take())).toEqual([old, now])
      const reversed = yield* inTable(
        On,
        table,
        db.entities.Gauges.history(key).reverse().collect(),
      )
      expect(reversed.map((e) => e.at)).toEqual([3, 2, 1])
    }),
  )

  it.effect("versions and deleted.list read the 1.36 partition", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const db = yield* inTable(On, table, clientOf(On))
      const key = { docId: -5 }
      yield* inTable(On, table, db.entities.Docs.put({ ...key, title: "v1" }).asEffect())
      yield* inTable(On, table, db.entities.Docs.update(key).set({ title: "v2" }).asEffect())
      yield* inTable(On, table, db.entities.Docs.delete(key).asEffect())
      const read = Effect.all({
        versions: db.entities.Docs.versions(key).collect(),
        tombstones: db.entities.Docs.deleted.list(key).collect(),
      })
      const before = yield* inTable(On, table, read)
      expect(before.versions.length).toBeGreaterThan(0)
      expect(before.tombstones.map((d) => d.title)).toEqual(["v2"])
      const now = KeyComposer.composePk(On.schema, "Doc", On.Docs.indexes.primary, key)
      const old = KeyText136.composePk(On.schema, "Doc", On.Docs.indexes.primary, key)
      demotePartition(table, now, old)
      table.take()
      const after = yield* inTable(On, table, read)
      expect(after).toEqual(before)
      // versions(): a keys-only look under the 1.36 key finds snapshots, so the
      // versions the current key holds are read first (its twins are left out);
      // then both passes. deleted.list(): both passes.
      expect(queriedPartitions(table.take())).toEqual([old, now, old, now, old, now])
    }),
  )
})

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

describe("legacy key queries — an aggregate under its 1.36 keys", () => {
  const route = {
    id: -5,
    area: "north",
    name: "r",
    stops: [new Stop({ label: "a b", note: "1" }), new Stop({ label: "c", note: "2" })],
  }
  const pkNow = DynamoSchema.composeCollectionKey(On.schema, "routes", [
    KeyComposer.serializeValue(-5),
  ])
  const pk136 = DynamoSchema.composeCollectionKey(On.schema, "routes", [
    KeyText136.serializeValue(-5),
  ])
  const stopSk = (label: string) =>
    DynamoSchema.composeKey(On.schema, "RouteStop", [KeyComposer.sortKeyText(label, "lowercase")])
  const stopSk136 = (label: string) => DynamoSchema.composeKey(On.schema, "RouteStop", [label])

  /** The route as 1.36 wrote it: its partition, its edge keys and its list sort key. */
  const seeded = (table: Recording) =>
    Effect.gen(function* () {
      yield* inTable(On, table, On.Routes.create(route))
      demotePartition(table, pkNow, pk136, (row) => {
        const sk = row.sk!.S!
        const edge = route.stops.find((stop) => stopSk(stop.label) === sk)
        return {
          ...row,
          ...(edge === undefined ? {} : { sk: { S: stopSk136(edge.label) } }),
          ...(row.gsi1sk === undefined
            ? {}
            : {
                gsi1sk: {
                  S: DynamoSchema.composeCollectionKey(On.schema, "routelist", [
                    KeyText136.serializeValue(-5),
                  ]),
                },
              }),
        }
      })
      expect(stopSk136("a b")).not.toBe(stopSk("a b"))
      table.take()
    })

  it.effect("get reads both partitions; create finds the 1.36 root", () =>
    Effect.gen(function* () {
      const table = freshTable()
      yield* seeded(table)
      const got = yield* inTable(On, table, On.Routes.get({ id: -5 }))
      expect(got.stops.map((s) => s.label).sort()).toEqual(["a b", "c"])
      expect(queriedPartitions(table.take())).toEqual([pk136, pkNow])
      const error = yield* inTable(On, table, On.Routes.create(route)).pipe(Effect.flip)
      expect(error._tag).toBe("ConditionalCheckFailed")
      const [write] = table.take().filter((r) => r.command === "TransactWriteItems")
      const check = (write!.input.TransactItems as Array<any>).at(-1)
      expect(check.ConditionCheck.Key.pk.S).toBe(pk136)
      expect(rowsUnder(table, pkNow)).toEqual([])
    }),
  )

  it.effect("update moves every row in its own group's transaction", () =>
    Effect.gen(function* () {
      const table = freshTable()
      yield* seeded(table)
      const updated = yield* inTable(
        On,
        table,
        On.Routes.update({ id: -5 }, ({ state }) => ({ ...state, name: "r2" })),
      )
      expect(updated.name).toBe("r2")
      expect(rowsUnder(table, pk136)).toEqual([])
      const moved = rowsUnder(table, pkNow)
      expect(moved.map((row) => row.sk).sort()).toEqual(
        [DynamoSchema.composeKey(On.schema, "RouteItem", []), stopSk("a b"), stopSk("c")].sort(),
      )
      const writes = table.take().filter((r) => r.command === "TransactWriteItems")
      expect(writes).toHaveLength(1)
      const items = writes[0]!.input.TransactItems as Array<any>
      expect(items.filter((i) => i.Put).map((i) => i.Put.Item.pk.S)).toEqual([pkNow, pkNow, pkNow])
      expect(
        items.filter((i) => i.Delete).map((i) => `${i.Delete.Key.pk.S}|${i.Delete.Key.sk.S}`),
      ).toEqual(
        expect.arrayContaining([
          `${pk136}|${DynamoSchema.composeKey(On.schema, "RouteItem", [])}`,
          `${pk136}|${stopSk136("a b")}`,
          `${pk136}|${stopSk136("c")}`,
        ]),
      )
      // A second update finds every row at its current key: nothing to move.
      yield* inTable(
        On,
        table,
        On.Routes.update({ id: -5 }, ({ state }) => ({ ...state, name: "r3" })),
      )
      const second = table.take().filter((r) => r.command === "TransactWriteItems")
      expect((second[0]!.input.TransactItems as Array<any>).some((i) => i.Delete)).toBe(false)
    }),
  )

  it.effect("list reads the 1.36 list key; delete removes the stored keys", () =>
    Effect.gen(function* () {
      const table = freshTable()
      yield* seeded(table)
      const listed = yield* inTable(On, table, On.Routes.list({ area: "north", id: -5 }))
      expect(listed.data.map((r) => r.id)).toEqual([-5])
      const all = yield* inTable(On, table, On.Routes.list({ area: "north" }))
      expect(all.data.map((r) => r.id)).toEqual([-5])
      yield* inTable(On, table, On.Routes.delete({ id: -5 }))
      expect(rowsUnder(table, pk136)).toEqual([])
      expect(rowsUnder(table, pkNow)).toEqual([])
    }),
  )
})

describe("legacy key queries — an aggregate at its current key with a 1.36 list key", () => {
  const line = {
    id: 7,
    area: "east",
    name: "big game",
    stops: [new Stop({ label: "a", note: "1" })],
  }
  const pk = DynamoSchema.composeCollectionKey(On.schema, "lines", [KeyComposer.serializeValue(7)])
  const rootSk = DynamoSchema.composeKey(On.schema, "LineItem", [])
  const listSk = DynamoSchema.composeCollectionKey(On.schema, "linelist", [
    KeyComposer.sortKeyText("big game", "lowercase"),
  ])
  const listSk136 = DynamoSchema.composeCollectionKey(On.schema, "linelist", ["big game"])

  it.effect("update rewrites the root, recomposing its list key; list finds it once", () =>
    Effect.gen(function* () {
      const table = freshTable()
      yield* inTable(On, table, On.Lines.create(line))
      const root = table.items.get(at(pk, rootSk))!
      expect(root.gsi1sk?.S).toBe(listSk)
      expect(listSk136).not.toBe(listSk)
      table.items.set(at(pk, rootSk), { ...root, gsi1sk: { S: listSk136 } })
      table.take()

      const pinned = yield* inTable(On, table, On.Lines.list({ area: "east", name: "big game" }))
      expect(pinned.data.map((l) => l.id)).toEqual([7])

      // An update that changes nothing rewrites the root all the same.
      yield* inTable(
        On,
        table,
        On.Lines.update({ id: 7 }, ({ state }) => state),
      )
      expect(table.items.get(at(pk, rootSk))!.gsi1sk?.S).toBe(listSk)
      table.take()
      const again = yield* inTable(On, table, On.Lines.list({ area: "east", name: "big game" }))
      expect(again.data.map((l) => l.id)).toEqual([7])
      const all = yield* inTable(On, table, On.Lines.list({ area: "east" }))
      expect(all.data.map((l) => l.id)).toEqual([7])

      // From then on an update that changes nothing writes nothing.
      yield* inTable(
        On,
        table,
        On.Lines.update({ id: 7 }, ({ state }) => state),
      )
      expect(table.take().filter((r) => r.command === "TransactWriteItems")).toEqual([])
    }),
  )
})

// ---------------------------------------------------------------------------
// Event streams
// ---------------------------------------------------------------------------

describe("legacy key queries — an event stream 1.36 started", () => {
  const streamPk = (w: World, id: number, text: (value: unknown) => string) =>
    DynamoSchema.composeKey(w.schema, "Ledger", [text(id)])

  it.effect("is read and appended under its 1.36 key; a new stream starts at its current key", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const id = ledger(-5)
      yield* inTable(On, table, On.Ledger.append(id, [new Deposited({ amount: 1 })], 0))
      const now = streamPk(On, -5, KeyComposer.serializeValue)
      const old = streamPk(On, -5, KeyText136.serializeValue)
      expect(old).not.toBe(now)
      demotePartition(table, now, old)
      table.take()

      const read = yield* inTable(On, table, On.Ledger.read(id))
      expect(read.map((e) => e.version)).toEqual([1])
      const appended = yield* inTable(
        On,
        table,
        On.Ledger.append(id, [new Deposited({ amount: 2 })], 1),
      )
      expect(appended.version).toBe(2)
      expect(rowsUnder(table, now)).toEqual([])
      expect(rowsUnder(table, old).map((row) => row.sk)).toHaveLength(2)
      const after = yield* inTable(On, table, On.Ledger.read(id))
      expect(after.map((e) => e.version)).toEqual([1, 2])
      // A stale append conflicts where the stream lives.
      const stale = yield* inTable(
        On,
        table,
        On.Ledger.append(id, [new Deposited({ amount: 3 })], 0),
      ).pipe(Effect.flip)
      expect(stale._tag).toBe("VersionConflict")
      table.take()

      // A new stream: one probe of its 1.36 key, then its current key.
      const fresh = ledger(-6)
      yield* inTable(On, table, On.Ledger.append(fresh, [new Deposited({ amount: 1 })], 0))
      const requests = table.take()
      expect(requests[0]!.command).toBe("GetItem")
      expect(requests[0]!.input.Key.pk.S).toBe(streamPk(On, -6, KeyText136.serializeValue))
      expect(rowsUnder(table, streamPk(On, -6, KeyComposer.serializeValue))).toHaveLength(1)
    }),
  )

  it.effect("a stream id whose text did not change sends no probe", () =>
    Effect.gen(function* () {
      const table = freshTable()
      yield* inTable(On, table, On.Ledger.append(ledger("l5"), [new Deposited({ amount: 1 })], 0))
      yield* inTable(On, table, On.Ledger.read(ledger("l5")))
      expect(table.requests.map((r) => r.command)).toEqual(["PutItem", "Query"])
    }),
  )
})
