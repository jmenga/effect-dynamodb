/**
 * A retained entity's update, one changing a unique field and one computing an index composite
 * (`helpers/ReadFirstUpdates.ts`) apply `.subtract()`, `.append()`, `.add()` and
 * `.deleteFromSet()` to the row they read, where any other update sends them as an expression for
 * DynamoDB to apply (#236). Where DynamoDB refuses the expression on a value of another kind, the
 * update that reads first is refused the same way, after its read and with nothing written. Its
 * message is the library's, in DynamoDB Local's wording (`KIND`): what this test checks is the
 * library's text, never that the service words it so. It used to append a string's characters,
 * add a number to a string, and die on the `NaN` a string less a number is.
 * `connected.retained-record-ops.test.ts` holds the two paths side by side on DynamoDB Local. On an
 * attribute the row lacks, or holds as `NULL`, the two still differ, as on 1.40.0: the update that
 * reads first starts it from nothing (`connected.missing-operand-paths.test.ts`).
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { READ_FIRST, type ReadFirstUpdate } from "./helpers/ReadFirstUpdates.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const definitions = (config: ReadFirstUpdate) => {
  const schema = DynamoSchema.make({ name: "retained", version: 1 })
  const model = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      email: Schema.optional(Schema.String),
      rank: Schema.optional(Schema.Number),
      n: Schema.optional(Schema.Number),
      m: Schema.optional(Schema.Number),
      tags: Schema.optional(Schema.Array(Schema.String)),
      notes: Schema.optional(Schema.Array(Schema.String)),
      labels: Schema.optional(Schema.ReadonlySet(Schema.String)),
      ns: Schema.optional(Schema.ReadonlySet(Schema.Number)),
      nul: Schema.optional(Schema.NullOr(Schema.Number)),
      nlist: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      nset: Schema.optional(Schema.NullOr(Schema.ReadonlySet(Schema.String))),
      data: Schema.Record(Schema.String, Schema.Number),
      lists: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    }),
    {
      data: { storedAs: DynamoModel.SparseMap() },
      lists: { storedAs: DynamoModel.SparseMap() },
    },
  )
  const E = Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...config.entity,
  } as never) as any
  const Main = Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}

const KIND = "An operand in the update expression has an incorrect data type"

/**
 * Each operation DynamoDB refuses, its message in DynamoDB Local's wording, and what 1.40.0 did on
 * these paths (measured on DynamoDB Local; one answer on all three but where noted).
 */
const refused: ReadonlyArray<
  readonly [name: string, says: string, apply: (u: any) => any, on140: string]
> = [
  [
    "append to a string",
    KIND,
    (u) => u.append({ name: ["x"] }),
    "wrote the string's characters and the operand as a list, then failed: the row no longer reads",
  ],
  [
    "subtract from a string",
    KIND,
    (u) => u.subtract({ name: 2 }),
    "died on NaN (an index composite computed: ValidationError)",
  ],
  ["add a number to a string", KIND, (u) => u.add({ name: 2 }), 'stored "abc2"'],
  [
    "add a set to a string",
    KIND,
    (u) => u.add({ name: new Set(["x"]) }),
    "wrote the set, then failed: the row no longer reads",
  ],
  [
    "add a number to a set",
    KIND,
    (u) => u.add({ labels: 2 }),
    'wrote "[object Set]2", then failed: the row no longer reads',
  ],
  [
    "add a set of numbers to a set of strings",
    KIND,
    (u) => u.add({ labels: new Set([2]) }),
    'stored the union, "2" a string',
  ],
  [
    "delete from a string",
    KIND,
    (u) => u.deleteFromSet({ name: new Set(["x"]) }),
    "wrote the row unchanged",
  ],
  [
    "delete from a number",
    KIND,
    (u) => u.deleteFromSet({ n: new Set([5]) }),
    "wrote the row unchanged",
  ],
  [
    "delete a set of numbers from a set of strings",
    KIND,
    (u) => u.deleteFromSet({ labels: new Set([2]) }),
    "wrote the row unchanged",
  ],
  [
    "delete a set of strings from a set of numbers",
    KIND,
    (u) => u.deleteFromSet({ ns: new Set(["1"]) }),
    "wrote the row unchanged",
  ],
]

/** Seeds `a` and `b`, then sends `apply`'s update of `a`, alone or in a transaction. */
const run = (
  config: ReadFirstUpdate,
  transaction: boolean,
  apply: (update: any) => any,
  check: (outcome: {
    readonly exit: Exit.Exit<unknown, unknown>
    readonly commands: ReadonlyArray<string>
    readonly written: boolean
    readonly after: any
  }) => void,
) => {
  const { E, Main } = definitions(config)
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { E },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    yield* db.entities.E.put({
      id: "a",
      name: "abc",
      email: "a",
      n: 5,
      tags: ["t"],
      labels: new Set(["l"]),
      ns: new Set([1]),
      nul: null,
      nlist: null,
      nset: null,
      data: { y: 1 },
      lists: {},
    }).asEffect()
    yield* db.entities.E.put({ id: "b", name: "b", data: {}, lists: {} }).asEffect()
    const stored = structuredClone([...table.items])
    table.take()
    const op = apply(config.prefix(db.entities.E.update({ id: "a" })))
    const exit = yield* Effect.exit(
      transaction
        ? Transaction.transactWrite([db.entities.E.update({ id: "b" }).set({ name: "c" }), op])
        : op.asEffect(),
    )
    const commands = table.requests.map((request) => request.command)
    const written = JSON.stringify([...table.items]) !== JSON.stringify(stored)
    const after = yield* db.entities.E.get({ id: "a" })
    check({ exit, commands, written, after })
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    void,
    unknown
  >
}

describe.each(
  READ_FIRST,
)("$name: a record operation is refused where DynamoDB refuses it (#236)", (config) => {
  for (const transaction of [false, true]) {
    const where = transaction ? "in a transaction" : "alone"
    for (const [name, says, apply, on140] of refused) {
      it.effect(`${name}, ${where} | 1.40.0: ${on140}`, () =>
        run(config, transaction, apply, ({ exit, commands, written }) => {
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons[0]!._tag).toBe("Fail")
            const error = Cause.squash(exit.cause) as any
            expect(error._tag).toBe("DynamoValidationError")
            expect(error.operation).toBe("TransactWriteItems")
            expect(error.cause.message).toBe(says)
            expect(error.cause.name).toBe("ValidationException")
          }
          // It read the rows it updates, and wrote nothing.
          expect(commands.every((command) => command.includes("Get"))).toBe(true)
          expect(written).toBe(false)
        }),
      )
    }

    it.effect(`subtracts, adds and appends on values the row holds, ${where}`, () =>
      run(
        config,
        transaction,
        (update) =>
          update
            .subtract({ n: 2, "data#y": 1 })
            .append({ tags: ["u"] })
            .add({ labels: new Set(["m"]), "data#z": 3 }),
        ({ exit, written, after }) => {
          expect(Exit.isSuccess(exit)).toBe(true)
          expect(written).toBe(true)
          expect(after.n).toBe(3)
          expect(after.tags).toEqual(["t", "u"])
          expect(after.data).toEqual({ y: 0, z: 3 })
          expect([...after.labels].sort()).toEqual(["l", "m"])
        },
      ),
    )
  }
})
