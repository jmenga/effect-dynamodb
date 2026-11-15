/**
 * `DynamoModel.Packed` — config validation (EDD-9071), defaults, the brand
 * guard, `configure` integration and `getPackedFields` / `ExtractPackedFields`;
 * the `external` option (#179: EDD-9141, the 65,536 default, the
 * `ExternalPackedConfig` overload).
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
    expect(config.external).toBeUndefined()
    expect(DynamoModel.isExternalPackedConfig(config)).toBe(false)
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

  it("refuses an unknown option key, naming external among the expected ones (EDD-9071)", () => {
    expectEdd9071(
      () => DynamoModel.Packed({ format: "json", offload: {} } as never),
      'expected "format", optional "compression" and optional "external"',
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

const expectEdd9141 = (thunk: () => unknown, fragment: string) => {
  expect(thunk).toThrow(/\[EDD-9141\] DynamoModel\.Packed:/)
  expect(thunk).toThrow(fragment)
}

describe("DynamoModel.Packed({ external })", () => {
  it("defaults the threshold to 65,536 stored bytes", () => {
    const config = DynamoModel.Packed({ format: "json", external: {} })
    expect(config.external).toEqual({ threshold: 65_536 })
    expect(DynamoModel.DEFAULT_EXTERNAL_THRESHOLD).toBe(65_536)
    expect(DynamoModel.isPackedConfig(config)).toBe(true)
    expect(DynamoModel.isExternalPackedConfig(config)).toBe(true)
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.external)).toBe(true)
  })

  it("keeps an explicit threshold, including 0 (always offload)", () => {
    expect(
      DynamoModel.Packed({ format: "json", external: { threshold: 131_072 } }).external,
    ).toEqual({ threshold: 131_072 })
    expect(DynamoModel.Packed({ format: "json", external: { threshold: 0 } }).external).toEqual({
      threshold: 0,
    })
    expect(
      DynamoModel.Packed({ format: "json", external: { threshold: undefined } }).external,
    ).toEqual({ threshold: 65_536 })
  })

  it("combines with compression; both settings are resolved", () => {
    const config = DynamoModel.Packed({
      format: "json",
      compression: { codec: "zstd", threshold: 0 },
      external: { threshold: 1000 },
    })
    expect(config.compression).toEqual({ codec: "zstd", threshold: 0 })
    expect(config.external).toEqual({ threshold: 1000 })
  })

  it("treats external: undefined as a plain packed config", () => {
    const config = DynamoModel.Packed({ format: "json", external: undefined })
    expect(config.external).toBeUndefined()
    expect(DynamoModel.isExternalPackedConfig(config)).toBe(false)
  })

  it("refuses an external option that is not an object (EDD-9141)", () => {
    for (const external of [null, 5, "big", true, [1]]) {
      expectEdd9141(
        () => DynamoModel.Packed({ format: "json", external } as never),
        "external must be an object",
      )
    }
  })

  it("refuses an unknown external key (EDD-9141)", () => {
    expectEdd9141(
      () => DynamoModel.Packed({ format: "json", external: { limit: 5 } } as never),
      'unknown external option "limit"',
    )
  })

  it("refuses a threshold that is not a non-negative safe integer (EDD-9141)", () => {
    for (const threshold of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "65536"]) {
      expectEdd9141(
        () => DynamoModel.Packed({ format: "json", external: { threshold } } as never),
        "external.threshold must be a non-negative safe integer",
      )
    }
  })

  it("isExternalPackedConfig rejects other configs", () => {
    expect(DynamoModel.isExternalPackedConfig(DynamoModel.External())).toBe(false)
    expect(DynamoModel.isExternalPackedConfig(DynamoModel.SparseMap())).toBe(false)
    expect(DynamoModel.isExternalPackedConfig({ external: { threshold: 1 } })).toBe(false)
    expect(DynamoModel.isExternalPackedConfig(null)).toBe(false)
  })

  it("returns ExternalPackedConfig only from the external overload", () => {
    expectTypeOf(
      DynamoModel.Packed({ format: "json", external: {} }),
    ).toEqualTypeOf<DynamoModel.ExternalPackedConfig>()
    expectTypeOf(DynamoModel.Packed({ format: "json" })).toEqualTypeOf<DynamoModel.PackedConfig>()
    // Options typed as the plain `PackedOptions` cannot carry `external`, so a
    // config the type level would not see as offloaded is never returned.
    const plain: DynamoModel.PackedOptions = { format: "json" }
    expectTypeOf(DynamoModel.Packed(plain)).toEqualTypeOf<DynamoModel.PackedConfig>()
    // @ts-expect-error — `external` is not part of the plain options
    const withExternal: DynamoModel.PackedOptions = { format: "json", external: {} }
    void withExternal
    // The two configs are disjoint: a plain config is not an overflow config,
    // and an overflow config cannot be widened to a plain one — the type level
    // would then read it as inline and drop its blob-store errors.
    expectTypeOf<DynamoModel.PackedConfig>().not.toExtend<DynamoModel.ExternalPackedConfig>()
    expectTypeOf<DynamoModel.ExternalPackedConfig>().not.toExtend<DynamoModel.PackedConfig>()
    // @ts-expect-error — an overflow config is not a PackedConfig
    const widened: DynamoModel.PackedConfig = DynamoModel.Packed({
      format: "json",
      external: { threshold: 0 },
    })
    void widened
    // Either is a packed config to the guard.
    const either = DynamoModel.Packed({ format: "json", external: {} }) as unknown
    if (DynamoModel.isPackedConfig(either)) {
      expectTypeOf(either).toEqualTypeOf<
        DynamoModel.PackedConfig | DynamoModel.ExternalPackedConfig
      >()
    }
  })

  it("configure stores an overflow config as packed; getPackedFields includes it", () => {
    const external = DynamoModel.Packed({ format: "json", external: { threshold: 0 } })
    const model = DynamoModel.configure(Order, {
      lines: { field: "l", immutable: true, storedAs: external },
    })
    expect(model.attributes.lines).toEqual({ field: "l", immutable: true, packed: external })
    expect(model.attributes.lines?.external).toBeUndefined()
    expect(DynamoModel.getPackedFields(model)).toEqual({ lines: external })
    expectTypeOf<DynamoModel.ExtractPackedFields<typeof model>>().toEqualTypeOf<"lines">()
  })
})
