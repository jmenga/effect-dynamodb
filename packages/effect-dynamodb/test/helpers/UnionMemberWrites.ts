/**
 * Path writes into a union whose members a path names differently, or that a write can move a
 * row out of (#238). `fixtures/union-member-writes-1.40.0.json` holds what 1.40.0 did for each, on
 * a standalone update, in a transaction, on a retained entity and on one with a unique constraint.
 *
 * - Members that rename their keys crosswise (`x` stored as `y` in one, `y` as `x` in the other):
 *   no one name is right for every row, so the path is written as given, as 1.40.0 wrote it, and
 *   the row reads back as 1.40.0 read it.
 * - Members that store the discriminator under different names: written as given, as 1.40.0 wrote
 *   it; the row still reads as the member it held (named in the changeset).
 * - A discriminator set alone to another member's tag, in a field and in a sparse map's entry:
 *   sent as 1.40.0 sent it; no read takes the row (named in the changeset).
 * - A recursive union (`Schema.suspend`): written as 1.40.0 wrote it.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, recordingRequests, sortedRows } from "./Kept139.js"
import { comparedCases } from "./WholeDiff.js"

const A = Schema.Struct({ kind: Schema.Literal("a"), x: Schema.Number })
const B = Schema.Struct({ kind: Schema.Literal("b"), y: Schema.Number })

const Tree: Schema.Codec<unknown> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("leaf"), v: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal("node"),
    kids: Schema.Array(Schema.suspend((): Schema.Codec<unknown> => Tree)),
  }),
])

type Mode = "standalone" | "transaction" | "retained" | "unique"

type Case = {
  readonly f: Schema.Top
  readonly sparse?: true
  readonly seed: unknown
  readonly sets: ReadonlyArray<readonly [ReadonlyArray<string | number>, unknown]>
}

const cases: ReadonlyArray<readonly [name: string, Case]> = [
  [
    "members renaming their keys crosswise, moved to the other member",
    {
      f: Schema.Union([
        A.pipe(Schema.encodeKeys({ kind: "k", x: "y" })),
        B.pipe(Schema.encodeKeys({ kind: "k", y: "x" })),
      ]),
      seed: { kind: "a", x: 1 },
      sets: [
        [["f", "kind"], "b"],
        [["f", "y"], 2],
      ],
    },
  ],
  [
    "members storing the discriminator under different names, moved to the other member",
    {
      f: Schema.Union([
        A.pipe(Schema.encodeKeys({ kind: "ka", x: "xa" })),
        B.pipe(Schema.encodeKeys({ kind: "kb", y: "yb" })),
      ]),
      seed: { kind: "a", x: 1 },
      sets: [
        [["f", "kind"], "b"],
        [["f", "y"], 2],
      ],
    },
  ],
  [
    "the discriminator alone set to the first member's tag",
    { f: Schema.Union([A, B]), seed: { kind: "b", y: 1 }, sets: [[["f", "kind"], "a"]] },
  ],
  [
    "the discriminator alone set to another member's tag in a sparse map's entry",
    {
      f: Schema.Record(Schema.String, Schema.Union([A, B])),
      sparse: true,
      seed: { e: { kind: "a", x: 1 } },
      sets: [[["f#e", "kind"], "b"]],
    },
  ],
  [
    "a value in a recursive union",
    {
      f: Tree,
      seed: { kind: "node", kids: [{ kind: "leaf", v: 1 }] },
      sets: [[["f", "kids", 0, "v"], 2]],
    },
  ],
]

const define = (c: Case, mode: Mode, escapeKeys: boolean) => {
  const fields = { id: Schema.String, f: c.f, email: Schema.String }
  const model = Schema.Struct(fields)
  const Docs = Lib.Entity.make({
    model: c.sparse
      ? Lib.DynamoModel.configure(model, { f: { storedAs: Lib.DynamoModel.SparseMap() } } as never)
      : model,
    entityType: "Doc",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    ...(mode === "retained" && { versioned: { retain: true } }),
    ...(mode === "unique" && { unique: { email: ["email"] } }),
  } as never) as any
  const MainTable = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "um", version: 1, escapeKeys }),
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
    readFileSync(new URL("../fixtures/union-member-writes-1.40.0.json", import.meta.url), "utf8"),
  )

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return { ok: true }
  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "Some") {
    const error = failure.value as { readonly _tag: string; readonly cause?: unknown }
    return { fail: error._tag, says: String(error.cause ?? "").slice(0, 200) }
  }
  return { die: String(Cause.squash(exit.cause)).slice(0, 160) }
}

const readOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isSuccess(exit) ? { ok: JSON.parse(JSON.stringify(exit.value)) } : outcomeOf(exit)

const onSeeded = (open: OpenTable, c: Case, mode: Mode, escapeKeys: boolean) =>
  Effect.gen(function* () {
    const { entities, MainTable } = define(c, mode, escapeKeys)
    const log: Array<unknown> = []
    return yield* onTable(recordingRequests(open, log), 0, MainTable, { entities }, (db, table) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put({ id: "a", f: c.seed, email: "e" })
        log.length = 0
        let update = db.entities.Docs.update({ id: "a" })
        for (const [path, value] of c.sets) {
          update = update.pathSet({ segments: path, value })
        }
        const exit = yield* Effect.exit(
          mode === "transaction"
            ? Lib.Transaction.transactWrite([update])
            : (update.asEffect() as Effect.Effect<unknown, unknown>),
        )
        const requests = [...log]
        const rows = sortedRows(yield* table.rows)
        const read = readOf(yield* Effect.exit(db.entities.Docs.get({ id: "a" })))
        return { outcome: outcomeOf(exit), requests, rows, read } satisfies Record140
      }),
    )
  })

const caseName = (name: string, mode: Mode, escapeKeys: boolean) =>
  `${name}, ${mode}, escapeKeys ${escapeKeys}`

export const unionMemberWritesSuite = (open: OpenTable) => {
  const { compared, asserted, everyCaseCompared } = comparedCases(
    "union-member-writes-1.40.0.json",
    fixture.cases,
  )
  for (const escapeKeys of [false, true]) {
    for (const mode of ["standalone", "transaction", "retained", "unique"] as const) {
      for (const [what, c] of cases) {
        const name = caseName(what, mode, escapeKeys)
        const was = compared(name)
        it.effect(name, () =>
          Effect.gen(function* () {
            const got = yield* onSeeded(open, c, mode, escapeKeys)
            expect(got).toEqual(was)
            asserted(name)
          }),
        )
      }
    }
  }
  everyCaseCompared()
}
