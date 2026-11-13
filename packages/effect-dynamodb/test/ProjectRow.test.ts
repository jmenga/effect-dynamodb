/**
 * `Query.projectRow`: what a `ProjectionExpression` of some paths returns of a row, worked out on
 * the row itself, for a select that reads whole rows because it names a sparse map (#238 section
 * 1, `helpers/SelectSparseMaps.ts`). And such a select is still a select: a client-side predicate
 * after it is refused (EDD-9054), as after any other.
 */

import { it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import { projectRow } from "../src/Query.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

describe("projectRow", () => {
  const row = {
    id: "a",
    meta: { count: 1, tags: ["x", "y", "z"], nested: { deep: true } },
    list: [{ a: 1, b: 2 }, { a: 3 }, "plain"],
    set: new Set(["s"]),
    empty: {},
  }

  it("keeps each path's value under the maps holding it", () => {
    expect(projectRow(row, [["id"], ["meta", "count"], ["meta", "nested", "deep"]])).toEqual({
      id: "a",
      meta: { count: 1, nested: { deep: true } },
    })
  })

  it("keeps a list's selected positions, in position order", () => {
    expect(
      projectRow(row, [
        ["meta", "tags", 2],
        ["meta", "tags", 0],
      ]),
    ).toEqual({ meta: { tags: ["x", "z"] } })
    expect(
      projectRow(row, [
        ["list", 1, "a"],
        ["list", 0, "b"],
      ]),
    ).toEqual({
      list: [{ b: 2 }, { a: 3 }],
    })
  })

  it("leaves out a path the row doesn't hold", () => {
    expect(
      projectRow(row, [
        ["missing"],
        ["meta", "missing"],
        ["meta", "count", "below"],
        ["meta", "tags", 5],
        ["list", "a"],
        ["meta", 0],
        ["set", 0],
        ["empty", "x"],
      ]),
    ).toEqual({})
  })

  it("holds a path inside one selected whole, in either order", () => {
    expect(projectRow(row, [["meta"], ["meta", "count"]])).toEqual({ meta: row.meta })
    expect(projectRow(row, [["meta", "count"], ["meta"]])).toEqual({ meta: row.meta })
  })

  it("keeps an empty map, and a key named like an object's own member", () => {
    expect(projectRow(row, [["empty"]])).toEqual({ empty: {} })
    const odd = JSON.parse('{"__proto__": {"x": 1}, "constructor": 2}') as Record<string, unknown>
    const projected = projectRow(odd, [["__proto__", "x"], ["constructor"]])
    expect(Object.hasOwn(projected, "__proto__")).toBe(true)
    expect(Object.getOwnPropertyDescriptor(projected, "__proto__")?.value).toEqual({ x: 1 })
    expect(projected.constructor).toBe(2)
  })
})

describe("a select reading whole rows is still a select (EDD-9054)", () => {
  const Docs = Lib.Entity.make({
    model: Lib.DynamoModel.configure(
      Schema.Struct({ id: Schema.String, f: Schema.Record(Schema.String, Schema.Number) }),
      { f: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "m" }) } },
    ),
    entityType: "Doc",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any
  const Main = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "pr", version: 1 }),
    entities: { Docs },
  } as never) as any

  it.effect(
    "filterBy after it is refused, and select after filterBy too",
    () =>
      Effect.gen(function* () {
        const db: any = yield* Lib.DynamoClient.make({
          entities: { Docs },
          tables: { Main },
        } as never)
        expect(() =>
          db.entities.Docs.scan()
            .select(["f"])
            .filterBy(() => true),
        ).toThrow(/EDD-9054/)
        expect(() =>
          db.entities.Docs.scan()
            .filterBy(() => true)
            .select(["f"]),
        ).toThrow(/EDD-9054/)
      }).pipe(
        Effect.provide(
          Layer.merge(makeRecordingTable().layer, Main.layer({ name: "pr" })) as never,
        ),
      ) as Effect.Effect<void>,
  )
})
