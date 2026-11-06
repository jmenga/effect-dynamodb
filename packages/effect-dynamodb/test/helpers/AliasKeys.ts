/**
 * After `rekey`, `foo bar` and `foo%20bar` are two values (#183). Rows from every key text a table
 * can hold — 1.36's, that of 1.37.0 and 1.38.0, either setting's — are seeded for real, by the setting
 * that wrote them, with those releases' partition key text put back on them. `rekey` then moves them to what the
 * setting composes, in both directions, and every operation on each value finds its own rows and
 * touches nothing of the other's. On a fresh table there is no alias at all. These scenarios run on
 * a recording table and on DynamoDB Local, through a {@link Harness}.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { unescapeKeyText } from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Option, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Query from "../../src/Query.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import type { Harness, StoredRows } from "./Rows137.js"

export type { Harness } from "./Rows137.js"

export type Scenario = {
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}

const SPACE = "foo bar"
const SPELLED = "foo%20bar"

/** Each value as the one asked about, the other as the one holding rows. */
const DIRECTIONS = [
  { name: "asking for `foo bar`", asked: SPACE, owner: SPELLED },
  { name: "asking for `foo%20bar`", asked: SPELLED, owner: SPACE },
] as const
type Direction = (typeof DIRECTIONS)[number]

/** Where the rows are, and what the setting is when `rekey` runs. */
export const CELLS = [
  {
    name: "rows 1.36 wrote, flag on",
    writer: false,
    as137: false,
    target: true,
    moves: true,
  },
  {
    name: "rows 1.37.0 wrote, flag on",
    writer: true,
    as137: true,
    target: true,
    moves: true,
  },
  {
    name: "rows 1.37.0 wrote, flag off",
    writer: true,
    as137: true,
    target: false,
    moves: true,
  },
  {
    name: "rows written with the flag on, flag off",
    writer: true,
    as137: false,
    target: false,
    moves: true,
  },
  { name: "a fresh table, flag on", writer: true, as137: false, target: true, moves: false },
  { name: "a fresh table, flag off", writer: false, as137: false, target: false, moves: false },
] as const
type Cell = (typeof CELLS)[number]

/**
 * Whether `rekey` has work: 1.37.0's partition key text is off's, so where no sort key holds a value
 * to escape, its rows are already where off reads them.
 */
const hasWork = (cell: Cell, escapedSortKey: boolean) =>
  cell.moves && (cell.target || !cell.as137 || escapedSortKey)

/** 1.37.0's partition keys: unescaped, where the flag's aren't. Its sort keys are the flag's. */
const as137 = (table: StoredRows, attributes: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const rows = yield* table.rows()
    // All out first: `foo%20bar`'s row lands where `foo bar`'s is now.
    yield* Effect.forEach(rows, (row) => table.remove(row))
    yield* Effect.forEach(rows, (row) => {
      const moved = { ...row }
      for (const attribute of [...attributes, "_entity_pk"]) {
        const text = row[attribute]?.S as string | undefined
        if (text !== undefined) moved[attribute] = { S: unescapeKeyText(text) }
      }
      return table.seed(moved)
    })
  })

const tagOf = (effect: Effect.Effect<unknown, unknown, any>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error as { readonly _tag: string })._tag),
  )

const expectNone = (rows: unknown) => expect(rows).toEqual([])

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const VARIANTS = [
  { name: "with sort key composites", sk: ["id"], rename: false },
  { name: "without sort key composites", sk: [], rename: false },
  { name: "with a field: rename", sk: ["id"], rename: true },
] as const
type Variant = (typeof VARIANTS)[number]

const entityWorld = (variant: Variant, escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "alias", version: 1, escapeKeys })
  const Doc = Schema.Struct({
    tenant: Schema.String,
    id: Schema.String,
    note: Schema.optional(Schema.String),
    owner: Schema.optional(Schema.String),
  })
  const renamed = {
    tenant: { field: "tenant_" },
    id: { field: "id_" },
    note: { field: "note_" },
    owner: { field: "owner_" },
  }
  const model = variant.rename ? DynamoModel.configure(Doc, renamed) : Doc
  const primaryKey = {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: variant.sk },
  }
  const byOwner = {
    name: "gsi1",
    collection: "owned",
    pk: { field: "gsi1pk", composite: ["owner"] },
    sk: { field: "gsi1sk", composite: ["id"] },
  }
  const Docs = Entity.make({
    model,
    entityType: "Doc",
    primaryKey,
    versioned: { retain: true },
    softDelete: true,
  } as never) as any
  const Rows = Entity.make({
    model,
    entityType: "Row",
    primaryKey,
    indexes: { byOwner },
  } as never) as any
  const Logs = Entity.make({
    model,
    entityType: "Log",
    primaryKey,
    indexes: { byOwner },
  } as never) as any
  const Reading = Schema.Struct({
    tenant: Schema.String,
    id: Schema.String,
    at: Schema.Number,
    note: Schema.optional(Schema.String),
  })
  const Readings = Entity.make({
    model: variant.rename
      ? DynamoModel.configure(Reading, { tenant: { field: "tenant_" }, id: { field: "id_" } })
      : Reading,
    entityType: "Reading",
    primaryKey,
    timeSeries: { orderBy: "at", appendInput: Reading },
  } as never) as any
  const Accounts = Entity.make({
    model,
    entityType: "Account",
    primaryKey,
    unique: { byOwner: ["owner"] },
  } as never) as any
  const entities = { Docs, Rows, Logs, Readings, Accounts }
  const MainTable = Table.make({ schema, entities } as never) as any
  const client = () => DynamoClient.make({ entities, tables: { MainTable } } as never) as any
  return { MainTable, client }
}

type EntityContext = {
  readonly db: any
  readonly table: StoredRows
  readonly variant: Variant
  readonly asked: string
  readonly owner: string
  /** An item's key, for `value`, in this variant. */
  readonly key: (value: string, id?: string) => Record<string, string>
  /** An item's whole key fields, for `value`. */
  readonly input: (value: string, id?: string) => Record<string, string>
}

const contextOf = (
  db: any,
  table: StoredRows,
  variant: Variant,
  direction: Direction,
): EntityContext => ({
  db,
  table,
  variant,
  asked: direction.asked,
  owner: direction.owner,
  key: (value, id = "1") => (variant.sk.length > 0 ? { tenant: value, id } : { tenant: value }),
  input: (value, id = "1") => ({ tenant: value, id }),
})

const noteOf = (value: string) => `${value}'s`

/** A partition of its own for what `value` holds in an index. */
const holderOf = (value: string) => (value === SPACE ? "held-space" : "held-spelled")

const hasSortComposites = (variant: Variant) => variant.sk.length > 0

/** What a value holds: a live document, its history, a tombstone, rows to query, a sentinel. */
const seedValue = (context: EntityContext, value: string) =>
  Effect.gen(function* () {
    const { db, input, key, variant } = context
    const docs = db.entities.Docs
    yield* docs.put({ ...input(value), note: "first" }).asEffect()
    yield* docs.update(key(value)).set({ note: "second" }).asEffect()
    yield* docs.delete(key(value)).asEffect()
    yield* docs.put({ ...input(value), note: noteOf(value) }).asEffect()
    for (const id of ["1", "2", "a b1"]) {
      yield* db.entities.Rows.put({ ...input(value, id), note: noteOf(value) }).asEffect()
    }
    const holder = holderOf(value)
    yield* db.entities.Rows.put({ tenant: holder, id: "o1", owner: value }).asEffect()
    yield* db.entities.Logs.put({ tenant: holder, id: "l1", owner: value }).asEffect()
    yield* db.entities.Accounts.put({ tenant: holder, id: "a1", owner: value }).asEffect()
    yield* db.entities.Readings.append({ ...input(value), at: 1, note: noteOf(value) }).asEffect()
    yield* db.entities.Readings.append({ ...input(value), at: 2, note: noteOf(value) }).asEffect()
    // The value in a sort key: the chain in the half 1.37.0 escaped.
    if (hasSortComposites(variant)) {
      yield* db.entities.Rows.put({ tenant: "shared", id: value, note: noteOf(value) }).asEffect()
    }
  })

/** Every read of `value` finds its own rows, and only those. */
const expectValueIntact = (context: EntityContext, value: string) =>
  Effect.gen(function* () {
    const { db, key, variant } = context
    const k = key(value)
    const docs = db.entities.Docs
    const doc = yield* docs.get(k)
    expect(doc.note).toBe(noteOf(value))
    expect(doc.tenant).toBe(value)
    expect((yield* docs.getVersion(k, 1)).tenant).toBe(value)
    const versions: ReadonlyArray<any> = yield* docs.versions(k).collect()
    expect(versions.length).toBeGreaterThan(0)
    for (const version of versions) expect(version.tenant).toBe(value)
    expect((yield* docs.deleted.get(k)).tenant).toBe(value)
    const tombstones: ReadonlyArray<any> = yield* docs.deleted.list(k).collect()
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0].tenant).toBe(value)

    const rows = db.entities.Rows
    const query = () => rows.primary({ tenant: value })
    const all: ReadonlyArray<any> = yield* query().collect()
    const ids = hasSortComposites(variant) ? ["1", "2", "a b1"] : ["a b1"]
    expect(all.map((row) => row.id)).toEqual(ids)
    for (const row of all) expect(row.tenant).toBe(value)
    expect(yield* query().count()).toBe(ids.length)
    const selected: ReadonlyArray<any> = yield* query().select(["note"]).collect()
    expect(selected.map((row) => row.note)).toEqual(ids.map(() => noteOf(value)))
    if (hasSortComposites(variant)) {
      const first: any = yield* query().limit(1).fetch()
      expect(first.items.map((row: any) => row.id)).toEqual(["1"])
      const rest: ReadonlyArray<any> = yield* query().startFrom(first.cursor.value).collect()
      expect(rest.map((row) => row.id)).toEqual(["2", "a b1"])
      const ranged: ReadonlyArray<any> = yield* query()
        .where((t: any, ops: any) => ops.gte(t.id, "2"))
        .collect()
      expect(ranged.map((row) => row.id)).toEqual(["2", "a b1"])
      const within: ReadonlyArray<any> = yield* query()
        .within({ id: { gte: "2" } })
        .collect()
      expect(within.map((row) => row.id)).toEqual(["2", "a b1"])
      const shared: any = yield* rows.get({ tenant: "shared", id: value })
      expect(shared.note).toBe(noteOf(value))
      const pinned: ReadonlyArray<any> = yield* rows
        .primary({ tenant: "shared", id: value })
        .collect()
      expect(pinned.map((row) => row.id)).toEqual([value])
    }
    const indexed: ReadonlyArray<any> = yield* rows.byOwner({ owner: value }).collect()
    expect(indexed.map((row) => row.tenant)).toEqual([holderOf(value)])
    const collected: any = yield* db.collections.owned({ owner: value }).collect()
    expect(collected.Rows.map((row: any) => row.tenant)).toEqual([holderOf(value)])
    expect(collected.Logs.map((row: any) => row.tenant)).toEqual([holderOf(value)])

    const events: ReadonlyArray<any> = yield* db.entities.Readings.history(k).collect()
    expect(events.map((event) => event.at).sort()).toEqual([1, 2])
    for (const event of events) expect(event.tenant).toBe(value)
    expect((yield* db.entities.Readings.get(k)).at).toBe(2)

    const [batched]: ReadonlyArray<any> = yield* Batch.get([docs.get(k)]) as any
    expect(batched.note).toBe(noteOf(value))
    const [transacted]: ReadonlyArray<any> = yield* Transaction.transactGet([docs.get(k)]) as any
    expect(transacted.note).toBe(noteOf(value))

    const holder = holderOf(value)
    const account: any = yield* db.entities.Accounts.get(key(holder, "a1"))
    expect(account.owner).toBe(value)
    expect(
      yield* tagOf(
        db.entities.Accounts.put({ tenant: `${holder}-2`, id: "a2", owner: value }).asEffect(),
      ),
    ).toBe("UniqueConstraintViolation")
  })

const seededEntities = (
  h: Harness,
  variant: Variant,
  cell: Cell,
  direction: Direction,
  values: ReadonlyArray<string>,
  body: (context: EntityContext, report: Table.RekeyReport) => Effect.Effect<void, unknown, any>,
) => {
  const writer = entityWorld(variant, cell.writer)
  const world = entityWorld(variant, cell.target)
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      yield* table.as(writer, (written) =>
        Effect.forEach(values, (value) =>
          seedValue(contextOf(written, table, variant, direction), value),
        ),
      )
      if (cell.as137) yield* as137(table, ["pk", "gsi1pk"])
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.conflicts).toEqual([])
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(report.moved.item > 0).toBe(hasWork(cell, hasSortComposites(variant)))
      yield* body(contextOf(db, table, variant, direction), report)
    }),
  )
}

/** Every read of each value after `rekey`, the dry run agreeing, and a second run with no work. */
export const entityValueScenarios: ReadonlyArray<Scenario> = VARIANTS.flatMap((variant) =>
  CELLS.map(
    (cell): Scenario => ({
      name: `${variant.name}, ${cell.name}: each value reads its own rows`,
      run: (h) => {
        const writer = entityWorld(variant, cell.writer)
        const world = entityWorld(variant, cell.target)
        const direction = DIRECTIONS[0]
        return h.on(world, (db, table) =>
          Effect.gen(function* () {
            yield* table.as(writer, (written) =>
              Effect.forEach([SPACE, SPELLED], (value) =>
                seedValue(contextOf(written, table, variant, direction), value),
              ),
            )
            if (cell.as137) yield* as137(table, ["pk", "gsi1pk"])
            const before = yield* table.rows()
            const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
            expect(yield* table.rows()).toEqual(before)
            const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
            expect(report.conflicts).toEqual([])
            expect(report.skipped).toEqual(dry.skipped)
            expect(report.moved).toEqual(dry.moved)
            expect(report.indexKeysRewritten).toBe(dry.indexKeysRewritten)
            expect(report.sentinelsMoved).toBe(dry.sentinelsMoved)
            expect(report.skipped.unrecognizedKey).toBe(0)
            expect(report.moved.item > 0).toBe(hasWork(cell, hasSortComposites(variant)))
            const context = contextOf(db, table, variant, direction)
            yield* expectValueIntact(context, SPACE)
            yield* expectValueIntact(context, SPELLED)
            const after = yield* table.rows()
            const again: Table.RekeyReport = yield* db.tables.MainTable.rekey()
            expect(again.conflicts).toEqual([])
            expect(again.moved.item).toBe(0)
            expect(again.indexKeysRewritten).toBe(0)
            expect(again.sentinelsMoved).toBe(0)
            expect(yield* table.rows()).toEqual(after)
          }),
        )
      },
    }),
  ),
)

/** The asked value holds nothing: every operation on it finds nothing of the other value's. */
const ABSENT_OPERATIONS: ReadonlyArray<{
  readonly name: string
  readonly when?: (variant: Variant) => boolean
  readonly run: (context: EntityContext) => Effect.Effect<void, unknown, any>
}> = [
  {
    name: "get",
    run: ({ asked, db, key }) =>
      Effect.map(tagOf(db.entities.Docs.get(key(asked))), (tag) =>
        expect(tag).toBe("ItemNotFound"),
      ),
  },
  {
    name: "getVersion",
    run: ({ asked, db, key }) =>
      Effect.map(tagOf(db.entities.Docs.getVersion(key(asked), 1)), (tag) =>
        expect(tag).toBe("ItemNotFound"),
      ),
  },
  {
    name: "versions",
    run: ({ asked, db, key }) =>
      Effect.map(db.entities.Docs.versions(key(asked)).collect(), expectNone),
  },
  {
    name: "deleted.get",
    run: ({ asked, db, key }) =>
      Effect.map(tagOf(db.entities.Docs.deleted.get(key(asked))), (tag) =>
        expect(tag).toBe("ItemNotFound"),
      ),
  },
  {
    name: "deleted.list",
    run: ({ asked, db, key }) =>
      Effect.map(db.entities.Docs.deleted.list(key(asked)).collect(), expectNone),
  },
  {
    name: "restore",
    run: ({ asked, db, key }) =>
      Effect.map(tagOf(db.entities.Docs.restore(key(asked))), (tag) =>
        expect(tag).toBe("ItemNotFound"),
      ),
  },
  {
    name: "purge",
    run: ({ asked, db, key, table }) =>
      Effect.gen(function* () {
        const before = (yield* table.rows()).length
        yield* db.entities.Docs.purge(key(asked))
        expect(yield* table.rows()).toHaveLength(before)
      }),
  },
  {
    name: "a query",
    run: ({ asked, db }) =>
      Effect.map(db.entities.Rows.primary({ tenant: asked }).collect(), expectNone),
  },
  {
    name: "a count",
    run: ({ asked, db }) =>
      Effect.map(db.entities.Rows.primary({ tenant: asked }).count(), (count) =>
        expect(count).toBe(0),
      ),
  },
  {
    name: "a query selecting one field",
    run: ({ asked, db }) =>
      Effect.map(
        db.entities.Rows.primary({ tenant: asked }).select(["note"]).collect(),
        expectNone,
      ),
  },
  {
    name: "a page",
    run: ({ asked, db }) =>
      Effect.map(db.entities.Rows.primary({ tenant: asked }).limit(1).fetch(), (page: any) => {
        expect(page.items).toEqual([])
        expect(Option.isNone(page.cursor)).toBe(true)
      }),
  },
  {
    name: "a range",
    when: hasSortComposites,
    run: ({ asked, db }) =>
      Effect.map(
        db.entities.Rows.primary({ tenant: asked })
          .where((t: any, ops: any) => ops.gte(t.id, "1"))
          .collect(),
        expectNone,
      ),
  },
  {
    name: "a within",
    when: hasSortComposites,
    run: ({ asked, db }) =>
      Effect.map(
        db.entities.Rows.primary({ tenant: asked })
          .within({ id: { gte: "1" } })
          .collect(),
        expectNone,
      ),
  },
  {
    name: "an index",
    run: ({ asked, db }) =>
      Effect.map(db.entities.Rows.byOwner({ owner: asked }).collect(), expectNone),
  },
  {
    name: "a collection",
    run: ({ asked, db }) =>
      Effect.map(db.collections.owned({ owner: asked }).collect(), (found: any) => {
        expect(found.Rows).toEqual([])
        expect(found.Logs).toEqual([])
      }),
  },
  {
    name: "a time series' history",
    run: ({ asked, db, key }) =>
      Effect.map(db.entities.Readings.history(key(asked)).collect(), expectNone),
  },
  {
    name: "a time series' append",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Readings.append({ ...input(asked), at: 1, note: "mine" }).asEffect()
        const mine: ReadonlyArray<any> = yield* db.entities.Readings.history(key(asked)).collect()
        expect(mine.map((event) => event.at)).toEqual([1])
        expect(mine[0].tenant).toBe(asked)
      }),
  },
  {
    name: "put",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put({ ...input(asked), note: "mine" }).asEffect()
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "upsert",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.upsert({ ...input(asked), note: "mine" }).asEffect()
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "create",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.create({ ...input(asked), note: "mine" }).asEffect()
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "update",
    run: ({ asked, db, key }) =>
      Effect.map(
        tagOf(db.entities.Docs.update(key(asked)).set({ note: "mine" }).asEffect()),
        (tag) => expect(tag).toBe("ItemNotFound"),
      ),
  },
  {
    name: "patch",
    run: ({ asked, db, key }) =>
      Effect.map(
        tagOf(db.entities.Docs.patch(key(asked)).set({ note: "mine" }).asEffect()),
        (tag) => expect(tag).toBe("ConditionalCheckFailed"),
      ),
  },
  {
    name: "delete",
    run: ({ asked, db, key, table }) =>
      Effect.gen(function* () {
        const before = (yield* table.rows()).length
        yield* db.entities.Rows.delete(key(asked)).asEffect()
        expect(yield* table.rows()).toHaveLength(before)
      }),
  },
  {
    name: "a soft delete",
    run: ({ asked, db, key }) =>
      Effect.map(tagOf(db.entities.Docs.delete(key(asked)).asEffect()), (tag) =>
        expect(tag).toBe("ItemNotFound"),
      ),
  },
  {
    name: "deleteIfExists",
    run: ({ asked, db, key }) =>
      Effect.map(tagOf(db.entities.Docs.deleteIfExists(key(asked)).asEffect()), (tag) =>
        expect(tag).toBe("ConditionalCheckFailed"),
      ),
  },
  {
    name: "Batch.get",
    run: ({ asked, db, key }) =>
      Effect.map(Batch.get([db.entities.Docs.get(key(asked))]), (got: any) =>
        expect(got).toEqual([undefined]),
      ),
  },
  {
    name: "Batch.write of a delete",
    run: ({ asked, db, key, table }) =>
      Effect.gen(function* () {
        const before = (yield* table.rows()).length
        yield* Batch.write([db.entities.Rows.delete(key(asked))]) as Effect.Effect<
          void,
          unknown,
          any
        >
        expect(yield* table.rows()).toHaveLength(before)
      }),
  },
  {
    name: "transactGet",
    run: ({ asked, db, key }) =>
      Effect.map(Transaction.transactGet([db.entities.Docs.get(key(asked))]), (got: any) =>
        expect(got).toEqual([undefined]),
      ),
  },
  {
    name: "transactWrite of a put",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* Transaction.transactWrite([db.entities.Docs.put({ ...input(asked), note: "mine" })])
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "a unique constraint on the value is free",
    run: ({ asked, db }) =>
      Effect.gen(function* () {
        const account = { tenant: "new-holder", id: "a9", owner: asked }
        yield* db.entities.Accounts.put(account).asEffect()
        const held: any = yield* db.entities.Accounts.get({ tenant: "new-holder", id: "a9" })
        expect(held.owner).toBe(asked)
      }),
  },
]

/** Both values hold rows: a write of one changes that one's, and nothing of the other's. */
const PRESENT_OPERATIONS: ReadonlyArray<{
  readonly name: string
  readonly when?: (variant: Variant) => boolean
  readonly run: (context: EntityContext) => Effect.Effect<void, unknown, any>
}> = [
  {
    name: "put",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put({ ...input(asked), note: "mine" }).asEffect()
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "upsert",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.upsert({ ...input(asked), note: "mine" }).asEffect()
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "create refused by its own row",
    run: ({ asked, db, input }) =>
      Effect.map(
        tagOf(db.entities.Docs.create({ ...input(asked), note: "mine" }).asEffect()),
        (tag) => expect(tag).toBe("ConditionalCheckFailed"),
      ),
  },
  {
    name: "update",
    run: ({ asked, db, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.update(key(asked)).set({ note: "mine" }).asEffect()
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "patch",
    run: ({ asked, db, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.patch(key(asked)).set({ note: "mine" }).asEffect()
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "an update moving an index",
    run: ({ asked, db, key }) =>
      Effect.gen(function* () {
        const holder = holderOf(asked)
        yield* db.entities.Rows.update(key(holder, "o1")).set({ owner: "moved" }).asEffect()
        expect(yield* db.entities.Rows.byOwner({ owner: asked }).collect()).toEqual([])
        const moved: ReadonlyArray<any> = yield* db.entities.Rows.byOwner({
          owner: "moved",
        }).collect()
        expect(moved.map((row) => row.tenant)).toEqual([holder])
      }),
  },
  {
    name: "delete",
    run: ({ asked, db, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.delete(key(asked, "a b1")).asEffect()
        expect(yield* tagOf(db.entities.Rows.get(key(asked, "a b1")))).toBe("ItemNotFound")
      }),
  },
  {
    name: "a soft delete, then a restore",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.purge(key(asked))
        yield* db.entities.Docs.put({ ...input(asked), note: "mine" }).asEffect()
        yield* db.entities.Docs.delete(key(asked)).asEffect()
        expect(yield* tagOf(db.entities.Docs.get(key(asked)))).toBe("ItemNotFound")
        expect((yield* db.entities.Docs.deleted.get(key(asked))).note).toBe("mine")
        yield* db.entities.Docs.restore(key(asked))
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "deleteIfExists",
    run: ({ asked, db, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.deleteIfExists(key(asked)).asEffect()
        expect(yield* tagOf(db.entities.Docs.get(key(asked)))).toBe("ItemNotFound")
      }),
  },
  {
    name: "purge",
    run: ({ asked, db, key, table }) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.purge(key(asked))
        expect(yield* tagOf(db.entities.Docs.get(key(asked)))).toBe("ItemNotFound")
        expect(yield* db.entities.Docs.versions(key(asked)).collect()).toEqual([])
        const rows = yield* table.rows()
        expect(rows.filter((row) => row.__edd_e__?.S === "Doc").length).toBeGreaterThan(0)
      }),
  },
  {
    name: "a time series' append",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* db.entities.Readings.append({ ...input(asked), at: 3, note: "mine" }).asEffect()
        const mine: ReadonlyArray<any> = yield* db.entities.Readings.history(key(asked)).collect()
        expect(mine.map((event) => event.at).sort()).toEqual([1, 2, 3])
      }),
  },
  {
    name: "Batch.write",
    run: ({ asked, db, input, key }) =>
      Effect.gen(function* () {
        yield* Batch.write([
          db.entities.Rows.put({ ...input(asked, "1"), note: "mine" }),
        ]) as Effect.Effect<void, unknown, any>
        expect((yield* db.entities.Rows.get(key(asked, "1"))).note).toBe("mine")
      }),
  },
  {
    name: "transactWrite of an update",
    run: ({ asked, db, key }) =>
      Effect.gen(function* () {
        yield* Transaction.transactWrite([
          db.entities.Docs.update(key(asked)).set({ note: "mine" }),
        ])
        expect((yield* db.entities.Docs.get(key(asked))).note).toBe("mine")
      }),
  },
  {
    name: "deleting a holder releases its own sentinel, not the other value's",
    run: ({ asked, db, key }) =>
      Effect.gen(function* () {
        const holder = holderOf(asked)
        yield* db.entities.Accounts.delete(key(holder, "a1")).asEffect()
        const next = { tenant: `${holder}-3`, id: "a3", owner: asked }
        yield* db.entities.Accounts.put(next).asEffect()
        const held: any = yield* db.entities.Accounts.get({ tenant: next.tenant, id: "a3" })
        expect(held.owner).toBe(asked)
      }),
  },
]

/** Every operation over the rows of every cell and direction, for the given variants. */
export const entityOperationScenarios = (
  variants: ReadonlyArray<Variant> = VARIANTS,
  cells: ReadonlyArray<Cell> = CELLS,
): ReadonlyArray<Scenario> =>
  variants.flatMap((variant) =>
    cells.flatMap((cell) =>
      DIRECTIONS.flatMap((direction) => {
        const label = `${variant.name}, ${cell.name}, ${direction.name}`
        const absent = ABSENT_OPERATIONS.filter((op) => op.when?.(variant) ?? true).map(
          (operation): Scenario => ({
            name: `${label}: nothing to find, ${operation.name}`,
            run: (h) =>
              seededEntities(h, variant, cell, direction, [direction.owner], (context) =>
                Effect.gen(function* () {
                  yield* operation.run(context)
                  yield* expectValueIntact(context, direction.owner)
                }),
              ),
          }),
        )
        const present = PRESENT_OPERATIONS.filter((op) => op.when?.(variant) ?? true).map(
          (operation): Scenario => ({
            name: `${label}: both hold rows, ${operation.name}`,
            run: (h) =>
              seededEntities(h, variant, cell, direction, [SPACE, SPELLED], (context) =>
                Effect.gen(function* () {
                  yield* operation.run(context)
                  yield* expectValueIntact(context, direction.owner)
                }),
              ),
          }),
        )
        return [...absent, ...present]
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

const holderTable = (schema: DynamoSchema.DynamoSchema) => {
  const Holder = Entity.make({
    model: Schema.Struct({ id: Schema.String, area: Schema.String }),
    entityType: "Holder",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byArea: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["area"] },
        sk: { field: "gsi1sk", composite: ["id"] },
      },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Holder } } as never) as any
  return { Holder, MainTable }
}

const aggregateWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "alias", version: 1, escapeKeys })
  const { Holder, MainTable } = holderTable(schema)
  const Route = Schema.Struct({
    id: Schema.String,
    area: Schema.String,
    note: Schema.String,
    stops: Schema.Array(Schema.Struct({ label: Schema.String })),
  })
  const Routes = Aggregate.make(
    Route as never,
    {
      table: MainTable,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "routes" },
      list: {
        index: "gsi1",
        name: "routesByArea",
        pk: { field: "gsi1pk", composite: ["area"] },
        sk: { field: "gsi1sk", composite: ["id"] },
      },
      root: { entityType: "RouteItem" },
      edges: { stops: Aggregate.many({ entityType: "RouteStop", sk: { composite: ["label"] } }) },
    } as never,
  ) as any
  const client = () =>
    DynamoClient.make({
      entities: { Holder },
      aggregates: { Routes },
      tables: { MainTable },
    } as never) as any
  return { MainTable, client }
}

const route = (id: string, note: string) => ({
  id,
  area: id,
  note,
  stops: [{ label: "first" }, { label: "second" }, { label: id }],
})

const absent = "AggregateAssemblyError"

const seededAggregates = (
  h: Harness,
  cell: Cell,
  values: ReadonlyArray<string>,
  body: (db: any, table: StoredRows) => Effect.Effect<void, unknown, any>,
) => {
  const writer = aggregateWorld(cell.writer)
  const world = aggregateWorld(cell.target)
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      yield* table.as(writer, (written) =>
        Effect.forEach(values, (value) =>
          written.aggregates.Routes.create(route(value, noteOf(value))),
        ),
      )
      if (cell.as137) yield* as137(table, ["pk", "gsi1pk"])
      const before = yield* table.rows()
      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
      expect(yield* table.rows()).toEqual(before)
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.conflicts).toEqual([])
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(report.moved).toEqual(dry.moved)
      expect(report.moved.aggregate > 0).toBe(hasWork(cell, true))
      const after = yield* table.rows()
      const again: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(again.moved.aggregate).toBe(0)
      expect(yield* table.rows()).toEqual(after)
      yield* body(db, table)
    }),
  )
}

const expectRouteIntact = (db: any, value: string) =>
  Effect.gen(function* () {
    const one: any = yield* db.aggregates.Routes.get({ id: value })
    expect(one.note).toBe(noteOf(value))
    expect(one.id).toBe(value)
    expect(one.stops.map((stop: any) => stop.label).sort()).toEqual(
      ["first", "second", value].sort(),
    )
    const listed: any = yield* db.aggregates.Routes.list({ area: value })
    expect(listed.data.map((item: any) => item.id)).toEqual([value])
    expect(listed.data[0].stops).toHaveLength(3)
  })

const AGGREGATE_OPERATIONS: ReadonlyArray<{
  readonly name: string
  /** Whether the asked value holds an aggregate too. */
  readonly both: boolean
  readonly run: (db: any, direction: Direction) => Effect.Effect<void, unknown, any>
}> = [
  {
    name: "get reads as absent",
    both: false,
    run: (db, { asked }) =>
      Effect.map(tagOf(db.aggregates.Routes.get({ id: asked })), (tag) => expect(tag).toBe(absent)),
  },
  {
    name: "update reads as absent",
    both: false,
    run: (db, { asked }) =>
      Effect.map(
        tagOf(
          db.aggregates.Routes.update({ id: asked }, ({ state }: any) => ({
            ...state,
            note: "changed",
          })),
        ),
        (tag) => expect(tag).toBe(absent),
      ),
  },
  {
    name: "delete removes nothing of the other's",
    both: false,
    run: (db, { asked }) =>
      db.aggregates.Routes.delete({ id: asked }).pipe(Effect.ignore) as Effect.Effect<
        void,
        unknown,
        any
      >,
  },
  {
    name: "create lands on its own key",
    both: false,
    run: (db, { asked }) =>
      Effect.gen(function* () {
        yield* db.aggregates.Routes.create(route(asked, noteOf(asked)))
        yield* expectRouteIntact(db, asked)
      }),
  },
  {
    name: "list finds nothing",
    both: false,
    run: (db, { asked }) =>
      Effect.map(db.aggregates.Routes.list({ area: asked }), (found: any) =>
        expect(found.data).toEqual([]),
      ),
  },
  {
    name: "create is refused by its own root",
    both: true,
    run: (db, { asked }) =>
      Effect.map(tagOf(db.aggregates.Routes.create(route(asked, "mine"))), (tag) =>
        expect(tag).toBe("ConditionalCheckFailed"),
      ),
  },
  {
    name: "update changes its own",
    both: true,
    run: (db, { asked }) =>
      Effect.gen(function* () {
        yield* db.aggregates.Routes.update({ id: asked }, ({ state }: any) => ({
          ...state,
          note: "changed",
        }))
        expect((yield* db.aggregates.Routes.get({ id: asked })).note).toBe("changed")
      }),
  },
  {
    name: "delete removes its own",
    both: true,
    run: (db, { asked }) =>
      Effect.gen(function* () {
        yield* db.aggregates.Routes.delete({ id: asked })
        expect(yield* tagOf(db.aggregates.Routes.get({ id: asked }))).toBe(absent)
      }),
  },
]

export const aggregateValueScenarios: ReadonlyArray<Scenario> = CELLS.flatMap((cell) => [
  {
    name: `${cell.name}: each value reads its own aggregate`,
    run: (h: Harness) =>
      seededAggregates(h, cell, [SPACE, SPELLED], (db) =>
        Effect.gen(function* () {
          yield* expectRouteIntact(db, SPACE)
          yield* expectRouteIntact(db, SPELLED)
        }),
      ),
  },
  ...DIRECTIONS.flatMap((direction) =>
    AGGREGATE_OPERATIONS.map(
      (operation): Scenario => ({
        name: `${cell.name}, ${direction.name}: ${operation.name}`,
        run: (h) =>
          seededAggregates(h, cell, operation.both ? [SPACE, SPELLED] : [direction.owner], (db) =>
            Effect.gen(function* () {
              yield* operation.run(db, direction)
              yield* expectRouteIntact(db, direction.owner)
            }),
          ),
      }),
    ),
  ),
])

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

class Added extends Schema.TaggedClass<Added>()("Added", { value: Schema.Number }) {}
const Total = Schema.Struct({ total: Schema.Number })

const STREAM_IDS = [
  {
    name: "one composite",
    composite: ["id"],
    of: (value: string) => ({ id: value }),
  },
  {
    name: "two composites",
    composite: ["tenant", "id"],
    of: (value: string) => ({ tenant: "t", id: value }),
  },
] as const
type StreamIds = (typeof STREAM_IDS)[number]

const streamWorld = (ids: StreamIds, escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "alias", version: 1, escapeKeys })
  const { Holder, MainTable } = holderTable(schema)
  const Events = EventStore.makeStream({
    table: MainTable,
    streamName: "Events",
    events: [Added],
    streamId: { composite: ids.composite },
    snapshot: { schema: Total },
  } as never) as any
  const Inline = EventStore.makeStream({
    table: MainTable,
    streamName: "Inline",
    events: [Added],
    streamId: { composite: ids.composite },
    snapshot: { schema: Total, mode: "inline" },
  } as never) as any
  const client = () =>
    DynamoClient.make({ entities: { Holder }, tables: { MainTable } } as never) as any
  return { Events, Inline, MainTable, client }
}
type StreamWorld = ReturnType<typeof streamWorld>

const decider: any = {
  initialState: { total: 0 },
  decide: (command: { readonly value: number }) =>
    Effect.succeed([new Added({ value: command.value })]),
  evolve: (state: { readonly total: number }, event: Added) => ({
    total: state.total + event.value,
  }),
}

const added = (value: number) => new Added({ value })

const seedStream = (world: StreamWorld, id: Record<string, string>) =>
  Effect.gen(function* () {
    yield* world.Events.append(id, [added(1), added(2)], 0)
    yield* world.Events.writeSnapshot(id, { total: 3 }, 2)
    yield* (EventStore.commandHandler as any)(decider, world.Inline)(id, { value: 1 })
  })

const expectStreamIntact = (world: StreamWorld, id: Record<string, string>) =>
  Effect.gen(function* () {
    const events: ReadonlyArray<any> = yield* world.Events.read(id)
    expect(events.map((event) => event.version)).toEqual([1, 2])
    const latest: any = yield* world.Events.readLatest(id)
    expect(latest.version).toBe(2)
    expect(Option.isSome(latest.snapshot)).toBe(true)
    const snapshot: any = yield* world.Events.readSnapshot(id)
    expect(snapshot.value.state.total).toBe(3)
    expect(yield* world.Events.currentVersion(id)).toBe(2)
    const inline: any = yield* world.Inline.readLatest(id, { verifySnapshot: false })
    expect(inline.version).toBe(1)
  })

const STREAM_OPERATIONS: ReadonlyArray<{
  readonly name: string
  readonly run: (world: StreamWorld, asked: Record<string, string>) => Effect.Effect<void, any, any>
}> = [
  { name: "read", run: (world, asked) => Effect.map(world.Events.read(asked), expectNone) },
  {
    name: "readFrom",
    run: (world, asked) => Effect.map(world.Events.readFrom(asked, 0), expectNone),
  },
  {
    name: "readLatest",
    run: (world, asked) =>
      Effect.map(world.Events.readLatest(asked), (latest: any) => {
        expect(latest.events).toEqual([])
        expect(latest.version).toBe(0)
        expect(Option.isNone(latest.snapshot)).toBe(true)
      }),
  },
  {
    name: "currentVersion",
    run: (world, asked) =>
      Effect.map(world.Events.currentVersion(asked), (version) => expect(version).toBe(0)),
  },
  {
    name: "query.events",
    run: (world, asked) => Effect.map(Query.collect(world.Events.query.events(asked)), expectNone),
  },
  {
    name: "append at a version it doesn't have is a conflict",
    run: (world, asked) =>
      Effect.map(tagOf(world.Events.append(asked, [added(9)], 1)), (tag) =>
        expect(tag).toBe("VersionConflict"),
      ),
  },
  {
    name: "append at 0 and writeSnapshot land under its own key",
    run: (world, asked) =>
      Effect.gen(function* () {
        yield* world.Events.append(asked, [added(9)], 0)
        yield* world.Events.writeSnapshot(asked, { total: 9 }, 1)
        const events: ReadonlyArray<any> = yield* world.Events.read(asked)
        expect(events.map((event) => event.data.value)).toEqual([9])
        const snapshot: any = yield* world.Events.readSnapshot(asked)
        expect(snapshot.value.state.total).toBe(9)
      }),
  },
  {
    name: "a command starts at version 0",
    run: (world, asked) =>
      Effect.gen(function* () {
        yield* (EventStore.commandHandler as any)(decider, world.Events)(asked, { value: 9 })
        expect(yield* world.Events.currentVersion(asked)).toBe(1)
      }),
  },
]

const seededStreams = (
  h: Harness,
  ids: StreamIds,
  cell: Cell,
  values: ReadonlyArray<string>,
  body: (world: StreamWorld) => Effect.Effect<void, unknown, any>,
) => {
  const writer = streamWorld(ids, cell.writer)
  const world = streamWorld(ids, cell.target)
  const streams = [world.Events, world.Inline]
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      yield* table.as(writer, () =>
        Effect.forEach(values, (value) => seedStream(writer, ids.of(value))),
      )
      if (cell.as137) yield* as137(table, ["pk"])
      const before = yield* table.rows()
      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true, streams })
      expect(yield* table.rows()).toEqual(before)
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey({ streams })
      expect(report.conflicts).toEqual([])
      expect(report.skipped.unrecognizedKey).toBe(0)
      expect(report.moved).toEqual(dry.moved)
      expect(report.moved.stream > 0).toBe(hasWork(cell, false))
      const after = yield* table.rows()
      const again: Table.RekeyReport = yield* db.tables.MainTable.rekey({ streams })
      expect(again.moved.stream).toBe(0)
      expect(yield* table.rows()).toEqual(after)
      yield* body(world)
    }),
  )
}

export const streamValueScenarios: ReadonlyArray<Scenario> = STREAM_IDS.flatMap((ids) =>
  CELLS.flatMap((cell) => [
    {
      name: `${ids.name}, ${cell.name}: each value reads its own stream`,
      run: (h: Harness) =>
        seededStreams(h, ids, cell, [SPACE, SPELLED], (world) =>
          Effect.gen(function* () {
            yield* expectStreamIntact(world, ids.of(SPACE))
            yield* expectStreamIntact(world, ids.of(SPELLED))
          }),
        ),
    },
    ...DIRECTIONS.flatMap((direction) =>
      STREAM_OPERATIONS.map(
        (operation): Scenario => ({
          name: `${ids.name}, ${cell.name}, ${direction.name}: ${operation.name}`,
          run: (h) =>
            seededStreams(h, ids, cell, [direction.owner], (world) =>
              Effect.gen(function* () {
                yield* operation.run(world, ids.of(direction.asked))
                yield* expectStreamIntact(world, ids.of(direction.owner))
              }),
            ),
        }),
      ),
    ),
  ]),
)
