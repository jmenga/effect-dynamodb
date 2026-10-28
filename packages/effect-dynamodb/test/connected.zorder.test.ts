/**
 * #171: adaptive request sizing, skip-scan and Z-order indexes — connected
 * tests against DynamoDB Local. The Z-order cases seed 2,600 listings
 * (`helpers/ZOrderListings.ts`) and compare every strategy against a
 * brute-force scan, in the index order the stored binary keys give.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * One store's 2,000 products share a partition; 1 in 100 of the first 1,000
 * is discontinued, and the last 1,000 are a tail with none. A query for a few
 * discontinued products is the selective-filter case adaptive sizing is for:
 * what it examines (Σ `ScannedCount`, observed through `onRequest`) is
 * compared against natural 1 MB pages, and what it returns against
 * `pageSize("natural")`, which sizes requests as 1.36 did.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, DateTime, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Cursor from "../src/internal/Cursor.js"
import type * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import { compareBytes } from "./helpers/PartitionMock.js"
import * as ZListings from "./helpers/ZOrderListings.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local isn't reachable
// ---------------------------------------------------------------------------

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}

const describeConnected = dynamoAvailable ? describe : describe.skip

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "sizing-conn", version: 1 })
const tableName = `sizing-conn-${Date.now()}`

class Product extends Schema.Class<Product>("Product")({
  storeId: Schema.String,
  productId: Schema.String,
  status: Schema.Literals(["active", "discontinued"]),
  price: Schema.Number,
}) {}

const Products = Entity.make({
  model: Product,
  entityType: "Product",
  primaryKey: {
    pk: { field: "pk", composite: ["storeId"] },
    sk: { field: "sk", composite: ["productId"] },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Products } })

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TestLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)

const STORE = "store-1"
const PRODUCTS = 2_000
/** Products 37, 137, …, 937 are discontinued: 10 of 2,000, then a 1,062-product tail. */
const isDiscontinued = (n: number) => n < 1_000 && n % 100 === 37

const product = (n: number) =>
  new Product({
    storeId: STORE,
    productId: `p-${String(n).padStart(4, "0")}`,
    status: isDiscontinued(n) ? "discontinued" : "active",
    price: 100 + (n % 50),
  })

const discontinuedIds = Array.from({ length: PRODUCTS }, (_, n) => n)
  .filter(isDiscontinued)
  .map((n) => product(n).productId)

/** Rows examined and items accepted, summed over a terminal's requests. */
const observed = () => {
  const events: Array<Query.QueryRequestEvent> = []
  return {
    events,
    observer: (event: Query.QueryRequestEvent) => Effect.sync(() => events.push(event)),
    scanned: () => events.reduce((sum, event) => sum + event.scannedCount, 0),
  }
}

const decodeCursor = (cursor: string | null) => (cursor === null ? null : JSON.parse(atob(cursor)))

describeConnected("#171 adaptive request sizing — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
        yield* Batch.write(Array.from({ length: PRODUCTS }, (_, n) => Products.put(product(n))))
      }).pipe(provide),
    )
  }, 120_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 30_000)

  it.effect(
    "adaptive sizing returns the same items with less ScannedCount than natural pages for a selective filter with limit(5)",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Products }, tables: { MainTable } })
        const query = () =>
          db.entities.Products.primary({ storeId: STORE })
            .filter({ status: "discontinued" })
            .limit(5)

        const adaptive = observed()
        const sized = yield* query().onRequest(adaptive.observer).collect()
        const natural = observed()
        const pages = yield* query().pageSize("natural").onRequest(natural.observer).collect()

        expect(sized.map((p) => p.productId)).toEqual(discontinuedIds.slice(0, 5))
        expect(sized).toEqual(pages)
        // A natural page reads every product of the store (well under 1 MB);
        // sized requests stop soon after the fifth match (product 437).
        expect(natural.events.map((event) => event.limit)).toEqual([undefined])
        expect(natural.scanned()).toBe(PRODUCTS)
        expect(adaptive.events[0]!.limit).toBe(16)
        expect(adaptive.scanned()).toBeLessThan(natural.scanned())
        expect(adaptive.scanned()).toBeGreaterThanOrEqual(438)
        expect(adaptive.events.reduce((sum, event) => sum + event.accepted, 0)).toBe(5)
      }).pipe(provide),
  )

  it.effect(
    "a fetch chain returns natural's pages under adaptive sizing, then one empty page",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Products }, tables: { MainTable } })
        const chain = (natural: boolean) =>
          Effect.gen(function* () {
            const pages: Array<{ readonly ids: Array<string>; readonly cursor: unknown }> = []
            let cursor: string | null = null
            do {
              let query = db.entities.Products.primary({ storeId: STORE })
                .filter({ status: "discontinued" })
                .limit(5)
              if (natural) query = query.pageSize("natural")
              if (cursor !== null) query = query.startFrom(cursor)
              const page: Query.Page<Product> = yield* query.fetch()
              pages.push({
                ids: page.items.map((p) => p.productId),
                cursor: decodeCursor(page.cursor),
              })
              cursor = page.cursor
            } while (cursor !== null && pages.length < 20)
            return pages
          })

        const adaptive = yield* chain(false)
        const natural = yield* chain(true)

        // The second page fills the limit on product 937, the last match. The
        // natural page read on to the end of the partition and returned null;
        // the sized request stopped well short of the tail, at its `Limit`, and
        // returned DynamoDB's LastEvaluatedKey — so the adaptive chain has one
        // more page, empty (design §8.4, §19 C9).
        expect(natural.map((page) => page.ids)).toEqual([
          discontinuedIds.slice(0, 5),
          discontinuedIds.slice(5),
        ])
        expect(natural.at(-1)!.cursor).toBeNull()
        expect(adaptive.map((page) => page.ids)).toEqual([...natural.map((page) => page.ids), []])
        expect(adaptive.at(-2)!.cursor).not.toBeNull()
        expect(adaptive.at(-1)!.cursor).toBeNull()
        // Each cursor resumes at the same place. A natural page fills the limit
        // mid-page, so its cursor is rebuilt from the last item kept (#122); a
        // sized request may fill it on its last returned row and keep DynamoDB's
        // LastEvaluatedKey instead — a later row the filter rejected, never one
        // past an item still owed.
        const productIdAt = (cursor: unknown) =>
          String((cursor as { readonly sk: { readonly S: string } }).sk.S)
            .split("_")
            .at(-1)!
        adaptive.forEach((page, i) => {
          if (page.cursor === null) return
          const at = productIdAt(page.cursor)
          const naturalCursor = natural[i]!.cursor
          if (naturalCursor !== null) expect(at >= productIdAt(naturalCursor)).toBe(true)
          expect(at >= page.ids.at(-1)!).toBe(true)
          const next = adaptive[i + 1]!.ids[0]
          if (next !== undefined) expect(at < next).toBe(true)
        })
      }).pipe(provide),
  )

  it.effect("count with a limit and a filter equals the natural count", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Products }, tables: { MainTable } })
      const query = (limit: number) =>
        db.entities.Products.primary({ storeId: STORE })
          .filter({ status: "discontinued" })
          .limit(limit)

      for (const limit of [5, 50]) {
        const adaptive = observed()
        const natural = observed()
        const sized = yield* query(limit).onRequest(adaptive.observer).count()
        const pages = yield* query(limit).pageSize("natural").onRequest(natural.observer).count()

        expect(sized).toBe(Math.min(limit, discontinuedIds.length))
        expect(sized).toBe(pages)
        expect(sized).toBe((yield* query(limit).collect()).length)
        expect(adaptive.events.every((event) => event.kind === "count")).toBe(true)
        expect(adaptive.scanned()).toBeLessThanOrEqual(natural.scanned())
      }
    }).pipe(provide),
  )
})

// ---------------------------------------------------------------------------
// Skip-scan (design §7)
// ---------------------------------------------------------------------------

const skipTableName = `skipscan-conn-${Date.now()}`

const LISTING_STATUSES = ["active", "draft", "pending", "sold"] as const

class Listing extends Schema.Class<Listing>("Listing")({
  storeId: Schema.String,
  listingId: Schema.String,
  status: Schema.Literals(LISTING_STATUSES),
  price: Schema.Number,
}) {}

/** Listings by store, then status, price and id: a price bound leaves `status` as the skip tuple. */
const Listings = Entity.make({
  model: Listing,
  entityType: "Listing",
  primaryKey: {
    pk: { field: "pk", composite: ["listingId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byStore: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["storeId"] },
      sk: { field: "gsi1sk", composite: ["status", "price", "listingId"] },
    },
  },
})

const SkipTable = Table.make({ schema: AppSchema, entities: { Listings } })
const provideSkip = Effect.provide(
  Layer.mergeAll(ClientLayer, SkipTable.layer({ name: skipTableName })),
)

const LISTINGS = 1_200
const listing = (n: number) =>
  new Listing({
    storeId: STORE,
    listingId: `l-${String(n).padStart(4, "0")}`,
    status: LISTING_STATUSES[(n * 7) % LISTING_STATUSES.length]!,
    price: (n * 37) % 1_000,
  })
const allListings = Array.from({ length: LISTINGS }, (_, n) => listing(n))

/** Prices 100–149: 5% of each status. */
const PRICE = { gte: 100, lte: 149 } as const
const inPrice = (l: Listing) => l.price >= PRICE.gte && l.price <= PRICE.lte

/** Index order: status, then price, then id (every key is ASCII). */
const indexOrder = (a: Listing, b: Listing) =>
  a.status !== b.status
    ? a.status < b.status
      ? -1
      : 1
    : a.price !== b.price
      ? a.price - b.price
      : a.listingId < b.listingId
        ? -1
        : 1
const expectedIds = allListings
  .filter(inPrice)
  .sort(indexOrder)
  .map((l) => l.listingId)

const listingIds = (items: ReadonlyArray<Listing>) => items.map((l) => l.listingId)

interface Fetchable<A> {
  readonly fetch: () => Effect.Effect<Query.Page<A>, unknown>
  readonly startFrom: (cursor: string) => Fetchable<A>
}

/** A fetch chain's pages, from the start. */
const fetchChain = <A>(query: Fetchable<A>) =>
  Effect.gen(function* () {
    const pages: Array<Query.Page<A>> = []
    let cursor: string | null | undefined
    while (cursor !== null && pages.length < 500) {
      const page = yield* (cursor === undefined ? query : query.startFrom(cursor)).fetch()
      pages.push(page)
      cursor = page.cursor
    }
    return pages
  })

describeConnected("#171 skip-scan — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: skipTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(SkipTable),
        })
        yield* Batch.write(allListings.map((l) => Listings.put(l)))
      }).pipe(provideSkip),
    )
  }, 120_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: skipTableName })
      }).pipe(
        provideSkip,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 30_000)

  const listingsDb = () => DynamoClient.make({ entities: { Listings }, tables: { SkipTable } })

  it.effect(
    "skip-scan over a literals status composite equals a filtered read with fewer rows examined",
    () =>
      Effect.gen(function* () {
        const db = yield* listingsDb()
        const skip = observed()
        const query = db.entities.Listings.byStore({ storeId: STORE })
          .within({ price: PRICE })
          .onRequest(skip.observer)
        expect((yield* query.explain()).plan).toBe("skip-scan")
        const skipped = yield* query.collect()

        const full = observed()
        const filtered = yield* db.entities.Listings.byStore({ storeId: STORE })
          .filter((t, { between }) => between(t.price, PRICE.gte, PRICE.lte))
          .onRequest(full.observer)
          .collect()

        expect(listingIds(skipped)).toEqual(expectedIds)
        expect(skipped).toEqual(filtered)
        // One probe per status, plus the one that finds none; each tuple read
        // examines only its matching rows.
        expect(skip.events.filter((event) => event.kind === "probe")).toHaveLength(
          LISTING_STATUSES.length + 1,
        )
        expect(full.scanned()).toBe(LISTINGS)
        expect(skip.scanned()).toBe(expectedIds.length + LISTING_STATUSES.length)
        expect(skip.scanned()).toBeLessThan(full.scanned() / 10)
        expect(yield* query.count()).toBe(expectedIds.length)
      }).pipe(provideSkip),
  )

  it.effect(
    "fetch cursor chains through a skip-scan equal one collect, including a limit landing on a tuple end",
    () =>
      Effect.gen(function* () {
        const db = yield* listingsDb()
        const query = db.entities.Listings.byStore({ storeId: STORE }).within({ price: PRICE })
        const collected = listingIds(yield* query.collect())
        expect(collected).toEqual(expectedIds)

        // The first status's matches, exactly: its first page ends on the tuple's last row.
        const firstTuple = allListings.filter(
          (l) => inPrice(l) && l.status === LISTING_STATUSES[0],
        ).length
        for (const limit of [firstTuple, 7, 1]) {
          const pages = yield* fetchChain(query.limit(limit))
          expect(listingIds(pages.flatMap((page) => page.items)), `limit ${limit}`).toEqual(
            collected,
          )
          if (limit === firstTuple) {
            expect(pages[0]!.items.every((l) => l.status === LISTING_STATUSES[0])).toBe(true)
            expect(pages[0]!.items).toHaveLength(firstTuple)
          }
        }
        // Under a filter, requests are sized by `pageSize`, so the tuple read
        // ends without a LastEvaluatedKey: the cursor holds the pending probe.
        const filtered = query.filter({ storeId: STORE }).pageSize(500)
        const pages = yield* fetchChain(filtered.limit(firstTuple))
        expect(listingIds(pages.flatMap((page) => page.items))).toEqual(collected)
        expect(pages[0]!.items).toHaveLength(firstTuple)
        const cursor = Cursor.decode(pages[0]!.cursor!)!
        expect(cursor.s).toBe("skip-scan")
        expect(cursor.d).toBe(1)
        // …which is the resumed call's first request.
        const resumed = observed()
        yield* filtered
          .limit(firstTuple)
          .startFrom(pages[0]!.cursor!)
          .onRequest(resumed.observer)
          .fetch()
        expect(resumed.events[0]!.kind).toBe("probe")
        expect(resumed.events[1]!.kind).toBe("read")
      }).pipe(provideSkip),
  )

  it.effect("maxSkips fallback returns the same rows", () =>
    Effect.gen(function* () {
      const db = yield* listingsDb()
      for (const maxSkips of [0, 1, 2]) {
        const seen = observed()
        const query = db.entities.Listings.byStore({ storeId: STORE })
          .within({ price: PRICE }, { maxSkips })
          .onRequest(seen.observer)
        expect(listingIds(yield* query.collect()), `maxSkips ${maxSkips}`).toEqual(expectedIds)
        expect(seen.events.filter((event) => event.kind === "probe")).toHaveLength(maxSkips)
        const pages = yield* fetchChain(query.limit(9))
        expect(listingIds(pages.flatMap((page) => page.items))).toEqual(expectedIds)
      }
    }).pipe(provideSkip),
  )

  it.effect("reverse skip-scan", () =>
    Effect.gen(function* () {
      const db = yield* listingsDb()
      const query = db.entities.Listings.byStore({ storeId: STORE })
        .within({ price: PRICE })
        .reverse()
      const reversed = [...expectedIds].reverse()
      expect(listingIds(yield* query.collect())).toEqual(reversed)
      const pages = yield* fetchChain(query.limit(11))
      expect(listingIds(pages.flatMap((page) => page.items))).toEqual(reversed)
    }).pipe(provideSkip),
  )
})

// ---------------------------------------------------------------------------
// A ref-derived composite (design §11)
// ---------------------------------------------------------------------------

const refTableName = `skipscan-ref-conn-${Date.now()}`

class Part extends Schema.Class<Part>("Part")({
  partId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}

const LINE_STAGES = ["packed", "picked", "shipped"] as const

class OrderLine extends Schema.Class<OrderLine>("OrderLine")({
  lineId: Schema.String,
  orderId: Schema.String,
  stage: Schema.Literals(LINE_STAGES),
  part: Part.pipe(DynamoModel.ref),
}) {}

const Parts = Entity.make({
  model: Part,
  entityType: "Part",
  primaryKey: {
    pk: { field: "pk", composite: ["partId"] },
    sk: { field: "sk", composite: [] },
  },
})

/** Lines by order, then stage and part: `partId` comes from the `part` ref, stored as a map. */
const OrderLines = Entity.make({
  model: OrderLine,
  entityType: "OrderLine",
  primaryKey: {
    pk: { field: "pk", composite: ["lineId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byOrder: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["orderId"] },
      sk: { field: "gsi1sk", composite: ["stage", "partId"] },
    },
  },
  refs: { part: { entity: Parts } },
})

const RefTable = Table.make({ schema: AppSchema, entities: { OrderLines, Parts } })
const provideRef = Effect.provide(
  Layer.mergeAll(ClientLayer, RefTable.layer({ name: refTableName })),
)

const PART_IDS = Array.from({ length: 40 }, (_, n) => `part-${String(n).padStart(2, "0")}`)
const ORDER = "order-1"
/** Every stage holds a line for every part: 120 lines, in index order. */
const orderLines = LINE_STAGES.flatMap((stage) =>
  PART_IDS.map((partId) => ({ lineId: `${stage}-${partId}`, stage, partId })),
)

describeConnected("#171 a ref-derived composite bound — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: refTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(RefTable),
        })
        const db = yield* DynamoClient.make({
          entities: { OrderLines, Parts },
          tables: { RefTable },
        })
        yield* Effect.forEach(
          PART_IDS,
          (partId) => db.entities.Parts.put({ partId, name: `Part ${partId}` }).asEffect(),
          { concurrency: 8 },
        )
        yield* Effect.forEach(
          orderLines,
          (line) =>
            db.entities.OrderLines.put({
              lineId: line.lineId,
              orderId: ORDER,
              stage: line.stage,
              partId: line.partId,
            }).asEffect(),
          { concurrency: 8 },
        )
      }).pipe(provideRef),
    )
  }, 120_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: refTableName })
      }).pipe(
        provideRef,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 30_000)

  const lineIdsOf = (items: ReadonlyArray<OrderLine>) => items.map((line) => line.lineId)
  const wanted = (keep: (partId: string) => boolean) =>
    orderLines.filter((line) => keep(line.partId)).map((line) => line.lineId)

  it.effect("the filter plan and the maxSkips fallback check it from the stored ref", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { OrderLines, Parts }, tables: { RefTable } })
      // The item stores the ref, not `partId`.
      const client = yield* DynamoClient
      const stored = yield* client.scan({ TableName: refTableName, Limit: 200 })
      const line = stored.Items!.find((item) => item.__edd_e__?.S === "OrderLine")!
      expect(line.partId).toBeUndefined()
      expect(line.part?.M?.partId?.S).toBeDefined()

      const atLeast = wanted((partId) => partId >= "part-30")
      for (const maxSkips of [0, 1, 32]) {
        const seen = observed()
        const query = db.entities.OrderLines.byOrder({ orderId: ORDER })
          .within({ partId: { gte: "part-30" } }, { maxSkips })
          .onRequest(seen.observer)
        const explain = yield* query.explain()
        expect(explain.plan, `maxSkips ${maxSkips}`).toBe(maxSkips === 0 ? "filter" : "skip-scan")
        expect(lineIdsOf(yield* query.collect()), `maxSkips ${maxSkips}`).toEqual(atLeast)
        expect(
          seen.events.filter((event) => event.kind === "probe"),
          `maxSkips ${maxSkips}`,
        ).toHaveLength(maxSkips === 0 ? 0 : maxSkips === 1 ? 1 : LINE_STAGES.length + 1)
        expect(yield* query.count(), `maxSkips ${maxSkips}`).toBe(atLeast.length)
        const pages = yield* fetchChain(query.limit(7))
        expect(lineIdsOf(pages.flatMap((page) => page.items)), `maxSkips ${maxSkips}`).toEqual(
          atLeast,
        )
      }

      // A projection borrows the ref for the check and strips it; a path
      // inside the ref reads it whole (DynamoDB rejects overlapping paths).
      const filterPlan = () =>
        db.entities.OrderLines.byOrder({ orderId: ORDER }).within(
          { partId: { gte: "part-30" } },
          { maxSkips: 0 },
        )
      expect(yield* filterPlan().select(["lineId"]).collect()).toEqual(
        atLeast.map((lineId) => ({ lineId })),
      )
      const inside = yield* filterPlan()
        .select((t) => [t.lineId, t.part.name])
        .collect()
      expect(inside.map((item) => item.lineId)).toEqual(atLeast)
      expect(inside[0]!.part).toEqual({ partId: "part-30", name: "Part part-30" })

      // A strict bound on the last composite is exact on the key inside each
      // tuple; after a bounded composite, it is checked from the stored ref.
      const below = db.entities.OrderLines.byOrder({ orderId: ORDER }).within({
        partId: { lt: "part-05" },
      })
      expect((yield* below.explain()).rowChecks).toEqual([])
      expect(lineIdsOf(yield* below.collect())).toEqual(wanted((partId) => partId < "part-05"))
      const later = db.entities.OrderLines.byOrder({ orderId: ORDER }).within({
        stage: { gte: "p" },
        partId: { lt: "part-05" },
      })
      expect((yield* later.explain()).rowChecks).toEqual(["partId"])
      expect(lineIdsOf(yield* later.collect())).toEqual(wanted((partId) => partId < "part-05"))
    }).pipe(provideRef),
  )
})

// ---------------------------------------------------------------------------
// Z-order indexes (design §5, §8.5, §11)
// ---------------------------------------------------------------------------

const zTableName = `zorder-conn-${Date.now()}`
const provideZ = Effect.provide(
  Layer.mergeAll(ClientLayer, ZListings.MainTable.layer({ name: zTableName })),
)
const zListingsDb = () =>
  DynamoClient.make({
    entities: { Listings: ZListings.Listings },
    tables: { MainTable: ZListings.MainTable },
  })

/** 2,000 listings in one region, every field drawn at random. */
const NORTH = ZListings.randomZListings(2_026, 2_000)
/** A second region, gapped: prices in two narrow clusters, so the box's hull is mostly gap. */
const SOUTH = ZListings.randomZListings(1_717, 600, {
  prices: [
    ...Array.from({ length: 20 }, (_, i) => 200 + i),
    ...Array.from({ length: 20 }, (_, i) => 800 + i),
  ],
}).map((l) => ({ ...l, region: "south", listingId: `s-${l.listingId}` }))
/** The stored rows, composed by the entity's own puts (no DynamoDB involved). */
const Z_ROW_OF = (() => {
  const all = [...NORTH, ...SOUTH]
  const rows = ZListings.storedRows(all)
  return new Map(all.map((l, i) => [l.listingId, rows[i]!]))
})()

const zIds = (items: ReadonlyArray<{ readonly listingId: string }>) =>
  items.map((item) => item.listingId)

/**
 * `got` is exactly `want`, in `accessor`'s index order: sort key bytes
 * ascending (descending in reverse). Rows with the same sort key come back in
 * an order DynamoDB doesn't document, so only the keys' order is asserted.
 */
const expectIndexOrder = (
  accessor: ZListings.Accessor,
  got: ReadonlyArray<{ readonly listingId: string }>,
  want: ReadonlyArray<{ readonly listingId: string }>,
  reverse = false,
  label = "",
) => {
  expect([...zIds(got)].sort(), label).toEqual([...zIds(want)].sort())
  const sk = ZListings.INDEX[accessor].sk
  const keys = got.map((item) => Z_ROW_OF.get(item.listingId)![sk]!.B!)
  for (let i = 1; i < keys.length; i++) {
    const order = compareBytes(keys[i - 1]!, keys[i]!)
    expect(reverse ? order >= 0 : order <= 0, `${label} at ${i}`).toBe(true)
  }
}

const STRATEGIES = ["naive", "jump", "precise", "auto"] as const

describeConnected("#171 Z-order indexes — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: zTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(ZListings.MainTable),
        })
        yield* Batch.write([...NORTH, ...SOUTH].map((l) => ZListings.Listings.put(l)))
      }).pipe(provideZ),
    )
  }, 300_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: zTableName })
      }).pipe(
        provideZ,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 30_000)

  it.effect(
    "every strategy and auto equals a brute-force filtered scan, in index order, both ways",
    () =>
      Effect.gen(function* () {
        const db = yield* zListingsDb()
        const scanned = (yield* db.entities.Listings.scan().collect()).filter(
          (l) => l.region === ZListings.REGION,
        )
        expect(scanned.length).toBe(NORTH.length)
        const boxes = [
          [
            [100, 400],
            [2, 5],
          ],
          [
            [0, 1023],
            [9, 9],
          ],
          [
            [700, 760],
            [0, 15],
          ],
        ] as const
        for (const [prices, beds] of boxes) {
          const want = scanned.filter(
            (l) =>
              l.price >= prices[0] &&
              l.price <= prices[1] &&
              l.bedrooms >= beds[0] &&
              l.bedrooms <= beds[1],
          )
          expect(want.length).toBeGreaterThan(0)
          for (const strategy of STRATEGIES) {
            for (const reverse of [false, true]) {
              const base = db.entities.Listings.byFacets({ region: ZListings.REGION })
                .within({ price: { between: prices }, bedrooms: { between: beds } })
                .zorder({ strategy })
              const got = yield* (reverse ? base.reverse() : base).collect()
              expectIndexOrder("byFacets", got, want, reverse, `${strategy} ${reverse}`)
              expect(yield* base.count(), `${strategy} count`).toBe(want.length)
            }
          }
        }
      }).pipe(provideZ),
    60_000,
  )

  it.effect(
    "fetch chains equal one collect, with limits landing exactly on precise range ends",
    () =>
      Effect.gen(function* () {
        const db = yield* zListingsDb()
        for (const strategy of ["precise", "jump", "naive"] as const) {
          const query = db.entities.Listings.byFacets({ region: ZListings.REGION })
            .within({ price: { between: [300, 520] }, bedrooms: { gte: 6, lte: 12 } })
            .zorder({ strategy, maxRanges: 8 })
          const events: Array<Query.QueryRequestEvent> = []
          const all = zIds(
            yield* query.onRequest((event) => Effect.sync(() => void events.push(event))).collect(),
          )
          expect(all.length).toBeGreaterThan(10)
          // Each precise range is one natural page: its accepted rows end exactly at the range end.
          const rangeEnds = strategy === "precise" ? events.map((event) => event.accepted) : []
          const limits = new Set([1, 7, ...rangeEnds.filter((n) => n > 0)])
          for (const limit of limits) {
            const pages = yield* fetchChain(query.limit(limit))
            expect(zIds(pages.flatMap((page) => page.items)), `${strategy} ${limit}`).toEqual(all)
          }
          if (strategy === "precise") {
            const first = rangeEnds.find((n) => n > 0)!
            const page = yield* query.limit(first).fetch()
            expect(page.items.length).toBe(first)
            // Through the end of a range, not inside one.
            const cursor = Cursor.decode(page.cursor!)!
            expect(cursor.k).toBeUndefined()
          }
        }
      }).pipe(provideZ),
    60_000,
  )

  it.effect("a NumberFromString dimension returns the same set as a brute-force scan", () =>
    Effect.gen(function* () {
      const db = yield* zListingsDb()
      const scanned = (yield* db.entities.Listings.scan().collect()).filter(
        (l) => l.region === ZListings.REGION,
      )
      // Stored as S: "95" sorts after "610" as text, so only a per-row numeric check is exact.
      const want = scanned.filter((l) => l.priceText >= 95 && l.priceText < 610 && l.bedrooms <= 6)
      for (const strategy of STRATEGIES) {
        const got = yield* db.entities.Listings.byText({ region: ZListings.REGION })
          .within({ priceText: { gte: 95, lt: 610 }, bedrooms: { lte: 6 } })
          .zorder({ strategy })
          .collect()
        expectIndexOrder("byText", got, want, false, strategy)
      }
    }).pipe(provideZ),
  )

  it.effect("a binary prefix skip-scans each agency and office, and checks a hashed office", () =>
    Effect.gen(function* () {
      const db = yield* zListingsDb()
      const skipped = observed()
      const query = db.entities.Listings.byAgency({ region: ZListings.REGION })
        .within({ officeId: "o-2", price: { lte: 400 } })
        .onRequest(skipped.observer)
      const explain = yield* query.explain()
      expect(explain.plan).toBe("skip-scan")
      expect(explain.rowChecks).toEqual(["officeId"])
      const want = NORTH.filter((l) => l.officeId === "o-2" && l.price <= 400)
      const all = yield* query.collect()
      expectIndexOrder("byAgency", all, want)
      expect(skipped.scanned()).toBeLessThan(NORTH.length / 2)
      const pages = yield* fetchChain(query.limit(9))
      expect(zIds(pages.flatMap((page) => page.items))).toEqual(zIds(all))
    }).pipe(provideZ),
  )

  it.effect(
    "jump on gapped data: run sizing examines fewer rows than a page sized to the cap",
    () =>
      Effect.gen(function* () {
        const db = yield* zListingsDb()
        const box = { price: { between: [150, 900] }, bedrooms: { between: [3, 12] } } as const
        const want = SOUTH.filter(
          (l) => l.price >= 150 && l.price <= 900 && l.bedrooms >= 3 && l.bedrooms <= 12,
        )
        const query = db.entities.Listings.byFacets({ region: "south" })
          .within(box)
          .zorder({ strategy: "jump" })
        const run = observed()
        const capped = observed()
        const hull = observed()
        const sized = yield* query.limit(50).onRequest(run.observer).collect()
        // Where pass-rate sizing grows on a selective box: the 1,000-row cap.
        const fixed = yield* query
          .zorder({ pageSize: 1_000 })
          .limit(50)
          .onRequest(capped.observer)
          .collect()
        const naive = yield* query
          .zorder({ strategy: "naive" })
          .limit(50)
          .onRequest(hull.observer)
          .collect()
        const all = yield* query.collect()
        expectIndexOrder("byFacets", all, want)
        const first50 = zIds(all).slice(0, 50)
        expect(zIds(sized)).toEqual(first50)
        expect(zIds(fixed)).toEqual(first50)
        expect(zIds(naive)).toEqual(first50)
        // §8.5's worked case: a page sized to the cap reads deep into the gaps (564 rows here).
        expect(run.scanned() * 5).toBeLessThanOrEqual(capped.scanned())
        expect(run.scanned()).toBeLessThan(hull.scanned())
        // Estimator constants (Q5): jump requests start at 16 and never pass 1,000.
        expect(run.events[0]!.limit).toBe(16)
        expect(run.events.every((event) => event.limit! <= 1_000)).toBe(true)
        // count sizes its COUNT requests the same way.
        const counted = observed()
        expect(yield* query.onRequest(counted.observer).count()).toBe(want.length)
        expect(counted.events[0]!.limit).toBe(16)
        expect(counted.scanned()).toBeLessThan(capped.scanned() + want.length * 4)
      }).pipe(provideZ),
    60_000,
  )

  it.effect(
    "jump on a selective box: a small multiple of what it returns, against a pass-rate-sized filter",
    () =>
      Effect.gen(function* () {
        const db = yield* zListingsDb()
        // 8 of the 40 prices and 3 of the 16 bedroom counts: about 4% of the partition.
        const holds = (l: ZListings.ZListing) =>
          l.price >= 805 && l.price <= 812 && l.bedrooms >= 2 && l.bedrooms <= 4
        const want = SOUTH.filter(holds)
        expect(want.length / SOUTH.length).toBeLessThan(0.05)
        const jump = db.entities.Listings.byFacets({ region: "south" })
          .within({ price: { between: [805, 812] }, bedrooms: { between: [2, 4] } })
          .zorder({ strategy: "jump" })
        // The same rows without `.within()`: one range over the partition, the
        // bounds a filter, each request sized from the pass rate so far (§8).
        const filtered = db.entities.Listings.byFacets({ region: "south" }).filter(
          (t, { and, between }) => and(between(t.price, 805, 812), between(t.bedrooms, 2, 4)),
        )
        for (const limit of [10, want.length]) {
          const run = observed()
          const pass = observed()
          const got = yield* jump.limit(limit).onRequest(run.observer).collect()
          const baseline = yield* filtered.limit(limit).onRequest(pass.observer).collect()
          expect(got.length).toBe(limit)
          expect(zIds(got), `${limit}`).toEqual(zIds(baseline))
          // Jump examines the box's rows and at most a run into each gap: at
          // most 2 rows per row returned. The filter skips nothing: it reads
          // up to its last match, at least 10 times what jump read.
          expect(run.scanned(), `${limit}`).toBeLessThanOrEqual(2 * got.length)
          expect(pass.scanned(), `${limit}`).toBeGreaterThanOrEqual(10 * run.scanned())
          const runCount = observed()
          const passCount = observed()
          expect(yield* jump.limit(limit).onRequest(runCount.observer).count()).toBe(limit)
          expect(yield* filtered.limit(limit).onRequest(passCount.observer).count()).toBe(limit)
          expect(runCount.scanned()).toBeLessThanOrEqual(2 * limit)
          expect(passCount.scanned()).toBeGreaterThanOrEqual(10 * runCount.scanned())
        }
      }).pipe(provideZ),
    60_000,
  )

  it.effect("DateEpochSeconds: a window inside one second holds the listing stored at it", () =>
    Effect.gen(function* () {
      const db = yield* zListingsDb()
      // Its own partition: listings at whole seconds T - 1, T and T + 1.
      const T = ZListings.EPOCH_MS + 100_000 * 1000
      const listed = [-1, 0, 1].map((n) => ({
        ...NORTH[n + 1]!,
        region: "east",
        listingId: `e-${n + 1}`,
        listedAt: DateTime.makeUnsafe(T + n * 1000),
      }))
      for (const listing of listed) yield* db.entities.Listings.put(listing)
      const at = (plus: number) => DateTime.makeUnsafe(T + plus)
      const cases = [
        [{ gte: at(0), lt: at(500) }, ["e-1"]],
        [{ gt: at(-500), lte: at(0) }, ["e-1"]],
        [{ gt: at(-1_000), lt: at(1_000) }, ["e-1"]],
        [{ gt: at(0), lt: at(1_000) }, []],
        [{ gte: at(500), lte: at(900) }, []],
      ] as const
      for (const [bound, want] of cases) {
        const sent = observed()
        const got = yield* db.entities.Listings.byListed({ region: "east" })
          .within({ listedAt: bound })
          .onRequest(sent.observer)
          .collect()
        expect(zIds(got), JSON.stringify(bound)).toEqual(want)
        // No stored second in the window: nothing is sent.
        if (want.length === 0) expect(sent.events).toEqual([])
      }
    }).pipe(provideZ),
  )

  it.effect("an empty box sends nothing; a DateTimeZoned and a literals bound are exact", () =>
    Effect.gen(function* () {
      const db = yield* zListingsDb()
      const nothing = observed()
      expect(
        yield* db.entities.Listings.byFacets({ region: ZListings.REGION })
          .within({ price: { gte: 600, lte: 100 } })
          .onRequest(nothing.observer)
          .collect(),
      ).toEqual([])
      expect(nothing.events).toEqual([])

      const scanned = (yield* db.entities.Listings.scan().collect()).filter(
        (l) => l.region === ZListings.REGION,
      )
      const ms = (value: { readonly epochMilliseconds: number }) => value.epochMilliseconds
      const from = ZListings.EPOCH_MS + 200 * 3_600_000
      const to = ZListings.EPOCH_MS + 500 * 3_600_000
      const opened = yield* db.entities.Listings.byOpened({ region: ZListings.REGION })
        .within({
          openedAt: {
            gte: DateTime.makeZonedUnsafe(from, { timeZone: "Europe/London" }),
            lt: DateTime.makeZonedUnsafe(to, { timeZone: "Europe/London" }),
          },
        })
        .collect()
      expectIndexOrder(
        "byOpened",
        opened,
        scanned.filter((l) => ms(l.openedAt) >= from && ms(l.openedAt) < to),
      )
      const codes = yield* db.entities.Listings.byCode({ region: ZListings.REGION })
        .within({ code: { gte: "c010" }, bedrooms: { lte: 3 } })
        .collect()
      expectIndexOrder(
        "byCode",
        codes,
        scanned.filter((l) => ZListings.CODES.indexOf(l.code) >= 10 && l.bedrooms <= 3),
      )
    }).pipe(provideZ),
  )
})
