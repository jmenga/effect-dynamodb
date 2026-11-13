/**
 * A sparse map's entry named through the map, beside a model field that carries the entry's
 * attribute name (#238): `g` stored under the prefix `a`, and an optional field named `a#b`
 * stored as `stored`, so the map's entry `b` is the attribute `a#b`.
 *
 * The field wins only for a bare segment the caller spells `a#b` (`HashFieldNames.ts`). Naming
 * the entry through the map (`.entry("b")` in a condition, `.set({ g: { b } })`, `removeEntries`,
 * a path operation on segments `.entry()` built) names the attribute `a#b`, never the field's
 * rename: the path `.entry()` built carries that it's an entry. Before that, section 3's rename of a
 * first segment turned a condition on `t.g.entry("b")` into one on `stored`, so a guarded delete
 * fired where the entry didn't hold and an update was refused where it did.
 *
 * `fixtures/entry-beside-field-1.40.0.json` holds what the published 1.40.0 did, every request
 * whole: the head does the same, except a path write on a unique entity, where 1.40.0 took the
 * entry's attribute for the unique field and wrote the field (`expected`, `CHANGED`).
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, type Row, recordingRequests } from "./Kept139.js"
import { wholeOf } from "./RenamedSparseMapWrites.js"
import { comparedCases, expectDiffersOnly } from "./WholeDiff.js"

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/entry-beside-field-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }
const fixtureCases = comparedCases("entry-beside-field-1.40.0.json", fixture.cases)

export interface Captured {
  readonly outcome: unknown
  readonly sent: ReadonlyArray<Record<string, unknown>>
  readonly row: Row | null
  readonly read: unknown
}

const model = () =>
  Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      "a#b": Schema.optional(Schema.Number),
      g: Schema.Record(Schema.String, Schema.Number),
    }),
    {
      "a#b": { field: "stored" },
      g: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "a" }) },
    },
  )
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const
const Beside = Lib.Entity.make({ model: model(), entityType: "Beside", primaryKey })
const Retained = Lib.Entity.make({
  model: model(),
  entityType: "Retained",
  primaryKey,
  versioned: { retain: true },
})
const Unique = Lib.Entity.make({
  model: model(),
  entityType: "Unique",
  primaryKey,
  unique: { byField: ["a#b"] },
})
const entities = { Beside, Retained, Unique }
const MainTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "eb", version: 1 }),
  entities,
})

const SEED = { id: "a", "a#b": 1, g: { b: 5 } }

/** Segments `.entry()` built, as a caller holding a path builder has them. */
const builtEntry = () =>
  (Lib.createPathBuilder([], undefined, { g: { prefix: "a" } }) as any).g.entry("b").segments

type Scenario = readonly [
  entity: keyof typeof entities,
  run: (db: any) => Effect.Effect<unknown, unknown, any>,
]

const scenarios: Record<string, Scenario> = {}
for (const E of ["Beside", "Retained", "Unique"] as const) {
  const op = (db: any) => db.entities[E]
  scenarios[`${E}: a delete guarded on the entry, which doesn't hold`] = [
    E,
    (db) =>
      op(db)
        .delete({ id: "a" })
        .condition((t: any, { eq }: any) => eq(t.g.entry("b"), 1))
        .asEffect(),
  ]
  scenarios[`${E}: a delete guarded on the entry, which holds`] = [
    E,
    (db) =>
      op(db)
        .delete({ id: "a" })
        .condition((t: any, { eq }: any) => eq(t.g.entry("b"), 5))
        .asEffect(),
  ]
  scenarios[`${E}: an update guarded on the entry, which holds`] = [
    E,
    (db) =>
      op(db)
        .update({ id: "a" })
        .set({ "a#b": 2 })
        .condition((t: any, { eq }: any) => eq(t.g.entry("b"), 5))
        .asEffect(),
  ]
  scenarios[`${E}: an update guarded on the entry, which doesn't hold`] = [
    E,
    (db) =>
      op(db)
        .update({ id: "a" })
        .set({ "a#b": 2 })
        .condition((t: any, { eq }: any) => eq(t.g.entry("b"), 1))
        .asEffect(),
  ]
  scenarios[`${E}: a write of the entry guarded on it`] = [
    E,
    (db) =>
      op(db)
        .update({ id: "a" })
        .set({ g: { b: 7 } })
        .condition((t: any, { eq }: any) => eq(t.g.entry("b"), 5))
        .asEffect(),
  ]
  scenarios[`${E}: a condition that the entry exists`] = [
    E,
    (db) =>
      op(db)
        .update({ id: "a" })
        .set({ "a#b": 2 })
        .condition((t: any, { exists }: any) => exists(t.g.entry("b")))
        .asEffect(),
  ]
  scenarios[`${E}: removeEntries of the entry`] = [
    E,
    (db) => op(db).update({ id: "a" }).removeEntries("g", ["b"]).asEffect(),
  ]
  scenarios[`${E}: pathSet of the entry .entry() built`] = [
    E,
    (db) =>
      op(db)
        .update({ id: "a" })
        .pathSet({ segments: builtEntry(), value: 8, isPath: false })
        .asEffect(),
  ]
  scenarios[`${E}: pathAdd of the entry .entry() built`] = [
    E,
    (db) => op(db).update({ id: "a" }).pathAdd({ segments: builtEntry(), value: 1 }).asEffect(),
  ]
  scenarios[`${E}: pathRemove of the entry .entry() built`] = [
    E,
    (db) => op(db).update({ id: "a" }).pathRemove(builtEntry()).asEffect(),
  ]
}
scenarios["transactWrite: a delete guarded on the entry, which doesn't hold"] = [
  "Beside",
  (db) =>
    Lib.Transaction.transactWrite([
      db.entities.Beside.delete({ id: "a" }).condition((t: any, { eq }: any) =>
        eq(t.g.entry("b"), 1),
      ),
    ]),
]
scenarios["transactWrite: an update guarded on the entry, which holds"] = [
  "Beside",
  (db) =>
    Lib.Transaction.transactWrite([
      db.entities.Beside.update({ id: "a" })
        .set({ "a#b": 2 })
        .condition((t: any, { eq }: any) => eq(t.g.entry("b"), 5)),
    ]),
]

/** As `Beside` does it, on the unique entity's row. */
const asOnUnique = (captured: Captured): Captured =>
  JSON.parse(JSON.stringify(captured).replaceAll("Beside", "Unique").replaceAll("beside", "unique"))

/** What the head does: 1.40.0's record, but for the cases noted. */
export const expected = (name: string): Captured => {
  // 1.40.0 took the attribute `a#b` of a path operation on a unique entity for the unique field and
  // wrote the field (`stored`), through the unique path. The entry `.entry()` built is the entry.
  if (name.startsWith("Unique: pathSet") || name.startsWith("Unique: pathAdd")) {
    return asOnUnique(fixture.cases[name.replace("Unique", "Beside")]!)
  }
  return fixture.cases[name]!
}

/**
 * Where the head's case differs from 1.40.0's own: one write of the entry, where 1.40.0 read the
 * row and the unique sentinel and wrote the field through a transaction.
 */
const CHANGED = [
  "outcome.ok.a#b",
  "outcome.ok.g.b",
  "read.a#b",
  "read.g.b",
  "row.a#b.N",
  "row.stored.N",
  "sent[0].getItem",
  "sent[0].updateItem",
  "sent[1]",
  "sent[2]",
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const normal = (value: unknown): any =>
  JSON.parse(JSON.stringify(value ?? null), (_key, held) =>
    typeof held === "string" && (UUID.test(held) || held === "<uuid>")
      ? "<token>"
      : typeof held === "string" && ISO.test(held)
        ? "<time>"
        : held,
  )

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return { ok: normal(exit.value) }
  const squashed = Cause.squash(exit.cause) as any
  return {
    [Cause.hasFails(exit.cause) ? "fail" : "die"]: String(squashed?._tag ?? squashed?.name),
    says: String(squashed?.message ?? "")
      .split("\n")[0]!
      .slice(0, 160),
  }
}

const rowOf = (rows: ReadonlyArray<Row>, entity: string): Row | null => {
  const row = rows.find(
    (r) =>
      r.pk?.S === `$eb#v1#${entity.toLowerCase()}#id_a` &&
      r.sk?.S === `$eb#v1#${entity.toLowerCase()}`,
  )
  if (row === undefined) return null
  return normal(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .filter((name) => name !== "createdAt" && name !== "updatedAt")
        .map((name) => [name, row[name]]),
    ),
  )
}

/** Each scenario on a table of its own: the outcome, every request it sent, the row and its read. */
export const entryBesideFieldSuite = (open: OpenTable) => {
  for (const [name, [entity, run]] of Object.entries(scenarios)) {
    const was = fixtureCases.compared(name)
    it.effect(name, () =>
      Effect.gen(function* () {
        const log: Array<unknown> = []
        const got = yield* onTable(
          recordingRequests(open, log),
          0,
          MainTable,
          { entities },
          (db, table) =>
            Effect.gen(function* () {
              for (const seeded of ["Beside", "Unique"] as const) {
                if (seeded === entity || name.startsWith("transactWrite")) {
                  yield* db.entities[seeded].put(SEED).asEffect()
                }
              }
              if (entity === "Retained") yield* db.entities.Retained.put(SEED).asEffect()
              log.length = 0
              const exit = yield* Effect.exit(Effect.suspend(() => run(db)))
              const sent = log.map((request) => wholeOf(request, table.name))
              const row = rowOf(yield* table.rows, entity)
              const read = yield* Effect.exit(db.entities[entity].get({ id: "a" }))
              return {
                outcome: outcomeOf(exit),
                sent,
                row,
                read: Exit.isSuccess(read)
                  ? normal(read.value)
                  : { fail: String((Cause.squash(read.cause) as any)?._tag) },
              }
            }),
        )
        const want = expected(name)
        expect(got.sent).toEqual(want.sent)
        expect(got.row).toEqual(want.row)
        expect(got.read).toEqual(want.read)
        expect(got.outcome).toEqual(want.outcome)
        expectDiffersOnly(was, got, want === was ? [] : CHANGED)
      }),
    )
  }
  fixtureCases.everyCaseCompared()
}
