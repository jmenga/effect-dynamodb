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
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
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
