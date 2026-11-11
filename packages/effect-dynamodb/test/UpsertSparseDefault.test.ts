/**
 * `upsert` given `undefined` for a sparse map with a decoding default, over a row that's there:
 * every path stores the default's entries beside the stored ones (#236 section 6, resolved as
 * intended behaviour; the cases and why are in `helpers/UpsertSparseDefault.ts`, and
 * `connected.upsert-sparse-default.test.ts` runs them against DynamoDB Local).
 */

import { it } from "@effect/vitest"
import { Cause, Effect, Exit, type Layer } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  cases,
  definitions,
  entriesOf,
  expected,
  nameOf,
  ROW_KEY,
  seed,
  storedEntries,
  upsert,
} from "./helpers/UpsertSparseDefault.js"

describe("upsert of data: undefined over a row that's there, on every path", () => {
  for (const each of cases) {
    it.effect(nameOf(each), () => {
      const table = makeRecordingTable()
      const { E, Main } = definitions(Lib, each)
      return Effect.gen(function* () {
        const db: any = yield* Lib.DynamoClient.make({ entities: { E }, tables: { Main } } as never)
        yield* seed(db)
        table.take()
        const exit = yield* Effect.exit(upsert(db, each))
        const sent = table.take()
        const read = yield* db.entities.E.get({ id: "a" })
        const row = [...table.items.values()].find(
          (item: any) => item.pk?.S === ROW_KEY.pk.S && item.sk?.S === ROW_KEY.sk.S,
        )
        const want = expected(each)
        if (want.failure === undefined) {
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toBe("")
        } else {
          expect(Exit.isFailure(exit)).toBe(true)
          const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
          expect({ error: failure?._tag, operation: failure?.operation }).toEqual(want.failure)
          // Refused citing the default, before anything is sent.
          expect(sent).toEqual([])
        }
        expect(entriesOf(row)).toEqual(storedEntries(want.data))
        expect(read.data).toEqual(want.data)
      }).pipe(
        Effect.provide(Main.layer({ name: "t" }) as Layer.Layer<never>),
        Effect.provide(table.layer),
      ) as Effect.Effect<void>
    })
  }
})
