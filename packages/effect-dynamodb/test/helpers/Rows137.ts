/**
 * Rows 1.37.0 wrote (#183): it escaped sort keys and no partition key, so a partition key holding
 * a character to escape is at neither its 1.36 text nor its current one. The stored keys here are
 * the ones the published 1.37.0 package wrote for these values. Only `rekey` looks for them: it
 * moves them, and until then a read doesn't find them. These scenarios run on a recording table
 * and on DynamoDB Local, through a {@link Harness}.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import { toAttributeMap } from "../../src/Marshaller.js"
import * as Table from "../../src/Table.js"

type StoredRow = Record<string, any>

/** What a harness needs of a scenario's definitions. */
export interface HarnessWorld {
  readonly MainTable: any
  readonly client: () => Effect.Effect<any, never, any>
}

export interface Harness {
  /** Run `body` with `world`'s client, on a table made from its definition. */
  readonly on: <A, E>(
    world: HarnessWorld,
    body: (db: any, table: StoredRows) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

export interface StoredRows {
  readonly seed: (row: StoredRow) => Effect.Effect<void, unknown, any>
  readonly remove: (row: StoredRow) => Effect.Effect<void, unknown, any>
  readonly rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown, any>
  /** Run `body` with a client over another world's members, on this table. */
  readonly as: <A, E>(
    world: HarnessWorld,
    body: (db: any) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown, any>
}

const Thing = Schema.Struct({
  tenant: Schema.String,
  n: Schema.Number,
  label: Schema.String,
  s: Schema.Number,
  region: Schema.optional(Schema.String),
  m: Schema.optional(Schema.Number),
  zone: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
})

const User = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  m: Schema.Number,
})

const Edge = Schema.Struct({
  userId: Schema.String,
  groupId: Schema.String,
})

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}

const Stop = Schema.Struct({ label: Schema.String, note: Schema.String })
const Route = Schema.Struct({ id: Schema.String, area: Schema.String, stops: Schema.Array(Stop) })

const thingKey = {
  pk: { field: "pk", composite: ["tenant", "n"] },
  sk: { field: "sk", composite: ["label", "s"] },
} as const

/** Everything the scenarios use, with a schema of their choosing. */
export const worldOf = (
  schemaOptions: { readonly legacyKeys?: boolean; readonly escapeKeys?: boolean } = {},
  options: Record<string, unknown> = {},
) => {
  const schema = DynamoSchema.make({ name: "mixed", version: 1, ...schemaOptions })
  const Things = Entity.make({
    model: Thing,
    entityType: "Thing",
    primaryKey: thingKey,
    indexes: {
      byRegion: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["region", "m"] },
        sk: { field: "gsi1sk", composite: ["zone"] },
      },
    },
    ...options,
  } as never) as any
  const Users = Entity.make({
    model: User,
    entityType: "User",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    unique: { contact: ["email", "m"] },
  }) as any
  const Edges = Entity.make({
    model: Edge,
    entityType: "Edge",
    primaryKey: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: ["groupId"] },
    },
    indexes: {
      byGroup: {
        name: "gsi2",
        pk: { field: "sk", composite: ["groupId"] },
        sk: { field: "pk", composite: ["userId"] },
      },
    },
  }) as any
  const MainTable = Table.make({ schema, entities: { Things, Users, Edges } }) as any
  const Accounts = EventStore.makeStream({
    table: MainTable,
    streamName: "Accounts",
    events: [Deposited],
    streamId: { composite: ["tenant", "n"] },
  } as never) as any
  const Routes = Aggregate.make(
    Route as never,
    {
      table: MainTable,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { index: "lsi1", name: "routes", sk: { field: "lsi1sk", composite: ["area"] } },
      root: { entityType: "RouteItem" },
      edges: { stops: Aggregate.many({ entityType: "RouteStop", sk: { composite: ["label"] } }) },
    } as never,
  ) as any
  const client = () =>
    DynamoClient.make({
      entities: { Things, Users, Edges },
      aggregates: { Routes },
      tables: { MainTable },
    } as never) as unknown as Effect.Effect<any, never, any>
  return { schema, Things, Users, Edges, MainTable, Accounts, Routes, client }
}
export type World = ReturnType<typeof worldOf>

type Scenario = {
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}

const stored = (values: Record<string, unknown>, keys: Record<string, string>, type: string) =>
  toAttributeMap({ ...values, ...keys, __edd_e__: type }) as StoredRow

const rekeyOf = (db: any, world: World) =>
  db.tables.MainTable.rekey({
    streams: [world.Accounts],
  }) as Effect.Effect<Table.RekeyReport, unknown, any>

const notFound = (db: any, key: object) =>
  db.entities.Things.get(key)
    .asEffect()
    .pipe(
      Effect.flip,
      Effect.map((error: any) => error._tag),
    )

const THINGS: ReadonlyArray<
  readonly [string, Record<string, unknown>, { readonly pk: string; readonly sk: string }]
> = [
  [
    "a string to escape and a changed number in the partition key",
    { tenant: "a b", n: -3, label: "plain", s: 1 },
    {
      pk: "$mixed#v1#thing#tenant_a b#n_-9999999999999996:",
      sk: "$mixed#v1#thing#label_plain#s_0000000000000001",
    },
  ],
  [
    "a string to escape in each half",
    { tenant: "a b", n: 5, label: "x y", s: 1 },
    {
      pk: "$mixed#v1#thing#tenant_a b#n_0000000000000005",
      sk: "$mixed#v1#thing#label_x%20y#s_0000000000000001",
    },
  ],
  [
    "a string to escape in the partition key, a changed number in the sort key",
    { tenant: "a b", n: 5, label: "plain", s: -3 },
    {
      pk: "$mixed#v1#thing#tenant_a b#n_0000000000000005",
      sk: "$mixed#v1#thing#label_plain#s_-9999999999999996:",
    },
  ],
]

/** A row of each mix: unfound until `rekey`, which moves it, and found with the fallback off. */
export const itemScenarios: ReadonlyArray<Scenario> = THINGS.map(([name, values, keys]) => ({
  name,
  run: (h) => {
    const world = worldOf()
    const key = { tenant: values.tenant, n: values.n, label: values.label, s: values.s }
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(stored(values, keys, "Thing"))
        expect(yield* notFound(db, key)).toBe("ItemNotFound")

        const dry = yield* db.tables.MainTable.rekey({ dryRun: true })
        expect(dry.moved.item).toBe(1)
        expect((yield* table.rows())[0]!.pk.S).toBe(keys.pk)

        const report = yield* rekeyOf(db, world)
        expect(report.moved.item).toBe(1)
        expect(report.conflicts).toEqual([])
        const rows = yield* table.rows()
        expect(rows).toHaveLength(1)
        expect(rows[0]!.pk.S).toContain("tenant_")
        expect(rows[0]!.pk.S).not.toBe(keys.pk)
        expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject(key)
        yield* table.as(worldOf({ legacyKeys: false }), (off) =>
          off.entities.Things.get(key).asEffect(),
        )

        const again = yield* rekeyOf(db, world)
        expect(again.moved.item).toBe(0)
        expect(again.unchanged).toBe(1)
      }),
    )
  },
}))

/** An index's partition key in 1.37's text, on a row at its current key. */
export const indexKeyScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a string to escape and a changed number in an index partition key",
    run: (h) => {
      const world = worldOf()
      const values = { tenant: "t", n: 1, label: "f", s: 1, region: "r 1", m: -3, zone: "z" }
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* table.seed(
            stored(
              values,
              {
                pk: "$mixed#v1#thing#tenant_t#n_0000000000000001",
                sk: "$mixed#v1#thing#label_f#s_0000000000000001",
                gsi1pk: "$mixed#v1#thing#region_r 1#m_-9999999999999996:",
                gsi1sk: "$mixed#v1#thing#zone_z",
              },
              "Thing",
            ),
          )
          const pin = { region: "r 1", m: -3 }
          expect(yield* db.entities.Things.byRegion(pin).collect()).toHaveLength(0)
          const report = yield* rekeyOf(db, world)
          expect(report.indexKeysRewritten).toBe(1)
          expect(report.moved.item).toBe(0)
          expect((yield* table.rows())[0]!.gsi1pk.S).toBe(
            "$mixed#v1#thing#region_r%201#m_-9999999999999996:",
          )
          expect(yield* db.entities.Things.byRegion(pin).collect()).toHaveLength(1)
        }),
      )
    },
  },
  {
    name: "a string to escape in each half of an index key",
    run: (h) => {
      const world = worldOf()
      const values = { tenant: "t", n: 2, label: "g", s: 1, region: "r 2", m: 5, zone: "z 1" }
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* table.seed(
            stored(
              values,
              {
                pk: "$mixed#v1#thing#tenant_t#n_0000000000000002",
                sk: "$mixed#v1#thing#label_g#s_0000000000000001",
                gsi1pk: "$mixed#v1#thing#region_r 2#m_0000000000000005",
                gsi1sk: "$mixed#v1#thing#zone_z%201",
              },
              "Thing",
            ),
          )
          const pin = { region: "r 2", m: 5, zone: "z 1" }
          // The 1.36 pass reads the partition, in a sort key text this row doesn't have.
          expect(yield* db.entities.Things.byRegion(pin).collect()).toHaveLength(0)
          const report = yield* rekeyOf(db, world)
          expect(report.indexKeysRewritten).toBe(1)
          expect(yield* db.entities.Things.byRegion(pin).collect()).toHaveLength(1)
        }),
      )
    },
  },
]

/** The partition key of a row written just now, as 1.37 would have stored it. */
const demote = (world: World, table: StoredRows, tenantPk: string, pk137: string) =>
  Effect.gen(function* () {
    for (const row of yield* table.rows()) {
      if (row.pk.S !== tenantPk) continue
      yield* table.remove(row)
      yield* table.seed({ ...row, pk: { S: pk137 } })
    }
    return world
  })

/** History rows of every kind: each moves from 1.37's key with its item. */
export const historyScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a version snapshot",
    run: (h) => {
      const world = worldOf({}, { versioned: { retain: true } })
      const key = { tenant: "a b", n: 5, label: "x y", s: 1 }
      const primary = world.Things.indexes.primary
      const now = KeyComposer.composePk(world.schema, "Thing", primary, key)
      const old = KeyComposer.composePk(KeyText136.schema137(world.schema), "Thing", primary, key)
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Things.put({ ...key, note: "first" }).asEffect()
          yield* db.entities.Things.update(key).set({ note: "second" }).asEffect()
          const before = (yield* table.rows()).length
          expect(before).toBeGreaterThan(1)
          yield* demote(world, table, now, old)
          expect(yield* notFound(db, key)).toBe("ItemNotFound")
          const report = yield* rekeyOf(db, world)
          expect(report.moved.item).toBe(1)
          expect(report.moved.snapshot).toBe(before - 1)
          expect(report.conflicts).toEqual([])
          expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject({ note: "second" })
          expect(yield* db.entities.Things.getVersion(key, 1)).toMatchObject({ note: "first" })
          expect((yield* table.rows()).every((row) => row.pk.S === now)).toBe(true)
        }),
      )
    },
  },
  {
    name: "a tombstone",
    run: (h) => {
      const world = worldOf({}, { softDelete: true })
      const key = { tenant: "a b", n: 5, label: "x y", s: 1 }
      const primary = world.Things.indexes.primary
      const now = KeyComposer.composePk(world.schema, "Thing", primary, key)
      const old = KeyComposer.composePk(KeyText136.schema137(world.schema), "Thing", primary, key)
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Things.put({ ...key, note: "kept" }).asEffect()
          yield* db.entities.Things.delete(key).asEffect()
          yield* demote(world, table, now, old)
          const report = yield* rekeyOf(db, world)
          expect(report.moved.tombstone).toBe(1)
          expect(report.conflicts).toEqual([])
          expect(yield* db.entities.Things.deleted.get(key)).toMatchObject({ note: "kept" })
          yield* db.entities.Things.restore(key)
          expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject({ note: "kept" })
        }),
      )
    },
  },
  {
    name: "a time-series event",
    run: (h) => {
      const world = worldOf(
        {},
        {
          timeSeries: {
            orderBy: "m",
            appendInput: Schema.Struct({
              tenant: Schema.String,
              n: Schema.Number,
              label: Schema.String,
              s: Schema.Number,
              m: Schema.Number,
            }),
          },
        },
      )
      const key = { tenant: "a b", n: 5, label: "x y", s: 1 }
      const primary = world.Things.indexes.primary
      const now = KeyComposer.composePk(world.schema, "Thing", primary, key)
      const old = KeyComposer.composePk(KeyText136.schema137(world.schema), "Thing", primary, key)
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Things.append({ ...key, m: 1 })
          yield* db.entities.Things.append({ ...key, m: 2 })
          yield* demote(world, table, now, old)
          const report = yield* rekeyOf(db, world)
          expect(report.moved.item).toBe(1)
          expect(report.moved.event).toBe(2)
          expect(report.conflicts).toEqual([])
          expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject({ m: 2 })
          expect(yield* db.entities.Things.history(key).collect()).toHaveLength(2)
        }),
      )
    },
  },
]

/** A unique sentinel of an item at 1.37's key: its text unchanged since 1.36, naming that key. */
export const sentinelScenario = (h: Harness) => {
  const world = worldOf()
  const values = { id: "u 1", email: "e f", m: 5 }
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      const pk137 = "$mixed#v1#user#id_u 1"
      yield* table.seed(stored(values, { pk: pk137, sk: "$mixed#v1#user" }, "User"))
      yield* table.seed(
        stored(
          {},
          {
            pk: "$mixed#v1#user.contact#e f#0000000000000005",
            sk: "$mixed#v1#user.contact",
            _entity_pk: pk137,
            _entity_sk: "$mixed#v1#user",
          },
          "User._unique.contact",
        ),
      )
      const report = yield* rekeyOf(db, world)
      expect(report.moved.item).toBe(1)
      expect(report.sentinelsMoved).toBe(1)
      expect(report.conflicts).toEqual([])
      const taken = yield* db.entities.Users.create({ id: "other", email: "e f", m: 5 })
        .asEffect()
        .pipe(Effect.flip)
      expect(taken._tag).toBe("UniqueConstraintViolation")
    }),
  )
}

/** A stream id mixing a string to escape with a changed number. */
export const streamScenario = (h: Harness) => {
  const world = worldOf()
  const id = { tenant: "a b", n: -3 } as never
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      yield* world.Accounts.append(id, [new Deposited({ amount: 1 })], 0)
      const now = (yield* table.rows()).map((row) => row.pk.S)
      expect(now).toEqual(["$mixed#v1#accounts#a%20b#-9999999999999996:"])
      yield* demote(world, table, now[0]!, "$mixed#v1#accounts#a b#-9999999999999996:")
      expect(yield* world.Accounts.read(id)).toHaveLength(0)

      const report = yield* rekeyOf(db, world)
      expect(report.moved.stream).toBe(1)
      expect(report.conflicts).toEqual([])
      expect(yield* world.Accounts.read(id)).toHaveLength(1)
      expect((yield* rekeyOf(db, world)).moved.stream).toBe(0)
    }),
  )
}

/**
 * An aggregate under a partition in 1.37's text, which is also 1.36's, with an edge row whose
 * sort key escapes: reading finds them all, and `rekey` moves them all.
 */
export const aggregateScenario = (h: Harness) => {
  const world = worldOf()
  const value = {
    id: "r 1",
    area: "north east",
    stops: [
      { label: "a b", note: "n" },
      { label: "plain", note: "n" },
    ],
  }
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      yield* db.aggregates.Routes.create(value)
      const now = "$mixed#v1#routes#r%201"
      yield* demote(world, table, now, "$mixed#v1#routes#r 1")
      expect((yield* table.rows()).map((row) => row.sk.S).sort()).toEqual([
        "$mixed#v1#routeitem",
        "$mixed#v1#routestop#a%20b",
        "$mixed#v1#routestop#plain",
      ])
      const found = yield* db.aggregates.Routes.get({ id: "r 1" })
      expect(found.stops).toHaveLength(2)

      const report = yield* rekeyOf(db, world)
      expect(report.moved.aggregate).toBe(3)
      expect(report.conflicts).toEqual([])
      const rows = yield* table.rows()
      expect(rows.every((row) => row.pk.S === now)).toBe(true)
      expect(rows).toHaveLength(3)
      yield* table.as(worldOf({ legacyKeys: false }), (off) =>
        Effect.gen(function* () {
          const moved = yield* off.aggregates.Routes.get({ id: "r 1" })
          expect(moved.stops).toHaveLength(2)
        }),
      )
    }),
  )
}

/**
 * `escapeKeys: false` covers strings: a number 1.36 wrote under its old text still reads through
 * the fallback, and `rekey` moves it to 1.37's encoding, leaving a raw string raw.
 */
export const numberUnderOffScenario = (h: Harness) => {
  const world = worldOf({ escapeKeys: false })
  const values = { tenant: "a b", n: -3, label: "x y", s: 1 }
  const old = {
    pk: `$mixed#v1#thing#tenant_a b#n_${KeyText136.serializeValue(-3)}`,
    sk: "$mixed#v1#thing#label_x y#s_0000000000000001",
  }
  const now = {
    pk: `$mixed#v1#thing#tenant_a b#n_${KeyComposer.serializeValue(-3)}`,
    sk: old.sk,
  }
  expect(now.pk).not.toBe(old.pk)
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      yield* table.seed(stored(values, old, "Thing"))
      const key = { tenant: "a b", n: -3, label: "x y", s: 1 }
      expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject({ tenant: "a b" })
      const report = yield* rekeyOf(db, world)
      expect(report.moved.item).toBe(1)
      const row = (yield* table.rows()).find((candidate) => candidate.tenant?.S === "a b")!
      expect({ pk: row.pk.S, sk: row.sk.S }).toEqual(now)
      expect(yield* notFound(db, { ...key, tenant: "other" })).toBe("ItemNotFound")
      expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject({ tenant: "a b" })
    }),
  )
}

/**
 * An aggregate at its current keys, in a partition whose text didn't change, where one edge's
 * current sort key is another's 1.36 one: nothing to move, and nothing to report.
 */
export const aggregateAliasScenario = (h: Harness) => {
  const world = worldOf()
  return h.on(world, (db) =>
    Effect.gen(function* () {
      yield* db.aggregates.Routes.create({
        id: "plain",
        area: "n",
        stops: [
          { label: "a b", note: "1" },
          { label: "a%20b", note: "2" },
        ],
      })
      const report = yield* rekeyOf(db, world)
      expect(report.moved.aggregate).toBe(0)
      expect(report.conflicts).toEqual([])
      const route = yield* db.aggregates.Routes.get({ id: "plain" })
      expect(route.stops.map((stop: any) => stop.note).sort()).toEqual(["1", "2"])
    }),
  )
}

/**
 * Limits of the upgrade from 1.37, pinned so the docs stay true. A `put` before `rekey` writes
 * beside the row, which `rekey` reports. A unique constraint mixing a string to escape with a
 * changed number isn't recognized, and an inverted row with a string to escape in each half
 * isn't either: `rekey` counts that one as unrecognized, and it stays.
 */
export const limitScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a stream under a 1.36 key another id escapes to is read under that id until rekey",
    run: (h) => {
      const world = worldOf()
      const spelled = { tenant: "foo%20bar", n: 5 } as never
      const value = { tenant: "foo bar", n: 5 } as never
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* world.Accounts.append(spelled, [new Deposited({ amount: 1 })], 0)
          yield* demote(
            world,
            table,
            "$mixed#v1#accounts#foo%2520bar#0000000000000005",
            "$mixed#v1#accounts#foo%20bar#0000000000000005",
          )
          expect(yield* world.Accounts.read(value)).toHaveLength(1)
          expect((yield* rekeyOf(db, world)).moved.stream).toBe(1)
          expect(yield* world.Accounts.read(value)).toHaveLength(0)
          expect(yield* world.Accounts.read(spelled)).toHaveLength(1)
        }),
      )
    },
  },
  {
    name: "an aggregate under a 1.36 key another id escapes to is read under that id until rekey",
    run: (h) => {
      const world = worldOf()
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* db.aggregates.Routes.create({ id: "foo%20bar", area: "n", stops: [] })
          yield* demote(world, table, "$mixed#v1#routes#foo%2520bar", "$mixed#v1#routes#foo%20bar")
          const seen = yield* db.aggregates.Routes.get({ id: "foo bar" })
          expect(seen.id).toBe("foo%20bar")
          expect((yield* rekeyOf(db, world)).moved.aggregate).toBe(1)
          const gone = yield* db.aggregates.Routes.get({ id: "foo bar" }).pipe(Effect.flip)
          expect(gone._tag).toBeDefined()
          expect((yield* db.aggregates.Routes.get({ id: "foo%20bar" })).id).toBe("foo%20bar")
        }),
      )
    },
  },
  {
    name: "a put before rekey writes beside the row, and rekey reports both",
    run: (h) => {
      const world = worldOf()
      const [, values, keys] = THINGS[1]!
      const key = { tenant: values.tenant, n: values.n, label: values.label, s: values.s }
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* table.seed(stored(values, keys, "Thing"))
          yield* db.entities.Things.put(values).asEffect()
          expect(yield* table.rows()).toHaveLength(2)
          const report = yield* rekeyOf(db, world)
          expect(report.conflicts.map((conflict: any) => conflict.reason)).toEqual(["bothKeys"])
          expect(yield* table.rows()).toHaveLength(2)
          expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject(key)
        }),
      )
    },
  },
  {
    name: "a sentinel of a string to escape and a changed number isn't recognized: rewrite the item",
    run: (h) => {
      const world = worldOf()
      const values = { id: "u1", email: "e f", m: -3 }
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          const owner = { pk: "$mixed#v1#user#id_u1", sk: "$mixed#v1#user" }
          yield* table.seed(stored(values, owner, "User"))
          yield* table.seed(
            stored(
              {},
              {
                pk: "$mixed#v1#user.contact#e f#-9999999999999996:",
                sk: "$mixed#v1#user.contact",
                _entity_pk: owner.pk,
                _entity_sk: owner.sk,
              },
              "User._unique.contact",
            ),
          )
          yield* rekeyOf(db, world)
          // Nothing holds the value at the text a write looks at.
          yield* db.entities.Users.put({ id: "other", email: "e f", m: -3 }).asEffect()
          yield* db.entities.Users.delete({ id: "other" }).asEffect()
          // A put alone keeps the sentinel it thinks the item has: delete it, then put it.
          yield* db.entities.Users.delete({ id: "u1" }).asEffect()
          yield* db.entities.Users.put(values).asEffect()
          const taken = yield* db.entities.Users.create({ id: "other", email: "e f", m: -3 })
            .asEffect()
            .pipe(Effect.flip)
          expect(taken._tag).toBe("UniqueConstraintViolation")
        }),
      )
    },
  },
  {
    name: "an inverted row with a string to escape in each half isn't recognized",
    run: (h) => {
      const world = worldOf()
      const values = { userId: "u 3", groupId: "c d" }
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* table.seed(
            stored(
              values,
              { pk: "$mixed#v1#edge#userid_u%203", sk: "$mixed#v1#edge#groupid_c d" },
              "Edge",
            ),
          )
          const missing = yield* db.entities.Edges.get(values).asEffect().pipe(Effect.flip)
          expect(missing._tag).toBe("ItemNotFound")
          const report = yield* rekeyOf(db, world)
          expect(report.moved.item).toBe(0)
          expect(report.skipped.unrecognizedKey).toBe(1)
          expect(yield* table.rows()).toHaveLength(1)
          // What the upgrading guide says to do: find it by a scan, write it, delete the old row.
          const [row] = yield* db.entities.Edges.scan().collect()
          yield* db.entities.Edges.put(row).asEffect()
          yield* table.remove(
            stored(
              values,
              { pk: "$mixed#v1#edge#userid_u%203", sk: "$mixed#v1#edge#groupid_c d" },
              "Edge",
            ),
          )
          expect(yield* db.entities.Edges.get(values).asEffect()).toMatchObject(values)
          expect(yield* table.rows()).toHaveLength(1)
        }),
      )
    },
  },
]
