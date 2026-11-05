/**
 * Migrating an index to shards over rows still holding 1.36 key text (#183, design
 * §9.3). A write can move a row's partition key into a shard and leave its sort key,
 * so a shard can hold both texts. These scenarios run on a recording table and on
 * DynamoDB Local, through a {@link Harness}: every one asserts on which pins find a
 * row, before and after, rather than on what was sent.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { toAttributeMap } from "../../src/Marshaller.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { rekeyOutcome } from "./RekeyOutcome.js"

export const schema = DynamoSchema.make({ name: "migrating", version: 1 })
export const TENANT = "t"

class Row extends Schema.Class<Row>("Row")({
  id: Schema.String,
  name: Schema.String,
  tenant: Schema.String,
  at: Schema.Number,
  region: Schema.optional(Schema.String),
  zone: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Number),
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: ["name"] },
} as const

export const worldOf = (
  shards: unknown,
  on: DynamoSchema.DynamoSchema = schema,
  sortKey: ReadonlyArray<string> = ["region", "zone", "group"],
  partitionKey: ReadonlyArray<string> = ["tenant"],
) => {
  const byTenant = {
    name: "gsi",
    pk: { field: "gpk", composite: partitionKey },
    sk: { field: "gsk", composite: sortKey },
    ...(shards === undefined ? {} : { shards }),
  } as never
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey,
    indexes: { byTenant },
  })
  const Retained = Entity.make({
    model: Row,
    entityType: "Retained",
    primaryKey,
    indexes: { byTenant },
    versioned: { retain: true },
  })
  const Series = Entity.make({
    model: Row,
    entityType: "Series",
    primaryKey,
    indexes: { byTenant },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        tenant: Schema.String,
        at: Schema.Number,
      }),
    },
  })
  const MainTable = Table.make({ schema: on, entities: { Rows, Retained, Series } })
  return { Rows, Retained, Series, MainTable }
}

/** `previous: 1`: the rows are on their way from the unsharded layout. */
export const Migrating = worldOf({ count: 8, previous: 1 })
/** The migration is over: only the shards are read. */
export const Finished = worldOf(8)
/** The same table with the index left unsharded. */
export const Unsharded = worldOf(undefined)
/** The sort key is one optional number. */
export const ScoredMigrating = worldOf({ count: 8, previous: 1 }, schema, ["score"])
export const ScoredFinished = worldOf(8, schema, ["score"])
export const ScoredUnsharded = worldOf(undefined, schema, ["score"])
/** The partition key is one optional number, on an index with no shards. */
export const ScoredPartition = worldOf(undefined, schema, ["id"], ["score"])
const ScoredPartitionOff = worldOf(
  undefined,
  DynamoSchema.make({ name: "migrating", version: 1, legacyKeys: false }),
  ["id"],
  ["score"],
)
export type World = typeof Migrating

/** What a scenario needs of a table. */
export interface Harness {
  /** Store a row as it is. */
  readonly seed: (row: StoredRow) => Effect.Effect<void, unknown>
  /** Every stored item row. */
  readonly rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown>
  /** Run `body` with a client over `world`'s definitions of this table. */
  readonly inWorld: <A, E>(
    world: World,
    body: (db: any) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

export type StoredRow = Record<string, AttributeValue>

/** A new client over the world's members. */
export const clientOf = (world: World) =>
  DynamoClient.make({
    entities: { Rows: world.Rows, Retained: world.Retained, Series: world.Series },
    tables: { MainTable: world.MainTable },
  }) as Effect.Effect<any, never, any>

export interface Values {
  readonly id: string
  readonly name?: string | undefined
  readonly at?: number | undefined
  readonly region?: string | undefined
  readonly zone?: string | undefined
  readonly group?: string | undefined
  readonly status?: string | undefined
  readonly score?: number | undefined
}

/** A row exactly as 1.36 wrote it: unsharded, its key text not escaped. */
export const row136 = (
  entityType: string,
  values: Values,
  extra: Record<string, unknown> = {},
): StoredRow => {
  const item = { name: "n", tenant: TENANT, at: 1, ...values }
  const index = KeyComposer.unshardedView(Migrating.Rows.indexes.byTenant)
  const primary = Migrating.Rows.indexes.primary
  return toAttributeMap({
    ...item,
    pk: KeyText136.composePk(schema, entityType, primary, item),
    sk: KeyText136.composeSk(schema, entityType, 1, primary, item),
    gpk: KeyText136.composePk(schema, entityType, index, item),
    gsk: KeyText136.composeSortKeyPrefix(schema, entityType, 1, index, item),
    __edd_e__: entityType,
    ...extra,
  }) as StoredRow
}

/** A row as the current code writes it, on the shard its primary key hashes to. */
export const rowNow = (
  entityType: string,
  values: Values,
  extra: Record<string, unknown> = {},
): StoredRow => {
  const item = { name: "n", tenant: TENANT, at: 1, ...values }
  const index = Migrating.Rows.indexes.byTenant
  return toAttributeMap({
    ...item,
    ...KeyComposer.composeIndexKeys(schema, entityType, 1, Migrating.Rows.indexes.primary, item),
    gpk: KeyComposer.composePk(schema, entityType, index, item),
    gsk: KeyComposer.composeSortKeyPrefix(schema, entityType, 1, index, item),
    __edd_e__: entityType,
    ...extra,
  }) as StoredRow
}

const idsOf = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id).sort()

const SHARD = /#!8\.\d#/

export interface WritePath {
  readonly name: string
  readonly member: "Rows" | "Retained" | "Series"
  readonly write: (db: any, world: World, values: Values) => Effect.Effect<unknown, any, any>
  /** `put` composes from what it's given: a truncated row leaves the index, as it always has. */
  readonly wholeOnly?: boolean
  /** Does it recompose the sort key too? Then no 1.36 text is left for `rekey`. */
  readonly convertsWhole?: boolean
  /** Likewise for a truncated sort key, which the structural rule otherwise leaves. */
  readonly convertsTruncated?: boolean
  /** The row is under its 1.36 table key too, so this path moves it there as well. */
  readonly from136TableKey?: boolean
}

const keyOf = (values: Values) => ({ id: values.id, name: values.name ?? "n" })

/** Every write path that can move a row out of the unsharded layout. */
export const writePaths: ReadonlyArray<WritePath> = [
  {
    name: "an update naming the partition key",
    member: "Rows",
    write: (db, _, values) =>
      db.entities.Rows.update(keyOf(values)).set({ tenant: TENANT }).asEffect(),
  },
  {
    name: "Transaction.transactWrite",
    member: "Rows",
    write: (_, world, values) =>
      Transaction.transactWrite([
        world.Rows.update(keyOf(values)).pipe(Entity.set({ tenant: TENANT })),
      ]),
  },
  {
    name: "append",
    member: "Series",
    write: (db, _, values) =>
      db.entities.Series.append({ ...keyOf(values), tenant: TENANT, at: 2 })
        .skipFollowUp()
        .asEffect(),
  },
  {
    name: "the retain path",
    member: "Retained",
    write: (db, _, values) =>
      db.entities.Retained.update(keyOf(values)).set({ tenant: TENANT }).asEffect(),
    convertsWhole: true,
  },
  {
    name: "put",
    member: "Rows",
    write: (db, _, values) =>
      db.entities.Rows.put({ name: "n", tenant: TENANT, at: 1, ...values }).asEffect(),
    wholeOnly: true,
    convertsWhole: true,
  },
  {
    name: "Batch.write",
    member: "Rows",
    write: (_, world, values) =>
      Batch.write([world.Rows.put({ name: "n", tenant: TENANT, at: 1, ...values } as never)]),
    wholeOnly: true,
    convertsWhole: true,
  },
  {
    name: "an update that moves the row from its 1.36 table key",
    member: "Rows",
    write: (db, _, values) =>
      db.entities.Rows.update(keyOf(values)).set({ status: "on" }).asEffect(),
    convertsWhole: true,
    convertsTruncated: true,
    from136TableKey: true,
  },
  {
    name: "rekey",
    member: "Rows",
    write: (db) => db.tables.MainTable.rekey(),
    convertsWhole: true,
    convertsTruncated: true,
  },
  {
    name: "rekey, moving the row from its 1.36 table key",
    member: "Rows",
    write: (db) => db.tables.MainTable.rekey(),
    convertsWhole: true,
    convertsTruncated: true,
    from136TableKey: true,
  },
]

const entityTypeOf = { Rows: "Row", Retained: "Retained", Series: "Series" } as const

const REGION = "new york"
const whole: Values = { id: "1", region: REGION, zone: "z", group: "g" }
const truncated: Values = { id: "1", region: REGION }

/**
 * The pins a row must stay reachable by: the ones whose text 1.37 changed, and for a
 * whole row, every leading run down to the complete key.
 */
const pinsOf = (values: Values): ReadonlyArray<Record<string, string>> =>
  values.group === undefined
    ? [{ tenant: TENANT }, { tenant: TENANT, region: REGION }]
    : [
        { tenant: TENANT },
        { tenant: TENANT, region: REGION },
        { tenant: TENANT, region: REGION, zone: "z" },
        { tenant: TENANT, region: REGION, zone: "z", group: "g" },
      ]

const expectReachable = (entity: any, values: Values, id = values.id) =>
  Effect.gen(function* () {
    for (const pins of pinsOf(values)) {
      expect(idsOf(yield* entity.byTenant(pins).collect())).toEqual([id])
      expect(yield* entity.byTenant(pins).count()).toBe(1)
    }
    const bounded = entity
      .byTenant({ tenant: TENANT })
      .where((t: any, { eq }: any) => eq(t.region, REGION))
    expect(idsOf(yield* bounded.collect())).toEqual([id])
  })

const seedFor = (path: WritePath, values: Values): StoredRow => {
  const entityType = entityTypeOf[path.member]
  const extra = path.member === "Retained" ? { version: 1 } : {}
  const row = row136(entityType, values, extra)
  if (path.from136TableKey === true) return row
  return {
    ...row,
    ...toAttributeMap(
      KeyComposer.composeIndexKeys(schema, entityType, 1, Migrating.Rows.indexes.primary, {
        name: "n",
        ...values,
      }),
    ),
  } as StoredRow
}

/** A table key whose text 1.37 changed, for the paths that move it. */
const named = (values: Values, path: WritePath): Values =>
  path.from136TableKey === true ? { ...values, name: "a b" } : values

/** A row stays reachable by the same pins through each write, and past the migration's end. */
export const pathScenario = (path: WritePath, shape: "whole" | "truncated", h: Harness) => {
  const values = named(shape === "whole" ? whole : truncated, path)
  return Effect.gen(function* () {
    yield* h.seed(seedFor(path, values))
    yield* h.inWorld(Migrating, (db) => expectReachable(db.entities[path.member], values))
    yield* h.inWorld(Migrating, (db) => path.write(db, Migrating, values))
    const [moved] = yield* h.rows()
    expect(moved!.gpk?.S).toMatch(SHARD)
    const converts = shape === "whole" ? path.convertsWhole : path.convertsTruncated
    expect(moved!.gsk?.S).toContain(
      converts === true || path.wholeOnly === true ? "region_new%20york" : "region_new york",
    )
    yield* h.inWorld(Migrating, (db) => expectReachable(db.entities[path.member], values))

    // `rekey` finishes the job and says so; after it, `previous` can go.
    const report = (yield* h.inWorld(Migrating, (db) =>
      db.tables.MainTable.rekey(),
    )) as Table.RekeyReport
    expect(report.conflicts).toEqual([])
    const [converted] = yield* h.rows()
    expect(converted!.gpk?.S).toMatch(SHARD)
    expect(converted!.gsk?.S).toContain("region_new%20york")
    yield* h.inWorld(Finished, (db) => expectReachable(db.entities[path.member], values))
  })
}

/** What `pathScenario`'s final read has no pass to rely on: each row once, by its own pins. */
export const foreignRowScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  {
    name: "a longer sibling in 1.36 text under a pin whose text didn't change",
    run: (h) =>
      Effect.gen(function* () {
        // `new york` sorts between `new` and `new#`, in the range of a pin on `new`.
        yield* h.seed(moved("Row", { id: "own", region: "new" }))
        yield* h.seed(moved("Row", { id: "sibling", region: REGION }))
        yield* h.inWorld(Migrating, (db) =>
          Effect.gen(function* () {
            const found = yield* db.entities.Rows.byTenant({
              tenant: TENANT,
              region: "new",
            }).collect()
            expect(idsOf(found)).toEqual(["own"])
          }),
        )
      }),
  },
  {
    name: "another value's 1.36 text that spells this pin's escape",
    run: (h) =>
      Effect.gen(function* () {
        // `a%20b` stored by 1.36 sits where `a b` is keyed now.
        yield* h.seed(moved("Row", { id: "spelled", region: "a%20b" }))
        yield* h.seed(rowNow("Row", { id: "spaced", region: "a b" }))
        yield* h.inWorld(Migrating, (db) =>
          Effect.gen(function* () {
            const rows = db.entities.Rows
            expect(
              idsOf(yield* rows.byTenant({ tenant: TENANT, region: "a b" }).collect()),
            ).toEqual(["spaced"])
            expect(
              idsOf(yield* rows.byTenant({ tenant: TENANT, region: "a%20b" }).collect()),
            ).toEqual(["spelled"])
          }),
        )
      }),
  },
  {
    name: "both texts of one pin, in a shard and in the unsharded layout: each row once",
    run: (h) =>
      Effect.gen(function* () {
        yield* h.seed(moved("Row", { id: "in-shard", region: REGION }))
        yield* h.seed(row136("Row", { id: "in-layout", region: REGION }, keysOf("in-layout")))
        yield* h.seed(rowNow("Row", { id: "current", region: REGION }))
        yield* h.inWorld(Migrating, (db) =>
          Effect.gen(function* () {
            const query = db.entities.Rows.byTenant({ tenant: TENANT, region: REGION })
            expect(idsOf(yield* query.collect())).toEqual(["current", "in-layout", "in-shard"])
            expect(yield* query.count()).toBe(3)
          }),
        )
      }),
  },
  {
    name: "a range both texts hold: the current read's rows aren't read twice",
    run: (h) =>
      Effect.gen(function* () {
        // `begins_with(50%)` holds `50%25`, the escaped text of `50%`.
        yield* h.seed(rowNow("Row", { id: "current", region: "50%" }))
        yield* h.seed(moved("Row", { id: "old", region: "50%" }))
        yield* h.inWorld(Migrating, (db) =>
          Effect.gen(function* () {
            const found = yield* db.entities.Rows.byTenant({ tenant: TENANT })
              .where((t: any, { beginsWith }: any) => beginsWith(t.region, "50%"))
              .collect()
            expect(idsOf(found)).toEqual(["current", "old"])
          }),
        )
      }),
  },
  {
    name: "a range both texts hold: a key an index policy left isn't read twice",
    run: (h) =>
      Effect.gen(function* () {
        // Its values compose `region_50%25#zone_z`, and `preserve` kept `region_50%25`,
        // which `begins_with` holds under both `50%25` and 1.36's `50%`.
        yield* h.seed({ ...rowNow("Row", { id: "left", region: "50%" }), zone: { S: "z" } })
        yield* h.inWorld(Migrating, (db) =>
          Effect.gen(function* () {
            const found = yield* db.entities.Rows.byTenant({ tenant: TENANT })
              .where((t: any, { beginsWith }: any) => beginsWith(t.region, "50%"))
              .collect()
            expect(idsOf(found)).toEqual(["left"])
          }),
        )
      }),
  },
  {
    name: "a sort key an index policy left, in current text, stays reachable",
    run: (h) =>
      Effect.gen(function* () {
        // The writer changed `group` without the composites before it: `preserve`.
        const row = rowNow("Row", { id: "1", region: REGION, zone: "z", group: "a" })
        yield* h.seed({ ...row, group: { S: "b" } })
        yield* h.inWorld(Migrating, (db) =>
          Effect.gen(function* () {
            const found = yield* db.entities.Rows.byTenant({
              tenant: TENANT,
              region: REGION,
            }).collect()
            expect(idsOf(found)).toEqual(["1"])
          }),
        )
      }),
  },
]

/** The table key the current code composes for `id`. */
const keysOf = (id: string) =>
  KeyComposer.composeIndexKeys(schema, "Row", 1, Migrating.Rows.indexes.primary, {
    id,
    name: "n",
  })

/** A row a write moved into its shard: the partition key composed, the sort key left. */
export const moved = (entityType: string, values: Values): StoredRow => {
  const now = rowNow(entityType, values)
  return { ...row136(entityType, values), pk: now.pk!, sk: now.sk!, gpk: now.gpk! }
}

/**
 * A row holding a half's composites gets the key they compose (D58), whatever text the
 * half held. 1.36 wrote `group_a`; a writer with no `region` then changed `group`, and
 * `preserve` kept the sort key.
 */
export const staleLegacySortKeyScenario = (h: Harness) =>
  Effect.gen(function* () {
    const row = row136("Row", { id: "1", region: REGION, zone: "z", group: "a" }, keysOf("1"))
    yield* h.seed({ ...row, group: { S: "b" } })
    yield* h.inWorld(Migrating, (db) =>
      Effect.gen(function* () {
        const dry = (yield* db.tables.MainTable.rekey({ dryRun: true })) as Table.RekeyReport
        expect(dry.indexKeysRewritten).toBe(1)
        expect(dry.conflicts).toEqual([])

        const first: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(first.indexKeysRewritten).toBe(1)
        expect(first.conflicts).toEqual([])

        const again: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(again.indexKeysRewritten).toBe(0)
        expect(again.unchanged).toBe(1)
      }),
    )
    const pinned = (group: string) => ({ tenant: TENANT, region: REGION, zone: "z", group })
    yield* h.inWorld(Finished, (db) =>
      Effect.gen(function* () {
        expect(idsOf(yield* db.entities.Rows.byTenant(pinned("b")).collect())).toEqual(["1"])
        expect(yield* db.entities.Rows.byTenant(pinned("a")).collect()).toEqual([])
      }),
    )
  })

/** The same of a key an index policy left in current text: the row's values decide. */
export const staleCurrentSortKeyScenario = (h: Harness) =>
  Effect.gen(function* () {
    const values = { id: "1", region: REGION, zone: "z" }
    yield* h.seed({ ...rowNow("Row", { ...values, group: "a" }), group: { S: "b" } })
    yield* h.inWorld(Migrating, (db) =>
      Effect.gen(function* () {
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.conflicts).toEqual([])
        expect(report.indexKeysRewritten).toBe(1)
      }),
    )
    const [after] = yield* h.rows()
    expect(after!.gsk?.S).toBe(rowNow("Row", { ...values, group: "b" }).gsk!.S)
  })

/**
 * Rows an old gate truncated though they hold every composite (D33): comparing repairs
 * them, as a side effect of `rekey` rewriting what differs. Nothing looks for them.
 */
export const truncatedHeldScenario = (h: Harness) =>
  Effect.gen(function* () {
    const whole = rowNow("Row", { id: "1", region: REGION, zone: "z", group: "g" })
    const truncated = rowNow("Row", { id: "1", region: REGION }).gsk!
    expect(truncated.S).not.toBe(whole.gsk!.S)
    yield* h.seed({ ...whole, gsk: truncated })
    yield* h.inWorld(Migrating, (db) =>
      Effect.gen(function* () {
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.indexKeysRewritten).toBe(1)
        expect(report.conflicts).toEqual([])
      }),
    )
    const [after] = yield* h.rows()
    expect(after!.gsk?.S).toBe(whole.gsk!.S)
  })

/**
 * And a row with no key stays that way, however much it holds: `rekey` compares what's
 * stored, and under `sparse` an absent key can be deliberate (D33).
 */
export const missingKeyScenario = (h: Harness) =>
  Effect.gen(function* () {
    const values = { region: REGION, zone: "z", group: "g" }
    const { gpk: _gpk, gsk: _gsk, ...noKeys } = rowNow("Row", { id: "1", ...values })
    const { gsk: _sortKey, ...noSortKey } = rowNow("Row", { id: "2", ...values })
    yield* h.seed(noKeys)
    yield* h.seed(noSortKey)
    yield* h.inWorld(Migrating, (db) =>
      Effect.gen(function* () {
        const dry = (yield* db.tables.MainTable.rekey({ dryRun: true })) as Table.RekeyReport
        expect(dry.indexKeysRewritten).toBe(0)
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.indexKeysRewritten).toBe(0)
        expect(report.unchanged).toBe(2)
        expect(report.conflicts).toEqual([])
      }),
    )
    const rows = yield* h.rows()
    expect(rows.map((row) => row.gsk)).toEqual([undefined])
    yield* h.inWorld(Finished, (db) =>
      Effect.gen(function* () {
        expect(yield* db.entities.Rows.byTenant({ tenant: TENANT }).collect()).toEqual([])
      }),
    )
  })

/**
 * A sort key missing a composite is left alone with no conflict, whatever it holds and
 * whatever the composites before the gap hold now: nothing says what its text meant.
 */
export const clearedHalfLeftScenario = (h: Harness) =>
  Effect.gen(function* () {
    const { group: _group, ...row } = row136(
      "Row",
      { id: "1", region: REGION, zone: "z", group: "g" },
      keysOf("1"),
    )
    yield* h.seed({ ...row, region: { S: "elsewhere" } })
    const stored = row.gsk!.S
    yield* h.inWorld(Migrating, (db) =>
      Effect.gen(function* () {
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.conflicts).toEqual([])
      }),
    )
    const [after] = yield* h.rows()
    expect(after!.gsk?.S).toBe(stored)
  })

/** A run that moves a row from its 1.36 table key judges the row it moved. */
export const moveJudgedScenario = (h: Harness) =>
  Effect.gen(function* () {
    // A gap in its sort key: `zone` is missing, so the move can't recompose it, and
    // 1.36's text of `region` alone is rewritten.
    yield* h.seed(row136("Row", { id: "1", name: "a b", region: REGION, group: "g" }))
    const report = (yield* h.inWorld(Migrating, (db) =>
      db.tables.MainTable.rekey(),
    )) as Table.RekeyReport
    expect(report.moved.item).toBe(1)
    expect(report.conflicts).toEqual([])
    const [row] = yield* h.rows()
    expect(row!.gsk?.S).toBe("$migrating#v1#row#region_new%20york")
    expect(row!.gpk?.S).toMatch(SHARD)
  })

/** And a move leaves a half it can't compose as it found it, in a dry run too. */
export const moveLeavesClearedHalfScenario = (h: Harness) =>
  Effect.gen(function* () {
    const row = row136("Row", { id: "1", name: "a b", region: REGION, zone: "z", group: "a" })
    yield* h.seed({ ...row, group: { S: "b" }, zone: { NULL: true } })
    const dry = (yield* h.inWorld(Migrating, (db) =>
      db.tables.MainTable.rekey({ dryRun: true }),
    )) as Table.RekeyReport
    expect(dry.conflicts).toEqual([])
    const report = (yield* h.inWorld(Migrating, (db) =>
      db.tables.MainTable.rekey(),
    )) as Table.RekeyReport
    expect(report.moved.item).toBe(1)
    expect(report.conflicts).toEqual([])
    const [after] = yield* h.rows()
    expect(after!.gsk?.S).toBe(row.gsk!.S)
  })

/** A sort key truncated under 1.36 is rewritten on an unsharded index too. */
export const truncatedUnshardedScenario = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.seed(row136("Row", { id: "1", region: REGION }, keysOf("1")))
    yield* h.inWorld(Unsharded, (db) =>
      Effect.gen(function* () {
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.indexKeysRewritten).toBe(1)
        expect(report.conflicts).toEqual([])
      }),
    )
    const [after] = yield* h.rows()
    expect(after!.gsk?.S).toBe("$migrating#v1#row#region_new%20york")
  })

/** A row under its current table key, its index keys as 1.36 composed `score`. */
const scored136 = (id: string, score: number): StoredRow => {
  const item = { id, name: "n", tenant: TENANT, at: 1, score }
  const index = KeyComposer.unshardedView(ScoredMigrating.Rows.indexes.byTenant)
  return toAttributeMap({
    ...item,
    ...keysOf(id),
    gpk: KeyText136.composePk(schema, "Row", index, item),
    gsk: KeyText136.composeSk(schema, "Row", 1, index, item),
    __edd_e__: "Row",
  }) as StoredRow
}

/**
 * The accepted limit on a sort key half (D58). The value goes and the sort key stays:
 * `.set({ score: undefined })` is legal, and nothing left says what the text meant. So
 * `rekey` leaves it, with no conflict, and once `previous` goes a broader query finds the
 * row where its old text sorts, while a pin on the cleared value misses it.
 */
export const clearedSortKeyLimitScenario = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.seed(scored136("1", -3))
    const pins = { tenant: TENANT, score: -3 }
    const broader = { tenant: TENANT }
    yield* h.inWorld(ScoredMigrating, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ id: "2", name: "n", tenant: TENANT, at: 1, score: -1 })
        yield* db.entities.Rows.update({ id: "1", name: "n" }).set({ score: undefined }).asEffect()
        // The fallback still reads it.
        expect(idsOf(yield* db.entities.Rows.byTenant(pins).collect())).toEqual(["1"])
        const dry = (yield* db.tables.MainTable.rekey({ dryRun: true })) as Table.RekeyReport
        expect(dry.conflicts).toEqual([])
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.conflicts).toEqual([])
        expect(idsOf(yield* db.entities.Rows.byTenant(pins).collect())).toEqual(["1"])
      }),
    )
    yield* h.inWorld(ScoredFinished, (db) =>
      Effect.gen(function* () {
        expect(yield* db.entities.Rows.byTenant(pins).collect()).toEqual([])
        // By its old text, after -1 though it held -3. In numeric order it came first.
        const found = yield* db.entities.Rows.byTenant(broader).collect()
        expect(found.map((row: { readonly id: string }) => row.id)).toEqual(["2", "1"])
      }),
    )
    // Writing the composite puts it back.
    yield* h.inWorld(ScoredMigrating, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.update({ id: "1", name: "n" }).set({ score: -3 }).asEffect()
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.conflicts).toEqual([])
      }),
    )
    yield* h.inWorld(ScoredFinished, (db) =>
      Effect.gen(function* () {
        expect(idsOf(yield* db.entities.Rows.byTenant(pins).collect())).toEqual(["1"])
        const found = yield* db.entities.Rows.byTenant(broader).collect()
        expect(found.map((row: { readonly id: string }) => row.id)).toEqual(["1", "2"])
      }),
    )
  })

/** A row whose partition key is 1.36's text for `score`, the value gone. */
const scoredPartition136 = (name: string, score: number): StoredRow => {
  const item = { id: "1", name, tenant: TENANT, at: 1, score }
  const index = ScoredPartition.Rows.indexes.byTenant
  const primary = ScoredPartition.Rows.indexes.primary
  const { score: _score, ...row } = toAttributeMap({
    ...item,
    pk: KeyText136.composePk(schema, "Row", primary, item),
    sk: KeyText136.composeSk(schema, "Row", 1, primary, item),
    gpk: KeyText136.composePk(schema, "Row", index, item),
    gsk: KeyText136.composeSk(schema, "Row", 1, index, item),
    __edd_e__: "Row",
  }) as StoredRow
  return row
}

/**
 * The accepted limit on a partition key half (D58): a pin on the old value reads the row
 * through the fallback, and only there. `rekey` leaves it, with no conflict, so with
 * `legacyKeys: false` that pin misses it, and `get` still reads the row.
 */
export const clearedPartitionKeyLimitScenario = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.seed(scoredPartition136("n", -3))
    const pins = { score: -3 }
    const key = { id: "1", name: "n" }
    yield* h.inWorld(ScoredPartition, (db) =>
      Effect.gen(function* () {
        expect(idsOf(yield* db.entities.Rows.byTenant(pins).collect())).toEqual(["1"])
        const dry = (yield* db.tables.MainTable.rekey({ dryRun: true })) as Table.RekeyReport
        expect(dry.conflicts).toEqual([])
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.conflicts).toEqual([])
        expect(report.indexKeysRewritten).toBe(0)
        expect(idsOf(yield* db.entities.Rows.byTenant(pins).collect())).toEqual(["1"])
      }),
    )
    yield* h.inWorld(ScoredPartitionOff, (db) =>
      Effect.gen(function* () {
        expect(yield* db.entities.Rows.byTenant(pins).collect()).toEqual([])
        expect((yield* db.entities.Rows.get(key).asEffect()).id).toBe("1")
      }),
    )
    // Writing the composite puts it back.
    yield* h.inWorld(ScoredPartition, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.update(key).set({ score: -3 }).asEffect()
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.conflicts).toEqual([])
      }),
    )
    yield* h.inWorld(ScoredPartitionOff, (db) =>
      Effect.gen(function* () {
        expect(idsOf(yield* db.entities.Rows.byTenant(pins).collect())).toEqual(["1"])
      }),
    )
  })

/** A positive integer's text didn't change: the row stays reachable, and nothing's reported. */
export const clearedIntegerScenario = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.seed(scored136("1", 42))
    const pins = { tenant: TENANT, score: 42 }
    yield* h.inWorld(ScoredMigrating, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.update({ id: "1", name: "n" }).set({ score: undefined }).asEffect()
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.conflicts).toEqual([])
      }),
    )
    yield* h.inWorld(ScoredFinished, (db) =>
      Effect.gen(function* () {
        expect(idsOf(yield* db.entities.Rows.byTenant(pins).collect())).toEqual(["1"])
      }),
    )
  })

const withoutTenant = (row: StoredRow): StoredRow => {
  const { tenant: _tenant, ...rest } = row
  return rest
}

/** What each of these seeds leaves `rekey` to do: a dry run must report exactly that. */
export const dryRunScenarios: ReadonlyArray<{
  readonly name: string
  readonly world: World
  readonly seed: ReadonlyArray<StoredRow>
  /** What the real run reports, so a scenario can't drift into covering nothing. */
  readonly reasons: ReadonlyArray<string>
}> = [
  {
    name: "a move recomposes a sort key an earlier run would have called stale",
    world: Migrating,
    seed: [
      {
        ...row136("Row", { id: "1", name: "a b", region: REGION, zone: "z", group: "a" }),
        group: { S: "b" },
      },
    ],
    reasons: [],
  },
  {
    name: "a move leaves a gap's 1.36 text to rewrite",
    world: Migrating,
    seed: [row136("Row", { id: "1", name: "a b", region: REGION, group: "g" })],
    reasons: [],
  },
  {
    name: "a move leaves a half it can't compose",
    world: Migrating,
    seed: [
      {
        ...row136("Row", { id: "1", name: "a b", region: REGION, zone: "z", group: "a" }),
        group: { S: "b" },
        zone: { NULL: true },
      },
    ],
    reasons: [],
  },
  {
    name: "a move over values that compose no shard",
    world: Migrating,
    seed: [withoutTenant(row136("Row", { id: "1", name: "a b", region: REGION }))],
    reasons: ["uncomposable"],
  },
  {
    // The conflict is all the move leaves: no other key differs.
    name: "a move over values that compose no shard, with nothing to rewrite",
    world: Migrating,
    seed: [withoutTenant(row136("Row", { id: "1", name: "a b" }))],
    reasons: ["uncomposable"],
  },
  {
    name: "in place: a key to rewrite",
    world: Migrating,
    seed: [row136("Row", { id: "1", region: REGION, zone: "z", group: "g" }, keysOf("1"))],
    reasons: [],
  },
  {
    name: "in place: a sort key its values no longer compose",
    world: Migrating,
    seed: [
      {
        ...row136("Row", { id: "1", region: REGION, zone: "z", group: "a" }, keysOf("1")),
        group: { S: "b" },
      },
    ],
    reasons: [],
  },
  {
    name: "in place: a number the row no longer holds",
    world: ScoredMigrating,
    seed: [
      (() => {
        const { score: _score, ...row } = scored136("1", -3)
        return row
      })(),
    ],
    reasons: [],
  },
  {
    name: "in place: a number the row no longer holds, on an unsharded index",
    world: ScoredUnsharded,
    seed: [
      (() => {
        const { score: _score, ...row } = scored136("1", -3)
        return row
      })(),
    ],
    reasons: [],
  },
  {
    name: "in place: values that compose no shard",
    world: Migrating,
    seed: [withoutTenant(row136("Row", { id: "1", region: REGION }, keysOf("1")))],
    reasons: ["uncomposable"],
  },
  {
    name: "in place: a partition key number to rewrite",
    world: ScoredPartition,
    seed: [{ ...scoredPartition136("n", -3), score: { N: "-3" } }],
    reasons: [],
  },
  {
    name: "in place: a partition key number the row no longer holds",
    world: ScoredPartition,
    seed: [scoredPartition136("n", -3)],
    reasons: [],
  },
  {
    name: "in place: a partition key integer the row no longer holds keeps its text",
    world: ScoredPartition,
    seed: [scoredPartition136("n", 42)],
    reasons: [],
  },
  {
    name: "a move leaves a partition key whose number the row no longer holds",
    world: ScoredPartition,
    seed: [scoredPartition136("a b", -3)],
    reasons: [],
  },
  {
    // `50%` escapes to what 1.36 wrote for `50%25`, so the first row's target holds the
    // second, stale itself. Nothing moved, so a dry run has nothing there to judge.
    name: "a move onto a key a stale row holds",
    world: Migrating,
    seed: [
      row136("Row", { id: "1", name: "50%", region: REGION, group: "g" }),
      row136("Row", { id: "1", name: "50%25", region: REGION, group: "g" }),
    ],
    reasons: [],
  },
  {
    name: "a retained row's move",
    world: Migrating,
    seed: [row136("Retained", { id: "1", name: "a b", region: REGION }, { version: 1 })],
    reasons: [],
  },
  {
    name: "rows of each kind at once",
    world: Migrating,
    seed: [
      row136("Row", { id: "1", name: "a b", region: REGION, zone: "z", group: "g" }),
      row136("Row", { id: "2", region: REGION, zone: "z", group: "g" }, keysOf("2")),
      {
        ...row136("Row", { id: "3", region: REGION, zone: "z", group: "a" }, keysOf("3")),
        group: { S: "b" },
      },
      rowNow("Row", { id: "4", region: "r" }),
    ],
    reasons: [],
  },
]

/** A dry run, then the real thing: the same report but for what a dry run can't measure. */
export const dryRunPredictsScenario =
  (scenario: (typeof dryRunScenarios)[number]) => (h: Harness) =>
    Effect.gen(function* () {
      for (const row of scenario.seed) yield* h.seed(row)
      const { dry, real } = yield* h.inWorld(scenario.world, (db) =>
        Effect.gen(function* () {
          const dry = (yield* db.tables.MainTable.rekey({ dryRun: true })) as Table.RekeyReport
          const real = (yield* db.tables.MainTable.rekey()) as Table.RekeyReport
          return { dry, real }
        }),
      )
      expect(real.conflicts.map((conflict) => conflict.reason)).toEqual(scenario.reasons)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
    })
