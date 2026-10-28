/**
 * #171: adaptive request sizing, skip-scan and Z-order indexes — connected
 * tests against DynamoDB Local.
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
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Cursor from "../src/internal/Cursor.js"
import type * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

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

      // A strict bound on the last composite is checked per row inside each tuple.
      const below = db.entities.OrderLines.byOrder({ orderId: ORDER }).within({
        partId: { lt: "part-05" },
      })
      expect((yield* below.explain()).rowChecks).toEqual(["partId"])
      expect(lineIdsOf(yield* below.collect())).toEqual(wanted((partId) => partId < "part-05"))
    }).pipe(provideRef),
  )
})
