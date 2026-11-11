/**
 * `Transaction.check` with a compiled condition (`Expression.condition`) names the attribute an
 * entity stores a field in (#236). The builder has no entity, so `count`, stored as `renamed`
 * (`field: "renamed"`), was named `count`, which no row holds: the check failed on a row holding
 * the value (also on 1.39.0). A name used only at the start of a document path is mapped; a
 * property below an attribute, a name no field is stored under, and a field stored under its own
 * name are sent as given.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const definitions = () => {
  const schema = DynamoSchema.make({ name: "checks", version: 1 })
  const model = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      count: Schema.Number,
      plain: Schema.Number,
      tally: Schema.Struct({ count: Schema.Number }),
    }),
    { count: { field: "renamed" } },
  )
  const E = Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any
  const Main = Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}

/** Sends a check of `a` with `condition` beside a put of `b`. */
const run = (
  condition: Expression.ExpressionResult,
  check: (outcome: {
    readonly exit: Exit.Exit<unknown, unknown>
    readonly names: Record<string, string>
  }) => void,
) => {
  const { E, Main } = definitions()
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { E },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    yield* db.entities.E.put({ id: "a", count: 1, plain: 2, tally: { count: 3 } }).asEffect()
    table.take()
    const exit = yield* Effect.exit(
      Transaction.transactWrite([
        Transaction.check(db.entities.E.get({ id: "a" }), condition),
        db.entities.E.put({ id: "b", count: 2, plain: 2, tally: { count: 2 } }),
      ]),
    )
    const write = table.requests.find((request) => request.command === "TransactWriteItems")!
    const names = write.input.TransactItems.find((item: any) => item.ConditionCheck !== undefined)
      .ConditionCheck.ExpressionAttributeNames as Record<string, string>
    check({ exit, names })
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    void,
    unknown
  >
}

const passes = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toBe("")
  expect(Exit.isSuccess(exit)).toBe(true)
}

describe("Transaction.check names the attribute a field is stored in (#236)", () => {
  it.effect("a renamed field, compared", () =>
    run(Expression.condition({ eq: { count: 1 } }), ({ exit, names }) => {
      expect(names).toEqual({ "#count": "renamed" })
      passes(exit)
    }),
  )

  it.effect("a renamed field, tested for existence", () =>
    run(Expression.condition({ attributeExists: "count" }), ({ exit, names }) => {
      expect(names).toEqual({ "#count": "renamed" })
      passes(exit)
    }),
  )

  it.effect("a field stored under its own name, and a stored name, as given", () =>
    run(Expression.condition({ eq: { plain: 2, renamed: 1 } }), ({ exit, names }) => {
      expect(names).toEqual({ "#plain": "plain", "#renamed": "renamed" })
      passes(exit)
    }),
  )

  it.effect("a property below an attribute named as a renamed field, as given", () =>
    run(
      {
        expression: "#t.#c = :v",
        names: { "#t": "tally", "#c": "count" },
        values: { ":v": { N: "3" } },
      },
      ({ exit, names }) => {
        expect(names).toEqual({ "#t": "tally", "#c": "count" })
        passes(exit)
      },
    ),
  )
})
