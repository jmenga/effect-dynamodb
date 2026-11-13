/**
 * `Transaction.check` with a compiled condition (`Expression.condition`) sends an operand that is
 * one of Effect's instances in the form the field stores it (#236), through the encoder a
 * condition on the entity uses (`operandsAsStored`, #242). The builder has no entity, so a
 * `DateTime` was marshalled as its own map, which no row holds: on a `Schema.DateTimeUtc` field,
 * stored as ISO text, `eq` never held and `ne` always did. A condition holding no such operand
 * sends the request it sent before, byte for byte.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const at = DateTime.makeUnsafe("2024-01-02T03:04:05.000Z")

/** Sends a check of `a` with `condition` beside a put of `b`: how it ended, and the check sent. */
const run = (condition: Expression.ExpressionResult) => {
  const E = Entity.make({
    model: Schema.Struct({ id: Schema.String, at: Schema.DateTimeUtc, n: Schema.Number }),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "checks", version: 1 }),
    entities: { E },
  } as never) as any
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { E }, tables: { Main } } as never)
    yield* db.entities.E.put({ id: "a", at, n: 1 }).asEffect()
    table.take()
    const exit = yield* Effect.exit(
      Transaction.transactWrite([
        Transaction.check(db.entities.E.get({ id: "a" }), condition),
        db.entities.E.put({ id: "b", at, n: 2 }),
      ]),
    )
    const write = table.requests.find((request) => request.command === "TransactWriteItems")!
    const sent = write.input.TransactItems.find((item: any) => item.ConditionCheck !== undefined)
      .ConditionCheck as Record<string, unknown>
    return {
      exit,
      sent: {
        ConditionExpression: sent.ConditionExpression,
        ExpressionAttributeNames: sent.ExpressionAttributeNames,
        ExpressionAttributeValues: sent.ExpressionAttributeValues,
      },
    }
  }).pipe(
    Effect.provide(Main.layer({ name: "t" })),
    Effect.provide(table.layer),
  ) as unknown as Effect.Effect<
    {
      readonly exit: Exit.Exit<unknown, unknown>
      readonly sent: Record<string, unknown>
    },
    unknown
  >
}

const holds = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toBe("")
  expect(Exit.isSuccess(exit)).toBe(true)
}

const fails = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect((Cause.squash(exit.cause) as any)._tag).toBe("TransactionCancelled")
  }
}

describe("Transaction.check sends an Effect instance operand as its field stores it (#236)", () => {
  it.effect("a DateTime on a DateTimeUtc field: the ISO text, and the check holds", () =>
    Effect.gen(function* () {
      const got = yield* run(Expression.condition({ eq: { at, n: 1 } }))
      // Only the instance's value changes: the expression and names are the builder's.
      expect(got.sent).toEqual({
        ConditionExpression: "#at = :v0 AND #n = :v1",
        ExpressionAttributeNames: { "#at": "at", "#n": "n" },
        ExpressionAttributeValues: { ":v0": { S: "2024-01-02T03:04:05.000Z" }, ":v1": { N: "1" } },
      })
      holds(got.exit)
    }),
  )

  it.effect("a DateTime the row doesn't hold: the check fails", () =>
    Effect.gen(function* () {
      const other = DateTime.makeUnsafe("2024-01-02T03:04:06.000Z")
      const got = yield* run(Expression.condition({ eq: { at: other } }))
      expect(got.sent.ExpressionAttributeValues).toEqual({
        ":v0": { S: "2024-01-02T03:04:06.000Z" },
      })
      fails(got.exit)
    }),
  )

  it.effect("a condition without one: the request it sent before", () =>
    Effect.gen(function* () {
      const got = yield* run(
        Expression.condition({
          eq: { n: 1 },
          between: { n: [0, 2] },
          beginsWith: { id: "a" },
          attributeExists: "at",
        }),
      )
      expect(got.sent).toEqual({
        ConditionExpression:
          "#n = :v0 AND #n BETWEEN :v1 AND :v2 AND begins_with(#id, :v3) AND attribute_exists(#at)",
        ExpressionAttributeNames: { "#n": "n", "#id": "id", "#at": "at" },
        ExpressionAttributeValues: {
          ":v0": { N: "1" },
          ":v1": { N: "0" },
          ":v2": { N: "2" },
          ":v3": { S: "a" },
        },
      })
      holds(got.exit)
    }),
  )
})
