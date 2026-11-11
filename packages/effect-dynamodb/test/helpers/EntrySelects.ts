/**
 * A select of an entry of a sparse map (#238), in a query and a collection, against what the
 * published 1.40.0 did (`fixtures/entry-selects-1.40.0.json`, every request whole).
 *
 * The projection names each entry where a row may hold it: its own attribute (`l#a`, `r#a`), with
 * the segments below it, and for a map a `field:` rename stores whole the map's attribute WHOLE
 * (`rw`), so the row says whether it holds the map that way. The map is rebuilt by the read's own
 * function, which takes the whole attribute when the row holds it, so an entry select returns what
 * a read returns, trimmed to the entry. What DynamoDB projected is never projected again by
 * position: an entry's list comes back closed up, as DynamoDB closes it (`a.at(2)` of
 * `[10, 20, 30]` is `[30]`), and only a map read from its whole attribute, which the projection
 * names whole, is trimmed to the paths. That costs the whole map's attribute on each row (not the
 * row): a map without a rename projects only its entries.
 *
 * Rows: `w`, as `put` stores every map; `e`, the renamed maps as entries; `x`, the renamed maps
 * whole and empty beside entries a read never sees; `y`, the renamed maps whole beside entries
 * holding other values a read never sees; and a `Peer` with a map of its own prefix.
 *
 * Through 1.40.0 a select through the map's field projected `rw.a[2]` (and `lists.a[2]`, which no
 * row holds): right for a row holding the map whole, nothing for one holding entries or for a map
 * without a rename. `.entry()` threw in a query's callback.
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
  readFileSync(new URL("../fixtures/entry-selects-1.40.0.json", import.meta.url), "utf8"),
) as {
  readonly cases: Record<string, { readonly outcome: any; readonly sent: ReadonlyArray<any> }>
}

const byGroup = {
  name: "gsi1",
  collection: "group",
  pk: { field: "gsi1pk", composite: ["group"] },
  sk: { field: "gsi1sk", composite: ["id"] },
} as const
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const
const Lists = Schema.Record(Schema.String, Schema.Array(Schema.Number))
const Docs = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      group: Schema.String,
      lists: Lists,
      rl: Lists,
      whole: Schema.Record(Schema.String, Schema.Number),
    }),
    {
      lists: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "l" }) },
      rl: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "r" }), field: "rw" },
      whole: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "w" }), field: "wh" },
    },
  ),
  entityType: "Doc",
  primaryKey,
  indexes: { byGroup },
})
const Peers = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({ id: Schema.String, group: Schema.String, lists: Lists }),
    { lists: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "p" }) } },
  ),
  entityType: "Peer",
  primaryKey,
  indexes: { byGroup },
})
const entities = { Docs, Peers }
const MainTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "es", version: 1 }),
  entities,
})

const list = (...ns: ReadonlyArray<number>) => ({ L: ns.map((n) => ({ N: String(n) })) })
const rawSet = (
  tableName: string,
  id: string,
  expression: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const raw = yield* Lib.DynamoClient
    yield* raw.updateItem({
      TableName: tableName,
      Key: { pk: { S: `$es#v1#doc#id_${id}` }, sk: { S: "$es#v1#doc" } },
      ConditionExpression: "attribute_exists(pk)",
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values as never,
    })
  })

const seed = (db: any, tableName: string) =>
  Effect.gen(function* () {
    const docs = db.entities.Docs
    const lists = { a: [10, 20, 30] }
    yield* docs.put({ id: "w", group: "g", lists, rl: lists, whole: { k: 1 } }).asEffect()
    yield* docs.put({ id: "e", group: "g", lists, rl: {}, whole: {} }).asEffect()
    yield* rawSet(
      tableName,
      "e",
      "SET #r = :r, #w = :w REMOVE #rw, #wh",
      { "#r": "r#a", "#w": "w#k", "#rw": "rw", "#wh": "wh" },
      { ":r": list(10, 20, 30), ":w": { N: "1" } },
    )
    yield* docs.put({ id: "x", group: "g", lists, rl: {}, whole: {} }).asEffect()
    yield* rawSet(
      tableName,
      "x",
      "SET #r = :r, #w = :w",
      { "#r": "r#a", "#w": "w#k" },
      { ":r": list(1, 2, 3), ":w": { N: "5" } },
    )
    yield* docs
      .put({ id: "y", group: "g", lists, rl: { a: [7, 8, 9] }, whole: { k: 1 } })
      .asEffect()
    yield* rawSet(
      tableName,
      "y",
      "SET #r = :r, #w = :w, #j = :j",
      { "#r": "r#a", "#w": "w#k", "#j": "w#j" },
      { ":r": list(1, 2, 3), ":w": { N: "5" }, ":j": { N: "2" } },
    )
    yield* db.entities.Peers.put({ id: "p", group: "g", lists }).asEffect()
  })

/**
 * Each select: what the head returns for rows e, w, x, y (in that order) and for the Peer, and the
 * `ProjectionExpression` names it sends (the Doc's, without the collection's `__edd_e__`).
 */
const selects: ReadonlyArray<
  readonly [
    label: string,
    select: (t: any) => ReadonlyArray<unknown>,
    docs: ReadonlyArray<unknown>,
    peer: unknown,
    projected: ReadonlyArray<string>,
  ]
> = [
  [
    "lists.a.at(2)",
    (t) => [t.lists.a.at(2)],
    Array(4).fill({ lists: { a: [30] } }),
    { lists: { a: [30] } },
    ["l#a[2]"],
  ],
  [
    "lists.a.at(0), lists.a.at(2)",
    (t) => [t.lists.a.at(0), t.lists.a.at(2)],
    Array(4).fill({ lists: { a: [10, 30] } }),
    { lists: { a: [10, 30] } },
    ["l#a[0]", "l#a[2]"],
  ],
  [
    "rl.a.at(2)",
    (t) => [t.rl.a.at(2)],
    [{ rl: { a: [30] } }, { rl: { a: [30] } }, {}, { rl: { a: [9] } }],
    {},
    ["r#a[2]", "rw"],
  ],
  [
    "rl.a.at(0), rl.a.at(2)",
    (t) => [t.rl.a.at(0), t.rl.a.at(2)],
    [{ rl: { a: [10, 30] } }, { rl: { a: [10, 30] } }, {}, { rl: { a: [7, 9] } }],
    {},
    ["r#a[0]", "rw", "r#a[2]"],
  ],
  [
    "rl.a",
    (t) => [t.rl.a],
    [{ rl: { a: [10, 20, 30] } }, { rl: { a: [10, 20, 30] } }, {}, { rl: { a: [7, 8, 9] } }],
    {},
    ["r#a", "rw"],
  ],
  [
    "whole.k",
    (t) => [t.whole.k],
    [{ whole: { k: 1 } }, { whole: { k: 1 } }, {}, { whole: { k: 1 } }],
    {},
    ["w#k", "wh"],
  ],
  [
    "whole.k, whole.j",
    (t) => [t.whole.k, t.whole.j],
    [{ whole: { k: 1 } }, { whole: { k: 1 } }, {}, { whole: { k: 1 } }],
    {},
    ["w#k", "wh", "w#j"],
  ],
  [
    "whole.entry('k')",
    (t) => [t.whole.entry("k")],
    [{ whole: { k: 1 } }, { whole: { k: 1 } }, {}, { whole: { k: 1 } }],
    {},
    ["w#k", "wh"],
  ],
  [
    "rl.entry('a')",
    (t) => [t.rl.entry("a")],
    [{ rl: { a: [10, 20, 30] } }, { rl: { a: [10, 20, 30] } }, {}, { rl: { a: [7, 8, 9] } }],
    {},
    ["r#a", "rw"],
  ],
]

/** A projection's paths, its placeholders named. */
const projectionOf = (request: any): ReadonlyArray<string> => {
  const names = request.ExpressionAttributeNames as Record<string, string>
  return (request.ProjectionExpression as string)
    .split(", ")
    .map((path) => path.replace(/#[A-Za-z0-9_]+/g, (token) => names[token]!))
}

export const entrySelectsSuite = (open: OpenTable) => {
  for (const [label, select, docs, peer, projected] of selects) {
    for (const through of ["a query", "a collection"] as const) {
      const name = `${through}: select ${label}`
      const was = fixture.cases[name]!
      const expected = through === "a query" ? docs : { Docs: docs, Peers: [peer] }
      const same = JSON.stringify(was.outcome) === JSON.stringify({ ok: expected })
      it.effect(
        same
          ? `${name}: as 1.40.0`
          : `${name}: what a read returns, where 1.40.0 gave ${JSON.stringify(was.outcome).slice(0, 80)}`,
        () =>
          Effect.gen(function* () {
            const log: Array<unknown> = []
            const { outcome, sent } = yield* onTable(
              recordingRequests(open, log),
              0,
              MainTable,
              { entities },
              (db, table) =>
                Effect.gen(function* () {
                  yield* seed(db, table.name)
                  log.length = 0
                  const read =
                    through === "a query"
                      ? db.entities.Docs.byGroup({ group: "g" })
                      : db.collections.group({ group: "g" })
                  const exit = yield* Effect.exit(read.select(select).collect())
                  return {
                    outcome: outcomeOf(exit),
                    sent: log.map((request) => wholeOf(request, table.name)) as Array<any>,
                  }
                }),
            )
            expect(outcome).toEqual({ ok: expected })
            // One query, as 1.40.0 sent, but for the projection's paths and their names.
            expect(sent.length).toBe(1)
            const { ProjectionExpression, ExpressionAttributeNames, ...rest } = sent[0].query
            if (was.sent.length > 0) {
              const {
                ProjectionExpression: _wasProjection,
                ExpressionAttributeNames: wasNames,
                ...wasRest
              } = (was.sent[0] as any).query
              expect(rest).toEqual(wasRest)
              expect(ExpressionAttributeNames).toEqual(
                expect.objectContaining(
                  Object.fromEntries(
                    Object.entries(wasNames as Record<string, string>).filter(
                      ([token]) => !token.startsWith("#proj"),
                    ),
                  ),
                ),
              )
            }
            const paths = projectionOf(sent[0].query)
            expect(paths).toEqual(
              through === "a query"
                ? projected
                : [
                    ...projected,
                    ...(label.startsWith("lists")
                      ? projected.map((path) => path.replace("l#", "p#"))
                      : []),
                    "__edd_e__",
                  ],
            )
          }),
      )
    }
  }
}
