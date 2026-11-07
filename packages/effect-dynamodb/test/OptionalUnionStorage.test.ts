/**
 * `Schema.optionalKey` over a union: the first member is written in its stored form and the rest as
 * they're declared, so what's stored for a date depends on which member it is, as it always has. The
 * read takes each member's forms. Against an in-memory table; `connected.unreadable.test.ts` has the
 * same on real rows.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Equal, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })
const ISO = "2025-01-01T00:00:00.000Z"
const instant = DateTime.makeUnsafe(ISO)
const when = new Date(ISO)
const later = DateTime.makeUnsafe("2026-02-02T00:00:00.000Z")
const INTERNAL = {
  M: {
    epochMilliseconds: { N: String(when.getTime()) },
    "~effect/DateTime": { S: "~effect/DateTime" },
    _tag: { S: "Utc" },
  },
}
const key = (of: unknown) => JSON.stringify(of)

const K = (...members: ReadonlyArray<Schema.Top>) =>
  Schema.optionalKey(Schema.Union(members as never) as never) as unknown as Schema.Top

/** A table of one row at a time: what a put wrote, and the values of the last update. */
const memoryTable = () => {
  const rows = new Map<string, Record<string, any>>()
  const updates: Array<Record<string, any>> = []
  const layer = mockDynamoClientLayer({
    putItem: (input: any) =>
      Effect.sync(() => {
        rows.set(key({ pk: input.Item.pk, sk: input.Item.sk }), input.Item)
        return {}
      }),
    getItem: (input: any) => Effect.sync(() => ({ Item: rows.get(key(input.Key)) })),
    updateItem: (input: any) =>
      Effect.sync(() => {
        updates.push(input)
        const row = rows.get(key(input.Key)) ?? {}
        return { Attributes: row }
      }),
    transactWriteItems: (input: any) =>
      Effect.sync(() => {
        for (const item of input.TransactItems) {
          const put = item.Put?.Item
          if (put !== undefined) rows.set(key({ pk: put.pk, sk: put.sk }), put)
        }
        return {}
      }),
    query: () => Effect.sync(() => ({ Items: [...rows.values()] })),
  } as never)
  return { rows, updates, layer, only: () => [...rows.values()][0]! }
}

type Memory = ReturnType<typeof memoryTable>

const onEntity = <A, E>(
  field: Schema.Top,
  body: (rows: any, memory: Memory) => Effect.Effect<A, E, any>,
) => {
  const Rows = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      f: field as never,
      n: Schema.optional(Schema.Number),
    }),
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never)
  const MainTable = Table.make({ schema: AppSchema, entities: { Rows } })
  const memory = memoryTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { MainTable } } as never)
    return yield* body(db.entities.Rows, memory)
  }).pipe(
    Effect.provide(Layer.merge(memory.layer, MainTable.layer({ name: "t" }))),
    Effect.scoped,
  ) as Effect.Effect<A, E, never>
}

const onAggregate = <A, E>(
  field: Schema.Top,
  body: (agg: any, memory: Memory) => Effect.Effect<A, E, any>,
) => {
  const Base = Table.make({ schema: AppSchema, entities: {} })
  const Root = (Aggregate.make as any)(
    Schema.Struct({ id: Schema.String, f: field as never, note: Schema.optional(Schema.String) }),
    {
      table: Base,
      schema: Base.schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "root" },
      root: { entityType: "Root" },
      edges: {},
    },
  )
  const MainTable = { ...Base, aggregates: { Root } }
  const memory = memoryTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({
      entities: {},
      aggregates: { Root },
      tables: { MainTable },
    } as never)
    return yield* body(db.aggregates.Root, memory)
  }).pipe(
    Effect.provide(Layer.merge(memory.layer, Base.layer({ name: "t" }))),
    Effect.scoped,
  ) as Effect.Effect<A, E, never>
}

/** Which attribute a date is stored as, and what it reads back as, by member order and owner. */
const STORED: ReadonlyArray<
  readonly [name: string, field: Schema.Top, value: unknown, stored: unknown, read?: unknown]
> = [
  ["a date after a string", K(Schema.String, Schema.DateTimeUtc), instant, INTERNAL],
  ["a date after a number", K(Schema.Number, Schema.DateTimeUtc), instant, INTERNAL],
  ["a date between two", K(Schema.String, Schema.DateTimeUtc, Schema.Number), instant, INTERNAL],
  ["a date before a string", K(Schema.DateTimeUtc, Schema.String), instant, { S: ISO }],
  ["a date before a number", K(Schema.DateTimeUtc, Schema.Number), instant, { S: ISO }],
  ["a date before null", K(Schema.DateTimeUtc, Schema.Null), instant, { S: ISO }],
  ["a string after a date", K(Schema.DateTimeUtc, Schema.String), "x", { S: "x" }],
  ["a string before a date", K(Schema.String, Schema.DateTimeUtc), "x", { S: "x" }],
  ["null after a date", K(Schema.DateTimeUtc, Schema.Null), null, { NULL: true }],
  ["a number after a date", K(Schema.DateTimeUtc, Schema.Number), 5, { N: "5" }],
  [
    "a list of dates after a string",
    K(Schema.String, Schema.Array(Schema.DateTimeUtc)),
    [instant],
    { L: [INTERNAL] },
  ],
  [
    "a list of dates before a string",
    K(Schema.Array(Schema.DateTimeUtc), Schema.String),
    [instant],
    { L: [{ S: ISO }] },
  ],
  [
    "a struct holding a date after a string",
    K(Schema.String, Schema.Struct({ d: Schema.DateTimeUtc })),
    { d: instant },
    { M: { d: INTERNAL } },
  ],
  [
    "a struct holding a date before a string",
    K(Schema.Struct({ d: Schema.DateTimeUtc }), Schema.String),
    { d: instant },
    { M: { d: { S: ISO } } },
  ],
  [
    "a nested optional union, the date later",
    Schema.Struct({ a: K(Schema.String, Schema.DateTimeUtc) }),
    { a: instant },
    { M: { a: INTERNAL } },
  ],
  [
    "a nested optional union, the date first",
    Schema.Struct({ a: K(Schema.DateTimeUtc, Schema.String) }),
    { a: instant },
    { M: { a: { S: ISO } } },
  ],
  [
    "a list of dates after a date",
    K(Schema.DateTimeUtc, Schema.Array(Schema.DateTimeUtc)),
    [instant],
    { L: [INTERNAL] },
  ],
  [
    "a struct holding a date after a date",
    K(Schema.DateTimeUtc, Schema.Struct({ d: Schema.DateTimeUtc })),
    { d: instant },
    { M: { d: INTERNAL } },
  ],
  ["a date from a string, later", K(Schema.Number, Schema.DateFromString), when, { S: ISO }],
  ["a date from a string, first", K(Schema.DateFromString, Schema.Number), when, { S: ISO }],
  ["a Date first", K(Schema.Date, Schema.String), when, { S: ISO }],
  ["a bigint first", K(Schema.BigInt, Schema.String), 5n, { N: "5" }],
  ["a bigint later", K(Schema.String, Schema.BigInt), 5n, { N: "5" }],
]

/** A read back, by what it is: a `DateTime` holds more than `toEqual` looks at. */
const expectValue = (read: unknown, value: unknown) => {
  if (DateTime.isDateTime(value)) expect(Equal.equals(read, value)).toBe(true)
  else expect(read).toEqual(value)
}

describe("Schema.optionalKey over a union, stored", () => {
  for (const [name, field, value, stored] of STORED) {
    it.effect(`${name}, on an entity: put, read back, an update of something else`, () =>
      onEntity(field, (rows, memory) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: value }).asEffect()
          expect(memory.only().f).toEqual(stored)
          expectValue((yield* rows.get({ id: "a" })).f, value)
          yield* rows.update({ id: "a" }).set({ n: 1 }).asEffect()
          expect(Object.values(memory.updates[0]?.ExpressionAttributeNames ?? {})).not.toContain(
            "f",
          )
        }),
      ),
    )

    it.effect(`${name}, on an entity: set`, () =>
      onEntity(field, (rows, memory) =>
        Effect.gen(function* () {
          yield* rows.update({ id: "a" }).set({ f: value }).asEffect().pipe(Effect.exit)
          const values = Object.values(memory.updates[0]?.ExpressionAttributeValues ?? {})
          // A null on `set` removes the attribute.
          if (value === null) expect(memory.updates[0]?.UpdateExpression).toContain("REMOVE")
          else expect(values).toContainEqual(stored)
        }),
      ),
    )

    it.effect(`${name}, on an aggregate: create, read back, update`, () =>
      onAggregate(field, (agg, memory) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: value })
          expect(memory.only().f).toEqual(stored)
          expectValue((yield* agg.get({ id: "a" })).f, value)
          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          expect(memory.only().f).toEqual(stored)
          expect(memory.only().note).toEqual({ S: "n" })
          expectValue((yield* agg.get({ id: "a" })).f, value)
        }),
      ),
    )
  }

  it.effect("an explicit undefined is taken where the first member is substituted", () =>
    onEntity(K(Schema.DateTimeUtc, Schema.String), (rows, memory) =>
      Effect.gen(function* () {
        yield* rows.put({ id: "a", f: undefined }).asEffect()
        expect(memory.only().f).toBeUndefined()
      }),
    ),
  )

  it.effect("an explicit undefined is refused where the first member isn't substituted", () =>
    onEntity(K(Schema.String, Schema.DateTimeUtc), (rows, memory) =>
      Effect.gen(function* () {
        const failure = yield* rows.put({ id: "a", f: undefined }).asEffect().pipe(Effect.flip)
        expect(failure._tag).toBe("ValidationError")
        expect(memory.rows.size).toBe(0)
      }),
    ),
  )

  it.effect("an explicit encoding on an aggregate's own date is what's stored", () =>
    onAggregate(
      Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
      (agg, memory) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: instant })
          expect(memory.only().f).toEqual({ N: String(when.getTime()) })
        }),
    ),
  )
})

describe("Schema.optionalKey over a union, read", () => {
  const READS: ReadonlyArray<
    readonly [name: string, field: Schema.Top, stored: unknown, read: (value: unknown) => void]
  > = [
    [
      "the text of a date under a first string is that text",
      K(Schema.String, Schema.DateTimeUtc),
      { S: ISO },
      (value) => expect(value).toBe(ISO),
    ],
    [
      "the text of a date under a first Date is that date",
      K(Schema.Date, Schema.String),
      { S: ISO },
      (value) => expect(value).toEqual(when),
    ],
    [
      "the text of a date under a first DateTime is that date",
      K(Schema.DateTimeUtc, Schema.String),
      { S: ISO },
      (value) => expect(Equal.equals(value, instant)).toBe(true),
    ],
    [
      "other text under a first DateTime is that text",
      K(Schema.DateTimeUtc, Schema.String),
      { S: "2025-01-01" },
      (value) => expect(value).toBe("2025-01-01"),
    ],
    [
      "the internal form under a later DateTime is that date",
      K(Schema.String, Schema.DateTimeUtc),
      INTERNAL,
      (value) => expect(Equal.equals(value, instant)).toBe(true),
    ],
    [
      "a number under a first DateTime is that number, with a later number member",
      K(Schema.DateTimeUtc, Schema.Number),
      { N: "5" },
      (value) => expect(value).toBe(5),
    ],
    [
      "a number under a first bigint is that bigint, whatever comes later",
      K(Schema.BigInt, Schema.Number),
      { N: "5" },
      (value) => expect(value).toBe(5n),
    ],
    [
      "a number that isn't a whole one under a first bigint is that number",
      K(Schema.BigInt, Schema.Number),
      { N: "5.5" },
      (value) => expect(value).toBe(5.5),
    ],
    [
      "a number under a later bigint, with a number after it, is that number",
      K(Schema.String, Schema.BigInt, Schema.Number),
      { N: "5" },
      (value) => expect(value).toBe(5),
    ],
    [
      "a number under a later bigint, with a number after it and null first, is that number",
      K(Schema.Null, Schema.BigInt, Schema.Number),
      { N: "5" },
      (value) => expect(value).toBe(5),
    ],
    [
      "a number under a later bigint, after a number, is that number",
      K(Schema.Number, Schema.BigInt),
      { N: "5" },
      (value) => expect(value).toBe(5),
    ],
    [
      "a number under a later bigint, after a string, is that bigint",
      K(Schema.String, Schema.BigInt),
      { N: "5" },
      (value) => expect(value).toBe(5n),
    ],
  ]
  for (const [name, field, stored, check] of READS) {
    it.effect(`${name}, on an entity`, () =>
      onEntity(field, (rows, memory) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a" }).asEffect()
          memory.only().f = stored
          check((yield* rows.get({ id: "a" })).f)
        }),
      ),
    )
    it.effect(`${name}, on an aggregate`, () =>
      onAggregate(field, (agg, memory) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a" })
          memory.only().f = stored
          check((yield* agg.get({ id: "a" })).f)
        }),
      ),
    )
  }

  it.effect("an aggregate reads what it stores for a first date transform: its date encoding", () =>
    Effect.gen(function* () {
      for (const field of [
        K(Schema.DateFromMillis, Schema.Null),
        K(Schema.DateFromMillis, Schema.Number),
        K(Schema.DateFromMillis, Schema.String),
      ]) {
        yield* onAggregate(field, (agg, memory) =>
          Effect.gen(function* () {
            yield* agg.create({ id: "a", f: when })
            expect(memory.only().f).toEqual({ S: ISO })
            expect((yield* agg.get({ id: "a" })).f).toEqual(when)
            yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
            expect(memory.only().f).toEqual({ S: ISO })
          }),
        )
      }
    }),
  )

  const EPOCH = Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs))
  for (const [name, field, value] of [
    ["optionalKey(Null, DateTimeUtc storedAs)", K(Schema.Null, EPOCH), instant],
    ["NullOr(DateTimeUtc storedAs)", Schema.NullOr(EPOCH), instant],
    ["optionalKey(Null, DateEpochMs)", K(Schema.Null, DynamoModel.DateEpochMs), instant],
    ["NullOr(DateEpochMs)", Schema.NullOr(DynamoModel.DateEpochMs), instant],
    ["optionalKey(Null, DateFromMillis)", K(Schema.Null, Schema.DateFromMillis), when],
    ["NullOr(DateFromMillis)", Schema.NullOr(Schema.DateFromMillis), when],
  ] as const) {
    it.effect(`an aggregate reads what its date encoder stores under ${name}`, () =>
      onAggregate(field, (agg, memory) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: value })
          expect(memory.only().f).toEqual({ S: ISO })
          expectValue((yield* agg.get({ id: "a" })).f, value)
          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          expect(memory.only().f).toEqual({ S: ISO })
          expectValue((yield* agg.get({ id: "a" })).f, value)
          yield* agg.create({ id: "a", f: null })
          expect(memory.only().f).toEqual({ NULL: true })
          expect((yield* agg.get({ id: "a" })).f).toBe(null)
        }),
      ),
    )
  }

  for (const [name, field, value, read] of [
    ["a Date under DateTimeUtc first", K(Schema.DateTimeUtc, Schema.DateFromString), when, instant],
    [
      "a Date under DateEpochMs first",
      K(DynamoModel.DateEpochMs, Schema.DateFromMillis),
      when,
      instant,
    ],
    [
      "a DateTime under Date first",
      K(Schema.DateFromString, Schema.DateTimeUtcFromString),
      instant,
      when,
    ],
    [
      "a DateTime under Date first, a plain union",
      Schema.Union([Schema.DateFromMillis, DynamoModel.DateEpochMs]),
      instant,
      when,
    ],
    [
      "a Date under DateTime first, a plain union",
      Schema.Union([DynamoModel.DateEpochMs, Schema.DateFromMillis]),
      when,
      instant,
    ],
    [
      "a Date in a plain union of self dates",
      Schema.Union([Schema.DateTimeUtc, Schema.Date]),
      when,
      instant,
    ],
  ] as const) {
    it.effect(
      `two kinds of date on an aggregate: ${name} is stored as text, and reads as the first`,
      () =>
        onAggregate(field, (agg, memory) =>
          Effect.gen(function* () {
            yield* agg.create({ id: "a", f: value })
            expect(memory.only().f).toEqual({ S: ISO })
            expectValue((yield* agg.get({ id: "a" })).f, read)
            yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
            expect(memory.only().f).toEqual({ S: ISO })
          }),
        ),
    )
  }

  it.effect(
    "a Zoned value under a first DateTimeUtc on an aggregate is stored in its own form",
    () =>
      onAggregate(K(Schema.DateTimeUtc, Schema.DateTimeZoned), (agg, memory) =>
        Effect.gen(function* () {
          yield* agg.create({
            id: "a",
            f: DateTime.makeZonedUnsafe(ISO, { timeZone: "Asia/Tokyo" }),
          })
          expect(memory.only().f).toEqual({ S: "2025-01-01T09:00:00.000+09:00[Asia/Tokyo]" })
        }),
      ),
  )

  for (const [name, field] of [
    ["UndefinedOr(DateEpochMs)", Schema.UndefinedOr(DynamoModel.DateEpochMs)],
    ["UndefinedOr(DateTimeUtc storedAs)", Schema.UndefinedOr(EPOCH)],
  ] as const) {
    it.effect(`an aggregate reads what its date encoder stores under ${name}`, () =>
      onAggregate(field, (agg, memory) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: instant })
          expect(memory.only().f).toEqual({ S: ISO })
          expectValue((yield* agg.get({ id: "a" })).f, instant)
        }),
      ),
    )
  }

  for (const [name, field, stored, read] of [
    [
      "the text of a date under a date transform and a string",
      Schema.Union([Schema.DateFromMillis, Schema.String]),
      { S: ISO },
      ISO,
    ],
    [
      "other text under a first date transform",
      K(Schema.DateFromMillis, Schema.String),
      { S: "2025-01-01" },
      "2025-01-01",
    ],
    [
      "a number under a first date from a string",
      K(Schema.DateFromString, Schema.Number),
      { N: "5" },
      5,
    ],
  ] as const) {
    it.effect(`${name} isn't taken for the date, on an aggregate`, () =>
      onAggregate(field, (agg, memory) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: read })
          memory.only().f = stored
          expect((yield* agg.get({ id: "a" })).f).toEqual(read)
        }),
      ),
    )
  }

  it.effect("the text of a date under a later date transform isn't taken for it", () =>
    onAggregate(K(Schema.Number, Schema.DateFromMillis), (agg, memory) =>
      Effect.gen(function* () {
        yield* agg.create({ id: "a" })
        memory.only().f = { S: ISO }
        const failure = yield* Effect.flip(agg.get({ id: "a" }))
        expect(failure).toBeDefined()
      }),
    ),
  )

  it.effect("the text of a date under a first date transform is text on an entity", () =>
    onEntity(K(Schema.DateFromMillis, Schema.String, Schema.DateTimeUtc), (rows, memory) =>
      Effect.gen(function* () {
        yield* rows.put({ id: "a" }).asEffect()
        memory.only().f = { S: ISO }
        expect((yield* rows.get({ id: "a" })).f).toBe(ISO)
      }),
    ),
  )

  it.effect("a value that's no kind of date a union holds is still refused", () =>
    onAggregate(Schema.Union([Schema.DateFromMillis, DynamoModel.DateEpochMs]), (agg, memory) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(agg.create({ id: "a", f: "not a date" }))
        expect(exit._tag).toBe("Failure")
        expect(memory.rows.size).toBe(0)
      }),
    ),
  )

  it.effect("a date's own stored form still reads under a union beside null", () =>
    onAggregate(Schema.Struct({ d: Schema.NullOr(EPOCH) }), (agg, memory) =>
      Effect.gen(function* () {
        yield* agg.create({ id: "a", f: { d: instant } })
        expect(memory.only().f).toEqual({ M: { d: { N: String(when.getTime()) } } })
        expectValue((yield* agg.get({ id: "a" })).f.d, instant)
      }),
    ),
  )

  it.effect("a first member's row in a struct still reads, in its date encoding", () =>
    onAggregate(K(Schema.Struct({ d: Schema.DateFromMillis }), Schema.String), (agg, memory) =>
      Effect.gen(function* () {
        yield* agg.create({ id: "a", f: { d: when } })
        expect(memory.only().f).toEqual({ M: { d: { S: ISO } } })
        expect((yield* agg.get({ id: "a" })).f).toEqual({ d: when })
      }),
    ),
  )

  it.effect("an aggregate's update keeps a list where a later member is a list", () =>
    onAggregate(K(Schema.ReadonlySet(Schema.String), Schema.Array(Schema.String)), (agg, memory) =>
      Effect.gen(function* () {
        yield* agg.create({ id: "a", f: ["a"] })
        expect(memory.only().f).toEqual({ L: [{ S: "a" }] })
        yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
        expect(memory.only().f).toEqual({ L: [{ S: "a" }] })
      }),
    ),
  )

  it.effect("an aggregate's update still hands back a set no later member takes", () =>
    onAggregate(K(Schema.String, Schema.ReadonlySet(Schema.String)), (agg, memory) =>
      Effect.gen(function* () {
        yield* agg.create({ id: "a", f: new Set(["a"]) })
        expect(memory.only().f).toEqual({ SS: ["a"] })
        yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
        expect(memory.only().f).toEqual({ SS: ["a"] })
      }),
    ),
  )
})

describe("Schema.optionalKey over a union, a path write", () => {
  const pathValue = (memory: Memory) =>
    Object.values(memory.updates[0]?.ExpressionAttributeValues ?? {})
  const NEXT = {
    M: {
      epochMilliseconds: { N: String(DateTime.toEpochMillis(later)) },
      "~effect/DateTime": { S: "~effect/DateTime" },
      _tag: { S: "Utc" },
    },
  }
  const NEXT_ISO = { S: "2026-02-02T00:00:00.000Z" }
  const PATHS: ReadonlyArray<
    readonly [
      name: string,
      field: Schema.Top,
      segments: ReadonlyArray<string | number>,
      at: unknown,
    ]
  > = [
    [
      "into a later struct is as declared",
      K(Schema.String, Schema.Struct({ d: Schema.DateTimeUtc })),
      ["f", "d"],
      NEXT,
    ],
    [
      "into a first struct is its stored form",
      K(Schema.Struct({ d: Schema.DateTimeUtc }), Schema.String),
      ["f", "d"],
      NEXT_ISO,
    ],
    [
      "into a later list is as declared",
      K(Schema.String, Schema.Array(Schema.DateTimeUtc)),
      ["f", 0],
      NEXT,
    ],
    [
      "into a first list is its stored form",
      K(Schema.Array(Schema.DateTimeUtc), Schema.String),
      ["f", 0],
      NEXT_ISO,
    ],
    [
      "into a second struct, past the first, is as declared",
      K(Schema.Struct({ d: Schema.DateTimeUtc }), Schema.Struct({ e: Schema.DateTimeUtc })),
      ["f", "e"],
      NEXT,
    ],
    [
      "through two levels of a later struct is as declared",
      K(Schema.String, Schema.Struct({ o: Schema.Struct({ d: Schema.DateTimeUtc }) })),
      ["f", "o", "d"],
      NEXT,
    ],
  ]
  for (const [name, field, segments, stored] of PATHS) {
    it.effect(name, () =>
      onEntity(field, (rows, memory) =>
        Effect.gen(function* () {
          yield* rows
            .update({ id: "a" })
            .pathSet({ segments, value: later, isPath: false })
            .asEffect()
            .pipe(Effect.exit)
          expect(pathValue(memory)).toContainEqual(stored)
        }),
      ),
    )
  }

  it.effect("a later member that encodes itself is encoded: a date from a string", () =>
    onEntity(K(Schema.String, Schema.Struct({ d: Schema.DateFromString })), (rows, memory) =>
      Effect.gen(function* () {
        yield* rows
          .update({ id: "a" })
          .pathSet({ segments: ["f", "d"], value: when, isPath: false })
          .asEffect()
          .pipe(Effect.exit)
        expect(pathValue(memory)).toContainEqual({ S: ISO })
      }),
    ),
  )

  for (const [name, write] of [
    ["append", (u: any, value: unknown) => u.append({ f: value })],
    [
      "pathAppend",
      (u: any, value: unknown) => u.pathAppend({ segments: ["f"], value, isPath: false }),
    ],
    [
      "pathPrepend",
      (u: any, value: unknown) => u.pathPrepend({ segments: ["f"], value, isPath: false }),
    ],
  ] as const) {
    it.effect(`${name} onto a first list is its stored form`, () =>
      onEntity(K(Schema.Array(Schema.DateTimeUtc), Schema.String), (rows, memory) =>
        Effect.gen(function* () {
          yield* write(rows.update({ id: "a" }), [later])
            .asEffect()
            .pipe(Effect.exit)
          expect(pathValue(memory)).toContainEqual({ L: [NEXT_ISO] })
        }),
      ),
    )
    it.effect(`${name} onto a first list of a date transform is that transform's form`, () =>
      onEntity(K(Schema.Array(Schema.DateFromString), Schema.String), (rows, memory) =>
        Effect.gen(function* () {
          yield* write(rows.update({ id: "a" }), [when])
            .asEffect()
            .pipe(Effect.exit)
          expect(pathValue(memory)).toContainEqual({ L: [{ S: ISO }] })
        }),
      ),
    )
    it.effect(`${name} onto a later list of a date transform is that transform's form`, () =>
      onEntity(K(Schema.String, Schema.Array(Schema.DateFromString)), (rows, memory) =>
        Effect.gen(function* () {
          yield* write(rows.update({ id: "a" }), [when])
            .asEffect()
            .pipe(Effect.exit)
          expect(pathValue(memory)).toContainEqual({ L: [{ S: ISO }] })
        }),
      ),
    )
    it.effect(`${name} onto a later list is as declared`, () =>
      onEntity(K(Schema.String, Schema.Array(Schema.DateTimeUtc)), (rows, memory) =>
        Effect.gen(function* () {
          yield* write(rows.update({ id: "a" }), [later])
            .asEffect()
            .pipe(Effect.exit)
          expect(pathValue(memory)).toContainEqual({ L: [NEXT] })
        }),
      ),
    )
  }
})

describe("what's refused on the operational makes", () => {
  const entity = (field: Schema.Top) => () =>
    Entity.make({
      model: Schema.Struct({ id: Schema.String, f: field as never }),
      entityType: "E",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    } as never)

  it("a Schema.Date after a string: it would be stored as an empty map", () => {
    expect(entity(K(Schema.String, Schema.Date))).toThrow(
      /\[EDD-9125\].*field "f" is a Schema\.Date/,
    )
  })

  it("a Schema.Date before a string, and a DateTime after one: they read back", () => {
    expect(entity(K(Schema.Date, Schema.String))).not.toThrow()
    expect(entity(K(Schema.String, Schema.DateTimeUtc))).not.toThrow()
  })
})
