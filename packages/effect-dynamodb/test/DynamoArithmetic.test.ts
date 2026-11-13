/**
 * DynamoDB's arithmetic and set algebra as an update that reads the row first applies them (#236):
 * a retained entity's, one changing a unique field, one computing an index composite
 * (`helpers/ReadFirstUpdates.ts`).
 *
 * `helpers/RetainedArithmetic.ts` holds each case with the attribute DynamoDB stores for it when
 * the update is sent as an expression (`connected.retained-arithmetic.test.ts` checks every case
 * against DynamoDB Local, both paths side by side). Here the update that reads first, alone and
 * in a transaction, stores exactly that attribute; where DynamoDB refuses the number (39 significant
 * digits), the update sends it as it is, for DynamoDB to refuse. A bigint field's `.add()` and
 * `.subtract()` died mixing a bigint with a number read back (also on 1.39.0); a fraction was a
 * JavaScript float (`0.30000000000000004`); a bigint or binary set's members were compared by
 * identity, so a union held a member twice and a difference removed nothing.
 *
 * A set operand is sent, and applied, as the set at its position stores its members
 * (`memberKindCases`): `Schema.ReadonlySet(Schema.NumberFromString)` stores strings, and its
 * operand `Set([7])` was sent as a number set, which DynamoDB refuses on a string set, and which
 * the update that reads first refused once it compared kinds (1.40.0 unioned it). A `NumberValue`
 * operand is the number its text holds.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { NumberValueImpl as NumberValue } from "@aws-sdk/util-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { isNumeric, numberSum, setDifference, setUnion } from "../src/internal/DynamoArithmetic.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { READ_FIRST, type ReadFirstUpdate } from "./helpers/ReadFirstUpdates.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  arithmeticCases,
  arithmeticModel,
  memberKindCases,
  sorted,
} from "./helpers/RetainedArithmetic.js"

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

  it("takes a NumberValue as the number its text holds", () => {
    expect(isNumeric(NumberValue.from("2"))).toBe(true)
    expect(numberSum(5, NumberValue.from("2"), false)).toBe(7)
    expect(numberSum(0.2, NumberValue.from("0.1"), false)).toBe(0.3)
    expect(numberSum(9007199254740993n, NumberValue.from("2"), false)).toBe(9007199254740995n)
    expect(numberSum(5, NumberValue.from("1e2"), true)).toBe(-95)
  })
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

  it("NumberValues", () => {
    expect(setUnion(new Set([2]), new Set([NumberValue.from("2.0")])).size).toBe(1)
    expect([...setDifference(new Set([1, 2]), new Set([NumberValue.from("2")]))]).toEqual([1])
  })
})

/** Runs a case on an update that reads first: how it ended, and what it stored for its attribute. */
const run = (
  config: ReadFirstUpdate,
  transaction: boolean,
  each: (typeof arithmeticCases)[number],
) => {
  const E = Entity.make({
    model: arithmeticModel,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...config.entity,
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
    const op = each.apply(config.prefix(db.entities.E.update({ id: "a" })))
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

describe.each(
  READ_FIRST,
)("$name: the update stores what DynamoDB stores for the expression", (config) => {
  const cases = [...arithmeticCases, ...memberKindCases].filter(
    (each) => each.pathOp !== true || config.takesPathOps,
  )
  for (const transaction of [false, true]) {
    for (const each of cases) {
      it.effect(`${each.name}, ${transaction ? "in a transaction" : "alone"}`, () =>
        Effect.gen(function* () {
          const got = yield* run(config, transaction, each)
          if (each.stored === undefined) {
            // A number DynamoDB can't hold is sent as it is, and refused as DynamoDB refuses it.
            expect(Exit.isFailure(got.exit)).toBe(true)
            if (Exit.isFailure(got.exit)) {
              expect((Cause.squash(got.exit.cause) as any)._tag).toBe("DynamoValidationError")
            }
            return
          }
          if (Exit.isFailure(got.exit)) expect(Cause.pretty(got.exit.cause)).toBe("")
          expect(got.stored).toEqual(sorted(each.stored))
        }),
      )
    }
  }
})

/** The request an update of `a` sends, on an entity without a read-first configuration. */
const sent = (seed: Record<string, unknown>, apply: (update: any) => any, transaction: boolean) => {
  const E = Entity.make({
    model: arithmeticModel,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "arith", version: 1 }),
    entities: { E },
  } as never) as any
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { E }, tables: { Main } } as never)
    yield* db.entities.E.put({ id: "a", ...seed }).asEffect()
    yield* db.entities.E.put({ id: "b" }).asEffect()
    table.take()
    const op = apply(db.entities.E.update({ id: "a" }))
    yield* transaction
      ? Transaction.transactWrite([db.entities.E.update({ id: "b" }).set({ n: 1 }), op])
      : op.asEffect()
    const writes = table.take().filter((request) => !request.command.startsWith("Get"))
    const update = transaction
      ? writes[0]?.input.TransactItems.map((item: any) => item.Update).find(
          (u: any) => u?.Key?.pk?.S === "$arith#v1#e#id_a",
        )
      : writes[0]?.input
    const values = Object.entries(update?.ExpressionAttributeValues ?? {})
      .filter(([placeholder]) => /^:(a|d|pad|pd)\d+$/.test(placeholder))
      .map(([, value]) => sorted(value as AttributeValue))
    const live = [...table.items.values()].find(
      (row: any) => row.pk?.S === "$arith#v1#e#id_a" && row.sk?.S === "$arith#v1#e",
    ) as Record<string, AttributeValue> | undefined
    return { values, row: live }
  }).pipe(
    Effect.provide(Main.layer({ name: "t" })),
    Effect.provide(table.layer),
  ) as unknown as Effect.Effect<
    { values: ReadonlyArray<unknown>; row: Record<string, AttributeValue> | undefined },
    unknown
  >
}

describe("an update sent as an expression sends a set operand as its position stores it (#236)", () => {
  const cases: ReadonlyArray<
    readonly [name: string, seed: Record<string, unknown>, apply: (u: any) => any, value: unknown]
  > = [
    [
      ".add() to a NumberFromString set",
      { nfs: new Set([5]) },
      (u) => u.add({ nfs: new Set([7]) }),
      { SS: ["7"] },
    ],
    [
      ".deleteFromSet() from a NumberFromString set",
      { nfs: new Set([5, 6]) },
      (u) => u.deleteFromSet({ nfs: new Set([5]) }),
      { SS: ["5"] },
    ],
    [
      "pathAdd to a NumberFromString set",
      { nfs: new Set([5]) },
      (u) => u.pathAdd({ segments: ["nfs"], value: new Set([7]) }),
      { SS: ["7"] },
    ],
    [
      "pathDelete from a NumberFromString set",
      { nfs: new Set([5, 6]) },
      (u) => u.pathDelete({ segments: ["nfs"], value: new Set([5]) }),
      { SS: ["5"] },
    ],
    // A set stored as given is sent as 1.40.0 sent it.
    [
      ".add() to a number set",
      { ns: new Set([1]) },
      (u) => u.add({ ns: new Set([2]) }),
      { NS: ["2"] },
    ],
    [
      ".add() to a bigint set",
      { bigs: new Set([5n]) },
      (u) => u.add({ bigs: new Set([7n]) }),
      {
        NS: ["7"],
      },
    ],
    [
      ".deleteFromSet() from a string set",
      { strs: new Set(["a", "b"]) },
      (u) => u.deleteFromSet({ strs: new Set(["a"]) }),
      { SS: ["a"] },
    ],
    [".add() of a number", { n: 5 }, (u) => u.add({ n: 2 }), { N: "2" }],
  ]
  for (const transaction of [false, true]) {
    for (const [name, seed, apply, value] of cases) {
      it.effect(`${name}, ${transaction ? "in a transaction" : "alone"}`, () =>
        Effect.gen(function* () {
          const got = yield* sent(seed, apply, transaction)
          expect(got.values).toEqual([sorted(value as AttributeValue)])
        }),
      )
    }
  }

  it.effect("the row read back holds the operand's members", () =>
    Effect.gen(function* () {
      const got = yield* sent({ nfs: new Set([5]) }, (u) => u.add({ nfs: new Set([7]) }), false)
      expect(sorted(got.row?.nfs)).toEqual({ SS: ["5", "7"] })
    }),
  )
})
