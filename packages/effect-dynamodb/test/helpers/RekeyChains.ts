/**
 * A dry run follows the chain (D88), on sentinels, streams and aggregates. One value's current key
 * is where the other value is stored under the other setting: `foo bar` escapes to where `foo%20bar`
 * is stored raw, and going back, `foo%20bar` is where `foo bar` is stored escaped. So the second has
 * to move first, and when it can't, neither does: the real run reports both, the one that can't and
 * the one it holds up, and the dry run says the same.
 *
 * These run on a recording table (`RekeyCompleteness.test.ts`) and on DynamoDB Local
 * (`connected.rekey-chains.test.ts`). A recording table scans in key order, so one order only per
 * direction; DynamoDB scans in hash order, so `values` decides which of the two the scan meets
 * first, and the connected suite asserts both orders are met.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"
import { rekeyOutcome } from "./RekeyOutcome.js"

type StoredRow = Record<string, any>

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

class Logged extends Schema.TaggedClass<Logged>()("Logged", { note: Schema.String }) {}

const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "chains", version: 1, escapeKeys })
  const Accounts = Entity.make({
    model: Account,
    entityType: "Account",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    unique: { email: ["email"] },
  })
  const MainTable = Table.make({ schema, entities: { Accounts } })
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
    entities: { Accounts },
    aggregates: { Routes },
    tables: { MainTable },
  })
  return { schema, Accounts, Logs, Routes, MainTable, client }
}

export type ChainWorld = ReturnType<typeof world>

export interface Harness {
  /** Run `body` on a fresh table, under `world`'s setting. */
  readonly on: <A, E>(
    world: ChainWorld,
    body: (table: StoredRows) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

export interface StoredRows {
  /** Store a row as it is, replacing what's at its key. */
  readonly seed: (row: StoredRow) => Effect.Effect<void, unknown, any>
  /** Delete the row at this row's key. */
  readonly remove: (row: StoredRow) => Effect.Effect<void, unknown, any>
  /** Every stored row, in the order a scan meets them. */
  readonly rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown, any>
  /** Run `body` under another world's setting, on this table. */
  readonly as: <A, E>(world: ChainWorld, body: Effect.Effect<A, E, any>) => Effect.Effect<A, E, any>
}

/** Two values, the first's current key being where the second is stored under the other setting. */
export interface Chain {
  readonly moving: string
  readonly holder: string
}

/** The pair for a stem, `foo bar` going on and `foo%20bar` going off. */
export const chainOf = (escapeKeys: boolean, stem = "foo"): Chain =>
  escapeKeys
    ? { moving: `${stem} bar`, holder: `${stem}%20bar` }
    : { moving: `${stem}%20bar`, holder: `${stem} bar` }

/** Which of the two a scan meets first. */
export type Met = "moving first" | "holder first"

const metFirst = (
  rows: ReadonlyArray<StoredRow>,
  was: DynamoSchema.DynamoSchema,
  values: Chain,
  isRow: (row: StoredRow) => boolean,
): Met => {
  const textOf = (value: string) => KeyComposer.keyText(was, value, "lowercase")
  const at = (value: string) =>
    rows.findIndex((row) => isRow(row) && String(row.pk?.S).includes(textOf(value)))
  const moving = at(values.moving)
  const holder = at(values.holder)
  expect(moving).toBeGreaterThanOrEqual(0)
  expect(holder).toBeGreaterThanOrEqual(0)
  return moving < holder ? "moving first" : "holder first"
}

const byKey = (rows: ReadonlyArray<StoredRow>) =>
  rows.map((row) => `${row.pk?.S}|${row.sk?.S}`).sort()

const dryThenReal = (db: any, options: Record<string, unknown>) =>
  Effect.gen(function* () {
    const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ ...options, dryRun: true })
    const real: Table.RekeyReport = yield* db.tables.MainTable.rekey(options)
    return { dry, real }
  })

/** What a run decided, in an order that doesn't depend on which segment got there first. */
const decided = (report: Table.RekeyReport) => {
  const { conflicts, ...rest } = rekeyOutcome(report)
  return {
    ...rest,
    conflicts: [...conflicts].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  }
}

const logged = [new Logged({ note: "n" })]

const isSentinel = (row: StoredRow) => row.__edd_e__ === undefined || row._entity_pk !== undefined

export interface ChainScenario {
  readonly name: string
  readonly escapeKeys: boolean
  readonly run: (h: Harness, values: Chain, segments: number) => Effect.Effect<Met, unknown>
}

const scenario = (
  escapeKeys: boolean,
  name: string,
  run: (
    now: ChainWorld,
    was: ChainWorld,
    table: StoredRows,
    values: Chain,
    options: { readonly segments: number },
  ) => Effect.Effect<Met, unknown, any>,
): ChainScenario => ({
  name: `${escapeKeys ? "to on" : "to off"}: ${name}`,
  escapeKeys,
  run: (h, values, segments) => {
    const now = world(escapeKeys)
    const was = world(!escapeKeys)
    return h.on(now, (table) => run(now, was, table, values, { segments }))
  },
})

export const chainScenarios: ReadonlyArray<ChainScenario> = [true, false].flatMap((escapeKeys) => [
  scenario(
    escapeKeys,
    "a sentinel's key held by one that can't move: neither moves",
    (now, was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        yield* table.as(
          was,
          Effect.gen(function* () {
            const db = yield* was.client
            yield* db.entities.Accounts.put({ id: "a", email: moving }).asEffect()
            yield* db.entities.Accounts.put({ id: "b", email: holder }).asEffect()
          }),
        )
        const met = metFirst(yield* table.rows(), was.schema, { moving, holder }, isSentinel)
        const db = yield* now.client
        // A duplicate of the holder's value, landed before `rekey`: its sentinel's current key is taken.
        yield* db.entities.Accounts.put({ id: "c", email: holder }).asEffect()
        const before = byKey(yield* table.rows())
        const { dry, real } = yield* dryThenReal(db, options)
        expect(decided(dry)).toEqual(decided(real))
        expect(real.sentinelsMoved).toBe(0)
        expect(real.conflicts.map((conflict) => conflict.reason)).toEqual(["taken", "taken"])
        expect(byKey(yield* table.rows())).toEqual(before)
        return met
      }),
  ),
  scenario(
    escapeKeys,
    "a sentinel's key held by one that can move: both move",
    (now, was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        yield* table.as(
          was,
          Effect.gen(function* () {
            const db = yield* was.client
            yield* db.entities.Accounts.put({ id: "a", email: moving }).asEffect()
            yield* db.entities.Accounts.put({ id: "b", email: holder }).asEffect()
          }),
        )
        const met = metFirst(yield* table.rows(), was.schema, { moving, holder }, isSentinel)
        const db = yield* now.client
        const { dry, real } = yield* dryThenReal(db, options)
        expect(real.conflicts).toEqual([])
        expect(real.sentinelsMoved).toBe(2)
        // Both items' sentinels move, so neither item is left as it was, whichever pass moved
        // which sentinel.
        expect(real.unchanged).toBe(0)
        expect(decided(dry)).toEqual(decided(real))
        // Each value is taken under its current key, by its own row.
        const stored = yield* table.rows()
        expect(
          stored
            .filter(isSentinel)
            .map((row) => row.pk?.S)
            .sort(),
        ).toEqual(
          [moving, holder]
            .map(
              (email) =>
                DynamoSchema.composeUniqueKey(now.schema, "Account", "email", [
                  KeyComposer.keyText(now.schema, email, "lowercase"),
                ]).pk,
            )
            .sort(),
        )
        expect(
          yield* Effect.flip(db.entities.Accounts.put({ id: "d", email: moving }).asEffect()),
        ).toMatchObject({
          _tag: "UniqueConstraintViolation",
        })
        expect(
          yield* Effect.flip(db.entities.Accounts.put({ id: "e", email: holder }).asEffect()),
        ).toMatchObject({
          _tag: "UniqueConstraintViolation",
        })
        return met
      }),
  ),
  scenario(
    escapeKeys,
    "a stream's partition held by one that can't move: neither moves",
    (now, was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        yield* table.as(
          was,
          Effect.gen(function* () {
            yield* was.Logs.append({ id: moving }, logged, 0)
            yield* was.Logs.append({ id: holder }, logged, 0)
          }),
        )
        const seeded = yield* table.rows()
        const met = metFirst(seeded, was.schema, { moving, holder }, () => true)
        // Rows of no stream we know, where the holder belongs.
        const known = new Set(byKey(seeded))
        yield* now.Logs.append({ id: holder }, logged, 0)
        for (const row of yield* table.rows()) {
          if (!known.has(`${row.pk?.S}|${row.sk?.S}`)) {
            yield* table.seed({ ...row, streamId: { S: "zzz" } })
          }
        }
        const db = yield* now.client
        const before = byKey(yield* table.rows())
        const { dry, real } = yield* dryThenReal(db, { ...options, streams: [now.Logs] })
        expect(decided(dry)).toEqual(decided(real))
        expect(real.moved.stream).toBe(0)
        expect(real.conflicts.map((conflict) => conflict.reason).sort()).toEqual([
          "bothKeys",
          "taken",
        ])
        expect(byKey(yield* table.rows())).toEqual(before)
        return met
      }),
  ),
  scenario(
    escapeKeys,
    "a stream's partition held by one that can move: both move",
    (now, was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        yield* table.as(
          was,
          Effect.gen(function* () {
            yield* was.Logs.append({ id: moving }, logged, 0)
            yield* was.Logs.append({ id: holder }, logged, 0)
          }),
        )
        const met = metFirst(yield* table.rows(), was.schema, { moving, holder }, () => true)
        const db = yield* now.client
        const { dry, real } = yield* dryThenReal(db, { ...options, streams: [now.Logs] })
        expect(real.conflicts).toEqual([])
        expect(real.moved.stream).toBe(2)
        expect(decided(dry)).toEqual(decided(real))
        // Each carries on from its own event, with nothing merged.
        yield* now.Logs.append({ id: moving }, logged, 1)
        yield* now.Logs.append({ id: holder }, logged, 1)
        return met
      }),
  ),
  scenario(
    escapeKeys,
    "an aggregate's partition held by one that can't move: neither moves",
    (now, was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        yield* table.as(
          was,
          Effect.gen(function* () {
            const db = yield* was.client
            yield* db.aggregates.Routes.create({ id: moving, name: "n", stops: [] })
            yield* db.aggregates.Routes.create({ id: holder, name: "n", stops: [] })
          }),
        )
        const seeded = yield* table.rows()
        const met = metFirst(seeded, was.schema, { moving, holder }, () => true)
        // It can't be assembled, so it can't be moved.
        const held = seeded.find((row) => row.id?.S === holder)!
        const { name: _name, ...undecodable } = held
        yield* table.seed(undecodable)
        const db = yield* now.client
        const before = byKey(yield* table.rows())
        const { dry, real } = yield* dryThenReal(db, options)
        expect(decided(dry)).toEqual(decided(real))
        expect(real.moved.aggregate).toBe(0)
        expect(real.conflicts.map((conflict) => conflict.reason).sort()).toEqual([
          "failed",
          "taken",
        ])
        expect(byKey(yield* table.rows())).toEqual(before)
        return met
      }),
  ),
  scenario(
    escapeKeys,
    "an aggregate's partition held by one that can move: both move",
    (now, was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        yield* table.as(
          was,
          Effect.gen(function* () {
            const db = yield* was.client
            yield* db.aggregates.Routes.create({ id: moving, name: "n", stops: [] })
            yield* db.aggregates.Routes.create({ id: holder, name: "n", stops: [] })
          }),
        )
        const met = metFirst(yield* table.rows(), was.schema, { moving, holder }, () => true)
        const db = yield* now.client
        const { dry, real } = yield* dryThenReal(db, options)
        expect(real.conflicts).toEqual([])
        expect(real.moved.aggregate).toBe(2)
        expect(decided(dry)).toEqual(decided(real))
        expect(yield* db.aggregates.Routes.get({ id: moving })).toMatchObject({ id: moving })
        expect(yield* db.aggregates.Routes.get({ id: holder })).toMatchObject({ id: holder })
        return met
      }),
  ),
  scenario(
    escapeKeys,
    "an aggregate with edges, held by another with edges that can move: every row moves",
    (now, was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        const stops = [
          new Stop({ label: "a", note: "n" }),
          new Stop({ label: "b", note: "n" }),
          new Stop({ label: "c", note: "n" }),
        ]
        yield* table.as(
          was,
          Effect.gen(function* () {
            const db = yield* was.client
            yield* db.aggregates.Routes.create({ id: moving, name: "n", stops })
            yield* db.aggregates.Routes.create({ id: holder, name: "n", stops })
          }),
        )
        const met = metFirst(yield* table.rows(), was.schema, { moving, holder }, () => true)
        const db = yield* now.client
        const { dry, real } = yield* dryThenReal(db, options)
        expect(real.conflicts).toEqual([])
        expect(real.skipped.unrecognizedKey).toBe(0)
        // A row each: two roots and their three edges.
        expect(real.moved.aggregate).toBe(8)
        expect(decided(dry)).toEqual(decided(real))
        expect(yield* db.aggregates.Routes.get({ id: moving })).toMatchObject({ stops })
        expect(yield* db.aggregates.Routes.get({ id: holder })).toMatchObject({ stops })
        expect(yield* db.tables.MainTable.rekey()).toMatchObject({
          moved: { aggregate: 0 },
          skipped: { unrecognizedKey: 0 },
          conflicts: [],
        })
        return met
      }),
  ),
  scenario(
    escapeKeys,
    "an aggregate with edges, held by one that can't move: nothing moves and no edge is counted",
    (now, was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        const stops = [new Stop({ label: "a", note: "n" }), new Stop({ label: "b", note: "n" })]
        yield* table.as(
          was,
          Effect.gen(function* () {
            const db = yield* was.client
            yield* db.aggregates.Routes.create({ id: moving, name: "n", stops })
            yield* db.aggregates.Routes.create({ id: holder, name: "n", stops })
          }),
        )
        const seeded = yield* table.rows()
        const met = metFirst(seeded, was.schema, { moving, holder }, () => true)
        const held = seeded.find((row) => row.__edd_e__?.S === "RouteItem" && row.id?.S === holder)!
        const { name: _name, ...undecodable } = held
        yield* table.seed(undecodable)
        const db = yield* now.client
        const before = byKey(yield* table.rows())
        const { dry, real } = yield* dryThenReal(db, options)
        expect(decided(dry)).toEqual(decided(real))
        expect(real.moved.aggregate).toBe(0)
        expect(real.skipped.unrecognizedKey).toBe(0)
        expect(real.conflicts.map((conflict) => conflict.reason).sort()).toEqual([
          "failed",
          "taken",
        ])
        expect(byKey(yield* table.rows())).toEqual(before)
        return met
      }),
  ),
  scenario(
    escapeKeys,
    "a move cut short, the root at the old key and its edges here: the root comes to them",
    (now, was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        const stops = [new Stop({ label: "a", note: "n" }), new Stop({ label: "b", note: "n" })]
        const db = yield* now.client
        yield* db.aggregates.Routes.create({ id: holder, name: "n", stops })
        const seeded = yield* table.rows()
        const root = seeded.find((row) => row.__edd_e__?.S === "RouteItem")!
        yield* table.remove(root)
        const old = DynamoSchema.composeCollectionKey(was.schema, "routes", [
          KeyComposer.keyText(was.schema, holder, "lowercase"),
        ])
        yield* table.seed({ ...root, pk: { S: old } })
        // Which the scan meets first: the root at its old key, or an edge at the current one.
        const rows = yield* table.rows()
        const first = rows.findIndex((row) => row.pk?.S === old)
        const met: Met = first === 0 ? "moving first" : "holder first"
        const { dry, real } = yield* dryThenReal(db, options)
        expect(real.conflicts).toEqual([])
        expect(real.skipped.unrecognizedKey).toBe(0)
        expect(real.skipped.rootNotSeen).toBe(0)
        expect(real.moved.aggregate).toBe(1)
        expect(decided(dry)).toEqual(decided(real))
        expect(yield* db.aggregates.Routes.get({ id: holder })).toMatchObject({ stops })
        expect(moving).not.toBe(holder)
        return met
      }),
  ),
  scenario(
    escapeKeys,
    "edges whose root is gone are counted in both runs, whichever order they met",
    (now, _was, table, { moving, holder }, options) =>
      Effect.gen(function* () {
        const stops = [new Stop({ label: "a", note: "n" }), new Stop({ label: "b", note: "n" })]
        const db = yield* now.client
        yield* db.aggregates.Routes.create({ id: moving, name: "n", stops })
        yield* db.aggregates.Routes.create({ id: holder, name: "n", stops })
        const seeded = yield* table.rows()
        const orphaned = seeded.find(
          (row) => row.__edd_e__?.S === "RouteItem" && row.id?.S === holder,
        )!
        yield* table.remove(orphaned)
        const rows = yield* table.rows()
        const firstOrphan = rows.findIndex((row) => row.pk?.S === orphaned.pk?.S)
        const firstOther = rows.findIndex((row) => row.pk?.S !== orphaned.pk?.S)
        const met: Met = firstOther < firstOrphan ? "moving first" : "holder first"
        const { dry, real } = yield* dryThenReal(db, options)
        expect(real.skipped.unrecognizedKey).toBe(2)
        expect(real.skipped.rootNotSeen).toBe(0)
        expect(decided(dry)).toEqual(decided(real))
        return met
      }),
  ),
])
