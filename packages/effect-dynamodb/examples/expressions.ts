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
 *   - Filter expressions: Products.filter() on queries and scans
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
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  name: Schema.NonEmptyString,
  category: Schema.String,
  price: Schema.Number,
  stock: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// 2. Schema + Table + Entity
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "expr-demo", version: 1 })

const Products = Entity.make({
  model: Product,
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
  versioned: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Products } })

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // Typed execution gateway
  const db = yield* DynamoClient.make(MainTable)

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")

  yield* db.createTable()
  yield* Console.log("Table created\n")

  // --- Entity.create — put with duplicate detection ---
  yield* Console.log("=== Entity.create() — Insert-Only ===\n")

  // create() is put() + automatic attribute_not_exists on primary key.
  // It fails with ConditionalCheckFailed if an item already exists.
  const widget = yield* db.Products.create({
    productId: "p-1",
    name: "Widget",
    category: "electronics",
    price: 29.99,
    stock: 100,
  })
  yield* Console.log(`Created: ${widget.name} ($${widget.price})`)

  // Try to create the same item again — should fail
  const duplicateResult = yield* db.Products.create({
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
  yield* Console.log(`Duplicate create: ${duplicateResult}\n`)

  // Seed more products
  yield* db.Products.create({
    productId: "p-2",
    name: "Gadget",
    category: "electronics",
    price: 89.99,
    stock: 25,
  })
  yield* db.Products.create({
    productId: "p-3",
    name: "USB Cable",
    category: "accessories",
    price: 9.99,
    stock: 500,
  })
  yield* db.Products.create({
    productId: "p-4",
    name: "Phone Case",
    category: "accessories",
    price: 14.99,
    stock: 0,
  })
  yield* Console.log("Seeded additional products\n")

  // --- Conditional put ---
  yield* Console.log("=== Conditional Put ===\n")

  // Products.condition() adds a ConditionExpression to a put operation.
  // The condition is evaluated server-side. If it fails, the put is rejected.
  const condPutResult = yield* db.Products.put(
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
  yield* Console.log(`Conditional put succeeded: ${condPutResult.name}\n`)

  // --- Conditional delete ---
  yield* Console.log("=== Conditional Delete ===\n")

  // Delete only if the item's stock is 0 (don't delete items with stock).
  // Products.condition() maps ConditionalCheckFailedException at runtime.
  // Use Effect.match to handle both success and failure paths.
  const condDeleteResult = yield* db.Products.delete(
    { productId: "p-4" },
    Products.condition((t, { eq }) => eq(t.stock, 0)),
  ).pipe(
    Effect.match({
      onFailure: (e) => `Failed: ${e._tag}`,
      onSuccess: () => "deleted (stock was 0)",
    }),
  )
  yield* Console.log(`Conditional delete (p-4 stock=0): ${condDeleteResult}`)

  // Try to conditionally delete an item with stock > 0
  const condDeleteFail = yield* db.Products.delete(
    { productId: "p-1" },
    Products.condition((t, { eq }) => eq(t.stock, 0)),
  ).pipe(
    Effect.match({
      onFailure: (e) => `${e._tag} — item has stock (correct!)`,
      onSuccess: () => "deleted",
    }),
  )
  yield* Console.log(`Conditional delete (p-1 stock=100): ${condDeleteFail}\n`)

  // --- Conditional update with optimistic locking ---
  yield* Console.log("=== Conditional Update + Optimistic Locking ===\n")

  // Combine condition() with expectedVersion() and set().
  // The user condition is ANDed with the optimistic lock condition.
  const updated = yield* db.Products.update(
    { productId: "p-1" },
    Products.set({ price: 24.99 }),
    Products.expectedVersion(1),
    Products.condition((t, { gt }) => gt(t.stock, 0)),
  )
  yield* Console.log(
    `Updated p-1: price=$${updated.price} (condition: stock > 0, expectedVersion: 1)`,
  )

  // Condition fails: update only if stock > 1000 (it's 100)
  const condUpdateFail = yield* db.Products.update(
    { productId: "p-1" },
    Products.set({ price: 19.99 }),
    Products.condition((t, { gt }) => gt(t.stock, 1000)),
  ).pipe(
    Effect.match({
      onFailure: (e) => `${e._tag} — stock not > 1000`,
      onSuccess: () => "updated",
    }),
  )
  yield* Console.log(`Conditional update (stock > 1000): ${condUpdateFail}\n`)

  // --- Filter expressions ---
  yield* Console.log("=== Filter Expressions ===\n")

  // Products.filter() adds FilterExpression to narrow query/scan results.
  // Uses the same callback + shorthand API as Products.condition().

  // Equality filter
  const electronics = yield* db.Products.collect(
    Products.query.byCategory({ category: "electronics" }),
  )
  yield* Console.log(`Electronics: ${electronics.length} products`)

  // Greater-than filter
  const expensive = yield* db.Products.collect(
    Products.query.byCategory({ category: "electronics" }),
    Products.filter((t, { gt }) => gt(t.price, 30)),
  )
  yield* Console.log(`Electronics > $30: ${expensive.length} products`)
  for (const p of expensive) {
    yield* Console.log(`  ${p.name}: $${p.price}`)
  }

  // Between filter
  const midRange = yield* db.Products.collect(
    Products.query.byCategory({ category: "electronics" }),
    Products.filter((t, { between }) => between(t.price, 20, 50)),
  )
  yield* Console.log(`Electronics $20-$50: ${midRange.length} products`)

  // Contains filter (string substring match)
  const withWidget = yield* db.Products.collect(
    Products.scan(),
    Products.filter((t, { contains }) => contains(t.name, "Widget")),
  )
  yield* Console.log(`Products containing "Widget": ${withWidget.length}`)

  // Attribute exists/not exists
  const allWithStock = yield* db.Products.collect(
    Products.scan(),
    Products.filter((t, { exists }) => exists(t.stock)),
  )
  yield* Console.log(`Products with stock attribute: ${allWithStock.length}`)
  yield* Console.log("")

  // --- Condition expressions ---
  yield* Console.log("=== Callback API: Products.condition() ===\n")

  // The callback API provides type-safe conditions using PathBuilder.
  // First argument `t` is a path proxy, second `ops` has comparison functions.
  const conditionUpdated = yield* db.Products.update(
    { productId: "p-2" },
    Products.set({ price: 79.99 }),
    // Type-safe: t.stock is typed as number, "active" would be a type error
    Products.condition((t, { gt }) => gt(t.stock, 0)),
  )
  yield* Console.log(
    `Callback condition update: ${conditionUpdated.name} price=$${conditionUpdated.price}`,
  )

  // Shorthand condition — plain object for simple equality
  const shorthandResult = yield* db.Products.update(
    { productId: "p-2" },
    Products.set({ price: 84.99 }),
    Products.condition({ category: "electronics" }),
  ).pipe(
    Effect.match({
      onFailure: (e) => `Failed: ${e._tag}`,
      onSuccess: (p) => `Shorthand condition: ${p.name} price=$${p.price}`,
    }),
  )
  yield* Console.log(shorthandResult)
  yield* Console.log("")

  // --- Callback API: Entity.filter() ---
  yield* Console.log("=== Callback API: Products.filter() ===\n")

  // Filter with callback — supports nested paths, OR, and all DynamoDB operators
  const expensiveProducts = yield* db.Products.collect(
    Products.query.byCategory({ category: "electronics" }),
    Products.filter((t, { gt }) => gt(t.price, 30)),
  )
  yield* Console.log(`Electronics > $30 (callback): ${expensiveProducts.length} products`)
  for (const p of expensiveProducts) {
    yield* Console.log(`  ${p.name}: $${p.price}`)
  }

  // OR composition in filter
  const multiCategory = yield* db.Products.collect(
    Products.scan(),
    Products.filter((t, { or, eq }) =>
      or(eq(t.category, "electronics"), eq(t.category, "accessories")),
    ),
  )
  yield* Console.log(`Electronics OR accessories (callback): ${multiCategory.length} products`)
  yield* Console.log("")

  // --- Callback API: Entity.select() ---
  yield* Console.log("=== Callback API: Products.select() ===\n")

  // Path-based projection — type-safe attribute selection
  const namesAndPrices = yield* db.Products.collect(
    Products.scan(),
    Products.select((t) => [t.name, t.price]),
  )
  yield* Console.log("Projected (name, price):")
  for (const item of namesAndPrices) {
    yield* Console.log(`  ${(item as any).name}: $${(item as any).price}`)
  }

  // String array shorthand
  const nameOnly = yield* db.Products.collect(
    Products.scan(),
    Products.select(["name", "category"]),
  )
  yield* Console.log(`\nProjected (string shorthand): ${nameOnly.length} items`)
  yield* Console.log("")

  // --- Low-level Expression builders ---
  yield* Console.log("=== Expression.condition() — Low-Level Builder ===\n")

  // Expression.condition() builds raw ConditionExpression strings.
  // These are what Products.condition() uses under the hood.

  const cond1 = Expression.condition({
    eq: { status: "active" },
    gt: { stock: 0 },
  })
  yield* Console.log(`Condition: ${cond1.expression}`)
  yield* Console.log(`Names: ${JSON.stringify(cond1.names)}`)
  yield* Console.log(`Values: ${JSON.stringify(cond1.values)}\n`)

  const cond2 = Expression.condition({
    between: { price: [10, 50] },
    attributeExists: "category",
  })
  yield* Console.log(`Between + exists: ${cond2.expression}\n`)

  // --- Expression.update() ---
  yield* Console.log("=== Expression.update() — Low-Level Builder ===\n")

  const upd = Expression.update({
    set: { name: "New Name", price: 39.99 },
    remove: ["description"],
    add: { viewCount: 1 },
  })
  yield* Console.log(`Update: ${upd.expression}`)
  yield* Console.log(`Names: ${JSON.stringify(upd.names)}`)
  yield* Console.log(`Values: ${JSON.stringify(upd.values)}\n`)

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* db.deleteTable
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
  MainTable.layer({ name: "expr-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
