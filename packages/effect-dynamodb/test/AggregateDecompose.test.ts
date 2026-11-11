/**
 * What a `many` edge's custom `decompose` is handed, with a client that keeps what's written.
 *
 * A write's value is taken as the domain value a caller holds, but a custom `decompose` is handed it
 * as 1.39.0 handed it: read stored form first. That only changes a transformation with one type on
 * both sides: on a field that multiplies by 10 on decode, `create(50)` hands `decompose` 500. A
 * `decompose` returning the stored form (`f / 10`) then stores 5 under the key text 50 and reads 50,
 * exactly as on 1.39.0, and an update leaves the row where it is. Update's old state is handed as it
 * was read, as on 1.39.0. Anything else is handed as it is.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { AppSchema } from "./helpers/CustomDeclarationPaths.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

type Row = Record<string, AttributeValue>

const X10 = Schema.Number.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((value) => value * 10),
    encode: SchemaGetter.transform((value) => value / 10),
  }),
)

/** What each `decompose` was handed, by edge. */
const handed: Record<string, Array<unknown>> = {}
const recording =
  (edge: string, map: (line: Record<string, unknown>) => Record<string, unknown>) =>
  (value: unknown) => {
    const seen = handed[edge] ?? []
    seen.push(value)
    handed[edge] = seen
    return (value as ReadonlyArray<Record<string, unknown>>).map(map)
  }

const Line = Schema.Struct({ lineId: Schema.String, f: X10, note: Schema.optional(Schema.String) })
const Counted = Schema.Struct({ lineId: Schema.String, f: Schema.NumberFromString })
const Plain = Schema.Struct({ lineId: Schema.String, f: Schema.Number })
const Order = Schema.Struct({
  id: Schema.String,
  lines: Schema.Array(Line),
  kept: Schema.Array(Line),
  counted: Schema.Array(Counted),
  plain: Schema.Array(Plain),
})

const Base = Table.make({ schema: AppSchema, entities: {} } as never) as any
const Orders = (Aggregate.make as any)(Order, {
  table: Base,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "order" },
  root: { entityType: "Order" },
  edges: {
    // Returns the composite's stored form.
    lines: Aggregate.many({
      entityType: "OrderLine",
      sk: { composite: ["f"] },
      decompose: recording("lines", (line) => ({ ...line, f: (line.f as number) / 10 })),
    }),
    // Hands it back unchanged.
    kept: Aggregate.many({
      entityType: "OrderKept",
      sk: { composite: ["f"] },
      decompose: recording("kept", (line) => ({ ...line })),
    }),
    // A transformation with two types, whose key text `decompose` pads.
    counted: Aggregate.many({
      entityType: "OrderCounted",
      sk: { composite: ["f"] },
      decompose: recording("counted", (line) => ({ ...line, f: String(line.f).padStart(2, "0") })),
    }),
    // No transformation at all.
    plain: Aggregate.many({
      entityType: "OrderPlain",
      sk: { composite: ["f"] },
      decompose: recording("plain", (line) => ({ ...line })),
    }),
  },
})

/** A client keeping what's written, whose every query finds all of it. */
const memory = () => {
  const rows = new Map<string, Row>()
  const writes = { count: 0 }
  const keyOf = (row: Row) => `${row.pk?.S}|${row.sk?.S}`
  const layer = mockDynamoClientLayer({
    transactWriteItems: (input: { readonly TransactItems?: ReadonlyArray<any> | undefined }) =>
      Effect.sync(() => {
        writes.count++
        for (const item of input.TransactItems ?? []) {
          if (item.Put) rows.set(keyOf(item.Put.Item), item.Put.Item)
          if (item.Delete) rows.delete(keyOf(item.Delete.Key))
        }
        return {}
      }) as never,
    query: () =>
      Effect.sync(() => {
        const items = [...rows.values()]
        return { Items: items, Count: items.length, ScannedCount: items.length }
      }) as never,
  })
  return { rows, writes, layer }
}

const run = <A, E>(
  layer: Layer.Layer<DynamoClient>,
  body: (db: any) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({
      entities: {},
      aggregates: { Orders },
      tables: { Base },
    } as never)
    return yield* body(db)
  }).pipe(
    Effect.provide(Layer.merge(layer, Base.layer({ name: "decompose" })) as never),
    Effect.exit,
  ) as Effect.Effect<Exit.Exit<A, E>>

/** What a successful run returned, as the untyped client's results are. */
const succeed = (exit: Exit.Exit<unknown, unknown>): any => {
  expect(Exit.isSuccess(exit)).toBe(true)
  return (exit as Exit.Success<unknown, unknown>).value
}

const input = {
  id: "a",
  lines: [{ lineId: "l1", f: 50 }],
  kept: [{ lineId: "k1", f: 50 }],
  counted: [{ lineId: "c1", f: 5 }],
  plain: [{ lineId: "p1", f: 5 }],
}

/** Each row of an edge as its sort key and its stored `f`. */
const stored = (rows: Map<string, Row>, entityType: string) =>
  [...rows.values()]
    .filter((row) => row.__edd_e__?.S === entityType)
    .map((row) => [row.sk?.S, row.f])

const reset = () => {
  for (const edge of Object.keys(handed)) delete handed[edge]
}

describe("a custom decompose is handed a write's value as 1.39.0 handed it", () => {
  it.effect("create hands it read stored form first, and keeps its output's key text", () =>
    Effect.gen(function* () {
      const { rows, layer } = memory()
      reset()
      const created = succeed(yield* run(layer, (db) => db.aggregates.Orders.create(input)))
      expect(created).toEqual(input)
      expect(handed.lines).toEqual([[{ lineId: "l1", f: 500 }]])
      expect(stored(rows, "OrderLine")).toEqual([
        ["$custom#v1#orderline#0000000000000050", { N: "5" }],
      ])
      const got = succeed(yield* run(layer, (db) => db.aggregates.Orders.get({ id: "a" })))
      expect(got.lines).toEqual([{ lineId: "l1", f: 50 }])
    }),
  )

  it.effect("an update leaves a row whose decompose returns the stored form where it is", () =>
    Effect.gen(function* () {
      const { rows, layer } = memory()
      succeed(yield* run(layer, (db) => db.aggregates.Orders.create(input)))
      let before: Record<string, unknown> = { lineId: "l1", f: 50 }
      for (const note of ["one", "two", "three"]) {
        reset()
        const updated = succeed(
          yield* run(layer, (db) =>
            db.aggregates.Orders.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              lines: state.lines.map((line: any) => ({ ...line, note })),
            })),
          ),
        )
        expect(updated.lines).toEqual([{ lineId: "l1", f: 50, note }])
        // The old state as it was read, then the new state as a write's value.
        expect(handed.lines).toEqual([[before], [{ lineId: "l1", f: 500, note }]])
        before = { lineId: "l1", f: 50, note }
        expect(stored(rows, "OrderLine")).toEqual([
          ["$custom#v1#orderline#0000000000000050", { N: "5" }],
        ])
        const got = succeed(yield* run(layer, (db) => db.aggregates.Orders.get({ id: "a" })))
        expect(got.lines).toEqual([{ lineId: "l1", f: 50, note }])
      }
    }),
  )

  it.effect("an update that changes nothing still rewrites the edge's rows, as on 1.39.0", () =>
    Effect.gen(function* () {
      const { rows, writes, layer } = memory()
      succeed(yield* run(layer, (db) => db.aggregates.Orders.create(input)))
      const before = new Map(rows)
      writes.count = 0
      succeed(
        yield* run(layer, (db) =>
          db.aggregates.Orders.update({ id: "a" }, ({ state }: any) => state),
        ),
      )
      // The state read is handed to `decompose` as read, so its rows compose other keys.
      expect(writes.count).toBe(1)
      expect(stored(rows, "OrderLine")).toEqual(stored(before, "OrderLine"))
    }),
  )

  it.effect("a value handed back unchanged is stored decoded once more, as on 1.39.0", () =>
    Effect.gen(function* () {
      const { rows, layer } = memory()
      succeed(yield* run(layer, (db) => db.aggregates.Orders.create(input)))
      expect(stored(rows, "OrderKept")).toEqual([
        ["$custom#v1#orderkept#0000000000000500", { N: "50" }],
      ])
      const got = succeed(yield* run(layer, (db) => db.aggregates.Orders.get({ id: "a" })))
      expect(got.kept).toEqual([{ lineId: "k1", f: 500 }])
    }),
  )

  it.effect("a transformation with two types, and a field with none, are handed as they are", () =>
    Effect.gen(function* () {
      const { rows, layer } = memory()
      reset()
      succeed(yield* run(layer, (db) => db.aggregates.Orders.create(input)))
      expect(handed.counted).toEqual([[{ lineId: "c1", f: 5 }]])
      expect(stored(rows, "OrderCounted")).toEqual([["$custom#v1#ordercounted#05", { S: "5" }]])
      expect(handed.plain).toEqual([[{ lineId: "p1", f: 5 }]])
      expect(stored(rows, "OrderPlain")).toEqual([
        ["$custom#v1#orderplain#0000000000000005", { N: "5" }],
      ])
    }),
  )
})
