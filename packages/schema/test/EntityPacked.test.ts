/**
 * Packed entity fields (`storedAs: DynamoModel.Packed`) — the definition-time
 * guards of the pure `Entity.make` (shared with the runtime one through
 * `buildEntityDefinition`): EDD-9072 (key / index source), EDD-9073 (shape,
 * missing field, dates — so never a TTL attribute), EDD-9074 (unique), EDD-9075
 * (ref), and the derived storage plan (packed / dispatch attributes, renames).
 */
import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"

class Line extends Schema.Class<Line>("Line")({ sku: Schema.String, qty: Schema.Number }) {}

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  status: Schema.String,
  placedAt: Schema.String,
  lines: Schema.Array(Line),
  details: Schema.Struct({ note: Schema.String, total: Schema.Number }),
  extra: Schema.optional(Schema.Unknown),
  tags: Schema.Record(Schema.String, Schema.Number),
  amount: Schema.Number,
  stamp: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromMillis,
  bytes: Schema.Uint8ArrayFromBase64,
  mixed: Schema.Union([Schema.Struct({ a: Schema.String }), Schema.String]),
  maybeLines: Schema.optional(Schema.NullOr(Schema.Array(Line))),
}) {}

const json = DynamoModel.Packed({ format: "json" })
const zstd = DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } })

const primaryKey = {
  pk: { field: "pk", composite: ["orderId"] },
  sk: { field: "sk", composite: [] },
} as const

const make = (
  attrs: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Entity.EntityDefinition =>
  Entity.make({
    // The guards are what is under test: the attribute map is built
    // dynamically, including shapes the configure() types would refuse.
    model: DynamoModel.configure(Order, attrs as never),
    entityType: "Order",
    primaryKey,
    ...extra,
  } as never) as unknown as Entity.EntityDefinition

describe("Entity.make — packed fields", () => {
  it("accepts object, array, record, unknown and optional/nullable array fields", () => {
    const def = make({
      lines: { storedAs: json },
      details: { storedAs: zstd },
      tags: { storedAs: json },
      extra: { storedAs: json },
      maybeLines: { storedAs: json },
    })
    expect(Object.keys(def._data.packedFields).sort()).toEqual([
      "details",
      "extra",
      "lines",
      "maybeLines",
      "tags",
    ])
    expect(def._data.hasPackedFields).toBe(true)
    expect(def._data.packedAttributes.details).toBe(zstd)
    expect([...def._packedFields].sort()).toEqual([
      "details",
      "extra",
      "lines",
      "maybeLines",
      "tags",
    ])
  })

  it("stores a renamed packed field under its stored name", () => {
    const def = make({ details: { field: "d", storedAs: zstd } })
    expect(def._data.packedFields.details).toBe(zstd)
    expect(def._data.packedAttributes).toEqual({ d: zstd })
    expect(def._data.dispatchAttributes).toContain("d")
    expect(def._data.dispatchAttributes).not.toContain("details")
  })

  it("dispatches on object/array fields even when they are not packed (packed → native rollback)", () => {
    const def = make({})
    expect(def._data.hasPackedFields).toBe(false)
    const dispatch = new Set(def._data.dispatchAttributes)
    // Structured: a native value is never S or B.
    for (const field of ["lines", "details", "tags", "maybeLines"]) {
      expect(dispatch.has(field)).toBe(true)
    }
    // Scalars, dates, binary, mixed unions and opaque Unknown are not.
    for (const field of ["orderId", "status", "amount", "stamp", "bytes", "mixed", "extra"]) {
      expect(dispatch.has(field)).toBe(false)
    }
  })

  it("does not dispatch on a sparse-map field", () => {
    const def = make({ tags: { storedAs: DynamoModel.SparseMap() } })
    expect(def._data.dispatchAttributes).not.toContain("tags")
  })

  describe("EDD-9073 — shape", () => {
    it.each([
      ["status", /a string/],
      ["amount", /a number/],
      ["stamp", /not object- or array-shaped/],
      ["expiresAt", /not object- or array-shaped/],
      ["bytes", /not object- or array-shaped/],
      ["mixed", /a member of its union is not packable/],
    ])("refuses %s", (field, reason) => {
      const thunk = () => make({ [field]: { storedAs: json } })
      expect(thunk).toThrow(/\[EDD-9073\]/)
      expect(thunk).toThrow(reason)
      expect(thunk).toThrow(`packed field "${field}"`)
    })

    it("refuses a packed field that is not on the model", () => {
      expect(() =>
        Entity.make({
          model: {
            ...DynamoModel.configure(Order, {}),
            attributes: { nope: { packed: json } },
          } as never,
          entityType: "Order",
          primaryKey,
        }),
      ).toThrow(/\[EDD-9073\].*"nope" does not exist on the model/)
    })

    it("refuses a date used as a TTL-style epoch attribute", () => {
      expect(() => make({ expiresAt: { storedAs: zstd } })).toThrow(/\[EDD-9073\]/)
    })
  })

  describe("EDD-9072 — key and index sources", () => {
    it("refuses a primary-key composite", () => {
      expect(() =>
        Entity.make({
          model: DynamoModel.configure(Order, { details: { storedAs: json } }),
          entityType: "Order",
          primaryKey: {
            pk: { field: "pk", composite: ["orderId"] },
            sk: { field: "sk", composite: ["details"] },
          },
        }),
      ).toThrow(/\[EDD-9072\].*"details" cannot be a composite of the primary key/)
    })

    it("refuses a GSI pk or sk composite", () => {
      const index = (pk: string, sk: string) => ({
        byX: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: [pk] },
          sk: { field: "gsi1sk", composite: [sk] },
        },
      })
      expect(() =>
        make({ lines: { storedAs: json } }, { indexes: index("lines", "status") }),
      ).toThrow(/\[EDD-9072\].*"lines" cannot be a composite of index "byX"/)
      expect(() =>
        make({ lines: { storedAs: json } }, { indexes: index("status", "lines") }),
      ).toThrow(/\[EDD-9072\]/)
    })

    it("refuses timeSeries.orderBy", () => {
      expect(() =>
        make(
          { details: { storedAs: json } },
          {
            timeSeries: {
              orderBy: "details",
              appendInput: Schema.Struct({ orderId: Schema.String, details: Order.fields.details }),
            },
          },
        ),
      ).toThrow(/\[EDD-9072\].*timeSeries\.orderBy/)
    })

    it("refuses a vector index filter or partition field", () => {
      const vector = (key: "filters" | "partition") => ({
        vectorIndexes: {
          similar: {
            index: "vec",
            dimensions: 3,
            source: { fields: ["status"] },
            [key]: ["details"],
          },
        },
      })
      expect(() => make({ details: { storedAs: json } }, vector("filters"))).toThrow(
        /\[EDD-9072\].*filter field of vector index "similar"/,
      )
      expect(() => make({ details: { storedAs: json } }, vector("partition"))).toThrow(
        /\[EDD-9072\].*partition composite of vector index "similar"/,
      )
    })

    it("refuses an index injected later (collection-owned) whose composite is packed", () => {
      const def = make({ lines: { storedAs: json } })
      expect(() =>
        def._injectIndex("coll", {
          index: "gsi9",
          pk: { field: "gsi9pk", composite: ["lines"] },
          sk: { field: "gsi9sk", composite: [] },
        }),
      ).toThrow(/\[EDD-9072\].*"lines" cannot be a composite of index "coll"/)
      // A clean injection still works.
      def._injectIndex("ok", {
        index: "gsi8",
        pk: { field: "gsi8pk", composite: ["status"] },
        sk: { field: "gsi8sk", composite: [] },
      })
      expect(def.indexes.ok).toBeDefined()
    })
  })

  it("EDD-9074 — refuses a unique-constraint field", () => {
    expect(() =>
      make({ details: { storedAs: json } }, { unique: { byDetails: ["details"] } }),
    ).toThrow(/\[EDD-9074\].*unique constraint "byDetails"/)
  })

  it("EDD-9075 — refuses a ref field", () => {
    expect(() => make({ details: { storedAs: json, ref: true } })).toThrow(/\[EDD-9075\]/)
  })

  it("carries the packed field names at the type level", () => {
    const Packed = Entity.make({
      model: DynamoModel.configure(Order, {
        lines: { storedAs: json },
        details: { storedAs: zstd },
      }),
      entityType: "Order",
      primaryKey,
    })
    expectTypeOf(Packed._packedFields).toEqualTypeOf<ReadonlyArray<"lines" | "details">>()
    const Plain = Entity.make({ model: Order, entityType: "Order", primaryKey })
    expectTypeOf(Plain._packedFields).toEqualTypeOf<ReadonlyArray<never>>()
  })
})
