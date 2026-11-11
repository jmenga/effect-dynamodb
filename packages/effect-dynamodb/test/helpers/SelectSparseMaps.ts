/**
 * A `.select()` naming a sparse map field (#238 section 1). A sparse map is stored one attribute
 * per entry (`m#<key>`), and a `ProjectionExpression` can't name attributes by prefix: through
 * 1.40.0 the select projected `f`, which no row holds, so the map came back absent, on an entity's
 * scan and index query and on a collection alike. A select of a whole map now reads whole rows
 * (the request is the one it sent, without the projection), rebuilds each as a read does and trims
 * it to what was selected. A select of an entry through its map (`t.f.k`) projects the entry's
 * attribute (`m#k`) in place of `f.k`, and rebuilds the map from it (`entryProjections`). A select
 * naming no sparse map sends what it always sent.
 *
 * `fixtures/select-sparse-maps-1.39.0.json` holds what the published 1.39.0 did (1.40.0 did the
 * same): the head sends the same requests, less the projection where a sparse map is named, and
 * returns `expected`'s results there and 1.39.0's elsewhere.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"

interface Captured {
  readonly outcome: { readonly ok?: unknown }
  readonly sent: ReadonlyArray<Record<string, Record<string, unknown>>>
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/select-sparse-maps-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }

const byCat = {
  name: "gsi1",
  pk: { field: "gsi1pk", composite: ["cat"] },
  sk: { field: "gsi1sk", composite: ["id"] },
  collection: "cats",
}

const Docs = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      cat: Schema.String,
      note: Schema.String,
      f: Schema.Record(Schema.String, Schema.Number),
      g: Schema.Record(Schema.String, Schema.Struct({ x: Schema.Number })),
    }),
    {
      note: { field: "nt" },
      f: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "m" }) },
      g: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "gm" }) },
    },
  ),
  entityType: "Doc",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  indexes: { byCat },
} as never) as any

const Notes = Lib.Entity.make({
  model: Schema.Struct({ id: Schema.String, cat: Schema.String, note: Schema.String }),
  entityType: "Note",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  indexes: { byCat },
} as never) as any

const MainTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "sel", version: 1 }),
  entities: { Docs, Notes },
} as never) as any

const scenarios: Record<string, (db: any) => Effect.Effect<unknown, unknown>> = {
  "scan, select(['f'])": (db) => db.entities.Docs.scan().select(["f"]).collect(),
  "scan, select(['id', 'f'])": (db) => db.entities.Docs.scan().select(["id", "f"]).collect(),
  "scan, select(['note', 'f'])": (db) => db.entities.Docs.scan().select(["note", "f"]).collect(),
  "scan, select((t) => [t.f])": (db) =>
    db.entities.Docs.scan()
      .select((t: any) => [t.f])
      .collect(),
  "scan, select((t) => [t.f.k, t.note])": (db) =>
    db.entities.Docs.scan()
      .select((t: any) => [t.f.k, t.note])
      .collect(),
  "scan, select((t) => [t.g.a.x])": (db) =>
    db.entities.Docs.scan()
      .select((t: any) => [t.g.a.x])
      .collect(),
  "scan, select(['id']), no sparse map": (db) => db.entities.Docs.scan().select(["id"]).collect(),
  "index query, select(['f'])": (db) =>
    db.entities.Docs.byCat({ cat: "c" }).select(["f"]).collect(),
  "index query, select(['f']).limit(1).fetch()": (db) =>
    db.entities.Docs.byCat({ cat: "c" }).select(["f"]).limit(1).fetch(),
  "collection, select(['f'])": (db) => db.collections.cats({ cat: "c" }).select(["f"]).collect(),
  "collection, select(['note', 'f'])": (db) =>
    db.collections.cats({ cat: "c" }).select(["note", "f"]).collect(),
  "collection, select(['note']), no sparse map": (db) =>
    db.collections.cats({ cat: "c" }).select(["note"]).collect(),
}

const A = { k: 1, j: 2 }

/** The head's result where it differs from 1.39.0's: the maps a read rebuilds, trimmed. */
const results: Record<string, unknown> = {
  "scan, select(['f'])": [{ f: {} }, { f: A }],
  "scan, select(['id', 'f'])": [
    { id: "b", f: {} },
    { id: "a", f: A },
  ],
  "scan, select(['note', 'f'])": [
    { note: "o", f: {} },
    { note: "n", f: A },
  ],
  "scan, select((t) => [t.f])": [{ f: {} }, { f: A }],
  "scan, select((t) => [t.f.k, t.note])": [{ note: "o" }, { f: { k: 1 }, note: "n" }],
  "scan, select((t) => [t.g.a.x])": [{}, { g: { a: { x: 3 } } }],
  "index query, select(['f'])": [{ f: A }, { f: {} }],
  "index query, select(['f']).limit(1).fetch()": {
    items: [{ f: A }],
    cursor: (fixture.cases["index query, select(['f']).limit(1).fetch()"]!.outcome.ok as any)
      .cursor,
  },
  "collection, select(['f'])": { Docs: [{ f: A }, { f: {} }], Notes: [{}] },
  "collection, select(['note', 'f'])": {
    Docs: [
      { note: "n", f: A },
      { note: "o", f: {} },
    ],
    Notes: [{ note: "p" }],
  },
}

/**
 * What a select of an entry through its map sends now: 1.39.0's request, projecting the entry's
 * attribute (`m#k`, `gm#a`) where 1.39.0 projected the map's field and key (`f.k`), which no row
 * holds.
 */
const entryProjections: Record<string, Captured["sent"]> = {
  "scan, select((t) => [t.f.k, t.note])": [
    {
      scan: {
        FilterExpression: "#eddE IN (:et0)",
        ProjectionExpression: "#proj0, #proj1",
        ExpressionAttributeNames: { "#eddE": "__edd_e__", "#proj0": "m#k", "#proj1": "nt" },
      },
    },
  ],
  "scan, select((t) => [t.g.a.x])": [
    {
      scan: {
        FilterExpression: "#eddE IN (:et0)",
        ProjectionExpression: "#proj0.#proj1",
        ExpressionAttributeNames: { "#eddE": "__edd_e__", "#proj0": "gm#a", "#proj1": "x" },
      },
    },
  ],
}

/** 1.39.0's request, without its projection: what a select of a whole sparse map sends now. */
const withoutProjection = (sent: Captured["sent"]): Captured["sent"] =>
  sent.map((request) =>
    Object.fromEntries(
      Object.entries(request).map(([operation, input]) => {
        const {
          ProjectionExpression: _,
          ExpressionAttributeNames,
          ...rest
        } = input as {
          readonly ProjectionExpression?: string
          readonly ExpressionAttributeNames: Record<string, string>
        }
        const projected = new Set(
          String((input as { ProjectionExpression?: string }).ProjectionExpression ?? "")
            .split(/[,.\s]+/)
            .filter((part) => part.startsWith("#")),
        )
        return [
          operation,
          {
            ...rest,
            ExpressionAttributeNames: Object.fromEntries(
              Object.entries(ExpressionAttributeNames).filter(([name]) => !projected.has(name)),
            ),
          },
        ]
      }),
    ),
  )

const PARTS = [
  "IndexName",
  "KeyConditionExpression",
  "FilterExpression",
  "ProjectionExpression",
  "ExpressionAttributeNames",
  "Limit",
] as const

const partsOf = (request: unknown): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(request as Record<string, Record<string, unknown>>).map(([operation, input]) => [
      operation,
      Object.fromEntries(
        PARTS.filter((part) => input[part] !== undefined).map((part) => [part, input[part]]),
      ),
    ]),
  )

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value ?? null)) }
  const squashed = Cause.squash(exit.cause) as any
  return {
    [Cause.hasFails(exit.cause) ? "fail" : "die"]: String(squashed?._tag ?? squashed?.name),
    says: String(squashed?.message ?? "").split("\n")[0],
  }
}

/** A scan's items in an order independent of the table's (the recording table scans in key order). */
const unordered = (items: unknown): unknown =>
  Array.isArray(items) ? [...items].map((item) => JSON.stringify(item)).sort() : items

/**
 * Each select on a table of its own. `dynamodb`: whether the table is DynamoDB Local, which
 * applies a projection, scans in its own order and words its own `LastEvaluatedKey`; on the
 * recording table, results are compared only where no projection is sent, a scan's in any order,
 * and a cursor not at all.
 */
export const selectSparseMapsSuite = (open: OpenTable, options: { readonly dynamodb: boolean }) => {
  for (const name of Object.keys(scenarios)) {
    const was = fixture.cases[name]!
    const changed = Object.hasOwn(results, name)
    const entry = entryProjections[name]
    it.effect(
      entry !== undefined
        ? `${name}: the map as a read rebuilds it, from the entry's attribute projected`
        : changed
          ? `${name}: the map as a read rebuilds it, with no projection sent`
          : `${name}: does what 1.39.0 did`,
      () =>
        Effect.gen(function* () {
          const log: Array<unknown> = []
          const got = yield* onTable(
            recordingRequests(open, log),
            0,
            MainTable,
            { entities: { Docs, Notes } },
            (db) =>
              Effect.gen(function* () {
                yield* db.entities.Docs.put({
                  id: "a",
                  cat: "c",
                  note: "n",
                  f: A,
                  g: { a: { x: 3 } },
                }).asEffect()
                yield* db.entities.Docs.put({
                  id: "b",
                  cat: "c",
                  note: "o",
                  f: {},
                  g: {},
                }).asEffect()
                yield* db.entities.Notes.put({ id: "c", cat: "c", note: "p" }).asEffect()
                log.length = 0
                const exit = yield* Effect.exit(Effect.suspend(() => scenarios[name]!(db)))
                return { outcome: outcomeOf(exit) as Captured["outcome"], sent: log.map(partsOf) }
              }),
          )
          expect(got.sent).toEqual(entry ?? (changed ? withoutProjection(was.sent) : was.sent))
          const want = changed ? { ok: results[name] } : was.outcome
          if (options.dynamodb) {
            expect(got.outcome).toEqual(want)
          } else if (changed) {
            const ok = got.outcome.ok as any
            const wanted = (want as any).ok
            if (name.startsWith("scan")) expect(unordered(ok)).toEqual(unordered(wanted))
            else if (name.endsWith("fetch()")) expect(ok.items).toEqual(wanted.items)
            else expect(ok).toEqual(wanted)
          }
        }),
    )
  }
}
