/**
 * `DynamoModel.Packed` — config validation (EDD-9071), defaults, the brand
 * guard, `configure` integration and `getPackedFields` / `ExtractPackedFields`.
 */
import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"

class Line extends Schema.Class<Line>("Line")({ sku: Schema.String, qty: Schema.Number }) {}

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  total: Schema.Number,
  lines: Schema.Array(Line),
  details: Schema.Struct({ note: Schema.String }),
  meta: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  extra: Schema.Unknown,
  tags: Schema.Record(Schema.String, Schema.Number),
}) {}

const expectEdd9071 = (thunk: () => unknown, fragment: string) => {
  expect(thunk).toThrow(/\[EDD-9071\]/)
  expect(thunk).toThrow(fragment)
}

describe("DynamoModel.Packed", () => {
  it("builds a json config without compression", () => {
    const config = DynamoModel.Packed({ format: "json" })
    expect(DynamoModel.isPackedConfig(config)).toBe(true)
    expect(config.format).toBe("json")
    expect(config.compression).toBeUndefined()
    expect(Object.isFrozen(config)).toBe(true)
  })

  it("defaults the compression threshold to 1024 bytes", () => {
    const config = DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } })
    expect(config.compression).toEqual({ codec: "zstd", threshold: 1024 })
    expect(DynamoModel.DEFAULT_COMPRESSION_THRESHOLD).toBe(1024)
    expect(Object.isFrozen(config.compression)).toBe(true)
  })

  it("keeps an explicit threshold, including 0", () => {
    expect(
      DynamoModel.Packed({ format: "json", compression: { codec: "gzip", threshold: 4096 } })
        .compression,
    ).toEqual({ codec: "gzip", threshold: 4096 })
    expect(
      DynamoModel.Packed({ format: "json", compression: { codec: "brotli", threshold: 0 } })
        .compression,
    ).toEqual({ codec: "brotli", threshold: 0 })
  })

  it("accepts every codec", () => {
    for (const codec of DynamoModel.compressionCodecs) {
      expect(
        DynamoModel.Packed({ format: "json", compression: { codec } }).compression?.codec,
      ).toBe(codec)
    }
  })

  it("refuses format binary as reserved (EDD-9071)", () => {
    expectEdd9071(
      () => DynamoModel.Packed({ format: "binary" } as never),
      'format "binary" is reserved',
    )
  })

  it("refuses an unknown or missing format (EDD-9071)", () => {
    expectEdd9071(() => DynamoModel.Packed({ format: "xml" } as never), 'unknown format "xml"')
    expectEdd9071(() => DynamoModel.Packed({} as never), "unknown format")
  })

  it("refuses an unknown codec (EDD-9071)", () => {
    expectEdd9071(
      () => DynamoModel.Packed({ format: "json", compression: { codec: "lz4" } } as never),
      'unknown compression codec "lz4"',
    )
    expectEdd9071(
      () => DynamoModel.Packed({ format: "json", compression: {} } as never),
      "unknown compression codec",
    )
  })

  it("refuses a bad threshold (EDD-9071)", () => {
    for (const threshold of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1024"]) {
      expectEdd9071(
        () =>
          DynamoModel.Packed({
            format: "json",
            compression: { codec: "gzip", threshold },
          } as never),
        "non-negative safe integer",
      )
    }
  })

  it("refuses unknown option keys (EDD-9071)", () => {
    expectEdd9071(
      () => DynamoModel.Packed({ format: "json", level: 3 } as never),
      'unknown option "level"',
    )
    expectEdd9071(
      () =>
        DynamoModel.Packed({ format: "json", compression: { codec: "zstd", level: 3 } } as never),
      'unknown compression option "level"',
    )
  })

  it("refuses non-object options (EDD-9071)", () => {
    expectEdd9071(() => DynamoModel.Packed(null as never), "options must be an object")
    expectEdd9071(
      () => DynamoModel.Packed({ format: "json", compression: "zstd" } as never),
      "compression must be an object",
    )
  })

  it("isPackedConfig rejects look-alikes", () => {
    expect(DynamoModel.isPackedConfig({ format: "json", compression: undefined })).toBe(false)
    expect(DynamoModel.isPackedConfig(DynamoModel.SparseMap())).toBe(false)
    expect(DynamoModel.isPackedConfig(null)).toBe(false)
    expect(DynamoModel.isSparseMapConfig(DynamoModel.Packed({ format: "json" }))).toBe(false)
  })
})

describe("configure with storedAs: Packed", () => {
  it("resolves packed onto the attribute, beside field and immutable", () => {
    const lines = DynamoModel.Packed({ format: "json" })
    const details = DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } })
    const model = DynamoModel.configure(Order, {
      lines: { storedAs: lines },
      details: { field: "d", immutable: true, storedAs: details },
    })
    expect(model.attributes.lines).toEqual({ packed: lines })
    expect(model.attributes.details).toEqual({ field: "d", immutable: true, packed: details })
    expect(model.attributes.details?.packed).toBe(details)
    expect(model.attributes.details?.sparse).toBeUndefined()
    expect(model.attributes.details?.encoding).toBeUndefined()
  })

  it("getPackedFields returns domain field names → config", () => {
    const packed = DynamoModel.Packed({ format: "json" })
    const model = DynamoModel.configure(Order, {
      lines: { storedAs: packed },
      meta: { field: "m", storedAs: packed },
      tags: { storedAs: DynamoModel.SparseMap() },
      orderId: { immutable: true },
    })
    expect(DynamoModel.getPackedFields(model)).toEqual({ lines: packed, meta: packed })
    expect(DynamoModel.getSparseFields(model)).toEqual({ tags: { prefix: "tags" } })
  })

  it("getPackedFields is empty for an unconfigured model", () => {
    expect(DynamoModel.getPackedFields(Order)).toEqual({})
    expect(DynamoModel.getPackedFields(DynamoModel.configure(Order, {}))).toEqual({})
  })

  it("admits Packed only on object/array-shaped (or unknown) fields at the type level", () => {
    const packed = DynamoModel.Packed({ format: "json" })
    DynamoModel.configure(Order, {
      lines: { storedAs: packed },
      details: { storedAs: packed },
      meta: { storedAs: packed },
      extra: { storedAs: packed },
    })
    // @ts-expect-error — a string field cannot be packed
    DynamoModel.configure(Order, { orderId: { storedAs: packed } })
    // @ts-expect-error — a number field cannot be packed
    DynamoModel.configure(Order, { total: { storedAs: packed } })
  })

  it("ExtractPackedFields names the packed fields", () => {
    const packed = DynamoModel.Packed({ format: "json" })
    const model = DynamoModel.configure(Order, {
      lines: { storedAs: packed },
      details: { field: "d", storedAs: packed },
      tags: { storedAs: DynamoModel.SparseMap() },
      orderId: { immutable: true },
    })
    expectTypeOf<DynamoModel.ExtractPackedFields<typeof model>>().toEqualTypeOf<
      "lines" | "details"
    >()
    expectTypeOf<DynamoModel.ExtractPackedFields<typeof Order>>().toEqualTypeOf<never>()
  })
})
