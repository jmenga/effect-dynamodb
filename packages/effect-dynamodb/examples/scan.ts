/**
 * Scan example — effect-dynamodb v2
 *
 * Demonstrates:
 *   - Entity.scan(): returns a Query<Entity.Record> that uses DynamoDB Scan
 *   - Scan shares all Query combinators: filter, limit, consistentRead
 *   - Scan shares all terminals: execute, paginate
 *   - Entity type filtering: scan only returns items matching the entity type
 *   - Scan vs Query: scan reads entire table, query targets a specific partition
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/scan.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  name: Schema.NonEmptyString,
  category: Schema.String,
  price: Schema.Number,
  inStock: Schema.Boolean,
}) {}

class Review extends Schema.Class<Review>("Review")({
  reviewId: Schema.String,
  productId: Schema.String,
  rating: Schema.Number,
  comment: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// 2. Schema + Table + Entities
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "scan-demo", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

const Products = Entity.make({
  model: Product,
  table: MainTable,
  entityType: "Product",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["productId"] },
      sk: { field: "sk", composite: [] },
    },
    byCategory: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["category"] },
      sk: { field: "gsi1sk", composite: ["productId"] },
    },
  },
  timestamps: true,
})

const Reviews = Entity.make({
  model: Review,
  table: MainTable,
  entityType: "Review",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["reviewId"] },
      sk: { field: "sk", composite: [] },
    },
    byProduct: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["productId"] },
      sk: { field: "gsi1sk", composite: ["reviewId"] },
    },
  },
  timestamps: true,
})

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const client = yield* DynamoClient

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")

  yield* client.createTable({
    TableName: "scan-demo-table",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(MainTable, [Products, Reviews]),
  })
  yield* Console.log("Table created\n")

  // Seed data
  yield* Products.put({
    productId: "p-1",
    name: "Wireless Mouse",
    category: "electronics",
    price: 29.99,
    inStock: true,
  })
  yield* Products.put({
    productId: "p-2",
    name: "Mechanical Keyboard",
    category: "electronics",
    price: 89.99,
    inStock: true,
  })
  yield* Products.put({
    productId: "p-3",
    name: "USB-C Cable",
    category: "accessories",
    price: 9.99,
    inStock: false,
  })
  yield* Products.put({
    productId: "p-4",
    name: "Monitor Stand",
    category: "accessories",
    price: 49.99,
    inStock: true,
  })
  yield* Reviews.put({ reviewId: "r-1", productId: "p-1", rating: 5, comment: "Great mouse!" })
  yield* Reviews.put({ reviewId: "r-2", productId: "p-2", rating: 4, comment: "Good keyboard" })
  yield* Console.log("Seeded 4 products + 2 reviews\n")

  // --- Basic scan ---
  yield* Console.log("=== Entity.scan() — All Products ===\n")

  // scan() returns a Query<Entity.Record> just like query accessors.
  // It reads the entire table but filters by __edd_e__ to return only
  // items matching this entity type.
  const allProducts = yield* Products.scan().pipe(Query.collect)
  yield* Console.log(`Found ${allProducts.length} products:`)
  for (const p of allProducts) {
    yield* Console.log(`  ${p.productId}: ${p.name} — $${p.price} (in stock: ${p.inStock})`)
  }
  yield* Console.log("")

  // --- Scan with filter ---
  yield* Console.log("=== Scan with Filter — In-Stock Products ===\n")

  // Scan supports all Query combinators including filter.
  // FilterExpression is applied server-side to reduce network transfer.
  // Note: filters don't reduce read capacity (DynamoDB still reads every item).
  const inStockProducts = yield* Products.scan().pipe(
    Query.filter({ inStock: true }),
    Query.collect,
  )
  yield* Console.log(`In-stock products: ${inStockProducts.length}`)
  for (const p of inStockProducts) {
    yield* Console.log(`  ${p.productId}: ${p.name}`)
  }
  yield* Console.log("")

  // --- Scan with limit ---
  yield* Console.log("=== Scan with Limit ===\n")

  // Limit controls the page size (how many items DynamoDB evaluates per request).
  const firstTwo = yield* Products.scan().pipe(Query.limit(2), Query.collect)
  yield* Console.log(`First 2 products (limit=2): ${firstTwo.length}`)
  for (const p of firstTwo) {
    yield* Console.log(`  ${p.productId}: ${p.name}`)
  }
  yield* Console.log("")

  // --- Scan with consistent read ---
  yield* Console.log("=== Scan with Consistent Read ===\n")

  // ConsistentRead on scan ensures you read the most recent data.
  // Costs 2x the read capacity of eventually-consistent reads.
  const consistent = yield* Products.scan().pipe(Query.consistentRead, Query.collect)
  yield* Console.log(`Consistent scan: ${consistent.length} products\n`)

  // --- Scan only returns matching entity type ---
  yield* Console.log("=== Entity-Type Isolation ===\n")

  // Even though Products and Reviews share the same table,
  // Products.scan() only returns Product items (filtered by __edd_e__).
  const productScan = yield* Products.scan().pipe(Query.collect)
  const reviewScan = yield* Reviews.scan().pipe(Query.collect)
  yield* Console.log(`Products.scan(): ${productScan.length} items`)
  yield* Console.log(`Reviews.scan():  ${reviewScan.length} items`)
  yield* Console.log("Each scan only returns its own entity type\n")

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* client.deleteTable({ TableName: "scan-demo-table" })
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 4. Provide dependencies and run
// ---------------------------------------------------------------------------

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "scan-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer), Effect.scoped)

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
