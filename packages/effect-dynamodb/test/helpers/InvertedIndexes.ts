/**
 * Canonical shape 14 (#183): an inverted index, whose partition key is the table's sort key
 * and whose sort key is the table's partition key. It is supported, not encouraged: index keys
 * belong in dedicated GSI attributes. One rule composes every key's text, so both roles build
 * identical text with `escapeKeys` on or off, and no part of it needs a case of its own. Nothing
 * writes a table key attribute through the index. These scenarios run on a recording table and
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

const on = DynamoSchema.make({ name: "halves", version: 1, escapeKeys: true })
const off = DynamoSchema.make({ name: "halves", version: 1, escapeKeys: false })

/** Both settings of the flag, by what a scenario's name says of them. */
const BOTH: ReadonlyArray<readonly [string, DynamoSchema.DynamoSchema]> = [
  ["escaped", on],
  ["escapeKeys off", off],
]

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
const TEXT = ["plain", "u 1", "a b", "50%", "a#b", "MiXeD Case", "Zürich 東京", "x!y"]

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

/** Every value in either key, under every casing and either setting. */
export const textScenarios: ReadonlyArray<Scenario> = (
  [
    ["a lowercase schema", on],
    [
      "an uppercase schema",
      DynamoSchema.make({ name: "halves", version: 1, casing: "uppercase", escapeKeys: true }),
    ],
    [
      "a preserve schema",
      DynamoSchema.make({ name: "halves", version: 1, casing: "preserve", escapeKeys: true }),
    ],
    ["escapeKeys off", off],
    [
      "escapeKeys off, uppercase",
      DynamoSchema.make({ name: "halves", version: 1, casing: "uppercase", escapeKeys: false }),
    ],
    [
      "escapeKeys off, preserve",
      DynamoSchema.make({ name: "halves", version: 1, casing: "preserve", escapeKeys: false }),
    ],
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

/** Number and date composites, whose key text holds nothing either setting escapes. */
export const numberAndDateScenarios: ReadonlyArray<Scenario> = BOTH.flatMap(([label, schema]) =>
  [-3, 0, 2.5, 123456789].map((seq) => ({
    name: `${label}: ${seq}`,
    run: (h: Harness) => {
      const at = DateTime.makeUnsafe("2026-01-02T03:04:05.678Z")
      const key = { seq, at }
      return h.on(worldOf(Reading, readingKey, invertedReadings, {}, schema), (db, table) =>
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
  })),
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

/**
 * Every other path that writes a row, under `schema`: the table's composition is the only
 * writer on each.
 */
const writePathsUnder = (
  label: string,
  schema: DynamoSchema.DynamoSchema,
): ReadonlyArray<Scenario> => [
  {
    name: `${label}: a batch`,
    run: (h: Harness) => {
      const world = edges({}, schema)
      return h.on(world, (db, table) =>
        Effect.gen(function* () {
          yield* Batch.write(VALUES.map((key) => world.Rows.put(key)))
          for (const key of VALUES) yield* expectFound(db, key)
          for (const row of yield* table.rows()) {
            expectTableText(schema, row, { userId: row.userId.S, groupId: row.groupId.S })
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
    name: `${label}: a transaction`,
    run: (h: Harness) => {
      const world = edges({}, schema)
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
            expectTableText(schema, row, { userId: row.userId.S, groupId: row.groupId.S })
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
    const title = label
    const value = JSON.stringify(key)
    return [
      {
        name: `${title}: an upsert: ${value}`,
        run: (h: Harness) =>
          h.on(edges({}, schema), (db, table) =>
            Effect.gen(function* () {
              yield* db.entities.Rows.upsert(key).asEffect()
              yield* db.entities.Rows.upsert(key).asEffect()
              yield* expectFound(db, key)
              expect(yield* table.rows()).toHaveLength(1)
              expectTableText(schema, (yield* table.rows())[0]!, key)
            }),
          ),
      },
      {
        name: `${title}: retained versions: ${value}`,
        run: (h: Harness) =>
          h.on(edges({ versioned: { retain: true } }, schema), (db, table) =>
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
                (row) => row.sk.S === KeyComposer.composeSk(schema, "Edge", 1, primaryOfEdges, key),
              )
              expect(current).toHaveLength(1)
              expect(stored.length).toBeGreaterThan(1)
            }),
          ),
      },
      {
        name: `${title}: soft delete and restore: ${value}`,
        run: (h: Harness) =>
          h.on(edges({ softDelete: true }, schema), (db, table) =>
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
              expectTableText(schema, stored[0]!, key)
            }),
          ),
      },
    ]
  }),
  {
    name: `${label}: append`,
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
          schema,
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
            for (const row of stored) {
              expect(row.pk.S).toBe(KeyComposer.composePk(schema, "Edge", primaryOfEdges, key))
            }
          }),
      ),
  },
]

export const writePathScenarios: ReadonlyArray<Scenario> = BOTH.flatMap(([label, schema]) =>
  writePathsUnder(label, schema),
)

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
 * A sort key of several composites, whose values include what sorts below the delimiter
 * unescaped (`new york#…` before `new#…`). The rows picked by value are the rows returned,
 * whichever plan reads them.
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
    name: ".where() range on a composite before the last",
    run: (h) =>
      withMembers(h, (db) =>
        Effect.gen(function* () {
          const found = yield* db.entities.Rows.byGroup(group)
            .where((t: any, o: any) => o.gt(t.tenant, "new"))
            .collect()
          expectSame(found, (m) => above("new")(m.tenant))
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
    ([name, bounds, picked]): Scenario => ({
      name: `.within(): ${name}`,
      run: (h) =>
        withMembers(h, (db) =>
          Effect.gen(function* () {
            const found = yield* db.entities.Rows.byGroup(group).within(bounds).collect()
            expectSame(found, picked)
          }),
        ),
    }),
  ),
  {
    name: ".within() is planned as on any other index",
    run: (h) =>
      withMembers(h, (db) =>
        Effect.gen(function* () {
          const query = db.entities.Rows.byGroup(group).within({ tenant: { gt: "new" } })
          const explained = yield* query.explain()
          expect(explained.plan).toBe("key")
        }),
      ),
  },
]

/**
 * What holds under `escapeKeys: false` for the same rows: a complete pin and ranges on the last
 * composite. A range on a composite before the last can return wrong rows here, as the docs
 * say; the last three pin what it returns rather than endorse it.
 */
export const multiCompositeOffScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a complete pin is that one row",
    run: (h) =>
      withMembers(
        h,
        (db) =>
          Effect.gen(function* () {
            const pin = { ...group, tenant: "new", userId: "a" }
            const found = yield* db.entities.Rows.byGroup(pin).collect()
            expectSame(found, (m) => m.tenant === "new" && m.userId === "a")
          }),
        off,
      ),
  },
  {
    name: "a pin on the first composite stops at its value",
    run: (h) =>
      withMembers(
        h,
        (db) =>
          Effect.gen(function* () {
            const found = yield* db.entities.Rows.byGroup({ ...group, tenant: "new" }).collect()
            expectSame(found, (m) => m.tenant === "new")
          }),
        off,
      ),
  },
  ...(
    [
      ["eq", (t: any, o: any) => o.eq(t.userId, "a b"), (v: string) => v === "a b"],
      ["lt", (t: any, o: any) => o.lt(t.userId, "a!"), below("a!")],
      [
        "between",
        (t: any, o: any) => o.between(t.userId, "a b", "ab"),
        (v: string) => !below("a b")(v) && !above("ab")(v),
      ],
    ] as const
  ).map(
    ([name, where, picked]): Scenario => ({
      name: `.where() ${name} on the last composite, under a pin`,
      run: (h) =>
        withMembers(
          h,
          (db) =>
            Effect.gen(function* () {
              const found = yield* db.entities.Rows.byGroup({ ...group, tenant: "new" })
                .where(where)
                .collect()
              expectSame(found, (m) => m.tenant === "new" && picked(m.userId))
            }),
          off,
        ),
    }),
  ),
  {
    name: "pinned, not endorsed: `gt` under a pin passes a longer value below the delimiter, as in 1.36",
    run: (h) =>
      withMembers(
        h,
        (db) =>
          Effect.gen(function* () {
            const found = yield* db.entities.Rows.byGroup({ ...group, tenant: "new" })
              .where((t: any, o: any) => o.gt(t.userId, "a"))
              .collect()
            expect(found.map((m: Member) => m.userId).sort()).toEqual(["ab", "b"])
          }),
        off,
      ),
  },
  {
    name: "pinned, not endorsed: a range on the first composite takes a value below the delimiter",
    run: (h) =>
      withMembers(
        h,
        (db) =>
          Effect.gen(function* () {
            const found = yield* db.entities.Rows.byGroup(group)
              .where((t: any, o: any) => o.lte(t.tenant, "new"))
              .collect()
            // `new york#…` sorts before `new#…` unescaped, so it is inside the range.
            expect(found.some((m: Member) => m.tenant === "new york")).toBe(true)
          }),
        off,
      ),
  },
]

const offForm: KeyText136.KeyForm = { pk: off, sk: off }
const onForm: KeyText136.KeyForm = { pk: on, sk: on }

const seededAt = (
  form: KeyText136.KeyForm,
  values: { readonly userId: string; readonly groupId: string },
) =>
  toAttributeMap({
    ...values,
    ...KeyText136.composeAt(form, "Edge", 1, primaryOfEdges, values),
    __edd_e__: "Edge",
  }) as StoredRow

/** Until `rekey` moves it nothing finds the row, then everything does, and a second run moves nothing. */
const movesTo = (
  h: Harness,
  schema: DynamoSchema.DynamoSchema,
  row: StoredRow,
  values: { readonly userId: string; readonly groupId: string },
) =>
  h.on(edges({}, schema), (db, table) =>
    Effect.gen(function* () {
      yield* table.seed(row)
      expect(yield* notFound(db, values)).toBe("ItemNotFound")
      expect(yield* db.entities.Rows.byGroup(values).collect()).toHaveLength(0)

      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
      expect(dry.moved.item).toBe(1)
      expect(yield* table.rows()).toEqual([row])

      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.moved.item).toBe(1)
      expect(report.conflicts).toEqual([])
      expect(report.skipped).toEqual(dry.skipped)
      expect(report.indexKeysRewritten).toBe(0)

      const rows = yield* table.rows()
      expect(rows).toHaveLength(1)
      expectTableText(schema, rows[0]!, values)
      yield* expectFound(db, values)

      const again: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(again.moved.item).toBe(0)
      expect(again.unchanged).toBe(1)
    }),
  )

/** A row whose text changed, each way: `rekey` moves it (the index follows, its halves being the table's key). */
const CHANGED = [
  { userId: "u 1", groupId: "a b" },
  { userId: "u1", groupId: "a b" },
  { userId: "u1", groupId: "50%" },
  { userId: "u1", groupId: "MiXeD #1" },
]
export const row136Scenarios: ReadonlyArray<Scenario> = CHANGED.flatMap((values) => [
  {
    name: `1.36 text, on: ${JSON.stringify(values)}`,
    run: (h: Harness) => movesTo(h, on, seededAt(offForm, values), values),
  },
  {
    name: `on's text, off: ${JSON.stringify(values)}`,
    run: (h: Harness) => movesTo(h, off, seededAt(onForm, values), values),
  },
])

/** A row whose text didn't change: nothing moves under either setting. */
export const unchanged136Scenario = (h: Harness) =>
  Effect.forEach(
    [on, off],
    (schema) => {
      const values = { userId: "u1", groupId: "plain" }
      return h.on(edges({}, schema), (db, table) =>
        Effect.gen(function* () {
          yield* table.seed(seededAt(offForm, values))
          yield* expectFound(db, values)
          const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
          expect(report.moved.item).toBe(0)
          expect(report.indexKeysRewritten).toBe(0)
          expect(report.unchanged).toBe(1)
          yield* expectFound(db, values)
        }),
      )
    },
    { discard: true },
  )

/** Under off a 1.36 row is already at its key, whatever its values hold: nothing moves. */
export const off136Scenarios: ReadonlyArray<Scenario> = VALUES.map((values) => ({
  name: JSON.stringify(values),
  run: (h: Harness) =>
    h.on(edges({}, off), (db, table) =>
      Effect.gen(function* () {
        yield* table.seed(seededAt(offForm, values))
        yield* expectFound(db, values)
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.moved.item).toBe(0)
        expect(report.indexKeysRewritten).toBe(0)
        expect(report.unchanged).toBe(1)
        yield* expectFound(db, values)
      }),
    ),
}))

/**
 * A row with number composites, whose text changed in both keys, moved from each text the other
 * setting has stored it under to the one this setting composes.
 */
export const number136Scenarios: ReadonlyArray<Scenario> = (
  [
    ["1.36 text, on", on, offForm],
    ["on's text, off", off, onForm],
    ["1.37.0's text, off", off, { pk: KeyText136.schema137(off), sk: on }],
  ] as const
).map(([label, schema, form]) => ({
  name: label,
  run: (h: Harness) => {
    const at = DateTime.makeUnsafe("2026-01-02T03:04:05.678Z")
    const world = worldOf(Reading, readingKey, invertedReadings, {}, schema)
    const key = { seq: -3, at }
    const keyForm = { seq: -3, at: "2026-01-02T03:04:05.678Z" }
    const primary = world.Rows.indexes.primary
    return h.on(world, (db, table) =>
      Effect.gen(function* () {
        const old = KeyText136.composeAt(form, "Edge", 1, primary, keyForm)
        const now = KeyText136.composeAt({ pk: schema, sk: schema }, "Edge", 1, primary, keyForm)
        expect(old).not.toEqual(now)
        yield* table.seed(
          toAttributeMap({ seq: -3, at: keyForm.at, ...old, __edd_e__: "Edge" }) as StoredRow,
        )
        const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        expect(report.moved.item).toBe(1)
        expect(report.conflicts).toEqual([])
        const [row] = yield* table.rows()
        expect(row!.pk.S).toBe(now.pk)
        expect(row!.sk.S).toBe(now.sk)
        expect(yield* db.entities.Rows.get(key).asEffect()).toMatchObject({ seq: -3 })
        expect(yield* db.entities.Rows.byAt({ at }).collect()).toHaveLength(1)
        expect(yield* db.entities.Rows.byAt(key).collect()).toHaveLength(1)
      }),
    )
  },
}))

/**
 * What 1.37.0 left, writing an inverted index's halves over the table's: the partition key
 * attribute holds the index's sort half (escaped) and the sort key attribute its partition half
 * (not escaped). With nothing to escape in the sort key that is the key `on` composes.
 */
export const overwritten137Scenario = (h: Harness) => {
  const values = { userId: "u 1", groupId: "plain" }
  return h.on(edges({}, on), (db, table) =>
    Effect.gen(function* () {
      const row = seededAt(KeyText136.invertedForm137(on), values)
      expect(row.pk.S).toContain("userid_u%201")
      yield* table.seed(row)
      yield* expectFound(db, values)

      const report: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      expect(report.moved.item).toBe(0)
      expect(report.indexKeysRewritten).toBe(0)
      expect(report.conflicts).toEqual([])
      expect(report.unchanged).toBe(1)

      yield* db.entities.Rows.delete(values).asEffect()
      expect(yield* table.rows()).toHaveLength(0)
    }),
  )
}

/** With an escape in both halves that row is at no form's key but its own: `rekey` moves it. */
export const overwritten137Scenarios: ReadonlyArray<Scenario> = [
  { userId: "u 1", groupId: "a b" },
  { userId: "u%1", groupId: "50%" },
].flatMap((values) => [
  {
    name: `an escape in both halves, on: ${JSON.stringify(values)}`,
    run: (h: Harness) => movesTo(h, on, seededAt(KeyText136.invertedForm137(on), values), values),
  },
  {
    name: `an escape in both halves, off: ${JSON.stringify(values)}`,
    run: (h: Harness) => movesTo(h, off, seededAt(KeyText136.invertedForm137(off), values), values),
  },
])

/** Off: a key holding an escape isn't found by anything until `rekey` moves it to 1.36 text. */
export const overwritten137OffScenario = (h: Harness) => {
  const values = { userId: "u 1", groupId: "plain" }
  return movesTo(h, off, seededAt(KeyText136.invertedForm137(off), values), values)
}
