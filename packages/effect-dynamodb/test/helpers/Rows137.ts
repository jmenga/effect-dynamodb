/**
 * Rows 1.37.0 wrote (#183): it escaped sort keys and no partition key, so a partition key holding
 * a character to escape is at neither its 1.36 text nor its text with `escapeKeys: true`, and with
 * the flag off a sort key holding one is at no text at all. The stored keys here are the ones the
 * published 1.37.0 package wrote for these values. Only `rekey` looks for them: it moves them to
 * what the setting composes, either way, and until then a read doesn't find them. These scenarios
 * run under both settings, on a recording table and on DynamoDB Local, through a {@link Harness}.
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
const Trip = Schema.Struct({
  tenant: Schema.String,
  n: Schema.Number,
  stops: Schema.Array(Stop),
})

const thingKey = {
  pk: { field: "pk", composite: ["tenant", "n"] },
  sk: { field: "sk", composite: ["label", "s"] },
} as const

/** Everything the scenarios use, with a schema of their choosing. */
export const worldOf = (escapeKeys: boolean, options: Record<string, unknown> = {}) => {
  const schema = DynamoSchema.make({ name: "mixed", version: 1, escapeKeys })
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
  const Trips = Aggregate.make(
    Trip as never,
    {
      table: MainTable,
      schema,
      pk: { field: "pk", composite: ["tenant", "n"] },
      collection: { index: "lsi1", name: "trips", sk: { field: "lsi1sk", composite: [] } },
      root: { entityType: "TripItem" },
      edges: { stops: Aggregate.many({ entityType: "TripStop", sk: { composite: ["label"] } }) },
    } as never,
  ) as any
  const client = () =>
    DynamoClient.make({
      entities: { Things, Users, Edges },
      aggregates: { Routes, Trips },
      tables: { MainTable },
    } as never) as unknown as Effect.Effect<any, never, any>
  return { schema, Things, Users, Edges, MainTable, Accounts, Routes, Trips, client }
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

/** Each scenario under both settings: `rekey` moves a row to what the setting composes. */
const bothSettings = (
  name: string,
  run: (escapeKeys: boolean, h: Harness) => Effect.Effect<void, unknown>,
): ReadonlyArray<Scenario> => [
  { name: `${name}, on`, run: (h) => run(true, h) },
  { name: `${name}, off`, run: (h) => run(false, h) },
]

/** A row of each mix: unfound until `rekey`, which moves it. */
export const itemScenarios: ReadonlyArray<Scenario> = THINGS.flatMap(([name, values, keys]) =>
  bothSettings(name, (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const key = { tenant: values.tenant, n: values.n, label: values.label, s: values.s }
    const primary = world.Things.indexes.primary
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
        expect(rows[0]!.pk.S).toBe(KeyComposer.composePk(world.schema, "Thing", primary, key))
        expect(rows[0]!.sk.S).toBe(KeyComposer.composeSk(world.schema, "Thing", 1, primary, key))
        expect({ pk: rows[0]!.pk.S, sk: rows[0]!.sk.S }).not.toEqual(keys)
        expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject(key)

        const again = yield* rekeyOf(db, world)
        expect(again.moved.item).toBe(0)
        expect(again.unchanged).toBe(1)
      }),
    )
  }),
)

/** An index key in 1.37's text, on a row whose table key didn't change. */
export const indexKeyScenarios: ReadonlyArray<Scenario> = [
  ...bothSettings(
    "a string to escape and a changed number in an index partition key",
    (escapeKeys, h) => {
      const world = worldOf(escapeKeys)
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
            escapeKeys
              ? "$mixed#v1#thing#region_r%201#m_-9999999999999996:"
              : "$mixed#v1#thing#region_r 1#m_00000000000000-3",
          )
          expect(yield* db.entities.Things.byRegion(pin).collect()).toHaveLength(1)
          expect((yield* rekeyOf(db, world)).indexKeysRewritten).toBe(0)
        }),
      )
    },
  ),
  ...bothSettings("a string to escape in each half of an index key", (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
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
        expect(yield* db.entities.Things.byRegion(pin).collect()).toHaveLength(0)
        const report = yield* rekeyOf(db, world)
        expect(report.indexKeysRewritten).toBe(1)
        expect(yield* db.entities.Things.byRegion(pin).collect()).toHaveLength(1)
        expect((yield* rekeyOf(db, world)).indexKeysRewritten).toBe(0)
      }),
    )
  }),
]

/** A partition's rows written with the flag on, as 1.37 would have stored them. */
const demote = (table: StoredRows, pkNow: string, pk137: string) =>
  Effect.gen(function* () {
    for (const row of yield* table.rows()) {
      if (row.pk.S !== pkNow) continue
      yield* table.remove(row)
      yield* table.seed({ ...row, pk: { S: pk137 } })
    }
  })

const historyKey = { tenant: "a b", n: 5, label: "x y", s: 1 }

/** Rows in 1.37's text, from `write` under the flag on, then the partition key's text changed. */
const seeded137 = (
  options: Record<string, unknown>,
  table: StoredRows,
  write: (db: any) => Effect.Effect<unknown, unknown, any>,
) => {
  const writer = worldOf(true, options)
  const primary = writer.Things.indexes.primary
  return Effect.gen(function* () {
    yield* table.as(writer, write)
    yield* demote(
      table,
      KeyComposer.composePk(writer.schema, "Thing", primary, historyKey),
      KeyComposer.composePk(KeyText136.schema137(writer.schema), "Thing", primary, historyKey),
    )
  })
}

/** Every row of the partition is at what `world` composes for the key. */
const expectHistoryAt = (world: World, rows: ReadonlyArray<StoredRow>) => {
  const primary = world.Things.indexes.primary
  const pk = KeyComposer.composePk(world.schema, "Thing", primary, historyKey)
  const text = world.schema.escapeKeys === true ? "label_x%20y" : "label_x y"
  for (const row of rows) {
    expect(row.pk.S).toBe(pk)
    expect(row.sk.S).toContain(text)
  }
}

/** History rows of every kind: each moves from 1.37's key with its item. */
export const historyScenarios: ReadonlyArray<Scenario> = [
  ...bothSettings("a version snapshot", (escapeKeys, h) => {
    const options = { versioned: { retain: true } }
    const world = worldOf(escapeKeys, options)
    const key = historyKey
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* seeded137(options, table, (writer) =>
          Effect.gen(function* () {
            yield* writer.entities.Things.put({ ...key, note: "first" }).asEffect()
            yield* writer.entities.Things.update(key).set({ note: "second" }).asEffect()
          }),
        )
        const before = (yield* table.rows()).length
        expect(before).toBeGreaterThan(1)
        expect(yield* notFound(db, key)).toBe("ItemNotFound")
        const report = yield* rekeyOf(db, world)
        expect(report.moved.item).toBe(1)
        expect(report.moved.snapshot).toBe(before - 1)
        expect(report.conflicts).toEqual([])
        expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject({ note: "second" })
        expect(yield* db.entities.Things.getVersion(key, 1)).toMatchObject({ note: "first" })
        expectHistoryAt(world, yield* table.rows())
        const again = yield* rekeyOf(db, world)
        expect(again.moved.item + again.moved.snapshot).toBe(0)
      }),
    )
  }),
  ...bothSettings("a tombstone", (escapeKeys, h) => {
    const options = { softDelete: true }
    const world = worldOf(escapeKeys, options)
    const key = historyKey
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* seeded137(options, table, (writer) =>
          Effect.gen(function* () {
            yield* writer.entities.Things.put({ ...key, note: "kept" }).asEffect()
            yield* writer.entities.Things.delete(key).asEffect()
          }),
        )
        const report = yield* rekeyOf(db, world)
        expect(report.moved.tombstone).toBe(1)
        expect(report.conflicts).toEqual([])
        expectHistoryAt(world, yield* table.rows())
        expect(yield* db.entities.Things.deleted.get(key)).toMatchObject({ note: "kept" })
        expect((yield* rekeyOf(db, world)).moved.tombstone).toBe(0)
        yield* db.entities.Things.restore(key)
        expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject({ note: "kept" })
      }),
    )
  }),
  ...bothSettings("a time-series event", (escapeKeys, h) => {
    const options = {
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
    }
    const world = worldOf(escapeKeys, options)
    const key = historyKey
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* seeded137(options, table, (writer) =>
          Effect.gen(function* () {
            yield* writer.entities.Things.append({ ...key, m: -1 })
            yield* writer.entities.Things.append({ ...key, m: 2 })
          }),
        )
        const report = yield* rekeyOf(db, world)
        expect(report.moved.item).toBe(1)
        expect(report.moved.event).toBe(2)
        expect(report.conflicts).toEqual([])
        expectHistoryAt(world, yield* table.rows())
        expect(yield* db.entities.Things.get(key).asEffect()).toMatchObject({ m: 2 })
        expect(yield* db.entities.Things.history(key).collect()).toHaveLength(2)
        expect((yield* rekeyOf(db, world)).moved.event).toBe(0)
      }),
    )
  }),
]

/** Its value is taken, whichever way it is written next: the sentinel was found and kept. */
const expectTaken = (db: any, values: object) =>
  Effect.gen(function* () {
    const taken = yield* db.entities.Users.create({ ...values, id: "other" })
      .asEffect()
      .pipe(Effect.flip)
    expect(taken._tag).toBe("UniqueConstraintViolation")
  })

/** A unique sentinel of an item at 1.37's key: its text unchanged since 1.36, naming that key. */
export const sentinelScenarios: ReadonlyArray<Scenario> = [
  ...bothSettings("naming the item's key", (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
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
        expect(report.moved.item).toBe(escapeKeys ? 1 : 0)
        expect(report.sentinelsMoved).toBe(escapeKeys ? 1 : 0)
        expect(report.conflicts).toEqual([])
        yield* expectTaken(db, { email: "e f", m: 5 })
        const again = yield* rekeyOf(db, world)
        expect(again.moved.item + again.sentinelsMoved).toBe(0)
      }),
    )
  }),
  // A string to escape and a changed number: at 1.37's text, which neither setting composes.
  ...bothSettings("mixing a string to escape and a changed number", (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const values = { id: "u1", email: "e f", m: -3 }
    const owner = { pk: "$mixed#v1#user#id_u1", sk: "$mixed#v1#user" }
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
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
        const dry = yield* db.tables.MainTable.rekey({ dryRun: true })
        expect(dry.sentinelsMoved).toBe(1)
        const report = yield* rekeyOf(db, world)
        expect(report.sentinelsMoved).toBe(1)
        expect(report.moved.item).toBe(0)
        expect(report.conflicts).toEqual([])
        expect(report.skipped.unrecognizedKey).toBe(0)
        const pks = (yield* table.rows()).map((row) => row.pk.S)
        expect(pks).toContain(
          escapeKeys
            ? "$mixed#v1#user.contact#e%20f#-9999999999999996:"
            : "$mixed#v1#user.contact#e f#00000000000000-3",
        )
        yield* expectTaken(db, { email: "e f", m: -3 })
        expect((yield* rekeyOf(db, world)).sentinelsMoved).toBe(0)
        // Its item deletes the sentinel it now composes.
        yield* db.entities.Users.delete({ id: "u1" }).asEffect()
        expect(yield* table.rows()).toHaveLength(0)
      }),
    )
  }),
]

/** A stream id mixing a string to escape with a changed number. */
export const streamScenarios: ReadonlyArray<Scenario> = bothSettings(
  "a stream",
  (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const writer = worldOf(true)
    const id = { tenant: "a b", n: -3 } as never
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.as(writer, () =>
          writer.Accounts.append(id, [new Deposited({ amount: 1 })], 0),
        )
        const now = (yield* table.rows()).map((row) => row.pk.S)
        expect(now).toEqual(["$mixed#v1#accounts#a%20b#-9999999999999996:"])
        yield* demote(table, now[0]!, "$mixed#v1#accounts#a b#-9999999999999996:")
        expect(yield* world.Accounts.read(id)).toHaveLength(0)

        const report = yield* rekeyOf(db, world)
        expect(report.moved.stream).toBe(1)
        expect(report.conflicts).toEqual([])
        expect((yield* table.rows()).map((row) => row.pk.S)).toEqual([
          escapeKeys
            ? "$mixed#v1#accounts#a%20b#-9999999999999996:"
            : "$mixed#v1#accounts#a b#00000000000000-3",
        ])
        expect(yield* world.Accounts.read(id)).toHaveLength(1)
        expect((yield* rekeyOf(db, world)).moved.stream).toBe(0)
      }),
    )
  },
)

/**
 * An aggregate under a partition in 1.37's text, which is also 1.36's, with an edge row whose
 * sort key escapes: reading finds none of it, and `rekey` moves it all.
 */
export const aggregateScenarios: ReadonlyArray<Scenario> = [
  ...bothSettings("under its 1.37 partition", (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const writer = worldOf(true)
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
        yield* table.as(writer, (w) => w.aggregates.Routes.create(value))
        yield* demote(table, "$mixed#v1#routes#r%201", "$mixed#v1#routes#r 1")
        expect((yield* table.rows()).map((row) => row.sk.S).sort()).toEqual([
          "$mixed#v1#routeitem",
          "$mixed#v1#routestop#a%20b",
          "$mixed#v1#routestop#plain",
        ])

        const dry = yield* db.tables.MainTable.rekey({ dryRun: true })
        const report = yield* rekeyOf(db, world)
        expect(report.moved.aggregate).toBe(dry.moved.aggregate)
        expect(report.moved.aggregate).toBe(escapeKeys ? 3 : 1)
        expect(report.conflicts).toEqual([])
        const rows = yield* table.rows()
        const pk = escapeKeys ? "$mixed#v1#routes#r%201" : "$mixed#v1#routes#r 1"
        expect(rows.every((row) => row.pk.S === pk)).toBe(true)
        expect(rows.map((row) => row.sk.S).sort()).toEqual([
          "$mixed#v1#routeitem",
          `$mixed#v1#routestop#${escapeKeys ? "a%20b" : "a b"}`,
          "$mixed#v1#routestop#plain",
        ])
        // The root's collection sort key follows, whether or not its table key moved.
        expect(rows.find((row) => row.sk.S === "$mixed#v1#routeitem")!.lsi1sk.S).toBe(
          `$mixed#v1#routes#${escapeKeys ? "north%20east" : "north east"}`,
        )
        const moved = yield* db.aggregates.Routes.get({ id: "r 1" })
        expect(moved.stops).toHaveLength(2)
        expect((yield* rekeyOf(db, world)).moved.aggregate).toBe(0)
      }),
    )
  }),
  // A string to escape and a changed number in its partition key: at 1.37's text alone.
  ...bothSettings("mixing a string to escape and a changed number", (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const writer = worldOf(true)
    const value = { tenant: "a b", n: -3, stops: [{ label: "x y", note: "n" }] }
    const key = { tenant: "a b", n: -3 }
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.as(writer, (w) => w.aggregates.Trips.create(value))
        yield* demote(
          table,
          "$mixed#v1#trips#a%20b#-9999999999999996:",
          "$mixed#v1#trips#a b#-9999999999999996:",
        )
        expect(yield* db.aggregates.Trips.get(key).pipe(Effect.flip)).toMatchObject({
          _tag: "AggregateAssemblyError",
        })
        const dry = yield* db.tables.MainTable.rekey({ dryRun: true })
        expect(dry.moved.aggregate).toBe(2)
        expect(yield* table.rows()).toHaveLength(2)

        const report = yield* rekeyOf(db, world)
        expect(report.moved.aggregate).toBe(2)
        expect(report.conflicts).toEqual([])
        expect(report.skipped.unrecognizedKey).toBe(0)
        const pk = escapeKeys
          ? "$mixed#v1#trips#a%20b#-9999999999999996:"
          : "$mixed#v1#trips#a b#00000000000000-3"
        expect((yield* table.rows()).every((row) => row.pk.S === pk)).toBe(true)
        expect((yield* db.aggregates.Trips.get(key)).stops).toHaveLength(1)
        expect((yield* rekeyOf(db, world)).moved.aggregate).toBe(0)
      }),
    )
  }),
  // The other setting's rows.
  ...bothSettings("under the other setting's text", (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const writer = worldOf(!escapeKeys)
    const value = { tenant: "a b", n: -3, stops: [{ label: "x y", note: "n" }] }
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.as(writer, (w) => w.aggregates.Trips.create(value))
        const report = yield* rekeyOf(db, world)
        expect(report.moved.aggregate).toBe(2)
        expect(report.conflicts).toEqual([])
        expect((yield* db.aggregates.Trips.get({ tenant: "a b", n: -3 })).stops).toHaveLength(1)
        expect((yield* rekeyOf(db, world)).moved.aggregate).toBe(0)
      }),
    )
  }),
]

/** A number 1.36 wrote, under both settings: off is at its key, on moves it. */
export const number136Scenarios: ReadonlyArray<Scenario> = bothSettings(
  "a number 1.36 wrote",
  (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const values = { tenant: "a b", n: -3, label: "x y", s: 1 }
    const old = {
      pk: "$mixed#v1#thing#tenant_a b#n_00000000000000-3",
      sk: "$mixed#v1#thing#label_x y#s_0000000000000001",
    }
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(stored(values, old, "Thing"))
        if (escapeKeys) expect(yield* notFound(db, values)).toBe("ItemNotFound")
        else expect(yield* db.entities.Things.get(values).asEffect()).toMatchObject(values)
        const report = yield* rekeyOf(db, world)
        expect(report.moved.item).toBe(escapeKeys ? 1 : 0)
        const row = (yield* table.rows()).find((candidate) => candidate.tenant?.S === "a b")!
        expect({ pk: row.pk.S, sk: row.sk.S }).toEqual(
          escapeKeys
            ? {
                pk: "$mixed#v1#thing#tenant_a%20b#n_-9999999999999996:",
                sk: "$mixed#v1#thing#label_x%20y#s_0000000000000001",
              }
            : old,
        )
        expect(yield* db.entities.Things.get(values).asEffect()).toMatchObject(values)
      }),
    )
  },
)

/**
 * An aggregate at its current keys, in a partition whose text didn't change, where one edge's
 * current sort key is another's other text: nothing to move, and nothing to report.
 */
export const aggregateAliasScenarios: ReadonlyArray<Scenario> = bothSettings(
  "an aggregate at its current keys, where they alias",
  (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
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
  },
)

/** One id's key text is another's other text: moved in either scan order, nothing merged. */
export const chainScenarios: ReadonlyArray<Scenario> = [
  ...bothSettings("streams", (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const writer = worldOf(!escapeKeys)
    const spelled = { tenant: "foo%20bar", n: 5 } as never
    const value = { tenant: "foo bar", n: 5 } as never
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.as(writer, () =>
          Effect.gen(function* () {
            yield* writer.Accounts.append(value, [new Deposited({ amount: 1 })], 0)
            yield* writer.Accounts.append(spelled, [new Deposited({ amount: 2 })], 0)
          }),
        )
        const dry = yield* db.tables.MainTable.rekey({
          dryRun: true,
          streams: [world.Accounts],
        })
        const report = yield* rekeyOf(db, world)
        expect(report.moved.stream).toBe(dry.moved.stream)
        expect(report.moved.stream).toBe(2)
        expect(report.conflicts).toEqual([])
        const amounts = (id: never) =>
          world.Accounts.read(id).pipe(
            Effect.map((events: any) => events.map((event: any) => event.data.amount)),
          )
        expect(yield* amounts(value)).toEqual([1])
        expect(yield* amounts(spelled)).toEqual([2])
        expect((yield* rekeyOf(db, world)).moved.stream).toBe(0)
      }),
    )
  }),
  ...bothSettings("aggregates", (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const writer = worldOf(!escapeKeys)
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.as(writer, (w) =>
          Effect.gen(function* () {
            yield* w.aggregates.Routes.create({ id: "foo bar", area: "one", stops: [] })
            yield* w.aggregates.Routes.create({ id: "foo%20bar", area: "two", stops: [] })
          }),
        )
        const dry = yield* db.tables.MainTable.rekey({ dryRun: true })
        const report = yield* rekeyOf(db, world)
        expect(report.moved.aggregate).toBe(dry.moved.aggregate)
        expect(report.moved.aggregate).toBe(2)
        expect(report.conflicts).toEqual([])
        expect((yield* db.aggregates.Routes.get({ id: "foo bar" })).area).toBe("one")
        expect((yield* db.aggregates.Routes.get({ id: "foo%20bar" })).area).toBe("two")
        expect((yield* rekeyOf(db, world)).moved.aggregate).toBe(0)
      }),
    )
  }),
]

/** A `put` before `rekey` writes beside the row, which `rekey` reports. */
export const bothKeysScenarios: ReadonlyArray<Scenario> = bothSettings(
  "a put before rekey writes beside the row, and rekey reports both",
  (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
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
)

/** An inverted row with a string to escape in each half: moved, by the form 1.37 stored it in. */
export const invertedRowScenarios: ReadonlyArray<Scenario> = bothSettings(
  "an inverted row with a string to escape in each half",
  (escapeKeys, h) => {
    const world = worldOf(escapeKeys)
    const values = { userId: "u 3", groupId: "c d" }
    const keys = { pk: "$mixed#v1#edge#userid_u%203", sk: "$mixed#v1#edge#groupid_c d" }
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(stored(values, keys, "Edge"))
        const missing = yield* db.entities.Edges.get(values).asEffect().pipe(Effect.flip)
        expect(missing._tag).toBe("ItemNotFound")
        const dry = yield* db.tables.MainTable.rekey({ dryRun: true })
        expect(dry.moved.item).toBe(1)
        const report = yield* rekeyOf(db, world)
        expect(report.moved.item).toBe(1)
        expect(report.skipped.unrecognizedKey).toBe(0)
        const rows = yield* table.rows()
        expect(rows).toHaveLength(1)
        expect({ pk: rows[0]!.pk.S, sk: rows[0]!.sk.S }).toEqual(
          escapeKeys
            ? { pk: "$mixed#v1#edge#userid_u%203", sk: "$mixed#v1#edge#groupid_c%20d" }
            : { pk: "$mixed#v1#edge#userid_u 3", sk: "$mixed#v1#edge#groupid_c d" },
        )
        expect(yield* db.entities.Edges.get(values).asEffect()).toMatchObject(values)
        expect((yield* rekeyOf(db, world)).moved.item).toBe(0)
      }),
    )
  },
)
