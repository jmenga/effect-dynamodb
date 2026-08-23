/**
 * Vector Search Guide Example — effect-dynamodb
 *
 * Demonstrates native DynamoDB vector search:
 *   - Declaring `vectorIndexes` on an entity (dimensions, distance, source)
 *   - The `Embedder` service — pluggable per environment
 *   - Automatic entity + tenant scoping via the composed partition attribute
 *   - `db.entities.X.<index>(query)` — the BoundVectorQuery builder
 *   - `.withVector()` for pre-computed embeddings
 *   - `reembed()` for model migrations
 *   - `VectorSearchEmulation.layer` — DynamoDB Local has no vector search
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-vector-search.ts
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Console, Effect, Layer, Schema } from "effect"

// Import from source (use "effect-dynamodb" when published)
import { DynamoClient } from "../src/DynamoClient.js"
import { Embedder } from "../src/index.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as VectorSearchEmulation from "../src/VectorSearchEmulation.js"

// =============================================================================
// 1. Pure domain model — the embedding never appears here
// =============================================================================

// #region model
class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  tenantId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  category: Schema.String,
  price: Schema.Number,
}) {}
// #endregion

const AppSchema = DynamoSchema.make({ name: "vector-demo", version: 1 })

// =============================================================================
// 2. Entity definition — vectorIndexes alongside primaryKey / indexes
// =============================================================================

// #region define
const Products = Entity.make({
  model: Product,
  entityType: "Product",
  primaryKey: {
    pk: { field: "pk", composite: ["tenantId", "productId"] },
    sk: { field: "sk", composite: [] },
  },
  vectorIndexes: {
    byDescription: {
      name: "vec1", // physical vector index on the table
      dimensions: 8, // immutable after CreateTable
      distance: "cosine", // cosine | euclidean | dotProduct — immutable
      source: { fields: ["name", "description"] },
      partition: ["tenantId"], // composed into the HASH attribute
      filters: ["category"], // INLINE_FILTER attributes (equality-only)
    },
  },
})
// #endregion

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Products },
})

// =============================================================================
// 3. Layers — the Embedder plugs in here
// =============================================================================

// #region layers
const endpoint = Config.string("DYNAMODB_ENDPOINT").pipe(
  Config.withDefault("http://localhost:8000"),
)

const ClientLayer = DynamoClient.layerConfig({
  region: Config.succeed("us-east-1"),
  endpoint,
  credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
})

// DynamoDB Local silently discards VectorIndexes on CreateTable and rejects
// SearchVectors outright, so local runs go through the emulation layer. Against
// real DynamoDB you would use `ClientLayer` directly.
const EmulatedClientLayer = VectorSearchEmulation.layer(ClientLayer, {
  tables: { MainTable },
})

const AppLayer = Layer.mergeAll(
  EmulatedClientLayer,
  MainTable.layer({ name: "vector-demo-table" }),
  // A deterministic in-library embedder. Swap for a Bedrock/OpenAI-backed
  // implementation in production — see § "Bringing your own Embedder".
  Embedder.layerTest({ dimensions: 8 }),
)
// #endregion

// =============================================================================
// 4. Program
// =============================================================================

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make({
    entities: { Products },
    tables: { MainTable },
  })

  // `create()` emits the merged VectorIndexes derived from every registered
  // entity — nothing extra to declare at the table level.
  yield* db.tables.MainTable.create()

  // ---------- Write — the embedding is generated for you ----------
  // #region write
  yield* db.entities.Products.put({
    productId: "p-1",
    tenantId: "acme",
    name: "Summit Trail Boot",
    description: "Waterproof leather hiking boot with ankle support",
    category: "footwear",
    price: 189,
  })

  yield* db.entities.Products.put({
    productId: "p-2",
    tenantId: "acme",
    name: "Harbour Deck Shoe",
    description: "Breathable canvas boat shoe for warm weather",
    category: "footwear",
    price: 89,
  })

  yield* db.entities.Products.put({
    productId: "p-3",
    tenantId: "acme",
    name: "Camp Kettle",
    description: "Hard anodised aluminium kettle for camp stoves",
    category: "cookware",
    price: 45,
  })
  // #endregion

  // ---------- Search ----------
  // #region search
  const hits = yield* db.entities.Products
    .byDescription("waterproof hiking boots")
    .partition({ tenantId: "acme" })
    .topK(5)
    .collect()

  for (const hit of hits) {
    yield* Console.log(`${hit.item.name} — similarity ${hit.similarity.toFixed(3)}`)
  }
  // #endregion

  if (hits.length === 0) {
    yield* Effect.die(new Error("expected at least one vector search hit"))
  }

  // ---------- Filter + project ----------
  // #region filter
  const cookware = yield* db.entities.Products
    .byDescription("something to boil water in")
    .partition({ tenantId: "acme" })
    .filter({ category: "cookware" })
    .select(["productId", "name", "price"])
    .collect()

  yield* Console.log(`Cookware matches: ${cookware.length}`)
  // #endregion

  if (cookware.length !== 1) {
    yield* Effect.die(new Error("expected exactly one cookware match"))
  }

  // ---------- Tenant scoping is automatic ----------
  // The partition attribute is `$vector-demo#v1#product#tenantid_<tenant>`, so a
  // search never crosses tenants — or entity types, since the entity prefix is
  // in the same value.
  // #region scoping
  yield* db.entities.Products.put({
    productId: "p-9",
    tenantId: "globex",
    name: "Summit Trail Boot",
    description: "Waterproof leather hiking boot with ankle support",
    category: "footwear",
    price: 189,
  })

  const globex = yield* db.entities.Products
    .byDescription("waterproof hiking boots")
    .partition({ tenantId: "globex" })
    .collect()

  yield* Console.log(`Globex sees ${globex.length} product(s), not Acme's ${hits.length}`)
  // #endregion

  if (globex.length !== 1) {
    yield* Effect.die(new Error("tenant scoping failed"))
  }

  // ---------- Updates re-embed only when the source changes ----------
  // #region update
  // `price` is not a source field — no Embedder call, vector untouched.
  yield* db.entities.Products.update({ tenantId: "acme", productId: "p-1" }).set({ price: 199 })

  // `description` IS a source field — the vector is regenerated.
  yield* db.entities.Products
    .update({ tenantId: "acme", productId: "p-1" })
    .set({ description: "Insulated waterproof boot for alpine trekking" })
  // #endregion

  // ---------- Pre-computed embeddings ----------
  // #region with-vector
  yield* db.entities.Products
    .put({
      productId: "p-4",
      tenantId: "acme",
      name: "Trail Sock",
      description: "Merino wool hiking sock",
      category: "apparel",
      price: 19,
    })
    .withVector("byDescription", [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
  // #endregion

  // ---------- Re-embedding after a model change ----------
  // DynamoDB never recomputes a vector, so switching embedding models means
  // rewriting every stored vector.
  // #region reembed
  const rewritten = yield* db.entities.Products.reembed({ concurrency: 4 })
  yield* Console.log(`Re-embedded ${rewritten} item(s)`)
  // #endregion

  if (rewritten < 4) {
    yield* Effect.die(new Error("expected reembed to rewrite every product"))
  }

  const client = yield* DynamoClient
  yield* client.deleteTable({ TableName: "vector-demo-table" })
})

// =============================================================================
// 5. Run
// =============================================================================

Effect.runPromise(program.pipe(Effect.provide(AppLayer), Effect.scoped))
