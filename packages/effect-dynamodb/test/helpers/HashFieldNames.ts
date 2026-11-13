/**
 * A model field whose own name holds `#` (`a#b`, stored as `stored` by a `field:` rename), and a
 * sparse map's entry (`m#k`), named by a path write, a condition, a filter and a projection (#238
 * section 3).
 *
 * Through 1.40.0 a path write and a condition took a first segment holding `#` as a literal
 * attribute name, while a filter and a projection renamed it: `pathSet(["a#b"])` set a top-level
 * `a#b` that no read looks at and left `stored` as it was, and a condition on `t["a#b"]` tested
 * `a#b`, which `put` never stores, so it failed whatever the row held. All four now name the
 * attribute `put` stored, and so does the refusal of a `pathRemove` of a sparse map's entry: a
 * field named like one (`a#b` beside a map stored under `a`) is removed where it's stored, as
 * `.remove()` removes it. A sparse map's entry named through the map (`.entry()`, `removeEntries`)
 * is the entry's attribute whatever field spells it (`EntryBesideField.ts`).
 *
 * `fixtures/hash-field-names-1.39.0.json` holds what the published 1.39.0 did (1.40.0 did the
 * same): the head does the same, except where `expected` says otherwise.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, type Row, recordingRequests } from "./Kept139.js"
import { comparedCases } from "./WholeDiff.js"

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/hash-field-names-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }
const fixtureCases = comparedCases("hash-field-names-1.39.0.json", fixture.cases)

export interface Captured {
  readonly outcome: unknown
  readonly sent: ReadonlyArray<Record<string, unknown>>
  readonly row: Row
  readonly read: unknown
}

const Model = Schema.Struct({
  id: Schema.String,
  "a#b": Schema.Number,
  f: Schema.Record(Schema.String, Schema.Struct({ x: Schema.Number })),
})

const Docs = Lib.Entity.make({
  model: Lib.DynamoModel.configure(Model, {
    "a#b": { field: "stored" },
    f: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "m" }) },
  }),
  entityType: "Doc",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})

/** An optional field named `a#b` beside a sparse map stored under `a`: its name reads as entry `b`. */
const Beside = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      "a#b": Schema.optional(Schema.Number),
      g: Schema.Record(Schema.String, Schema.Number),
    }),
    {
      "a#b": { field: "stored" },
      g: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "a" }) },
    },
  ),
  entityType: "Beside",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})

const MainTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "hash", version: 1 }),
  entities: { Docs, Beside },
})

const SEEDS = {
  Docs: { id: "a", "a#b": 1, f: { k: { x: 1 } } },
  Beside: { id: "a", "a#b": 1, g: { b: 5 } },
} as const

const entityOf = (name: string): keyof typeof SEEDS =>
  name.endsWith("named as an entry") ? "Beside" : "Docs"

const scenarios: Record<string, (db: any) => Effect.Effect<unknown, unknown>> = {
  "pathSet of the field": (db) =>
    db.entities.Docs.update({ id: "a" })
      .pathSet({ segments: ["a#b"], value: 9, isPath: false })
      .asEffect(),
  "a condition on the field": (db) =>
    db.entities.Docs.update({ id: "a" })
      .set({ "a#b": 2 })
      .condition((t: any, { eq }: any) => eq(t["a#b"], 1))
      .asEffect(),
  "a filter on the field": (db) =>
    db.entities.Docs.scan()
      .filter((t: any, { eq }: any) => eq(t["a#b"], 1))
      .collect(),
  "a projection of the field": (db) =>
    db.entities.Docs.scan()
      .select((t: any) => [t["a#b"]])
      .collect(),
  "pathSet of an entry": (db) =>
    db.entities.Docs.update({ id: "a" })
      .pathSet({ segments: ["m#k", "x"], value: 9, isPath: false })
      .asEffect(),
  "a condition on an entry": (db) =>
    db.entities.Docs.update({ id: "a" })
      .set({ "a#b": 2 })
      .condition((t: any, { eq }: any) => eq(t.f.entry("k").x, 1))
      .asEffect(),
  "a filter on an entry": (db) =>
    db.entities.Docs.scan()
      .filter((t: any, { eq }: any) => eq(t.f.entry("k").x, 1))
      .collect(),
  "pathRemove of the field, named as an entry": (db) =>
    db.entities.Beside.update({ id: "a" }).pathRemove(["a#b"]).asEffect(),
  ".remove() of the field, named as an entry": (db) =>
    db.entities.Beside.update({ id: "a" }).remove(["a#b"]).asEffect(),
}

/** Renames the attribute `a#b` names in every request to `stored`. */
const namingStored = (sent: Captured["sent"]): Captured["sent"] =>
  sent.map((request) => ({
    ...request,
    ExpressionAttributeNames: Object.fromEntries(
      Object.entries(request.ExpressionAttributeNames as Record<string, string>).map(
        ([placeholder, name]) => [placeholder, name === "a#b" ? "stored" : name],
      ),
    ),
  }))

const withoutAttribute = (row: Row, name: string): Row =>
  Object.fromEntries(Object.entries(row).filter(([attribute]) => attribute !== name))

/** What the head does: 1.39.0's record, where it named the attribute `put` stored. */
export const expected = (name: string): Captured => {
  const was = fixture.cases[name]!
  switch (name) {
    // The write sets `stored`, the attribute the read decodes, and adds no `a#b`.
    case "pathSet of the field": {
      const read = { ...(was.read as object), "a#b": 9 }
      return {
        outcome: { ok: read },
        sent: namingStored(was.sent),
        row: { ...withoutAttribute(was.row, "a#b"), stored: { N: "9" } },
        read,
      }
    }
    // The condition tests `stored`, which holds 1, so the update is applied.
    case "a condition on the field": {
      const read = { ...(was.read as object), "a#b": 2 }
      return {
        outcome: { ok: read },
        sent: namingStored(was.sent),
        row: { ...was.row, stored: { N: "2" } },
        read,
      }
    }
    // The removal names the field, so it removes `stored`, as `.remove()` does, and leaves the
    // map's entry `a#b` alone. 1.39.0 removed the entry; 1.40.0 refused it as an entry.
    case "pathRemove of the field, named as an entry": {
      const remove = fixture.cases[".remove() of the field, named as an entry"]!
      return { ...remove, sent: namingStored(was.sent) }
    }
    // A query's path builder knows the entity's sparse maps, so the filter names the entry's
    // attribute, as the condition does, and finds the row. Through 1.40.0 `.entry()` threw in any
    // query callback (`EntryInQueries.ts`).
    case "a filter on an entry":
      return {
        ...was,
        outcome: { ok: [was.read] },
        sent: [
          {
            FilterExpression: "#eddE IN (:et0) AND (#e0.#e1 = :e2)",
            ExpressionAttributeNames: { "#e0": "m#k", "#e1": "x", "#eddE": "__edd_e__" },
            ExpressionAttributeValues: { ":e2": { N: "1" }, ":et0": { S: "Doc" } },
          },
        ],
      }
    default:
      return was
  }
}

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value ?? null)) }
  const squashed = Cause.squash(exit.cause) as any
  return {
    [Cause.hasFails(exit.cause) ? "fail" : "die"]: String(squashed?._tag ?? squashed?.name),
    says: String(squashed?.message ?? "").split("\n")[0],
  }
}

const EXPRESSION_PARTS = [
  "UpdateExpression",
  "ConditionExpression",
  "FilterExpression",
  "ProjectionExpression",
  "ExpressionAttributeNames",
  "ExpressionAttributeValues",
] as const

const expressionParts = (request: unknown): Record<string, unknown> => {
  const input = Object.values(request as Record<string, Record<string, unknown>>)[0]!
  return Object.fromEntries(
    EXPRESSION_PARTS.filter((part) => input[part] !== undefined).map((part) => [part, input[part]]),
  )
}

const sortedRow = (row: Row | undefined): Row =>
  Object.fromEntries(
    Object.keys(row ?? {})
      .sort()
      .map((name) => [name, row![name]!]),
  )

/**
 * Each scenario on a table of its own, seeded by `put`. `projects`: whether the table applies a
 * `ProjectionExpression` (DynamoDB Local does; the recording table returns whole items, so a
 * projection's result is compared only there).
 */
export const hashFieldNamesSuite = (open: OpenTable, options: { readonly projects: boolean }) => {
  for (const name of Object.keys(scenarios)) {
    fixtureCases.compared(name)
    it.effect(name, () =>
      Effect.gen(function* () {
        const log: Array<unknown> = []
        const got = yield* onTable(
          recordingRequests(open, log),
          0,
          MainTable,
          { entities: { Docs, Beside } },
          (db, table) =>
            Effect.gen(function* () {
              const entity = entityOf(name)
              yield* db.entities[entity].put(SEEDS[entity]).asEffect()
              log.length = 0
              const exit = yield* Effect.exit(Effect.suspend(() => scenarios[name]!(db)))
              const sent = log.map(expressionParts)
              const rows = yield* table.rows
              const read = yield* db.entities[entity].get({ id: "a" })
              return {
                outcome: outcomeOf(exit),
                sent,
                row: sortedRow(rows[0]),
                read: JSON.parse(JSON.stringify(read)),
              }
            }),
        )
        const want = expected(name)
        expect(got.sent).toEqual(want.sent)
        expect(got.row).toEqual(want.row)
        expect(got.read).toEqual(want.read)
        if (options.projects || name !== "a projection of the field") {
          expect(got.outcome).toEqual(want.outcome)
        }
      }),
    )
  }
  fixtureCases.everyCaseCompared()
}
