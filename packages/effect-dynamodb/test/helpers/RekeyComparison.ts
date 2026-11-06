/**
 * What `rekey` compares (#183, design §9.2, D58): a stored key against what the other settings and
 * releases composed from the row's values. Nothing reads a value out of a stored key, and a half
 * only ever touches a key that is one of its own texts, so the risk is the other way round: a key
 * a write stored that `rekey` then touches. After each write here the stored rows must be exactly
 * what they were. A scenario that moves a row runs in both directions, and the rest follow the
 * run's setting. These scenarios run on a recording table (`RekeyComparison.test.ts`) and on
 * DynamoDB Local (`connected.sharding.test.ts`).
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DateTime, Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { toAttributeMap } from "../../src/Marshaller.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { rekeyOutcome } from "./RekeyOutcome.js"

type StoredRow = Record<string, any>

/** What a scenario needs of a table. */
export interface Harness {
  /** Run `body` with a client over `world`'s member, on a table made from its definition. */
  readonly on: <A, E>(
    world: { readonly MainTable: any; readonly Rows: any },
    body: (db: any, table: StoredRows) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

export interface StoredRows {
  /** Store a row as it is. */
  readonly seed: (row: StoredRow) => Effect.Effect<void, unknown, any>
  /** Every stored row. */
  readonly rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown, any>
}

export const clientOf = (world: { readonly MainTable: any; readonly Rows: any }) =>
  DynamoClient.make({
    entities: { Rows: world.Rows },
    tables: { MainTable: world.MainTable },
  }) as Effect.Effect<any, never, any>

const worldOf = (
  model: any,
  primaryKey: unknown,
  indexes: unknown,
  options: Record<string, unknown> = {},
  on: DynamoSchema.DynamoSchema = DynamoSchema.make({ name: "compared", version: 1 }),
) => {
  const Rows = Entity.make({
    model,
    entityType: "Row",
    primaryKey,
    indexes,
    ...options,
  } as never) as any
  return { Rows, MainTable: Table.make({ schema: on, entities: { Rows } }) }
}

const byKey = (rows: ReadonlyArray<StoredRow>) =>
  [...rows].sort((a, b) => (`${a.pk?.S}|${a.sk?.S}` < `${b.pk?.S}|${b.sk?.S}` ? -1 : 1))

/**
 * A run over what the writes left: every row is judged, none is touched. It compares the
 * stored rows whole, which is what makes this more than `rekey` reporting no work.
 */
const nothingToDo = (db: any, table: StoredRows) =>
  Effect.gen(function* () {
    const before = byKey(yield* table.rows())
    const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
    expect(report.conflicts).toEqual([])
    expect(report.indexKeysRewritten).toBe(0)
    expect(report.skipped).toEqual({
      notLibrary: 0,
      unregistered: 0,
      unrecognizedKey: 0,
      rootNotSeen: 0,
    })
    expect(before.length).toBeGreaterThan(0)
    expect(report.unchanged).toBe(before.length)
    expect(byKey(yield* table.rows())).toEqual(before)
  })

const key = { tenant: "t", id: "1" }
const primaryKey = {
  pk: { field: "pk", composite: ["tenant"] },
  sk: { field: "sk", composite: ["id"] },
} as const

class Kinds extends Schema.Class<Kinds>("Kinds")({
  tenant: Schema.String,
  id: Schema.String,
  text: Schema.String,
  count: Schema.Number,
  whole: Schema.Number,
  big: Schema.BigInt,
  bigText: Schema.BigIntFromString,
  at: Schema.DateTimeUtc,
  atText: Schema.DateTimeUtcFromString,
  day: Schema.Date,
  flag: Schema.Boolean,
  kind: Schema.Literals(["Open", "closed"]),
  encoded: Schema.NumberFromString,
  epoch: Schema.DateTimeUtc,
  renamed: Schema.String,
  note: Schema.optional(Schema.String),
}) {}

const KIND_FIELDS = [
  "text",
  "count",
  "whole",
  "big",
  "bigText",
  "at",
  "atText",
  "day",
  "flag",
  "kind",
  "encoded",
  "epoch",
  "renamed",
] as const

const instant = (iso: string) => DateTime.makeUnsafe(iso)

const kindsOf = (count: number) => ({
  ...key,
  text: "A b%#",
  count,
  whole: 7,
  big: -5n,
  bigText: 12345678901234567890123n,
  at: instant("2026-01-02T03:04:05.678Z"),
  atText: instant("2026-01-02T03:04:05.678Z"),
  day: new Date("2026-01-02T03:04:05.678Z"),
  flag: true,
  kind: "Open" as const,
  encoded: -2.5,
  epoch: instant("2026-01-02T03:04:05.000Z"),
  renamed: "r",
})

const kindsWorld = (options: Record<string, unknown> = {}) =>
  worldOf(
    DynamoModel.configure(Kinds, {
      epoch: { storedAs: DynamoModel.DateEpochSeconds },
      renamed: { field: "stored_as" },
    }),
    primaryKey,
    Object.fromEntries(
      KIND_FIELDS.map((field, i) => [
        `by${field}`,
        {
          name: `gsi${i}`,
          pk: { field: `p${i}`, composite: [field] },
          sk: { field: `s${i}`, composite: [field] },
        },
      ]),
    ),
    options,
  )

/** The composites in `Kinds`, in each half: `rekey` leaves what a write stored. */
export const compositeKindScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  { name: "an ordinary row", options: {} },
  { name: "with retained versions", options: { versioned: { retain: true } } },
].map(({ name, options }) => ({
  name,
  run: (h: Harness) =>
    h.on(kindsWorld(options), (db, table) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put(kindsOf(-2.5)).asEffect()
        yield* nothingToDo(db, table)
        const { tenant: _tenant, id: _id, ...updates } = kindsOf(123.25)
        yield* db.entities.Rows.update(key).set(updates).asEffect()
        yield* nothingToDo(db, table)
        yield* db.entities.Rows.update(key).set({ note: "n" }).asEffect()
        yield* nothingToDo(db, table)
      }),
    ),
}))

class Shaped extends Schema.Class<Shaped>("Shaped")({
  tenant: Schema.String,
  id: Schema.String,
  region: Schema.optional(Schema.String),
  zone: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  count: Schema.optional(Schema.Number),
  extra: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
}) {}

const half = (i: number, composite: ReadonlyArray<string>) => ({
  pk: { field: `p${i}`, composite: ["tenant"] },
  sk: { field: `s${i}`, composite },
})

const SHAPES = {
  hierarchical: { name: "gsi0", ...half(0, ["region", "zone", "group"]) },
  emptySortKey: { name: "gsi1", ...half(1, []) },
  keyComposites: { name: "gsi2", ...half(2, ["id"]) },
  mixed: { name: "gsi3", ...half(3, ["region", "id"]) },
  twoWriters: {
    name: "gsi4",
    pk: { field: "p4", composite: ["note"] },
    sk: { field: "s4", composite: ["group"] },
  },
  isolated: { name: "gsi5", ...half(5, ["group"]), collection: "isolated" },
  clustered: { name: "gsi6", ...half(6, ["group"]), collection: "clustered", type: "clustered" },
  preserved: { name: "gsi7", ...half(7, ["region"]), casing: "preserve" },
  sharded: { name: "gsi8", ...half(8, ["region"]), shards: 8 },
  shardedBy: { name: "gsi9", ...half(9, ["group"]), shards: { count: 8, by: ["group"] } },
  zOrder: {
    name: "gsi10",
    pk: { field: "p10", composite: ["tenant"] },
    sk: { field: "s10", zorder: [{ field: "count", min: -100, max: 100 }] },
  },
  shardedZOrder: {
    name: "gsi11",
    pk: { field: "p11", composite: ["tenant"] },
    sk: { field: "s11", zorder: [{ field: "count", min: -100, max: 100 }] },
    shards: 8,
  },
  created: { name: "gsi12", ...half(12, ["createdAt"]) },
  updated: { name: "gsi14", ...half(14, ["updatedAt"]) },
  local: {
    name: "lsi0",
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "lsk", composite: ["region"] },
  },
  sharedSortKey: {
    name: "gsi13",
    pk: { field: "p13", composite: ["region"] },
    sk: { field: "sk", composite: ["id"] },
  },
}

const shapedWorld = (options: Record<string, unknown> = {}) =>
  worldOf(Shaped, primaryKey, SHAPES, { timestamps: true, ...options })

const WHOLE = { region: "Us East", zone: "Z 1", group: "G%", note: "n", count: -3 }

/** The indexes of `SHAPES` through these writes. `otherWritePathScenarios` has the rest. */
export const writePathScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = (
  [
    {
      name: "put",
      run: (db) => db.entities.Rows.put({ ...key, ...WHOLE }).asEffect(),
    },
    {
      name: "put with no optional composite",
      run: (db) => db.entities.Rows.put(key).asEffect(),
    },
    {
      name: "create",
      run: (db) => db.entities.Rows.create({ ...key, ...WHOLE }).asEffect(),
    },
    {
      name: "create with no optional composite",
      run: (db) => db.entities.Rows.create(key).asEffect(),
    },
    {
      name: "Batch.write",
      run: (_db, world) => Batch.write([world.Rows.put({ ...key, ...WHOLE })]),
    },
    {
      name: "Batch.write with no optional composite",
      run: (_db, world) => Batch.write([world.Rows.put(key)]),
    },
    {
      name: "upsert",
      run: (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.upsert({ ...key, ...WHOLE }).asEffect()
          yield* db.entities.Rows.upsert({ ...key, ...WHOLE, group: "G2" }).asEffect()
        }),
    },
    {
      name: "an update naming every composite",
      run: (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
          yield* db.entities.Rows.update(key)
            .set({ ...WHOLE, region: "Elsewhere", count: 4 })
            .asEffect()
        }),
    },
    {
      name: "an update naming none",
      run: (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
          yield* db.entities.Rows.update(key).set({ extra: "x" }).asEffect()
        }),
    },
    {
      name: "an update naming one composite: the keys lag the row",
      run: (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
          yield* db.entities.Rows.update(key).set({ zone: "Z 2" }).asEffect()
        }),
    },
    {
      name: "a composite removed: the structural rule truncates",
      run: (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
          yield* db.entities.Rows.update(key).remove(["group", "count"]).asEffect()
        }),
    },
    {
      name: "a composite cleared: the same write as removing it",
      run: (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
          yield* db.entities.Rows.update(key).set({ note: undefined, zone: undefined }).asEffect()
        }),
    },
  ] as ReadonlyArray<{
    readonly name: string
    readonly run: (db: any, world: any) => Effect.Effect<unknown, unknown, any>
  }>
).map(({ name, run }) => ({
  name,
  run: (h: Harness) => {
    const world = shapedWorld()
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* run(db, world)
        yield* nothingToDo(db, table)
      }),
    )
  },
}))

class Appended extends Schema.Class<Appended>("Appended")({
  tenant: Schema.String,
  id: Schema.String,
  at: Schema.Number,
  region: Schema.optional(Schema.String),
  zone: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
}) {}

/** A transaction's update, a retained update and `append`: the writes with a path of their own. */
export const otherWritePathScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  {
    name: "a transaction's update",
    run: (h: Harness) => {
      const world = shapedWorld()
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
          yield* Transaction.transactWrite([
            world.Rows.update(key).pipe(Entity.set({ ...WHOLE, region: "Elsewhere", count: 4 })),
          ])
          yield* nothingToDo(db, table)
        }),
      )
    },
  },
  {
    name: "a retained update",
    run: (h: Harness) =>
      h.on(shapedWorld({ versioned: { retain: true } }), (db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
          yield* nothingToDo(db, table)
          yield* db.entities.Rows.update(key).set({ extra: "x" }).asEffect()
          yield* nothingToDo(db, table)
          yield* db.entities.Rows.update(key).set({ note: undefined }).asEffect()
          yield* nothingToDo(db, table)
          yield* db.entities.Rows.update(key).remove(["group"]).asEffect()
          yield* nothingToDo(db, table)
        }),
      ),
  },
  {
    name: "append",
    run: (h: Harness) =>
      h.on(
        worldOf(
          Appended,
          primaryKey,
          {
            hierarchical: { name: "gsi0", ...half(0, ["region", "zone", "group"]) },
            emptySortKey: { name: "gsi1", ...half(1, []) },
            sharded: { name: "gsi8", ...half(8, ["region"]), shards: 8 },
          },
          {
            timeSeries: {
              orderBy: "at",
              appendInput: Schema.Struct({
                tenant: Schema.String,
                id: Schema.String,
                at: Schema.Number,
                region: Schema.optional(Schema.String),
                zone: Schema.optional(Schema.String),
                group: Schema.optional(Schema.String),
              }),
            },
          },
        ),
        (db, table) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.append({ ...key, at: 1, region: "Us East", zone: "Z 1" })
            yield* nothingToDo(db, table)
            yield* db.entities.Rows.append({
              ...key,
              at: 2,
              region: "Us East",
              zone: "Z 2",
              group: "G%",
            })
            yield* nothingToDo(db, table)
          }),
      ),
  },
]

class Flat extends Schema.Class<Flat>("Flat")({
  tenant: Schema.String,
  id: Schema.String,
  status: Schema.String,
  count: Schema.Number,
  region: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
}) {}

/** A row under its table key, its index keys as `indexKeys` says, whatever its values. */
const rowOf = (
  world: any,
  values: Record<string, unknown>,
  indexKeys: Record<string, string>,
  schema: DynamoSchema.DynamoSchema = DynamoSchema.make({ name: "compared", version: 1 }),
) =>
  toAttributeMap({
    ...values,
    pk: KeyComposer.composePk(schema, "Row", world.Rows.indexes.primary, values),
    sk: KeyComposer.composeSk(schema, "Row", 1, world.Rows.indexes.primary, values),
    ...indexKeys,
    __edd_e__: "Row",
  }) as StoredRow

const on = DynamoSchema.make({ name: "compared", version: 1, escapeKeys: true })
const off = DynamoSchema.make({ name: "compared", version: 1, escapeKeys: false })

/** A scenario's setting, and the setting whose text its stored row has. */
interface Direction {
  readonly label: string
  readonly now: DynamoSchema.DynamoSchema
  readonly was: DynamoSchema.DynamoSchema
}
const DIRECTIONS: ReadonlyArray<Direction> = [
  { label: "to on", now: on, was: off },
  { label: "to off", now: off, was: on },
]

interface Scenario {
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}

const bothWays = (
  name: string,
  run: (h: Harness, d: Direction) => Effect.Effect<void, unknown>,
): ReadonlyArray<Scenario> =>
  DIRECTIONS.map((d) => ({ name: `${name}, ${d.label}`, run: (h) => run(h, d) }))

/**
 * A Z-order index's partition half is text like any other: `rekey` moves it to the text the
 * setting composes, sharded or not. A sharded one's is moved into the layout too (D24). The
 * address is binary, and stays.
 */
export const zOrderScenarios: ReadonlyArray<Scenario> = [
  {
    name: "unsharded: its partition key, and never its address",
    shards: undefined,
  },
  {
    name: "sharded: its partition key, and never its address",
    shards: 8,
  },
].flatMap(({ name, shards }) =>
  bothWays(name, (h, { now, was }) => {
    const world = worldOf(
      Flat,
      primaryKey,
      {
        byCount: {
          name: "gsi",
          pk: { field: "gpk", composite: ["count"] },
          sk: { field: "gsk", zorder: [{ field: "status", values: ["open", "closed"] }] },
          ...(shards === undefined ? {} : { shards }),
        },
      },
      {},
      now,
    )
    const values = { ...key, status: "open", count: -3 }
    const index = world.Rows.indexes.byCount
    const unsharded = KeyComposer.unshardedView(index)
    const stored = KeyComposer.composePk(was, "Row", unsharded, values)
    expect(stored).not.toBe(KeyComposer.composePk(now, "Row", unsharded, values))
    const address = { B: new Uint8Array([1, 2, 3]) }
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.seed({ ...rowOf(world, values, { gpk: stored }, now), gsk: address })
        const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
        expect(dry.indexKeysRewritten).toBe(1)
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.indexKeysRewritten).toBe(1)
        expect(report.conflicts).toEqual([])
        const [row] = yield* table.rows()
        expect(row!.gpk.S).toBe(KeyComposer.composeStoredPk(now, "Row", index, values))
        expect(Array.from(row!.gsk.B as Uint8Array)).toEqual([1, 2, 3])
        const again: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(again.indexKeysRewritten).toBe(0)
      }),
    )
  }),
)

class Paired extends Schema.Class<Paired>("Paired")({
  tenant: Schema.String,
  id: Schema.String,
  region: Schema.String,
  score: Schema.optional(Schema.Number),
  group: Schema.optional(Schema.String),
  extra: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
}) {}

const pairedWorld = (schema?: DynamoSchema.DynamoSchema) =>
  worldOf(
    Paired,
    primaryKey,
    {
      byRegion: {
        name: "gsi",
        pk: { field: "gpk", composite: ["region"] },
        sk: { field: "gsk", composite: ["tenant"] },
      },
      byGroup: {
        name: "gsi2",
        pk: { field: "gpk2", composite: ["group"] },
        sk: { field: "gsk2", composite: ["extra"] },
      },
    },
    {},
    schema,
  )

/**
 * Two accessors on a row holding composites of both, each in its own attributes: a half is
 * rewritten only when the stored key is one of its own texts, and the other accessor's keys say
 * nothing about it. (In one attribute they're refused: shape 13, `EDD-9106`.)
 */
export const separatePairScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = (() => {
  const stays = (
    name: string,
    write: (db: any) => Effect.Effect<unknown, unknown, any>,
    pin: any,
  ) => ({
    name,
    run: (h: Harness) =>
      h.on(pairedWorld(), (db, table) =>
        Effect.gen(function* () {
          yield* write(db)
          expect(yield* db.entities.Rows.byRegion(pin).collect()).toHaveLength(1)
          const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
          expect(dry.indexKeysRewritten).toBe(0)
          yield* nothingToDo(db, table)
          expect(yield* db.entities.Rows.byRegion(pin).collect()).toHaveLength(1)
        }),
      ),
  })
  return [
    // The write skips `byGroup`, which has no `extra`, though the row holds `group`.
    stays(
      "a sparse put",
      (db) => db.entities.Rows.put({ ...key, region: "west", group: "team" }).asEffect(),
      { region: "west" },
    ),
    // The update wrote `byRegion`'s keys; the row still holds all of `byGroup`'s composites.
    stays(
      "an update of one accessor's composites",
      (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({
            ...key,
            region: "west",
            group: "team",
            extra: "x",
          }).asEffect()
          yield* db.entities.Rows.update(key).set({ region: "east" }).asEffect()
        }),
      { region: "east" },
    ),
    {
      name: "a put holding every composite: both accessors' keys stay",
      run: (h: Harness) =>
        h.on(pairedWorld(), (db, table) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({
              ...key,
              region: "west",
              group: "team",
              extra: "x",
            }).asEffect()
            yield* nothingToDo(db, table)
            const found = yield* db.entities.Rows.byGroup({ group: "team", extra: "x" }).collect()
            expect(found).toHaveLength(1)
          }),
        ),
    },
    ...bothWays(
      "a sort key that is its own other text is rewritten, the other half left",
      (h, { now, was }) => {
        const world = pairedWorld(now)
        const values = { tenant: "a b", id: "1", region: "west", group: "team" }
        const index = world.Rows.indexes.byRegion
        const gsk = KeyComposer.composeSk(was, "Row", 1, index, values)
        expect(gsk).not.toBe(KeyComposer.composeSk(now, "Row", 1, index, values))
        const gpk = KeyComposer.composePk(was, "Row", index, values)
        return h.on(world, (db, table) =>
          Effect.gen(function* () {
            yield* table.seed(rowOf(world, values, { gpk, gsk }, now))
            const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
            expect(dry.indexKeysRewritten).toBe(1)
            const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
            expect(report.indexKeysRewritten).toBe(1)
            expect(report.conflicts).toEqual([])
            const [row] = yield* table.rows()
            expect(row!.gpk.S).toBe(gpk)
            expect(row!.gsk.S).toBe(KeyComposer.composeSk(now, "Row", 1, index, values))
            const pin = { region: "west", tenant: "a b" }
            expect(yield* db.entities.Rows.byRegion(pin).collect()).toHaveLength(1)
          }),
        )
      },
    ),
    ...bothWays(
      "one accessor's own other text is rewritten, and the other's unrelated keys left",
      (h, { now, was }) => {
        const world = pairedWorld(now)
        const values = { tenant: "t", id: "1", region: "west", group: "team", extra: "x y" }
        const index = world.Rows.indexes.byGroup
        const gsk = KeyComposer.composeSk(was, "Row", 1, index, values)
        expect(gsk).not.toBe(KeyComposer.composeSk(now, "Row", 1, index, values))
        const gpk = KeyComposer.composePk(was, "Row", index, values)
        return h.on(world, (db, table) =>
          Effect.gen(function* () {
            yield* table.seed(
              rowOf(
                world,
                values,
                { gpk: "unrelated", gsk: "unrelated", gpk2: gpk, gsk2: gsk },
                now,
              ),
            )
            const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
            expect(report.indexKeysRewritten).toBe(1)
            expect(report.conflicts).toEqual([])
            const [row] = yield* table.rows()
            expect(row!.gpk2.S).toBe(gpk)
            expect(row!.gsk2.S).toBe(KeyComposer.composeSk(now, "Row", 1, index, values))
            expect(row!.gsk.S).toBe("unrelated")
            const pin = { group: "team", extra: "x y" }
            expect(yield* db.entities.Rows.byGroup(pin).collect()).toHaveLength(1)
          }),
        )
      },
    ),
    ...bothWays("a partition key that is its own other text is rewritten", (h, { now, was }) => {
      const world = worldOf(
        Paired,
        primaryKey,
        {
          byScore: {
            name: "gsi",
            pk: { field: "gpk", composite: ["score"] },
            sk: { field: "gsk", composite: ["tenant"] },
          },
          byGroup: {
            name: "gsi2",
            pk: { field: "gpk2", composite: ["group"] },
            sk: { field: "gsk2", composite: ["extra"] },
          },
        },
        {},
        now,
      )
      const values = { ...key, region: "west", score: -3, group: "team" }
      const index = world.Rows.indexes.byScore
      const gpk = KeyComposer.composePk(was, "Row", index, values)
      expect(gpk).not.toBe(KeyComposer.composePk(now, "Row", index, values))
      const gsk = KeyComposer.composeSk(was, "Row", 1, index, values)
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* table.seed(rowOf(world, values, { gpk, gsk }, now))
          const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
          expect(report.indexKeysRewritten).toBe(1)
          const [row] = yield* table.rows()
          expect(row!.gpk.S).toBe(KeyComposer.composePk(now, "Row", index, values))
          expect(row!.gsk.S).toBe(gsk)
          expect(yield* db.entities.Rows.byScore({ score: -3 }).collect()).toHaveLength(1)
        }),
      )
    }),
  ]
})()

/**
 * Two accessors over one sharded partition key: `EDD-9106` has proved they compose the
 * same bytes, so no question of ownership arises, and a move writes the key itself.
 */
export const sharedShardMoveScenarios: ReadonlyArray<Scenario> = bothWays(
  "two accessors over one sharded partition key",
  (h, { now, was }) => {
    const halves = (i: number) => ({
      name: `gsi${i}`,
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: `gsk${i}`, composite: ["tenant"] },
      shards: { count: 8, previous: 1 },
    })
    const world = worldOf(
      Paired,
      primaryKey,
      { byRegion: halves(0), byRegionAgain: halves(1) },
      {},
      now,
    )
    const values = { ...key, id: "a b", region: "west" }
    const primary = world.Rows.indexes.primary
    const index = world.Rows.indexes.byRegion
    const unsharded = KeyComposer.unshardedView(index)
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(
          toAttributeMap({
            ...values,
            pk: KeyComposer.composePk(was, "Row", primary, values),
            sk: KeyComposer.composeSk(was, "Row", 1, primary, values),
            gpk: KeyComposer.composePk(was, "Row", unsharded, values),
            __edd_e__: "Row",
          }) as StoredRow,
        )
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.moved.item).toBe(1)
        // In the move's own write: a second one would mean it left the key behind.
        expect(report.indexKeysRewritten).toBe(0)
        const [row] = yield* table.rows()
        expect(row!.gpk.S).toBe(KeyComposer.composeStoredPk(now, "Row", index, values))
      }),
    )
  },
)

/**
 * Two accessors sharing a table key attribute: it isn't theirs, so a move still takes it to
 * its new key. Its text has to change for that to show, which a sort key's does.
 */
export const sharedTableKeyMoveScenarios: ReadonlyArray<Scenario> = [
  {
    name: "two local indexes sharing the table's partition key",
    indexes: {
      byRegion: {
        name: "lsi0",
        pk: { field: "pk", composite: ["tenant"] },
        sk: { field: "lsk0", composite: ["region"] },
      },
      byGroup: {
        name: "lsi1",
        pk: { field: "pk", composite: ["tenant"] },
        sk: { field: "lsk1", composite: ["group"] },
      },
    },
    keys: (_world: any, _values: any) => ({
      lsk0: "$compared#v1#row#region_west",
      lsk1: "$compared#v1#row#group_team",
    }),
  },
  {
    name: "two indexes sharing the table's sort key",
    indexes: {
      byRegion: {
        name: "gsi0",
        pk: { field: "gpk0", composite: ["region"] },
        sk: { field: "sk", composite: ["id"] },
      },
      byGroup: {
        name: "gsi1",
        pk: { field: "gpk1", composite: ["group"] },
        sk: { field: "sk", composite: ["id"] },
      },
    },
    keys: (world: any, values: any) => ({
      gpk0: KeyComposer.composePk(on, "Row", world.Rows.indexes.byRegion, values),
      gpk1: KeyComposer.composePk(on, "Row", world.Rows.indexes.byGroup, values),
    }),
  },
].flatMap(({ name, indexes, keys }) =>
  bothWays(name, (h, { now, was }) => {
    const world = worldOf(Paired, primaryKey, indexes, {}, now)
    const values = { ...key, id: "a b", region: "west", group: "team" }
    const primary = world.Rows.indexes.primary
    const old = KeyComposer.composeSk(was, "Row", 1, primary, values)
    const current = KeyComposer.composeIndexKeys(now, "Row", 1, primary, values)
    expect(old).not.toBe(current.sk)
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(
          toAttributeMap({
            ...values,
            pk: KeyComposer.composePk(was, "Row", primary, values),
            sk: old,
            ...keys(world, values),
            __edd_e__: "Row",
          }) as StoredRow,
        )
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.moved.item).toBe(1)
        expect(report.conflicts).toEqual([])
        const rows = yield* table.rows()
        expect(rows.map((row) => [row.pk.S, row.sk.S])).toEqual([[current.pk, current.sk]])
      }),
    )
  }),
)

/**
 * Two accessors whose halves in one attribute compose the same bytes, on a healthy row. A move
 * recomposes every index as an update would, so the row's entry follows it whole: keeping the
 * attribute as stored (the rejected D60) would leave its old text beside the other half's
 * current text, and a pin on the row would miss it.
 */
export const sameBytesMoveScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a partition key two accessors compose alike",
    indexes: {
      byScore: {
        name: "gsi",
        pk: { field: "gpk", composite: ["score"] },
        sk: { field: "gsk", composite: ["region"] },
      },
      byScoreAgain: {
        name: "gsi2",
        pk: { field: "gpk", composite: ["score"] },
        sk: { field: "gsk2", composite: ["group"] },
      },
    },
  },
  {
    name: "a sort key two accessors compose alike",
    indexes: {
      byScore: {
        name: "gsi",
        pk: { field: "gpk", composite: ["score"] },
        sk: { field: "gsk", composite: ["region"] },
      },
      byGroup: {
        name: "gsi2",
        pk: { field: "gpk2", composite: ["group"] },
        sk: { field: "gsk", composite: ["region"] },
      },
    },
  },
].flatMap(({ name, indexes }) =>
  bothWays(`${name}, moved by \`rekey\``, (h, { now, was }) => {
    const world = worldOf(Paired, primaryKey, indexes, {}, now)
    const values = { ...key, id: "a b", region: "x y", score: -3 }
    const primary = world.Rows.indexes.primary
    const index = world.Rows.indexes.byScore
    const pin = { score: -3, region: "x y" }
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(
          toAttributeMap({
            ...values,
            pk: KeyComposer.composePk(was, "Row", primary, values),
            sk: KeyComposer.composeSk(was, "Row", 1, primary, values),
            gpk: KeyComposer.composePk(was, "Row", index, values),
            gsk: KeyComposer.composeSk(was, "Row", 1, index, values),
            __edd_e__: "Row",
          }) as StoredRow,
        )
        expect(yield* db.entities.Rows.byScore(pin).collect()).toHaveLength(0)
        const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(report))
        expect(report.moved.item).toBe(1)
        expect(report.conflicts).toEqual([])
        expect(yield* db.entities.Rows.byScore(pin).collect()).toHaveLength(1)
      }),
    )
  }),
)

/**
 * A sharded partition key is composed and compared whatever it holds (D24), which is what
 * moves a row from one layout to another: neither side of that is ever unsharded text. The sort
 * key beside it follows the rule for every other half, so one lagging its values stays.
 */
export const shardLayoutMoveScenario = (h: Harness) => {
  const indexOf = (shards: unknown) => ({
    name: "gsi",
    pk: { field: "gpk", composite: ["tenant"] },
    sk: { field: "gsk", composite: ["region"] },
    shards,
  })
  const from = worldOf(Paired, primaryKey, { byTenant: indexOf(8) })
  const to = worldOf(Paired, primaryKey, { byTenant: indexOf({ count: 16, previous: 8 }) })
  const values = { ...key, region: "west" }
  const schema = DynamoSchema.make({ name: "compared", version: 1 })
  const before = KeyComposer.composeStoredPk(schema, "Row", from.Rows.indexes.byTenant, values)!
  const after = KeyComposer.composeStoredPk(schema, "Row", to.Rows.indexes.byTenant, values)!
  expect(before).not.toBe(after)
  const gsk = KeyComposer.composeSk(schema, "Row", 1, to.Rows.indexes.byTenant, {
    ...values,
    region: "east",
  })
  return h.on(to, (db, table) =>
    Effect.gen(function* () {
      yield* table.seed(rowOf(to, values, { gpk: before, gsk }))
      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
      expect(dry.indexKeysRewritten).toBe(1)
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.indexKeysRewritten).toBe(1)
      expect(report.conflicts).toEqual([])
      const [row] = yield* table.rows()
      expect(row!.gpk.S).toBe(after)
      expect(row!.gsk.S).toBe(gsk)
      yield* nothingToDo(db, table)
    }),
  )
}

/**
 * A half stored in a table key attribute is never set, whatever the values compose (D70), so
 * `rekey` has nothing to compare it with. A local index's partition key, a sort key shared with
 * the table, and an inverted index's halves, whose kinds differ from the table's they're stored
 * in.
 */
export const tableKeyAttributeScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  {
    name: "a local index's partition key",
    index: {
      name: "lsi",
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "lsk", composite: ["status"] },
    },
    keys: { lsk: "$compared#v1#row#status_s" },
  },
  {
    name: "a sort key shared with the table",
    index: {
      name: "gsi",
      pk: { field: "gpk", composite: ["status"] },
      sk: { field: "sk", composite: ["id"] },
    },
    keys: { gpk: "$compared#v1#row#status_s" },
  },
  {
    name: "an inverted index",
    index: {
      name: "gsi",
      pk: { field: "sk", composite: ["id"] },
      sk: { field: "pk", composite: ["tenant"] },
    },
    keys: {},
  },
].map(({ name, index, keys }) => ({
  name,
  run: (h: Harness) => {
    const world = worldOf(Flat, primaryKey, { byNote: index })
    const values = { tenant: "a b", id: "c d", status: "s", count: 1 }
    const row = rowOf(world, values, keys)
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(row)
        yield* nothingToDo(db, table)
      }),
    )
  },
}))

/** Labels that begin alike mean nothing to a comparison. */
export const labelScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = (["pk", "sk"] as const).flatMap((half) => {
  const composite = (attrs: ReadonlyArray<string>) => ({
    name: "gsi",
    pk: { field: "gpk", composite: half === "pk" ? attrs : [] },
    sk: { field: "gsk", composite: half === "sk" ? attrs : [] },
  })
  const field = half === "pk" ? "gpk" : "gsk"
  const Labelled = Schema.Struct({
    tenant: Schema.String,
    id: Schema.String,
    code: Schema.String,
    code_value: Schema.optional(Schema.Number),
    score: Schema.optional(Schema.Number),
    score_label: Schema.String,
  })
  return [
    {
      // `.set({ score: undefined })` under `preserve` left this row before 1.40.
      name: `${half}: a number cleared before a string whose label begins with its own`,
      run: (h: Harness) => {
        const world = worldOf(Labelled, primaryKey, { byIt: composite(["score", "score_label"]) })
        return h.on(world, (db, table) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ ...key, code: "c", score: 3, score_label: "abc" })
            const [before] = yield* table.rows()
            const { score: _cleared, ...kept } = before!
            yield* table.seed(kept)
            yield* nothingToDo(db, table)
            const [after] = yield* table.rows()
            expect(after![field]).toEqual(before![field])
            expect(after!.score).toBeUndefined()
            const found = yield* db.entities.Rows.byIt({
              score: 3,
              score_label: "abc",
            }).collect()
            expect(found).toHaveLength(1)
          }),
        )
      },
    },
    ...bothWays(
      `${half}: a number at its other text, cleared after a string whose label begins the same`,
      (h, { now, was }) => {
        const world = worldOf(
          Labelled,
          primaryKey,
          {
            byIt: composite(["code", "code_value"]),
          },
          {},
          now,
        )
        const values = { ...key, code: "abc", score_label: "l", code_value: -3 }
        const { code_value: _gone, ...held } = values
        const stored = KeyComposer.composeIndexKeys(
          was,
          "Row",
          1,
          world.Rows.indexes.byIt,
          values,
        ) as Record<string, string>
        expect(stored[field]).not.toBe(
          (KeyComposer.composeIndexKeys(now, "Row", 1, world.Rows.indexes.byIt, values) as any)[
            field
          ],
        )
        return h.on(world, (db, table) =>
          Effect.gen(function* () {
            yield* table.seed(rowOf(world, held, stored, now))
            yield* nothingToDo(db, table)
            const [after] = yield* table.rows()
            expect(after![field]!.S).toBe(stored[field])
          }),
        )
      },
    ),
  ]
})

/**
 * A dry run follows the chain (D88). One value moves to where the other value's row is, and when
 * that row can't move, the real run moves neither and reports both: the one that can't, and the one
 * it holds up. The dry run says the same, and without the blocked row both move in each.
 */
export const dryRunChainScenarios: ReadonlyArray<Scenario> = [false, true].flatMap((blocked) =>
  bothWays(
    blocked
      ? "blocked: neither moves, in the dry run too"
      : "not blocked: both move, in the dry run too",
    (h, { now, was }) => {
      const model = Schema.Struct({ id: Schema.String, status: Schema.String })
      const world = worldOf(
        model,
        {
          pk: { field: "pk", composite: [] },
          sk: { field: "sk", composite: ["id"] },
        },
        {
          byStatus: {
            name: "gsi",
            pk: { field: "gpk", composite: [] },
            sk: { field: "gsk", zorder: [{ field: "status", values: ["a", "b"] }] },
          },
        },
        {},
        now,
      )
      const primary = world.Rows.indexes.primary
      const rowAtThen = (values: { readonly id: string; readonly status: string }) =>
        toAttributeMap({
          ...values,
          pk: KeyComposer.composePk(was, "Row", primary, values),
          sk: KeyComposer.composeSk(was, "Row", 1, primary, values),
          __edd_e__: "Row",
        }) as StoredRow
      // The row the other's target holds: `a%20b`'s old row on the way on, `a b`'s on the way off.
      const held = now === on ? "a%20b" : "a b"
      const moving = now === on ? "a b" : "a%20b"
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* table.seed(rowAtThen({ id: moving, status: "a" }))
          yield* table.seed(rowAtThen({ id: held, status: blocked ? "c" : "b" }))
          const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
          const real: Table.RekeyReport = yield* db.tables.MainTable.rekey()
          expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
          if (blocked) {
            expect(real.moved.item).toBe(0)
            expect(real.conflicts.map((conflict) => conflict.reason).sort()).toEqual([
              "failed",
              "taken",
            ])
            expect(yield* table.rows()).toHaveLength(2)
          } else {
            expect(real.moved.item).toBe(2)
          }
        }),
      )
    },
  ),
)
