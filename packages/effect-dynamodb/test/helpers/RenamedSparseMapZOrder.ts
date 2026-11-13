/**
 * A sparse map a `field:` rename stores whole (`counts`, stored as `sr` by `put`, as entries
 * `counts#<key>` by a plain `upsert`) on an entity with a Z-order index (`byFacets`, `price` as its
 * one dimension) (#238). A `.within()` read's filter or select of an entry takes the map from the
 * form each row holds, as an entity's scan does (`RenamedSparseMap.ts`); an update of an entry
 * beside a dimension writes the entry where the row holds the map and moves the index entry in the
 * same request, or, unread on a row holding `sr`, is refused (`EDD-9150`) with nothing written,
 * the index entry included.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { type OpenTable, onTable } from "./Kept139.js"
import { outcomeOf } from "./RenamedSparseMap.js"

const Listings = Entity.make({
  model: DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      region: Schema.String,
      price: Schema.Number,
      counts: Schema.Record(Schema.String, Schema.Number),
    }),
    { counts: { storedAs: DynamoModel.SparseMap(), field: "sr" } } as never,
  ),
  entityType: "Listing",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byFacets: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", zorder: [{ field: "price", min: 0, max: 1000 }] },
    },
  },
} as never)
const entities = { Listings } as Record<string, any>
const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "zo", version: 1 }),
  entities,
} as never)

/** `w` holds the map whole (`put`), `e` as entries (`upsert`), each `{ a: 1 }`. */
const seed = (db: any) =>
  Effect.gen(function* () {
    yield* db.entities.Listings.put({ id: "w", region: "r", price: 5, counts: { a: 1 } }).asEffect()
    yield* db.entities.Listings.upsert({
      id: "e",
      region: "r",
      price: 7,
      counts: { a: 1 },
    }).asEffect()
  })

const box = (db: any) =>
  db.entities.Listings.byFacets({ region: "r" }).within({ price: { between: [0, 100] } })

const w = { id: "w", region: "r", price: 5, counts: { a: 1 } }
const e = { id: "e", region: "r", price: 7, counts: { a: 1 } }

const reads: ReadonlyArray<readonly [label: string, read: (db: any) => any, items: unknown]> = [
  ["within", (db) => box(db), [w, e]],
  [
    "within, filter eq(t.counts.a, 1)",
    (db) => box(db).filter((t: any, { eq }: any) => eq(t.counts.a, 1)),
    [w, e],
  ],
  [
    "within, filter eq(t.counts.entry('a'), 1)",
    (db) => box(db).filter((t: any, { eq }: any) => eq(t.counts.entry("a"), 1)),
    [w, e],
  ],
  [
    "within, filter eq(t.counts.a, 9)",
    (db) => box(db).filter((t: any, { eq }: any) => eq(t.counts.a, 9)),
    [],
  ],
  [
    "within, select(['counts'])",
    (db) => box(db).select(["counts"]),
    [{ counts: { a: 1 } }, { counts: { a: 1 } }],
  ],
  [
    "within, select((t) => [t.counts.entry('a')])",
    (db) => box(db).select((t: any) => [t.counts.entry("a")]),
    [{ counts: { a: 1 } }, { counts: { a: 1 } }],
  ],
]

/** Each write, with its outcome, the row it leaves and the index's entries after it. */
const writes: ReadonlyArray<
  readonly [
    label: string,
    write: (db: any) => Effect.Effect<unknown, unknown, any>,
    outcome: unknown,
    after: unknown,
    within: unknown,
  ]
> = [
  [
    "w: .set({ price: 9, counts: { b: 2 } })",
    (db) =>
      db.entities.Listings.update({ id: "w" })
        .set({ price: 9, counts: { b: 2 } })
        .asEffect(),
    { fail: "ValidationError" },
    w,
    [w, e],
  ],
  [
    "w: .set({ price: 9, counts: { b: 2 } }), in a transaction",
    (db) =>
      Transaction.transactWrite([
        db.entities.Listings.update({ id: "w" }).set({ price: 9, counts: { b: 2 } }),
      ]),
    { ok: null },
    { ...w, price: 9, counts: { a: 1, b: 2 } },
    [e, { ...w, price: 9, counts: { a: 1, b: 2 } }],
  ],
  [
    "e: .set({ price: 11, counts: { b: 2 } })",
    (db) =>
      db.entities.Listings.update({ id: "e" })
        .set({ price: 11, counts: { b: 2 } })
        .asEffect(),
    { ok: { ...e, price: 11, counts: { a: 1, b: 2 } } },
    { ...e, price: 11, counts: { a: 1, b: 2 } },
    [w, { ...e, price: 11, counts: { a: 1, b: 2 } }],
  ],
  [
    "w: .clearMap('counts').set({ price: 13, counts: { c: 3 } }), in a transaction",
    (db) =>
      Transaction.transactWrite([
        db.entities.Listings.update({ id: "w" })
          .clearMap("counts")
          .set({ price: 13, counts: { c: 3 } }),
      ]),
    { ok: null },
    { ...w, price: 13, counts: { c: 3 } },
    [e, { ...w, price: 13, counts: { c: 3 } }],
  ],
  [
    "w: pathAdd(['counts#a'], 1) beside .set({ price: 3 }), in a transaction",
    (db) =>
      Transaction.transactWrite([
        db.entities.Listings.update({ id: "w" })
          .set({ price: 3 })
          .pathAdd({ segments: ["counts#a"], value: 1 }),
      ]),
    { ok: null },
    { ...w, price: 3, counts: { a: 2 } },
    [{ ...w, price: 3, counts: { a: 2 } }, e],
  ],
]

export const renamedSparseMapZOrderSuite = (open: OpenTable) => {
  for (const [label, read, items] of reads) {
    it.effect(`${label}: takes the map from either form`, () =>
      Effect.gen(function* () {
        const got = yield* onTable(open, 0, MainTable, { entities }, (db) =>
          Effect.gen(function* () {
            yield* seed(db)
            return yield* read(db).collect()
          }),
        )
        expect(got).toEqual(items)
      }),
    )
  }
  for (const [label, write, outcome, after, within] of writes) {
    it.effect(label, () =>
      Effect.gen(function* () {
        const got = yield* onTable(open, 0, MainTable, { entities }, (db) =>
          Effect.gen(function* () {
            yield* seed(db)
            const exit = yield* Effect.exit(Effect.suspend(() => write(db)))
            return {
              outcome: outcomeOf(exit, Number.POSITIVE_INFINITY),
              after: yield* db.entities.Listings.get({ id: (after as { id: string }).id }),
              within: yield* box(db).collect(),
            }
          }),
        )
        if ((outcome as { fail?: string }).fail !== undefined) {
          expect(got.outcome.fail).toEqual((outcome as { fail: string }).fail)
          expect(got.outcome.says).toContain("[EDD-9150]")
        } else expect(got.outcome).toEqual(outcome)
        expect(got.after).toEqual(after)
        expect(got.within).toEqual(within)
      }),
    )
  }
}
