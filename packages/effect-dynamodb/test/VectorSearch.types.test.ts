/**
 * Type-level tests for the vector search surface.
 *
 * Every guard here exists because the runtime consequence of getting it wrong
 * is invisible locally and expensive in production: an undeclared filter
 * attribute is a `ValidationException` from DynamoDB, a missing partition value
 * is a rejected `SearchVectors` call, and a mistyped `.withVector()` name used
 * to be silently ignored (leaving the Embedder to run anyway).
 *
 * `@ts-expect-error` is load-bearing: TypeScript fails the build if the marked
 * line ever starts compiling, so these assertions cannot silently rot.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

const AppSchema = DynamoSchema.make({ name: "vectortypes", version: 1 })

class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  tenantId: Schema.String,
  description: Schema.String,
  category: Schema.String,
  price: Schema.Number,
}) {}

const Products = Entity.make({
  model: Product,
  entityType: "product",
  primaryKey: {
    pk: { field: "pk", composite: ["productId"] },
    sk: { field: "sk", composite: [] },
  },
  vectorIndexes: {
    byDescription: {
      name: "vec1",
      dimensions: 4,
      source: { fields: ["description"] },
      partition: ["tenantId"],
      filters: ["category"],
    },
  },
})

/** No `partition` and no `filters` — the degenerate end of both conditionals. */
const Notes = Entity.make({
  model: Product,
  entityType: "note",
  primaryKey: {
    pk: { field: "pk", composite: ["productId"] },
    sk: { field: "sk", composite: [] },
  },
  vectorIndexes: {
    byDescription: { name: "vec2", dimensions: 4, source: { fields: ["description"] } },
  },
})

/** No vector indexes at all — the vector surface must be absent entirely. */
const Plain = Entity.make({
  model: Product,
  entityType: "plain",
  primaryKey: {
    pk: { field: "pk", composite: ["productId"] },
    sk: { field: "sk", composite: [] },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Products, Notes, Plain } })

const input = {
  productId: "p-1",
  tenantId: "t-1",
  description: "waterproof boot",
  category: "footwear",
  price: 120,
}

/**
 * Never executed — the assertions are the compile itself. Kept inside a
 * function so nothing here needs a live DynamoDB.
 */
const _typeAssertions = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Products, Notes, Plain },
    tables: { MainTable },
  })

  // --- .filter() is restricted to declared INLINE_FILTER attributes ---
  yield* db.entities.Products.byDescription("x")
    .partition({ tenantId: "t-1" })
    .filter({ category: "footwear" })
    .collect()

  // @ts-expect-error `price` is a model field but is not declared in `filters`.
  yield* db.entities.Products.byDescription("x").partition({ tenantId: "t" }).filter({ price: 1 })

  // @ts-expect-error not a model field at all.
  yield* db.entities.Products.byDescription("x").partition({ tenantId: "t" }).filter({ nope: 1 })

  // --- .partition() is required when partition composites are declared ---
  // @ts-expect-error terminals do not exist until `.partition()` discharges them.
  yield* db.entities.Products.byDescription("x").collect()

  // …and absent when they are not: this index declares no partition, so the
  // terminal is reachable immediately.
  yield* db.entities.Notes.byDescription("x").collect()

  // An index with no declared filters accepts no filter keys.
  // @ts-expect-error `category` is not declared as an INLINE_FILTER on `vec2`.
  yield* db.entities.Notes.byDescription("x").filter({ category: "footwear" })

  // --- pagination combinators are structurally absent ---
  // @ts-expect-error SearchVectors has no cursor, so `.fetch()` cannot exist.
  yield* db.entities.Products.byDescription("x").partition({ tenantId: "t" }).fetch()

  // @ts-expect-error …nor `.paginate()`.
  db.entities.Products.byDescription("x").partition({ tenantId: "t" }).paginate()

  // --- .withVector() takes a declared LOGICAL index name ---
  yield* db.entities.Products.put(input).withVector("byDescription", [1, 0, 0, 0])

  // @ts-expect-error typo — used to be silently ignored, running the Embedder anyway.
  yield* db.entities.Products.put(input).withVector("byDescriptionn", [1, 0, 0, 0])

  // @ts-expect-error an entity with no vector indexes has no name to pass.
  yield* db.entities.Plain.put(input).withVector("byDescription", [1, 0, 0, 0])

  // --- EmbeddingError is in the declared error channel ---
  yield* db.entities.Products.put(input)
    .asEffect()
    .pipe(Effect.catchTag("EmbeddingError", () => Effect.void))
  yield* db.entities.Products.upsert(input)
    .asEffect()
    .pipe(Effect.catchTag("EmbeddingError", () => Effect.void))
  yield* db.entities.Products.update({ productId: "p-1" })
    .set({ description: "x" })
    .asEffect()
    .pipe(Effect.catchTag("EmbeddingError", () => Effect.void))

  // …and NOT in the channel of an entity without vector indexes, so the entity
  // keeps exactly the error surface it had before vector search existed.
  // @ts-expect-error EmbeddingError is unreachable for an entity with no vectorIndexes.
  yield* db.entities.Plain.put(input)
    .asEffect()
    .pipe(Effect.catchTag("EmbeddingError", () => Effect.void))

  // --- reembed exists only on entities that declare vector indexes ---
  yield* db.entities.Products.reembed({ concurrency: 2 })

  // @ts-expect-error nothing to re-embed on an entity without vector indexes.
  yield* db.entities.Plain.reembed()
})

describe("vector search types", () => {
  it("compiles the type-level assertion block", () => {
    // The assertions above are enforced by `tsc`; this keeps vitest happy and
    // makes the file's purpose discoverable from the test report.
    expect(typeof _typeAssertions).toBe("object")
  })
})
