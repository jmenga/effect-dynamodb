/**
 * A query operand its composite's kind can't hold exactly (`EDD-9050`): a `bigint` past 2^53 for a
 * number, a fraction for a bigint, plain or string-encoded. It has no key text, and is refused as a
 * value is (`NaN`, `EDD-9096`): the query fails with a `ValidationError` on its error channel and
 * sends nothing. Building the condition has no error channel, so the refusal used to escape it as a
 * thrown `Error` and the query died.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const kinds = [
  { name: "Schema.Number", Kind: Schema.Number, inexact: 9007199254740993n, kind: "number" },
  { name: "Schema.BigInt", Kind: Schema.BigInt, inexact: 1.5, kind: "bigint" },
  {
    name: "Schema.NumberFromString",
    Kind: Schema.NumberFromString,
    inexact: 9007199254740993n,
    kind: "number",
  },
  { name: "Schema.BigIntFromString", Kind: Schema.BigIntFromString, inexact: -1.5, kind: "bigint" },
] as const

const definitions = (Kind: Schema.Top, escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "inexact", version: 1, escapeKeys })
  const model = Schema.Struct({ id: Schema.String, n: Kind })
  const E = Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byN: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["id"] },
        sk: { field: "gsi1sk", composite: ["n"] },
      },
      byKey: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["n"] },
        sk: { field: "gsi2sk", composite: ["id"] },
      },
    },
    timeSeries: { orderBy: "n", appendInput: model },
  } as never) as any
  const Main = Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}

const conditions = {
  eq: (n: unknown) => (t: any, ops: any) => ops.eq(t.n, n),
  gte: (n: unknown) => (t: any, ops: any) => ops.gte(t.n, n),
  between: (n: unknown) => (t: any, ops: any) => ops.between(t.n, n, n),
} as const

describe("a query operand its composite's kind can't hold exactly fails, sending nothing", () => {
  for (const { name, Kind, inexact, kind } of kinds) {
    for (const escapeKeys of [false, true]) {
      const run = (query: (e: any) => any) => {
        const { E, Main } = definitions(Kind, escapeKeys)
        const table = makeRecordingTable({
          indexes: {
            gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
            gsi2: { pk: "gsi2pk", sk: "gsi2sk" },
          },
        })
        return Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { E },
            tables: { Main },
          } as never) as Effect.Effect<any, never, any>
          const exit = yield* Effect.exit(Effect.suspend(() => query(db.entities.E).collect()))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons[0]!
            // On the error channel: a failure, not a defect.
            expect(failure._tag).toBe("Fail")
            const error = Cause.squash(exit.cause) as any
            expect(error._tag).toBe("ValidationError")
            expect(String(error.cause?.message)).toContain(`[EDD-9050] Composite "n"`)
            expect(String(error.cause?.message)).toContain(`is a value no ${kind} holds exactly`)
          }
          expect(table.requests).toEqual([])
        }).pipe(
          Effect.provide(Main.layer({ name: "t" })),
          Effect.provide(table.layer),
        ) as Effect.Effect<void, unknown>
      }

      for (const [op, condition] of Object.entries(conditions)) {
        it.effect(`${name}, escapeKeys ${escapeKeys}: history ${op}`, () =>
          run((e) => e.history({ id: "x" }).where(condition(inexact))),
        )
        it.effect(`${name}, escapeKeys ${escapeKeys}: index ${op}`, () =>
          run((e) => e.byN({ id: "x" }).where(condition(inexact))),
        )
      }

      it.effect(`${name}, escapeKeys ${escapeKeys}: an index's partition key composite`, () =>
        run((e) => e.byKey({ n: inexact })),
      )
    }
  }
})
