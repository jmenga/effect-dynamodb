/**
 * Canonical shape 14 (#183, D62): an index half stored in a table key attribute, with the
 * composites of the table half stored there, is that half of the table's key. An inverted
 * index is the case that matters: its partition key is the table's sort key, its sort key
 * the table's partition key. Nothing writes either through the index, and whatever reads
 * through them composes the table half's text. These scenarios run on a recording table and
 * on DynamoDB Local, through a {@link Harness}.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DateTime, Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { compareUtf8 } from "../../src/internal/RangePlanner.js"
import { toAttributeMap } from "../../src/Marshaller.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"

type StoredRow = Record<string, any>
type World = { readonly MainTable: any; readonly Rows: any }

/** What a scenario needs of a table. */
export interface Harness {
  /** Run `body` with a client over `world`'s member, on a table made from its definition. */
  readonly on: <A, E>(
    world: World,
    body: (db: any, table: StoredRows) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

export interface StoredRows {
  /** Store a row as it is. */
  readonly seed: (row: StoredRow) => Effect.Effect<void, unknown, any>
  /** Every stored row. */
  readonly rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown, any>
  /** Run `body` with a client over another world's member, on this table. */
  readonly as: <A, E>(
    world: World,
    body: (db: any) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown, any>
}

export const clientOf = (world: World) =>
  DynamoClient.make({
    entities: { Rows: world.Rows },
    tables: { MainTable: world.MainTable },
  }) as Effect.Effect<any, never, any>

type Scenario = {
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}

const on = DynamoSchema.make({ name: "halves", version: 1 })
const noFallback = DynamoSchema.make({ name: "halves", version: 1, legacyKeys: false })

const worldOf = (
  model: unknown,
  primaryKey: unknown,
  indexes: unknown,
  options: Record<string, unknown> = {},
  schema: DynamoSchema.DynamoSchema = on,
): World => {
  const Rows = Entity.make({
    model,
    entityType: "Edge",
    primaryKey,
    indexes,
    ...options,
  } as never) as any
  return { Rows, MainTable: Table.make({ schema, entities: { Rows } }) }
}

class Edge extends Schema.Class<Edge>("Edge")({
  userId: Schema.String,
  groupId: Schema.String,
  role: Schema.optional(Schema.String),
}) {}

const edgeKey = {
  pk: { field: "pk", composite: ["userId"] },
  sk: { field: "sk", composite: ["groupId"] },
} as const
const invertedEdges = {
  byGroup: {
    name: "inverted",
    pk: { field: "sk", composite: ["groupId"] },
    sk: { field: "pk", composite: ["userId"] },
  },
} as const

const edges = (options: Record<string, unknown> = {}, schema: DynamoSchema.DynamoSchema = on) =>
  worldOf(Edge, edgeKey, invertedEdges, options, schema)

/** A value of each kind a key's text can treat differently. */
const TEXT = ["plain", "a b", "50%", "a#b", "MiXeD Case", "Zürich 東京", "x!y"]

/** The row's text is the table's: nothing composed through the index reached it. */
const expectTableText = (schema: DynamoSchema.DynamoSchema, row: StoredRow, values: object) => {
  const primary = edges().Rows.indexes.primary
  expect(row.pk.S).toBe(KeyComposer.composePk(schema, "Edge", primary, values as never))
  expect(row.sk.S).toBe(KeyComposer.composeSk(schema, "Edge", 1, primary, values as never))
}

const notFound = (db: any, key: object) =>
  db.entities.Rows.get(key)
    .asEffect()
    .pipe(
      Effect.flip,
      Effect.map((error: any) => error._tag),
    )

/** `put`, `get`, the inverted query with and without a pin, `update` and `delete`. */
const lifecycleOf = (schema: DynamoSchema.DynamoSchema, userId: string, groupId: string) => {
  const key = { userId, groupId }
  return (db: any, table: StoredRows) =>
    Effect.gen(function* () {
      yield* db.entities.Rows.put(key).asEffect()
      const stored = yield* table.rows()
      expect(stored).toHaveLength(1)
      expectTableText(schema, stored[0]!, key)

      expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject(key)
      expect(yield* db.entities.Rows.byGroup({ groupId }).collect()).toHaveLength(1)
      expect(yield* db.entities.Rows.byGroup({ groupId, userId }).collect()).toHaveLength(1)

      yield* db.entities.Rows.update(key).set({ role: "r" }).asEffect()
      expect(yield* table.rows()).toHaveLength(1)
      expectTableText(schema, (yield* table.rows())[0]!, key)
      expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ role: "r" })
      const found = yield* db.entities.Rows.byGroup({ groupId, userId }).collect()
      expect(found.map((row: Edge) => row.role)).toEqual(["r"])

      yield* db.entities.Rows.delete(key).asEffect()
      expect(yield* notFound(db, key)).toBe("ItemNotFound")
      expect(yield* table.rows()).toHaveLength(0)
      expect(yield* db.entities.Rows.byGroup({ groupId }).collect()).toHaveLength(0)
    })
}

/** Every value in either key, under every casing, with the fallback on and off. */
export const textScenarios: ReadonlyArray<Scenario> = (
  [
    ["a lowercase schema", on],
    ["an uppercase schema", DynamoSchema.make({ name: "halves", version: 1, casing: "uppercase" })],
    ["a preserve schema", DynamoSchema.make({ name: "halves", version: 1, casing: "preserve" })],
    ["the fallback off", DynamoSchema.make({ name: "halves", version: 1, legacyKeys: false })],
  ] as const
).flatMap(([label, schema]) =>
  TEXT.map((value) => ({
    name: `${label}: ${JSON.stringify(value)}`,
    run: (h: Harness) =>
      Effect.gen(function* () {
        yield* h.on(edges({}, schema), lifecycleOf(schema, value, "g"))
        yield* h.on(edges({}, schema), lifecycleOf(schema, "u", value))
        yield* h.on(edges({}, schema), lifecycleOf(schema, value, value))
      }),
  })),
)

class Reading extends Schema.Class<Reading>("Reading")({
  seq: Schema.Number,
  at: Schema.DateTimeUtc,
  note: Schema.optional(Schema.String),
}) {}

const readingKey = {
  pk: { field: "pk", composite: ["seq"] },
  sk: { field: "sk", composite: ["at"] },
} as const
const invertedReadings = {
  byAt: {
    name: "inverted",
    pk: { field: "sk", composite: ["at"] },
    sk: { field: "pk", composite: ["seq"] },
  },
} as const

/** Number and date composites, whose key text holds nothing either half escapes. */
export const numberAndDateScenarios: ReadonlyArray<Scenario> = [-3, 0, 2.5, 123456789].map(
  (seq) => ({
    name: `${seq}`,
    run: (h: Harness) => {
      const at = DateTime.makeUnsafe("2026-01-02T03:04:05.678Z")
      const key = { seq, at }
      return h.on(worldOf(Reading, readingKey, invertedReadings), (db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(key).asEffect()
          expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ seq })
          expect(yield* db.entities.Rows.byAt({ at }).collect()).toHaveLength(1)
          expect(yield* db.entities.Rows.byAt({ at, seq }).collect()).toHaveLength(1)
          yield* db.entities.Rows.update(key).set({ note: "n" }).asEffect()
          expect(yield* db.entities.Rows.byAt({ at, seq }).collect()).toHaveLength(1)
          expect(yield* table.rows()).toHaveLength(1)
          yield* db.entities.Rows.delete(key).asEffect()
          expect(yield* table.rows()).toHaveLength(0)
        }),
      )
    },
  }),
)

const VALUES = [
  { userId: "u 1", groupId: "plain" },
  { userId: "u1", groupId: "a b" },
  { userId: "u%1", groupId: "50%" },
]

const expectFound = (db: any, key: { readonly userId: string; readonly groupId: string }) =>
  Effect.gen(function* () {
    expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject(key)
    expect(yield* db.entities.Rows.byGroup({ groupId: key.groupId }).collect()).toHaveLength(1)
    expect(yield* db.entities.Rows.byGroup(key).collect()).toHaveLength(1)
  })

/** Every other path that writes a row: the table's composition is the only writer on each. */
export const writePathScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a batch",
    run: (h: Harness) => {
      const world = edges()
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* Batch.write(VALUES.map((key) => world.Rows.put(key)))
          for (const key of VALUES) yield* expectFound(db, key)
          for (const row of yield* table.rows()) {
            expectTableText(on, row, { userId: row.userId.S, groupId: row.groupId.S })
          }
          const got = yield* Batch.get(VALUES.map((key) => world.Rows.get(key)))
          expect(got.filter((item: unknown) => item !== undefined)).toHaveLength(VALUES.length)
          yield* Batch.write(VALUES.map((key) => world.Rows.delete(key)))
          expect(yield* table.rows()).toHaveLength(0)
        }),
      )
    },
  },
  {
    name: "a transaction",
    run: (h: Harness) => {
      const world = edges()
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* Transaction.transactWrite(VALUES.map((key) => world.Rows.put(key)))
          for (const key of VALUES) yield* expectFound(db, key)
          yield* Transaction.transactWrite(
            VALUES.map((key) => world.Rows.update(key).pipe(Entity.set({ role: "r" }))),
          )
          for (const key of VALUES) {
            yield* expectFound(db, key)
            expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ role: "r" })
          }
          for (const row of yield* table.rows()) {
            expectTableText(on, row, { userId: row.userId.S, groupId: row.groupId.S })
          }
          const got = yield* Transaction.transactGet(VALUES.map((key) => world.Rows.get(key)))
          expect(got.filter((item: unknown) => item !== undefined)).toHaveLength(VALUES.length)
          yield* Transaction.transactWrite(VALUES.map((key) => world.Rows.delete(key)))
          expect(yield* table.rows()).toHaveLength(0)
        }),
      )
    },
  },
  ...VALUES.flatMap((key): ReadonlyArray<Scenario> => {
    const label = JSON.stringify(key)
    return [
      {
        name: `an upsert: ${label}`,
        run: (h: Harness) =>
          h.on(edges(), (db, table) =>
            Effect.gen(function* () {
              yield* db.entities.Rows.upsert(key).asEffect()
              yield* db.entities.Rows.upsert(key).asEffect()
              yield* expectFound(db, key)
              expect(yield* table.rows()).toHaveLength(1)
              expectTableText(on, (yield* table.rows())[0]!, key)
            }),
          ),
      },
      {
        name: `retained versions: ${label}`,
        run: (h: Harness) =>
          h.on(edges({ versioned: { retain: true } }), (db, table) =>
            Effect.gen(function* () {
              yield* db.entities.Rows.put({ ...key, role: "first" }).asEffect()
              yield* db.entities.Rows.update(key).set({ role: "second" }).asEffect()
              yield* expectFound(db, key)
              expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ role: "second" })
              expect(yield* db.entities.Rows.getVersion(key, 1)).toMatchObject({ role: "first" })
              // The inverted partition holds the current row, not a snapshot of it.
              const found = yield* db.entities.Rows.byGroup({ groupId: key.groupId }).collect()
              expect(found.map((row: Edge) => row.role)).toEqual(["second"])
              const stored = yield* table.rows()
              const current = stored.filter(
                (row) => row.sk.S === KeyComposer.composeSk(on, "Edge", 1, primaryOfEdges, key),
              )
              expect(current).toHaveLength(1)
              expect(stored.length).toBeGreaterThan(1)
            }),
          ),
      },
      {
        name: `soft delete and restore: ${label}`,
        run: (h: Harness) =>
          h.on(edges({ softDelete: true }), (db, table) =>
            Effect.gen(function* () {
              yield* db.entities.Rows.put({ ...key, role: "r" }).asEffect()
              yield* db.entities.Rows.delete(key).asEffect()
              expect(yield* notFound(db, key)).toBe("ItemNotFound")
              const gone = yield* db.entities.Rows.byGroup({ groupId: key.groupId }).collect()
              expect(gone).toHaveLength(0)
              expect(yield* db.entities.Rows.deleted.get(key)).toMatchObject({ role: "r" })
              yield* db.entities.Rows.restore(key)
              yield* expectFound(db, key)
              const stored = yield* table.rows()
              expect(stored).toHaveLength(1)
              expectTableText(on, stored[0]!, key)
            }),
          ),
      },
    ]
  }),
  {
    name: "append",
    run: (h: Harness) =>
      h.on(
        worldOf(
          Schema.Struct({
            userId: Schema.String,
            groupId: Schema.String,
            at: Schema.Number,
            reading: Schema.optional(Schema.String),
          }),
          edgeKey,
          invertedEdges,
          {
            timeSeries: {
              orderBy: "at",
              appendInput: Schema.Struct({
                userId: Schema.String,
                groupId: Schema.String,
                at: Schema.Number,
                reading: Schema.optional(Schema.String),
              }),
            },
          },
        ),
        (db, table) =>
          Effect.gen(function* () {
            const key = { userId: "u 1", groupId: "a b" }
            yield* db.entities.Rows.append({ ...key, at: 1, reading: "x" })
            yield* db.entities.Rows.append({ ...key, at: 2, reading: "y" })
            expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ reading: "y" })
            const found = yield* db.entities.Rows.byGroup({ groupId: key.groupId }).collect()
            expect(found.map((row: { readonly reading: string }) => row.reading)).toEqual(["y"])
            const pinned = yield* db.entities.Rows.byGroup(key).collect()
            expect(pinned).toHaveLength(1)
            const stored = yield* table.rows()
            expect(stored.some((row) => row.pk.S.includes("%"))).toBe(false)
          }),
      ),
  },
]

const primaryOfEdges = edges().Rows.indexes.primary as KeyComposer.IndexDefinition

class Member extends Schema.Class<Member>("Member")({
  tenant: Schema.String,
  userId: Schema.String,
  groupId: Schema.String,
  kind: Schema.String,
}) {}

const memberKey = {
  pk: { field: "pk", composite: ["tenant", "userId"] },
  sk: { field: "sk", composite: ["groupId", "kind"] },
} as const
const invertedMembers = {
  byGroup: {
    name: "inverted",
    pk: { field: "sk", composite: ["groupId", "kind"] },
    sk: { field: "pk", composite: ["tenant", "userId"] },
  },
} as const

const TENANTS = ["new", "new york", "new!", "newt", "m"]
const USERS = ["a", "a b", "a!", "ab", "b"]
const group = { groupId: "g 1", kind: "k%" }
const MEMBERS = TENANTS.flatMap((tenant) =>
  USERS.map((userId) => ({ ...group, tenant, userId })),
) as ReadonlyArray<Member>

type Pick = (member: Member) => boolean

const expectSame = (found: ReadonlyArray<Member>, pick: Pick) =>
  expect(found.map(({ tenant, userId }) => `${tenant}|${userId}`).sort()).toEqual(
    MEMBERS.filter(pick)
      .map(({ tenant, userId }) => `${tenant}|${userId}`)
      .sort(),
  )

/**
 * A sort key in partition key text with more than one composite: its values aren't escaped,
 * so a value can hold what sorts below the delimiter (`new york#…` before `new#…`). The rows
 * picked by value are the rows returned, whichever plan reads them.
 */
const membersWorld = (schema: DynamoSchema.DynamoSchema) =>
  worldOf(Member, memberKey, invertedMembers, {}, schema)

const withMembers = (
  h: Harness,
  body: (db: any) => Effect.Effect<void, unknown, any>,
  schema: DynamoSchema.DynamoSchema = on,
) => {
  const world = membersWorld(schema)
  return h.on(world, (db) =>
    Effect.gen(function* () {
      yield* Batch.write(MEMBERS.map((member) => world.Rows.put(member)))
      yield* body(db)
    }),
  )
}

const above = (value: string) => (other: string) => compareUtf8(other, value) > 0
const below = (value: string) => (other: string) => compareUtf8(other, value) < 0

export const multiCompositeScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a pin on the first composite stops at its value",
    run: (h) =>
      withMembers(h, (db) =>
        Effect.gen(function* () {
          const found = yield* db.entities.Rows.byGroup({ ...group, tenant: "new" }).collect()
          expectSame(found, (m) => m.tenant === "new")
        }),
      ),
  },
  {
    name: "a complete pin is that one row",
    run: (h) =>
      withMembers(h, (db) =>
        Effect.gen(function* () {
          const pin = { ...group, tenant: "new", userId: "a" }
          const found = yield* db.entities.Rows.byGroup(pin).collect()
          expectSame(found, (m) => m.tenant === "new" && m.userId === "a")
        }),
      ),
  },
  ...(
    [
      ["eq", (t: any, o: any) => o.eq(t.userId, "a b"), (v: string) => v === "a b"],
      ["gt", (t: any, o: any) => o.gt(t.userId, "a"), above("a")],
      ["gte", (t: any, o: any) => o.gte(t.userId, "a b"), (v: string) => !below("a b")(v)],
      ["lt", (t: any, o: any) => o.lt(t.userId, "a!"), below("a!")],
      ["lte", (t: any, o: any) => o.lte(t.userId, "a"), (v: string) => !above("a")(v)],
      [
        "between",
        (t: any, o: any) => o.between(t.userId, "a b", "ab"),
        (v: string) => !below("a b")(v) && !above("ab")(v),
      ],
      ["beginsWith", (t: any, o: any) => o.beginsWith(t.userId, "a"), (v: string) => v[0] === "a"],
    ] as const
  ).map(
    ([name, where, picked]): Scenario => ({
      name: `.where() ${name} on the last composite, under a pin`,
      run: (h) =>
        withMembers(h, (db) =>
          Effect.gen(function* () {
            const found = yield* db.entities.Rows.byGroup({ ...group, tenant: "new" })
              .where(where)
              .collect()
            expectSame(found, (m) => m.tenant === "new" && picked(m.userId))
          }),
        ),
    }),
  ),
  {
    name: ".where() eq and beginsWith on a composite before the last",
    run: (h) =>
      withMembers(h, (db) =>
        Effect.gen(function* () {
          const equal = yield* db.entities.Rows.byGroup(group)
            .where((t: any, o: any) => o.eq(t.tenant, "new"))
            .collect()
          expectSame(equal, (m) => m.tenant === "new")
          const prefixed = yield* db.entities.Rows.byGroup(group)
            .where((t: any, o: any) => o.beginsWith(t.tenant, "new"))
            .collect()
          expectSame(prefixed, (m) => m.tenant.startsWith("new"))
        }),
      ),
  },
  {
    name: ".where() range on a composite before the last is refused, naming .within()",
    run: (h) =>
      withMembers(h, (db) =>
        Effect.sync(() => {
          expect(() =>
            db.entities.Rows.byGroup(group).where((t: any, o: any) => o.gt(t.tenant, "new")),
          ).toThrow(/\[EDD-9107\].*"tenant".*\.within\(\)/)
        }),
      ),
  },
  ...(
    [
      [
        "a range on the first composite",
        { tenant: { gt: "new" } },
        (m: Member) => above("new")(m.tenant),
      ],
      [
        "both ends of the first composite",
        { tenant: { gte: "new york", lt: "newt" } },
        (m: Member) => !below("new york")(m.tenant) && below("newt")(m.tenant),
      ],
      ["eq on the first composite", { tenant: { eq: "new" } }, (m: Member) => m.tenant === "new"],
      [
        "eq then a range on the last",
        { tenant: { eq: "new" }, userId: { gt: "a" } },
        (m: Member) => m.tenant === "new" && above("a")(m.userId),
      ],
      [
        "a range on each",
        { tenant: { lt: "new!" }, userId: { lte: "a!" } },
        (m: Member) => below("new!")(m.tenant) && !above("a!")(m.userId),
      ],
      [
        "the last composite alone, past an unbounded one",
        { userId: { gt: "a" } },
        (m: Member) => above("a")(m.userId),
      ],
    ] as const
  ).flatMap(
    ([name, bounds, picked]): ReadonlyArray<Scenario> =>
      (
        [
          ["", on],
          // Nothing judges a row for the fallback's sake, so a range too wide shows.
          [", the fallback off", noFallback],
        ] as const
      ).map(([label, schema]) => ({
        name: `.within(): ${name}${label}`,
        run: (h) =>
          withMembers(
            h,
            (db) =>
              Effect.gen(function* () {
                const found = yield* db.entities.Rows.byGroup(group).within(bounds).collect()
                expectSame(found, picked)
              }),
            schema,
          ),
      })),
  ),
  {
    name: ".within() past an unbounded composite is a filter plan, whatever the value holds",
    run: (h) =>
      withMembers(h, (db) =>
        Effect.gen(function* () {
          const query = db.entities.Rows.byGroup(group).within({ userId: { gt: "a" } })
          const explained = yield* query.explain()
          expect(explained.plan).toBe("filter")
          expect(explained.reason).toContain("partition key text")
        }),
      ),
  },
]

const rowKeyOf = (primary: KeyComposer.IndexDefinition, values: Record<string, unknown>) => ({
  pk: KeyText136.composePk(on, "Edge", primary, values),
  sk: KeyText136.composeSk(on, "Edge", 1, primary, values),
})

const seededEdge = (values: { readonly userId: string; readonly groupId: string }) =>
  toAttributeMap({ ...values, ...rowKeyOf(primaryOfEdges, values), __edd_e__: "Edge" }) as StoredRow

/**
 * A row 1.36 wrote: found with the fallback on, moved by `rekey` (the index follows, as its
 * half is the table's key), and found with the fallback off.
 */
export const row136Scenarios: ReadonlyArray<Scenario> = [
  { userId: "u 1", groupId: "a b" },
  { userId: "u1", groupId: "a b" },
  { userId: "u1", groupId: "50%" },
  { userId: "u1", groupId: "MiXeD #1" },
].map((values) => ({
  name: JSON.stringify(values),
  run: (h: Harness) =>
    h.on(edges(), (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(seededEdge(values))
        yield* expectFound(db, values)

        const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
        expect(dry.moved.item).toBe(1)
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.moved.item).toBe(1)
        expect(report.conflicts).toEqual([])
        expect(report.indexKeysRewritten).toBe(0)

        const [row] = yield* table.rows()
        expectTableText(on, row!, values)
        expect(yield* table.rows()).toHaveLength(1)
        yield* expectFound(db, values)

        yield* table.as(edges({}, noFallback), (current) => expectFound(current, values))
      }),
    ),
}))

/** A 1.36 row whose text didn't change: nothing moves, and it never needed the fallback. */
export const unchanged136Scenario = (h: Harness) => {
  const values = { userId: "u 1", groupId: "plain" }
  return h.on(edges(), (db, table) =>
    Effect.gen(function* () {
      yield* table.seed(seededEdge(values))
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.moved.item).toBe(0)
      expect(report.indexKeysRewritten).toBe(0)
      expect(report.unchanged).toBe(1)
      yield* table.as(edges({}, noFallback), (current) => expectFound(current, values))
    }),
  )
}

/** A 1.36 row with number composites, whose text changed in both keys. */
export const number136Scenario = (h: Harness) => {
  const at = DateTime.makeUnsafe("2026-01-02T03:04:05.678Z")
  const world = worldOf(Reading, readingKey, invertedReadings)
  const current = worldOf(Reading, readingKey, invertedReadings, {}, noFallback)
  const key = { seq: -3, at }
  const keyForm = { seq: -3, at: "2026-01-02T03:04:05.678Z" }
  const primary = world.Rows.indexes.primary
  const found = (db: any) =>
    Effect.gen(function* () {
      expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ seq: -3 })
      expect(yield* db.entities.Rows.byAt({ at }).collect()).toHaveLength(1)
      expect(yield* db.entities.Rows.byAt(key).collect()).toHaveLength(1)
    })
  return h.on(world, (db, table) =>
    Effect.gen(function* () {
      const old = {
        pk: KeyText136.composePk(on, "Edge", primary, keyForm),
        sk: KeyText136.composeSk(on, "Edge", 1, primary, keyForm),
      }
      expect(old.pk).not.toBe(KeyComposer.composePk(on, "Edge", primary, keyForm))
      yield* table.seed(
        toAttributeMap({
          seq: -3,
          at: keyForm.at,
          ...old,
          __edd_e__: "Edge",
        }) as StoredRow,
      )
      yield* found(db)
      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.moved.item).toBe(1)
      expect(report.conflicts).toEqual([])
      const [row] = yield* table.rows()
      expect(row!.pk.S).toBe(KeyComposer.composePk(on, "Edge", primary, keyForm))
      yield* table.as(current, found)
    }),
  )
}

/**
 * What 1.37.0 left, writing an inverted index's halves over the table's: a partition key
 * holding sort key text. Nothing composes that key from the row's values any more.
 */
const overwrittenRow = (values: { readonly userId: string; readonly groupId: string }) =>
  toAttributeMap({
    ...values,
    pk: KeyComposer.composeSk(on, "Edge", 1, primaryWithUserSort, values),
    sk: KeyComposer.composeSk(on, "Edge", 1, primaryOfEdges, values),
    __edd_e__: "Edge",
  }) as StoredRow

const primaryWithUserSort: KeyComposer.IndexDefinition = {
  pk: { field: "sk", composite: ["groupId"] },
  sk: { field: "pk", composite: ["userId"] },
}

/**
 * Pinned, not endorsed: this release doesn't repair such a row. `get` and a pin can't reach
 * it, and `delete` reports success and leaves it, as they did on 1.37.0. The inverted
 * partition still lists it, and `rekey` leaves it alone. A re-put writes the row at its key
 * and leaves this one beside it; a delete spelling the stored text removes it.
 */
export const overwritten137Scenario = (h: Harness) => {
  const values = { userId: "u 1", groupId: "plain" }
  const spelled = { userId: "u%201", groupId: "plain" }
  return h.on(edges(), (db, table) =>
    Effect.gen(function* () {
      const row = overwrittenRow(values)
      expect(row.pk.S).toContain("userid_u%201")
      yield* table.seed(row)

      expect(yield* notFound(db, values)).toBe("ItemNotFound")
      expect(yield* db.entities.Rows.byGroup(values).collect()).toHaveLength(0)
      const listed = yield* db.entities.Rows.byGroup({ groupId: values.groupId }).collect()
      expect(listed.map((found: Edge) => found.userId)).toEqual(["u 1"])

      yield* db.entities.Rows.delete(values).asEffect()
      expect(yield* table.rows()).toHaveLength(1)

      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.moved.item).toBe(0)
      expect(report.indexKeysRewritten).toBe(0)
      expect(report.conflicts).toEqual([])
      expect(report.skipped.unrecognizedKey).toBe(1)
      expect((yield* table.rows()).map((stored) => stored.pk.S)).toEqual([row.pk.S])

      yield* db.entities.Rows.put(values).asEffect()
      expect(yield* db.entities.Rows.get(values).asEffect()).toMatchObject(values)
      expect(yield* db.entities.Rows.byGroup(values).collect()).toHaveLength(1)
      expect(yield* table.rows()).toHaveLength(2)
      expect(yield* db.entities.Rows.byGroup({ groupId: values.groupId }).collect()).toHaveLength(2)

      yield* db.entities.Rows.delete(spelled).asEffect()
      const left = yield* table.rows()
      expect(left).toHaveLength(1)
      expectTableText(on, left[0]!, values)
    }),
  )
}
