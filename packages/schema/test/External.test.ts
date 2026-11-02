/**
 * `DynamoModel.External` (#179) — config validation (EDD-9141), defaults, the
 * brand guard, `configure` integration (renames, `immutable`, the
 * `Uint8Array`-only admission at the type level), `getExternalFields`, and the
 * type-level offload helpers: `ExtractOffloadFields`, `ReadBlobErrors`,
 * `WriteBlobErrors`, `OpBlobErrors`.
 */
import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import type { BlobStoreError, RefNotFound, ValidationError } from "../src/Errors.js"
import type {
  DefaultOffloadModes,
  OpBlobErrors,
  ReadBlobErrors,
  WriteBlobErrors,
} from "../src/internal/EntityTypes.js"

class Document extends Schema.Class<Document>("Document")({
  id: Schema.String,
  title: Schema.String,
  size: Schema.Number,
  body: Schema.Struct({ text: Schema.String }),
  scan: Schema.Uint8Array,
  thumbnail: Schema.optional(Schema.Uint8Array),
  preview: Schema.NullOr(Schema.Uint8Array),
  encoded: Schema.Uint8ArrayFromBase64,
  extra: Schema.Unknown,
}) {}

const expectEdd9141 = (thunk: () => unknown, fragment: string) => {
  expect(thunk).toThrow(/\[EDD-9141\] DynamoModel\.External:/)
  expect(thunk).toThrow(fragment)
}

describe("DynamoModel.External", () => {
  it("defaults the content type to application/octet-stream", () => {
    const config = DynamoModel.External()
    expect(DynamoModel.isExternalConfig(config)).toBe(true)
    expect(config.contentType).toBe("application/octet-stream")
    expect(DynamoModel.DEFAULT_EXTERNAL_CONTENT_TYPE).toBe("application/octet-stream")
    expect(Object.isFrozen(config)).toBe(true)
    expect(DynamoModel.External({}).contentType).toBe("application/octet-stream")
    expect(DynamoModel.External({ contentType: undefined }).contentType).toBe(
      "application/octet-stream",
    )
  })

  it("keeps a content type up to 255 US-ASCII bytes", () => {
    expect(DynamoModel.External({ contentType: "application/pdf" }).contentType).toBe(
      "application/pdf",
    )
    const longest = `image/${"x".repeat(249)}`
    expect(longest.length).toBe(255)
    expect(DynamoModel.External({ contentType: longest }).contentType).toBe(longest)
  })

  it("refuses options that are not an object (EDD-9141)", () => {
    for (const options of [null, "application/pdf", 5, ["application/pdf"]]) {
      expectEdd9141(() => DynamoModel.External(options as never), "options must be an object")
    }
  })

  it("refuses an unknown option key (EDD-9141)", () => {
    expectEdd9141(
      () => DynamoModel.External({ contentType: "image/png", threshold: 0 } as never),
      'unknown option "threshold"',
    )
  })

  it("refuses a content type that is empty, too long, not printable ASCII or not a string (EDD-9141)", () => {
    for (const contentType of [
      "",
      "x".repeat(256),
      "image/pngé",
      "text/plain; charset=☃",
      "text/plain\r\nX-Injected: 1",
      "text/plain\u0000",
      "text/\tplain",
      "text/plain\u007f",
      5,
    ]) {
      expectEdd9141(
        () => DynamoModel.External({ contentType } as never),
        "contentType must be a non-empty printable US-ASCII string of at most 255 bytes",
      )
    }
    // Spaces and every printable character are a header's to carry.
    expect(DynamoModel.External({ contentType: 'text/plain; charset="utf-8"' }).contentType).toBe(
      'text/plain; charset="utf-8"',
    )
  })

  it("is distinct from Packed and SparseMap configs", () => {
    const external = DynamoModel.External()
    expect(DynamoModel.isPackedConfig(external)).toBe(false)
    expect(DynamoModel.isSparseMapConfig(external)).toBe(false)
    expect(DynamoModel.isExternalConfig(DynamoModel.Packed({ format: "json", external: {} }))).toBe(
      false,
    )
    expect(DynamoModel.isExternalConfig({ contentType: "application/pdf" })).toBe(false)
    expect(DynamoModel.isExternalConfig(null)).toBe(false)
  })
})

describe("configure with storedAs: External", () => {
  it("resolves external onto the attribute, beside field and immutable", () => {
    const pdf = DynamoModel.External({ contentType: "application/pdf" })
    const model = DynamoModel.configure(Document, {
      scan: { storedAs: pdf },
      thumbnail: { field: "thumb", immutable: true, storedAs: DynamoModel.External() },
    })
    expect(model.attributes.scan).toEqual({ external: pdf })
    expect(model.attributes.scan?.external).toBe(pdf)
    expect(model.attributes.thumbnail).toEqual({
      field: "thumb",
      immutable: true,
      external: DynamoModel.External(),
    })
    expect(model.attributes.scan?.packed).toBeUndefined()
    expect(model.attributes.scan?.encoding).toBeUndefined()
  })

  it("getExternalFields returns domain field names → config", () => {
    const pdf = DynamoModel.External({ contentType: "application/pdf" })
    const model = DynamoModel.configure(Document, {
      scan: { storedAs: pdf },
      preview: { field: "p", storedAs: DynamoModel.External() },
      body: { storedAs: DynamoModel.Packed({ format: "json", external: {} }) },
      title: { immutable: true },
    })
    expect(DynamoModel.getExternalFields(model)).toEqual({
      scan: pdf,
      preview: DynamoModel.External(),
    })
    expect(Object.keys(DynamoModel.getPackedFields(model))).toEqual(["body"])
  })

  it("getExternalFields is empty for an unconfigured model", () => {
    expect(DynamoModel.getExternalFields(Document)).toEqual({})
    expect(DynamoModel.getExternalFields(DynamoModel.configure(Document, {}))).toEqual({})
  })

  it("admits External only on Uint8Array-typed fields at the type level", () => {
    const external = DynamoModel.External()
    DynamoModel.configure(Document, {
      scan: { storedAs: external },
      thumbnail: { storedAs: external },
      preview: { storedAs: external },
      // The domain side of Uint8ArrayFromBase64 is a Uint8Array: admitted by the
      // types, refused by Entity.make (EDD-9111) for its string encoded side.
      encoded: { storedAs: external },
    })
    // @ts-expect-error — a string field cannot be External
    DynamoModel.configure(Document, { title: { storedAs: external } })
    // @ts-expect-error — a number field cannot be External
    DynamoModel.configure(Document, { size: { storedAs: external } })
    // @ts-expect-error — an object field cannot be External
    DynamoModel.configure(Document, { body: { storedAs: external } })
    // @ts-expect-error — an unknown field cannot be External
    DynamoModel.configure(Document, { extra: { storedAs: external } })
  })
})

describe("ExtractOffloadFields", () => {
  it("names the overflow and binary fields", () => {
    const model = DynamoModel.configure(Document, {
      body: {
        storedAs: DynamoModel.Packed({
          format: "json",
          compression: { codec: "zstd" },
          external: {},
        }),
      },
      extra: { storedAs: DynamoModel.Packed({ format: "json" }) },
      scan: { field: "s", storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
      thumbnail: { storedAs: DynamoModel.External() },
      title: { immutable: true },
    })
    expectTypeOf<DynamoModel.ExtractOffloadFields<typeof model>>().toEqualTypeOf<{
      readonly overflow: "body"
      readonly binary: "scan" | "thumbnail"
    }>()
    // An overflow field is a packed field; a plain packed field is not offloaded.
    expectTypeOf<DynamoModel.ExtractPackedFields<typeof model>>().toEqualTypeOf<"body" | "extra">()
  })

  it("is NoOffload for a model that offloads nothing", () => {
    expectTypeOf<
      DynamoModel.ExtractOffloadFields<typeof Document>
    >().toEqualTypeOf<DynamoModel.NoOffload>()
    const packedOnly = DynamoModel.configure(Document, {
      body: { storedAs: DynamoModel.Packed({ format: "json" }) },
    })
    expectTypeOf<DynamoModel.ExtractOffloadFields<typeof packedOnly>>().toEqualTypeOf<{
      readonly overflow: never
      readonly binary: never
    }>()
  })

  it("sees an overflow config held in a variable", () => {
    const overflow = DynamoModel.Packed({ format: "json", external: { threshold: 0 } })
    const model = DynamoModel.configure(Document, { body: { storedAs: overflow } })
    expectTypeOf<
      DynamoModel.ExtractOffloadFields<typeof model>["overflow"]
    >().toEqualTypeOf<"body">()
  })

  it("counts a config that may be an overflow one as overflow, never under-reporting", () => {
    // A union-typed config is legal; it may offload, so it is overflow.
    const pick = (large: boolean): DynamoModel.PackedConfig | DynamoModel.ExternalPackedConfig =>
      large
        ? DynamoModel.Packed({ format: "json", external: {} })
        : DynamoModel.Packed({ format: "json" })
    const model = DynamoModel.configure(Document, { body: { storedAs: pick(true) } })
    expectTypeOf<
      DynamoModel.ExtractOffloadFields<typeof model>["overflow"]
    >().toEqualTypeOf<"body">()
    expectTypeOf<DynamoModel.ExtractPackedFields<typeof model>>().toEqualTypeOf<"body">()
    // A config typed `PackedConfig` is provably inline: widening an overflow
    // config to it is a compile error (see Packed.test.ts), so nothing over-reports.
    const plain: DynamoModel.PackedConfig = DynamoModel.Packed({ format: "json" })
    const inline = DynamoModel.configure(Document, { body: { storedAs: plain } })
    expectTypeOf<
      DynamoModel.ExtractOffloadFields<typeof inline>["overflow"]
    >().toEqualTypeOf<never>()
    expectTypeOf<DynamoModel.ExtractPackedFields<typeof inline>>().toEqualTypeOf<"body">()
  })
})

describe("blob error type helpers", () => {
  type Both = { readonly overflow: "body"; readonly binary: "scan" }
  type OverflowOnly = { readonly overflow: "body"; readonly binary: never }
  type BinaryOnly = { readonly overflow: never; readonly binary: "scan" }
  type Eager = { readonly overflow: "eager"; readonly binary: "eager" }
  type Lazy = { readonly overflow: "lazy"; readonly binary: "lazy" }

  it("ReadBlobErrors: BlobStoreError only where the mode reads a present kind eagerly", () => {
    expectTypeOf<ReadBlobErrors<Both, DefaultOffloadModes>>().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<ReadBlobErrors<Both, Eager>>().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<ReadBlobErrors<Both, Lazy>>().toEqualTypeOf<never>()
    expectTypeOf<
      ReadBlobErrors<OverflowOnly, DefaultOffloadModes>
    >().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<ReadBlobErrors<OverflowOnly, Lazy>>().toEqualTypeOf<never>()
    // A binary-only entity keeps today's read errors under the default modes.
    expectTypeOf<ReadBlobErrors<BinaryOnly, DefaultOffloadModes>>().toEqualTypeOf<never>()
    expectTypeOf<ReadBlobErrors<BinaryOnly, Eager>>().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<ReadBlobErrors<DynamoModel.NoOffload, Eager>>().toEqualTypeOf<never>()
    // A mode that is not one literal counts as eager.
    type Unknown = { readonly overflow: "eager" | "lazy"; readonly binary: "eager" | "lazy" }
    expectTypeOf<ReadBlobErrors<BinaryOnly, Unknown>>().toEqualTypeOf<BlobStoreError>()
    // `any` contributes nothing.
    expectTypeOf<ReadBlobErrors<any, Eager>>().toEqualTypeOf<never>()
  })

  it("WriteBlobErrors: BlobStoreError when anything is offloaded", () => {
    expectTypeOf<WriteBlobErrors<Both>>().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<WriteBlobErrors<OverflowOnly>>().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<WriteBlobErrors<BinaryOnly>>().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<WriteBlobErrors<DynamoModel.NoOffload>>().toEqualTypeOf<never>()
    expectTypeOf<WriteBlobErrors<any>>().toEqualTypeOf<never>()
  })

  it("OpBlobErrors: the blob errors of an op's error type, never for any", () => {
    expectTypeOf<
      OpBlobErrors<BlobStoreError | ValidationError | RefNotFound>
    >().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<OpBlobErrors<ValidationError>>().toEqualTypeOf<never>()
    expectTypeOf<OpBlobErrors<never>>().toEqualTypeOf<never>()
    expectTypeOf<OpBlobErrors<any>>().toEqualTypeOf<never>()
  })
})
