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
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
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
  const MainTable = Table.make({ schema, entities: { Accounts, Readings, Listings } })
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
    entities: { Accounts, Readings, Listings },
    aggregates: { Routes },
    tables: { MainTable },
  })
  return { schema, Accounts, Readings, Listings, Routes, MainTable, client }
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

const dryThenReal = (db: any) =>
  Effect.gen(function* () {
    const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
    const real: Table.RekeyReport = yield* db.tables.MainTable.rekey()
    return { dry, real }
  })

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
