/**
 * Adaptive request sizing (#171): a query with a `limit` under a filter, a
 * `filterBy` predicate or rows dropped as history sizes each request's `Limit`
 * from the pass rate the earlier requests showed (rows accepted / rows
 * examined), instead of asking for a natural 1 MB page.
 *
 * - First request: twice the limit, at least 16 rows (history only: the limit).
 * - Nothing accepted yet: twice the last `Limit`.
 * - Then: `remaining / rate × 1.25`, the rate the lower of the cumulative one
 *   and the last request's own; at least twice the last `Limit` after a
 *   request that accepted nothing. Clamped to 1..100,000.
 *
 * A numeric `pageSize` is used as given, and `pageSize("natural")` and
 * `maxPages` keep 1.36's sizing. Results are unchanged throughout, and every
 * cursor resumes where 1.36's did — but a sized request that fills the limit
 * on its last returned row hands back DynamoDB's `LastEvaluatedKey`, which can
 * be non-null where 1.36's was null, so a fetch chain can end with one empty
 * page (design §8.4, §19 C9). Requests are served by a partition that honours
 * `Limit`, the 1 MB page cap and `ExclusiveStartKey` (`helpers/PartitionMock.ts`).
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { createConditionOps } from "../src/internal/Expr.js"
import { createPathBuilder } from "../src/internal/PathBuilder.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import { makePartition, ONE_MB, type Partition, type Row } from "./helpers/PartitionMock.js"

interface Product {
  readonly id: string
  readonly status: string
}

const ops = createConditionOps<Product>()
const pb = createPathBuilder<Product>()

const PK = "$shop#v1#product#store-1"
const skOf = (n: number) => `$shop#v1#product#${String(n).padStart(6, "0")}`

const productRow = (n: number, status: string): Row => ({
  pk: { S: PK },
  sk: { S: skOf(n) },
  id: { S: `p-${n}` },
  status: { S: status },
  __edd_e__: { S: "Product" },
})

/** `count` products numbered from 0, each `statusOf(n)`. */
const productRows = (count: number, statusOf: (n: number) => string): Array<Row> =>
  Array.from({ length: count }, (_, n) => productRow(n, statusOf(n)))

/** Every third product (0, 3, 6, …) is active. */
const everyThird = (n: number) => (n % 3 === 0 ? "active" : "sold")

const numberOf = (id: string | undefined) => Number(String(id).slice(2))
const isActive = (row: Row) => row.status?.S === "active"
/** `filterBy`'s stand-in for "active": the same rows, judged on the decoded item. */
const keepsThirds = (item: Product) => numberOf(item.id) % 3 === 0

const products = (options?: { readonly liveRows?: Query.LiveRows }) =>
  Query.make<Product>({
    tableName: "Products",
    indexName: undefined,
    pkField: "pk",
    pkValue: PK,
    skField: "sk",
    entityTypes: ["Product"],
    decoder: (raw) => Effect.succeed({ id: raw.id as string, status: raw.status as string }),
    keyFields: ["pk", "sk"],
    liveRows: options?.liveRows,
  })

/** Rows of products not numbered a multiple of 3 are history (an item's snapshots). */
const thirdsLive: Query.LiveRows = {
  isLive: (row) => numberOf(row.id?.S) % 3 === 0,
  reads: ["id"],
}

const activeOnly = Query.filterExpr(ops.eq(pb.status, "active"))

const ids = (items: ReadonlyArray<Product>) => items.map((item) => numberOf(item.id))

/** 100-byte rows on a page cap of `rows` rows. */
const cappedAt = (rows: number) => ({ rowBytes: () => 100, pageBytes: rows * 100 })

const decodeCursor = (cursor: string | null) => JSON.parse(atob(cursor!))

/**
 * Follow `query`'s `fetch` cursors to the end: each page's items, the sort key
 * its cursor resumes after (`null` at the end) and the `Limit`s it sent.
 */
const fetchChain = (partition: Partition, query: Query.Query<Product>) =>
  Effect.gen(function* () {
    const pages: Array<{
      readonly ids: Array<number>
      readonly after: string | null
      readonly limits: Array<number | undefined>
    }> = []
    let cursor: string | null = null
    do {
      partition.clear()
      const page: Query.Page<Product> = yield* Query.execute(
        cursor === null ? query : query.pipe(Query.startFrom(cursor)),
      )
      pages.push({
        ids: ids(page.items),
        after: page.cursor === null ? null : decodeCursor(page.cursor).sk.S,
        limits: partition.limits(),
      })
      cursor = page.cursor
    } while (cursor !== null && pages.length < 20)
    return pages
  })

describe("adaptive request sizing (#171)", () => {
  describe("the Limit follows the observed pass rate", () => {
    it.effect("a high pass rate sizes the next Limit near remaining × 1.25", () => {
      // 19 of every 20 products active; DynamoDB's page cap stops each request
      // at 40 rows, so the first (asking for 200) cannot fill the limit.
      const partition = makePartition({
        rows: productRows(200, (n) => (n % 20 === 19 ? "sold" : "active")),
        filter: isActive,
        ...cappedAt(40),
      })
      return Effect.gen(function* () {
        const items = yield* products().pipe(activeOnly, Query.limit(100), Query.collect)
        expect(items).toHaveLength(100)
        // 38 of 40 accepted: 62 owed / 0.95 × 1.25 → 82, then 24 owed → 32.
        expect(partition.limits()).toEqual([200, 82, 32])
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect("a low pass rate sizes the next Limit from the observed rate", () => {
      const partition = makePartition({
        rows: productRows(1000, (n) => (n % 10 === 0 ? "active" : "sold")),
        filter: isActive,
      })
      return Effect.gen(function* () {
        const items = yield* products().pipe(activeOnly, Query.limit(20), Query.collect)
        expect(ids(items)).toEqual(Array.from({ length: 20 }, (_, i) => i * 10))
        // 4 of 40 accepted (rate 0.1): 16 owed / 0.1 × 1.25 = 200.
        expect(partition.limits()).toEqual([40, 200])
        // A natural page would have examined all 1,000 rows.
        expect(partition.scanned()).toBe(240)
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect("nothing accepted doubles, then the rate takes over", () => {
      const partition = makePartition({
        rows: productRows(500, (n) => (n >= 100 && n % 10 === 0 ? "active" : "sold")),
        filter: isActive,
      })
      return Effect.gen(function* () {
        const items = yield* products().pipe(activeOnly, Query.limit(10), Query.collect)
        expect(ids(items)).toEqual([100, 110, 120, 130, 140, 150, 160, 170, 180, 190])
        // 20, 40 and 80 rows; the third accepts 4 of 140 examined, so the
        // 6 still owed ask for 6 / (4 / 140) × 1.25 = 262.5 → 263.
        expect(partition.limits()).toEqual([20, 40, 80, 263])
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect(
      "early cluster then long desert stays within a logarithmic margin of natural pages",
      () => {
        // 999 matches up front, then 100,000 rows that never match: the
        // cumulative rate alone would recover from 999 / 2,000 by about 0.125%
        // per request. After a request that accepts nothing the Limit at least
        // doubles, until DynamoDB's 1 MB page cap takes over.
        const desert = 100_000
        const rows = productRows(999 + desert, (n) => (n < 999 ? "active" : "sold"))
        const partition = makePartition({ rows, filter: isActive, rowBytes: () => 100 })
        return Effect.gen(function* () {
          const query = products().pipe(activeOnly, Query.limit(1000))
          const adaptive = yield* Query.collect(query)
          const adaptiveRequests = partition.inputs.length
          partition.clear()
          const natural = yield* Query.collect(query.pipe(Query.pageSize("natural")))
          const naturalPages = partition.inputs.length

          expect(adaptive).toHaveLength(999)
          expect(adaptive).toEqual(natural)
          expect(naturalPages).toBe(Math.ceil((rows.length * 100) / ONE_MB))
          expect(adaptiveRequests).toBeLessThanOrEqual(
            naturalPages + Math.ceil(Math.log2(rows.length)),
          )
        }).pipe(Effect.provide(partition.layer))
      },
      30_000,
    )

    it.effect(
      "early cluster then sparse trickle stays within a logarithmic margin of natural pages",
      () =>
        Effect.gen(function* () {
          // A cluster of matches up front, then isolated matches `gap` rows
          // apart. Sized from the cumulative rate alone, the request after each
          // isolated match would shrink to a few dozen rows and double again
          // through the next gap: 46 requests for the first shape, 61 for the
          // second. The last request's own rate sizes it for the gap instead.
          for (const { cluster, gap, trickle } of [
            { cluster: 990, gap: 1_000, trickle: 10 },
            { cluster: 900, gap: 2_000, trickle: 100 },
          ]) {
            const isMatch = (n: number) =>
              n < cluster || (n >= cluster + gap - 1 && (n - cluster + 1) % gap === 0)
            // The last match is followed by one more gap of misses.
            const rows = productRows(cluster + gap * (trickle + 1), (n) =>
              isMatch(n) ? "active" : "sold",
            )
            const partition = makePartition({ rows, filter: isActive, rowBytes: () => 100 })
            const query = products().pipe(activeOnly, Query.limit(1000))
            const adaptive = yield* Query.collect(query).pipe(Effect.provide(partition.layer))
            const adaptiveRequests = partition.inputs.length
            partition.clear()
            const natural = yield* Query.collect(query.pipe(Query.pageSize("natural"))).pipe(
              Effect.provide(partition.layer),
            )
            const naturalPages = partition.inputs.length

            expect(adaptive).toHaveLength(1000)
            expect(adaptive).toEqual(natural)
            expect(adaptiveRequests).toBeLessThanOrEqual(
              naturalPages + Math.ceil(Math.log2(rows.length)),
            )
          }
        }),
      30_000,
    )

    it.effect("the first filtered request asks for max(16, ceil(limit × 2))", () => {
      const partition = makePartition({ rows: productRows(400, everyThird), filter: isActive })
      return Effect.gen(function* () {
        for (const [limit, first] of [
          [1, 16],
          [8, 16],
          [9, 18],
          [100, 200],
        ] as const) {
          partition.clear()
          yield* products().pipe(activeOnly, Query.limit(limit), Query.execute)
          expect(partition.limits()[0]).toBe(first)
          partition.clear()
          yield* products().pipe(Query.filterBy(keepsThirds), Query.limit(limit), Query.execute)
          expect(partition.limits()[0]).toBe(first)
        }
        // Rows dropped only as history: #133's first request, the limit itself.
        partition.clear()
        yield* products({ liveRows: thirdsLive }).pipe(Query.limit(9), Query.execute)
        expect(partition.limits()[0]).toBe(9)
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect("a grown Limit stops at 100,000", () => {
      const partition = makePartition({
        rows: productRows(30, () => "sold"),
        filter: isActive,
        ...cappedAt(10),
      })
      return Effect.gen(function* () {
        const items = yield* products().pipe(activeOnly, Query.limit(30_000), Query.collect)
        expect(items).toEqual([])
        // 60,000, then twice that clamped to 100,000; the third page reaches
        // the page cap on the partition's last row, so a fourth finds nothing.
        expect(partition.limits()).toEqual([60_000, 100_000, 100_000, 100_000])
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect("a missing ScannedCount falls back to Items.length", () => {
      const rows = productRows(100, (n) => (n % 2 === 0 ? "active" : "sold"))
      const reported = makePartition({ rows, filter: isActive, ...cappedAt(10) })
      const unreported = makePartition({
        rows,
        filter: isActive,
        ...cappedAt(10),
        omitScannedCount: true,
      })
      const run = products().pipe(activeOnly, Query.limit(20), Query.collect)
      return Effect.gen(function* () {
        // 5 of 10 rows pass each page: a rate of 0.5.
        expect(ids(yield* run.pipe(Effect.provide(reported.layer)))).toHaveLength(20)
        expect(reported.limits()).toEqual([40, 38, 25, 13])
        // Without ScannedCount only the 5 rows returned are known: a rate of 1,
        // so each request asks for too few rows and one more is needed.
        expect(ids(yield* run.pipe(Effect.provide(unreported.layer)))).toHaveLength(20)
        expect(unreported.limits()).toEqual([40, 19, 13, 7, 2])
      })
    })
  })

  describe("pageSize and maxPages", () => {
    it.effect("a numeric pageSize is used as given", () => {
      const partition = makePartition({ rows: productRows(100, everyThird), filter: isActive })
      return Effect.gen(function* () {
        const items = yield* products().pipe(
          activeOnly,
          Query.limit(5),
          Query.pageSize(7),
          Query.collect,
        )
        expect(ids(items)).toEqual([0, 3, 6, 9, 12])
        expect(partition.limits()).toEqual([7, 7])
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect('pageSize("natural") reproduces every 1.36 Limit', () =>
      Effect.gen(function* () {
        // 30 rows, 10 to a page. Each case: its query, what the partition's
        // filter keeps, and the `Limit`s 1.36 sent.
        const cases: ReadonlyArray<
          readonly [string, Query.Query<Product>, ((row: Row) => boolean) | undefined, unknown]
        > = [
          ["filter", products().pipe(activeOnly, Query.limit(5)), isActive, [undefined, undefined]],
          [
            "predicate",
            products().pipe(Query.filterBy(keepsThirds), Query.limit(5)),
            undefined,
            [undefined, undefined],
          ],
          // #133: the limit, then twice the last.
          ["history", products({ liveRows: thirdsLive }).pipe(Query.limit(5)), undefined, [5, 10]],
          // The outstanding budget.
          ["budget", products().pipe(Query.limit(12)), undefined, [12, 2]],
          // No limit: natural pages until the range is exhausted.
          [
            "none",
            products().pipe(activeOnly),
            isActive,
            [undefined, undefined, undefined, undefined],
          ],
        ]
        for (const [name, query, filter, sent] of cases) {
          const partition = makePartition({
            rows: productRows(30, everyThird),
            filter,
            ...cappedAt(10),
          })
          yield* Query.collect(query.pipe(Query.pageSize("natural"))).pipe(
            Effect.provide(partition.layer),
          )
          expect([name, partition.limits()]).toEqual([name, sent])
        }
      }),
    )

    it.effect("limit + filter + maxPages keeps the 1.36 Limits and results", () => {
      const partition = makePartition({
        rows: productRows(30, everyThird),
        filter: isActive,
        ...cappedAt(10),
      })
      return Effect.gen(function* () {
        // One natural page: the 4 matches among rows 0..9, and its LastEvaluatedKey.
        const page = yield* products().pipe(
          activeOnly,
          Query.limit(5),
          Query.maxPages(1),
          Query.execute,
        )
        expect(partition.limits()).toEqual([undefined])
        expect(ids(page.items)).toEqual([0, 3, 6, 9])
        expect(decodeCursor(page.cursor)).toEqual({ pk: { S: PK }, sk: { S: skOf(9) } })
        partition.clear()
        const natural = yield* products().pipe(
          activeOnly,
          Query.limit(5),
          Query.maxPages(1),
          Query.pageSize("natural"),
          Query.execute,
        )
        expect(natural).toEqual(page)
        // Two pages fill the limit; the cursor is rebuilt from the last item kept.
        partition.clear()
        const two = yield* products().pipe(
          activeOnly,
          Query.limit(5),
          Query.maxPages(2),
          Query.execute,
        )
        expect(partition.limits()).toEqual([undefined, undefined])
        expect(ids(two.items)).toEqual([0, 3, 6, 9, 12])
        expect(decodeCursor(two.cursor)).toEqual({ pk: { S: PK }, sk: { S: skOf(12) } })
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect("maxPages still caps requests", () => {
      const partition = makePartition({
        rows: productRows(100, (n) => (n % 10 === 0 ? "active" : "sold")),
        filter: isActive,
        ...cappedAt(10),
      })
      return Effect.gen(function* () {
        const capped = yield* products().pipe(
          activeOnly,
          Query.limit(50),
          Query.maxPages(2),
          Query.collect,
        )
        expect(ids(capped)).toEqual([0, 10])
        expect(partition.inputs).toHaveLength(2)
        partition.clear()
        const sized = yield* products().pipe(
          activeOnly,
          Query.limit(50),
          Query.pageSize(4),
          Query.maxPages(3),
          Query.collect,
        )
        expect(ids(sized)).toEqual([0, 10])
        expect(partition.limits()).toEqual([4, 4, 4])
      }).pipe(Effect.provide(partition.layer))
    })
  })

  describe("results and cursors", () => {
    it.effect("the cursor follows the last accepted item (#122)", () => {
      const partition = makePartition({ rows: productRows(60, everyThird), filter: isActive })
      return Effect.gen(function* () {
        const query = products().pipe(activeOnly, Query.limit(3))
        // The first request examines 16 rows and returns 6 matches: 3 are
        // kept, so the cursor is rebuilt from the third, not the page's end.
        const first = yield* Query.execute(query)
        expect(partition.limits()).toEqual([16])
        expect(ids(first.items)).toEqual([0, 3, 6])
        expect(decodeCursor(first.cursor)).toEqual({ pk: { S: PK }, sk: { S: skOf(6) } })

        const chained: Array<number> = [...ids(first.items)]
        let cursor = first.cursor
        for (let pages = 0; cursor !== null && pages < 20; pages++) {
          const page = yield* Query.execute(query.pipe(Query.startFrom(cursor)))
          chained.push(...ids(page.items))
          cursor = page.cursor
        }
        expect(cursor).toBeNull()
        expect(chained).toEqual(ids(yield* Query.collect(products().pipe(activeOnly))))
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect(
      "a limit filled on a sized request's last returned row keeps LastEvaluatedKey, so the chain ends with an empty page",
      () => {
        const partition = makePartition({ rows: productRows(30, everyThird), filter: isActive })
        return Effect.gen(function* () {
          const query = products().pipe(activeOnly, Query.limit(5))
          const adaptive = yield* fetchChain(partition, query)
          const natural = yield* fetchChain(partition, query.pipe(Query.pageSize("natural")))

          // The second request examines rows 13..28 and fills the limit on
          // product 27, its last match: the cursor is row 28, a later row the
          // filter rejected, where the natural page read on to the end of the
          // partition and returned null. The third finds nothing.
          expect(adaptive).toEqual([
            { ids: [0, 3, 6, 9, 12], after: skOf(12), limits: [16] },
            { ids: [15, 18, 21, 24, 27], after: skOf(28), limits: [16] },
            { ids: [], after: null, limits: [16] },
          ])
          expect(natural).toEqual([
            { ids: [0, 3, 6, 9, 12], after: skOf(12), limits: [undefined] },
            { ids: [15, 18, 21, 24, 27], after: null, limits: [undefined] },
          ])
          const all = ids(yield* Query.collect(products().pipe(activeOnly)))
          expect(adaptive.flatMap((page) => page.ids)).toEqual(all)
          expect(natural.flatMap((page) => page.ids)).toEqual(all)
        }).pipe(Effect.provide(partition.layer))
      },
    )

    it.effect("a reverse fetch chain returns collect's items, in reverse", () => {
      // Products 30..59 match every third; rows 29..0 are a tail of misses.
      const partition = makePartition({
        rows: productRows(60, (n) => (n >= 30 ? everyThird(n) : "sold")),
        filter: isActive,
      })
      return Effect.gen(function* () {
        const query = products().pipe(activeOnly, Query.reverse, Query.limit(5))
        const adaptive = yield* fetchChain(partition, query)
        const natural = yield* fetchChain(partition, query.pipe(Query.pageSize("natural")))

        // Each sized request fills the limit on its last match, so its cursor
        // is the request's last row; the third reads the tail and finds nothing.
        expect(adaptive).toEqual([
          { ids: [57, 54, 51, 48, 45], after: skOf(44), limits: [16] },
          { ids: [42, 39, 36, 33, 30], after: skOf(28), limits: [16] },
          { ids: [], after: null, limits: [16, 32] },
        ])
        // A natural page fills the first limit mid-page (#122: the cursor is
        // the last item kept), then reads to the start of the partition.
        expect(natural).toEqual([
          { ids: [57, 54, 51, 48, 45], after: skOf(45), limits: [undefined] },
          { ids: [42, 39, 36, 33, 30], after: null, limits: [undefined] },
        ])
        const all = ids(yield* Query.collect(products().pipe(activeOnly, Query.reverse)))
        expect(adaptive.flatMap((page) => page.ids)).toEqual(all)
        expect(natural.flatMap((page) => page.ids)).toEqual(all)
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect(
      "estimator state lives in PageState: re-running the stream sends the same Limits",
      () => {
        const partition = makePartition({
          rows: productRows(1000, (n) => (n % 10 === 0 ? "active" : "sold")),
          filter: isActive,
        })
        return Effect.gen(function* () {
          const stream = yield* products().pipe(activeOnly, Query.limit(10), Query.paginate)
          const first = yield* Stream.runCollect(stream)
          const firstLimits = partition.limits()
          partition.clear()
          const second = yield* Stream.runCollect(stream)

          expect(ids(first.flat())).toEqual(Array.from({ length: 10 }, (_, i) => i * 10))
          // One array per request, so the page boundaries follow the sized
          // requests (design §19 C10); a natural page would hold all 10.
          expect(first.map((page) => page.length)).toEqual([2, 8])
          expect(second).toEqual(first)
          // 2 of 20 accepted: 8 owed / 0.1 × 1.25 = 100.
          expect(firstLimits).toEqual([20, 100])
          expect(partition.limits()).toEqual(firstLimits)
        }).pipe(Effect.provide(partition.layer))
      },
    )
  })

  describe("collections and count", () => {
    const AppSchema = DynamoSchema.make({ name: "shop", version: 1 })

    class Listing extends Schema.Class<Listing>("Listing")({
      listingId: Schema.String,
      storeId: Schema.String,
      status: Schema.String,
    }) {}
    class Offer extends Schema.Class<Offer>("Offer")({
      offerId: Schema.String,
      storeId: Schema.String,
      status: Schema.String,
    }) {}

    const byStore = <const Id extends string>(id: Id) =>
      ({
        name: "gsi1",
        collection: "Catalog",
        pk: { field: "gsi1pk", composite: ["storeId"] },
        sk: { field: "gsi1sk", composite: [id] },
      }) as const
    const Listings = Entity.make({
      model: Listing,
      entityType: "Listing",
      primaryKey: {
        pk: { field: "pk", composite: ["listingId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: { byStore: byStore("listingId") },
    })
    const Offers = Entity.make({
      model: Offer,
      entityType: "Offer",
      primaryKey: {
        pk: { field: "pk", composite: ["offerId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: { byStore: byStore("offerId") },
    })
    const MainTable = Table.make({ schema: AppSchema, entities: { Listings, Offers } })

    /** Listings at even positions, offers at odd; every third is active. */
    const catalogRows = Array.from({ length: 60 }, (_, n): Row => {
      const listing = n % 2 === 0
      const id = `${listing ? "l" : "o"}-${n}`
      return {
        pk: { S: `$shop#v1#${listing ? "listing" : "offer"}#${id}` },
        sk: { S: `$shop#v1#${listing ? "listing" : "offer"}` },
        gsi1pk: { S: "$shop#v1#catalog#s-1" },
        gsi1sk: { S: `$shop#v1#catalog#${String(n).padStart(4, "0")}` },
        [listing ? "listingId" : "offerId"]: { S: id },
        storeId: { S: "s-1" },
        status: { S: everyThird(n) },
        __edd_e__: { S: listing ? "Listing" : "Offer" },
      }
    })

    it.effect("a collection query with a filter and a limit adapts", () => {
      const partition = makePartition({
        rows: catalogRows,
        pkField: "gsi1pk",
        skField: "gsi1sk",
        keyFields: ["gsi1pk", "gsi1sk", "pk", "sk"],
        filter: isActive,
      })
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Listings, Offers },
          tables: { MainTable },
        })
        const events: Array<Query.QueryRequestEvent> = []
        const grouped = (yield* db.collections.Catalog!({ storeId: "s-1" })
          .filter({ status: "active" })
          .limit(8)
          .onRequest((event) => Effect.sync(() => events.push(event)))
          .collect()) as {
          readonly Listings: ReadonlyArray<Listing>
          readonly Offers: ReadonlyArray<Offer>
        }
        expect(grouped.Listings.map((l) => l.listingId)).toEqual(["l-0", "l-6", "l-12", "l-18"])
        expect(grouped.Offers.map((o) => o.offerId)).toEqual(["o-3", "o-9", "o-15", "o-21"])
        // 6 of 16 accepted: 2 owed / 0.375 × 1.25 → 7.
        expect(partition.limits()).toEqual([16, 7])
        expect(events.map((event) => [event.request, event.limit, event.accepted])).toEqual([
          [1, 16, 6],
          [2, 7, 2],
        ])

        partition.clear()
        yield* db.collections.Catalog!({ storeId: "s-1" })
          .filter({ status: "active" })
          .limit(8)
          .pageSize("natural")
          .collect()
        expect(partition.limits()).toEqual([undefined])
      }).pipe(Effect.provide(Layer.merge(partition.layer, MainTable.layer({ name: "shop" }))))
    })

    it.effect("count path 1 (filterBy) adapts through collect", () => {
      const partition = makePartition({ rows: productRows(60, everyThird) })
      return Effect.gen(function* () {
        const counted = yield* products().pipe(
          Query.filterBy(keepsThirds),
          Query.limit(8),
          Query.count,
        )
        expect(counted).toBe(8)
        // The rows are read (a predicate needs items): 6 of 16, then 7 rows.
        expect(partition.limits()).toEqual([16, 7])
        expect(partition.inputs.every((input) => input.Select === undefined)).toBe(true)
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect("count path 2 (history rows) adapts", () => {
      const partition = makePartition({ rows: productRows(60, everyThird) })
      return Effect.gen(function* () {
        const events: Array<Query.QueryRequestEvent> = []
        const query = products({ liveRows: thirdsLive }).pipe(
          Query.limit(4),
          Query.onRequest((event) => Effect.sync(() => events.push(event))),
        )
        expect(yield* Query.count(query)).toBe(4)
        // 2 of 4 live, then 2 owed / 0.5 × 1.25 = 5. That request finds 1 of 5:
        // below the cumulative 3 of 9, so 1 owed / (1 / 5) × 1.25 → 7.
        expect(partition.limits()).toEqual([4, 5, 7])
        expect(events.map((event) => [event.kind, event.accepted])).toEqual([
          ["count", 2],
          ["count", 1],
          ["count", 3],
        ])
        partition.clear()
        expect(yield* Query.count(query.pipe(Query.pageSize("natural")))).toBe(4)
        expect(partition.limits()).toEqual([4, 8])
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect("count path 3 (Select COUNT) with a limit sizes from Count", () => {
      const rows = productRows(60, everyThird)
      const reported = makePartition({ rows, filter: isActive })
      const unreported = makePartition({ rows, filter: isActive, omitScannedCount: true })
      const query = products().pipe(activeOnly, Query.limit(8))
      return Effect.gen(function* () {
        expect(yield* Query.count(query).pipe(Effect.provide(reported.layer))).toBe(8)
        expect(reported.inputs.every((input) => input.Select === "COUNT")).toBe(true)
        // Count 6 of ScannedCount 16, then 2 owed / 0.375 × 1.25 → 7.
        expect(reported.limits()).toEqual([16, 7])
        // Without ScannedCount, Count stands in for it: the rate reads as 1.
        expect(yield* Query.count(query).pipe(Effect.provide(unreported.layer))).toBe(8)
        expect(unreported.limits()).toEqual([16, 3, 2, 4])
        // With maxPages: 1.36's natural pages.
        reported.clear()
        expect(
          yield* Query.count(query.pipe(Query.maxPages(1))).pipe(Effect.provide(reported.layer)),
        ).toBe(8)
        expect(reported.limits()).toEqual([undefined])
      })
    })

    it.effect("count without a limit is unchanged", () =>
      Effect.gen(function* () {
        for (const [query, filter, counted] of [
          [products().pipe(activeOnly), isActive, 10],
          [products().pipe(Query.filterBy(keepsThirds)), undefined, 10],
          [products({ liveRows: thirdsLive }), undefined, 10],
        ] as const) {
          const partition = makePartition({
            rows: productRows(30, everyThird),
            filter,
            ...cappedAt(10),
          })
          expect(yield* Query.count(query).pipe(Effect.provide(partition.layer))).toBe(counted)
          expect(partition.limits()).toEqual([undefined, undefined, undefined, undefined])
        }
      }),
    )
  })

  describe("onRequest", () => {
    it.effect(
      "onRequest sees one event per request with limit, scannedCount, count and accepted",
      () => {
        const partition = makePartition({ rows: productRows(60, everyThird), filter: isActive })
        return Effect.gen(function* () {
          const log: Array<string> = []
          const events: Array<Query.QueryRequestEvent> = []
          const query = products().pipe(
            Query.where({ between: [skOf(0), skOf(59)] }),
            activeOnly,
            Query.limit(8),
            Query.onRequest((event) =>
              Effect.sync(() => {
                log.push(`a${event.request}`)
                events.push(event)
              }),
            ),
            Query.onRequest((event) => Effect.sync(() => log.push(`b${event.request}`))),
          )
          const bounds = { lower: skOf(0), upper: skOf(59) }

          yield* Query.collect(query)
          expect(log).toEqual(["a1", "b1", "a2", "b2"])
          expect(events).toEqual([
            {
              kind: "read",
              request: 1,
              ...bounds,
              limit: 16,
              scannedCount: 16,
              count: 6,
              accepted: 6,
              discarded: false,
            },
            {
              kind: "read",
              request: 2,
              ...bounds,
              limit: 7,
              scannedCount: 7,
              count: 2,
              accepted: 2,
              discarded: false,
            },
          ])

          // Numbered per terminal call; `count` reports its own kind.
          events.length = 0
          yield* Query.count(query)
          expect(events.map((event) => [event.kind, event.request, event.accepted])).toEqual([
            ["count", 1, 6],
            ["count", 2, 2],
          ])

          // Accepted counts what became items: 6 rows passed the filter, 5 were kept.
          events.length = 0
          yield* Query.execute(query.pipe(Query.limit(5)))
          expect(events).toEqual([
            {
              kind: "read",
              request: 1,
              ...bounds,
              limit: 16,
              scannedCount: 16,
              count: 6,
              accepted: 5,
              discarded: false,
            },
          ])

          // A stream reports each page as it is pulled.
          events.length = 0
          yield* Stream.runCollect(yield* Query.paginate(query))
          expect(events.map((event) => event.request)).toEqual([1, 2])
        }).pipe(Effect.provide(partition.layer))
      },
    )

    it.effect("onRequest shows the key condition sent as its bounds", () => {
      const partition = makePartition({ rows: productRows(5, everyThird) })
      return Effect.gen(function* () {
        const seen: Array<readonly [string | undefined, string | undefined]> = []
        const observe = Query.onRequest((event) =>
          Effect.sync(() => seen.push([event.lower, event.upper])),
        )
        for (const condition of [
          { eq: skOf(1) },
          { gt: skOf(1) },
          { gte: skOf(1) },
          { lt: skOf(3) },
          { lte: skOf(3) },
          { between: [skOf(1), skOf(3)] as const },
          { beginsWith: "$shop#v1#product#" },
        ] satisfies ReadonlyArray<Query.SortKeyCondition>) {
          yield* products().pipe(Query.where(condition), observe, Query.execute)
        }
        yield* products().pipe(observe, Query.execute)
        yield* Query.makeScan<Product>({
          tableName: "Products",
          indexName: undefined,
          entityTypes: ["Product"],
          decoder: (raw) => Effect.succeed(raw as unknown as Product),
        }).pipe(observe, Query.execute)
        expect(seen).toEqual([
          [skOf(1), skOf(1)],
          [skOf(1), undefined],
          [skOf(1), undefined],
          [undefined, skOf(3)],
          [undefined, skOf(3)],
          [skOf(1), skOf(3)],
          ["$shop#v1#product#", undefined],
          [undefined, undefined],
          [undefined, undefined],
        ])
      }).pipe(Effect.provide(partition.layer))
    })

    it.effect("an observer failure is a defect", () => {
      const partition = makePartition({ rows: productRows(5, everyThird) })
      return Effect.gen(function* () {
        const failing = yield* products().pipe(
          Query.onRequest(() => Effect.fail("observer failed") as unknown as Effect.Effect<void>),
          Query.collect,
          Effect.exit,
        )
        expect(Exit.isFailure(failing) && Cause.hasDies(failing.cause)).toBe(true)
        const throwing = yield* products().pipe(
          Query.onRequest(() => {
            throw new Error("observer threw")
          }),
          Query.collect,
          Effect.exit,
        )
        expect(Exit.isFailure(throwing) && Cause.hasDies(throwing.cause)).toBe(true)
      }).pipe(Effect.provide(partition.layer))
    })
  })

  it("pageSize rejects an unknown string with EDD-9095", () => {
    expect(products().pipe(Query.pageSize("natural"))._state.pageSizeValue).toBe("natural")
    expect(() => products().pipe(Query.pageSize("big" as unknown as number))).toThrow(
      /\[EDD-9095\] pageSize\("big"\)/,
    )
    // Numbers are DynamoDB's to judge: stored as given.
    expect(products().pipe(Query.pageSize(0))._state.pageSizeValue).toBe(0)
  })
})
