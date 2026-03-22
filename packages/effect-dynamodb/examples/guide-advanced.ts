/**
 * Advanced guide example — effect-dynamodb
 *
 * Demonstrates:
 *   - Rich update operations (remove, add, subtract, append, deleteFromSet)
 *   - Composing multiple update types in a single call
 *   - Batch operations (Batch.get, Batch.write)
 *   - Conditional writes (condition on put, update, delete)
 *   - Composing conditions with optimistic locking
 *   - Handling ConditionalCheckFailed
 *   - Entity.create() for safe inserts
 *   - Entity-level expressions (condition, filter, select)
 *   - Low-level Expression builders
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-advanced.ts
 */

import { Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
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
  categories: Schema.ReadonlySet(Schema.String),
}) {}

const ProductModel = DynamoModel.configure(Product, {
  category: { immutable: true },
})

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
}) {}

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  title: Schema.NonEmptyString,
  status: Schema.Literals(["active", "done"]),
}) {}
// #endregion

// ---------------------------------------------------------------------------
// 2. Schema + Entities + Table
// ---------------------------------------------------------------------------

// #region entities
const AppSchema = DynamoSchema.make({ name: "advanced-demo", version: 1 })

const Products = Entity.make({
  model: ProductModel,
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

const Users = Entity.make({
  model: User,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
  },
  timestamps: true,
})

const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
  },
  timestamps: true,
  versioned: true,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Products, Users, Tasks },
})
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

  // Seed a product
  yield* db.Products.put({
    productId: "p-1",
    name: "Wireless Mouse",
    description: "Ergonomic wireless mouse",
    price: 29.99,
    stock: 100,
    viewCount: 0,
    tags: ["electronics", "accessories"],
    category: "peripherals",
    categories: new Set(["electronics", "accessories", "obsolete"]),
  })
  yield* Console.log("Seeded product p-1\n")

  // --- Removing Attributes ---
  yield* Console.log("=== Entity.remove() ===\n")

  // #region remove
  yield* db.Products.update({ productId: "p-1" }, Entity.remove(["description"]))
  // #endregion
  yield* Console.log("Removed description from p-1\n")

  // --- Atomic Increment ---
  yield* Console.log("=== Entity.add() ===\n")

  // #region add
  yield* db.Products.update({ productId: "p-1" }, Entity.add({ viewCount: 1, stock: 50 }))
  // #endregion
  yield* Console.log("Incremented viewCount by 1, stock by 50\n")

  // --- Atomic Decrement ---
  yield* Console.log("=== Entity.subtract() ===\n")

  // #region subtract
  yield* db.Products.update({ productId: "p-1" }, Entity.subtract({ stock: 3 }))
  // #endregion
  yield* Console.log("Decremented stock by 3\n")

  // --- Appending to Lists ---
  yield* Console.log("=== Entity.append() ===\n")

  // #region append
  yield* db.Products.update({ productId: "p-1" }, Entity.append({ tags: ["on-sale", "featured"] }))
  // #endregion
  yield* Console.log("Appended tags\n")

  // --- Removing from Sets ---
  yield* Console.log("=== Entity.deleteFromSet() ===\n")

  // #region delete-from-set
  yield* db.Products.update(
    { productId: "p-1" },
    Entity.deleteFromSet({ categories: new Set(["obsolete"]) }),
  )
  // #endregion
  yield* Console.log("Removed 'obsolete' from categories set\n")

  // --- Composing Multiple Update Types ---
  yield* Console.log("=== Composed Updates ===\n")

  // #region composed-updates
  yield* db.Products.update(
    { productId: "p-1" },
    Entity.set({ name: "Premium Mouse", price: 39.99 }),
    Entity.add({ viewCount: 10 }),
    Entity.subtract({ stock: 5 }),
    Entity.append({ tags: ["premium"] }),
    Entity.remove(["description"]),
    Entity.expectedVersion(5),
  )
  // #endregion
  yield* Console.log("Applied composed update to p-1\n")

  // --- Batch Operations ---
  yield* Console.log("=== Batch Operations ===\n")

  // #region batch-ops
  // Batch write (auto-chunks at 25 items)
  yield* Batch.write([
    Users.put({ userId: "u-1", email: "a@b.com", displayName: "A" }),
    Users.put({ userId: "u-2", email: "b@c.com", displayName: "B" }),
    Users.put({ userId: "u-3", email: "c@d.com", displayName: "C" }),
  ])

  // Batch get (auto-chunks at 100 items)
  const [u1, u2, u3] = yield* Batch.get([
    Users.get({ userId: "u-1" }),
    Users.get({ userId: "u-2" }),
    Users.get({ userId: "u-3" }),
  ])

  // Batch delete
  yield* Batch.write([Users.delete({ userId: "u-2" }), Users.delete({ userId: "u-3" })])
  // #endregion
  yield* Console.log(`Fetched: ${u1?.displayName}, ${u2?.displayName}, ${u3?.displayName}`)
  yield* Console.log("Batch deleted u-2, u-3\n")

  // --- Conditional Writes ---
  yield* Console.log("=== Conditional Writes ===\n")

  // Seed users and tasks for conditional write demos
  yield* db.Users.put({ userId: "u-10", email: "new@example.com", displayName: "New User" })
  yield* db.Tasks.put({ taskId: "t-1", title: "Build feature", status: "active" })

  // #region conditional-put
  // Conditional put — only if item doesn't already exist
  const condPutResult = yield* db.Users.put(
    { userId: "u-10", email: "new@example.com", displayName: "New User" },
    Users.condition((t, { notExists }) => notExists(t.email)),
  ).pipe(
    Effect.match({
      onFailure: (e) => `${e._tag} — already exists`,
      onSuccess: (u) => `created ${u.displayName}`,
    }),
  )
  // #endregion
  yield* Console.log(`Conditional put: ${condPutResult}`)

  // #region conditional-delete
  // Conditional delete — only if stock is zero
  const condDeleteResult = yield* db.Products.delete(
    { productId: "p-1" },
    Products.condition((t, { eq }) => eq(t.stock, 0)),
  ).pipe(
    Effect.match({
      onFailure: (e) => `${e._tag} — stock not zero, delete prevented`,
      onSuccess: () => "deleted (stock was 0)",
    }),
  )
  // #endregion
  yield* Console.log(`Conditional delete: ${condDeleteResult}`)

  // #region conditional-update
  // Conditional update — only if status is "active"
  yield* db.Tasks.update(
    { taskId: "t-1" },
    Entity.set({ status: "done" }),
    Tasks.condition((t, { eq }) => eq(t.status, "active")),
  )
  // #endregion
  yield* Console.log("Conditional writes completed\n")

  // --- Composing with Optimistic Locking ---
  yield* Console.log("=== Condition + Optimistic Locking ===\n")

  // #region optimistic-condition
  yield* db.Products.update(
    { productId: "p-1" },
    Entity.set({ price: 24.99 }),
    Products.expectedVersion(6),
    Products.condition((t, { gt }) => gt(t.stock, 0)),
  )
  // ConditionExpression: (#version = :v_lock) AND (#stock > :v0)
  // #endregion
  yield* Console.log("Updated with combined condition + version check\n")

  // --- Handling ConditionalCheckFailed ---
  yield* Console.log("=== Handling ConditionalCheckFailed ===\n")

  // #region handle-conditional
  const result = yield* db.Users.create({
    userId: "u-10",
    email: "new@example.com",
    displayName: "New User",
  }).pipe(Effect.catchTag("ConditionalCheckFailed", () => Effect.succeed("already exists")))
  // #endregion
  yield* Console.log(`Result: ${result}\n`)

  // --- Entity.create() ---
  yield* Console.log("=== Entity.create() ===\n")

  // #region create-safely
  // Create — fails with ConditionalCheckFailed if item already exists
  const user = yield* db.Users.create({
    userId: "u-20",
    email: "alice@example.com",
    displayName: "Alice",
  })

  // Duplicate — caught gracefully
  const dup = yield* db.Users.create({
    userId: "u-20",
    email: "alice@example.com",
    displayName: "Alice",
  }).pipe(
    Effect.map(() => "created"),
    Effect.catchTag("ConditionalCheckFailed", () => Effect.succeed("already exists")),
  )
  // #endregion
  yield* Console.log(`Created user: ${user.displayName}`)
  yield* Console.log(`Duplicate attempt: ${dup}\n`)

  // --- Entity-Level Expressions ---
  yield* Console.log("=== Entity-Level Expressions ===\n")

  // Seed more products for expression demos
  yield* db.Products.create({
    productId: "p-2",
    name: "Widget Pro",
    price: 49.99,
    stock: 200,
    viewCount: 0,
    tags: ["electronics"],
    category: "peripherals",
    categories: new Set(["electronics"]),
  })

  // #region entity-expressions
  // Condition — type-safe, nested paths, OR/NOT composition
  Products.condition((t, { eq, gt, and }) => and(eq(t.category, "peripherals"), gt(t.stock, 0)))

  // Filter — same API, applied to queries/scans
  const filtered = yield* db.Products.collect(
    Products.query.byCategory({ category: "peripherals" }),
    Products.filter((t, { contains }) => contains(t.name, "Widget")),
  )

  // Projection — select specific attributes
  const projected = yield* db.Products.collect(
    Products.scan(),
    Products.select((t) => [t.name, t.price]),
  )
  // #endregion
  yield* Console.log(`Filtered products containing 'Widget': ${filtered.length}`)
  yield* Console.log(`Projected items: ${projected.length}\n`)

  // --- Low-Level Expression Builders ---
  yield* Console.log("=== Low-Level Expression Builders ===\n")

  // #region expression-builders
  // Condition expression (for conditional writes)
  const cond = Expression.condition({
    eq: { status: "active" },
    gt: { stock: 0 },
  })

  // Filter expression (for query post-filtering)
  const filter = Expression.filter({
    between: { price: [10, 50] },
    attributeExists: "category",
  })

  // Update expression
  const upd = Expression.update({
    set: { displayName: "New Name", updatedAt: new Date().toISOString() },
    remove: ["temporaryFlag"],
    add: { loginCount: 1 },
  })
  // #endregion
  yield* Console.log(`Condition: ${cond.expression}`)
  yield* Console.log(`Filter: ${filter.expression}`)
  yield* Console.log(`Update: ${upd.expression}\n`)

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
  MainTable.layer({ name: "advanced-demo-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion
