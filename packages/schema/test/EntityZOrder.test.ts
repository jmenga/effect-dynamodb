/**
 * Z-order sort keys at `Entity.make` (#171): binding a declared half to the
 * model — storage resolution (EDD-9088), the bit budget (EDD-9089), the
 * placement rules (EDD-9086 primary key, EDD-9090 collections, including
 * `_injectIndex`) — and the existing composite checks (EDD-9002, 9025, 9072,
 * 9022), which read the derived `composite` and so cover prefix composites and
 * dimensions.
 */
import { DateTime, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import type { DimensionStorage } from "../src/internal/ZOrderCurve.js"
import * as KeyComposer from "../src/KeyComposer.js"
import * as ZOrder from "../src/ZOrder.js"

const schema = DynamoSchema.make({ name: "myapp", version: 1 })

const byId = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

/** Make an entity over `fields` (plus `id`) with one Z-order index. */
const withZOrder = (
  fields: Schema.Struct.Fields,
  sk: {
    readonly prefix?: ReadonlyArray<ZOrder.PrefixPart>
    readonly zorder: ReadonlyArray<ZOrder.Dimension>
  },
  options?: { readonly collection?: string },
) =>
  Entity.make({
    model: Schema.Struct({ id: Schema.String, region: Schema.String, ...fields }),
    entityType: "Listing",
    primaryKey: byId,
    indexes: {
      search: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["region"] },
        sk: { field: "gsi2sk", ...sk } as KeyComposer.ZOrderKeyPart,
        ...(options?.collection !== undefined && { collection: options.collection }),
      },
    },
  })

const layoutOf = (entity: { readonly indexes: Record<string, KeyComposer.IndexDefinition> }) => {
  const half = entity.indexes.search!.sk as KeyComposer.ZOrderSkPart
  expect(half.zorderHalf.layout).toBeDefined()
  return half.zorderHalf.layout!
}

const storagesOf = (entity: {
  readonly indexes: Record<string, KeyComposer.IndexDefinition>
}): ReadonlyArray<DimensionStorage> => layoutOf(entity).dimensions.map((d) => d.storage)

describe("Entity.make — Z-order sort keys (#171)", () => {
  describe("binding", () => {
    const Listings = Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        region: Schema.String,
        agencyId: Schema.String,
        price: Schema.Number,
        bedrooms: Schema.Number,
        listedAt: DynamoModel.DateString,
      }),
      entityType: "Listing",
      primaryKey: byId,
      indexes: {
        search: {
          name: "gsi2",
          pk: { field: "gsi2pk", composite: ["region"] },
          sk: {
            field: "gsi2sk",
            prefix: ["agencyId"],
            zorder: [
              ZOrder.int("price", { min: 0, max: 5_000_000, step: 1_000 }),
              ZOrder.int("bedrooms", { min: 0, max: 15 }),
              ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "hours", bits: 16 }),
            ],
          },
        },
      },
    })

    it("lays the address out in declaration order, MSB-aligned", () => {
      const layout = layoutOf(Listings)
      expect(layout.bits).toBe(13 + 4 + 16)
      expect(layout.bytes).toBe(5)
      expect(layout.dimensions.map((d) => d.field)).toEqual(["price", "bedrooms", "listedAt"])
      expect(layout.order.slice(0, 3)).toEqual([
        { dim: 0, bit: 12 },
        { dim: 1, bit: 3 },
        { dim: 2, bit: 15 },
      ])
    })

    it("derives composite = prefix composites, then dimensions (value and type)", () => {
      expect(Listings.indexes.search.sk.composite).toEqual([
        "agencyId",
        "price",
        "bedrooms",
        "listedAt",
      ])
      type Composite = typeof Listings.indexes.search.sk.composite
      expectTypeOf<Composite["length"]>().toEqualTypeOf<4>()
      expectTypeOf<Composite[0]>().toEqualTypeOf<"agencyId">()
      expectTypeOf<Composite[1]>().toEqualTypeOf<"price">()
      expectTypeOf<Composite[3]>().toEqualTypeOf<"listedAt">()
    })

    it("keeps the declared Dimension values, so one declaration can serve several entities", () => {
      const half = Listings.indexes.search.sk as KeyComposer.ZOrderSkPart
      expect(half.zorderHalf.dimensions.every((d) => ZOrder.isDimension(d))).toBe(true)
    })
  })

  describe("storage resolution", () => {
    it.each<[string, Schema.Top, DimensionStorage]>([
      ["Schema.Number", Schema.Number, { _tag: "Number", numeric: "number" }],
      ["Schema.Int", Schema.Int, { _tag: "Number", numeric: "number" }],
      ["Schema.BigInt", Schema.BigInt, { _tag: "Number", numeric: "bigint" }],
      [
        "Schema.NumberFromString",
        Schema.NumberFromString,
        { _tag: "NumericString", numeric: "number" },
      ],
      [
        "Schema.BigIntFromString",
        Schema.BigIntFromString,
        { _tag: "NumericString", numeric: "bigint" },
      ],
    ])("ZOrder.int over %s", (_, field, storage) => {
      const entity = withZOrder(
        { price: field },
        { zorder: [ZOrder.int("price", { min: 0, max: 1000 })] },
      )
      expect(storagesOf(entity)).toEqual([storage])
    })

    it.each<[string, Schema.Top, DimensionStorage]>([
      ["DynamoModel.DateEpochMs", DynamoModel.DateEpochMs, { _tag: "Epoch", unit: "epochMs" }],
      [
        "DynamoModel.DateEpochSeconds",
        DynamoModel.DateEpochSeconds,
        { _tag: "Epoch", unit: "epochSeconds" },
      ],
      ["DynamoModel.DateString", DynamoModel.DateString, { _tag: "UtcIsoString" }],
      ["Schema.DateTimeUtcFromString", Schema.DateTimeUtcFromString, { _tag: "UtcIsoString" }],
      ["DynamoModel.DateTimeZoned", DynamoModel.DateTimeZoned, { _tag: "ZonedIsoString" }],
    ])("ZOrder.dateTime over %s", (_, field, storage) => {
      const entity = withZOrder(
        { listedAt: field },
        { zorder: [ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "days", bits: 12 })] },
      )
      expect(storagesOf(entity)).toEqual([storage])
    })

    it.each<[string, Schema.Top, DimensionStorage]>([
      ["optional DateString", Schema.optional(DynamoModel.DateString), { _tag: "UtcIsoString" }],
      [
        "optionalKey DateEpochMs",
        Schema.optionalKey(DynamoModel.DateEpochMs),
        { _tag: "Epoch", unit: "epochMs" },
      ],
      ["optional Number", Schema.optional(Schema.Number), { _tag: "Number", numeric: "number" }],
    ])("an optional field (%s) resolves through its wrapper", (_, field, storage) => {
      const dimension =
        storage._tag === "Number"
          ? ZOrder.int("value", { min: 0, max: 9 })
          : ZOrder.dateTime("value", { from: "2024-01-01", unit: "days", bits: 12 })
      expect(storagesOf(withZOrder({ value: field }, { zorder: [dimension] }))).toEqual([storage])
    })

    it("ZOrder.dateTime over a configured storedAs override reads the override", () => {
      class Listing extends Schema.Class<Listing>("Listing")({
        id: Schema.String,
        region: Schema.String,
        listedAt: Schema.DateTimeUtc,
      }) {}
      const entity = Entity.make({
        model: DynamoModel.configure(Listing, {
          listedAt: { storedAs: DynamoModel.DateEpochSeconds },
        }),
        entityType: "Listing",
        primaryKey: byId,
        indexes: {
          search: {
            name: "gsi2",
            pk: { field: "gsi2pk", composite: ["region"] },
            sk: {
              field: "gsi2sk",
              zorder: [ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "days", bits: 12 })],
            },
          },
        },
      })
      expect(storagesOf(entity)).toEqual([{ _tag: "Epoch", unit: "epochSeconds" }])
    })

    it("ZOrder.literals over literal fields, and ZOrder.string over a string", () => {
      const entity = withZOrder(
        {
          status: Schema.Literals(["draft", "live"]),
          furnished: Schema.Boolean,
          floors: Schema.Literals([1, 2, 3]),
          suburb: Schema.String,
        },
        {
          zorder: [
            ZOrder.literals("status", ["draft", "live", "sold"]),
            ZOrder.literals("furnished", [false, true]),
            ZOrder.literals("floors", [1, 2, 3]),
            ZOrder.string("suburb", { bytes: 2 }),
          ],
        },
      )
      expect(storagesOf(entity)).toEqual([
        { _tag: "Literal" },
        { _tag: "Literal" },
        { _tag: "Literal" },
        { _tag: "RawString" },
      ])
    })

    it("one Dimension bound by two entities to different storages places an instant identically", () => {
      const listedAt = ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "hours", bits: 16 })
      const AsIso = withZOrder({ listedAt: DynamoModel.DateString }, { zorder: [listedAt] })
      const AsEpoch = withZOrder({ listedAt: DynamoModel.DateEpochMs }, { zorder: [listedAt] })
      expect(storagesOf(AsIso)).toEqual([{ _tag: "UtcIsoString" }])
      expect(storagesOf(AsEpoch)).toEqual([{ _tag: "Epoch", unit: "epochMs" }])
      const instant = DateTime.makeUnsafe("2024-01-02T05:30:00.000Z")
      const iso = KeyComposer.composeZOrderSk(schema, AsIso.indexes.search, {
        listedAt: DateTime.formatIso(instant),
      })
      const epoch = KeyComposer.composeZOrderSk(schema, AsEpoch.indexes.search, {
        listedAt: DateTime.toEpochMillis(instant),
      })
      expect(iso).toEqual(epoch)
      expect(iso).toEqual(Uint8Array.of(0x00, 29))
    })

    it.each<[string, Schema.Struct.Fields, ZOrder.Dimension, RegExp]>([
      [
        "int over a string",
        { price: Schema.String },
        ZOrder.int("price", { min: 0, max: 9 }),
        /needs a number or bigint field/,
      ],
      [
        "float over a bigint",
        { price: Schema.BigInt },
        ZOrder.float("price", { min: 0, max: 9, step: 0.5 }),
        /use ZOrder\.int/,
      ],
      [
        "dateTime over a plain string",
        { listedAt: Schema.String },
        ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "days", bits: 8 }),
        /known storage format/,
      ],
      [
        "dateTime over a plain number",
        { listedAt: Schema.Number },
        ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "days", bits: 8 }),
        /known storage format/,
      ],
      [
        "literals with an undeclared member",
        { status: Schema.Literals(["draft", "live", "sold"]) },
        ZOrder.literals("status", ["draft", "live"]),
        /"sold" are not declared/,
      ],
      [
        "literals of another kind",
        { status: Schema.String },
        ZOrder.literals("status", [1, 2]),
        /1 is not a string/,
      ],
      [
        "literals over an object",
        { status: Schema.Struct({ code: Schema.String }) },
        ZOrder.literals("status", ["a"]),
        /string, number or boolean field/,
      ],
      [
        "string over a number",
        { suburb: Schema.Number },
        ZOrder.string("suburb", { bytes: 2 }),
        /needs a string field/,
      ],
    ])("[EDD-9088] %s", (_, fields, dimension, why) => {
      expect(() => withZOrder(fields, { zorder: [dimension] })).toThrow(
        /\[EDD-9088\] Entity "Listing": index "search"/,
      )
      expect(() => withZOrder(fields, { zorder: [dimension] })).toThrow(why)
    })
  })

  describe("[EDD-9089] bit budget", () => {
    it("refuses a dimension wider than its kind allows", () => {
      const huge = ZOrder.int("price", {
        min: -Number.MAX_SAFE_INTEGER,
        max: Number.MAX_SAFE_INTEGER,
      })
      expect(huge.bits).toBe(54)
      expect(() => withZOrder({ price: Schema.Number }, { zorder: [huge] })).toThrow(
        /\[EDD-9089\] .*ZOrder\.int\("price"\) needs 54 bits; a int dimension takes at most 53/,
      )
      const wide = ZOrder.literals("status", ["a", "b"], { bits: 60 })
      expect(() => withZOrder({ status: Schema.Literals(["a", "b"]) }, { zorder: [wide] })).toThrow(
        /\[EDD-9089\]/,
      )
    })

    it("refuses an address wider than 512 bits", () => {
      const fields = Object.fromEntries(
        ["s1", "s2", "s3", "s4", "s5"].map((name) => [name, Schema.String]),
      )
      const dims = Object.keys(fields).map((name) => ZOrder.string(name, { bytes: 16 }))
      expect(() => withZOrder(fields, { zorder: dims })).toThrow(
        /\[EDD-9089\] Entity "Listing": index "search" interleaves 640 bits; a Z-order address takes at most 512/,
      )
      // 4 × 128 = 512 fits.
      expect(layoutOf(withZOrder(fields, { zorder: dims.slice(0, 4) })).bytes).toBe(64)
    })
  })

  describe("placement", () => {
    it("[EDD-9086] the primary key can't be a Z-order key", () => {
      const model = Schema.Struct({ id: Schema.String, price: Schema.Number })
      const primary = (half: "pk" | "sk", extra: Record<string, unknown>) =>
        ({
          pk: { field: "pk", composite: ["id"], ...(half === "pk" ? extra : {}) },
          sk: { field: "sk", composite: [], ...(half === "sk" ? extra : {}) },
        }) as unknown as typeof byId
      for (const [half, extra] of [
        ["sk", { zorder: [ZOrder.int("price", { min: 0, max: 9 })] }],
        ["sk", { prefix: ["id"] }],
        ["pk", { zorder: [ZOrder.int("price", { min: 0, max: 9 })] }],
      ] as const) {
        expect(() =>
          Entity.make({ model, entityType: "Listing", primaryKey: primary(half, extra) }),
        ).toThrow(/\[EDD-9086\] Entity "Listing": the primary key can't be a Z-order key/)
      }
    })

    it("[EDD-9086] a malformed secondary half fails at Entity.make", () => {
      expect(() => withZOrder({ price: Schema.Number }, { zorder: [] })).toThrow(
        /\[EDD-9086\] Index "gsi2"/,
      )
    })

    it("[EDD-9090] a Z-order index can't belong to a collection", () => {
      expect(() =>
        withZOrder(
          { price: Schema.Number },
          { zorder: [ZOrder.int("price", { min: 0, max: 9 })] },
          { collection: "listings" },
        ),
      ).toThrow(/\[EDD-9090\] Entity "Listing": index "search" has a Z-order sort key/)
    })

    it("[EDD-9090] _injectIndex refuses a Z-order half", () => {
      const Bound = withZOrder(
        { price: Schema.Number },
        { zorder: [ZOrder.int("price", { min: 0, max: 9 })] },
      )
      const Other = Entity.make({
        model: Schema.Struct({ id: Schema.String, region: Schema.String, price: Schema.Number }),
        entityType: "Other",
        primaryKey: byId,
      })
      expect(() =>
        (
          Other as unknown as {
            _injectIndex: (name: string, def: KeyComposer.IndexDefinition) => void
          }
        )._injectIndex("search", Bound.indexes.search),
      ).toThrow(/\[EDD-9090\] Entity "Other": index "search"/)
      expect(Object.keys(Other.indexes)).toEqual(["primary"])
    })
  })

  describe("existing composite checks cover prefix composites and dimensions", () => {
    it("[EDD-9002] an unknown prefix composite or dimension field", () => {
      expect(() =>
        withZOrder(
          { price: Schema.Number },
          { prefix: ["agencyId"], zorder: [ZOrder.int("price", { min: 0, max: 9 })] },
        ),
      ).toThrow(
        /\[EDD-9002\] Entity "Listing": index "search" references unknown attribute "agencyId"/,
      )
      expect(() =>
        withZOrder(
          { price: Schema.Number },
          { zorder: [ZOrder.int("bedrooms", { min: 0, max: 9 })] },
        ),
      ).toThrow(/\[EDD-9002\] .*unknown attribute "bedrooms"/)
    })

    it("[EDD-9025] a nullable prefix composite or dimension", () => {
      expect(() =>
        withZOrder(
          { agencyId: Schema.NullOr(Schema.String), price: Schema.Number },
          { prefix: ["agencyId"], zorder: [ZOrder.int("price", { min: 0, max: 9 })] },
        ),
      ).toThrow(/EDD-9025/)
      expect(() =>
        withZOrder(
          { price: Schema.NullOr(Schema.Number) },
          { zorder: [ZOrder.int("price", { min: 0, max: 9 })] },
        ),
      ).toThrow(/EDD-9025/)
    })

    const configured = (storedAs: unknown, sk: Record<string, unknown>) => {
      class Listing extends Schema.Class<Listing>("Listing")({
        id: Schema.String,
        region: Schema.String,
        price: Schema.Number,
        details: Schema.Struct({ rooms: Schema.Array(Schema.String) }),
        tags: Schema.Record(Schema.String, Schema.String),
      }) {}
      return () =>
        Entity.make({
          model: DynamoModel.configure(Listing, storedAs as never),
          entityType: "Listing",
          primaryKey: byId,
          indexes: {
            search: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["region"] },
              sk: { field: "gsi2sk", ...sk } as KeyComposer.ZOrderKeyPart,
            },
          },
        })
    }

    it("[EDD-9072] a packed prefix composite", () => {
      expect(
        configured(
          { details: { storedAs: DynamoModel.Packed({ format: "json" }) } },
          { prefix: ["details"], zorder: [ZOrder.int("price", { min: 0, max: 9 })] },
        ),
      ).toThrow(
        /\[EDD-9072\] Entity "Listing": packed field "details" cannot be a composite of index "search"/,
      )
    })

    it("[EDD-9022] a sparse prefix composite or dimension", () => {
      const sparse = { tags: { storedAs: DynamoModel.SparseMap() } }
      expect(
        configured(sparse, { prefix: ["tags"], zorder: [ZOrder.int("price", { min: 0, max: 9 })] }),
      ).toThrow(/\[EDD-9022\] Entity "Listing": sparse field "tags"/)
      expect(configured(sparse, { zorder: [ZOrder.string("tags", { bytes: 2 })] })).toThrow(
        /\[EDD-9022\] Entity "Listing": sparse field "tags"/,
      )
    })
  })
})
