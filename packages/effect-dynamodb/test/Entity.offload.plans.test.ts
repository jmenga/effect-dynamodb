/**
 * Offloaded fields under the planned query reads of #171 (#179, design §8.2):
 * a Z-order box and a composite sort key's skip-scan fetch offloaded values
 * only for the rows they return — under `limit`, and across a `fetch` chain
 * whose cursors resume mid-plan.
 *
 * The rows are written through the entity (its uploads land in the in-memory
 * store), then served by `PartitionMock`, which honours `Limit` as rows
 * examined, `ExclusiveStartKey` and `LastEvaluatedKey` as DynamoDB does, and
 * evaluates the `FilterExpression` sent. The store's GET count says what each
 * read fetched.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as BlobPointer from "@effect-dynamodb/schema/internal/BlobPointer.js"
import { Effect, Layer, Option, Schema } from "effect"
import { beforeEach } from "vitest"
import { BlobStore } from "../src/BlobStore.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import type * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import { InMemoryClient, resetStore, store as rows } from "./helpers/InMemoryTables.js"
import { makePartition, type Row } from "./helpers/PartitionMock.js"

const AppSchema = DynamoSchema.make({ name: "plans", version: 1, escapeKeys: true })

const STATUSES = ["draft", "live", "sold"] as const

class Place extends Schema.Class<Place>("Place")({
  placeId: Schema.String,
  region: Schema.String,
  status: Schema.Literals(STATUSES),
  price: Schema.Number,
  bedrooms: Schema.Number,
  body: Schema.Struct({ text: Schema.String }),
}) {}

/** Every body is over its 16-byte threshold: each row holds a pointer. */
const Places = Entity.make({
  model: DynamoModel.configure(Place, {
    body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 16 } }) },
  }),
  entityType: "Place",
  primaryKey: {
    pk: { field: "pk", composite: ["placeId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    /** Z-order over price × bedrooms. */
    byBox: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: {
        field: "gsi1sk",
        zorder: [
          { field: "price", min: 0, max: 1023 },
          { field: "bedrooms", min: 0, max: 15 },
        ],
      },
    },
    /** `.within({ price })` skip-scans `status`, a literal composite. */
    byStatus: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["region"] },
      sk: { field: "gsi2sk", composite: ["status", "price"] },
    },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Places } })
const tableLayer = MainTable.layer({ name: "main" })
const client = DynamoClient.make({ entities: { Places }, tables: { MainTable } })

let blobs: MemoryBlobStore = BlobStore.memory()
beforeEach(() => {
  resetStore()
  blobs = BlobStore.memory()
})
const gets = () => blobs.inspect().calls.get

/** 36 places in one region: prices 0..875, bedrooms 0..11, every status. */
const seed = Effect.suspend(() =>
  Effect.gen(function* () {
    const db = yield* client
    for (let n = 0; n < 36; n++) {
      yield* db.entities.Places.put({
        placeId: `p-${String(n).padStart(2, "0")}`,
        region: "r",
        status: STATUSES[n % 3]!,
        price: n * 25,
        bedrooms: n % 12,
        body: { text: `place ${n}: ${"x".repeat(40)}` },
      })
    }
  }).pipe(Effect.provide(Layer.mergeAll(InMemoryClient, tableLayer, BlobStore.layer(blobs)))),
)

/** Serve the stored rows as the partition of an index (`gsi1` or `gsi2`). */
const serve = (index: "gsi1" | "gsi2") => {
  const stored = [...rows.values()].filter((row) => row[`${index}sk`] !== undefined) as Array<Row>
  for (const row of stored) expect(BlobPointer.isPointerHeader(row.body!.B![0]!)).toBe(true)
  return makePartition({
    rows: stored,
    pkField: `${index}pk`,
    skField: `${index}sk`,
    keyFields: [`${index}pk`, `${index}sk`, "pk", "sk"],
    evaluateFilter: true,
  })
}

/** A query a `fetch` chain resumes. */
interface Fetchable<A> {
  readonly fetch: () => Effect.Effect<Query.Page<A>, unknown>
  readonly startFrom: (cursor: string) => Fetchable<A>
}

/** Every page of a `fetch` chain, from the start. */
const fetchAll = <A>(query: Fetchable<A>) =>
  Effect.gen(function* () {
    const pages: Array<Query.Page<A>> = []
    let cursor = Option.none<string>()
    do {
      const page = yield* Option.match(cursor, {
        onNone: () => query,
        onSome: (resume) => query.startFrom(resume),
      }).fetch()
      pages.push(page)
      cursor = page.cursor
      if (pages.length > 200) return yield* Effect.die(new Error("the fetch chain did not end"))
    } while (Option.isSome(cursor))
    return pages
  })

const ids = (items: ReadonlyArray<{ readonly placeId: string }>) =>
  items.map((item) => item.placeId)

/** Run `effect` over `partition`, the table and the store. */
const over =
  (partition: { readonly layer: Layer.Layer<DynamoClient> }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(Layer.mergeAll(partition.layer, tableLayer, BlobStore.layer(blobs))))

const BOX = { price: { gte: 100, lte: 700 }, bedrooms: { gte: 1, lte: 10 } } as const
const PRICE = { price: { gte: 150, lte: 650 } } as const

describe("Entity offload reads — planned queries fetch only the rows they return (#171)", () => {
  it.effect("a Z-order box: under limit, and across a fetch chain", () =>
    Effect.gen(function* () {
      yield* seed
      const partition = serve("gsi1")
      yield* over(partition)(
        Effect.gen(function* () {
          const db = yield* client
          const box = () => db.entities.Places.byBox({ region: "r" }).within(BOX)
          for (const strategy of ["jump", "precise"] as const) {
            const query = () => box().zorder({ strategy })
            expect((yield* query().explain()).plan).toBe(strategy)
            // Every row in the box, read without fetching anything.
            const start = gets()
            const all = yield* query().offloaded("lazy").collect()
            expect(all.length).toBeGreaterThan(6)
            expect(gets()).toBe(start)

            let before = gets()
            const two = yield* query().limit(2).collect()
            expect(ids(two)).toEqual(ids(all).slice(0, 2))
            expect(gets() - before).toBe(2)
            for (const place of two) expect(place.body.text).toMatch(/^place \d+: x+$/)

            before = gets()
            const pages = yield* fetchAll(query().limit(1))
            const paged = pages.flatMap((page) => page.items)
            expect(ids(paged)).toEqual(ids(all))
            expect(gets() - before).toBe(paged.length)
          }
        }),
      )
    }),
  )

  it.effect("a skip-scan, plain and filtered: under limit, and across a fetch chain", () =>
    Effect.gen(function* () {
      yield* seed
      const partition = serve("gsi2")
      yield* over(partition)(
        Effect.gen(function* () {
          const db = yield* client
          const plain = () => db.entities.Places.byStatus({ region: "r" }).within(PRICE)
          // About half the rows pass: each request asks for more rows than it still owes.
          const filtered = () => plain().filter((t, { gte }) => gte(t.bedrooms, 5))
          for (const query of [plain, filtered]) {
            expect((yield* query().explain()).plan).toBe("skip-scan")
            const start = gets()
            const all = yield* query().offloaded("lazy").collect()
            expect(new Set(all.map((place) => place.status)).size).toBe(3)
            expect(all.length).toBeGreaterThan(7)
            expect(gets()).toBe(start)

            let before = gets()
            const two = yield* query().limit(2).collect()
            expect(ids(two)).toEqual(ids(all).slice(0, 2))
            expect(gets() - before).toBe(2)

            before = gets()
            const pages = yield* fetchAll(query().limit(1))
            const paged = pages.flatMap((page) => page.items)
            expect(ids(paged)).toEqual(ids(all))
            expect(gets() - before).toBe(paged.length)

            // Past the first tuple's rows: the window never takes more than it owes.
            before = gets()
            const seven = yield* query().limit(7).collect()
            expect(ids(seven)).toEqual(ids(all).slice(0, 7))
            expect(gets() - before).toBe(7)
          }
        }),
      )
    }),
  )
})
