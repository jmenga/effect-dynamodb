/**
 * An expression naming the path builder itself (`t`, or `t.size()`) names the whole item, not an
 * attribute (#238 section 7). It compiled to an empty attribute name: published 1.40.0 sent a
 * filter as `#eddE IN (:et0) AND ( = :e0)` and a condition as `( = :e0) AND
 * attribute_exists(#exists)`, and DynamoDB rejected each with a `DynamoValidationError`; 1.39.0
 * sent the condition the same way, and its filter died with a `TypeError` before sending (measured
 * on both, against DynamoDB Local). Every entry point now refuses it as it refuses an empty part
 * (`emptyPartProblem`, `EDD-9149`): a `ValidationError` naming the operation, with nothing sent.
 */

import { it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import { compileExpr, createConditionOps, emptyPartProblem } from "../src/internal/Expr.js"
import { createPathBuilder } from "../src/internal/PathBuilder.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const Model = Schema.Struct({ id: Schema.String, cat: Schema.String, n: Schema.Number })

const docsOf = (renamed: boolean) =>
  Lib.Entity.make({
    model: renamed ? Lib.DynamoModel.configure(Model, { n: { field: "nn" } }) : Model,
    entityType: "Doc",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byCat: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["cat"] },
        sk: { field: "gsi1sk", composite: ["id"] },
        collection: "cats",
      },
    },
  } as never) as any

const run = (renamed: boolean, body: (db: any, Docs: any) => Effect.Effect<unknown, unknown>) => {
  const Docs = docsOf(renamed)
  const Main = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "root", version: 1 }),
    entities: { Docs },
  })
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  return Effect.gen(function* () {
    const db: any = yield* Lib.DynamoClient.make({ entities: { Docs }, tables: { Main } } as never)
    yield* db.entities.Docs.put({ id: "a", cat: "c", n: 1 }).asEffect()
    table.take()
    const exit = yield* Effect.exit(Effect.suspend(() => body(db, Docs)))
    return { exit, sent: table.take() }
  }).pipe(
    Effect.provide(Layer.merge(table.layer, Main.layer({ name: "root" })) as never),
  ) as Effect.Effect<{
    readonly exit: Exit.Exit<unknown, unknown>
    readonly sent: ReturnType<typeof table.take>
  }>
}

const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  const failure = Exit.isFailure(exit) ? (exit.cause.reasons[0] as any)?.error : undefined
  expect(failure?._tag).toBe("ValidationError")
  expect(String(failure?.cause)).toContain("[EDD-9149]")
  expect(String(failure?.cause)).toContain("Nothing was sent.")
  return failure.operation as string
}

const whole = (t: any, { eq }: any) => eq(t, 1)

const cases: ReadonlyArray<
  readonly [string, string, (db: any, Docs: any) => Effect.Effect<unknown, unknown>]
> = [
  ["a scan's filter", "query.filter", (db) => db.entities.Docs.scan().filter(whole).collect()],
  [
    "an index query's filter",
    "query.filter",
    (db) => db.entities.Docs.byCat({ cat: "c" }).filter(whole).collect(),
  ],
  [
    "a collection's filter",
    "query.filter",
    (db) => db.collections.cats({ cat: "c" }).filter(whole).collect(),
  ],
  [
    "an update's condition",
    "update.condition",
    (db) => db.entities.Docs.update({ id: "a" }).set({ n: 2 }).condition(whole).asEffect(),
  ],
  [
    "a put's condition",
    "put.condition",
    (db) => db.entities.Docs.put({ id: "a", cat: "c", n: 2 }).condition(whole).asEffect(),
  ],
  [
    "a delete's condition",
    "delete.condition",
    (db) => db.entities.Docs.delete({ id: "a" }).condition(whole).asEffect(),
  ],
  [
    "a transaction's op condition",
    "transactWrite.condition",
    (db) => Lib.Transaction.transactWrite([db.entities.Docs.delete({ id: "a" }).condition(whole)]),
  ],
]

describe("an expression naming the path builder itself (#238 section 7)", () => {
  for (const renamed of [true, false]) {
    for (const [name, operation, body] of cases) {
      it.effect(`${name} is refused before sending${renamed ? ", with a renamed field" : ""}`, () =>
        Effect.gen(function* () {
          const { exit, sent } = yield* run(renamed, body)
          expect(refusal(exit)).toBe(operation)
          expect(sent).toEqual([])
        }),
      )
    }
  }

  const ops = createConditionOps<{ a: string }>()
  const t = createPathBuilder<{ a: string }>() as any

  it("every leaf naming it is a problem, wherever it sits, and compileExpr refuses it", () => {
    for (const expr of [
      ops.eq(t, 1),
      ops.ne(1 as never, t),
      ops.gt(t.size(), 1),
      ops.between(t, 1, 2),
      ops.isIn(t, [1]),
      ops.exists(t),
      ops.notExists(t),
      ops.attributeType(t, "S"),
      ops.beginsWith(t, "x"),
      ops.contains(t, "x"),
      ops.and(ops.eq(t.a, "x"), ops.not(ops.exists(t))),
      ops.or(ops.eq(t.a, "x"), ops.eq(t, 1)),
    ]) {
      expect(emptyPartProblem(expr as never)).toContain("[EDD-9149]")
      expect(() => compileExpr(expr as never)).toThrow(/compileExpr/)
    }
  })

  it("an attribute is not", () => {
    for (const expr of [
      ops.eq(t.a, "x"),
      ops.gt(t.a.size(), 1),
      ops.exists(t.a),
      ops.eq(t.a, t.a),
    ]) {
      expect(emptyPartProblem(expr as never)).toBeUndefined()
    }
  })
})
