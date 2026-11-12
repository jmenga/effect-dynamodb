/**
 * Where the operand check can't say, the operand is sent as 1.40.0 sent it (#236).
 *
 * - **A schema that can't run synchronously.** The check runs the read schema synchronously; a
 *   row's read runs it as an Effect. A decoder with an asynchronous step can't finish
 *   synchronously, and that says nothing about the value: the operand is sent and the row reads.
 *   At a sparse map's entry named by its stored name and below a `Schema.suspend`, positions the
 *   check reads since #236, 1.40.0 sent it and head refused it (`AsyncFiberError`); at a field,
 *   below a struct and in an `.append()`, positions 1.39.0 already checked, both releases died
 *   ("Option adapter can only return none for schema issues"). A schema issue is still a refusal.
 * - **An entry of a sparse map stored under a `field:` rename.** Such a map is read whole from the
 *   renamed attribute, so no read takes `<field>#<key>` as its own attribute: the operand check
 *   doesn't judge it. The entry is written where the row holds the map, and its value is checked
 *   against the map's value schema as one written into a field is (#238): a value that schema
 *   refuses is refused, with nothing written.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { CANT_SAY, issueOf } from "@effect-dynamodb/schema/internal/SchemaIssue.js"
import { Cause, Effect, Exit, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { judgeOperand } from "../src/internal/OperandReaders.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** A string read back upper-cased by an asynchronous step, and stored lower-cased. */
const Slow = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformEffect((s: string) =>
      Effect.promise(() => Promise.resolve(s.toUpperCase())),
    ),
    encode: SchemaGetter.transform((s: string) => s.toLowerCase()),
  }),
)

describe("issueOf", () => {
  it("is a schema issue's cause, CANT_SAY for anything else", () => {
    const decode = Schema.decodeUnknownExit(Slow)
    expect(issueOf(() => decode("x"))).toBe(CANT_SAY)
    expect(Cause.isCause(issueOf(() => decode(5)))).toBe(true)
    expect(issueOf(() => Schema.decodeUnknownExit(Schema.String)("x"))).toBeUndefined()
    expect(
      issueOf(() => {
        throw new Error("boom")
      }),
    ).toBe(CANT_SAY)
    expect(issueOf(() => Exit.die("boom"))).toBe(CANT_SAY)
  })
})

describe("judgeOperand, where a reader can't say", () => {
  it("sends the operand", () => {
    expect(judgeOperand([Slow.ast], "value", "x", "x", () => [])).toEqual({
      encoded: "x",
      issue: undefined,
    })
    expect(judgeOperand([Slow.ast], "elements", ["x"], ["x"], () => [])).toEqual({
      encoded: ["x"],
      issue: undefined,
    })
  })

  it("refuses what a reader refuses for certain", () => {
    expect(Cause.isCause(judgeOperand([Slow.ast], "value", 5, 5, () => []).issue)).toBe(true)
    // One element refused for certain refuses the list.
    expect(
      Cause.isCause(judgeOperand([Slow.ast], "elements", ["x", 5], ["x", 5], () => []).issue),
    ).toBe(true)
  })
})

const primaryKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }

const slowEntity = () => {
  const E = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        top: Slow,
        nest: Schema.Struct({ s: Slow }),
        list: Schema.Array(Slow),
        notes: Schema.Record(Schema.String, Slow),
        detail: Schema.suspend(
          (): Schema.Codec<{ readonly s: string }, { readonly s: string }> =>
            Schema.Struct({ s: Slow }),
        ),
      }),
      { notes: { storedAs: DynamoModel.SparseMap() } },
    ),
    entityType: "E",
    primaryKey,
  } as never) as any
  const seed = (id: string) => ({
    id,
    top: "t",
    nest: { s: "n" },
    list: ["l"],
    notes: { a: "a" },
    detail: { s: "d" },
  })
  return { E, seed }
}

const renamedEntity = () => {
  const E = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({ id: Schema.String, counts: Schema.Record(Schema.String, Schema.Number) }),
      { counts: { storedAs: DynamoModel.SparseMap(), field: "sr" } },
    ),
    entityType: "E",
    primaryKey,
  } as never) as any
  return { E, seed: (id: string) => ({ id, counts: { a: 1 } }) }
}

/** Seeds `a` and `b`, then sends an update of `a`, alone or in a transaction with one of `b`. */
const run = (
  definition: { readonly E: any; readonly seed: (id: string) => Record<string, unknown> },
  transaction: boolean,
  apply: (update: any) => any,
) => {
  const { E, seed } = definition
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "cantsay", version: 1 }),
    entities: { E },
  } as never) as any
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { E }, tables: { Main } } as never)
    yield* db.entities.E.put(seed("a")).asEffect()
    yield* db.entities.E.put(seed("b")).asEffect()
    table.take()
    const op = apply(db.entities.E.update({ id: "a" }))
    const exit = yield* Effect.exit(
      transaction
        ? Transaction.transactWrite([db.entities.E.update({ id: "b" }), op])
        : op.asEffect(),
    )
    const commands = table.take().map((request) => request.command)
    const read = yield* Effect.exit(db.entities.E.get({ id: "a" }))
    return { exit, commands, read }
  }).pipe(
    Effect.provide(Main.layer({ name: "t" })),
    Effect.provide(table.layer),
  ) as unknown as Effect.Effect<
    {
      exit: Exit.Exit<unknown, unknown>
      commands: ReadonlyArray<string>
      read: Exit.Exit<any, unknown>
    },
    unknown
  >
}

const slowCases: ReadonlyArray<
  readonly [name: string, apply: (u: any) => any, read: (row: any) => unknown, expected: unknown]
> = [
  [
    "a sparse map's entry by its stored name",
    (u) => u.pathSet({ segments: ["notes#a"], value: "x", isPath: false }),
    (row) => row.notes,
    { a: "X" },
  ],
  [
    "a property of a suspended struct",
    (u) => u.pathSet({ segments: ["detail", "s"], value: "x", isPath: false }),
    (row) => row.detail,
    { s: "X" },
  ],
  [
    "a field",
    (u) => u.pathSet({ segments: ["top"], value: "x", isPath: false }),
    (row) => row.top,
    "X",
  ],
  [
    "a property of a struct",
    (u) => u.pathSet({ segments: ["nest", "s"], value: "x", isPath: false }),
    (row) => row.nest,
    { s: "X" },
  ],
  ["an append", (u) => u.append({ list: ["x"] }), (row) => row.list, ["L", "X"]],
]

describe("a schema that can't run synchronously: the operand is sent (#236)", () => {
  for (const transaction of [false, true]) {
    const where = transaction ? "in a transaction" : "alone"
    for (const [name, apply, read, expected] of slowCases) {
      it.effect(`${name}, ${where}`, () =>
        Effect.gen(function* () {
          const got = yield* run(slowEntity(), transaction, apply)
          if (Exit.isFailure(got.exit)) expect(Cause.pretty(got.exit.cause)).toBe("")
          expect(got.commands.some((command) => !command.includes("Get"))).toBe(true)
          expect(Exit.isSuccess(got.read)).toBe(true)
          if (Exit.isSuccess(got.read)) expect(read(got.read.value)).toEqual(expected)
        }),
      )
    }
    it.effect(`a schema issue is still refused, ${where}`, () =>
      Effect.gen(function* () {
        for (const apply of [
          (u: any) => u.pathSet({ segments: ["notes#a"], value: 5, isPath: false }),
          (u: any) => u.pathSet({ segments: ["detail", "s"], value: 5, isPath: false }),
          (u: any) => u.append({ list: [5] }),
        ]) {
          const got = yield* run(slowEntity(), transaction, apply)
          expect(Exit.isFailure(got.exit)).toBe(true)
          const error = Exit.isFailure(got.exit) ? (Cause.squash(got.exit.cause) as any) : undefined
          expect(error?._tag).toBe("ValidationError")
          expect(got.commands).toEqual([])
        }
      }),
    )
  }
})

describe("an entry of a sparse map stored under a field: rename: checked by the map's value schema (#238)", () => {
  for (const transaction of [false, true]) {
    it.effect(transaction ? "in a transaction" : "alone", () =>
      Effect.gen(function* () {
        const got = yield* run(renamedEntity(), transaction, (u) =>
          u.pathSet({ segments: ["counts#a"], value: "note", isPath: false }),
        )
        expect(Exit.isFailure(got.exit)).toBe(true)
        if (Exit.isFailure(got.exit)) {
          const error = Cause.squash(got.exit.cause) as any
          expect(error._tag).toBe("ValidationError")
          expect(error.operation).toBe("update.pathSet")
          expect(String(error.cause)).toContain("Expected number")
        }
        expect(got.commands.some((command) => !command.includes("Get"))).toBe(false)
        // The map is read whole from `sr`, which nothing touched.
        expect(Exit.isSuccess(got.read)).toBe(true)
        if (Exit.isSuccess(got.read)) expect(got.read.value.counts).toEqual({ a: 1 })
      }),
    )
  }
})
