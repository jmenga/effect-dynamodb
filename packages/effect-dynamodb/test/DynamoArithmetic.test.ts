/**
 * DynamoDB's arithmetic and set algebra as a retained entity's update applies them (#236).
 *
 * `helpers/RetainedArithmetic.ts` holds each case with the attribute DynamoDB stores for it when
 * the update is sent as an expression (`connected.retained-arithmetic.test.ts` checks every case
 * against DynamoDB Local, both paths side by side). Here the retained update, alone and in a
 * transaction, stores exactly that attribute; where DynamoDB refuses the number (39 significant
 * digits), the update sends it as it is, for DynamoDB to refuse. A bigint field's `.add()` and
 * `.subtract()` died mixing a bigint with a number read back (also on 1.39.0); a fraction was a
 * JavaScript float (`0.30000000000000004`); a bigint or binary set's members were compared by
 * identity, so a union held a member twice and a difference removed nothing.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { numberSum, setDifference, setUnion } from "../src/internal/DynamoArithmetic.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { arithmeticCases, arithmeticModel, sorted } from "./helpers/RetainedArithmetic.js"

describe("numberSum", () => {
  const cases: ReadonlyArray<
    readonly [before: number | bigint, operand: number | bigint, negate: boolean, sum: unknown]
  > = [
    [5, 2n, false, 7],
    [5, 7n, true, -2],
    [9007199254740991, 2n, false, 9007199254740993n],
    [9007199254740993n, 2n, true, 9007199254740991],
    [-9007199254740993n, 10n, true, -9007199254741003n],
    [0.2, 0.1, false, 0.3],
    [0.3, 0.1, true, 0.2],
    [1.5, 4, true, -2.5],
    [1e21, 1, false, 1000000000000000000001n],
    [1.5e-7, 1e-8, false, 1.6e-7],
    [0.5, 0.5, false, 1],
    [99999999999999999999999999999999999999n, 2n, false, 100000000000000000000000000000000000001n],
  ]
  for (const [before, operand, negate, sum] of cases) {
    it(`${before} ${negate ? "-" : "+"} ${operand}`, () => {
      expect(numberSum(before, operand, negate)).toStrictEqual(sum)
    })
  }
})

describe("setUnion and setDifference compare members by value", () => {
  it("numbers and bigints", () => {
    expect([...setUnion(new Set([5, 9007199254740993n]), new Set([5n, 2n]))]).toEqual([
      5,
      9007199254740993n,
      2n,
    ])
    expect([...setDifference(new Set([5, 7]), new Set([5n]))]).toEqual([7])
  })

  it("bytes", () => {
    const union = setUnion(new Set([new Uint8Array([1])]), new Set([new Uint8Array([1])]))
    expect(union.size).toBe(1)
    expect(setDifference(new Set([new Uint8Array([1])]), new Set([new Uint8Array([1])])).size).toBe(
      0,
    )
  })
})

/** Runs a case on a retained entity: how it ended, and what it stored or sent for its attribute. */
const run = (transaction: boolean, each: (typeof arithmeticCases)[number]) => {
  const E = Entity.make({
    model: arithmeticModel,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    versioned: { retain: true },
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "arith", version: 1 }),
    entities: { E },
  } as never) as any
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { E }, tables: { Main } } as never)
    yield* db.entities.E.put({ id: "a", ...each.seed }).asEffect()
    yield* db.entities.E.put({ id: "b" }).asEffect()
    table.take()
    const op = each.apply(db.entities.E.update({ id: "a" }))
    const exit = yield* Effect.exit(
      transaction
        ? Transaction.transactWrite([db.entities.E.update({ id: "b" }).set({ n: 1 }), op])
        : op.asEffect(),
    )
    const live = [...table.items.values()].find(
      (row: any) => row.pk?.S === "$arith#v1#e#id_a" && row.sk?.S === "$arith#v1#e",
    ) as Record<string, AttributeValue> | undefined
    return { exit, stored: sorted(live?.[each.attribute]) }
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    { exit: Exit.Exit<unknown, unknown>; stored: unknown },
    unknown
  >
}

describe("a retained entity's update stores what DynamoDB stores for the expression", () => {
  for (const transaction of [false, true]) {
    for (const each of arithmeticCases) {
      it.effect(`${each.name}, ${transaction ? "in a transaction" : "alone"}`, () =>
        Effect.gen(function* () {
          const got = yield* run(transaction, each)
          if (Exit.isFailure(got.exit)) expect(Cause.pretty(got.exit.cause)).toBe("")
          // A number DynamoDB can't hold is sent as it is, for DynamoDB to refuse: this table
          // stores what it's sent.
          expect(got.stored).toEqual(
            sorted(each.stored ?? { N: "100000000000000000000000000000000000001" }),
          )
        }),
      )
    }
  }
})
