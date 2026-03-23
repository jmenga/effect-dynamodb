/**
 * Guide: Expressions — effect-dynamodb v2
 *
 * Companion example for the Expressions guide. Demonstrates:
 *   - Condition expressions: callback API + shorthand syntax
 *   - Filter expressions: callback API + shorthand syntax
 *   - Update expressions: record-based + path-based combinators
 *   - Key condition expressions: collection queries + Query.where
 *   - Projection expressions: Entity.select callback + string array shorthand
 *   - PathBuilder: nested maps, array elements, size()
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-expressions.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// 1. Domain models
// ---------------------------------------------------------------------------

// #region model
class Address extends Schema.Class<Address>("Address")({
  street: Schema.String,
  city: Schema.String,
  zip: Schema.String,
}) {}

class RosterEntry extends Schema.Class<RosterEntry>("RosterEntry")({
  name: Schema.String,
  position: Schema.String,
}) {}

class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  name: Schema.NonEmptyString,
  status: Schema.String,
  role: Schema.String,
  category: Schema.String,
  price: Schema.Number,
  stock: Schema.Number,
  inStock: Schema.Boolean,
  viewCount: Schema.Number,
  email: Schema.optional(Schema.String),
  backup_email: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  temporaryFlag: Schema.optional(Schema.String),
  createdBy: Schema.optional(Schema.String),
  address: Address,
  roster: Schema.Array(RosterEntry),
  tags: Schema.Array(Schema.String),
  categories: Schema.optional(Schema.ReadonlySet(Schema.String)),
  metadata: Schema.optional(Schema.Struct({ temporary: Schema.optional(Schema.String) })),
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Schema + Table + Entity + Collections
// ---------------------------------------------------------------------------

// #region entities
const AppSchema = DynamoSchema.make({ name: "guide-expr", version: 1 })

const Products = Entity.make({
  model: Product,
  entityType: "Product",
  primaryKey: {
    pk: { field: "pk", composite: ["productId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCategory: {
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["category"],
      sk: ["productId"],
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
  const db = yield* DynamoClient.make({
    entities: { Products },
  })

  // --- Setup ---
  yield* db.tables["guide-expr-table"]!.create()
  yield* Console.log("Table created\n")

  // Seed products
  const baseProduct = {
    status: "active",
    role: "admin",
    inStock: true,
    viewCount: 0,
    address: { street: "123 Main St", city: "NYC", zip: "10001" },
    roster: [
      { name: "Alice", position: "lead" },
      { name: "Bob", position: "member" },
    ],
    tags: ["electronics", "featured"],
    metadata: { temporary: "yes" },
  } as const

  yield* db.entities.Products.put({
    ...baseProduct,
    productId: "p-1",
    name: "Widget",
    category: "electronics",
    price: 29.99,
    stock: 100,
    email: "widget@store.com",
  })
  yield* db.entities.Products.put({
    ...baseProduct,
    productId: "p-2",
    name: "Gadget",
    category: "electronics",
    price: 89.99,
    stock: 25,
    email: "gadget@store.com",
  })
  yield* db.entities.Products.put({
    ...baseProduct,
    productId: "p-3",
    name: "USB Cable",
    category: "accessories",
    price: 9.99,
    stock: 500,
  })
  yield* db.entities.Products.put({
    ...baseProduct,
    productId: "p-4",
    name: "Phone Case",
    category: "accessories",
    price: 14.99,
    stock: 0,
    status: "archived",
    inStock: false,
  })
  yield* Console.log("Seeded 4 products\n")

  // -----------------------------------------------------------------------
  // Condition Expressions — Callback API
  // -----------------------------------------------------------------------
  yield* Console.log("=== Condition Expressions — Callback API ===\n")

  // #region condition-callback
  // Single comparison
  Products.condition((t, { eq }) => eq(t.status, "active"))

  // Multiple conditions with AND
  Products.condition((t, { eq, gt, and }) => and(eq(t.status, "active"), gt(t.stock, 0)))

  // Nested path
  Products.condition((t, { eq }) => eq(t.address.city, "NYC"))

  // Size comparison
  Products.condition((t, { gt }) => gt(t.tags.size(), 5))

  // Attribute existence
  Products.condition((t, { exists }) => exists(t.email))

  // OR + NOT composition
  Products.condition((t, { or, not, eq }) =>
    or(eq(t.status, "active"), not(eq(t.status, "archived"))),
  )
  // #endregion

  yield* Console.log("Condition combinators built (callback API)\n")

  // -----------------------------------------------------------------------
  // Condition Expressions — Applied to put/update/delete
  // -----------------------------------------------------------------------
  yield* Console.log("=== Conditions on put/update/delete ===\n")

  // #region condition-on-operations
  // On put
  yield* db.entities.Products.put(
    {
      ...baseProduct,
      productId: "p-5",
      name: "New Product",
      category: "electronics",
      price: 49.99,
      stock: 10,
    },
    Products.condition((t, { notExists }) => notExists(t.productId)),
  )

  // On update (ANDed with optimistic lock)
  yield* db.entities.Products.update(
    { productId: "p-1" },
    Products.set({ name: "Widget Pro" }),
    Products.expectedVersion(1),
    Products.condition((t, { gt }) => gt(t.stock, 0)),
  )

  // On delete
  yield* db.entities.Products.delete(
    { productId: "p-4" },
    Products.condition((t, { eq }) => eq(t.stock, 0)),
  )
  // #endregion

  yield* Console.log("Conditional put, update, and delete succeeded\n")

  // -----------------------------------------------------------------------
  // Condition Expressions — Shorthand Syntax
  // -----------------------------------------------------------------------
  yield* Console.log("=== Condition Expressions — Shorthand ===\n")

  // #region condition-shorthand
  // Equivalent to: eq(t.status, "active") AND eq(t.role, "admin")
  Products.condition({ status: "active", role: "admin" })
  // #endregion

  yield* Console.log("Shorthand condition built\n")

  // -----------------------------------------------------------------------
  // Filter Expressions — Callback API
  // -----------------------------------------------------------------------
  yield* Console.log("=== Filter Expressions — Callback API ===\n")

  // #region filter-callback
  // Filter on entity index query — shorthand for equality
  const activeElectronics = yield* db.entities.Products.byCategory({ category: "electronics" })
    .filter({ status: "active" })
    .collect()

  // Filter on scan — callback with typed PathBuilder
  const withWidget = yield* db.entities.Products.scan()
    .filter((t, { contains }) => contains(t.name, "Widget"))
    .collect()

  // Complex filter with OR
  const activeOrPending = yield* db.entities.Products.scan()
    .filter((t, { or, eq }) => or(eq(t.status, "active"), eq(t.status, "pending")))
    .collect()
  // #endregion

  yield* Console.log(`Active electronics: ${activeElectronics.length} products`)
  yield* Console.log(`Containing "Widget": ${withWidget.length} products`)
  yield* Console.log(`Active or pending: ${activeOrPending.length} products\n`)

  // -----------------------------------------------------------------------
  // Filter Expressions — Shorthand Syntax
  // -----------------------------------------------------------------------
  yield* Console.log("=== Filter Expressions — Shorthand ===\n")

  // #region filter-shorthand
  Products.filter({ status: "active" })
  Products.filter({ category: "electronics", inStock: true })
  // #endregion

  yield* Console.log("Shorthand filters built\n")

  // -----------------------------------------------------------------------
  // Update Expressions — Record-Based Combinators
  // -----------------------------------------------------------------------
  yield* Console.log("=== Update Expressions — Record-Based ===\n")

  // Re-seed p-4 for further demos
  yield* db.entities.Products.put({
    ...baseProduct,
    productId: "p-4",
    name: "Phone Case",
    category: "accessories",
    price: 14.99,
    stock: 0,
    status: "archived",
    inStock: false,
    description: "A phone case",
    temporaryFlag: "temp",
    categories: new Set(["accessories", "obsolete"]),
  })

  // #region update-record
  // SET — assign values
  yield* db.entities.Products.update(
    { productId: "p-1" },
    Entity.set({ name: "Widget Deluxe", price: 34.99 }),
  )

  // REMOVE — delete attributes
  yield* db.entities.Products.update(
    { productId: "p-4" },
    Entity.remove(["description", "temporaryFlag"]),
  )

  // ADD — atomic increment (numbers) or union (sets)
  yield* db.entities.Products.update({ productId: "p-1" }, Entity.add({ viewCount: 1, stock: 50 }))

  // Subtract — SET field = field - value
  yield* db.entities.Products.update({ productId: "p-1" }, Entity.subtract({ stock: 3 }))

  // Append — SET field = list_append(field, value)
  yield* db.entities.Products.update(
    { productId: "p-1" },
    Entity.append({ tags: ["on-sale", "featured"] }),
  )

  // DELETE — remove elements from a set
  yield* db.entities.Products.update(
    { productId: "p-4" },
    Entity.deleteFromSet({ categories: new Set(["obsolete"]) }),
  )
  // #endregion

  yield* Console.log("Record-based updates applied\n")

  // -----------------------------------------------------------------------
  // Update Expressions — Composing Multiple Types
  // -----------------------------------------------------------------------
  yield* Console.log("=== Composing Multiple Update Types ===\n")

  // #region update-composed
  yield* db.entities.Products.update(
    { productId: "p-1" },
    Entity.set({ name: "Updated Widget", price: 24.99 }),
    Entity.add({ viewCount: 1 }),
    Entity.subtract({ stock: 3 }),
    Entity.append({ tags: ["clearance"] }),
    Entity.remove(["temporaryFlag"]),
    Products.expectedVersion(5),
  )
  // #endregion

  yield* Console.log("Composed update applied\n")

  // -----------------------------------------------------------------------
  // Update Expressions — Path-Based Combinators
  // -----------------------------------------------------------------------
  yield* Console.log("=== Update Expressions — Path-Based ===\n")

  // #region update-path
  // SET nested path
  yield* db.entities.Products.update({ productId: "p-1" }, (op) =>
    Entity.pathSet(op, { segments: ["address", "city"], value: "NYC", isPath: false }),
  )

  // SET array element
  yield* db.entities.Products.update({ productId: "p-1" }, (op) =>
    Entity.pathSet(op, { segments: ["roster", 0, "position"], value: "captain", isPath: false }),
  )

  // Copy attribute to attribute
  yield* db.entities.Products.update({ productId: "p-1" }, (op) =>
    Entity.pathSet(op, {
      segments: ["backup_email"],
      value: undefined,
      isPath: true,
      valueSegments: ["email"],
    }),
  )

  // REMOVE nested attribute
  yield* db.entities.Products.update({ productId: "p-1" }, (op) =>
    Entity.pathRemove(op, ["metadata", "temporary"]),
  )

  // PREPEND to list
  yield* db.entities.Products.update({ productId: "p-1" }, (op) =>
    Entity.pathPrepend(op, { segments: ["tags"], value: ["URGENT"] }),
  )

  // if_not_exists — set only if the attribute doesn't exist
  yield* db.entities.Products.update({ productId: "p-1" }, (op) =>
    Entity.pathIfNotExists(op, { segments: ["createdBy"], value: "system" }),
  )
  // #endregion

  yield* Console.log("Path-based updates applied\n")

  // -----------------------------------------------------------------------
  // Key Condition Expressions — Collection Queries
  // -----------------------------------------------------------------------
  yield* Console.log("=== Key Condition Expressions ===\n")

  // #region key-condition-query
  // Access via entity index query
  const byCategory = yield* db.entities.Products.byCategory({ category: "electronics" }).collect()

  // Partial SK composites narrow with begins_with automatically
  const byCategoryAndId = yield* db.entities.Products.byCategory({
    category: "electronics",
    productId: "p-1",
  }).collect()
  // #endregion

  yield* Console.log(`By category: ${byCategory.length} products`)
  yield* Console.log(`By category + productId: ${byCategoryAndId.length} products\n`)

  // -----------------------------------------------------------------------
  // Key Condition Expressions — Query.where
  // -----------------------------------------------------------------------
  yield* Console.log("=== Query.where ===\n")

  // #region key-condition-where
  // Pass SK composites to narrow with begins_with automatically
  const narrowed = yield* db.entities.Products.byCategory({
    category: "electronics",
    productId: "p-1",
  }).collect()

  // All products in category (no SK narrowing)
  const allInCategory = yield* db.entities.Products.byCategory({
    category: "electronics",
  }).collect()
  // #endregion

  yield* Console.log(`Narrowed (productId p-1): ${narrowed.length} products`)
  yield* Console.log(`All in category: ${allInCategory.length} products\n`)

  // -----------------------------------------------------------------------
  // Projection Expressions — Callback API
  // -----------------------------------------------------------------------
  yield* Console.log("=== Projection Expressions ===\n")

  // #region select-callback
  // Top-level fields
  Products.select((t) => [t.name, t.status])

  // Nested map paths
  Products.select((t) => [t.name, t.address.city])

  // Array elements
  Products.select((t) => [t.name, t.roster.at(0).name])

  // Mixed
  Products.select((t) => [t.name, t.address.city, t.tags.at(0)])
  // #endregion

  // -----------------------------------------------------------------------
  // Projection Expressions — Applied to queries
  // -----------------------------------------------------------------------

  // #region select-on-queries
  // Project on scan — callback
  const projected = yield* db.entities.Products.scan()
    .select((t) => [t.name, t.price])
    .collect()

  // Project on scan — string array shorthand
  const scanned = yield* db.entities.Products.scan().select(["name", "status"]).collect()
  // #endregion

  yield* Console.log(`Projected scan (callback): ${projected.length} items`)
  yield* Console.log(`Projected scan (shorthand): ${scanned.length} items\n`)

  // -----------------------------------------------------------------------
  // Projection Expressions — String Array Shorthand
  // -----------------------------------------------------------------------

  // #region select-shorthand
  Products.select(["name", "status", "price"])
  // #endregion

  yield* Console.log("Shorthand select built\n")

  // -----------------------------------------------------------------------
  // PathBuilder
  // -----------------------------------------------------------------------
  yield* Console.log("=== PathBuilder ===\n")

  // #region pathbuilder
  // t is PathBuilder<Product, Product>
  Products.condition((t, ops) => {
    // t.name        → Path with segments ["name"]
    // t.address.city → Path with segments ["address", "city"]
    // t.roster.at(0) → Path with segments ["roster", 0]
    // t.roster.at(0).name → Path with segments ["roster", 0, "name"]
    // t.tags.size() → SizeOperand with segments ["tags"]
    return ops.eq(t.status, "active")
  })
  // #endregion

  yield* Console.log("PathBuilder demonstrations complete\n")

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")
  yield* db.tables["guide-expr-table"]!.delete()
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
  MainTable.layer({ name: "guide-expr-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
