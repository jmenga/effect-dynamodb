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
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
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

  it.effect("upsert writes the embedding and partition attribute (B1)", () => {
    const capture: Capture = {}
    setVector("Trail Boot Waterproof hiking boot", [0, 1, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.upsert({
        productId: "p-1",
        tenantId: "t-1",
        name: "Trail Boot",
        description: "Waterproof hiking boot",
        category: "footwear",
        price: 120,
      })
      const names = capture.updateItem?.ExpressionAttributeNames as Record<string, string>
      const values = capture.updateItem?.ExpressionAttributeValues as Record<string, AttributeValue>
      const vectorKey = Object.keys(names).find((k) => names[k] === VECTOR_ATTR)
      const partitionKey = Object.keys(names).find((k) => names[k] === PARTITION_ATTR)
      expect(vectorKey).toBeDefined()
      expect(partitionKey).toBeDefined()
      expect(values[`:${vectorKey!.slice(1)}`]).toEqual({
        L: [{ N: "0" }, { N: "1" }, { N: "0" }, { N: "0" }],
      })
      expect(values[`:${partitionKey!.slice(1)}`]).toEqual({ S: "$app#v1#product#tenantid_t-1" })
      // Plain SET, never if_not_exists — an upsert that overwrites the source
      // fields must overwrite the vector derived from them.
      const expression = capture.updateItem?.UpdateExpression as string
      expect(expression).toContain(`${vectorKey} = :${vectorKey!.slice(1)}`)
      expect(expression).not.toContain(`if_not_exists(${vectorKey}`)
    }).pipe(Effect.provide(makeLayer(capture)))
  })

  it.effect("upsert honours .withVector (B1)", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.upsert({
        productId: "p-1",
        tenantId: "t-1",
        name: "Trail Boot",
        description: "Waterproof hiking boot",
        category: "footwear",
        price: 120,
      }).withVector("byDescription", [0.25, 0.25, 0.25, 0.25])
      const names = capture.updateItem?.ExpressionAttributeNames as Record<string, string>
      const values = capture.updateItem?.ExpressionAttributeValues as Record<string, AttributeValue>
      const vectorKey = Object.keys(names).find((k) => names[k] === VECTOR_ATTR)!
      expect(values[`:${vectorKey.slice(1)}`]).toEqual({
        L: [{ N: "0.25" }, { N: "0.25" }, { N: "0.25" }, { N: "0.25" }],
      })
      // No Embedder in this stack — arriving here proves it was bypassed.
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, makeMockClient(capture)),
          MainTable.layer({ name: "test-table" }),
        ),
      ),
    )
  })

  it.effect("rejects .withVector with an undeclared index name (S5)", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const error = yield* Effect.flip(
        db.entities.Products.put({
          productId: "p-1",
          tenantId: "t-1",
          name: "Trail Boot",
          description: "Waterproof hiking boot",
          category: "footwear",
          price: 120,
        })
          // Typed as the declared-name union, so this is a compile error for the
          // typed accessor; the cast reproduces an erased/dynamic call site.
          .withVector("byDescriptionn" as never, [1, 0, 0, 0])
          .asEffect(),
      )
      expect(error._tag).toBe("ValidationError")
      expect(String((error as { cause: unknown }).cause)).toContain("Unknown vector index")
      expect(capture.putItem).toBeUndefined()
    }).pipe(Effect.provide(makeLayer(capture)))
  })

  it.effect("update re-embeds when remove() clears a source field (S4)", () => {
    const capture: Capture = {}
    setVector("Trail Boot", [0, 0, 0, 1])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      // `remove()` never touches the SET payload, so the payload-only gate used
      // to miss it entirely and leave the old embedding in place.
      yield* db.entities.Products.update({ tenantId: "t-1", productId: "p-1" }).remove([
        "description",
      ])
      const names = capture.updateItem?.ExpressionAttributeNames as Record<string, string>
      const values = capture.updateItem?.ExpressionAttributeValues as Record<string, AttributeValue>
      const vectorKey = Object.keys(names).find((k) => names[k] === VECTOR_ATTR)!
      // Source is now just `name` — the stored `description` was subtracted.
      expect(values[`:${vectorKey.slice(1)}`]).toEqual({
        L: [{ N: "0" }, { N: "0" }, { N: "0" }, { N: "1" }],
      })
    }).pipe(Effect.provide(makeLayer(capture)))
  })

  it.effect("update re-embeds when a path operation targets a source field (S4)", () => {
    const capture: Capture = {}
    setVector("Trail Boot Waterproof hiking boot", [0, 1, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.update({ tenantId: "t-1", productId: "p-1" }).pathSet({
        segments: ["description"],
        value: "Waterproof hiking boot",
        isPath: false,
      })
      const names = capture.updateItem?.ExpressionAttributeNames as Record<string, string>
      expect(Object.values(names)).toContain(VECTOR_ATTR)
    }).pipe(Effect.provide(makeLayer(capture)))
  })

  it.effect("clearing every source field REMOVEs the vector and partition (S4)", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.update({ tenantId: "t-1", productId: "p-1" }).remove([
        "name",
        "description",
      ])
      const names = capture.updateItem?.ExpressionAttributeNames as Record<string, string>
      const expression = capture.updateItem?.UpdateExpression as string
      const removeSection = expression.slice(expression.indexOf("REMOVE"))
      const removedAttrs = Object.entries(names)
        .filter(([key]) => removeSection.includes(key))
        .map(([, attr]) => attr)
      // Sparse semantics: with no source text there is nothing to embed, so the
      // item must leave the index rather than answer to a stale description.
      expect(removedAttrs).toContain(VECTOR_ATTR)
      expect(removedAttrs).toContain(PARTITION_ATTR)
      // …and it must not simultaneously SET the partition back.
      const setSection = expression.slice(0, expression.indexOf("REMOVE"))
      const setAttrs = Object.entries(names)
        .filter(([key]) => setSection.includes(`${key} =`))
        .map(([, attr]) => attr)
      expect(setAttrs).not.toContain(PARTITION_ATTR)
    }).pipe(Effect.provide(makeLayer(capture)))
  })

  it.effect(".withVector on update stores the supplied embedding verbatim", () => {
    const capture: Capture = {}
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      yield* db.entities.Products.update({ tenantId: "t-1", productId: "p-1" })
        .set({ price: 99 })
        .withVector("byDescription", [0, 0, 0.6, 0.8])
      const names = capture.updateItem?.ExpressionAttributeNames as Record<string, string>
      const values = capture.updateItem?.ExpressionAttributeValues as Record<string, AttributeValue>
      const vectorKey = Object.keys(names).find((k) => names[k] === VECTOR_ATTR)!
      expect(values[`:${vectorKey.slice(1)}`]).toEqual({
        L: [{ N: "0" }, { N: "0" }, { N: "0.6" }, { N: "0.8" }],
      })
      // `price` is not a source field, so only the explicit vector could have
      // produced this SET — no Embedder is in the layer stack.
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, makeMockClient(capture)),
          MainTable.layer({ name: "test-table" }),
        ),
      ),
    )
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

  it.effect("rejects a filter on an attribute the index does not declare (S2)", () => {
    const capture: Capture = {}
    setVector("x", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Products },
        tables: { MainTable },
      })
      const error = yield* Effect.flip(
        db.entities.Products.byDescription("x")
          .partition({ tenantId: "t-1" })
          // `price` is a model field but NOT in `filters: ["category"]`, so it
          // is not an INLINE_FILTER attribute on the physical index. The typed
          // accessor rejects this at compile time; the cast reproduces what a
          // dynamically-built filter record would do at runtime.
          .filter({ price: 10 } as never)
          .collect(),
      )
      expect(error._tag).toBe("ValidationError")
      expect(String((error as { cause: unknown }).cause)).toContain("not an INLINE_FILTER")
      // The request must never have been issued.
      expect(capture.searchVectors).toBeUndefined()
    }).pipe(Effect.provide(makeLayer(capture)))
  })

  it.effect("the emulator rejects an undeclared filter the way real DynamoDB does (S2)", () => {
    const capture: Capture = { scanItems: [storedItem("only", "footwear", [1, 0, 0, 0])] }
    return Effect.gen(function* () {
      // Bypass the builder entirely and hand the emulator a raw request with an
      // undeclared filter attribute — the emulator must not silently honour it.
      const client = yield* DynamoClient
      const error = yield* Effect.flip(
        client.searchVectors({
          TableName: "test-table",
          IndexName: "vec1",
          SearchVector: [{ N: "1" }, { N: "0" }, { N: "0" }, { N: "0" }],
          TopK: 10,
          SearchConditionExpression: "#vp = :vp AND #f0 = :f0",
          ExpressionAttributeNames: { "#vp": PARTITION_ATTR, "#f0": "price" },
          ExpressionAttributeValues: {
            ":vp": { S: "$app#v1#product#tenantid_t-1" },
            ":f0": { N: "10" },
          },
        }),
      )
      expect(error._tag).toBe("DynamoValidationError")
    }).pipe(Effect.provide(makeEmulatedLayer(capture)))
  })

  it.effect("exposes terminals immediately when the index declares no partition", () => {
    const capture: Capture = {}
    setVector("anything", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Notes },
        tables: { NoteTable },
      })
      // No `.partition(...)` in the chain — the terminal is reachable directly
      // because the index declares no partition composites. That this compiles
      // at all IS the assertion for the `[Partition] extends [never]` branch.
      yield* db.entities.Notes.byBody("anything").collect()
      // The composed HASH value is still the bare entity prefix, which is what
      // keeps a shared physical index scoped to one entity type even with no
      // user-supplied partition composites.
      expect(
        (capture.searchVectors?.ExpressionAttributeValues as Record<string, AttributeValue>)[":vp"],
      ).toEqual({ S: "$app#v1#note" })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, makeMockClient(capture)),
          NoteTable.layer({ name: "test-table" }),
          FixedEmbedder,
        ),
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// 3b. Shared physical index — the "entity scoping for free" headline claim
// ---------------------------------------------------------------------------

class Note extends Schema.Class<Note>("Note")({
  noteId: Schema.String,
  body: Schema.String,
}) {}

/**
 * `Table.make` re-binds each member entity's table tag, so an entity may only
 * belong to one table per test file. The shared-index fixture therefore uses its
 * own product entity rather than reusing `Products`.
 */
const SharedProducts = Entity.make({
  model: Product,
  entityType: "sproduct",
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

/** Second entity type sharing physical index `vec1` with `SharedProducts`. */
class Article extends Schema.Class<Article>("Article")({
  articleId: Schema.String,
  tenantId: Schema.String,
  headline: Schema.String,
  topic: Schema.String,
}) {}

const Articles = Entity.make({
  model: Article,
  entityType: "article",
  primaryKey: {
    pk: { field: "pk", composite: ["tenantId", "articleId"] },
    sk: { field: "sk", composite: [] },
  },
  vectorIndexes: {
    byHeadline: {
      name: "vec1",
      dimensions: DIMENSIONS,
      distance: "cosine",
      source: { fields: ["headline"] },
      partition: ["tenantId"],
      // Deliberately a DIFFERENT filter attribute than Products declares —
      // the merged SearchSchema must carry the union (S3).
      filters: ["topic"],
    },
  },
})

const SharedTable = Table.make({ schema: AppSchema, entities: { SharedProducts, Articles } })

/** Partition-less vector index — used to prove terminals appear immediately. */
const Notes = Entity.make({
  model: Note,
  entityType: "note",
  primaryKey: {
    pk: { field: "pk", composite: ["noteId"] },
    sk: { field: "sk", composite: [] },
  },
  vectorIndexes: {
    byBody: { name: "vecn", dimensions: DIMENSIONS, source: { fields: ["body"] } },
  },
})

const NoteTable = Table.make({ schema: AppSchema, entities: { Notes } })

const sharedProductItem = (
  productId: string,
  vector: ReadonlyArray<number>,
  tenantId = "t-1",
): Record<string, AttributeValue> => ({
  pk: { S: `$app#v1#sproduct#tenantid_${tenantId}#productid_${productId}` },
  sk: { S: "$app#v1#sproduct" },
  productId: { S: productId },
  tenantId: { S: tenantId },
  name: { S: productId },
  description: { S: `${productId} description` },
  category: { S: "footwear" },
  price: { N: "10" },
  __edd_e__: { S: "sproduct" },
  [VECTOR_ATTR]: { L: vector.map((n) => ({ N: String(n) })) },
  [PARTITION_ATTR]: { S: `$app#v1#sproduct#tenantid_${tenantId}` },
})

const sharedArticleItem = (
  articleId: string,
  vector: ReadonlyArray<number>,
  tenantId = "t-1",
): Record<string, AttributeValue> => ({
  pk: { S: `$app#v1#article#tenantid_${tenantId}#articleid_${articleId}` },
  sk: { S: "$app#v1#article" },
  articleId: { S: articleId },
  tenantId: { S: tenantId },
  headline: { S: articleId },
  topic: { S: "news" },
  __edd_e__: { S: "article" },
  [VECTOR_ATTR]: { L: vector.map((n) => ({ N: String(n) })) },
  [PARTITION_ATTR]: { S: `$app#v1#article#tenantid_${tenantId}` },
})

// ---------------------------------------------------------------------------
// 3c. Renamed fields (`DynamoModel.configure({ field })`)
// ---------------------------------------------------------------------------

class Gadget extends Schema.Class<Gadget>("Gadget")({
  gadgetId: Schema.String,
  blurb: Schema.String,
  kind: Schema.String,
}) {}

/** Both the source field and the filter attribute are stored under short names. */
const GadgetModel = DynamoModel.configure(Gadget, {
  blurb: { field: "b" },
  kind: { field: "k" },
})

const Gadgets = Entity.make({
  model: GadgetModel,
  entityType: "gadget",
  primaryKey: {
    pk: { field: "pk", composite: ["gadgetId"] },
    sk: { field: "sk", composite: [] },
  },
  vectorIndexes: {
    byBlurb: {
      name: "vecg",
      dimensions: DIMENSIONS,
      source: { fields: ["blurb"] },
      filters: ["kind"],
    },
  },
})

const GadgetTable = Table.make({ schema: AppSchema, entities: { Gadgets } })

describe("vector search with renamed (storedAs) fields", () => {
  it("emits SearchSchema INLINE_FILTER entries under the STORED attribute name (S7)", () => {
    const definition = Table.definition(GadgetTable as unknown as Table.Table)
    expect(definition.VectorIndexes?.[0]?.SearchSchema).toEqual([
      { AttributeName: "__edd_vp_vecg__", SearchSchemaElementType: "HASH" },
      // `k`, not `kind` — items are written after renameToDynamo.
      { AttributeName: "k", SearchSchemaElementType: "INLINE_FILTER" },
    ])
  })

  it.effect("filters and projects under STORED names, returning DOMAIN names (S7)", () => {
    const capture: Capture = {
      scanItems: [
        {
          pk: { S: "$app#v1#gadget#gadgetid_g-1" },
          sk: { S: "$app#v1#gadget" },
          gadgetId: { S: "g-1" },
          b: { S: "a widget" },
          k: { S: "tool" },
          __edd_e__: { S: "gadget" },
          __edd_v_vecg__: { L: [{ N: "1" }, { N: "0" }, { N: "0" }, { N: "0" }] },
          __edd_vp_vecg__: { S: "$app#v1#gadget" },
        },
      ],
    }
    setVector("a widget", [1, 0, 0, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Gadgets },
        tables: { GadgetTable },
      })
      const hits = yield* db.entities.Gadgets.byBlurb("a widget")
        .filter({ kind: "tool" })
        .select(["gadgetId", "blurb"])
        .collect()
      // The filter matched despite `kind` living on disk as `k`…
      expect(hits).toHaveLength(1)
      // …and the projected result comes back under DOMAIN names.
      expect(hits[0]!.item).toEqual({ gadgetId: "g-1", blurb: "a widget" })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          VectorSearchEmulation.layer(Layer.succeed(DynamoClient, makeMockClient(capture)), {
            tables: { GadgetTable },
          }),
          GadgetTable.layer({ name: "test-table" }),
          FixedEmbedder,
        ),
      ),
    )
  })

  it.effect("writes the embedding derived from the renamed source field (S7)", () => {
    const capture: Capture = {}
    setVector("a widget", [0, 0, 1, 0])
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Gadgets },
        tables: { GadgetTable },
      })
      yield* db.entities.Gadgets.put({ gadgetId: "g-1", blurb: "a widget", kind: "tool" })
      const item = capture.putItem?.Item as Record<string, AttributeValue>
      expect(item.__edd_v_vecg__).toEqual({
        L: [{ N: "0" }, { N: "0" }, { N: "1" }, { N: "0" }],
      })
      expect(item.b).toEqual({ S: "a widget" })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, makeMockClient(capture)),
          GadgetTable.layer({ name: "test-table" }),
          FixedEmbedder,
        ),
      ),
    )
  })
})

describe("shared physical vector index", () => {
  it("unions filters from every sharer into one SearchSchema (S3)", () => {
    const definition = Table.definition(SharedTable as unknown as Table.Table)
    expect(definition.VectorIndexes).toEqual([
      {
        IndexName: "vec1",
        VectorAttribute: { AttributeName: VECTOR_ATTR },
        Dimensions: DIMENSIONS,
        DistanceFunction: "COSINE",
        Projection: { ProjectionType: "ALL" },
        SearchSchema: [
          { AttributeName: PARTITION_ATTR, SearchSchemaElementType: "HASH" },
          // Products' filter…
          { AttributeName: "category", SearchSchemaElementType: "INLINE_FILTER" },
          // …plus Articles', which the first-declarer-wins merge used to drop.
          { AttributeName: "topic", SearchSchemaElementType: "INLINE_FILTER" },
        ],
      },
    ])
  })

  it.effect("scopes searches to one entity type without any user-supplied filter", () => {
    const capture: Capture = {
      scanItems: [
        // Both entity types live in the same physical index with identical
        // embeddings — only the composed partition value tells them apart.
        sharedProductItem("prod", [1, 0, 0, 0]),
        sharedArticleItem("art", [1, 0, 0, 0]),
      ],
    }
    setVector("boots", [1, 0, 0, 0])
    const layer = Layer.mergeAll(
      VectorSearchEmulation.layer(Layer.succeed(DynamoClient, makeMockClient(capture)), {
        tables: { SharedTable },
      }),
      SharedTable.layer({ name: "test-table" }),
      FixedEmbedder,
    )
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { SharedProducts, Articles },
        tables: { SharedTable },
      })
      const products = yield* db.entities.SharedProducts.byDescription("boots")
        .partition({ tenantId: "t-1" })
        .collect()
      expect(products.map((h) => h.item.productId)).toEqual(["prod"])

      const articles = yield* db.entities.Articles.byHeadline("boots")
        .partition({ tenantId: "t-1" })
        .collect()
      expect(articles.map((h) => h.item.articleId)).toEqual(["art"])
    }).pipe(Effect.provide(layer))
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

  // The live service rejects CreateTable when a SearchSchema element is absent
  // from AttributeDefinitions ("One element in SearchSchema is not defined in
  // attribute definitions") — DynamoDB Local silently accepts it, so this is
  // pinned at the definition level.
  it("declares every SearchSchema element in AttributeDefinitions", () => {
    const definition = Table.definition(MainTable as unknown as Table.Table)
    expect(definition.AttributeDefinitions).toEqual(
      expect.arrayContaining([
        { AttributeName: PARTITION_ATTR, AttributeType: "S" },
        { AttributeName: "category", AttributeType: "S" },
      ]),
    )
  })

  it("types numeric filter fields as N in AttributeDefinitions", () => {
    const Priced = Entity.make({
      model: Product,
      entityType: "priced",
      primaryKey: {
        pk: { field: "pk", composite: ["productId"] },
        sk: { field: "sk", composite: [] },
      },
      vectorIndexes: {
        byDescription: {
          name: "vecp",
          dimensions: DIMENSIONS,
          source: { fields: ["description"] },
          filters: ["price", "category"],
        },
      },
    })
    const PricedTable = Table.make({ schema: AppSchema, entities: { Priced } })
    const definition = Table.definition(PricedTable as unknown as Table.Table)
    expect(definition.AttributeDefinitions).toEqual(
      expect.arrayContaining([
        { AttributeName: "__edd_vp_vecp__", AttributeType: "S" },
        { AttributeName: "price", AttributeType: "N" },
        { AttributeName: "category", AttributeType: "S" },
      ]),
    )
  })

  it("rejects filter fields that don't encode to string or number (EDD-9039)", () => {
    class Flagged extends Schema.Class<Flagged>("Flagged")({
      id: Schema.String,
      body: Schema.String,
      active: Schema.Boolean,
    }) {}
    expect(() =>
      Entity.make({
        model: Flagged,
        entityType: "flagged",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        vectorIndexes: {
          byBody: {
            name: "vecf",
            dimensions: DIMENSIONS,
            source: { fields: ["body"] },
            filters: ["active"],
          },
        },
      }),
    ).toThrow("[EDD-9039]")
  })

  it("rejects sharers declaring one stored filter attribute with two types (EDD-9040)", () => {
    class Coded extends Schema.Class<Coded>("Coded")({
      id: Schema.String,
      body: Schema.String,
      code: Schema.Number,
    }) {}
    const vectorIndex = (filters: ReadonlyArray<"code">) => ({
      byBody: {
        name: "vecc",
        dimensions: DIMENSIONS,
        source: { fields: ["body"] as const },
        filters,
      },
    })
    class CodedStr extends Schema.Class<CodedStr>("CodedStr")({
      id: Schema.String,
      body: Schema.String,
      code: Schema.String,
    }) {}
    const A = Entity.make({
      model: Coded,
      entityType: "coded-n",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      vectorIndexes: vectorIndex(["code"]),
    })
    const B = Entity.make({
      model: CodedStr,
      entityType: "coded-s",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      vectorIndexes: vectorIndex(["code"]),
    })
    expect(() => Table.make({ schema: AppSchema, entities: { A, B } })).toThrow("[EDD-9040]")
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

  it.effect("rejects a vector index whose name collides with another accessor (N4)", () => {
    // `byOwner` is both a GSI query accessor and a vector index name — binding
    // both would silently replace one with the other.
    const Colliding = Entity.make({
      model: Product,
      entityType: "colliding",
      primaryKey: {
        pk: { field: "pk", composite: ["productId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byOwner: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["tenantId"] },
          sk: { field: "gsi1sk", composite: [] },
        },
      },
      vectorIndexes: {
        byOwner: { name: "vecc", dimensions: DIMENSIONS, source: { fields: ["description"] } },
      },
    })
    const CollidingTable = Table.make({ schema: AppSchema, entities: { Colliding } })
    return Effect.gen(function* () {
      const message = yield* Effect.gen(function* () {
        yield* DynamoClient.make({
          entities: { Colliding },
          tables: { CollidingTable },
        })
        return "no failure"
      }).pipe(Effect.catchDefect((defect) => Effect.succeed(String(defect))))
      expect(message).toContain("EDD-9038")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(DynamoClient, makeMockClient({})),
          CollidingTable.layer({ name: "test-table" }),
        ),
      ),
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
