/**
 * An aggregate's dotted edge sort key composite under a transformation of what holds it (`EDD-9128`
 * at write). A `many` edge keyed by `nested.n`, where `nested` is a struct decoded to another
 * struct, composes its key from the domain value (`{ n: 5 }`, 16 digits) and stores the encoded one
 * (`{ n: 5n }`), which DynamoDB hands back as `{ n: 5 }` and the field decodes to `{ n: 5 }` again:
 * the key composed from the row as a read takes it is the key written. So the write is judged
 * through the field holding the value, never by the stored value at the path alone, which reads
 * back as the other kind. A parent whose decode keeps the kind DynamoDB hands back does move the key,
 * and is refused.
 *
 * The rows are what published 1.39.0 stored (`helpers/ReadBackKeys.ts`); connected twin:
 * `connected.read-back-keys.test.ts`.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Exit, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import {
  asGiven,
  byKey,
  dottedDefinitions,
  dottedParentRows,
  dottedShapes,
  type Row,
  toNumber,
} from "./helpers/ReadBackKeys.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const on = <A, E>(
  parent: Schema.Top,
  optional: boolean,
  deep: boolean,
  rows: ReadonlyArray<Row>,
  body: (aggregate: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, E, any>,
) => {
  const { Main, Roots } = dottedDefinitions(parent, optional, deep)
  const table = makeRecordingTable()
  for (const row of rows) table.items.set(`${row.pk.S}|${row.sk.S}`, structuredClone(row) as never)
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: {},
      aggregates: { Roots },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db.aggregates.Roots, table)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

const keysOf = (rows: ReadonlyArray<Row>) => rows.map((row) => `${row.pk.S}|${row.sk.S}`).sort()

describe("a dotted edge key under a transformed parent is judged through the parent", () => {
  for (const { optional, deep, shape, path, value, held } of dottedShapes) {
    const stored = dottedParentRows[shape]!

    it.effect(`${shape}: create, update and get store the rows 1.39.0 stored`, () =>
      on(toNumber, optional, deep, [], (aggregate, table) =>
        Effect.gen(function* () {
          yield* aggregate.create({ id: "x", lines: [{ nested: value, note: "before" }] })
          // The key composed from `{ n: 5 }`, and `{ n: 5n }` stored, as 1.39.0 stored them.
          expect(byKey([...table.items.values()] as never)).toEqual(byKey(stored))
          yield* aggregate.update({ id: "x" }, ({ state }: any) => ({
            ...state,
            lines: state.lines.map((line: any) => ({ ...line, note: "after" })),
          }))
          const got = yield* aggregate.get({ id: "x" })
          expect(got.lines).toEqual([{ nested: value, note: "after" }])
          // The edge row was rewritten where it was: no second row.
          expect([...table.items.keys()].sort()).toEqual(keysOf(stored))
        }),
      ),
    )

    it.effect(`${shape}: the rows 1.39.0 stored read and update`, () =>
      on(toNumber, optional, deep, stored, (aggregate, table) =>
        Effect.gen(function* () {
          expect((yield* aggregate.get({ id: "x" })).lines).toEqual([
            { nested: value, note: "before" },
          ])
          yield* aggregate.update({ id: "x" }, ({ state }: any) => ({
            ...state,
            lines: state.lines.map((line: any) => ({ ...line, note: "after" })),
          }))
          expect((yield* aggregate.get({ id: "x" })).lines).toEqual([
            { nested: value, note: "after" },
          ])
          expect([...table.items.keys()].sort()).toEqual(keysOf(stored))
        }),
      ),
    )

    it.effect(`${shape}: a parent that keeps the kind read back is refused`, () =>
      on(asGiven, optional, deep, [], (aggregate, table) =>
        Effect.gen(function* () {
          const created = yield* Effect.exit(
            aggregate
              .create({ id: "x", lines: [{ nested: held, note: "before" }] })
              .pipe(Effect.asVoid),
          )
          // `{ n: 5n }` keys 38 digits, and reads back `{ n: 5 }`, which keys 16.
          expect(Exit.isFailure(created)).toBe(true)
          const message = JSON.stringify(created)
          expect(message).toContain("EDD-9128")
          expect(message).toContain(`Field \\"${path}\\" of \\"lines\\"`)
          expect(message).toContain("the bigint 5n would read back as a number")
          expect(table.items.size).toBe(0)
        }),
      ),
    )
  }
})

// --- Each row judged by the edge it belongs to ------------------------------------------------

/** An aggregate of `edges`, its model `fields`, bound to a recording table seeded with `rows`. */
const onEdges = <A, E>(
  escapeKeys: boolean,
  fields: Record<string, Schema.Top>,
  edges: Record<string, unknown>,
  body: (aggregate: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, E, any>,
) => {
  const schema = DynamoSchema.make({ name: "edges", version: 1, escapeKeys })
  const Main = Table.make({ schema, entities: {} } as never) as any
  const Roots = (Aggregate.make as any)(Schema.Struct({ id: Schema.String, ...fields }), {
    table: Main,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "roots" },
    root: { entityType: "Root" },
    edges,
  })
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: {},
      aggregates: { Roots },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db.aggregates.Roots, table)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

describe("an edge's rows are judged by that edge's own sort key", () => {
  // Two sub-aggregates, told apart by `side`, each with a `Line` edge keyed by `nested.n`, a value
  // whose kind isn't declared: an ordinary number reads back as written. Their sort keys name the
  // composites in another order, or one fewer, so the left edge's `nested.n` isn't the right one's
  // first composite: judged against the other edge's key, it was refused.
  const line = Schema.Struct({
    nested: Schema.Struct({ n: Schema.Unknown }),
    rank: Schema.String,
    note: Schema.String,
  })
  const part = Schema.Struct({ lines: Schema.Array(line) })
  const layouts = {
    reversed: ["rank", "nested.n"],
    shorter: ["nested.n"],
  } as const
  for (const [layout, right] of Object.entries(layouts)) {
    for (const escapeKeys of [false, true]) {
      it.effect(`${layout}, escapeKeys ${escapeKeys}: create, update and get`, () => {
        const Left = (Aggregate.make as any)(part, {
          root: { entityType: "PartA" },
          edges: {
            lines: Aggregate.many({ entityType: "Line", sk: { composite: ["nested.n", "rank"] } }),
          },
        })
        const Right = (Aggregate.make as any)(part, {
          root: { entityType: "PartB" },
          edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: right } }) },
        })
        return onEdges(
          escapeKeys,
          { left: part, right: part },
          {
            left: Left.with({ discriminator: { side: "left" } }),
            right: Right.with({ discriminator: { side: "right" } }),
          },
          (aggregate, table) =>
            Effect.gen(function* () {
              yield* aggregate.create({
                id: "x",
                left: { lines: [{ nested: { n: 5 }, rank: "l", note: "before" }] },
                right: { lines: [{ nested: { n: 6 }, rank: "r", note: "before" }] },
              })
              const keys = [...table.items.keys()].sort()
              // Each edge's row keyed by its own composites, under either setting.
              expect(keys).toEqual([
                "$edges#v1#roots#x|$edges#v1#line#side#left#0000000000000005#l",
                layout === "reversed"
                  ? "$edges#v1#roots#x|$edges#v1#line#side#right#r#0000000000000006"
                  : "$edges#v1#roots#x|$edges#v1#line#side#right#0000000000000006",
                "$edges#v1#roots#x|$edges#v1#parta#side#left",
                "$edges#v1#roots#x|$edges#v1#partb#side#right",
                "$edges#v1#roots#x|$edges#v1#root",
              ])
              yield* aggregate.update({ id: "x" }, ({ state }: any) => ({
                ...state,
                left: { lines: state.left.lines.map((l: any) => ({ ...l, note: "after" })) },
              }))
              const got = yield* aggregate.get({ id: "x" })
              expect(got.left.lines).toEqual([{ nested: { n: 5 }, rank: "l", note: "after" }])
              expect(got.right.lines).toEqual([{ nested: { n: 6 }, rank: "r", note: "before" }])
              expect([...table.items.keys()].sort()).toEqual(keys)
            }),
        )
      })
    }
  }

  // Two edges of one entity type with no discriminator: assembly hands each `Line` row to both, so
  // each edge's own check judges it. `lines` decodes `nested.n` to a bigint, so its rows read back
  // as written; `others` keeps the number DynamoDB hands back, which keys other text.
  const toBigInt = Schema.Struct({ n: Schema.Unknown }).pipe(
    Schema.decodeTo(Schema.Struct({ n: Schema.Unknown }), {
      decode: SchemaGetter.transform((x: any) => ({ n: BigInt(x.n) })),
      encode: SchemaGetter.transform((x: any) => ({ n: x.n })),
    }),
  )
  const lines = Schema.Array(Schema.Struct({ nested: toBigInt, note: Schema.String }))
  const others = Schema.Array(
    Schema.Struct({ nested: Schema.Struct({ n: Schema.Unknown }), note: Schema.String }),
  )
  const byN = (entityType: string) =>
    Aggregate.many({ entityType, sk: { composite: ["nested.n"] } } as never)
  const value = { id: "x", lines: [{ nested: { n: 5n }, note: "before" }], others: [] }

  it.effect("a row two edges take is judged by each", () =>
    onEdges(
      false,
      { lines, others },
      { lines: byN("Line"), others: byN("Line") },
      (aggregate, table) =>
        Effect.gen(function* () {
          const created = yield* Effect.exit(aggregate.create(value).pipe(Effect.asVoid))
          expect(Exit.isFailure(created)).toBe(true)
          const message = JSON.stringify(created, (_, v) => (typeof v === "bigint" ? `${v}n` : v))
          expect(message).toContain("EDD-9128")
          expect(message).toContain(
            `Field \\"nested.n\\" of \\"lines\\" is composed into edge \\"others\\"'s sort key`,
          )
          expect(table.items.size).toBe(0)
        }),
    ),
  )

  it.effect("the same row, which no other edge takes, is written", () =>
    onEdges(
      false,
      { lines, others },
      { lines: byN("Line"), others: byN("Other") },
      (aggregate, table) =>
        Effect.gen(function* () {
          yield* aggregate.create(value)
          expect((yield* aggregate.get({ id: "x" })).lines).toEqual(value.lines)
          expect(table.items.size).toBe(2)
        }),
    ),
  )

  // `others` under an optional sub-aggregate: a read reaches it only through the sub-aggregate's
  // row (`assemblyWalk`). While the sub-aggregate is absent, no read hands `others` a row, so its
  // check judges none; once present, it takes every `Line` row, the root's among them.
  const Inner = (Aggregate.make as any)(Schema.Struct({ others }), {
    root: { entityType: "Inner" },
    edges: { others: byN("Line") },
  })
  const withPart = { lines, part: Schema.optionalKey(Schema.Struct({ others })) }
  for (const escapeKeys of [false, true]) {
    it.effect(`escapeKeys ${escapeKeys}: an edge under an absent sub-aggregate judges no row`, () =>
      onEdges(
        escapeKeys,
        withPart,
        { lines: byN("Line"), part: Inner.with({}) },
        (aggregate, table) =>
          Effect.gen(function* () {
            const absent = { id: "x", lines: [{ nested: { n: 5n }, note: "before" }] }
            yield* aggregate.create(absent)
            yield* aggregate.update({ id: "x" }, ({ state }: any) => ({
              ...state,
              lines: state.lines.map((line: any) => ({ ...line, note: "after" })),
            }))
            expect(yield* aggregate.get({ id: "x" })).toEqual({
              id: "x",
              lines: [{ nested: { n: 5n }, note: "after" }],
            })
            const rows = structuredClone([...table.items])
            expect(rows).toHaveLength(2)
            const present = yield* Effect.exit(
              aggregate
                .update({ id: "x" }, ({ state }: any) => ({ ...state, part: { others: [] } }))
                .pipe(Effect.asVoid),
            )
            expect(Exit.isFailure(present)).toBe(true)
            expect(JSON.stringify(present)).toContain(
              `Field \\"nested.n\\" of \\"lines\\" is composed into edge \\"others\\"'s sort key`,
            )
            expect([...table.items]).toEqual(rows)
          }),
      ),
    )
  }
})
