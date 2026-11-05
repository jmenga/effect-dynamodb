/**
 * Key halves sharing an attribute (#183): definitions that work and have to keep
 * working. These scenarios run on a recording table and on DynamoDB Local, through
 * a {@link Harness}; only the real one refuses an update to a table key attribute,
 * so the recording one checks the expression instead.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"

export const schema = DynamoSchema.make({ name: "shared-keys", version: 1 })

class Row extends Schema.Class<Row>("Row")({
  tenant: Schema.String,
  id: Schema.String,
  region: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  extra: Schema.optional(Schema.String),
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["tenant"] },
  sk: { field: "sk", composite: ["id"] },
} as const

/** What a scenario needs of a table. */
export interface Harness {
  /** Run `body` with a client over `table`'s member, on a table made from its definition. */
  readonly on: <A, E>(
    table: { readonly MainTable: any; readonly Rows: any },
    body: (db: any) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

const worldOf = (indexes: unknown, options: Record<string, unknown> = {}, on = schema) => {
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey,
    indexes: indexes as never,
    ...options,
  } as never) as any
  return { Rows, MainTable: Table.make({ schema: on, entities: { Rows } }) }
}

export const clientOf = (world: { readonly MainTable: any; readonly Rows: any }) =>
  DynamoClient.make({
    entities: { Rows: world.Rows },
    tables: { MainTable: world.MainTable },
  }) as Effect.Effect<any, never, any>

/** Two accessors on one physical index, over composites no item holds together. */
export const exclusiveAccessorsScenario = (h: Harness) => {
  const world = worldOf({
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
  return h.on(world, (db) =>
    Effect.gen(function* () {
      yield* db.entities.Rows.put({ tenant: "t", id: "1", region: "r" }).asEffect()
      yield* db.entities.Rows.put({ tenant: "t", id: "2", group: "g" }).asEffect()
      const inRegion = yield* db.entities.Rows.byRegion({ tenant: "t", region: "r" }).collect()
      const inGroup = yield* db.entities.Rows.byGroup({ tenant: "t", group: "g" }).collect()
      expect(inRegion.map((row: Row) => row.id)).toEqual(["1"])
      expect(inGroup.map((row: Row) => row.id)).toEqual(["2"])
    }),
  )
}

const VARIANTS = {
  "a sharded index's sort key in the table's": {
    pinned: { id: "1" },
    indexes: {
      byId: {
        name: "gsi",
        pk: { field: "gpk", composite: ["id"] },
        sk: { field: "sk", composite: ["id"] },
        shards: 8,
      },
    },
  },
  "an unsharded index's sort key in the table's": {
    pinned: { id: "1" },
    indexes: {
      byId: {
        name: "gsi",
        pk: { field: "gpk", composite: ["id"] },
        sk: { field: "sk", composite: ["id"] },
      },
    },
  },
  "a local index": {
    pinned: { tenant: "t" },
    indexes: {
      byId: {
        name: "lsi",
        pk: { field: "pk", composite: ["tenant"] },
        sk: { field: "lsk", composite: ["id"] },
      },
    },
  },
  "an inverted index": {
    pinned: { id: "1" },
    indexes: {
      byId: {
        name: "gsi",
        pk: { field: "sk", composite: ["id"] },
        sk: { field: "pk", composite: ["tenant"] },
      },
    },
  },
} as const

const key = { tenant: "t", id: "1" }

const LIFECYCLES: ReadonlyArray<{
  readonly name: string
  readonly options: Record<string, unknown>
  readonly run: (db: any) => Effect.Effect<void, unknown, any>
}> = [
  {
    name: "updates",
    options: {},
    run: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.update(key).set({ note: "n" }).asEffect()
        yield* db.entities.Rows.update(key).remove(["extra"]).asEffect()
        const row = yield* db.entities.Rows.get(key).asEffect()
        expect(row).toMatchObject({ note: "n" })
        expect(row.extra).toBeUndefined()
      }),
  },
  {
    name: "retained versions",
    options: { versioned: { retain: true } },
    run: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.update(key).set({ note: "n" }).asEffect()
        yield* db.entities.Rows.update(key).remove(["extra"]).asEffect()
        expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ note: "n" })
        const first = yield* db.entities.Rows.getVersion(key, 1)
        expect(first).toMatchObject({ extra: "x" })
      }),
  },
  {
    name: "soft delete and restore",
    options: { softDelete: true },
    run: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.delete(key).asEffect()
        const gone = yield* db.entities.Rows.get(key).asEffect().pipe(Effect.result)
        expect(gone._tag).toBe("Failure")
        expect(yield* db.entities.Rows.deleted.get(key)).toMatchObject({ extra: "x" })
        yield* db.entities.Rows.restore(key)
        expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ extra: "x" })
      }),
  },
]

/** A half in a table key attribute: no write may touch it, and nothing strips it. */
export const tableKeyScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = Object.entries(VARIANTS).flatMap(([variant, { pinned, indexes }]) =>
  LIFECYCLES.map((lifecycle) => ({
    name: `${variant}: ${lifecycle.name}`,
    run: (h: Harness) =>
      h.on(worldOf(indexes, lifecycle.options), (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, extra: "x" }).asEffect()
          yield* lifecycle.run(db)
          const found = yield* db.entities.Rows.byId(pinned).collect()
          expect(found.map((row: Row) => row.id)).toEqual(["1"])
          yield* db.entities.Rows.update(key).set({ note: "later" }).asEffect()
          expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ note: "later" })
        }),
      ),
  })),
)

/** Dropping an index entry takes only the half that isn't the table's. */
export const leavingIndexScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  { name: "an ordinary update", options: {} },
  { name: "with retained versions", options: { versioned: { retain: true } } },
].map(({ name, options }) => ({
  name,
  run: (h: Harness) =>
    h.on(
      worldOf(
        {
          byNote: {
            name: "gsi",
            pk: { field: "gpk", composite: ["note"] },
            sk: { field: "sk", composite: ["id"] },
            shards: 8,
          },
        },
        options,
      ),
      (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ ...key, note: "n" }).asEffect()
          const pin = { note: "n" }
          expect((yield* db.entities.Rows.byNote(pin).collect()).length).toBe(1)
          yield* db.entities.Rows.update(key).remove(["note"]).asEffect()
          expect((yield* db.entities.Rows.byNote(pin).collect()).length).toBe(0)
          expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ id: "1" })
        }),
    ),
}))

/**
 * A row an index can't hold, on the retain path: an update has no entry to keep or drop,
 * and must leave the table's key.
 */
export const offIndexScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  {
    name: "a sort key in the table's",
    pin: { note: "n" },
    indexes: {
      byNote: {
        name: "gsi",
        pk: { field: "gpk", composite: ["note"] },
        sk: { field: "sk", composite: ["id"] },
        shards: 8,
      },
    },
  },
  {
    name: "a partition key in the table's",
    pin: { tenant: "t", note: "n" },
    indexes: {
      byNote: {
        name: "lsi",
        pk: { field: "pk", composite: ["tenant"] },
        sk: { field: "lsk", composite: ["note"] },
      },
    },
  },
  {
    name: "a half in the table's, of a composite the row lacks",
    pin: { note: "n" },
    indexes: {
      byNote: {
        name: "gsi",
        pk: { field: "gpk", composite: ["note"] },
        sk: { field: "sk", composite: ["note"] },
      },
    },
  },
].map(({ name, pin, indexes }) => ({
  name,
  run: (h: Harness) =>
    h.on(worldOf(indexes, { versioned: { retain: true } }), (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put(key).asEffect()
        yield* db.entities.Rows.update(key).set({ extra: "x" }).asEffect()
        expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ extra: "x" })
        expect((yield* db.entities.Rows.byNote(pin).collect()).length).toBe(0)
      }),
    ),
}))

/**
 * Removing a composite of a half stored in a table key attribute drops the entry, which
 * takes the other half: the attribute stays, as DynamoDB refuses to remove it and the row
 * can't be found without it.
 */
export const removedCompositeScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = [
  { name: "an update", options: {} },
  { name: "a retained update", options: { versioned: { retain: true } } },
].map(({ name, options }) => ({
  name,
  run: (h: Harness) =>
    h.on(
      worldOf(
        {
          byNote: {
            name: "gsi",
            pk: { field: "gpk", composite: ["note"] },
            sk: { field: "sk", composite: ["note"] },
          },
        },
        options,
      ),
      (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(key).asEffect()
          yield* db.entities.Rows.update(key).set({ extra: "x" }).remove(["note"]).asEffect()
          expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ extra: "x" })
        }),
    ),
}))

/**
 * Canonical shape 12: a mutable half beside one that writes nothing, because it's stored
 * in a table key attribute or the row lacks its composites. An update clearing the
 * mutable composite composes nothing for the index at all, and that silence isn't a drop:
 * `preserve` keeps the entry through it and through any later update, as it does on an
 * index of the row's own attributes. The regression scenario from D53, on the retain path.
 */
const MUTABLE_HALVES: Record<
  string,
  { readonly pin: (note: string) => Record<string, string>; readonly index: unknown }
> = {
  "a sharded index's sort key in the table's": {
    pin: (note) => ({ note }),
    index: {
      name: "gsi",
      pk: { field: "gpk", composite: ["note"] },
      sk: { field: "sk", composite: ["id"] },
      shards: 8,
    },
  },
  "an unsharded index's sort key in the table's": {
    pin: (note) => ({ note }),
    index: {
      name: "gsi",
      pk: { field: "gpk", composite: ["note"] },
      sk: { field: "sk", composite: ["id"] },
    },
  },
  "a local index": {
    pin: (note) => ({ tenant: "t", note }),
    index: {
      name: "lsi",
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "lsk", composite: ["note"] },
    },
  },
  "an inverted index": {
    pin: (note) => ({ id: "1", note }),
    index: {
      name: "gsi",
      pk: { field: "sk", composite: ["id"] },
      sk: { field: "gsk", composite: ["note"] },
    },
  },
  "an index of the row's own attributes": {
    pin: (note) => ({ note }),
    index: {
      name: "gsi",
      pk: { field: "gpk", composite: ["note"] },
      sk: { field: "gsk", composite: ["id"] },
    },
  },
  "a sort key whose composite the row no longer holds": {
    pin: (note) => ({ note }),
    index: {
      name: "gsi",
      pk: { field: "gpk", composite: ["note"] },
      sk: { field: "gsk", composite: ["group"] },
    },
  },
}

const WRITE_PATHS: ReadonlyArray<{
  readonly name: string
  readonly options: Record<string, unknown>
  readonly write: (
    db: any,
    Rows: any,
    updates: Record<string, unknown>,
  ) => Effect.Effect<unknown, unknown, any>
}> = [
  {
    name: "an update",
    options: {},
    write: (db, _Rows, updates) => db.entities.Rows.update(key).set(updates).asEffect(),
  },
  {
    name: "a retained update",
    options: { versioned: { retain: true } },
    write: (db, _Rows, updates) => db.entities.Rows.update(key).set(updates).asEffect(),
  },
  {
    name: "a transaction's update",
    options: {},
    write: (_db, Rows, updates) =>
      Transaction.transactWrite([Rows.update(key).pipe(Entity.set(updates))]),
  },
]

export const keptEntryScenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}> = Object.entries(MUTABLE_HALVES).flatMap(([variant, { pin, index }]) =>
  WRITE_PATHS.map(({ name, options, write }) => ({
    name: `${variant}: ${name}`,
    run: (h: Harness) => {
      const world = worldOf({ byNote: index }, options)
      return h.on(world, (db) =>
        Effect.gen(function* () {
          const found = (note: string) =>
            Effect.map(db.entities.Rows.byNote(pin(note)).collect(), (rows: any) => rows.length)
          const update = (updates: Record<string, unknown>) => write(db, world.Rows, updates)
          yield* db.entities.Rows.put({ ...key, note: "old", group: "g" }).asEffect()

          // A new value moves the entry.
          yield* update({ note: "new" })
          expect(yield* found("old")).toBe(0)
          expect(yield* found("new")).toBe(1)

          // Clearing keeps it, and so does whatever comes after.
          yield* update({ group: undefined })
          expect(yield* found("new")).toBe(1)
          yield* update({ note: undefined })
          expect(yield* found("new")).toBe(1)
          expect((yield* db.entities.Rows.get(key).asEffect()).note).toBeUndefined()
          yield* update({ extra: "x" })
          expect(yield* found("new")).toBe(1)
          expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ extra: "x" })
        }),
      )
    },
  })),
)

/** A casing an index spells out, on a table whose schema agrees: every read finds the row. */
export const agreeingCasingScenario = (h: Harness) => {
  const world = worldOf(
    {
      byId: {
        name: "gsi",
        pk: { field: "gpk", composite: ["id"] },
        sk: { field: "sk", composite: ["id"] },
        shards: 8,
        casing: "uppercase",
      },
    },
    {},
    DynamoSchema.make({ name: "shared-keys", version: 1, casing: "uppercase" }),
  )
  return h.on(world, (db) =>
    Effect.gen(function* () {
      yield* db.entities.Rows.put({ tenant: "t", id: "Alice" }).asEffect()
      yield* db.entities.Rows.update({ tenant: "t", id: "Alice" }).set({ note: "n" }).asEffect()
      expect(yield* db.entities.Rows.get({ tenant: "t", id: "Alice" }).asEffect()).toMatchObject({
        note: "n",
      })
      const found = yield* db.entities.Rows.byId({ id: "Alice" }).collect()
      expect(found.map((row: Row) => row.id)).toEqual(["Alice"])
    }),
  )
}
