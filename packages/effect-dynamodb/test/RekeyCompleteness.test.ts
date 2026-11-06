/**
 * `rekey` is the only way a row under another key text is reached again (#183), so every row is
 * moved or counted in the report and none is silently left. These are the rows it can't place and
 * the moves that can be cut short, in both directions: each counts on every run, and a dry run says
 * what the real run does.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import * as RekeyChains from "./helpers/RekeyChains.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"

class Stop extends Schema.Class<Stop>("Stop")({
  label: Schema.String,
  note: Schema.String,
}) {}

class Route extends Schema.Class<Route>("Route")({
  id: Schema.String,
  name: Schema.String,
  stops: Schema.Array(Stop),
}) {}

class Account extends Schema.Class<Account>("Account")({
  id: Schema.String,
  email: Schema.String,
}) {}

class Reading extends Schema.Class<Reading>("Reading")({
  id: Schema.String,
  level: Schema.Number,
}) {}

class Listing extends Schema.Class<Listing>("Listing")({
  id: Schema.String,
  agency: Schema.String,
  status: Schema.Literals(["open", "closed"]),
}) {}

class Doc extends Schema.Class<Doc>("Doc")({
  id: Schema.String,
  title: Schema.String,
}) {}

class Logged extends Schema.TaggedClass<Logged>()("Logged", { note: Schema.String }) {}

const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "complete", version: 1, escapeKeys })
  const Accounts = Entity.make({
    model: Account,
    entityType: "Account",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    unique: { email: ["email"] },
  })
  const Readings = Entity.make({
    model: Reading,
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byLevel: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["id"] },
        sk: { field: "gsi1sk", composite: ["level"] },
      },
    },
  })
  const Listings = Entity.make({
    model: Listing,
    entityType: "Listing",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byAgency: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["id"] },
        sk: { field: "gsi2sk", prefix: ["agency"], zorder: ["status"] },
      },
    },
  })
  const Docs = Entity.make({
    model: Doc,
    entityType: "Doc",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    versioned: { retain: true },
    softDelete: true,
  })
  const MainTable = Table.make({ schema, entities: { Accounts, Readings, Listings, Docs } })
  const Logs = EventStore.makeStream({
    table: MainTable,
    streamName: "Log",
    events: [Logged],
    streamId: { composite: ["id"] },
  })
  const Routes = Aggregate.make(Route, {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "routes" },
    root: { entityType: "RouteItem" },
    edges: {
      stops: Aggregate.many({ entityType: "RouteStop", sk: { composite: ["label"] } }),
    },
  })
  const client = DynamoClient.make({
    entities: { Accounts, Readings, Listings, Docs },
    aggregates: { Routes },
    tables: { MainTable },
  })
  return { schema, Accounts, Readings, Listings, Docs, Logs, Routes, MainTable, client }
}

/** The text the rows of a test are under: the other setting's. */
const otherText = (escapeKeys: boolean) =>
  DynamoSchema.make({ name: "complete", version: 1, escapeKeys: !escapeKeys })

const tableOf = () =>
  makeRecordingTable({
    indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" }, gsi2: { pk: "gsi2pk", sk: "gsi2sk" } },
  })

const layerOf = (w: ReturnType<typeof world>, table: ReturnType<typeof tableOf>) =>
  Layer.merge(table.layer, w.MainTable.layer({ name: "t" }))

const on =
  (w: ReturnType<typeof world>, table: ReturnType<typeof tableOf>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(layerOf(w, table))) as Effect.Effect<A, E>

/** The stored rows, by key. */
const keysOf = (table: ReturnType<typeof tableOf>) =>
  [...table.items.values()].map((row) => [row.pk?.S, row.sk?.S]).sort()

/** Store a row as it is, in attribute form. */
const store = (table: ReturnType<typeof tableOf>, row: Record<string, AttributeValue>) => {
  table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
}

const seed = (table: ReturnType<typeof tableOf>, row: Record<string, unknown>) => {
  store(table, toAttributeMap(row))
}

const dryThenReal = (db: any, options: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ ...options, dryRun: true })
    const real: Table.RekeyReport = yield* db.tables.MainTable.rekey(options)
    return { dry, real }
  })

/**
 * Two values where the first's current key is where the second is stored under the other setting:
 * `foo bar` escapes to where `foo%20bar` is stored raw, and going back, `foo%20bar` is where
 * `foo bar` is stored escaped. So the second moves first, and when it can't, neither does.
 */
const chainOf = (escapeKeys: boolean) =>
  escapeKeys
    ? ({ moving: "foo bar", holder: "foo%20bar" } as const)
    : ({ moving: "foo%20bar", holder: "foo bar" } as const)

const SETTINGS = [
  ["to on", true],
  ["to off", false],
] as const

describe.each(SETTINGS)("rows `rekey` can't place are counted, %s", (_direction, escapeKeys) => {
  const w = world(escapeKeys)

  it.effect("a unique sentinel with no row behind it, on every run", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.entities.Accounts.put({ id: "a", email: "x y" }).asEffect()
      table.items.delete(
        `${KeyComposer.composePk(w.schema, "Account", w.Accounts.indexes.primary, { id: "a" })}|${KeyComposer.composeSk(w.schema, "Account", 1, w.Accounts.indexes.primary, { id: "a" })}`,
      )
      const before = keysOf(table)
      expect(before).toHaveLength(1)
      const { dry, real } = yield* dryThenReal(db)
      expect(real.skipped.unrecognizedKey).toBe(1)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      expect((yield* db.tables.MainTable.rekey()).skipped.unrecognizedKey).toBe(1)
      expect(keysOf(table)).toEqual(before)
    }).pipe(on(w, table))
  })

  it.effect("a unique sentinel its row's values don't compose", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.entities.Accounts.put({ id: "a", email: "x y" }).asEffect()
      // The row has since changed value, and this sentinel was left behind.
      const key = DynamoSchema.composeUniqueKey(w.schema, "Account", "email", ["other"])
      const row = [...table.items.values()].find((item) => item.__edd_e__?.S === "Account")!
      seed(table, {
        ...key,
        _entity_pk: row.pk?.S,
        _entity_sk: row.sk?.S,
        __edd_e__: "Account._unique.email",
      })
      const before = keysOf(table)
      const { dry, real } = yield* dryThenReal(db)
      expect(real.conflicts).toEqual([])
      expect(real.skipped.unrecognizedKey).toBe(1)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      expect(keysOf(table)).toEqual(before)
    }).pipe(on(w, table))
  })

  it.effect("an aggregate edge with no root in its partition, on every run", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create({
        id: "r 1",
        name: "n",
        stops: [new Stop({ label: "a b", note: "1" }), new Stop({ label: "c", note: "2" })],
      })
      const root = [...table.items.entries()].find(([, item]) => item.__edd_e__?.S === "RouteItem")!
      table.items.delete(root[0])
      const before = keysOf(table)
      const { dry, real } = yield* dryThenReal(db)
      expect(real.skipped.unrecognizedKey).toBe(2)
      expect(real.moved.aggregate).toBe(0)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      expect((yield* db.tables.MainTable.rekey()).skipped.unrecognizedKey).toBe(2)
      expect(keysOf(table)).toEqual(before)
    }).pipe(on(w, table))
  })

  it.effect("an aggregate root under no key its values have had", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create({ id: "r", name: "n", stops: [] })
      const entry = [...table.items.entries()].find(
        ([, item]) => item.__edd_e__?.S === "RouteItem",
      )!
      table.items.delete(entry[0])
      seed(table, {
        pk: DynamoSchema.composeCollectionKey(w.schema, "routes", ["somewhere else"]),
        sk: entry[1].sk!.S,
        id: "r",
        name: "n",
        __edd_e__: "RouteItem",
      })
      const before = keysOf(table)
      const { dry, real } = yield* dryThenReal(db)
      expect(real.skipped.unrecognizedKey).toBe(1)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      expect(keysOf(table)).toEqual(before)
    }).pipe(on(w, table))
  })

  it.effect("a history row under a partition its values never composed, on every run", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      const row = { pk: "$complete#v1#doc#somewhere else", id: "d", title: "t", __edd_e__: "Doc" }
      seed(table, { ...row, sk: DynamoSchema.composeVersionKey(w.schema, "Doc", 1), version: 1 })
      seed(table, {
        ...row,
        sk: DynamoSchema.composeDeletedKey(w.schema, "Doc", "2026-01-02T03:04:05.000Z"),
        deletedAt: "2026-01-02T03:04:05.000Z",
      })
      const before = keysOf(table)
      const { dry, real } = yield* dryThenReal(db)
      expect(real.skipped.unrecognizedKey).toBe(2)
      expect(real.moved.snapshot + real.moved.tombstone).toBe(0)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      expect((yield* db.tables.MainTable.rekey()).skipped.unrecognizedKey).toBe(2)
      expect(keysOf(table)).toEqual(before)
    }).pipe(on(w, table))
  })

  it.effect("a stream's row under a partition its id never composed, or with no id", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      const row = { sk: "e", version: 1, __edd_e__: w.Logs.eventMarker }
      seed(table, { ...row, pk: "$complete#v1#log#somewhere else", streamId: "s" })
      seed(table, { ...row, pk: "$complete#v1#log#no id" })
      const before = keysOf(table)
      const { dry, real } = yield* dryThenReal(db, { streams: [w.Logs] })
      expect(real.skipped.unrecognizedKey).toBe(2)
      expect(real.moved.stream).toBe(0)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      expect(keysOf(table)).toEqual(before)
    }).pipe(on(w, table))
  })

  it.effect("an edge with no root that has gone by the end of the scan isn't counted", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create({
        id: "r 1",
        name: "n",
        stops: [new Stop({ label: "a b", note: "1" }), new Stop({ label: "c", note: "2" })],
      })
      const root = [...table.items.entries()].find(([, item]) => item.__edd_e__?.S === "RouteItem")!
      table.items.delete(root[0])
      const edges = [...table.items.entries()]
      const gone = edges.find(([, item]) => item.label?.S === "c")!
      // A write deletes it after the scan met it.
      table.hooks.onRequest = ({ command, input }) => {
        if (command === "GetItem" && input.Key.sk?.S === gone[1].sk!.S) table.items.delete(gone[0])
      }
      const report = yield* db.tables.MainTable.rekey()
      expect(table.items.has(gone[0])).toBe(false)
      expect(report.skipped.unrecognizedKey).toBe(1)
    }).pipe(on(w, table))
  })

  it.effect("a Z-order row whose value places no key is a failed move, in the dry run too", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      const values = { id: "a b", agency: "x", status: "other" }
      const index = w.Listings.indexes.primary
      seed(table, {
        ...values,
        pk: KeyComposer.composePk(otherText(escapeKeys), "Listing", index, values),
        sk: KeyComposer.composeSk(otherText(escapeKeys), "Listing", 1, index, values),
        __edd_e__: "Listing",
      })
      const before = keysOf(table)
      const { dry, real } = yield* dryThenReal(db)
      expect(real.conflicts.map((conflict) => conflict.reason)).toEqual(["failed"])
      expect(real.moved.item).toBe(0)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      expect(keysOf(table)).toEqual(before)
    }).pipe(on(w, table))
  })
})

describe("a dry run follows the chain", () => {
  // The same scenarios run on DynamoDB Local (`connected.rekey-chains.test.ts`), where both scan
  // orders are met. A table here scans in key order.
  const harness: RekeyChains.Harness = {
    on: (chainWorld, body) => {
      const table = tableOf()
      const provideOn = (member: RekeyChains.ChainWorld) =>
        Layer.merge(table.layer, member.MainTable.layer({ name: "t" }))
      return body({
        seed: (row) => Effect.sync(() => store(table, row)),
        remove: (row) =>
          Effect.sync(() => {
            table.items.delete(`${row.pk!.S}|${row.sk!.S}`)
          }),
        rows: () => Effect.sync(() => [...table.items.values()]),
        as: (member, effect) => effect.pipe(Effect.provide(provideOn(member))) as never,
      }).pipe(Effect.provide(provideOn(chainWorld))) as never
    },
  }
  for (const scenario of RekeyChains.chainScenarios) {
    it.effect(scenario.name, () =>
      Effect.asVoid(scenario.run(harness, RekeyChains.chainOf(scenario.escapeKeys), 1)),
    )
  }
})

describe.each(SETTINGS)("a value landing on another's old rows, %s", (_direction, escapeKeys) => {
  const w = world(escapeKeys)
  const other = world(!escapeKeys)
  const { moving, holder } = chainOf(escapeKeys)
  const logged = [new Logged({ note: "n" })]

  it.effect("a stream's event stays its own: the two aren't merged, and it's reported", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      yield* other.Logs.append({ id: holder }, logged, 0).pipe(on(other, table))
      // `moving` composes the partition `holder` is stored under, and carries on from its events.
      yield* w.Logs.append({ id: moving }, logged, 1)
      const partition = [...table.items.values()][0]!.pk!.S!
      const db = yield* w.client
      const { dry, real } = yield* dryThenReal(db, { streams: [w.Logs] })
      expect(dry.moved.stream).toBe(1)
      expect(real.moved.stream).toBe(0)
      expect(real.conflicts.map((conflict) => conflict.reason)).toEqual(["contended"])
      const rows = [...table.items.values()]
      const landed = rows.find((row) => row.streamId?.S === moving)!
      expect(landed.pk?.S).toBe(partition)
      expect(landed.version?.N).toBe("2")
      expect(rows.filter((row) => row.streamId?.S === moving)).toHaveLength(1)
    }).pipe(on(w, table))
  })
})

describe("a NaN in a key", () => {
  // `NaN` has 1.36's text under off, as it always did, and no key text at all under on.
  const values = { id: "a", level: Number.NaN }
  const stored = (schema: DynamoSchema.DynamoSchema, index: KeyComposer.IndexDefinition) => ({
    [index.pk.field]: KeyComposer.composePk(schema, "Reading", index, values),
    [index.sk.field]: KeyComposer.composeSk(schema, "Reading", 1, index, values),
  })

  it.effect("off: the row is where off composes it, and nothing moves", () => {
    const w = world(false)
    const table = tableOf()
    seed(table, {
      id: "a",
      level: "NaN",
      ...stored(w.schema, w.Readings.indexes.primary),
      ...stored(w.schema, w.Readings.indexes.byLevel),
      __edd_e__: "Reading",
    })
    return Effect.gen(function* () {
      const db = yield* w.client
      const before = [...table.items.values()]
      const report = yield* db.tables.MainTable.rekey()
      expect(report.moved.item).toBe(0)
      expect(report.indexKeysRewritten).toBe(0)
      expect([...table.items.values()]).toEqual(before)
    }).pipe(on(w, table))
  })

  it("on: its text is refused, so a write can't store one", () => {
    const w = world(true)
    expect(() =>
      KeyComposer.composeSk(w.schema, "Reading", 1, w.Readings.indexes.byLevel, values),
    ).toThrow(/EDD-9096/)
  })
})

describe.each(SETTINGS)("an aggregate's move, %s", (_direction, escapeKeys) => {
  const w = world(escapeKeys)
  const old = otherText(escapeKeys)
  const route = {
    id: "r 1",
    name: "n",
    stops: [new Stop({ label: "a b", note: "1" }), new Stop({ label: "c", note: "2" })],
  }
  const textOf = (schema: DynamoSchema.DynamoSchema, value: string) =>
    schema.escapeKeys === true ? value.replace(" ", "%20") : value
  const pkOf = (schema: DynamoSchema.DynamoSchema) => `$complete#v1#routes#${textOf(schema, "r 1")}`
  const stopSk = (schema: DynamoSchema.DynamoSchema, label: string) =>
    `$complete#v1#routestop#${textOf(schema, label)}`
  /** The route as `old` stored it. */
  const asStored = (table: ReturnType<typeof tableOf>) => {
    const rows = [...table.items.values()]
    table.items.clear()
    for (const row of rows) {
      store(table, {
        ...row,
        pk: { S: pkOf(old) },
        ...(row.label === undefined ? {} : { sk: { S: stopSk(old, row.label.S!) } }),
      })
    }
  }

  const cutShort = (table: ReturnType<typeof tableOf>, when: (input: any) => boolean) =>
    Effect.gen(function* () {
      const plain = yield* DynamoClient
      let armed = true
      return {
        ...plain,
        transactWriteItems: (input: any) =>
          armed && when(input)
            ? Effect.suspend(() => {
                armed = false
                return Effect.fail(
                  new DynamoError({
                    operation: "TransactWriteItems",
                    cause: new Error(`cut short after ${table.requests.length} requests`),
                  }),
                )
              })
            : plain.transactWriteItems(input),
      }
    })

  const putsRoot = (input: any) =>
    (input.TransactItems ?? []).some((item: any) => item.Put?.Item?.__edd_e__?.S === "RouteItem")

  it.effect("the root moves last, so a run cut short is finished by the next", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create(route)
      asStored(table)
      expect(new Set(keysOf(table).map(([pk]) => pk))).toEqual(new Set([pkOf(old)]))

      const failed = yield* w.client.pipe(
        Effect.flatMap((cut) => cut.tables.MainTable.rekey()),
        Effect.provide(Layer.effect(DynamoClient, cutShort(table, putsRoot))),
        Effect.flip,
      )
      expect(failed._tag).toBe("DynamoError")
      // The edges are at the current key, and the root still at the old one.
      const during = [...table.items.values()]
      expect(during.find((row) => row.__edd_e__?.S === "RouteItem")?.pk?.S).toBe(pkOf(old))
      expect(
        during.filter((row) => row.__edd_e__?.S === "RouteStop").map((row) => row.pk?.S),
      ).toEqual([pkOf(w.schema), pkOf(w.schema)])

      const dry = yield* db.tables.MainTable.rekey({ dryRun: true })
      const report = yield* db.tables.MainTable.rekey()
      expect(report.conflicts).toEqual([])
      expect(report.moved.aggregate).toBe(1)
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(report))
      const found = yield* db.aggregates.Routes.get({ id: "r 1" })
      expect(found.stops.map((stop) => [stop.label, stop.note]).sort()).toEqual([
        ["a b", "1"],
        ["c", "2"],
      ])
      const again = yield* db.tables.MainTable.rekey()
      expect(again.moved.aggregate).toBe(0)
      expect(again.conflicts).toEqual([])
    }).pipe(on(w, table))
  })

  it.effect("edges left at the old partition with the root moved are counted on every run", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create(route)
      asStored(table)
      // What a 1.37 run cut short could leave: its root moved first.
      const entry = [...table.items.entries()].find(
        ([, item]) => item.__edd_e__?.S === "RouteItem",
      )!
      table.items.delete(entry[0])
      store(table, { ...entry[1], pk: { S: pkOf(w.schema) } })
      const before = keysOf(table)
      const { dry, real } = yield* dryThenReal(db)
      expect(real.skipped.unrecognizedKey).toBe(2)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      expect(keysOf(table)).toEqual(before)
    }).pipe(on(w, table))
  })

  it.effect(
    "one another run moves between the reads of its two partitions isn't under both",
    () => {
      const table = tableOf()
      return Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.Routes.create(route)
        asStored(table)
        const current = JSON.stringify({ S: pkOf(w.schema) })
        let moved = false
        table.hooks.onRequest = ({ command, input }) => {
          if (moved || command !== "Query") return
          if (!JSON.stringify(input.ExpressionAttributeValues ?? {}).includes(current)) return
          moved = true
          // Another `rekey` finishes the whole aggregate, just before this one reads there.
          for (const [stored, row] of [...table.items.entries()]) {
            table.items.delete(stored)
            store(table, {
              ...row,
              pk: { S: pkOf(w.schema) },
              ...(row.label === undefined ? {} : { sk: { S: stopSk(w.schema, row.label.S!) } }),
            })
          }
        }
        const report = yield* db.tables.MainTable.rekey()
        expect(moved).toBe(true)
        expect(report.conflicts).toEqual([])
        expect(report.moved.aggregate).toBe(0)
        const found = yield* db.aggregates.Routes.get({ id: "r 1" })
        expect(found.stops).toHaveLength(2)
      }).pipe(on(w, table))
    },
  )

  // A run cut short left the edges at the current key with the root still at the old one, and the
  // scan meets the edges first. The value decides the order: a table scans in key order here.
  const edgesFirst = escapeKeys ? "%z" : "r 1"
  const bounded = {
    ...route,
    id: edgesFirst,
  }
  /** The bounded run's rows: edges where the move put them, root where it was. */
  const halfMoved = (table: ReturnType<typeof tableOf>) => {
    const pkFor = (schema: DynamoSchema.DynamoSchema) =>
      DynamoSchema.composeCollectionKey(schema, "routes", [
        KeyComposer.keyText(schema, edgesFirst, "lowercase"),
      ])
    const entry = [...table.items.entries()].find(([, item]) => item.__edd_e__?.S === "RouteItem")!
    table.items.delete(entry[0])
    store(table, { ...entry[1], pk: { S: pkFor(old) } })
    const rows = [...table.items.values()].map((row) => row.pk?.S).sort()
    expect(rows[0]).toBe(pkFor(w.schema))
    expect(rows.at(-1)).toBe(pkFor(old))
  }

  it.effect("a run that stopped before the root says nothing of the edges it met", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create(bounded)
      halfMoved(table)
      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({
        dryRun: true,
        pageSize: 1,
        maxPages: 1,
      })
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({
        pageSize: 1,
        maxPages: 1,
      })
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(report))
      expect(report.scanned).toBe(1)
      expect(report.resume._tag).toBe("Some")
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(report.skipped.rootNotSeen).toBe(1)
    }).pipe(on(w, table))
  })

  it.effect("a run over the whole table judges them, with no read for a rooted edge", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create(bounded)
      halfMoved(table)
      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({
        dryRun: true,
        pageSize: 1,
      })
      expect(dry.skipped.unrecognizedKey).toBe(0)
      expect(dry.skipped.rootNotSeen).toBe(0)
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({ pageSize: 1 })
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(report.skipped.rootNotSeen).toBe(0)
      expect(report.moved.aggregate).toBe(1)
    }).pipe(on(w, table))
  })

  it.effect("a run resumed part way can't judge them either, whichever page held the root", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create(bounded)
      halfMoved(table)
      // A dry run moves nothing, so what it learned of the root on an earlier page is gone.
      const pages: Array<Table.RekeyReport> = []
      let resume: string | undefined
      do {
        const page: Table.RekeyReport = yield* db.tables.MainTable.rekey({
          dryRun: true,
          pageSize: 1,
          maxPages: 1,
          ...(resume === undefined ? {} : { resume }),
        })
        pages.push(page)
        resume = page.resume._tag === "Some" ? page.resume.value : undefined
      } while (resume !== undefined)
      expect(pages.length).toBeGreaterThan(1)
      expect(pages.map((page) => page.skipped.unrecognizedKey)).toEqual(pages.map(() => 0))
    }).pipe(on(w, table))
  })

  it.effect("a real orphan stays unjudged in a bounded run and is counted over the table", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create(bounded)
      const root = [...table.items.entries()].find(([, item]) => item.__edd_e__?.S === "RouteItem")!
      table.items.delete(root[0])
      const part: Table.RekeyReport = yield* db.tables.MainTable.rekey({ pageSize: 1, maxPages: 1 })
      expect(part.skipped.unrecognizedKey).toBe(0)
      expect(part.skipped.rootNotSeen).toBe(1)
      const whole: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(whole.skipped.unrecognizedKey).toBe(2)
      expect(whole.skipped.rootNotSeen).toBe(0)
    }).pipe(on(w, table))
  })

  it.effect("the fix adds no read to a run over the whole table", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create(bounded)
      const root = [...table.items.entries()].find(([, item]) => item.__edd_e__?.S === "RouteItem")!
      table.items.delete(root[0])
      table.take()
      yield* db.tables.MainTable.rekey()
      // Two edges: the root's read for each as the scan meets it, and each edge read again after.
      expect(table.take().map((request) => request.command)).toEqual([
        "Scan",
        "GetItem",
        "GetItem",
        "GetItem",
        "GetItem",
      ])
    }).pipe(on(w, table))
  })

  it.effect("segments meeting one aggregate move it once, and edges wait for the move", () => {
    const table = tableOf()
    return Effect.gen(function* () {
      const db = yield* w.client
      yield* db.aggregates.Routes.create(route)
      asStored(table)
      const report = yield* db.tables.MainTable.rekey({ segments: 4, concurrency: 4 })
      expect(report.conflicts).toEqual([])
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(report.moved.aggregate).toBe(3)
    }).pipe(on(w, table))
  })
})

describe.each(SETTINGS)("a Z-order index's text, %s", (_direction, escapeKeys) => {
  const w = world(escapeKeys)
  const old = otherText(escapeKeys)
  const index = w.Listings.indexes.byAgency
  const values = { id: "plain", agency: "x y", status: "open" as const }

  it.effect("prefix bytes under the other setting are rewritten, with the partition half", () => {
    const table = tableOf()
    const primary = w.Listings.indexes.primary
    const current = KeyComposer.composeZOrderSk(w.schema, index, values)
    const stored = KeyComposer.composeZOrderSk(old, index, values)
    expect(Array.from(stored)).not.toEqual(Array.from(current))
    seed(table, {
      ...values,
      pk: KeyComposer.composePk(w.schema, "Listing", primary, values),
      sk: KeyComposer.composeSk(w.schema, "Listing", 1, primary, values),
      gsi2pk: KeyComposer.composePk(old, "Listing", index, values),
      gsi2sk: stored,
      __edd_e__: "Listing",
    })
    return Effect.gen(function* () {
      const db = yield* w.client
      const { dry, real } = yield* dryThenReal(db)
      expect(real.indexKeysRewritten).toBe(1)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      const [row] = [...table.items.values()]
      expect(row?.gsi2pk?.S).toBe(KeyComposer.composePk(w.schema, "Listing", index, values))
      expect(Array.from(row!.gsi2sk!.B as Uint8Array)).toEqual(Array.from(current))
      expect((yield* db.tables.MainTable.rekey()).indexKeysRewritten).toBe(0)
    }).pipe(on(w, table))
  })
})
