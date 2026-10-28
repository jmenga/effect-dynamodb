/**
 * `helpers/PartitionMock.ts` selects rows by the sort key condition a query
 * sends, in both directions — the narrowing the #171 sizing, skip-scan and
 * Z-order tests rely on. A condition it does not recognise is a defect, never
 * every row.
 */

import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import * as Query from "../src/Query.js"
import { makePartition, type Row } from "./helpers/PartitionMock.js"

const PK = "$shop#v1#product#store-1"
const skOf = (n: number) => `$shop#v1#product#${String(n).padStart(6, "0")}`

const rows = Array.from(
  { length: 30 },
  (_, n): Row => ({
    pk: { S: PK },
    sk: { S: skOf(n) },
    id: { S: `p-${n}` },
    __edd_e__: { S: "Product" },
  }),
)

const products = Query.make<{ readonly id: string }>({
  tableName: "Products",
  indexName: undefined,
  pkField: "pk",
  pkValue: PK,
  skField: "sk",
  entityTypes: ["Product"],
  decoder: (raw) => Effect.succeed({ id: raw.id as string }),
  keyFields: ["pk", "sk"],
})

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `p-${from + i}`)

describe("PartitionMock", () => {
  it.effect("a sort key condition narrows the rows, in both directions", () => {
    const partition = makePartition({ rows })
    return Effect.gen(function* () {
      for (const [condition, expected] of [
        [{ eq: skOf(4) }, range(4, 4)],
        [{ lt: skOf(3) }, range(0, 2)],
        [{ lte: skOf(3) }, range(0, 3)],
        [{ gt: skOf(26) }, range(27, 29)],
        [{ gte: skOf(26) }, range(26, 29)],
        [{ between: [skOf(5), skOf(8)] as const }, range(5, 8)],
        [{ beginsWith: "$shop#v1#product#00001" }, range(10, 19)],
      ] satisfies ReadonlyArray<readonly [Query.SortKeyCondition, ReadonlyArray<string>]>) {
        const forward = yield* products.pipe(Query.where(condition), Query.collect)
        const reverse = yield* products.pipe(Query.where(condition), Query.reverse, Query.collect)
        expect([condition, forward.map((item) => item.id)]).toEqual([condition, expected])
        expect([condition, reverse.map((item) => item.id)]).toEqual([
          condition,
          [...expected].reverse(),
        ])
      }
      // No sort key condition: every row.
      expect((yield* Query.collect(products)).map((item) => item.id)).toEqual(range(0, 29))
    }).pipe(Effect.provide(partition.layer))
  })

  it.effect("ExclusiveStartKey resumes after the key, in both directions", () => {
    const partition = makePartition({ rows })
    return Effect.gen(function* () {
      const cursor = btoa(JSON.stringify({ pk: { S: PK }, sk: { S: skOf(26) } }))
      const forward = yield* products.pipe(Query.startFrom(cursor), Query.collect)
      const reverse = yield* products.pipe(
        Query.where({ gte: skOf(20) }),
        Query.reverse,
        Query.startFrom(cursor),
        Query.collect,
      )
      expect(forward.map((item) => item.id)).toEqual(range(27, 29))
      expect(reverse.map((item) => item.id)).toEqual(range(20, 25).reverse())
    }).pipe(Effect.provide(partition.layer))
  })

  it.effect("an unrecognised sort key condition is a defect", () => {
    const partition = makePartition({ rows })
    return Effect.gen(function* () {
      const exit = yield* partition
        .query({
          TableName: "Products",
          KeyConditionExpression: "#pk = :pk AND #sk <> :sk",
          ExpressionAttributeValues: { ":pk": { S: PK }, ":sk": { S: skOf(1) } },
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    })
  })
})
