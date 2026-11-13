/**
 * `.clearMap()` beside a `pathSubtract` of an entry the row doesn't hold (#238): left as 1.40.0
 * behaves (named in the changeset). The operand names nothing, DynamoDB refuses the request
 * (`DynamoValidationError`) and nothing is written, as through 1.40.0; it isn't refused before
 * sending with `EDD-9151`, which answers only for entries the clear's read found. On a map a
 * `field:` rename stores whole the request also removes that attribute, as every clear now does.
 * `fixtures/clear-beside-absent-entry-1.40.0.json` holds what 1.40.0 did for each.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, recordingRequests, sortedRows } from "./Kept139.js"
import { comparedCases, expectDiffersOnly } from "./WholeDiff.js"

const define = (renamed: boolean, escapeKeys: boolean) => {
  const model = Schema.Struct({
    id: Schema.String,
    counts: Schema.Record(Schema.String, Schema.Number),
  })
  const Docs = Lib.Entity.make({
    model: Lib.DynamoModel.configure(model, {
      counts: { storedAs: Lib.DynamoModel.SparseMap(), ...(renamed && { field: "sr" }) },
    }),
    entityType: "Doc",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  })
  const MainTable = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "ca", version: 1, escapeKeys }),
    entities: { Docs },
  })
  return { entities: { Docs }, MainTable }
}

interface Record140 {
  readonly outcome: unknown
  readonly requests: ReadonlyArray<unknown>
  readonly rows: ReadonlyArray<unknown>
  readonly read: unknown
}

/** What 1.40.0 did for each case, captured once from the published 1.40.0 (never regenerate). */
const fixture: { readonly generatedFrom: string; readonly cases: Record<string, Record140> } =
  JSON.parse(
    readFileSync(
      new URL("../fixtures/clear-beside-absent-entry-1.40.0.json", import.meta.url),
      "utf8",
    ),
  )

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return { ok: true }
  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "Some") return { fail: (failure.value as { readonly _tag: string })._tag }
  return { die: String(Cause.squash(exit.cause)).slice(0, 160) }
}

const readOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isSuccess(exit) ? { ok: JSON.parse(JSON.stringify(exit.value)) } : outcomeOf(exit)

const onSeeded = (open: OpenTable, renamed: boolean, transaction: boolean, escapeKeys: boolean) =>
  Effect.gen(function* () {
    const { entities, MainTable } = define(renamed, escapeKeys)
    const log: Array<unknown> = []
    return yield* onTable(recordingRequests(open, log), 0, MainTable, { entities }, (db, table) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put({ id: "a", counts: { a: 1 } })
        log.length = 0
        const update = db.entities.Docs.update({ id: "a" })
          .clearMap("counts")
          .pathSubtract({ segments: ["counts#missing"], value: 1 })
        const exit = yield* Effect.exit(
          transaction ? Lib.Transaction.transactWrite([update]) : update.asEffect(),
        )
        const requests = [...log]
        const rows = sortedRows(yield* table.rows)
        const read = readOf(yield* Effect.exit(db.entities.Docs.get({ id: "a" })))
        return { outcome: outcomeOf(exit), requests, rows, read } satisfies Record140
      }),
    )
  })

/** A renamed map's clear also removes its whole attribute (`#sc0`, `sr`): what 1.40.0 left. */
const removesWhole = (transaction: boolean): ReadonlyArray<string> => {
  const at = transaction
    ? "requests[1].transactWriteItems.TransactItems[0].Update"
    : "requests[1].updateItem"
  return [`${at}.UpdateExpression`, `${at}.ExpressionAttributeNames.#sc0`]
}

export const clearBesideAbsentEntrySuite = (open: OpenTable) => {
  const { compared, everyCaseCompared } = comparedCases(
    "clear-beside-absent-entry-1.40.0.json",
    fixture.cases,
  )
  for (const escapeKeys of [false, true]) {
    for (const renamed of [false, true]) {
      for (const transaction of [false, true]) {
        const name =
          `${renamed ? "a renamed" : "an unrenamed"} map, ` +
          `${transaction ? "in a transaction" : "standalone"}, escapeKeys ${escapeKeys}`
        const was = compared(name)
        it.effect(name, () =>
          Effect.gen(function* () {
            const got = yield* onSeeded(open, renamed, transaction, escapeKeys)
            if (renamed) expectDiffersOnly(was, got, removesWhole(transaction))
            else expect(got).toEqual(was)
          }),
        )
      }
    }
  }
  everyCaseCompared()
}
