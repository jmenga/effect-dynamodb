/**
 * `Offload.View` and the mode types (#179, design §9.2): a read's result type
 * under every mode, optional and nullable fields kept, exactly the model for a
 * member that offloads nothing, and widened or optional modes resolved so that
 * neither the view nor `ReadBlobErrors` under-reports.
 *
 * Compile-time only; checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import type { BlobStoreError } from "@effect-dynamodb/schema/Errors.js"
import { Schema } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import type {
  BlobHandle,
  DefaultOffloadModes,
  ExtractOffloadFields,
  NoOffload,
  NoOffloadState,
  OffloadedValue,
  OffloadMode,
  OffloadModes,
  OffloadState,
  ReadBlobErrors,
  ResolveModes,
  View,
  ViewOf,
} from "../src/Offload.js"

class Body extends Schema.Class<Body>("Body")({ text: Schema.String }) {}

class Document extends Schema.Class<Document>("Document")({
  id: Schema.String,
  title: Schema.String,
  body: Body,
  notes: Schema.optionalKey(Body),
  draft: Schema.NullOr(Body),
  scan: Schema.Uint8Array,
  thumbnail: Schema.optionalKey(Schema.Uint8Array),
}) {}

const Configured = DynamoModel.configure(Document, {
  body: { storedAs: DynamoModel.Packed({ format: "json", external: {} }) },
  notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 0 } }) },
  draft: { storedAs: DynamoModel.Packed({ format: "json", external: {} }) },
  scan: { storedAs: DynamoModel.External() },
  thumbnail: { storedAs: DynamoModel.External({ contentType: "image/png" }) },
})

type Fields = ExtractOffloadFields<typeof Configured>
type Model = Document

type Eager = { readonly overflow: "eager"; readonly binary: "eager" }
type Lazy = { readonly overflow: "lazy"; readonly binary: "lazy" }

describe("Offload types", () => {
  it("extracts the fields a configured model offloads", () => {
    expectTypeOf<Fields>().toEqualTypeOf<{
      readonly overflow: "body" | "notes" | "draft"
      readonly binary: "scan" | "thumbnail"
    }>()
  })

  it("is the model itself for a member that offloads nothing", () => {
    expectTypeOf<View<Model, NoOffload>>().toEqualTypeOf<Model>()
    expectTypeOf<View<Model, NoOffload, Lazy>>().toEqualTypeOf<Model>()
    expectTypeOf<
      ViewOf<{ readonly fields: NoOffload; readonly modes: Lazy; readonly item: Model }>
    >().toEqualTypeOf<Model>()
  })

  it("defaults to overflow eager, binary lazy", () => {
    type V = View<Model, Fields>
    expectTypeOf<V["body"]>().toEqualTypeOf<Body>()
    expectTypeOf<V["draft"]>().toEqualTypeOf<Body | null>()
    expectTypeOf<V["scan"]>().toEqualTypeOf<BlobHandle>()
    expectTypeOf<V["id"]>().toEqualTypeOf<string>()
    expectTypeOf<V>().toEqualTypeOf<View<Model, Fields, DefaultOffloadModes>>()
  })

  it("types every field eagerly", () => {
    type V = View<Model, Fields, Eager>
    expectTypeOf<V["body"]>().toEqualTypeOf<Body>()
    expectTypeOf<V["scan"]>().toEqualTypeOf<Uint8Array>()
  })

  it("types every field lazily, keeping null and absence", () => {
    type V = View<Model, Fields, Lazy>
    expectTypeOf<V["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
    expectTypeOf<V["draft"]>().toEqualTypeOf<OffloadedValue<Body> | null>()
    expectTypeOf<V["scan"]>().toEqualTypeOf<BlobHandle>()
    expectTypeOf<V["title"]>().toEqualTypeOf<string>()
    // optional fields stay optional, typed by mode when present
    expectTypeOf<V>().toMatchTypeOf<{
      readonly notes?: OffloadedValue<Body>
      readonly thumbnail?: BlobHandle
    }>()
    expectTypeOf<{
      readonly id: string
      readonly title: string
      readonly body: OffloadedValue<Body>
      readonly draft: OffloadedValue<Body> | null
      readonly scan: BlobHandle
    }>().toMatchTypeOf<V>()
  })

  it("types a mode that is not one literal as either form", () => {
    type V = View<Model, Fields, { readonly overflow: OffloadMode; readonly binary: OffloadMode }>
    expectTypeOf<V["body"]>().toEqualTypeOf<Body | OffloadedValue<Body>>()
    expectTypeOf<V["scan"]>().toEqualTypeOf<Uint8Array | BlobHandle>()
    expectTypeOf<V["draft"]>().toEqualTypeOf<Body | OffloadedValue<Body> | null>()
  })

  it("resolves modes: a string sets both kinds, an object the kinds it names", () => {
    expectTypeOf<ResolveModes<"lazy">>().toEqualTypeOf<{
      readonly overflow: "lazy"
      readonly binary: "lazy"
    }>()
    expectTypeOf<ResolveModes<{ readonly binary: "eager" }>>().toEqualTypeOf<{
      readonly overflow: "eager"
      readonly binary: "eager"
    }>()
    expectTypeOf<ResolveModes<{ readonly overflow: "lazy" }>>().toEqualTypeOf<{
      readonly overflow: "lazy"
      readonly binary: "lazy"
    }>()
    expectTypeOf<ResolveModes<{}, Eager>>().toEqualTypeOf<{
      readonly overflow: "eager"
      readonly binary: "eager"
    }>()
    expectTypeOf<ResolveModes<{ readonly binary: "lazy" }, Eager>>().toEqualTypeOf<{
      readonly overflow: "eager"
      readonly binary: "lazy"
    }>()
    // an explicit undefined keeps the base
    expectTypeOf<ResolveModes<{ readonly binary: undefined }>>().toEqualTypeOf<{
      readonly overflow: "eager"
      readonly binary: "lazy"
    }>()
  })

  it("resolves a kind the argument may or may not set to its mode or the base's", () => {
    // OffloadModes itself: either kind may be either mode
    expectTypeOf<ResolveModes<OffloadModes>>().toEqualTypeOf<{
      readonly overflow: OffloadMode
      readonly binary: OffloadMode
    }>()
    expectTypeOf<ResolveModes<{ readonly binary?: OffloadMode }>>().toEqualTypeOf<{
      readonly overflow: "eager"
      readonly binary: OffloadMode
    }>()
    // an optional literal: that literal or the base's
    expectTypeOf<ResolveModes<{ readonly overflow?: "lazy" | undefined }>>().toEqualTypeOf<{
      readonly overflow: OffloadMode
      readonly binary: "lazy"
    }>()
    expectTypeOf<ResolveModes<{ readonly binary?: "lazy" }, Eager>>().toEqualTypeOf<{
      readonly overflow: "eager"
      readonly binary: OffloadMode
    }>()
    // the same optional literal as the base is the base
    expectTypeOf<ResolveModes<{ readonly binary?: "lazy" }>>().toEqualTypeOf<DefaultOffloadModes>()
    // a widened string sets both kinds to either mode
    expectTypeOf<ResolveModes<OffloadMode>["binary"]>().toEqualTypeOf<OffloadMode>()
  })

  it("never under-reports a widened mode in the view or the error union", () => {
    type Widened = ResolveModes<OffloadModes>
    type V = View<Model, Fields, Widened>
    expectTypeOf<V["body"]>().toEqualTypeOf<Body | OffloadedValue<Body>>()
    expectTypeOf<V["scan"]>().toEqualTypeOf<Uint8Array | BlobHandle>()
    type BinaryOnly = { readonly overflow: never; readonly binary: "scan" }
    type OverflowOnly = { readonly overflow: "body"; readonly binary: never }
    // a binary-only member read eagerly may fail in the store
    expectTypeOf<ReadBlobErrors<BinaryOnly, Widened>>().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<
      ReadBlobErrors<BinaryOnly, ResolveModes<{ readonly binary?: OffloadMode }>>
    >().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<
      ReadBlobErrors<BinaryOnly, ResolveModes<{ readonly binary?: "eager" }>>
    >().toEqualTypeOf<BlobStoreError>()
    expectTypeOf<
      ReadBlobErrors<OverflowOnly, ResolveModes<{ readonly overflow?: "lazy" }>>
    >().toEqualTypeOf<BlobStoreError>()
    // only a surely-lazy kind drops it
    expectTypeOf<
      ReadBlobErrors<BinaryOnly, ResolveModes<{ readonly overflow?: OffloadMode }>>
    >().toEqualTypeOf<never>()
  })

  it("types a builder's offload state", () => {
    expectTypeOf<NoOffloadState>().toMatchTypeOf<OffloadState>()
    type State = { readonly fields: Fields; readonly modes: Lazy; readonly item: Model }
    expectTypeOf<ViewOf<State>>().toEqualTypeOf<View<Model, Fields, Lazy>>()
    // a selected partial re-types only what it holds
    type Selected = {
      readonly fields: Fields
      readonly modes: DefaultOffloadModes
      readonly item: Pick<Model, "id" | "scan">
    }
    expectTypeOf<ViewOf<Selected>>().toEqualTypeOf<{
      readonly id: string
      readonly scan: BlobHandle
    }>()
  })
})
