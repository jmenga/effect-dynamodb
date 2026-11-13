/**
 * Values `create`'s judgement (#241, `EDD-9159`) holds apart: `5n` beside a context value `5`, `-0`
 * beside `0`, a `BigDecimal` beside one of the same value at another scale (`1.5`, `1.50`). The
 * library writes the root's value on the member's row, and a read of it hands back the root's
 * (published 1.40.0's `get` returned `5`, `0` and `1.50` for these, measured at review), so each is
 * refused like any other value a read doesn't return. The same value at the same scale is
 * accepted, and judging it adds nothing to the caller's value (`Equal.equals` caches a
 * `BigDecimal`'s normalized form on the instance compared).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { BigDecimal, Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const make = (root: Schema.Top, member: Schema.Top) => {
  const schema = DynamoSchema.make({ name: "strict", version: 1 })
  const Main = Table.make({ schema, entities: {} })
  const Agg = Aggregate.make(
    Schema.Struct({ id: Schema.String, v: root, m: member }) as never,
    {
      schema,
      table: Main,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "agg" },
      root: { entityType: "Root" },
      context: ["v"],
      edges: { m: Aggregate.one({ entityType: "M" }) },
    } as never,
  ) as any
  return { Main, Agg }
}

const create = (root: Schema.Top, member: Schema.Top, input: unknown) => {
  const { Main, Agg } = make(root, member)
  const table = makeRecordingTable()
  return Effect.runPromise(
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: {},
        aggregates: { Agg },
        tables: { Main },
      })
      const made = yield* Effect.exit(db.aggregates.Agg.create(input))
      return {
        made,
        rows: [...table.items.values()],
        get: yield* Effect.exit(db.aggregates.Agg.get({ id: "a" })),
      }
    }).pipe(
      Effect.provide(Layer.merge(table.layer, Main.layer({ name: "strict" }))),
    ) as Effect.Effect<any, never, never>,
  ) as Promise<{
    made: Exit.Exit<any, any>
    rows: ReadonlyArray<unknown>
    get: Exit.Exit<any, any>
  }>
}

const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String((Cause.squash(exit.cause) as { reason?: unknown }).reason) : ""

const Member = (v: Schema.Top) => Schema.Struct({ text: Schema.String, v })

describe("EDD-9159 holds 5n and 5, -0 and 0, 1.5 and 1.50 apart", () => {
  it("a bigint given beside a number: refused", async () => {
    const now = await create(Schema.Number, Schema.Unknown, {
      id: "a",
      v: 5,
      m: { text: "n", v: 5n },
    })
    expect(refusal(now.made)).toMatch(/EDD-9159.*5n/s)
    expect(now.rows).toEqual([])
  })

  it("-0 given beside 0: refused", async () => {
    const now = await create(Schema.Number, Schema.Unknown, {
      id: "a",
      v: 0,
      m: { text: "n", v: -0 },
    })
    expect(refusal(now.made)).toMatch(/EDD-9159.*-0/s)
    expect(now.rows).toEqual([])
  })

  it("a BigDecimal at another scale: refused", async () => {
    const now = await create(Schema.BigDecimal, Member(Schema.BigDecimal), {
      id: "a",
      v: BigDecimal.fromStringUnsafe("1.50"),
      m: { text: "n", v: BigDecimal.fromStringUnsafe("1.5") },
    })
    expect(refusal(now.made)).toMatch(/EDD-9159.*BigDecimal\(1\.5\).*BigDecimal\(1\.50\)/s)
    expect(now.rows).toEqual([])
  })

  it("the same BigDecimal at the same scale: created, the caller's value untouched", async () => {
    const given = BigDecimal.fromStringUnsafe("1.50")
    const root = BigDecimal.fromStringUnsafe("1.50")
    const now = await create(Schema.BigDecimal, Member(Schema.BigDecimal), {
      id: "a",
      v: root,
      m: { text: "n", v: given },
    })
    expect(Exit.isSuccess(now.made)).toBe(true)
    expect(Object.keys(given).sort()).toEqual(["scale", "value"])
    expect(Object.keys(root).sort()).toEqual(["scale", "value"])
    const value = (now.made as Exit.Success<any, any>).value
    expect(Object.keys(value.m.v).sort()).toEqual(["scale", "value"])
    expect(Exit.isSuccess(now.get)).toBe(true)
  })

  it("the same number: created", async () => {
    const now = await create(Schema.Number, Schema.Unknown, {
      id: "a",
      v: 5,
      m: { text: "n", v: 5 },
    })
    expect(Exit.isSuccess(now.made)).toBe(true)
  })
})
