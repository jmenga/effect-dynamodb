/**
 * A `.select()` of one entry of a sparse map, named through the map's field (`t.counts.k`), on a
 * query and a collection (#238). Through 1.40.0 it projected `counts.k`, which no row holds, so
 * the entry came back absent; section 1 read whole rows for it. It now projects the attributes the
 * entry is stored under (`c#k`, and for a map a `field:` rename stores whole, `whole` stored as
 * `wh`, both `w#k` and `wh.k`) with the segments below it as stored, and returns the map trimmed
 * to that entry, as a read rebuilds it. Only a select of a whole map reads whole rows. In a
 * collection each member projects its own entry attributes (`Thirds` stores `counts` under `n`),
 * a member holding the map whole projects the map's key (`Fourths`), and a member without the
 * map gets nothing for it (`Others`, whose own map `tallies` is stored under the same prefix `c`).
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
    "a query's select of an entry through its map's field",
    (db) => ofDocs(db).select((t: any) => [t.counts.k]),
    [{ counts: { k: 5 } }, { counts: { k: 6 } }],
    true,
  ],
  [
    "a query's select below an entry, by the names its struct stores",
    (db) => ofDocs(db).select((t: any) => [t.deeps.k.deep]),
    [{ deeps: { k: { deep: 7 } } }, {}],
    true,
  ],
  [
    "a query's select of an entry of a map stored whole, in either form",
    (db) => ofDocs(db).select((t: any) => [t.whole.k]),
    [{ whole: { k: 3 } }, { whole: { k: 4 } }],
    true,
  ],
  [
    "a query's select of an entry beside a field",
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
    "a collection's select of an entry, by each member's own prefix",
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
    "a collection's select of an entry beside a field",
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
export const entrySelectsSuite = (open: OpenTable) => {
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
