/**
 * What `escapeKeys: false` does, beside the suites that pin `escapeKeys: true` (#183). Off composes
 * the key text 1.36 composed, for strings and numbers, and queries send what 1.36 sent. So a value
 * holding a character below `#` sorts out of its place, and a number sorts as its text does. These
 * are limitations of off, not bugs, and the tests pin them so a change to them is a decision.
 *
 * Reads are answered by a recording table holding the rows the writes put there, in byte order.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { inBound, makeListings, STORE } from "./helpers/ListingsFixture.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "off", version: 1, escapeKeys: false })

const Place = Schema.Struct({
  store: Schema.String,
  id: Schema.String,
  city: Schema.String,
  level: Schema.Number,
})

const Places = Entity.make({
  model: Place,
  entityType: "Place",
  primaryKey: {
    pk: { field: "pk", composite: ["store"] },
    sk: { field: "sk", composite: ["id"] },
  },
  indexes: {
    byCity: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["store"] },
      sk: { field: "gsi1sk", composite: ["city", "id"] },
    },
    byLevel: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["store"] },
      sk: { field: "gsi2sk", composite: ["level"] },
    },
  },
})

const Reading = Schema.Struct({
  site: Schema.String,
  seq: Schema.NumberFromString,
  note: Schema.String,
})

const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["site"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: { orderBy: "seq", appendInput: Reading },
})

const MainTable = Table.make({ schema, entities: { Places, Readings } })

const run = <A, E>(
  body: (db: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, E, any>,
) => {
  const table = makeRecordingTable({
    indexes: {
      gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
      gsi2: { pk: "gsi2pk", sk: "gsi2sk" },
    },
  })
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Places, Readings },
      tables: { MainTable },
    })
    return yield* body(db, table)
  }).pipe(
    Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "off-table" }))),
  ) as Effect.Effect<A, E>
}

const place = (id: string, city: string, level = 1) => ({ store: "s", id, city, level })

const lastQuery = (table: ReturnType<typeof makeRecordingTable>) => {
  const queries = table.requests.filter((request) => request.command === "Query")
  return queries[queries.length - 1]!.input
}

const skCondition = (input: Record<string, any>) => {
  const values = input.ExpressionAttributeValues as Record<string, { S?: string }>
  return (input.KeyConditionExpression as string)
    .split(" AND ")
    .slice(1)
    .join(" AND ")
    .replace(/:\w+/g, (name) => JSON.stringify(values[name]?.S))
}

describe("escapeKeys: false", () => {
  describe("the key text it composes", () => {
    it.effect("strings go in as they are, and numbers in 1.36's padded form", () =>
      run((db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Places.put(place("a#b", "New York", -3)).asEffect()
          const row = table.items.values().next().value!
          expect(row.pk!.S).toBe("$off#v1#place#store_s")
          expect(row.sk!.S).toBe("$off#v1#place#id_a#b")
          expect(row.gsi1sk!.S).toBe("$off#v1#place#city_new york#id_a#b")
          expect(row.gsi2sk!.S).toBe("$off#v1#place#level_00000000000000-3")
        }),
      ),
    )

    it.effect("a NaN has no key here either: EDD-9096, and nothing is sent", () =>
      run((db, table) =>
        Effect.gen(function* () {
          const before = table.requests.length
          const error: any = yield* Effect.flip(
            db.entities.Places.byLevel({ store: "s", level: Number.NaN }).collect(),
          )
          expect(error._tag).toBe("ValidationError")
          expect(
            String((error as { readonly cause?: { readonly message?: string } }).cause?.message),
          ).toContain("[EDD-9096]")
          expect(table.requests.length).toBe(before)
        }),
      ),
    )
  })

  describe("the key condition a query sends", () => {
    it.effect("a pin of a leading composite is begins_with the prefix", () =>
      run((db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Places.byCity({ store: "s", city: "new" }).collect()
          expect(skCondition(lastQuery(table))).toBe('begins_with(#sk, "$off#v1#place#city_new#")')
        }),
      ),
    )

    it.effect("a pin of every composite is the exact key", () =>
      run((db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Places.byCity({ store: "s", city: "new", id: "1" }).collect()
          expect(skCondition(lastQuery(table))).toBe('#sk = "$off#v1#place#city_new#id_1"')
        }),
      ),
    )

    it.effect(".where(eq) on a leading composite is begins_with the prefix", () =>
      run((db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Places.byCity({ store: "s" })
            .where((t: any, { eq }: any) => eq(t.city, "new"))
            .collect()
          expect(skCondition(lastQuery(table))).toBe('begins_with(#sk, "$off#v1#place#city_new#")')
        }),
      ),
    )

    it.effect(".within(eq) on a leading composite is begins_with the prefix", () =>
      run((db, table) =>
        Effect.gen(function* () {
          yield* db.entities.Places.byCity({ store: "s" })
            .within({ city: { eq: "new" } })
            .collect()
          expect(skCondition(lastQuery(table))).toBe('begins_with(#sk, "$off#v1#place#city_new#")')
        }),
      ),
    )
  })

  describe("what it can't do: key order isn't value order", () => {
    const CITIES = ["new", "new york", "newer"]

    const seeded = (db: any) =>
      Effect.forEach(CITIES, (city, i) => db.entities.Places.put(place(`${i}`, city)).asEffect())

    it.effect("a pin returns the value, and no value that extends it", () =>
      run((db) =>
        Effect.gen(function* () {
          yield* seeded(db)
          const found: ReadonlyArray<any> = yield* db.entities.Places.byCity({
            store: "s",
            city: "new",
          }).collect()
          expect(found.map((row) => row.city)).toEqual(["new"])
        }),
      ),
    )

    it.effect("`new york` sorts before `new`, because a space is below the delimiter", () =>
      run((db) =>
        Effect.gen(function* () {
          yield* seeded(db)
          const all: ReadonlyArray<any> = yield* db.entities.Places.byCity({ store: "s" }).collect()
          expect(all.map((row) => row.city)).toEqual(["new york", "new", "newer"])
        }),
      ),
    )

    it.effect("a bound on a leading composite leaves out what its key order puts past it", () =>
      run((db) =>
        Effect.gen(function* () {
          yield* seeded(db)
          const lte: ReadonlyArray<any> = yield* db.entities.Places.byCity({ store: "s" })
            .where((t: any, { lte: at }: any) => at(t.city, "new york"))
            .collect()
          // `new` is below `new york` by value and above it by key.
          expect(lte.map((row) => row.city)).toEqual(["new york"])
        }),
      ),
    )

    it.effect("a value holding `#` reads as a longer key under a pin of its prefix", () =>
      run((db) =>
        Effect.gen(function* () {
          yield* db.entities.Places.put(place("1", "new#2")).asEffect()
          yield* db.entities.Places.put(place("2", "new")).asEffect()
          const found: ReadonlyArray<any> = yield* db.entities.Places.byCity({
            store: "s",
            city: "new",
          }).collect()
          expect(found.map((row) => row.city).sort()).toEqual(["new", "new#2"])
        }),
      ),
    )

    it.effect("numbers sort as their text: negatives backwards, fractions above integers", () =>
      run((db) =>
        Effect.gen(function* () {
          yield* Effect.forEach([-10, -3, -5, 0, 2.5, 7, 10], (level, i) =>
            db.entities.Places.put(place(`${i}`, "x", level)).asEffect(),
          )
          const all: ReadonlyArray<any> = yield* db.entities.Places.byLevel({
            store: "s",
          }).collect()
          expect(all.map((row) => row.level)).toEqual([-10, -3, -5, 0, 7, 10, 2.5])
          const below3: ReadonlyArray<any> = yield* db.entities.Places.byLevel({ store: "s" })
            .where((t: any, { lt }: any) => lt(t.level, 3))
            .collect()
          // `2.5` is below 3 by value and above it by key.
          expect(below3.map((row) => row.level)).toEqual([-10, -3, -5, 0])
        }),
      ),
    )

    it.effect(".history() on a string-encoded number is in text order: 10 before 9", () =>
      run((db, table) =>
        Effect.gen(function* () {
          for (const seq of [9, 10]) {
            yield* db.entities.Readings.append({ site: "a", seq, note: "n" }).asEffect()
          }
          const events = [...table.items.values()].filter((row) => row.sk!.S!.includes("#e#"))
          expect(events.map((row) => row.sk!.S).sort()).toEqual([
            "$off#v1#reading#e#10",
            "$off#v1#reading#e#9",
          ])
          const history: ReadonlyArray<any> = yield* db.entities.Readings.history({
            site: "a",
          }).collect()
          expect(history.map((event) => event.seq)).toEqual([10, 9])
        }),
      ),
    )
  })

  describe("skip-scan", () => {
    const grid = (statuses: ReadonlyArray<string>) =>
      statuses.flatMap((status, s) =>
        [10, 40, 70].map((price, p) => ({
          storeId: STORE,
          listingId: `l-${s}-${p}`,
          status,
          price,
        })),
      )

    const scanOf = (statuses: ReadonlyArray<string>) => {
      const fixture = makeListings({ statuses, status: Schema.String, escapeKeys: false })
      const items = grid(statuses)
      const { layer } = fixture.serve(items)
      return Effect.gen(function* () {
        const listings = yield* fixture.listings
        const query = listings.byStore({ storeId: STORE }).within({ price: { gte: 20, lte: 50 } })
        const explained = yield* query.explain()
        const found: ReadonlyArray<any> = yield* query.collect()
        return { plan: explained.plan, found }
      }).pipe(Effect.provide(layer)) as Effect.Effect<{
        readonly plan: string
        readonly found: ReadonlyArray<any>
      }>
    }

    it.effect("is exact for values free of `#` and anything below it", () =>
      Effect.gen(function* () {
        const { plan, found } = yield* scanOf(["active", "pending", "sold"])
        expect(plan).toBe("skip-scan")
        expect(found.map((row) => row.status).sort()).toEqual(["active", "pending", "sold"])
        for (const row of found) expect(inBound({ gte: 20, lte: 50 }, row.price)).toBe(true)
      }),
    )

    it.effect("hides a value holding `#` whose key sorts past the value it extends", () =>
      Effect.gen(function* () {
        const { found } = yield* scanOf(["on", "on#zone"])
        expect(found.map((row) => row.status)).toEqual(["on"])
      }),
    )
  })
})
