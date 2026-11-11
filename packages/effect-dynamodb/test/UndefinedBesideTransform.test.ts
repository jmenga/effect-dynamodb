/**
 * A write given `undefined` for a defaulted sparse map beside a transformed field, its other
 * values in the domain form (`{ id, n: 1, data: undefined }` beside `n: Schema.NumberFromString`):
 * every write takes it as it takes the same input beside `n: Schema.Number` (#236). The cases and
 * what 1.40.0 did are in `helpers/UndefinedBesideTransform.ts`;
 * `connected.undefined-beside-transform.test.ts` runs them against DynamoDB Local.
 */

import { it } from "@effect/vitest"
import { Cause, Effect, Exit, type Layer } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  cases,
  definitions,
  expected,
  nameOf,
  seed,
  send,
} from "./helpers/UndefinedBesideTransform.js"

describe("a defaulted field given undefined beside a transformed field, on every write", () => {
  for (const each of cases) {
    it.effect(nameOf(each), () => {
      const table = makeRecordingTable()
      const { E, Main } = definitions(Lib, each)
      return Effect.gen(function* () {
        const db: any = yield* Lib.DynamoClient.make({ entities: { E }, tables: { Main } } as never)
        if (each.overRow) yield* seed(db)
        const exit = yield* Effect.exit(send(Lib, db, each))
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toBe("")
        const read = yield* db.entities.E.get({ id: "a" })
        expect(read.n).toBe(1)
        expect(read.data).toEqual(expected(each).data)
      }).pipe(
        Effect.provide(Main.layer({ name: "t" }) as Layer.Layer<never>),
        Effect.provide(table.layer),
      ) as Effect.Effect<void>
    })
  }
})
