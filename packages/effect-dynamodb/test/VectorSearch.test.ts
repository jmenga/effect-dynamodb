/**
 * Entity-level + emulation tests for native vector search (#78).
 *
 * Three layers of coverage:
 *
 *  1. **Emulation fidelity** — the brute-force distance functions must
 *     reproduce the DynamoDB developer guide's reference ranking table
 *     verbatim, including the score DIRECTIONS (COSINE/EUCLIDEAN report
 *     distances, DOT_PRODUCT reports a similarity). Everything downstream
 *     trusts these numbers, so they are pinned exactly.
 *  2. **Write path** — mock-client capture of the item / UpdateExpression, to
 *     prove the vector + partition attributes are written on put, gated on
 *     update, and stripped from snapshots / tombstones / event items.
 *  3. **Read path** — the emulation layer wired behind a real `DynamoClient`
 *     mock, so `SearchVectors` input construction and hit decoding are checked
 *     end to end.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as VectorSearchEmulation from "../src/VectorSearchEmulation.js"

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })

class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  tenantId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  category: Schema.String,
  price: Schema.Number,
}) {}

const DIMENSIONS = 4

const Products = Entity.make({
  model: Product,
  entityType: "product",
  primaryKey: {
    pk: { field: "pk", composite: ["tenantId", "productId"] },
    sk: { field: "sk", composite: [] },
  },
  vectorIndexes: {
    byDescription: {
      name: "vec1",
      dimensions: DIMENSIONS,
      distance: "cosine",
      source: { fields: ["name", "description"] },
      partition: ["tenantId"],
      filters: ["category"],
    },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Products } })

/** A fixed 4-dimension embedder so ranking assertions are exact. */
const fixedVectors: Record<string, ReadonlyArray<number>> = {}
const setVector = (text: string, vector: ReadonlyArray<number>): void => {
  fixedVectors[text] = vector
}
const FixedEmbedder = Layer.succeed(Embedder, {
  dimensions: DIMENSIONS,
  embed: (text: string) => Effect.succeed(fixedVectors[text] ?? [1, 0, 0, 0]),
})

/**
 * The developer guide's third reference vector, written the way the guide
 * writes it (4 dp) rather than as `Math.SQRT1_2`, so the fixture can be checked
 * against the published table character for character.
 */
// biome-ignore lint/suspicious/noApproximativeNumericConstant: matches the published reference table verbatim
const GUIDE_DIAGONAL: ReadonlyArray<number> = [0.7071, 0.7071, 0, 0]

const VECTOR_ATTR = "__edd_v_vec1__"
const PARTITION_ATTR = "__edd_vp_vec1__"

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

interface Capture {
  putItem?: Record<string, unknown>
  updateItem?: Record<string, unknown>
  transactWriteItems?: Record<string, unknown>
  searchVectors?: Record<string, unknown>
  scanItems?: Array<Record<string, AttributeValue>>
}

const currentItem: Record<string, AttributeValue> = {
  pk: { S: "$app#v1#product#tenantid_t-1#productid_p-1" },
  sk: { S: "$app#v1#product" },
  productId: { S: "p-1" },
  tenantId: { S: "t-1" },
  name: { S: "Trail Boot" },
  description: { S: "Waterproof hiking boot" },
  category: { S: "footwear" },
  price: { N: "120" },
  __edd_e__: { S: "product" },
  [VECTOR_ATTR]: { L: [{ N: "1" }, { N: "0" }, { N: "0" }, { N: "0" }] },
  [PARTITION_ATTR]: { S: "$app#v1#product#tenantid_t-1" },
}

const makeMockClient = (capture: Capture): DynamoClientService =>
  ({
    putItem: (input: Record<string, unknown>) => {
      capture.putItem = input
      return Effect.succeed({})
    },
    updateItem: (input: Record<string, unknown>) => {
      capture.updateItem = input
      return Effect.succeed({ Attributes: currentItem })
    },
    transactWriteItems: (input: Record<string, unknown>) => {
      capture.transactWriteItems = input
      return Effect.succeed({})
    },
    getItem: () => Effect.succeed({ Item: currentItem }),
    deleteItem: () => Effect.succeed({}),
    query: () => Effect.succeed({ Items: [] }),
    scan: () => Effect.succeed({ Items: capture.scanItems ?? [] }),
    searchVectors: (input: Record<string, unknown>) => {
      capture.searchVectors = input
      return Effect.succeed({ SearchResults: [] })
    },
    batchGetItem: () => Effect.die("batchGetItem not used"),
    batchWriteItem: () => Effect.die("batchWriteItem not used"),
    transactGetItems: () => Effect.die("transactGetItems not used"),
    createTable: () => Effect.die("createTable not used"),
    deleteTable: () => Effect.die("deleteTable not used"),
    describeTable: () => Effect.die("describeTable not used"),
    updateTable: () => Effect.die("updateTable not used"),
    listTables: () => Effect.die("listTables not used"),
    createBackup: () => Effect.die("createBackup not used"),
    deleteBackup: () => Effect.die("deleteBackup not used"),
    listBackups: () => Effect.die("listBackups not used"),
    restoreTableFromBackup: () => Effect.die("restoreTableFromBackup not used"),
    describeContinuousBackups: () => Effect.die("describeContinuousBackups not used"),
    updateContinuousBackups: () => Effect.die("updateContinuousBackups not used"),
    restoreTableToPointInTime: () => Effect.die("restoreTableToPointInTime not used"),
    exportTableToPointInTime: () => Effect.die("exportTableToPointInTime not used"),
    describeExport: () => Effect.die("describeExport not used"),
    updateTimeToLive: () => Effect.die("updateTimeToLive not used"),
    describeTimeToLive: () => Effect.die("describeTimeToLive not used"),
    tagResource: () => Effect.die("tagResource not used"),
    untagResource: () => Effect.die("untagResource not used"),
    listTagsOfResource: () => Effect.die("listTagsOfResource not used"),
  }) as unknown as DynamoClientService

const makeLayer = (capture: Capture) =>
  Layer.mergeAll(
    Layer.succeed(DynamoClient, makeMockClient(capture)),
    MainTable.layer({ name: "test-table" }),
    FixedEmbedder,
  )

// ---------------------------------------------------------------------------
// 1. Emulation fidelity — the developer guide's reference ranking table
// ---------------------------------------------------------------------------

describe("VectorSearchEmulation distance functions", () => {
  const query = [1, 0, 0, 0]
  const stored = {
    identical: [1, 0, 0, 0],
    scaled: [10, 0, 0, 0],
    diagonal: GUIDE_DIAGONAL,
    opposite: [-1, 0, 0, 0],
  } as const

  it("reproduces the documented COSINE scores (0..2, lower is closer)", () => {
    expect(VectorSearchEmulation.cosineDistance(query, stored.identical)).toBeCloseTo(0.0, 4)
    expect(VectorSearchEmulation.cosineDistance(query, stored.scaled)).toBeCloseTo(0.0, 4)
    expect(VectorSearchEmulation.cosineDistance(query, stored.diagonal)).toBeCloseTo(0.29, 2)
    expect(VectorSearchEmulation.cosineDistance(query, stored.opposite)).toBeCloseTo(2.0, 4)
  })

  it("reproduces the documented EUCLIDEAN scores (0..inf, lower is closer)", () => {
    expect(VectorSearchEmulation.euclideanDistance(query, stored.identical)).toBeCloseTo(0.0, 4)
    expect(VectorSearchEmulation.euclideanDistance(query, stored.scaled)).toBeCloseTo(9.0, 4)
    expect(VectorSearchEmulation.euclideanDistance(query, stored.diagonal)).toBeCloseTo(0.77, 2)
    expect(VectorSearchEmulation.euclideanDistance(query, stored.opposite)).toBeCloseTo(2.0, 4)
  })

  it("reproduces the documented DOT_PRODUCT scores (higher is closer, may be negative)", () => {
    expect(VectorSearchEmulation.dotProduct(query, stored.identical)).toBeCloseTo(1.0, 4)
    expect(VectorSearchEmulation.dotProduct(query, stored.scaled)).toBeCloseTo(10.0, 4)
    expect(VectorSearchEmulation.dotProduct(query, stored.diagonal)).toBeCloseTo(0.71, 2)
    expect(VectorSearchEmulation.dotProduct(query, stored.opposite)).toBeCloseTo(-1.0, 4)
  })

  it("routes each distance function through scoreVector", () => {
    expect(VectorSearchEmulation.scoreVector(query, stored.opposite, "cosine")).toBeCloseTo(2.0, 4)
    expect(VectorSearchEmulation.scoreVector(query, stored.scaled, "euclidean")).toBeCloseTo(9.0, 4)
    expect(VectorSearchEmulation.scoreVector(query, stored.scaled, "dotProduct")).toBeCloseTo(
      10.0,
      4,
    )
  })

  it("treats a zero-magnitude vector as maximally orthogonal rather than NaN", () => {
    expect(VectorSearchEmulation.cosineDistance(query, [0, 0, 0, 0])).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Write path
// ---------------------------------------------------------------------------

describe("vector search write path", () => {
  it.effect("put writes the embedding and the composed partition attribute", () => {
    const capture: Capture = {}
    setVector("Trail Boot Waterproof hiking boot", [0, 1, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.put({
        productId: "p-1",
        tenantId: "t-1",
        name: "Trail Boot",
        description: "Waterproof hiking boot",
        category: "footwear",
        price: 120,
      })
      const item = capture.putItem?.Item as Record<string, AttributeValue>
      expect(item[VECTOR_ATTR]).toEqual({ L: [{ N: "0" }, { N: "1" }, { N: "0" }, { N: "0" }] })
      // Entity type is baked into the partition value — that is what scopes a
      // shared physical index to one entity type.
      expect(item[PARTITION_ATTR]).toEqual({ S: "$app#v1#product#tenantid_t-1" })
    }).pipe(Effect.provide(makeLayer(capture)))
  })

  it.effect("put without an Embedder fails with a pointed EmbeddingError", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const result = yield* Effect.flip(
        db.entities.Products.put({
          productId: "p-1",
          tenantId: "t-1",
          name: "Trail Boot",
          description: "Waterproof hiking boot",
          category: "footwear",
          price: 120,
        }).asEffect(),
      )
      // `EmbeddingError` is in the declared error channel because the entity
      // declares vectorIndexes — no cast needed to reach `.index`.
      expect(result._tag).toBe("EmbeddingError")
      if (result._tag !== "EmbeddingError") throw new Error("expected EmbeddingError")
      expect(result.index).toBe("byDescription")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, makeMockClient(capture)),
          MainTable.layer({ name: "test-table" }),
        ),
      ),
    )
  })

  it.effect(".withVector skips the Embedder entirely", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.put({
        productId: "p-1",
        tenantId: "t-1",
        name: "Trail Boot",
        description: "Waterproof hiking boot",
        category: "footwear",
        price: 120,
      }).withVector("byDescription", [0.5, 0.5, 0.5, 0.5])
      const item = capture.putItem?.Item as Record<string, AttributeValue>
      expect(item[VECTOR_ATTR]).toEqual({
        L: [{ N: "0.5" }, { N: "0.5" }, { N: "0.5" }, { N: "0.5" }],
      })
      // No Embedder is provided in this layer stack, so reaching here at all
      // proves the escape hatch bypassed it.
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, makeMockClient(capture)),
          MainTable.layer({ name: "test-table" }),
        ),
      ),
    )
  })

  it.effect("a put whose embedding has the wrong arity fails before writing", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const result = yield* Effect.flip(
        db.entities.Products.put({
          productId: "p-1",
          tenantId: "t-1",
          name: "Trail Boot",
          description: "Waterproof hiking boot",
          category: "footwear",
          price: 120,
        })
          .withVector("byDescription", [1, 0])
          .asEffect(),
      )
      expect(result._tag).toBe("EmbeddingError")
      expect(capture.putItem).toBeUndefined()
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, makeMockClient(capture)),
          MainTable.layer({ name: "test-table" }),
        ),
      ),
    )
  })

  it.effect("update re-embeds when the payload touches a source field", () => {
    const capture: Capture = {}
    setVector("Trail Boot Now with GORE-TEX", [0, 0, 1, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.update({ tenantId: "t-1", productId: "p-1" }).set({
        description: "Now with GORE-TEX",
      })
      const values = capture.updateItem?.ExpressionAttributeValues as Record<string, AttributeValue>
      const names = capture.updateItem?.ExpressionAttributeNames as Record<string, string>
      const vectorKey = Object.keys(names).find((k) => names[k] === VECTOR_ATTR)
      expect(vectorKey).toBeDefined()
      // Source text merged the stored `name` with the new `description` — the
      // update reads the current item because the payload was a partial source.
      const valueKey = `:${vectorKey!.slice(1)}`
      expect(values[valueKey]).toEqual({ L: [{ N: "0" }, { N: "0" }, { N: "1" }, { N: "0" }] })
    }).pipe(Effect.provide(makeLayer(capture)))
  })

  it.effect("update leaves the vector untouched when no source field is named", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.update({ tenantId: "t-1", productId: "p-1" }).set({ price: 99 })
      const names = capture.updateItem?.ExpressionAttributeNames as Record<string, string>
      const written = Object.values(names)
      expect(written).not.toContain(VECTOR_ATTR)
      // The partition value is idempotent, so it is always recomposed.
      expect(written).toContain(PARTITION_ATTR)
    }).pipe(Effect.provide(makeLayer(capture)))
  })
})

// ---------------------------------------------------------------------------
// 3. Read path (through the emulation layer)
// ---------------------------------------------------------------------------

const storedItem = (
  productId: string,
  category: string,
  vector: ReadonlyArray<number>,
  tenantId = "t-1",
): Record<string, AttributeValue> => ({
  pk: { S: `$app#v1#product#tenantid_${tenantId}#productid_${productId}` },
  sk: { S: "$app#v1#product" },
  productId: { S: productId },
  tenantId: { S: tenantId },
  name: { S: productId },
  description: { S: `${productId} description` },
  category: { S: category },
  price: { N: "10" },
  __edd_e__: { S: "product" },
  [VECTOR_ATTR]: { L: vector.map((n) => ({ N: String(n) })) },
  [PARTITION_ATTR]: { S: `$app#v1#product#tenantid_${tenantId}` },
})

const makeEmulatedLayer = (capture: Capture) =>
  Layer.mergeAll(
    VectorSearchEmulation.layer(Layer.succeed(DynamoClient, makeMockClient(capture)), {
      tables: { MainTable },
    }),
    MainTable.layer({ name: "test-table" }),
    FixedEmbedder,
  )

describe("vector search read path", () => {
  it.effect("ranks hits most-similar-first and normalizes the score", () => {
    const capture: Capture = {
      scanItems: [
        storedItem("far", "footwear", [-1, 0, 0, 0]),
        storedItem("near", "footwear", [1, 0, 0, 0]),
        storedItem("mid", "footwear", GUIDE_DIAGONAL),
      ],
    }
    setVector("hiking boots", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const hits = yield* db.entities.Products.byDescription("hiking boots")
        .partition({ tenantId: "t-1" })
        .collect()
      expect(hits.map((h) => h.item.productId)).toEqual(["near", "mid", "far"])
      // rawScore keeps the wire value (cosine distance, lower is closer)…
      expect(hits[0]!.rawScore).toBeCloseTo(0, 4)
      expect(hits[2]!.rawScore).toBeCloseTo(2, 4)
      // …while similarity is normalized higher-is-more-similar.
      expect(hits[0]!.similarity).toBeCloseTo(1, 4)
      expect(hits[2]!.similarity).toBeCloseTo(0, 4)
    }).pipe(Effect.provide(makeEmulatedLayer(capture)))
  })

  it.effect("scopes results to the composed partition value", () => {
    const capture: Capture = {
      scanItems: [
        storedItem("mine", "footwear", [1, 0, 0, 0], "t-1"),
        storedItem("theirs", "footwear", [1, 0, 0, 0], "t-2"),
      ],
    }
    setVector("boots", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const hits = yield* db.entities.Products.byDescription("boots")
        .partition({ tenantId: "t-1" })
        .collect()
      expect(hits.map((h) => h.item.productId)).toEqual(["mine"])
    }).pipe(Effect.provide(makeEmulatedLayer(capture)))
  })

  it.effect("applies equality-only inline filters", () => {
    const capture: Capture = {
      scanItems: [
        storedItem("boot", "footwear", [1, 0, 0, 0]),
        storedItem("mug", "kitchen", [1, 0, 0, 0]),
      ],
    }
    setVector("anything", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const hits = yield* db.entities.Products.byDescription("anything")
        .partition({ tenantId: "t-1" })
        .filter({ category: "kitchen" })
        .collect()
      expect(hits.map((h) => h.item.productId)).toEqual(["mug"])
    }).pipe(Effect.provide(makeEmulatedLayer(capture)))
  })

  it.effect("clamps topK into 1..100 and truncates results", () => {
    const capture: Capture = {
      scanItems: [
        storedItem("a", "footwear", [1, 0, 0, 0]),
        storedItem("b", "footwear", [0.9, 0.1, 0, 0]),
        storedItem("c", "footwear", [0.8, 0.2, 0, 0]),
      ],
    }
    setVector("x", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const hits = yield* db.entities.Products.byDescription("x")
        .partition({ tenantId: "t-1" })
        .topK(2)
        .collect()
      expect(hits).toHaveLength(2)
      const clamped = yield* db.entities.Products.byDescription("x")
        .partition({ tenantId: "t-1" })
        .topK(1000)
        .collect()
      expect(clamped).toHaveLength(3)
    }).pipe(Effect.provide(makeEmulatedLayer(capture)))
  })

  it.effect("accepts a pre-computed query vector without an Embedder", () => {
    const capture: Capture = {
      scanItems: [storedItem("only", "footwear", [0, 1, 0, 0])],
    }
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const hits = yield* db.entities.Products.byDescription([0, 1, 0, 0])
        .partition({ tenantId: "t-1" })
        .collect()
      expect(hits).toHaveLength(1)
      expect(hits[0]!.similarity).toBeCloseTo(1, 4)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          VectorSearchEmulation.layer(Layer.succeed(DynamoClient, makeMockClient(capture)), {
            tables: { MainTable },
          }),
          MainTable.layer({ name: "test-table" }),
        ),
      ),
    )
  })

  it.effect("select() projects attributes and strips library-managed ones", () => {
    const capture: Capture = {
      scanItems: [storedItem("only", "footwear", [1, 0, 0, 0])],
    }
    setVector("x", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const hits = yield* db.entities.Products.byDescription("x")
        .partition({ tenantId: "t-1" })
        .select(["productId", "price"])
        .collect()
      expect(hits[0]!.item).toEqual({ productId: "only", price: 10 })
    }).pipe(Effect.provide(makeEmulatedLayer(capture)))
  })

  it.effect("skips items that carry no embedding (sparse index semantics)", () => {
    const withoutVector = storedItem("novec", "footwear", [1, 0, 0, 0])
    delete withoutVector[VECTOR_ATTR]
    const capture: Capture = {
      scanItems: [withoutVector, storedItem("hasvec", "footwear", [1, 0, 0, 0])],
    }
    setVector("x", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const hits = yield* db.entities.Products.byDescription("x")
        .partition({ tenantId: "t-1" })
        .collect()
      expect(hits.map((h) => h.item.productId)).toEqual(["hasvec"])
    }).pipe(Effect.provide(makeEmulatedLayer(capture)))
  })

  it.effect("sends a bare N-array as SearchVector, not an L-wrapped list", () => {
    const capture: Capture = {}
    setVector("x", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.byDescription("x").partition({ tenantId: "t-1" }).collect()
      expect(capture.searchVectors?.SearchVector).toEqual([
        { N: "1" },
        { N: "0" },
        { N: "0" },
        { N: "0" },
      ])
      expect(capture.searchVectors?.IndexName).toBe("vec1")
      expect(capture.searchVectors?.TopK).toBe(10)
      expect(capture.searchVectors?.SearchConditionExpression).toBe("#vp = :vp")
    }).pipe(Effect.provide(makeLayer(capture)))
  })
})

// ---------------------------------------------------------------------------
// 4. Table definition
// ---------------------------------------------------------------------------

describe("Table.definition vector indexes", () => {
  it("emits a VectorIndex with the composed partition as the single HASH element", () => {
    const definition = Table.definition(MainTable as unknown as Table.Table)
    expect(definition.VectorIndexes).toEqual([
      {
        IndexName: "vec1",
        VectorAttribute: { AttributeName: VECTOR_ATTR },
        Dimensions: DIMENSIONS,
        DistanceFunction: "COSINE",
        Projection: { ProjectionType: "ALL" },
        SearchSchema: [
          { AttributeName: PARTITION_ATTR, SearchSchemaElementType: "HASH" },
          { AttributeName: "category", SearchSchemaElementType: "INLINE_FILTER" },
        ],
      },
    ])
  })

  it("rejects entities that share a physical index with conflicting settings (EDD-9035)", () => {
    const Other = Entity.make({
      model: Product,
      entityType: "other",
      primaryKey: {
        pk: { field: "pk", composite: ["productId"] },
        sk: { field: "sk", composite: [] },
      },
      vectorIndexes: {
        byDescription: {
          name: "vec1",
          // Same physical index, different dimensionality — unrepresentable in
          // DynamoDB, so it must fail at definition time.
          dimensions: 8,
          source: { fields: ["description"] },
        },
      },
    })
    expect(() => Table.make({ schema: AppSchema, entities: { Products, Other } })).toThrow(
      "[EDD-9035]",
    )
  })

  it("omits VectorIndexes entirely when no entity declares one", () => {
    const Plain = Entity.make({
      model: Product,
      entityType: "plain",
      primaryKey: {
        pk: { field: "pk", composite: ["productId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const PlainTable = Table.make({ schema: AppSchema, entities: { Plain } })
    expect(Table.definition(PlainTable as unknown as Table.Table).VectorIndexes).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5. Lifecycle — sparse semantics do the "delete from index" work
// ---------------------------------------------------------------------------

const LifecycleProducts = Entity.make({
  model: Product,
  entityType: "lcproduct",
  primaryKey: {
    pk: { field: "pk", composite: ["tenantId", "productId"] },
    sk: { field: "sk", composite: [] },
  },
  versioned: { retain: true },
  softDelete: true,
  vectorIndexes: {
    byDescription: {
      name: "vec1",
      dimensions: DIMENSIONS,
      source: { fields: ["name", "description"] },
      partition: ["tenantId"],
    },
  },
})

const LifecycleTable = Table.make({
  schema: AppSchema,
  entities: { LifecycleProducts },
})

const lifecycleStoredItem: Record<string, AttributeValue> = {
  pk: { S: "$app#v1#lcproduct#tenantid_t-1#productid_p-1" },
  sk: { S: "$app#v1#lcproduct" },
  productId: { S: "p-1" },
  tenantId: { S: "t-1" },
  name: { S: "Trail Boot" },
  description: { S: "Waterproof hiking boot" },
  category: { S: "footwear" },
  price: { N: "120" },
  version: { N: "3" },
  __edd_e__: { S: "lcproduct" },
  [VECTOR_ATTR]: { L: [{ N: "1" }, { N: "0" }, { N: "0" }, { N: "0" }] },
  [PARTITION_ATTR]: { S: "$app#v1#lcproduct#tenantid_t-1" },
}

const makeLifecycleLayer = (capture: Capture, item = lifecycleStoredItem) =>
  Layer.mergeAll(
    Layer.succeed(DynamoClient, {
      ...makeMockClient(capture),
      getItem: () => Effect.succeed({ Item: item }),
      query: () => Effect.succeed({ Items: [item] }),
    } as unknown as DynamoClientService),
    LifecycleTable.layer({ name: "test-table" }),
    FixedEmbedder,
  )

/** Pull the Put items out of a captured TransactWriteItems request. */
const transactPuts = (capture: Capture): Array<Record<string, AttributeValue>> =>
  (
    (capture.transactWriteItems?.TransactItems ?? []) as Array<{
      Put?: { Item: Record<string, AttributeValue> }
    }>
  )
    .map((entry) => entry.Put?.Item)
    .filter((item): item is Record<string, AttributeValue> => item !== undefined)

describe("vector search lifecycle integration", () => {
  it.effect("version snapshots strip the vector and partition attributes", () => {
    const capture: Capture = {}
    setVector("Trail Boot Now drier", [0, 1, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { LifecycleProducts },
        tables: { LifecycleTable },
      })
      yield* db.entities.LifecycleProducts.update({ tenantId: "t-1", productId: "p-1" }).set({
        description: "Now drier",
      })
      const puts = transactPuts(capture)
      // Index 0 is the live item; index 1 is the pre-update snapshot.
      const snapshot = puts[1]!
      expect(snapshot.sk).toEqual({ S: "$app#v1#lcproduct#v#0000003" })
      expect(snapshot[VECTOR_ATTR]).toBeUndefined()
      expect(snapshot[PARTITION_ATTR]).toBeUndefined()
      expect(puts[0]![VECTOR_ATTR]).toBeDefined()
    }).pipe(Effect.provide(makeLifecycleLayer(capture)))
  })

  it.effect("soft delete stashes the embedding and strips the indexed attributes", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { LifecycleProducts },
        tables: { LifecycleTable },
      })
      yield* db.entities.LifecycleProducts.delete({ tenantId: "t-1", productId: "p-1" })
      const tombstone = transactPuts(capture)[0]!
      expect(tombstone[VECTOR_ATTR]).toBeUndefined()
      expect(tombstone[PARTITION_ATTR]).toBeUndefined()
      // Stashed under a non-indexed name so restore never re-embeds.
      expect(tombstone.__edd_vs_vec1__).toEqual({
        L: [{ N: "1" }, { N: "0" }, { N: "0" }, { N: "0" }],
      })
    }).pipe(Effect.provide(makeLifecycleLayer(capture)))
  })

  it.effect("restore un-stashes the embedding without calling the Embedder", () => {
    const capture: Capture = {}
    const tombstone: Record<string, AttributeValue> = {
      ...lifecycleStoredItem,
      sk: { S: "$app#v1#lcproduct#deleted#2026-01-01t00:00:00.000z" },
      deletedAt: { S: "2026-01-01T00:00:00.000Z" },
      __edd_vs_vec1__: { L: [{ N: "0" }, { N: "0" }, { N: "1" }, { N: "0" }] },
    }
    delete tombstone[VECTOR_ATTR]
    delete tombstone[PARTITION_ATTR]
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { LifecycleProducts },
        tables: { LifecycleTable },
      })
      yield* db.entities.LifecycleProducts.restore({ tenantId: "t-1", productId: "p-1" })
      const restored = transactPuts(capture)[0]!
      expect(restored[VECTOR_ATTR]).toEqual({
        L: [{ N: "0" }, { N: "0" }, { N: "1" }, { N: "0" }],
      })
      expect(restored[PARTITION_ATTR]).toEqual({ S: "$app#v1#lcproduct#tenantid_t-1" })
      expect(restored.__edd_vs_vec1__).toBeUndefined()
      // No Embedder is in this layer stack — reaching here proves restore is
      // purely a re-index, not a re-embed.
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, {
            ...makeMockClient(capture),
            getItem: () => Effect.succeed({ Item: undefined }),
            query: () => Effect.succeed({ Items: [tombstone] }),
          } as unknown as DynamoClientService),
          LifecycleTable.layer({ name: "test-table" }),
        ),
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// 6. DynamoClient.make dimension agreement
// ---------------------------------------------------------------------------

describe("DynamoClient.make embedder validation", () => {
  it.effect("rejects an Embedder whose dimensionality disagrees with an index", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const message = yield* Effect.gen(function* () {
        yield* DynamoClient.make({
          entities: { Products },
          tables: { MainTable },
          embedder: { dimensions: 1024, embed: () => Effect.succeed([]) },
        })
        return "no failure"
      }).pipe(Effect.catchDefect((defect) => Effect.succeed(String(defect))))
      expect(message).toContain("EDD-9037")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, makeMockClient(capture)),
          MainTable.layer({ name: "test-table" }),
        ),
      ),
    )
  })
})
