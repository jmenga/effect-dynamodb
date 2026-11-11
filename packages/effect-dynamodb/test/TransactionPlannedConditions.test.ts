/**
 * A planned op's condition with an empty part where none may be (an `or()` with no parts, or a
 * comparison with a value DynamoDB can't store, such as `NaN`) is refused in
 * `Transaction.transactWrite` as every other op's is: a `ValidationError` before any op of the
 * transaction reads or sends anything (#236). Planning compiled it only after the reads, so the
 * transaction died with a defect from `compileExpr`, sometimes after a `GetItem` (also on 1.39.0).
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const definitions = (retained: boolean) => {
  const schema = DynamoSchema.make({ name: "planned", version: 1 })
  const E = Entity.make({
    model: Schema.Struct({ id: Schema.String, n: Schema.optional(Schema.Number) }),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...(retained ? { versioned: { retain: true } } : {}),
  } as never) as any
  const Main = Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}

const or = (_: unknown, ops: any) => ops.or()

/** Each planned op with a condition no write may send, on a plain or a retained entity. */
const cases: ReadonlyArray<
  readonly [name: string, retained: boolean, says: string, op: (db: any) => unknown]
> = [
  [
    "an update with an empty or()",
    false,
    "or() has no parts",
    (db) => db.entities.E.update({ id: "a" }).set({ n: 1 }).condition(or),
  ],
  [
    "an update comparing with NaN",
    false,
    "NaN",
    (db) => db.entities.E.update({ id: "a" }).set({ n: 1 }).condition({ n: Number.NaN }),
  ],
  [
    "a retained entity's update with an empty or()",
    true,
    "or() has no parts",
    (db) => db.entities.E.update({ id: "a" }).set({ n: 1 }).condition(or),
  ],
  [
    "a retained entity's delete with an empty or()",
    true,
    "or() has no parts",
    (db) => db.entities.E.delete({ id: "a" }).condition(or),
  ],
  [
    "a retained entity's delete comparing with NaN",
    true,
    "NaN",
    (db) => db.entities.E.delete({ id: "a" }).condition({ n: Number.NaN }),
  ],
]

describe("a planned op's condition is refused before the transaction reads (#236)", () => {
  for (const [name, retained, says, op] of cases) {
    it.effect(name, () => {
      const { E, Main } = definitions(retained)
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { E },
          tables: { Main },
        } as never) as Effect.Effect<any, never, any>
        yield* db.entities.E.put({ id: "a", n: 1 }).asEffect()
        yield* db.entities.E.put({ id: "b", n: 1 }).asEffect()
        table.take()
        const stored = structuredClone([...table.items])
        // An op the transaction plans first, which reads before it writes.
        const exit = yield* Effect.exit(
          Transaction.transactWrite([db.entities.E.update({ id: "b" }).set({ n: 2 }), op(db)]),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons[0]!._tag).toBe("Fail")
          const error = Cause.squash(exit.cause) as any
          expect(error._tag).toBe("ValidationError")
          expect(error.operation).toBe("transactWrite.condition")
          expect(String(error.cause)).toContain(says)
          expect(String(error.cause)).toContain("Nothing was sent.")
        }
        expect(table.requests).toEqual([])
        expect([...table.items]).toEqual(stored)
      }).pipe(
        Effect.provide(Main.layer({ name: "t" })),
        Effect.provide(table.layer),
      ) as Effect.Effect<void, unknown>
    })
  }
})
