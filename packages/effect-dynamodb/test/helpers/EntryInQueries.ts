/**
 * A sparse map's entry in a query's, a scan's and a collection's `filter` and `select` (#238),
 * named by `.entry(key)` or through the map's field (`t.counts.k`). Through 1.40.0 a query's path
 * builder knew no sparse map, so `.entry()` threw ("not configured as a sparse map") in every query
 * callback, while a write's condition took it; and a select of `t.counts.k` projected
 * `counts.k`, which no row holds.
 *
 * A filter on an entry names the attribute a condition names: `<prefix>#<key>`, the segments
 * below it as stored, and for a map a `field:` rename stores whole (`whole`, stored as `wh`), the
 * row asked where it holds the map. A select of an entry returns the map trimmed to that entry,
 * as a read rebuilds it, and projects the attributes the entry is stored under (`c#k`, and both
 * `w#k` and `wh.k` for the renamed map); only a select of a whole map reads whole rows. In a
 * collection each member names the entry by its own prefix (`Thirds` stores `counts` under `n`),
 * a member holding the map whole by the map's key (`Fourths`), and a member without the map reads
 * it as absent: `Others` stores its own map `tallies` under the same prefix `c`, and its rows
 * never match.
 */

import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"

const Deep = Schema.Struct({ deep: Schema.Number }).pipe(Schema.encodeKeys({ deep: "dp" }))
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
const Docs = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      group: Schema.String,
      note: Schema.String,
      counts: Schema.Record(Schema.String, Schema.Number),
      deeps: Schema.Record(Schema.String, Deep),
      whole: Schema.Record(Schema.String, Schema.Number),
    }),
    {
      counts: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "c" }) },
      deeps: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "d" }) },
      whole: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "w" }), field: "wh" },
    },
  ),
  entityType: "Doc",
  primaryKey,
  indexes: { byGroup },
})
const Others = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      group: Schema.String,
      note: Schema.String,
      tallies: Schema.Record(Schema.String, Schema.Number),
    }),
    { tallies: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "c" }) } },
  ),
  entityType: "Other",
  primaryKey,
  indexes: { byGroup },
})
const Thirds = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      group: Schema.String,
      note: Schema.String,
      counts: Schema.Record(Schema.String, Schema.Number),
    }),
    { counts: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "n" }) } },
  ),
  entityType: "Third",
  primaryKey,
  indexes: { byGroup },
})
const Fourths = Lib.Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    group: Schema.String,
    note: Schema.String,
    counts: Schema.Record(Schema.String, Schema.Number),
  }),
  entityType: "Fourth",
  primaryKey,
  indexes: { byGroup },
})
const entities = { Docs, Others, Thirds, Fourths }
const MainTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "eq", version: 1 }),
  entities,
})

/** `a` stores `whole` as `wh`, as `put` does; `b` as an entry, as a plain entity's `upsert` does. */
const seed = (db: any) =>
  Effect.gen(function* () {
    yield* db.entities.Docs.put({
      id: "a",
      group: "g",
      note: "x",
      counts: { k: 5, j: 1 },
      deeps: { k: { deep: 7 } },
      whole: { k: 3 },
    }).asEffect()
    yield* db.entities.Docs.upsert({
      id: "b",
      group: "g",
      note: "y",
      counts: { k: 6 },
      deeps: {},
      whole: { k: 4 },
    }).asEffect()
    yield* db.entities.Others.put({ id: "o", group: "g", note: "x", tallies: { k: 5 } }).asEffect()
    yield* db.entities.Thirds.put({ id: "t", group: "g", note: "x", counts: { k: 5 } }).asEffect()
    yield* db.entities.Fourths.put({ id: "f", group: "g", note: "x", counts: { k: 5 } }).asEffect()
  })

const A = { id: "a", group: "g", note: "x", counts: { k: 5, j: 1 }, deeps: { k: { deep: 7 } } }
const B = { id: "b", group: "g", note: "y", counts: { k: 6 }, deeps: {} }

type Read = readonly [
  name: string,
  run: (db: any) => any,
  outcome: unknown,
  /** Whether the read sends a projection: an entry's is projected, a whole map's isn't. */
  projects?: boolean,
]

const ofDocs = (db: any) => db.entities.Docs.byGroup({ group: "g" })
const reads: ReadonlyArray<Read> = [
  [
    "a query's filter on an entry",
    (db) => ofDocs(db).filter((t: any, { eq }: any) => eq(t.counts.entry("k"), 5)),
    [{ ...A, whole: { k: 3 } }],
  ],
  [
    "a scan's filter on an entry",
    (db) => db.entities.Docs.scan().filter((t: any, { eq }: any) => eq(t.counts.entry("k"), 6)),
    [{ ...B, whole: { k: 4 } }],
  ],
  [
    "a query's filter below an entry, by the names its struct stores",
    (db) => ofDocs(db).filter((t: any, { eq }: any) => eq(t.deeps.entry("k").deep, 7)),
    [{ ...A, whole: { k: 3 } }],
  ],
  [
    "a query's filter on an entry of a map stored whole, where put stored it",
    (db) => ofDocs(db).filter((t: any, { eq }: any) => eq(t.whole.entry("k"), 3)),
    [{ ...A, whole: { k: 3 } }],
  ],
  [
    "a query's filter on an entry of a map stored whole, where an update stored it",
    (db) => ofDocs(db).filter((t: any, { eq }: any) => eq(t.whole.entry("k"), 4)),
    [{ ...B, whole: { k: 4 } }],
  ],
  [
    "a query's select of an entry",
    (db) => ofDocs(db).select((t: any) => [t.counts.entry("k")]),
    [{ counts: { k: 5 } }, { counts: { k: 6 } }],
    true,
  ],
  [
    "a query's select below an entry, by the names its struct stores",
    (db) => ofDocs(db).select((t: any) => [t.deeps.entry("k").deep]),
    [{ deeps: { k: { deep: 7 } } }, {}],
    true,
  ],
  [
    "a query's select of an entry of a map stored whole, in either form",
    (db) => ofDocs(db).select((t: any) => [t.whole.entry("k")]),
    [{ whole: { k: 3 } }, { whole: { k: 4 } }],
    true,
  ],
  [
    "a query's select of an entry beside a field",
    (db) => ofDocs(db).select((t: any) => [t.counts.entry("k"), t.note]),
    [
      { counts: { k: 5 }, note: "x" },
      { counts: { k: 6 }, note: "y" },
    ],
    true,
  ],
  [
    "a query's select of an entry through its map's field",
    (db) => ofDocs(db).select((t: any) => [t.counts.k]),
    [{ counts: { k: 5 } }, { counts: { k: 6 } }],
    true,
  ],
  [
    "a query's select below an entry, through its map's field",
    (db) => ofDocs(db).select((t: any) => [t.deeps.k.deep]),
    [{ deeps: { k: { deep: 7 } } }, {}],
    true,
  ],
  [
    "a query's select of an entry of a map stored whole, through its map's field",
    (db) => ofDocs(db).select((t: any) => [t.whole.k]),
    [{ whole: { k: 3 } }, { whole: { k: 4 } }],
    true,
  ],
  [
    "a query's select of an entry beside a field, through its map's field",
    (db) => ofDocs(db).select((t: any) => [t.counts.k, t.note]),
    [
      { counts: { k: 5 }, note: "x" },
      { counts: { k: 6 }, note: "y" },
    ],
    true,
  ],
  [
    "a query's select of the whole map",
    (db) => ofDocs(db).select((t: any) => [t.counts]),
    [{ counts: { k: 5, j: 1 } }, { counts: { k: 6 } }],
    false,
  ],
]

const ofGroup = (db: any) => db.collections.group({ group: "g" })
const collected: ReadonlyArray<Read> = [
  [
    "a collection's select of an entry, through its map's field",
    (db) => ofGroup(db).select((t: any) => [t.counts.k]),
    {
      Docs: [{ counts: { k: 5 } }, { counts: { k: 6 } }],
      Others: [{}],
      Thirds: [{ counts: { k: 5 } }],
      Fourths: [{ counts: { k: 5 } }],
    },
    true,
  ],
  [
    "a collection's select of an entry beside a field, through its map's field",
    (db) => ofGroup(db).select((t: any) => [t.counts.k, t.note]),
    {
      Docs: [
        { counts: { k: 5 }, note: "x" },
        { counts: { k: 6 }, note: "y" },
      ],
      Others: [{ note: "x" }],
      Thirds: [{ counts: { k: 5 }, note: "x" }],
      Fourths: [{ counts: { k: 5 }, note: "x" }],
    },
    true,
  ],
  [
    "a collection's filter on an entry, by each member's own prefix",
    (db) => ofGroup(db).filter((t: any, { eq }: any) => eq(t.counts.entry("k"), 5)),
    {
      Docs: [{ ...A, whole: { k: 3 } }],
      Others: [],
      Thirds: [{ id: "t", group: "g", note: "x", counts: { k: 5 } }],
      Fourths: [{ id: "f", group: "g", note: "x", counts: { k: 5 } }],
    },
  ],
  [
    "a collection's select of an entry, by each member's own prefix",
    (db) => ofGroup(db).select((t: any) => [t.counts.entry("k")]),
    {
      Docs: [{ counts: { k: 5 } }, { counts: { k: 6 } }],
      Others: [{}],
      Thirds: [{ counts: { k: 5 } }],
      Fourths: [{ counts: { k: 5 } }],
    },
    true,
  ],
  [
    "a collection's select of an entry beside a field",
    (db) => ofGroup(db).select((t: any) => [t.counts.entry("k"), t.note]),
    {
      Docs: [
        { counts: { k: 5 }, note: "x" },
        { counts: { k: 6 }, note: "y" },
      ],
      Others: [{ note: "x" }],
      Thirds: [{ counts: { k: 5 }, note: "x" }],
      Fourths: [{ counts: { k: 5 }, note: "x" }],
    },
    true,
  ],
]

/** A scan's items in an order independent of the table's. */
const unordered = (items: unknown): unknown =>
  Array.isArray(items) ? [...items].map((item) => JSON.stringify(item)).sort() : items

/** The `ProjectionExpression` of each read request a read sent. */
const projectionsOf = (log: ReadonlyArray<unknown>) =>
  log.flatMap((request) => {
    const [command, input] = Object.entries(request as Record<string, Record<string, any>>)[0]!
    return command === "query" || command === "scan" ? [input.ProjectionExpression] : []
  })

/** Each read on a table of its own: what it returns, and whether it sent a projection. */
export const entryInQueriesSuite = (open: OpenTable) => {
  for (const [name, run, outcome, projects] of [...reads, ...collected]) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const log: Array<unknown> = []
        const got = yield* onTable(recordingRequests(open, log), 0, MainTable, { entities }, (db) =>
          Effect.gen(function* () {
            yield* seed(db)
            log.length = 0
            return yield* run(db).collect()
          }),
        )
        expect(name.includes("scan") ? unordered(got) : got).toEqual(
          name.includes("scan") ? unordered(outcome) : outcome,
        )
        if (projects !== undefined) {
          const sent = projectionsOf(log)
          expect(sent.length).toBeGreaterThan(0)
          for (const projection of sent) expect(projection !== undefined).toBe(projects)
        }
      }),
    )
  }
}
