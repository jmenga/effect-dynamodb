/**
 * An aggregate `list` filter on a root whose structs rename their keys as they're stored
 * (`Schema.encodeKeys`), against what the published 1.40.0 did
 * (`fixtures/aggregate-list-filters-1.40.0.json`, every request whole).
 *
 * A filter names each path as an entity query's filter names it (#238): a path spelled by stored
 * names (`meta.am`, `outer.in.dp`, and `swap.a` where `encodeKeys({ a: "b", b: "a" })` stores
 * property `b` under `a`), a path through a union whose members name it differently
 * (`either.amount`), a path below a struct that renames nothing, and every filter on a root that
 * renames nothing, send what 1.40.0 sent. A path spelled by a property's own name (`meta.amount`),
 * which 1.40.0 sent as written, naming an attribute no root row holds (so the filter matched
 * nothing, or, under `not`, everything), now sends what its stored spelling sent on 1.40.0, and
 * lists what it listed.
 *
 * An aggregate takes no `DynamoModel.configure` model, so no top-level field is stored under
 * another name: 1.40.0 failed to make one.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"
import { outcomeOf } from "./RenamedSparseMap.js"
import { wholeOf } from "./RenamedSparseMapWrites.js"

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-list-filters-1.40.0.json", import.meta.url), "utf8"),
) as {
  readonly cases: Record<
    string,
    { readonly outcome: unknown; readonly sent: ReadonlyArray<unknown> }
  >
}

const S = Schema
const Amount = S.Struct({
  amount: S.Number,
  note: S.optional(S.String),
  tags: S.optional(S.Array(S.String)),
}).pipe(S.encodeKeys({ amount: "am", tags: "tg" }))
const Swap = S.Struct({ a: S.Number, b: S.Number }).pipe(S.encodeKeys({ a: "b", b: "a" }))
const Deep = S.Struct({ deep: S.Number }).pipe(S.encodeKeys({ deep: "dp" }))
const Outer = S.Struct({ inner: Deep, list: S.Array(Deep) }).pipe(S.encodeKeys({ inner: "in" }))
const Other = S.Struct({ amount: S.Number, kind: S.Literal("other") })
const Line = S.Struct({ lineId: S.String, sku: S.String })
const Renamed = S.Struct({
  matchId: S.String,
  tournament: S.String,
  name: S.String,
  title: S.String,
  meta: Amount,
  swap: Swap,
  outer: Outer,
  recs: S.Record(S.String, Deep),
  either: S.Union([Amount, Other]),
  maybe: S.optional(S.NullOr(Amount)),
  plain: S.Struct({ x: S.Number, ys: S.Array(S.Number) }),
  lines: S.Array(Line),
})
const Unrenamed = S.Struct({
  matchId: S.String,
  tournament: S.String,
  name: S.String,
  title: S.String,
  meta: S.Struct({ amount: S.Number, tags: S.optional(S.Array(S.String)) }),
  recs: S.Record(S.String, S.Struct({ deep: S.Number })),
  plain: S.Struct({ x: S.Number, ys: S.Array(S.Number) }),
  lines: S.Array(Line),
})
const Anchors = Lib.Entity.make({
  model: S.Struct({ anchorId: S.String }),
  entityType: "Anchor",
  primaryKey: {
    pk: { field: "pk", composite: ["anchorId"] },
    sk: { field: "sk", composite: [] },
  },
})
const schema = Lib.DynamoSchema.make({ name: "alf", version: 1 })
const Base = Lib.Table.make({ schema, entities: { Anchors } })
const aggregate = (model: Schema.Top, entityType: string, list: string): any =>
  Lib.Aggregate.make(
    model as never,
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["matchId"] },
      collection: { name: entityType.toLowerCase() },
      list: {
        index: "gsi1",
        name: list,
        pk: { field: "gsi1pk", composite: ["tournament"] },
        sk: { field: "gsi1sk", composite: ["name"] },
      },
      root: { entityType },
      edges: { lines: Lib.Aggregate.many({ entityType: `${entityType}Line` }) },
    } as never,
  )
const Matches = aggregate(Renamed, "Match", "matches")
const Games = aggregate(Unrenamed, "Game", "games")
const aggregates = { Matches, Games }
const MainTable = { ...Base, aggregates } as any

const seed = (db: any) =>
  Effect.gen(function* () {
    const line = [{ lineId: "l1", sku: "s" }]
    const matches = db.aggregates.Matches
    yield* matches.create({
      matchId: "m1",
      tournament: "t",
      name: "a",
      title: "x",
      meta: { amount: 5, note: "n", tags: ["tag"] },
      swap: { a: 1, b: 2 },
      outer: { inner: { deep: 3 }, list: [{ deep: 4 }, { deep: 6 }] },
      recs: { k: { deep: 8 } },
      either: { amount: 9 },
      maybe: { amount: 7 },
      plain: { x: 1, ys: [1, 2] },
      lines: line,
    })
    yield* matches.create({
      matchId: "m2",
      tournament: "t",
      name: "b",
      title: "y",
      meta: { amount: 50 },
      swap: { a: 10, b: 20 },
      outer: { inner: { deep: 30 }, list: [] },
      recs: {},
      either: { amount: 90, kind: "other" },
      maybe: null,
      plain: { x: 2, ys: [] },
      lines: [],
    })
    const games = db.aggregates.Games
    yield* games.create({
      matchId: "g1",
      tournament: "t",
      name: "a",
      title: "x",
      meta: { amount: 5, tags: ["tag"] },
      recs: { k: { deep: 8 } },
      plain: { x: 1, ys: [1, 2] },
      lines: line,
    })
    yield* games.create({
      matchId: "g2",
      tournament: "t",
      name: "b",
      title: "y",
      meta: { amount: 50 },
      recs: {},
      plain: { x: 2, ys: [] },
      lines: [],
    })
  })

/** Label, aggregate, filter, and, for a path spelled by a property's own name, its stored twin. */
const cases: ReadonlyArray<
  readonly [label: string, aggregate: keyof typeof aggregates, filter: unknown, twin?: string]
> = [
  ["meta.amount", "Matches", (t: any, { eq }: any) => eq(t.meta.amount, 5), "meta.am"],
  ["meta.am", "Matches", (t: any, { eq }: any) => eq(t.meta.am, 5)],
  [
    "exists meta.tags",
    "Matches",
    (t: any, { exists }: any) => exists(t.meta.tags),
    "exists meta.tg",
  ],
  ["exists meta.tg", "Matches", (t: any, { exists }: any) => exists(t.meta.tg)],
  [
    "contains meta.tags",
    "Matches",
    (t: any, { contains }: any) => contains(t.meta.tags, "tag"),
    "contains meta.tg",
  ],
  ["contains meta.tg", "Matches", (t: any, { contains }: any) => contains(t.meta.tg, "tag")],
  ["size meta.tags", "Matches", (t: any, { gt }: any) => gt(t.meta.tags.size(), 0), "size meta.tg"],
  ["size meta.tg", "Matches", (t: any, { gt }: any) => gt(t.meta.tg.size(), 0)],
  [
    "meta.amount below maybe.amount",
    "Matches",
    (t: any, { lt }: any) => lt(t.meta.amount, t.maybe.amount),
    "meta.am below maybe.am",
  ],
  ["meta.am below maybe.am", "Matches", (t: any, { lt }: any) => lt(t.meta.am, t.maybe.am)],
  ["meta.note", "Matches", (t: any, { eq }: any) => eq(t.meta.note, "n")],
  ["swap.a", "Matches", (t: any, { eq }: any) => eq(t.swap.a, 1)],
  ["swap.b", "Matches", (t: any, { eq }: any) => eq(t.swap.b, 1)],
  [
    "outer.inner.deep",
    "Matches",
    (t: any, { eq }: any) => eq(t.outer.inner.deep, 3),
    "outer.in.dp",
  ],
  ["outer.in.dp", "Matches", (t: any, { eq }: any) => eq(t.outer.in.dp, 3)],
  [
    "outer.list[0].deep",
    "Matches",
    (t: any, { eq }: any) => eq(t.outer.list.at(0).deep, 4),
    "outer.list[0].dp",
  ],
  ["outer.list[0].dp", "Matches", (t: any, { eq }: any) => eq(t.outer.list.at(0).dp, 4)],
  ["recs.k.deep", "Matches", (t: any, { eq }: any) => eq(t.recs.k.deep, 8), "recs.k.dp"],
  ["recs.k.dp", "Matches", (t: any, { eq }: any) => eq(t.recs.k.dp, 8)],
  ["either.amount", "Matches", (t: any, { eq }: any) => eq(t.either.amount, 9)],
  ["maybe.amount", "Matches", (t: any, { eq }: any) => eq(t.maybe.amount, 7), "maybe.am"],
  ["maybe.am", "Matches", (t: any, { eq }: any) => eq(t.maybe.am, 7)],
  ["plain.x", "Matches", (t: any, { eq }: any) => eq(t.plain.x, 1)],
  ["plain.ys[1]", "Matches", (t: any, { eq }: any) => eq(t.plain.ys.at(1), 2)],
  ["title", "Matches", (t: any, { eq }: any) => eq(t.title, "x")],
  ["title shorthand", "Matches", { title: "x" }],
  [
    "title and meta.amount",
    "Matches",
    (t: any, { and, eq }: any) => and(eq(t.title, "x"), eq(t.meta.amount, 5)),
    "title and meta.am",
  ],
  [
    "title and meta.am",
    "Matches",
    (t: any, { and, eq }: any) => and(eq(t.title, "x"), eq(t.meta.am, 5)),
  ],
  [
    "not meta.amount",
    "Matches",
    (t: any, { not, eq }: any) => not(eq(t.meta.amount, 5)),
    "not meta.am",
  ],
  ["not meta.am", "Matches", (t: any, { not, eq }: any) => not(eq(t.meta.am, 5))],
  ["games: meta.amount", "Games", (t: any, { eq }: any) => eq(t.meta.amount, 5)],
  ["games: size meta.tags", "Games", (t: any, { gt }: any) => gt(t.meta.tags.size(), 0)],
  ["games: recs.k.deep", "Games", (t: any, { eq }: any) => eq(t.recs.k.deep, 8)],
  ["games: plain.ys[1]", "Games", (t: any, { eq }: any) => eq(t.plain.ys.at(1), 2)],
  ["games: title shorthand", "Games", { title: "x" }],
  ["games: no filter", "Games", undefined],
]

export const aggregateListFiltersSuite = (open: OpenTable) => {
  it("captures every case 1.40.0 was asked", () => {
    expect(cases.map(([label]) => label).sort()).toEqual(Object.keys(fixture.cases).sort())
  })
  for (const [label, name, filter, twin] of cases) {
    const was = fixture.cases[label]!
    const expected = fixture.cases[twin ?? label]!
    it.effect(
      twin === undefined
        ? `list filter ${label}: as 1.40.0`
        : `list filter ${label}: as 1.40.0 sent ${twin}, where it listed ${JSON.stringify((was.outcome as any).ok?.data?.map((row: any) => row.matchId))}`,
      () =>
        Effect.gen(function* () {
          const log: Array<unknown> = []
          const { outcome, sent } = yield* onTable(
            recordingRequests(open, log),
            0,
            MainTable,
            { entities: { Anchors }, aggregates },
            (db, table) =>
              Effect.gen(function* () {
                yield* seed(db)
                log.length = 0
                const exit = yield* Effect.exit(
                  db.aggregates[name].list(
                    { tournament: "t" },
                    filter === undefined ? undefined : { filter },
                  ),
                )
                return {
                  outcome: outcomeOf(exit),
                  sent: log.map((request) => wholeOf(request, table.name)),
                }
              }),
          )
          expect({ outcome, sent }).toEqual({ outcome: expected.outcome, sent: expected.sent })
        }),
    )
  }
}
