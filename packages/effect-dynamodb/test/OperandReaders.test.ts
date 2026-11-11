/**
 * An update's operand at a position the read schema resolves exactly (#236): what 1.40.0 sends is
 * sent when one of the position's readers reads it back as stored; otherwise it is written in the
 * one other stored form those readers read back, and refused when there is none, or several.
 *
 * `judgeOperand` first, then the shapes #236 reproduced, each standalone and in a transaction:
 * a sparse map's entry named by its stored name, an append to a union of lists, and a suspended
 * schema. Every other position (an `Option`, a transformed struct, a decoding default, ...) is
 * sent as 1.39.0 sent it: `OperandPositions.test.ts` pins each against the published release.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { judgeOperand } from "../src/internal/OperandReaders.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

describe("judgeOperand", () => {
  const none = () => []
  const text = Schema.NumberFromString.ast

  it("sends what a reader reads back", () => {
    expect(judgeOperand([text], "value", 7, "7", none)).toEqual({ encoded: "7", issue: undefined })
  })

  it("writes the one stored form a reader reads back, where what was sent doesn't read", () => {
    expect(judgeOperand([text], "value", 7, 7, none)).toEqual({ encoded: "7", issue: undefined })
    expect(judgeOperand([text], "elements", [7, 8], [7, 8], none)).toEqual({
      encoded: ["7", "8"],
      issue: undefined,
    })
  })

  it("takes the form the model writes at the position", () => {
    expect(judgeOperand([text], "value", 7, 7, () => ["7"])).toEqual({
      encoded: "7",
      issue: undefined,
    })
  })

  it("refuses what no reader reads, with the first reader's issue", () => {
    const verdict = judgeOperand([text, Schema.Boolean.ast], "value", null, null, none)
    expect(verdict.encoded).toBe(null)
    expect(Cause.isCause(verdict.issue)).toBe(true)
    expect(String(verdict.issue)).toContain("Expected string")
  })

  it("refuses an operand two readers would store differently", () => {
    // A number read back from text, or from a one-element list.
    const listed = Schema.Array(Schema.Number).pipe(
      Schema.decodeTo(Schema.Number, {
        decode: SchemaGetter.transform((list: ReadonlyArray<number>) => list[0]!),
        encode: SchemaGetter.transform((n: number) => [n]),
      }),
    )
    const verdict = judgeOperand([text, listed.ast], "value", 7, 7, none)
    expect(verdict.encoded).toBe(7)
    expect(String(verdict.issue)).toContain("no one stored form")
  })

  it("leaves what isn't a list, and what can't be stored, to what refuses them", () => {
    expect(judgeOperand([text], "elements", 7, 7, none)).toEqual({ encoded: 7, issue: undefined })
    expect(judgeOperand([text], "value", Number.NaN, Number.NaN, none)).toEqual({
      encoded: Number.NaN,
      issue: undefined,
    })
  })
})

class Entry extends Schema.Class<Entry>("OperandReadersEntry")({ n: Schema.NumberFromString }) {}
const Suspended: Schema.Top = Schema.suspend(() => Schema.Struct({ n: Schema.NumberFromString }))

const definitions = () => {
  const schema = DynamoSchema.make({ name: "readers", version: 1 })
  const model = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      sparse: Schema.Record(Schema.String, Entry),
      lists: Schema.Union([Schema.Array(Schema.Number), Schema.Array(Schema.String)]),
      suspended: Suspended,
    }),
    { sparse: { storedAs: DynamoModel.SparseMap() } },
  )
  const E = Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any
  const Main = Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}

/** Seeds `a` and `b`, then sends an update of `a`, alone or in a transaction with one of `b`. */
const run = (
  transaction: boolean,
  apply: (update: any) => any,
  check: (outcome: {
    readonly exit: Exit.Exit<unknown, unknown>
    readonly requests: ReadonlyArray<{ readonly command: string; readonly input: any }>
    readonly read: Exit.Exit<unknown, unknown>
  }) => void,
) => {
  const { E, Main } = definitions()
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { E },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    const seed = (id: string) => ({
      id,
      sparse: { a: new Entry({ n: 1 }) },
      lists: [1],
      suspended: { n: 1 },
    })
    yield* db.entities.E.put(seed("a")).asEffect()
    yield* db.entities.E.put(seed("b")).asEffect()
    table.take()
    const op = apply(db.entities.E.update({ id: "a" }))
    const exit = yield* Effect.exit(
      transaction
        ? Transaction.transactWrite([db.entities.E.update({ id: "b" }).set({ lists: [2] }), op])
        : op.asEffect(),
    )
    const requests = [...table.requests]
    const read = yield* Effect.exit(db.entities.E.get({ id: "a" }))
    check({ exit, requests, read })
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    void,
    unknown
  >
}

const refusedAs =
  (operation: string, says: string) =>
  ({
    exit,
    requests,
    read,
  }: {
    readonly exit: Exit.Exit<unknown, unknown>
    readonly requests: ReadonlyArray<unknown>
    readonly read: Exit.Exit<unknown, unknown>
  }) => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons[0]!._tag).toBe("Fail")
      const error = Cause.squash(exit.cause) as any
      expect(error._tag).toBe("ValidationError")
      expect(error.operation).toBe(operation)
      expect(String(error.cause)).toContain(says)
    }
    // Refused before anything was read or sent, and the row still reads.
    expect(requests).toEqual([])
    expect(Exit.isSuccess(read)).toBe(true)
  }

/** The value the update wrote for `attribute`, as sent. */
const sentValue = (requests: ReadonlyArray<{ readonly command: string; readonly input: any }>) => {
  const write = requests.find((request) => !request.command.includes("Get"))!
  const update =
    write.command === "UpdateItem"
      ? write.input
      : write.input.TransactItems.map((item: any) => item.Update).find(
          (one: any) => one?.Key?.pk?.S?.endsWith("id_a") === true,
        )
  return Object.values(update.ExpressionAttributeValues as Record<string, unknown>)
}

describe("an operand at a position the read schema resolves exactly (#236)", () => {
  for (const transaction of [false, true]) {
    const where = transaction ? "in a transaction" : "alone"

    describe(`a sparse map's entry named by its stored name, ${where}`, () => {
      it.effect("refuses a value its entry's reader refuses", () =>
        run(
          transaction,
          (update) => update.pathSet({ segments: ["sparse#a", "n"], value: false, isPath: false }),
          refusedAs("update.pathSet", "Expected"),
        ),
      )
      it.effect("sends a number a stored row reads back as it sent it", () =>
        run(
          transaction,
          (update) => update.pathSet({ segments: ["sparse#a", "n"], value: 7, isPath: false }),
          ({ exit, requests, read }) => {
            expect(Exit.isSuccess(exit)).toBe(true)
            expect(sentValue(requests)).toContainEqual({ N: "7" })
            expect(Exit.isSuccess(read)).toBe(true)
          },
        ),
      )
    })

    describe(`an append to a union of lists, ${where}`, () => {
      for (const [operation, apply] of [
        ["update.append", (update: any) => update.append({ lists: [true] })],
        [
          "update.pathAppend",
          (update: any) => update.pathAppend({ segments: ["lists"], value: [true] }),
        ],
        [
          "update.pathPrepend",
          (update: any) => update.pathPrepend({ segments: ["lists"], value: [true] }),
        ],
      ] as const) {
        it.effect(`${operation} refuses elements neither list reads`, () =>
          run(transaction, apply, refusedAs(operation, "Expected")),
        )
      }
      it.effect("sends elements a list reads", () =>
        run(
          transaction,
          (update) => update.append({ lists: [2] }),
          ({ exit, requests, read }) => {
            expect(Exit.isSuccess(exit)).toBe(true)
            expect(sentValue(requests)).toContainEqual({ L: [{ N: "2" }] })
            expect(Exit.isSuccess(read)).toBe(true)
          },
        ),
      )
    })

    describe(`a suspended schema, ${where}`, () => {
      it.effect("refuses a value its reader refuses", () =>
        run(
          transaction,
          (update) => update.pathSet({ segments: ["suspended", "n"], value: true, isPath: false }),
          refusedAs("update.pathSet", "Expected"),
        ),
      )
      it.effect("writes a number its reader reads back as text", () =>
        run(
          transaction,
          (update) => update.pathSet({ segments: ["suspended", "n"], value: 7, isPath: false }),
          ({ exit, requests, read }) => {
            expect(Exit.isSuccess(exit)).toBe(true)
            const sent = sentValue(requests)
            expect(sent).toContainEqual({ S: "7" })
            expect(sent).not.toContainEqual({ N: "7" })
            expect(Exit.isSuccess(read)).toBe(true)
            if (Exit.isSuccess(read)) expect((read.value as any).suspended).toEqual({ n: 7 })
          },
        ),
      )
    })
  }
})
