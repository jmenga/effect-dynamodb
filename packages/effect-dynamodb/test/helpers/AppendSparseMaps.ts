/**
 * A time-series `.append()` whose `appendInput` holds a sparse map (#238). A map without a
 * `field:` rename is stored as one attribute per entry, and an append writes its fields whole:
 * through 1.40.0 it wrote `zones: { east: "y" }` beside the row's `z#east: "x"`, reported success,
 * and every read returned `{ east: "x" }`. Such an append is refused with a `ValidationError`
 * before anything is sent, as its `.remove()` of the map already was. An empty map writes
 * nothing a read sees, and a renamed map's whole attribute is the form a read takes first, so
 * both are sent as 1.40.0 sent them. `fixtures/append-sparse-maps-1.40.0.json` holds what 1.40.0
 * did for each.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, recordingRequests, sortedRows } from "./Kept139.js"
import { comparedCases, expectDiffersOnly } from "./WholeDiff.js"

const fields = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  zones: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  named: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})

const define = (escapeKeys: boolean) => {
  const Logs = Lib.Entity.make({
    model: Lib.DynamoModel.configure(fields, {
      zones: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "z" }) },
      named: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "n" }), field: "nm" },
    }),
    entityType: "Log",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: { orderBy: "at", appendInput: fields },
  })
  const MainTable = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "ap", version: 1, escapeKeys }),
    entities: { Logs },
  })
  return { entities: { Logs }, MainTable }
}

type Db = any

/** What each case does to a row holding `z#east` and `n#south`, and the paths it differs at. */
const cases: ReadonlyArray<
  readonly [
    name: string,
    run: (db: Db) => Effect.Effect<unknown, unknown>,
    differs?: ReadonlyArray<string>,
  ]
> = [
  [
    "an append of the unrenamed map's entries",
    (db) => db.entities.Logs.append({ id: "h", at: 2, zones: { east: "y" } }).asEffect(),
    // 1.40.0 sent the append (a read, then the transaction) and wrote `zones` whole beside
    // `z#east`, `at` 2 and the event item `e#2`, and read `{ east: "x" }`: refused, nothing sent.
    [
      "outcome.ok",
      "outcome.fail",
      "outcome.says",
      "requests[0]",
      "requests[1]",
      "rows[0].at.N",
      "rows[0].zones",
      "rows[2]",
      "read.at",
    ],
  ],
  [
    "an append of the unrenamed map empty",
    (db) => db.entities.Logs.append({ id: "h", at: 2, zones: {} }).asEffect(),
  ],
  [
    "an append of the renamed map's entries",
    (db) => db.entities.Logs.append({ id: "h", at: 2, named: { west: "w" } }).asEffect(),
  ],
  [
    "an append of the renamed map empty",
    (db) => db.entities.Logs.append({ id: "h", at: 2, named: {} }).asEffect(),
  ],
  [
    "an append removing the unrenamed map",
    (db) => db.entities.Logs.append({ id: "h", at: 2 }).remove(["zones"]).asEffect(),
  ],
  ["an append of neither map", (db) => db.entities.Logs.append({ id: "h", at: 2 }).asEffect()],
]

interface Record140 {
  readonly outcome: unknown
  readonly requests: ReadonlyArray<unknown>
  readonly rows: ReadonlyArray<unknown>
  readonly read: unknown
}

/** What 1.40.0 did for each case, captured once from the published 1.40.0 (never regenerate). */
const fixture: { readonly generatedFrom: string; readonly cases: Record<string, Record140> } =
  JSON.parse(
    readFileSync(new URL("../fixtures/append-sparse-maps-1.40.0.json", import.meta.url), "utf8"),
  )

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return { ok: true }
  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "Some") {
    const error = failure.value as { readonly _tag: string; readonly cause?: unknown }
    return { fail: error._tag, says: String(error.cause ?? "") }
  }
  return { die: String(Cause.squash(exit.cause)).slice(0, 160) }
}

const onSeeded = (
  open: OpenTable,
  escapeKeys: boolean,
  run: (db: Db) => Effect.Effect<unknown, unknown>,
) =>
  Effect.gen(function* () {
    const { entities, MainTable } = define(escapeKeys)
    const log: Array<unknown> = []
    return yield* onTable(recordingRequests(open, log), 0, MainTable, { entities }, (db, table) =>
      Effect.gen(function* () {
        yield* db.entities.Logs.append({ id: "h", at: 1 })
        yield* db.entities.Logs.update({ id: "h" }).set({
          zones: { east: "x" },
          named: { south: "s" },
        })
        log.length = 0
        const exit = yield* Effect.exit(Effect.suspend(() => run(db)))
        const requests = [...log]
        const rows = sortedRows(yield* table.rows)
        const read = yield* db.entities.Logs.get({ id: "h" })
        return { outcome: outcomeOf(exit), requests, rows, read } satisfies Record140
      }),
    )
  })

const caseName = (name: string, escapeKeys: boolean) => `${name}, escapeKeys ${escapeKeys}`

export const appendSparseMapsSuite = (open: OpenTable) => {
  const { compared, asserted, everyCaseCompared } = comparedCases(
    "append-sparse-maps-1.40.0.json",
    fixture.cases,
  )
  for (const escapeKeys of [false, true]) {
    for (const [what, run, differs] of cases) {
      const name = caseName(what, escapeKeys)
      const was = compared(name)
      it.effect(name, () =>
        Effect.gen(function* () {
          const got = yield* onSeeded(open, escapeKeys, run)
          if (differs === undefined) expect(got).toEqual(was)
          else expectDiffersOnly(was, got, differs)
          asserted(name)
        }),
      )
    }
  }
  everyCaseCompared()

  it("a poisoned fixture record fails the comparison", () => {
    const was = fixture.cases[caseName("an append of the renamed map's entries", false)]!
    const poisoned = JSON.parse(JSON.stringify(was).replace('"w"', '"v"'))
    expect(() => expect(poisoned).toEqual(was)).toThrow()
  })
}
