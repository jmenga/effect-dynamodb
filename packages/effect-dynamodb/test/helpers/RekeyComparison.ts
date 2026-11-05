/**
 * What `rekey` compares (#183, design §9.2, D58): a stored key against what the row's
 * values compose. Nothing reads a value out of a stored key, so the risks are the
 * other way round: a key a write composed that `rekey` composes differently would be
 * rewritten for no reason. These scenarios run on a recording table
 * (`RekeyComparison.test.ts`) and on DynamoDB Local (`connected.sharding.test.ts`).
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DateTime, Effect, Schema } from "effect"
import { expect } from "vitest"
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

/** A run over what the writes left: nothing differs, so nothing is rewritten or reported. */
const nothingToDo = (db: any) =>
  Effect.gen(function* () {
    const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
    expect(report.conflicts).toEqual([])
    expect(report.indexKeysRewritten).toBe(0)
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

/** A composite of every kind, in each half: what a write stores is what `rekey` composes. */
export const compositeKindScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  { name: "an ordinary row", options: {} },
  { name: "with retained versions", options: { versioned: { retain: true } } },
].map(({ name, options }) => ({
  name,
  run: (h: Harness) =>
    h.on(kindsWorld(options), (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put(kindsOf(-2.5)).asEffect()
        yield* nothingToDo(db)
        const { tenant: _tenant, id: _id, ...updates } = kindsOf(123.25)
        yield* db.entities.Rows.update(key).set(updates).asEffect()
        yield* nothingToDo(db)
        yield* db.entities.Rows.update(key).set({ note: "n" }).asEffect()
        yield* nothingToDo(db)
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

/** The shapes of `DESIGN.md §7` through every write that leaves their keys true. */
export const writePathScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  {
    name: "put",
    run: (db: any) => db.entities.Rows.put({ ...key, ...WHOLE }).asEffect(),
  },
  {
    name: "put with no optional composite",
    run: (db: any) => db.entities.Rows.put(key).asEffect(),
  },
  {
    name: "upsert",
    run: (db: any) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.upsert({ ...key, ...WHOLE }).asEffect()
        yield* db.entities.Rows.upsert({ ...key, ...WHOLE, group: "G2" }).asEffect()
      }),
  },
  {
    name: "an update naming every composite",
    run: (db: any) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
        yield* db.entities.Rows.update(key)
          .set({ ...WHOLE, region: "Elsewhere", count: 4 })
          .asEffect()
      }),
  },
  {
    name: "an update naming none",
    run: (db: any) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
        yield* db.entities.Rows.update(key).set({ extra: "x" }).asEffect()
      }),
  },
  {
    name: "a composite removed: the structural rule truncates",
    run: (db: any) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
        yield* db.entities.Rows.update(key).remove(["group", "count"]).asEffect()
      }),
  },
  {
    name: "a composite cleared: `preserve` keeps the key",
    run: (db: any) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
        yield* db.entities.Rows.update(key).set({ note: undefined, zone: undefined }).asEffect()
      }),
  },
].map(({ name, run }) => ({
  name,
  run: (h: Harness) =>
    h.on(shapedWorld(), (db) =>
      Effect.gen(function* () {
        yield* run(db)
        yield* nothingToDo(db)
      }),
    ),
}))

/** A transaction's update and a retained update, the writes with a path of their own. */
export const otherWritePathScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  {
    name: "a transaction's update",
    run: (h: Harness) => {
      const world = shapedWorld()
      return h.on(world, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
          yield* Transaction.transactWrite([
            world.Rows.update(key).pipe(Entity.set({ ...WHOLE, region: "Elsewhere", count: 4 })),
          ])
          yield* nothingToDo(db)
        }),
      )
    },
  },
  {
    name: "a retained update",
    run: (h: Harness) =>
      h.on(shapedWorld({ versioned: { retain: true } }), (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, ...WHOLE }).asEffect()
          yield* nothingToDo(db)
          yield* db.entities.Rows.update(key).set({ extra: "x" }).asEffect()
          yield* nothingToDo(db)
          yield* db.entities.Rows.update(key).set({ note: undefined }).asEffect()
          yield* nothingToDo(db)
          yield* db.entities.Rows.update(key).remove(["group"]).asEffect()
          yield* nothingToDo(db)
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
const rowOf = (world: any, values: Record<string, unknown>, indexKeys: Record<string, string>) =>
  toAttributeMap({
    ...values,
    pk: KeyComposer.composePk(
      DynamoSchema.make({ name: "compared", version: 1 }),
      "Row",
      world.Rows.indexes.primary,
      values,
    ),
    sk: KeyComposer.composeSk(
      DynamoSchema.make({ name: "compared", version: 1 }),
      "Row",
      1,
      world.Rows.indexes.primary,
      values,
    ),
    ...indexKeys,
    __edd_e__: "Row",
  }) as StoredRow

const on = DynamoSchema.make({ name: "compared", version: 1 })

/** A Z-order index's text half is compared like any other; its address never is. */
export const zOrderPartitionScenario = (h: Harness) => {
  const world = worldOf(Flat, primaryKey, {
    byCount: {
      name: "gsi",
      pk: { field: "gpk", composite: ["status"] },
      sk: { field: "gsk", zorder: [{ field: "count", min: -100, max: 100 }] },
    },
  })
  const values = { ...key, status: "open", count: 3 }
  const index = world.Rows.indexes.byCount
  const stale = KeyComposer.composePk(on, "Row", index, { ...values, status: "closed" })
  const address = { B: new Uint8Array([1, 2, 3]) }
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      yield* table.seed({ ...rowOf(world, values, { gpk: stale }), gsk: address })
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.indexKeysRewritten).toBe(1)
      expect(report.conflicts).toEqual([])
      const [row] = yield* table.rows()
      expect(row!.gpk.S).toBe(KeyComposer.composePk(on, "Row", index, values))
      expect(Array.from(row!.gsk.B as Uint8Array)).toEqual([1, 2, 3])
    }),
  )
}

const exclusiveWorld = () =>
  worldOf(Flat, primaryKey, {
    byRegion: {
      name: "gsi",
      pk: { field: "gpk", composite: ["tenant"] },
      sk: { field: "gsk", composite: ["region"] },
    },
    byGroup: {
      name: "gsi",
      pk: { field: "gpk", composite: ["tenant"] },
      sk: { field: "gsk", composite: ["group"] },
    },
  })

/**
 * Two accessors sharing an attribute: a write's later index wins, so `rekey`'s must too,
 * or a row holding both composites would flip on every run.
 */
export const sharedAttributeScenario = (h: Harness) =>
  h.on(exclusiveWorld(), (db, table) =>
    Effect.gen(function* () {
      const both = { ...key, status: "s", count: 1, region: "r", group: "g" }
      yield* db.entities.Rows.put(both).asEffect()
      const [written] = yield* table.rows()
      expect(written!.gsk.S).toContain("group_g")
      yield* nothingToDo(db)
      yield* db.entities.Rows.put({
        ...key,
        id: "2",
        status: "s",
        count: 1,
        region: "r",
      }).asEffect()
      yield* nothingToDo(db)
    }),
  )

/**
 * A half stored in a table key attribute is the table's to hold: DynamoDB refuses the
 * update, and the row under its table key isn't stale.
 */
export const tableKeyAttributeScenario = (h: Harness) => {
  const world = worldOf(Flat, primaryKey, {
    byNote: {
      name: "gsi",
      pk: { field: "gpk", composite: ["note"] },
      sk: { field: "sk", composite: ["note"] },
    },
  })
  const values = { ...key, status: "s", count: 1, note: "n" }
  const gpk = KeyComposer.composePk(on, "Row", world.Rows.indexes.byNote, values)
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      const row = rowOf(world, values, { gpk })
      yield* table.seed(row)
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.conflicts).toEqual([])
      expect(report.indexKeysRewritten).toBe(0)
      const [after] = yield* table.rows()
      expect(after!.sk).toEqual(row.sk)
    }),
  )
}

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
      name: `${half}: a number cleared before a string whose label begins with its own`,
      run: (h: Harness) =>
        h.on(
          worldOf(
            Labelled,
            primaryKey,
            { byIt: composite(["score", "score_label"]) },
            {},
            DynamoSchema.make({ name: "compared", version: 1, legacyKeys: false }),
          ),
          (db, table) =>
            Effect.gen(function* () {
              yield* db.entities.Rows.put({ ...key, code: "c", score: 3, score_label: "abc" })
              const [before] = yield* table.rows()
              yield* db.entities.Rows.update(key).set({ score: undefined }).asEffect()
              yield* nothingToDo(db)
              const [after] = yield* table.rows()
              expect(after![field]).toEqual(before![field])
              const found = yield* db.entities.Rows.byIt({
                score: 3,
                score_label: "abc",
              }).collect()
              expect(found).toHaveLength(1)
            }),
        ),
    },
    {
      name: `${half}: 1.36's number cleared after a string whose label begins the same`,
      run: (h: Harness) => {
        const world = worldOf(Labelled, primaryKey, {
          byIt: composite(["code", "code_value"]),
        })
        const values = { ...key, code: "abc", score_label: "l", code_value: -3 }
        const { code_value: _gone, ...held } = values
        const stored = KeyText136.composeIndexKeys(
          on,
          "Row",
          1,
          world.Rows.indexes.byIt,
          values,
        ) as Record<string, string>
        expect(stored[field]).not.toBe(
          (KeyComposer.composeIndexKeys(on, "Row", 1, world.Rows.indexes.byIt, values) as any)[
            field
          ],
        )
        return h.on(world, (db, table) =>
          Effect.gen(function* () {
            yield* table.seed(rowOf(world, held, stored))
            yield* nothingToDo(db)
            const [after] = yield* table.rows()
            expect(after![field]!.S).toBe(stored[field])
          }),
        )
      },
    },
  ]
})

/**
 * The limit on a dry run (D55): it judges each row on its own. `a b` moves to where
 * `a%20b` holds its 1.36 text, and `a%20b` can't move, so the real run moves neither.
 * The dry run says the first would move. Without the blocked row the two agree.
 */
export const dryRunChainScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [false, true].map((blocked) => ({
  name: blocked ? "blocked: a dry run predicts the move a real run refuses" : "not blocked: agrees",
  run: (h: Harness) => {
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
    )
    const primary = world.Rows.indexes.primary
    const row136 = (values: { readonly id: string; readonly status: string }) =>
      toAttributeMap({
        ...values,
        pk: KeyText136.composePk(on, "Row", primary, values),
        sk: KeyText136.composeSk(on, "Row", 1, primary, values),
        __edd_e__: "Row",
      }) as StoredRow
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(row136({ id: "a b", status: "a" }))
        yield* table.seed(row136({ id: "a%20b", status: blocked ? "c" : "b" }))
        const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        if (blocked) {
          expect(dry.moved.item).toBe(1)
          expect(dry.conflicts.map((conflict) => conflict.reason)).toEqual(["failed"])
          expect(real.moved.item).toBe(0)
          expect(real.conflicts.length).toBeGreaterThan(dry.conflicts.length)
        } else {
          expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
          expect(real.moved.item).toBe(2)
        }
      }),
    )
  },
}))
