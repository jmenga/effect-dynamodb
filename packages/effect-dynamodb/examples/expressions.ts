/**
 * Expressions example — effect-dynamodb v4
 *
 * Demonstrates:
 *   - Callback API: Products.condition((t, { eq }) => eq(t.status, "active"))
 *   - Callback API: Products.filter((t, { gt }) => gt(t.price, 30))
 *   - Callback API: Products.select((t) => [t.name, t.price])
 *   - Shorthand syntax: Products.condition({ field: value })
 *   - Conditional writes: Products.condition() on put, update, and delete
 *   - Entity.create(): put with automatic attribute_not_exists condition
 *   - Filter expressions: .filter() on BoundQuery chains
 *   - Expression.condition(): low-level condition expression builder
 *   - Expression.update(): low-level update expression builder
 *   - Error handling: catching ConditionalCheckFailed
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/expressions.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as Collections from "../src/Collections.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

// #region model
class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  name: Schema.NonEmptyString,
  category: Schema.String,
  price: Schema.Number,
  stock: Schema.Number,
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Schema + Table + Entity + Collections
// ---------------------------------------------------------------------------

// #region entities
const AppSchema = DynamoSchema.make({ name: "expr-demo", version: 1 })

const Products = Entity.make({
  model: Product,
  entityType: "Product",
  primaryKey: {
    pk: { field: "pk", composite: ["productId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  versioned: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Products } })

const ProductsByCategory = Collections.make("productsByCategory", {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["category"] },
  sk: { field: "gsi1sk" },
  members: {
    Products: Collections.member(Products, { sk: { composite: ["productId"] } }),
  },
})
// #endregion

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // Typed execution gateway
  const db = yield* DynamoClient.make({
    entities: { Products },
    collections: { ProductsByCategory },
  })

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")

  yield* db.tables["expr-demo-table"]!.create()
  yield* Console.log("Table created\n")

  // --- Entity.create — put with duplicate detection ---
  yield* Console.log("=== Entity.create() — Insert-Only ===\n")

  // #region create
  // create() is put() + automatic attribute_not_exists on primary key.
  // It fails with ConditionalCheckFailed if an item already exists.
  const widget = yield* db.entities.Products.create({
    productId: "p-1",
    name: "Widget",
    category: "electronics",
    price: 29.99,
    stock: 100,
  })

  // Try to create the same item again — should fail
  const duplicateResult = yield* db.entities.Products.create({
    productId: "p-1",
    name: "Widget Duplicate",
    category: "electronics",
    price: 19.99,
    stock: 50,
  }).pipe(
    Effect.map(() => "unexpected success"),
    Effect.catchTag("ConditionalCheckFailed", () =>
      Effect.succeed("ConditionalCheckFailed — duplicate prevented!"),
    ),
  )
  // #endregion

  // Seed more products
  yield* db.entities.Products.create({
    productId: "p-2",
    name: "Gadget",
    category: "electronics",
    price: 89.99,
    stock: 25,
  })
  yield* db.entities.Products.create({
    productId: "p-3",
    name: "USB Cable",
    category: "accessories",
    price: 9.99,
    stock: 500,
  })
  yield* db.entities.Products.create({
    productId: "p-4",
    name: "Phone Case",
    category: "accessories",
    price: 14.99,
    stock: 0,
  })
  yield* Console.log("Seeded additional products\n")

  // --- Conditional put ---
  yield* Console.log("=== Conditional Put ===\n")

  // #region conditional-put
  // Products.condition() adds a ConditionExpression to a put operation.
  // The condition is evaluated server-side. If it fails, the put is rejected.
  const condPutResult = yield* db.entities.Products.put(
    {
      productId: "p-5",
      name: "New Product",
      category: "electronics",
      price: 49.99,
      stock: 10,
    },
    // Only put if item doesn't already exist (same as create, but explicit)
    Products.condition((t, { notExists }) => notExists(t.productId)),
  )
  // #endregion

  // --- Conditional delete ---
  yield* Console.log("=== Conditional Delete ===\n")

  // #region conditional-delete
  // Delete only if the item's stock is 0 (don't delete items with stock).
  // Products.condition() maps ConditionalCheckFailedException at runtime.
  // Use Effect.match to handle both success and failure paths.
  const condDeleteResult = yield* db.entities.Products.delete(
    { productId: "p-4" },
    Products.condition((t, { eq }) => eq(t.stock, 0)),
  ).pipe(
    Effect.match({
      onFailure: (e) => `Failed: ${e._tag}`,
      onSuccess: () => "deleted (stock was 0)",
    }),
  )

  // Try to conditionally delete an item with stock > 0
  const condDeleteFail = yield* db.entities.Products.delete(
    { productId: "p-1" },
    Products.condition((t, { eq }) => eq(t.stock, 0)),
  ).pipe(
    Effect.match({
      onFailure: (e) => `${e._tag} — item has stock (correct!)`,
      onSuccess: () => "deleted",
    }),
  )
  // #endregion

  // --- Conditional update with optimistic locking ---
  yield* Console.log("=== Conditional Update + Optimistic Locking ===\n")

  // #region conditional-update
  // Combine condition() with expectedVersion() and set().
  // The user condition is ANDed with the optimistic lock condition.
  const updated = yield* db.entities.Products.update(
    { productId: "p-1" },
    Products.set({ price: 24.99 }),
    Products.expectedVersion(1),
    Products.condition((t, { gt }) => gt(t.stock, 0)),
  )
  // #endregion

  yield* Console.log(
    `Updated p-1: price=$${updated.price} (condition: stock > 0, expectedVersion: 1)`,
  )

  // #region conditional-update-fail
  // Condition fails: update only if stock > 1000 (it's 100)
  const condUpdateFail = yield* db.entities.Products.update(
    { productId: "p-1" },
    Products.set({ price: 19.99 }),
    Products.condition((t, { gt }) => gt(t.stock, 1000)),
  ).pipe(
    Effect.match({
      onFailure: (e) => `${e._tag} — stock not > 1000`,
      onSuccess: () => "updated",
    }),
  )
  // #endregion

  // --- Filter expressions ---
  yield* Console.log("=== Filter Expressions ===\n")

  // .filter() adds FilterExpression to narrow query/scan results.
  // Uses the same callback + shorthand API as Products.condition().

  // #region filters
  // All electronics via collection query
  const { Products: electronics } = yield* db.collections
    .ProductsByCategory({ category: "electronics" })
    .collect()

  // Greater-than filter on scan
  const expensive = yield* db.entities.Products.scan()
    .filter((t, { gt }) => gt(t.price, 30))
    .collect()

  // Between filter on scan
  const midRange = yield* db.entities.Products.scan()
    .filter((t, { between }) => between(t.price, 20, 50))
    .collect()

  // Contains filter (string substring match) on scan
  const withWidget = yield* db.entities.Products.scan()
    .filter((t, { contains }) => contains(t.name, "Widget"))
    .collect()

  // Attribute exists/not exists
  const allWithStock = yield* db.entities.Products.scan()
    .filter((t, { exists }) => exists(t.stock))
    .collect()
  // #endregion
  yield* Console.log(`Electronics: ${electronics.length} products`)
  yield* Console.log(`Electronics > $30: ${expensive.length} products`)
  for (const p of expensive) {
    yield* Console.log(`  ${p.name}: $${p.price}`)
  }
  yield* Console.log(`Electronics $20-$50: ${midRange.length} products`)
  yield* Console.log(`Products containing "Widget": ${withWidget.length}`)
  yield* Console.log(`Products with stock attribute: ${allWithStock.length}`)
  yield* Console.log("")

  // --- Condition expressions ---
  yield* Console.log("=== Callback API: Products.condition() ===\n")

  // #region condition-callback
  // The callback API provides type-safe conditions using PathBuilder.
  // First argument `t` is a path proxy, second `ops` has comparison functions.
  const conditionUpdated = yield* db.entities.Products.update(
    { productId: "p-2" },
    Products.set({ price: 79.99 }),
    // Type-safe: t.stock is typed as number, "active" would be a type error
    Products.condition((t, { gt }) => gt(t.stock, 0)),
  )

  // Shorthand condition — plain object for simple equality
  const shorthandResult = yield* db.entities.Products.update(
    { productId: "p-2" },
    Products.set({ price: 84.99 }),
    Products.condition({ category: "electronics" }),
  ).pipe(
    Effect.match({
      onFailure: (e) => `Failed: ${e._tag}`,
      onSuccess: (p) => `Shorthand condition: ${p.name} price=$${p.price}`,
    }),
  )
  // #endregion
  yield* Console.log(
    `Callback condition update: ${conditionUpdated.name} price=$${conditionUpdated.price}`,
  )
  yield* Console.log(shorthandResult)
  yield* Console.log("")

  // --- Callback API: Entity.filter() ---
  yield* Console.log("=== Callback API: Products.filter() ===\n")

  // #region filter-callback
  // Filter with callback on scan — supports nested paths, OR, and all DynamoDB operators
  const expensiveProducts = yield* db.entities.Products.scan()
    .filter((t, { gt }) => gt(t.price, 30))
    .collect()

  // OR composition in filter — scan with filter
  const multiCategory = yield* db.entities.Products.scan()
    .filter((t, { or, eq }) => or(eq(t.category, "electronics"), eq(t.category, "accessories")))
    .collect()
  // #endregion
  yield* Console.log(`Electronics > $30 (callback): ${expensiveProducts.length} products`)
  for (const p of expensiveProducts) {
    yield* Console.log(`  ${p.name}: $${p.price}`)
  }
  yield* Console.log(`Electronics OR accessories (callback): ${multiCategory.length} products`)
  yield* Console.log("")

  // --- Callback API: Entity.select() ---
  yield* Console.log("=== Callback API: Products.select() ===\n")

  // #region select
  // Path-based projection — type-safe attribute selection on scan
  const namesAndPrices = yield* db.entities.Products.scan()
    .select((t) => [t.name, t.price])
    .collect()

  // String array shorthand on scan
  const nameOnly = yield* db.entities.Products.scan().select(["name", "category"]).collect()
  // #endregion
  yield* Console.log("Projected (name, price):")
  for (const item of namesAndPrices) {
    yield* Console.log(`  ${(item as any).name}: $${(item as any).price}`)
  }
  yield* Console.log(`\nProjected (string shorthand): ${nameOnly.length} items`)
  yield* Console.log("")

  // --- Low-level Expression builders ---
  yield* Console.log("=== Expression.condition() — Low-Level Builder ===\n")

  // #region expression-builders
  // Expression.condition() builds raw ConditionExpression strings.
  // These are what Products.condition() uses under the hood.

  const cond1 = Expression.condition({
    eq: { status: "active" },
    gt: { stock: 0 },
  })
  // cond1.expression → "#status = :status AND #stock > :stock"
  // cond1.names      → { "#status": "status", "#stock": "stock" }
  // cond1.values     → { ":status": { S: "active" }, ":stock": { N: "0" } }

  const cond2 = Expression.condition({
    between: { price: [10, 50] },
    attributeExists: "category",
  })

  // Update expression with SET, REMOVE, and ADD clauses
  const upd = Expression.update({
    set: { name: "New Name", price: 39.99 },
    remove: ["description"],
    add: { viewCount: 1 },
  })
  // upd.expression → "SET #name = :name, #price = :price REMOVE #description ADD #viewCount :viewCount"
  // #endregion
  yield* Console.log(`Condition: ${cond1.expression}`)
  yield* Console.log(`Names: ${JSON.stringify(cond1.names)}`)
  yield* Console.log(`Values: ${JSON.stringify(cond1.values)}\n`)
  yield* Console.log(`Between + exists: ${cond2.expression}\n`)
  yield* Console.log("=== Expression.update() — Low-Level Builder ===\n")
  yield* Console.log(`Update: ${upd.expression}`)
  yield* Console.log(`Names: ${JSON.stringify(upd.names)}`)
  yield* Console.log(`Values: ${JSON.stringify(upd.values)}\n`)

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* db.tables["expr-demo-table"]!.delete()
  yield* Console.log("Table deleted.")
})

// ---------------------------------------------------------------------------
// 4. Provide dependencies and run
// ---------------------------------------------------------------------------

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: "expr-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
