import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"
import { Embedder, makeTestEmbedder } from "../src/Embedder.js"
import * as Entity from "../src/Entity.js"
import * as KeyComposer from "../src/KeyComposer.js"
import * as VectorIndex from "../src/VectorIndex.js"

const Product = Schema.Struct({
  productId: Schema.String,
  tenantId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  category: Schema.String,
  price: Schema.Number,
})

const makeProducts = (vectorIndexes: Record<string, VectorIndex.VectorIndexConfig>) =>
  Entity.make({
    model: Product,
    entityType: "product",
    primaryKey: {
      pk: { field: "pk", composite: ["productId"] },
      sk: { field: "sk", composite: [] },
    },
    vectorIndexes,
  })

describe("VectorIndex", () => {
  describe("attribute naming", () => {
    it("uses the __edd_ convention so user fields cannot collide", () => {
      expect(VectorIndex.vectorAttributeName("vec1")).toBe("__edd_v_vec1__")
      expect(VectorIndex.vectorPartitionAttributeName("vec1")).toBe("__edd_vp_vec1__")
      expect(VectorIndex.vectorStashAttributeName("vec1")).toBe("__edd_vs_vec1__")
    })
  })

  describe("normalizeVectorIndexConfig", () => {
    it("defaults distance to cosine and fills the managed attribute names", () => {
      const def = VectorIndex.normalizeVectorIndexConfig({
        name: "vec1",
        dimensions: 8,
        source: { fields: ["description"] },
      })
      expect(def.distance).toBe("cosine")
      expect(def.partition).toEqual([])
      expect(def.filters).toEqual([])
      expect(def.vectorField).toBe("__edd_v_vec1__")
      expect(def.partitionField).toBe("__edd_vp_vec1__")
    })

    it("preserves an explicit distance function", () => {
      const def = VectorIndex.normalizeVectorIndexConfig({
        name: "vec1",
        dimensions: 8,
        distance: "dotProduct",
        source: { fields: ["description"] },
      })
      expect(def.distance).toBe("dotProduct")
    })
  })

  describe("toWireDistanceFunction", () => {
    it("maps every distance function to its DynamoDB enum value", () => {
      expect(VectorIndex.toWireDistanceFunction("cosine")).toBe("COSINE")
      expect(VectorIndex.toWireDistanceFunction("euclidean")).toBe("EUCLIDEAN")
      expect(VectorIndex.toWireDistanceFunction("dotProduct")).toBe("DOT_PRODUCT")
    })
  })

  describe("toSimilarity", () => {
    it("normalizes cosine (0..2, lower closer) to 0..1 higher-closer", () => {
      expect(VectorIndex.toSimilarity(0, "cosine")).toBe(1)
      expect(VectorIndex.toSimilarity(1, "cosine")).toBe(0.5)
      expect(VectorIndex.toSimilarity(2, "cosine")).toBe(0)
    })

    it("normalizes euclidean (0..inf, lower closer) to 0..1 higher-closer", () => {
      expect(VectorIndex.toSimilarity(0, "euclidean")).toBe(1)
      expect(VectorIndex.toSimilarity(1, "euclidean")).toBe(0.5)
      expect(VectorIndex.toSimilarity(9, "euclidean")).toBeCloseTo(0.1, 10)
    })

    it("passes dotProduct through — it is already higher-is-more-similar", () => {
      expect(VectorIndex.toSimilarity(10, "dotProduct")).toBe(10)
      expect(VectorIndex.toSimilarity(-1, "dotProduct")).toBe(-1)
    })

    it("flips lower-is-closer wire scores and passes higher-is-closer through", () => {
      // Raw scores for query [1,0,0,0] against the documented stored vectors
      // [1,0,0,0], [10,0,0,0], [0.7071,0.7071,0,0], [-1,0,0,0].
      const raw = {
        cosine: [0.0, 0.0, 0.29, 2.0],
        euclidean: [0.0, 9.0, 0.77, 2.0],
        dotProduct: [1.0, 10.0, 0.71, -1.0],
      } as const
      for (const distance of VectorIndex.distanceFunctions) {
        const normalized = raw[distance].map((s) => VectorIndex.toSimilarity(s, distance))
        const byRaw = raw[distance]
          .map((score, i) => ({ score, similarity: normalized[i]! }))
          .sort((a, b) => a.score - b.score)
        // Sorting by raw score must produce a monotonic run of similarities —
        // descending for the lower-is-closer functions, ascending for dot product.
        for (let i = 1; i < byRaw.length; i++) {
          if (distance === "dotProduct") {
            expect(byRaw[i]!.similarity).toBeGreaterThanOrEqual(byRaw[i - 1]!.similarity)
          } else {
            expect(byRaw[i]!.similarity).toBeLessThanOrEqual(byRaw[i - 1]!.similarity)
          }
        }
      }
    })
  })

  describe("clampTopK", () => {
    it("clamps into 1..100 and floors fractional values", () => {
      expect(VectorIndex.clampTopK(0)).toBe(1)
      expect(VectorIndex.clampTopK(-5)).toBe(1)
      expect(VectorIndex.clampTopK(25.9)).toBe(25)
      expect(VectorIndex.clampTopK(1000)).toBe(100)
    })
  })

  describe("deriveSourceText", () => {
    const def = VectorIndex.normalizeVectorIndexConfig({
      name: "vec1",
      dimensions: 8,
      source: { fields: ["name", "description"] },
    })

    it("joins source field values in declaration order", () => {
      expect(VectorIndex.deriveSourceText(def, { name: "Boot", description: "Waterproof" })).toBe(
        "Boot Waterproof",
      )
    })

    it("skips absent fields", () => {
      expect(VectorIndex.deriveSourceText(def, { description: "Waterproof" })).toBe("Waterproof")
    })

    it("returns undefined when no source field carries a value", () => {
      expect(VectorIndex.deriveSourceText(def, { price: 10 })).toBeUndefined()
    })

    it("honours a custom compose function", () => {
      const custom = VectorIndex.normalizeVectorIndexConfig({
        name: "vec1",
        dimensions: 8,
        source: {
          fields: ["name", "description"],
          compose: (picked) => `${picked.name ?? ""}|${picked.description ?? ""}`,
        },
      })
      expect(VectorIndex.deriveSourceText(custom, { name: "Boot", description: "Dry" })).toBe(
        "Boot|Dry",
      )
    })
  })

  describe("touchesSource", () => {
    const def = VectorIndex.normalizeVectorIndexConfig({
      name: "vec1",
      dimensions: 8,
      source: { fields: ["name", "description"] },
    })

    it("fires on membership, not value — an explicit undefined still counts", () => {
      expect(VectorIndex.touchesSource(def, { description: undefined })).toBe(true)
    })

    it("does not fire when the payload names no source field", () => {
      expect(VectorIndex.touchesSource(def, { price: 42 })).toBe(false)
    })
  })

  describe("validation at Entity.make", () => {
    it("accepts a well-formed declaration", () => {
      const Products = makeProducts({
        byDescription: {
          name: "vec1",
          dimensions: 8,
          source: { fields: ["name", "description"] },
          partition: ["tenantId"],
          filters: ["category"],
        },
      })
      expect(Products._data.hasVectorIndexes).toBe(true)
      expect(Products._data.vectorIndexes.byDescription?.index).toBe("vec1")
    })

    it("rejects out-of-range dimensions (EDD-9030)", () => {
      expect(() =>
        makeProducts({
          byDescription: { name: "vec1", dimensions: 0, source: { fields: ["description"] } },
        }),
      ).toThrow("[EDD-9030]")
      expect(() =>
        makeProducts({
          byDescription: { name: "vec1", dimensions: 5000, source: { fields: ["description"] } },
        }),
      ).toThrow("[EDD-9030]")
    })

    it("rejects an empty source.fields (EDD-9031)", () => {
      expect(() =>
        makeProducts({
          byDescription: { name: "vec1", dimensions: 8, source: { fields: [] } },
        }),
      ).toThrow("[EDD-9031]")
    })

    it("rejects unknown source / partition / filter fields (EDD-9031)", () => {
      expect(() =>
        makeProducts({
          byDescription: { name: "vec1", dimensions: 8, source: { fields: ["nope"] } },
        }),
      ).toThrow("[EDD-9031]")
      expect(() =>
        makeProducts({
          byDescription: {
            name: "vec1",
            dimensions: 8,
            source: { fields: ["description"] },
            partition: ["nope"],
          },
        }),
      ).toThrow("[EDD-9031]")
      expect(() =>
        makeProducts({
          byDescription: {
            name: "vec1",
            dimensions: 8,
            source: { fields: ["description"] },
            filters: ["nope"],
          },
        }),
      ).toThrow("[EDD-9031]")
    })

    it("rejects more than 18 inline filters (EDD-9032)", () => {
      const wide = Schema.Struct({
        id: Schema.String,
        description: Schema.String,
        ...Object.fromEntries(
          Array.from({ length: 19 }, (_, i) => [`f${i}`, Schema.String] as const),
        ),
      })
      expect(() =>
        Entity.make({
          model: wide,
          entityType: "wide",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          vectorIndexes: {
            byDescription: {
              name: "vec1",
              dimensions: 8,
              source: { fields: ["description"] },
              filters: Array.from({ length: 19 }, (_, i) => `f${i}`),
            },
          },
        }),
      ).toThrow("[EDD-9032]")
    })

    it("rejects two logical indexes bound to the same physical index (EDD-9033)", () => {
      expect(() =>
        makeProducts({
          a: { name: "vec1", dimensions: 8, source: { fields: ["description"] } },
          b: { name: "vec1", dimensions: 8, source: { fields: ["name"] } },
        }),
      ).toThrow("[EDD-9033]")
    })
  })
})

describe("KeyComposer vector partition composition", () => {
  const schema = DynamoSchema.make({ name: "myapp", version: 1 })

  it("composes the bare entity prefix when no partition composites are declared", () => {
    const value = KeyComposer.composeVectorPartition(schema, "product", { partition: [] }, {})
    expect(value).toBe("$myapp#v1#product")
  })

  it("appends partition composites using the standard naming + casing rules", () => {
    const value = KeyComposer.composeVectorPartition(
      schema,
      "Product",
      { partition: ["tenantId"] },
      { tenantId: "Acme" },
    )
    expect(value).toBe("$myapp#v1#product#tenantid_acme")
  })

  it("honours a per-index casing override", () => {
    const value = KeyComposer.composeVectorPartition(
      schema,
      "Product",
      { partition: ["tenantId"], casing: "preserve" },
      { tenantId: "Acme" },
    )
    expect(value).toBe("$myapp#v1#Product#tenantId_Acme")
  })

  it("returns undefined from the try variant when a composite is missing (sparse)", () => {
    expect(
      KeyComposer.tryComposeVectorPartition(schema, "product", { partition: ["tenantId"] }, {}),
    ).toBeUndefined()
  })

  it("still composes from the try variant when every composite is present", () => {
    expect(
      KeyComposer.tryComposeVectorPartition(
        schema,
        "product",
        { partition: ["tenantId"] },
        { tenantId: "t-1" },
      ),
    ).toBe("$myapp#v1#product#tenantid_t-1")
  })
})

describe("Embedder", () => {
  it("layerTest produces deterministic unit vectors of the declared dimensionality", async () => {
    const embedder = makeTestEmbedder(16)
    const a = await Effect.runPromise(embedder.embed("waterproof hiking boots"))
    const b = await Effect.runPromise(embedder.embed("waterproof hiking boots"))
    expect(a).toEqual(b)
    expect(a).toHaveLength(16)
    const magnitude = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0))
    expect(magnitude).toBeCloseTo(1, 10)
  })

  it("produces different vectors for different text", async () => {
    const embedder = makeTestEmbedder(16)
    const a = await Effect.runPromise(embedder.embed("hiking boots"))
    const b = await Effect.runPromise(embedder.embed("espresso machine"))
    expect(a).not.toEqual(b)
  })

  it("returns a defined unit vector for unhashable text", async () => {
    const embedder = makeTestEmbedder(4)
    const v = await Effect.runPromise(embedder.embed("!!!"))
    expect(v).toEqual([1, 0, 0, 0])
  })

  it("exposes the declared dimensionality through the service tag", async () => {
    const program = Effect.gen(function* () {
      const embedder = yield* Embedder
      return embedder.dimensions
    })
    const dimensions = await Effect.runPromise(
      program.pipe(Effect.provide(Embedder.layerTest({ dimensions: 32 }))),
    )
    expect(dimensions).toBe(32)
  })
})
