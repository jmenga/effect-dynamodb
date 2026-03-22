/**
 * Rich updates example — effect-dynamodb v2
 *
 * Demonstrates all update operations beyond simple SET:
 *   - Entity.remove(fields): REMOVE attributes from an item
 *   - Entity.add(values): ADD to numeric attributes (atomic increment)
 *   - Entity.subtract(values): subtract from numeric attributes (SET #f = #f - :v)
 *   - Entity.append(values): append to list attributes (SET #f = list_append(#f, :v))
 *   - Entity.deleteFromSet(values): DELETE from set attributes (SS/NS)
 *   - Composing multiple update types in a single operation
 *   - Combining rich updates with set(), expectedVersion(), and condition()
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/updates.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

// #region models
class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  name: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  price: Schema.Number,
  stock: Schema.Number,
  viewCount: Schema.Number,
  tags: Schema.Array(Schema.String),
  category: Schema.String,
}) {}

const ProductModel = DynamoModel.configure(Product, {
  category: { immutable: true },
})
// #endregion

// ---------------------------------------------------------------------------
// 2. Schema + Table + Entity
// ---------------------------------------------------------------------------

// #region entities
const AppSchema = DynamoSchema.make({ name: "updates-demo", version: 1 })

const Products = Entity.make({
  model: ProductModel,
  entityType: "Product",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["productId"] },
      sk: { field: "sk", composite: [] },
    },
  },
  timestamps: true,
  versioned: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Products } })
// #endregion

// ---------------------------------------------------------------------------
// 3. Main program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make(MainTable)

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")

  yield* db.createTable()
  yield* Console.log("Table created\n")

  // Create initial product
  // #region setup
  const product = yield* db.Products.put({
    productId: "p-1",
    name: "Wireless Mouse",
    description: "Ergonomic wireless mouse",
    price: 29.99,
    stock: 100,
    viewCount: 0,
    tags: ["electronics", "accessories"],
    category: "peripherals",
  })
  // #endregion
  yield* Console.log(`Created: ${product.name} — $${product.price}, stock: ${product.stock}`)
  yield* Console.log(`  tags: ${JSON.stringify(product.tags)}`)
  yield* Console.log(`  viewCount: ${product.viewCount}\n`)

  // --- Entity.add — atomic increment ---
  yield* Console.log("=== Entity.add() — Atomic Increment ===\n")

  // ADD atomically increments a number. If the attribute doesn't exist,
  // it's initialized to the provided value. Thread-safe — no read-modify-write.
  // #region add
  const afterAdd = yield* db.Products.update({ productId: "p-1" }, Entity.add({ viewCount: 1 }))

  // Multiple adds compose
  const afterMultiAdd = yield* db.Products.update(
    { productId: "p-1" },
    Entity.add({ viewCount: 5, stock: 50 }),
  )
  // #endregion
  yield* Console.log(`After add(viewCount: 1): viewCount = ${afterAdd.viewCount}`)
  yield* Console.log(
    `After add(viewCount: 5, stock: 50): viewCount = ${afterMultiAdd.viewCount}, stock = ${afterMultiAdd.stock}\n`,
  )

  // --- Entity.subtract — atomic decrement ---
  yield* Console.log("=== Entity.subtract() — Atomic Decrement ===\n")

  // Subtract synthesizes SET #field = #field - :val
  // (DynamoDB has no native SUBTRACT — this is a convenience wrapper)
  // #region subtract
  const afterSub = yield* db.Products.update({ productId: "p-1" }, Entity.subtract({ stock: 3 }))
  // #endregion
  yield* Console.log(
    `After subtract(stock: 3): stock = ${afterSub.stock} (was ${afterMultiAdd.stock})\n`,
  )

  // --- Entity.append — list append ---
  yield* Console.log("=== Entity.append() — List Append ===\n")

  // Append uses list_append to add elements to the end of a list.
  // The value must be an array.
  // #region append
  const afterAppend = yield* db.Products.update(
    { productId: "p-1" },
    Entity.append({ tags: ["on-sale", "featured"] }),
  )
  // #endregion
  yield* Console.log(`After append(tags: ["on-sale", "featured"]):`)
  yield* Console.log(`  tags = ${JSON.stringify(afterAppend.tags)}\n`)

  // --- Entity.remove — remove attributes ---
  yield* Console.log("=== Entity.remove() — Remove Attributes ===\n")

  // REMOVE deletes attributes entirely from the item.
  // The attribute no longer exists after removal (undefined, not null).
  // #region remove
  const afterRemove = yield* db.Products.update(
    { productId: "p-1" },
    Entity.remove(["description"]),
  )
  // #endregion
  yield* Console.log(`After remove(["description"]):`)
  yield* Console.log(
    `  description = ${(afterRemove as any).description ?? "undefined (removed)"}\n`,
  )

  // --- Entity.deleteFromSet — remove elements from a set ---
  yield* Console.log("=== Entity.deleteFromSet() — Set Element Removal ===\n")

  // DELETE removes specific elements from a DynamoDB set attribute (SS, NS, BS).
  // This operates at the DynamoDB level — the value should be a Set.
  // Note: deleteFromSet works on DynamoDB Set types, not Schema arrays.
  // Here we show the API; in practice, use it with models that have Set-type fields.
  yield* Console.log("Entity.deleteFromSet({ fieldName: new Set([...]) })")
  yield* Console.log("  → Produces DynamoDB DELETE clause for Set-type attributes\n")

  // --- Composing multiple update types ---
  yield* Console.log("=== Composed Updates — Multiple Types ===\n")

  // All update combinators compose in a single pipe.
  // They are merged into one UpdateItem call to DynamoDB.
  // #region composed
  const composed = yield* db.Products.update(
    { productId: "p-1" },
    Products.set({ name: "Premium Wireless Mouse", price: 39.99 }),
    Entity.add({ viewCount: 10 }),
    Entity.subtract({ stock: 5 }),
    Entity.append({ tags: ["premium"] }),
  )
  // #endregion
  yield* Console.log(`Composed update:`)
  yield* Console.log(`  name: ${composed.name}`)
  yield* Console.log(`  price: $${composed.price}`)
  yield* Console.log(`  viewCount: ${composed.viewCount}`)
  yield* Console.log(`  stock: ${composed.stock}`)
  yield* Console.log(`  tags: ${JSON.stringify(composed.tags)}\n`)

  // --- Combining with expectedVersion ---
  yield* Console.log("=== Rich Updates + Optimistic Locking ===\n")

  // Use expectedVersion to guard against concurrent writes.
  // After the previous mutations (put + 4 updates), the version is 6.
  // #region locking
  const locked = yield* db.Products.update(
    { productId: "p-1" },
    Entity.add({ viewCount: 1 }),
    Products.expectedVersion(6),
  )

  // Wrong version → OptimisticLockError
  const lockFail = yield* db.Products.update(
    { productId: "p-1" },
    Entity.add({ viewCount: 1 }),
    Products.expectedVersion(1),
  ).pipe(
    Effect.map(() => "updated"),
    Effect.catchTag("OptimisticLockError", (e) =>
      Effect.succeed(`OptimisticLockError: expected v${e.expectedVersion}`),
    ),
  )
  // #endregion
  yield* Console.log(`Update with expectedVersion(6): viewCount = ${locked.viewCount}`)
  yield* Console.log(`Wrong version: ${lockFail}\n`)

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* db.deleteTable()
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
  MainTable.layer({ name: "updates-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
