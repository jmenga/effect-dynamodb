/**
 * An object as an aggregate key composite (#242, `EDD-9162`), as for an entity: every object
 * nothing gives other text to composes `[object Object]`, so aggregates written with different
 * values shared one partition, one list key or one collection key. A write composing a key from one
 * is refused with nothing written: `create` (the partition key, the collection sort key, the list
 * keys, each row's discriminators) and `update` (all but the partition key, which it composes from
 * the key it's given, as a read does). A value the row read holds at the same position is the key
 * that row is stored under, so `update` keeps writing it there. `get`, `list` and `delete` compose
 * the text as they always did, so the rows published 1.40.0 wrote under it
 * (`fixtures/aggregate-object-keys-1.40.0.json`) are reached as they were.
 *
 * What 1.40.0 did, per shape (the fixture's `results`):
 * - partition key: `a` was written under `…#roots#[object object]`; creating `b` failed with
 *   `ConditionalCheckFailed`, and `get` given `b`'s value returned `a`;
 * - list partition or sort key: both were written under `…#rl#[object object]`, and a `list` given
 *   `a`'s value returned both;
 * - collection sort key: both were written with `[object object]` as that key;
 * - discriminator: both were written under `…#side#side#[object object]`, and neither read back
 *   (the row isn't matched to its sub-aggregate: `ValidationError`, missing key);
 * - a `many` element's sort key: already refused for any object (`AggregateDecompositionError`,
 *   "non-scalar"), as it still is;
 * - two sub-aggregate bindings whose object discriminators compose one sort key: already refused
 *   (`AggregateDecompositionError`), as it still is.
 *
 * No object with a `toString` of its own round-tripped as an aggregate key composite on 1.40.0: a
 * `Schema.Class`'s key form is its encoded struct, which composed `[object Object]` (refused now);
 * a class instance in a `Schema.Unknown` field reads back as a map and was refused with `EDD-9128`
 * (still is); a discriminator holding one composed its own text, and its rows didn't read back
 * (still so). A value with a key form (a number, a `Duration`) is untouched.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Data, Duration, Effect, Exit, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import {
  define,
  fixture,
  INTO,
  keyOf,
  outcome,
  type Row,
  SHAPES,
  Side,
  valueOf,
} from "./helpers/AggregateObjectKeys.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const tableOf = (rows: ReadonlyArray<Row> = []) => {
  const table = makeRecordingTable({
    indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" }, lsi1: { pk: "pk", sk: "lsi1sk" } },
  })
  for (const row of rows) {
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  }
  return table
}

const rowsOf = (table: ReturnType<typeof tableOf>) =>
  [...table.items.values()] as unknown as ReadonlyArray<Row>

/** An aggregate as {@link define} gives one. */
type Defined = { readonly Base: any; readonly Roots: any; readonly Main: any }

const run = <A>(
  defined: Defined,
  table: ReturnType<typeof tableOf>,
  body: (db: any) => Effect.Effect<A, unknown, any>,
) =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: {},
      aggregates: { Roots: defined.Roots },
      tables: { Main: defined.Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db)
  }).pipe(
    Effect.provide(defined.Base.layer({ name: "ao" })),
    Effect.provide(table.layer),
  ) as Effect.Effect<A, unknown>

const refusalOf = (exit: Exit.Exit<unknown, unknown>): string => {
  expect(Exit.isFailure(exit)).toBe(true)
  const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as ValidationError
  expect(error).toBeInstanceOf(ValidationError)
  return String(error.cause)
}

describe("the fixture is published 1.40.0's", () => {
  it("each shape's answers", () => {
    expect(fixture.generatedFrom).toBe("effect-dynamodb@1.40.0")
    const results = Object.fromEntries(
      SHAPES.map((shape) => [shape, fixture.shapes[shape].results]),
    )
    expect(results).toEqual({
      partitionKey: {
        createA: "ok",
        createB: "ConditionalCheckFailed",
        getA: { id: "a", f: { a: 1 } },
        getB: { id: "a", f: { a: 1 } },
      },
      listSortKey: {
        createA: "ok",
        createB: "ok",
        getA: { id: "a", f: { a: 1 } },
        getB: { id: "b", f: { a: 2 } },
        list: ["a", "b"],
      },
      listPartitionKey: {
        createA: "ok",
        createB: "ok",
        getA: { id: "a", f: { a: 1 } },
        getB: { id: "b", f: { a: 2 } },
        list: ["a", "b"],
      },
      collectionSortKey: {
        createA: "ok",
        createB: "ok",
        getA: { id: "a", f: { a: 1 } },
        getB: { id: "b", f: { a: 2 } },
      },
      discriminator: {
        createA: "ok",
        createB: "ok",
        getA: "ValidationError",
        getB: "ValidationError",
      },
    })
    const keys = SHAPES.flatMap((shape) =>
      fixture.shapes[shape].rows.map((row) =>
        [row.pk?.S, row.sk?.S, row.gsi1pk?.S, row.gsi1sk?.S, row.lsi1sk?.S]
          .filter((text) => text !== undefined)
          .join(" | "),
      ),
    )
    expect(keys).toEqual([
      "$ao#v1#roots#[object object] | $ao#v1#root",
      "$ao#v1#roots#a | $ao#v1#root | $ao#v1#rl | $ao#v1#rl#[object object]",
      "$ao#v1#roots#b | $ao#v1#root | $ao#v1#rl | $ao#v1#rl#[object object]",
      "$ao#v1#roots#a | $ao#v1#root | $ao#v1#rl#[object object] | $ao#v1#rl",
      "$ao#v1#roots#b | $ao#v1#root | $ao#v1#rl#[object object] | $ao#v1#rl",
      "$ao#v1#roots#a | $ao#v1#root | $ao#v1#roots#[object object]",
      "$ao#v1#roots#b | $ao#v1#root | $ao#v1#roots#[object object]",
      "$ao#v1#roots#a | $ao#v1#root",
      "$ao#v1#roots#a | $ao#v1#side#side#[object object]",
      "$ao#v1#roots#b | $ao#v1#root",
      "$ao#v1#roots#b | $ao#v1#side#side#[object object]",
    ])
  })
})

describe("[EDD-9162] create composing an aggregate key from an object is refused", () => {
  const VALUES: ReadonlyArray<readonly [string, () => unknown]> = [
    ["a map", () => ({ a: 1 })],
    [
      "a Data class",
      () => new (class Point extends Data.Class<{ readonly x: number }> {})({ x: 1 }),
    ],
  ]
  for (const shape of SHAPES) {
    for (const [name, make] of shape === "discriminator" ? [VALUES[0]!] : VALUES) {
      it.effect(`${shape}, ${name}`, () =>
        Effect.gen(function* () {
          const table = tableOf()
          const defined =
            shape === "discriminator" ? define(shape, { discriminator: make() }) : define(shape)
          const value = {
            ...valueOf(shape, "a"),
            ...(shape === "discriminator" ? {} : { f: make() }),
          }
          const said = refusalOf(
            yield* run(defined, table, (db) => Effect.exit(db.aggregates.Roots.create(value))),
          )
          expect(said).toContain(INTO[shape])
          expect(said).toContain('composes the key text "[object Object]"')
          expect(said).toContain("[EDD-9162]")
          expect(table.items.size).toBe(0)
        }),
      )
    }
  }

  it.effect("a Schema.Class with a toString of its own, whose key form is its encoded struct", () =>
    Effect.gen(function* () {
      class Tagged extends Schema.Class<Tagged>("Tagged")({ name: Schema.String }) {
        override toString() {
          return `tagged:${this.name}`
        }
      }
      const table = tableOf()
      const defined = define("listSortKey", { field: Tagged })
      const said = refusalOf(
        yield* run(defined, table, (db) =>
          Effect.exit(
            db.aggregates.Roots.create({ id: "a", f: new Tagged({ name: "x" }), note: "one" }),
          ),
        ),
      )
      expect(said).toContain(INTO.listSortKey)
      expect(table.items.size).toBe(0)
    }),
  )
})

describe("rows 1.40.0 wrote under [object object]: reads, updates and deletes as before", () => {
  for (const shape of SHAPES) {
    it.effect(`${shape}: get and list answer as 1.40.0 did`, () =>
      Effect.gen(function* () {
        const { results, rows } = fixture.shapes[shape]
        const table = tableOf(rows)
        yield* run(define(shape), table, (db) =>
          Effect.gen(function* () {
            for (const id of ["a", "b"] as const) {
              const got: Exit.Exit<any, unknown> = yield* Effect.exit(
                db.aggregates.Roots.get(keyOf(shape, id)),
              )
              expect(
                Exit.isSuccess(got) ? { id: got.value.id, f: got.value.f } : outcome(got),
              ).toEqual(results[`get${id.toUpperCase()}`])
            }
            if (results.list !== undefined) {
              const listed = yield* db.aggregates.Roots.list(
                shape === "listPartitionKey" ? { f: { a: 1 } } : {},
              )
              expect(listed.data.map((x: { id: string }) => x.id).sort()).toEqual(results.list)
            }
          }),
        )
        expect(rowsOf(table)).toEqual(rows)
      }),
    )
  }

  for (const shape of SHAPES.filter((s) => s !== "discriminator")) {
    it.effect(`${shape}: an update leaving f as read writes it where it is`, () =>
      Effect.gen(function* () {
        const { rows } = fixture.shapes[shape]
        const table = tableOf(rows)
        yield* run(define(shape), table, (db) =>
          db.aggregates.Roots.update(keyOf(shape, "a"), ({ state }: any) => ({
            ...state,
            // An equal value, not the one read: a value is compared, not its identity.
            f: structuredClone(state.f),
            note: "two",
          })),
        )
        const expected = rows.map((row) =>
          row.id?.S === "a" ? { ...row, note: { S: "two" } } : row,
        )
        expect(rowsOf(table)).toEqual(expected)
      }),
    )
  }

  for (const shape of ["listSortKey", "listPartitionKey", "collectionSortKey"] as const) {
    it.effect(`${shape}: an update giving f another object is refused`, () =>
      Effect.gen(function* () {
        const { rows } = fixture.shapes[shape]
        const table = tableOf(rows)
        const exit = yield* run(define(shape), table, (db) =>
          Effect.exit(
            db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              f: { a: 3 },
            })),
          ),
        )
        const said = refusalOf(exit)
        expect(said).toContain(INTO[shape])
        expect(said).toContain("[EDD-9162]")
        expect(rowsOf(table)).toEqual(rows)
      }),
    )

    it.effect(`${shape}: an update giving f text moves the key to it`, () =>
      Effect.gen(function* () {
        const { rows } = fixture.shapes[shape]
        const table = tableOf(rows)
        yield* run(define(shape), table, (db) =>
          db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({ ...state, f: "text" })),
        )
        const a = rowsOf(table).find((row) => row.id?.S === "a")!
        expect(JSON.stringify(a)).toContain("#text")
        expect(JSON.stringify(a)).not.toContain("[object object]")
      }),
    )
  }

  it.effect(
    "partitionKey: an update is written under the key it's given, as a read composes it",
    () =>
      Effect.gen(function* () {
        const { rows } = fixture.shapes.partitionKey
        const table = tableOf(rows)
        // `b`'s value composes `a`'s key, as it did on 1.40.0: the update reaches `a`.
        yield* run(define("partitionKey"), table, (db) =>
          db.aggregates.Roots.update({ f: { a: 2 } }, ({ state }: any) => ({
            ...state,
            note: "two",
          })),
        )
        expect(rowsOf(table)).toEqual(rows.map((row) => ({ ...row, note: { S: "two" } })))
      }),
  )

  it.effect("discriminator: an update fails as 1.40.0's did, the rows unread", () =>
    Effect.gen(function* () {
      const { rows } = fixture.shapes.discriminator
      const table = tableOf(rows)
      const exit = yield* run(define("discriminator"), table, (db) =>
        Effect.exit(
          db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "two" })),
        ),
      )
      expect(outcome(exit)).toBe("ValidationError")
      expect(refusalOf(exit)).not.toContain("EDD-9162")
      expect(rowsOf(table)).toEqual(rows)
    }),
  )

  for (const shape of SHAPES) {
    it.effect(`${shape}: delete removes the rows it reads, as before`, () =>
      Effect.gen(function* () {
        const { rows } = fixture.shapes[shape]
        const table = tableOf(rows)
        yield* run(define(shape), table, (db) => db.aggregates.Roots.delete(keyOf(shape, "a")))
        expect(rowsOf(table)).toEqual(
          shape === "partitionKey" ? [] : rows.filter((row) => row.pk?.S !== "$ao#v1#roots#a"),
        )
      }),
    )
  }
})

describe("shapes 1.40.0 refused, refused as they were", () => {
  it.effect("a many element's sort key holding an object", () =>
    Effect.gen(function* () {
      const schema = DynamoSchema.make({ name: "ao", version: 1 })
      const Dummy = Entity.make({
        model: Schema.Struct({ id: Schema.String }),
        entityType: "Dummy",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      })
      const Base = Table.make({ schema, entities: { Dummy } })
      const Roots = Aggregate.make(
        Schema.Struct({
          id: Schema.String,
          leaves: Schema.Array(Schema.Struct({ lid: Schema.String, f: Schema.Unknown })),
        }),
        {
          table: Base,
          schema,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "roots" },
          root: { entityType: "Root" },
          edges: { leaves: Aggregate.many({ entityType: "Leaf", sk: { composite: ["f"] } }) },
        } as never,
      )
      const table = tableOf()
      const exit = yield* run(
        { Base, Roots, Main: { ...Base, aggregates: { Roots } } },
        table,
        (db) =>
          Effect.exit(db.aggregates.Roots.create({ id: "a", leaves: [{ lid: "l", f: { a: 1 } }] })),
      )
      expect(outcome(exit)).toBe("AggregateDecompositionError")
      expect(
        JSON.stringify(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)),
      ).toContain("non-scalar")
      expect(table.items.size).toBe(0)
    }),
  )

  it.effect("two bindings whose object discriminators compose one sort key", () =>
    Effect.gen(function* () {
      const schema = DynamoSchema.make({ name: "ao", version: 1 })
      const Dummy = Entity.make({
        model: Schema.Struct({ id: Schema.String }),
        entityType: "Dummy",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      })
      const Base = Table.make({ schema, entities: { Dummy } })
      const Roots = Aggregate.make(
        Schema.Struct({
          id: Schema.String,
          one: Schema.Struct({ s: Schema.String }),
          two: Schema.Struct({ s: Schema.String }),
        }),
        {
          table: Base,
          schema,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "roots" },
          root: { entityType: "Root" },
          edges: {
            one: Side.with({ discriminator: { side: { a: 1 } } }),
            two: Side.with({ discriminator: { side: { a: 2 } } }),
          },
        } as never,
      )
      const table = tableOf()
      const exit = yield* run(
        { Base, Roots, Main: { ...Base, aggregates: { Roots } } },
        table,
        (db) =>
          Effect.exit(db.aggregates.Roots.create({ id: "a", one: { s: "x" }, two: { s: "y" } })),
      )
      expect(outcome(exit)).toBe("AggregateDecompositionError")
      expect(table.items.size).toBe(0)
    }),
  )

  it.effect("a class instance with its own toString in a Schema.Unknown key composite", () =>
    Effect.gen(function* () {
      class Named {
        constructor(readonly name: string) {}
        toString() {
          return `named:${this.name}`
        }
      }
      const table = tableOf()
      const said = refusalOf(
        yield* run(define("listSortKey"), table, (db) =>
          Effect.exit(db.aggregates.Roots.create({ id: "a", f: new Named("x"), note: "one" })),
        ),
      )
      expect(said).toContain("would read back as something else")
      expect(said).not.toContain("EDD-9162")
      expect(table.items.size).toBe(0)
    }),
  )
})

describe("a value with key text of its own is untouched", () => {
  it.effect("a number discriminator", () =>
    Effect.gen(function* () {
      const table = tableOf()
      const defined = define("discriminator", { discriminator: 1 })
      yield* run(defined, table, (db) =>
        Effect.gen(function* () {
          yield* db.aggregates.Roots.create(valueOf("discriminator", "a"))
          const got = yield* db.aggregates.Roots.get({ id: "a" })
          expect(got.side).toEqual({ s: "s" })
        }),
      )
      expect(rowsOf(table).map((row) => row.sk?.S)).toContain("$ao#v1#side#side#0000000000000001")
    }),
  )

  it.effect("a discriminator with a toString of its own composes its text, as on 1.40.0", () =>
    Effect.gen(function* () {
      class Named {
        constructor(readonly name: string) {}
        toString() {
          return `named:${this.name}`
        }
      }
      const table = tableOf()
      const defined = define("discriminator", { discriminator: new Named("p") })
      yield* run(defined, table, (db) => db.aggregates.Roots.create(valueOf("discriminator", "a")))
      expect(rowsOf(table).map((row) => row.sk?.S)).toContain("$ao#v1#side#side#named:p")
    }),
  )

  it.effect("a Duration list sort key, which composes its own text and round-trips", () =>
    Effect.gen(function* () {
      const table = tableOf()
      const defined = define("listSortKey", { field: Schema.Duration })
      yield* run(defined, table, (db) =>
        Effect.gen(function* () {
          yield* db.aggregates.Roots.create({ id: "a", f: Duration.millis(1500), note: "one" })
          yield* db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
            ...state,
            note: "two",
          }))
          const got = yield* db.aggregates.Roots.get({ id: "a" })
          expect(Duration.toMillis(got.f)).toBe(1500)
        }),
      )
      expect(rowsOf(table)[0]?.gsi1sk).toEqual({ S: "$ao#v1#rl#1500 millis" })
    }),
  )
})

describe("a key the write doesn't compose refuses nothing, as 1.40.0 stored it", () => {
  // The list keys are sparse: `missing` absent, neither is composed, whatever `f` holds. 1.40.0
  // stored the aggregate without list keys; so do `create` and `update`.
  const schema = DynamoSchema.make({ name: "ao", version: 1, escapeKeys: false })
  const Dummy = Entity.make({
    model: Schema.Struct({ id: Schema.String }),
    entityType: "Dummy",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const Base = Table.make({ schema, entities: { Dummy } })
  const Roots = Aggregate.make(
    Schema.Struct({
      id: Schema.String,
      f: Schema.Unknown,
      missing: Schema.optional(Schema.String),
      note: Schema.String,
    }),
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "roots" },
      list: {
        index: "gsi1",
        name: "rl",
        pk: { field: "gsi1pk", composite: ["missing"] },
        sk: { field: "gsi1sk", composite: ["f"] },
      },
      root: { entityType: "Root" },
      edges: {},
    } as never,
  )
  const defined = { Base, Roots, Main: { ...Base, aggregates: { Roots } } }

  it.effect("create and update store the object, with no list keys", () =>
    Effect.gen(function* () {
      const table = tableOf()
      yield* run(defined, table, (db) =>
        Effect.gen(function* () {
          yield* db.aggregates.Roots.create({ id: "a", f: { a: 1 }, note: "one" })
          yield* db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
            ...state,
            f: { a: 2 },
          }))
        }),
      )
      const [row] = rowsOf(table)
      expect(rowsOf(table)).toHaveLength(1)
      expect(row?.f).toEqual({ M: { a: { N: "2" } } })
      expect(row).not.toHaveProperty("gsi1pk")
      expect(row).not.toHaveProperty("gsi1sk")
    }),
  )
})
