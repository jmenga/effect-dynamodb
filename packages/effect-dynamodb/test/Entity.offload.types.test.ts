/**
 * The offload type parameter on entities (#179, design §9.1, §9.3): `Entity`
 * and the schema package's `EntityDefinition` carry `TOffload` (inferred from
 * the configured model), `BoundEntity` and `TypedClient` pass it on, every
 * write adds `WriteBlobErrors<TOffload>` — `BlobStoreError` for a member that
 * offloads anything, nothing for one that does not — and an External field's
 * paths are `PackedPath`s, as a packed field's are.
 *
 * Compile-time only; checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as SchemaEntity from "@effect-dynamodb/schema/Entity.js"
import type { BlobStoreError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Schema, Stream } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Batch from "../src/Batch.js"
import * as Collection from "../src/Collection.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type * as EventStore from "../src/EventStore.js"
import type { WithBinaryInput } from "../src/internal/OffloadTypes.js"
import type {
  BinaryInput,
  BlobHandle,
  BlobSource,
  NoOffload,
  OffloadedValue,
} from "../src/Offload.js"
import * as Offload from "../src/Offload.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { withOffloadGate } from "./helpers/OffloadGate.js"

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.Struct({ text: Schema.String }),
  scan: Schema.optional(Schema.Uint8Array),
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const offloaded = DynamoModel.configure(Doc, {
  body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 1_024 } }) },
  scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
})

const Docs = withOffloadGate(() =>
  Entity.make({ model: offloaded, entityType: "Doc", primaryKey, versioned: { retain: true } }),
)

/** Binary only: its writes still reach the store. */
const Scans = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Doc, { scan: { storedAs: DynamoModel.External() } }),
    entityType: "Scan",
    primaryKey,
  }),
)

const Plain = Entity.make({ model: Doc, entityType: "PlainDoc", primaryKey })

/** {@link Docs} with its fields inline: what offloading must not change. */
const InlineDocs = Entity.make({
  model: DynamoModel.configure(Doc, {
    body: { storedAs: DynamoModel.Packed({ format: "json" }) },
  }),
  entityType: "InlineDoc",
  primaryKey,
  versioned: { retain: true },
})

/** A pure definition, from the AWS-free package. */
const PureDocs = withOffloadGate(() =>
  SchemaEntity.make({ model: offloaded, entityType: "PureDoc", primaryKey }),
)

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  at: Schema.Number,
  raw: Schema.optional(Schema.Uint8Array),
}) {}

const Readings = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Reading, { raw: { storedAs: DynamoModel.External() } }),
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["sensorId"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        sensorId: Schema.String,
        at: Schema.Number,
        raw: Schema.optional(Schema.Uint8Array),
      }),
    },
  }),
)

/** Members of an explicit collection: one offloads, one does not. */
const shelf = {
  collection: "shelf",
  name: "gsi1",
  pk: { field: "gsi1pk", composite: ["title"] },
  sk: { field: "gsi1sk", composite: ["docId"] },
} as const
const ShelfDocs = withOffloadGate(() =>
  Entity.make({ model: offloaded, entityType: "ShelfDoc", primaryKey, indexes: { shelf } }),
)
const ShelfPlain = Entity.make({
  model: Doc,
  entityType: "ShelfPlain",
  primaryKey,
  indexes: { shelf },
})

const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "types", version: 1, escapeKeys: true }),
  entities: { Docs, Scans, Plain, PureDocs, Readings },
})

/** Vector search over an offloading member, and over one that offloads nothing. */
const byTitle = {
  name: "vec1",
  dimensions: 2,
  distance: "cosine",
  source: { fields: ["title"] },
} as const
const Cards = withOffloadGate(() =>
  Entity.make({ model: offloaded, entityType: "Card", primaryKey, vectorIndexes: { byTitle } }),
)
const PlainCards = Entity.make({
  model: Doc,
  entityType: "PlainCard",
  primaryKey,
  vectorIndexes: { byTitle },
})
const VectorTable = Table.make({
  schema: DynamoSchema.make({ name: "vectors", version: 1, escapeKeys: true }),
  entities: { Cards, PlainCards },
})

type ErrorOf<T> = T extends { readonly asEffect: () => Effect.Effect<any, infer E, any> }
  ? E
  : T extends Effect.Effect<any, infer E, any>
    ? E
    : never
type Blob<T> = Extract<ErrorOf<T>, BlobStoreError>
/** A vector search's hit item and its terminal's errors. */
type HitOf<T> = T extends {
  readonly collect: () => Effect.Effect<Array<{ readonly item: infer A }>, any, any>
}
  ? A
  : never
type SearchBlob<T> = T extends {
  readonly collect: () => Effect.Effect<any, infer E, any>
}
  ? Extract<E, BlobStoreError>
  : never

const key = { docId: "d-1" }
const doc = { docId: "d-1", title: "t", body: { text: "b" } }

// The functions below are type-checked, never executed.
const typeOnly = (_: () => unknown) => undefined

describe("the offload type parameter (#179)", () => {
  it("is inferred from the configured model, on runtime and pure definitions alike", () => {
    type Fields = { readonly overflow: "body"; readonly binary: "scan" }
    expectTypeOf<NonNullable<(typeof Docs)["_offloadFields"]>>().toEqualTypeOf<Fields>()
    expectTypeOf<NonNullable<(typeof PureDocs)["_offloadFields"]>>().toEqualTypeOf<Fields>()
    expectTypeOf<NonNullable<(typeof Scans)["_offloadFields"]>>().toEqualTypeOf<{
      readonly overflow: never
      readonly binary: "scan"
    }>()
    expectTypeOf<NonNullable<(typeof Plain)["_offloadFields"]>>().toEqualTypeOf<NoOffload>()
    // A binary field is opaque to expressions: one of the entity's packed fields.
    expectTypeOf<(typeof Docs)["_packedFields"][number]>().toEqualTypeOf<"body" | "scan">()
    expectTypeOf<(typeof PureDocs)["_packedFields"][number]>().toEqualTypeOf<"body" | "scan">()
    expectTypeOf<(typeof Plain)["_packedFields"][number]>().toBeNever()
  })

  it("adds BlobStoreError to every unbound write of a member that offloads", () => {
    typeOnly(() => {
      expectTypeOf<Blob<ReturnType<typeof Docs.put>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.create>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.upsert>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.update>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.patch>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.delete>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.deleteIfExists>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.restore>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.purge>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Scans.put>>>().toEqualTypeOf<BlobStoreError>()
      const appended = Readings.append({ sensorId: "s", at: 1 })
      expectTypeOf<Blob<typeof appended>>().toEqualTypeOf<BlobStoreError>()
      const fired = Readings.append({ sensorId: "s", at: 1 }, undefined, true)
      expectTypeOf<Blob<typeof fired>>().toEqualTypeOf<BlobStoreError>()
      // A member that offloads nothing: exactly today's unions.
      expectTypeOf<Blob<ReturnType<typeof Plain.put>>>().toBeNever()
      expectTypeOf<Blob<ReturnType<typeof Plain.update>>>().toBeNever()
      expectTypeOf<Blob<ReturnType<typeof Plain.delete>>>().toBeNever()
      expectTypeOf<Blob<ReturnType<typeof Plain.purge>>>().toBeNever()
    })
    expect(true).toBe(true)
  })

  it("reaches the bound client, for runtime and pure definitions alike", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Docs, Scans, Plain, PureDocs, Readings },
          tables: { MainTable },
        })
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.put>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.update>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.delete>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.restore>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.purge>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.PureDocs.put>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Scans.upsert>>
        >().toEqualTypeOf<BlobStoreError>()
        const appended = db.entities.Readings.append({ sensorId: "s", at: 1 })
        expectTypeOf<Blob<typeof appended>>().toEqualTypeOf<BlobStoreError>()
        const fired = db.entities.Readings.append({ sensorId: "s", at: 1 }).skipFollowUp()
        expectTypeOf<Blob<typeof fired>>().toEqualTypeOf<BlobStoreError>()
        // The builders keep it through their combinators.
        const updated = db.entities.Docs.update(key).set({ title: "t2" }).expectedVersion(1)
        expectTypeOf<Blob<typeof updated>>().toEqualTypeOf<BlobStoreError>()
        const put = db.entities.Docs.put(doc).condition({ title: "t" })
        expectTypeOf<Blob<typeof put>>().toEqualTypeOf<BlobStoreError>()
        // A member that offloads nothing: exactly today's unions.
        expectTypeOf<Blob<ReturnType<typeof db.entities.Plain.put>>>().toBeNever()
        expectTypeOf<Blob<ReturnType<typeof db.entities.Plain.update>>>().toBeNever()
        expectTypeOf<Blob<ReturnType<typeof db.entities.Plain.delete>>>().toBeNever()
      }),
    )
    expect(true).toBe(true)
  })

  it("types an External field's paths as PackedPaths: exists / notExists only", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
        db.entities.Docs.update(key)
          .set({ title: "t2" })
          .condition((t, { exists }) => exists(t.scan))
        db.entities.Docs.put(doc).condition((t, { notExists }) => notExists(t.scan))
        db.entities.Docs.put(doc).condition((t, { eq }) =>
          // @ts-expect-error — an External field's path is not a comparable Path
          eq(t.scan, new Uint8Array(1)),
        )
        db.entities.Docs.delete(key).condition((t, { gt }) =>
          // @ts-expect-error — no size() on an External field
          gt(t.scan.size(), 1),
        )
        Docs.condition((t, { eq }) =>
          // @ts-expect-error — the unbound combinator types it the same way
          eq(t.scan, new Uint8Array(1)),
        )
      }),
    )
    expect(true).toBe(true)
  })

  it("keeps the ref-aware input helpers for a member that offloads, binary fields widened", () => {
    type Others<T> = Omit<T, "scan">
    expectTypeOf<Others<Entity.Input<typeof Docs>>>().toEqualTypeOf<
      Others<Entity.Input<typeof InlineDocs>>
    >()
    expectTypeOf<Others<Entity.Update<typeof Docs>>>().toEqualTypeOf<
      Others<Entity.Update<typeof InlineDocs>>
    >()
    expectTypeOf<Others<Entity.Create<typeof Docs>>>().toEqualTypeOf<
      Others<Entity.Create<typeof InlineDocs>>
    >()
    // A binary field takes any BinaryInput (#179, design §9.4).
    expectTypeOf<Entity.Input<typeof Docs>["scan"]>().toEqualTypeOf<BinaryInput | undefined>()
    // PartiQL `insert()` uploads as `put` does, so it takes the same binary inputs.
    expectTypeOf<Parameters<typeof Docs.insert>[0]>().toEqualTypeOf<
      Parameters<typeof Docs.create>[0]
    >()
  })
})

type Body = { readonly text: string }
type SuccessOf<T> = T extends { readonly asEffect: () => Effect.Effect<infer A, any, any> }
  ? A
  : T extends Effect.Effect<infer A, any, any>
    ? A
    : never
type Item<T> = T extends Query.Query<infer A, any, any> ? A : never
type QueryBlob<T> = T extends Query.Query<any, infer E, any> ? Extract<E, BlobStoreError> : never
type Collected<T> = T extends { readonly collect: () => Effect.Effect<Array<infer A>, any, any> }
  ? A
  : never
type CollectBlob<T> = T extends {
  readonly collect: () => Effect.Effect<any, infer E, any>
}
  ? Extract<E, BlobStoreError>
  : never

describe("the read types (#179)", () => {
  it("accepts an offloading member's ops in Batch.write, transactWrite and projections", () => {
    const plainBatch = Batch.write([Plain.put(doc), Plain.delete(key)])
    typeOnly(() => {
      const written = Batch.write([Docs.put(doc), Docs.delete(key), Plain.put(doc)])
      expectTypeOf<SuccessOf<typeof written>>().toEqualTypeOf<void>()
      // An op over an offloading member adds BlobStoreError; plain ops add nothing.
      expectTypeOf<Blob<typeof written>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<
        Blob<ReturnType<typeof Batch.write<[ReturnType<typeof Plain.put>]>>>
      >().toBeNever()
      expectTypeOf<Blob<typeof plainBatch>>().toBeNever()
      // Ops typed `any` add nothing either.
      expectTypeOf<Blob<ReturnType<typeof Batch.write<Array<any>>>>>().toBeNever()

      const transacted = Transaction.transactWrite([
        Docs.put(doc),
        Docs.delete(key),
        Docs.update(key).pipe(Entity.set({ title: "t2" })),
      ])
      expectTypeOf<Blob<typeof transacted>>().toEqualTypeOf<BlobStoreError>()
      const plainTransaction = Transaction.transactWrite([
        Plain.put(doc),
        Plain.update(key).pipe(Entity.set({ title: "t2" })),
      ])
      expectTypeOf<Blob<typeof plainTransaction>>().toBeNever()
      expectTypeOf<Blob<ReturnType<typeof Transaction.transactWrite<Array<any>>>>>().toBeNever()
      // A projection folds the read model's domain values: its rows are read eagerly.
      expectTypeOf<EventStore.ProjectionState<typeof Scans>["scan"]>().toEqualTypeOf<
        Uint8Array | undefined
      >()
      expectTypeOf<EventStore.ProjectionState<typeof Plain>>().toEqualTypeOf<Doc>()
    })
    expect(true).toBe(true)
  })

  it("adds BlobStoreError for bound ops in Batch.write and transactWrite", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Docs, Plain }, tables: { MainTable } })
        const written = Batch.write([db.entities.Docs.put(doc), db.entities.Plain.put(doc)])
        expectTypeOf<Blob<typeof written>>().toEqualTypeOf<BlobStoreError>()
        const plain = Transaction.transactWrite([db.entities.Plain.put(doc)])
        expectTypeOf<Blob<typeof plain>>().toBeNever()
      }),
    )
    expect(true).toBe(true)
  })

  it("types vector hits by the search's modes; select and reembed too", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Cards, PlainCards },
          tables: { VectorTable },
        })
        const search = db.entities.Cards.byTitle([1, 0])
        expectTypeOf<HitOf<typeof search>["body"]>().toEqualTypeOf<Body>()
        expectTypeOf<HitOf<typeof search>["scan"]>().toEqualTypeOf<BlobHandle | undefined>()
        expectTypeOf<SearchBlob<typeof search>>().toEqualTypeOf<BlobStoreError>()

        const lazy = search.topK(3).offloaded("lazy")
        expectTypeOf<HitOf<typeof lazy>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
        expectTypeOf<SearchBlob<typeof lazy>>().toBeNever()

        const eager = search.offloaded("eager")
        expectTypeOf<HitOf<typeof eager>["scan"]>().toEqualTypeOf<Uint8Array | undefined>()
        expectTypeOf<SearchBlob<typeof eager>>().toEqualTypeOf<BlobStoreError>()

        // A raw projection: partial records, read under the same modes.
        const selected = search.select(["title", "body"])
        expectTypeOf<HitOf<typeof selected>>().toEqualTypeOf<Record<string, unknown>>()
        expectTypeOf<SearchBlob<typeof selected>>().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<SearchBlob<ReturnType<typeof selected.offloaded<"lazy">>>>().toBeNever()

        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Cards.reembed>>
        >().toEqualTypeOf<BlobStoreError>()

        // A member that offloads nothing: unchanged.
        const plain = db.entities.PlainCards.byTitle([1, 0])
        expectTypeOf<HitOf<typeof plain>>().toEqualTypeOf<Doc>()
        expectTypeOf<SearchBlob<typeof plain>>().toBeNever()
        expectTypeOf<HitOf<ReturnType<typeof plain.offloaded<"lazy">>>>().toEqualTypeOf<Doc>()
        expectTypeOf<Blob<ReturnType<typeof db.entities.PlainCards.reembed>>>().toBeNever()
      }),
    )
    expect(true).toBe(true)
  })

  it("types a bound get by its modes: overflow eager, binary lazy by default", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Docs, Scans, Plain },
          tables: { MainTable },
        })
        const get = db.entities.Docs.get(key)
        expectTypeOf<SuccessOf<typeof get>["body"]>().toEqualTypeOf<Body>()
        expectTypeOf<SuccessOf<typeof get>["scan"]>().toEqualTypeOf<BlobHandle | undefined>()
        expectTypeOf<Blob<typeof get>>().toEqualTypeOf<BlobStoreError>()

        const lazy = get.offloaded("lazy")
        expectTypeOf<SuccessOf<typeof lazy>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
        expectTypeOf<SuccessOf<typeof lazy>["scan"]>().toEqualTypeOf<BlobHandle | undefined>()
        expectTypeOf<Blob<typeof lazy>>().toBeNever()

        const eager = get.offloaded("eager")
        expectTypeOf<SuccessOf<typeof eager>["scan"]>().toEqualTypeOf<Uint8Array | undefined>()
        expectTypeOf<Blob<typeof eager>>().toEqualTypeOf<BlobStoreError>()

        // An object sets the kinds it names over the builder's modes.
        const mixed = get.offloaded("lazy").offloaded({ binary: "eager" })
        expectTypeOf<SuccessOf<typeof mixed>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
        expectTypeOf<SuccessOf<typeof mixed>["scan"]>().toEqualTypeOf<Uint8Array | undefined>()
        expectTypeOf<Blob<typeof mixed>>().toEqualTypeOf<BlobStoreError>()

        // A binary-only member's default reads keep today's errors.
        expectTypeOf<Blob<ReturnType<typeof db.entities.Scans.get>>>().toBeNever()
        const scansEager = db.entities.Scans.get(key).offloaded("eager")
        expectTypeOf<Blob<typeof scansEager>>().toEqualTypeOf<BlobStoreError>()

        // A member that offloads nothing: unchanged by `.offloaded()`.
        const plain = db.entities.Plain.get(key)
        expectTypeOf<SuccessOf<typeof plain>>().toEqualTypeOf<Doc>()
        expectTypeOf<SuccessOf<ReturnType<typeof plain.offloaded<"lazy">>>>().toEqualTypeOf<Doc>()
        expectTypeOf<Blob<typeof plain>>().toBeNever()
      }),
    )
    expect(true).toBe(true)
  })

  it("re-types queries in any order with limit, filter and select", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Docs, Plain }, tables: { MainTable } })
        const scan = db.entities.Docs.scan()
        expectTypeOf<Collected<typeof scan>["body"]>().toEqualTypeOf<Body>()
        expectTypeOf<Collected<typeof scan>["scan"]>().toEqualTypeOf<BlobHandle | undefined>()
        expectTypeOf<CollectBlob<typeof scan>>().toEqualTypeOf<BlobStoreError>()

        const lazyFirst = scan.offloaded("lazy").limit(2).filter({ title: "t" })
        const lazyLast = scan.limit(2).filter({ title: "t" }).offloaded("lazy")
        expectTypeOf<Collected<typeof lazyFirst>>().toEqualTypeOf<Collected<typeof lazyLast>>()
        expectTypeOf<Collected<typeof lazyLast>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
        expectTypeOf<CollectBlob<typeof lazyLast>>().toBeNever()
        // filterBy's predicate sees the re-typed item.
        scan.offloaded("lazy").filterBy((doc) => {
          expectTypeOf(doc.body).toEqualTypeOf<OffloadedValue<Body>>()
          return true
        })

        // A projection's rows stay raw records; its errors follow the modes.
        const selected = scan.select(["title", "body"])
        expectTypeOf<Collected<typeof selected>>().toEqualTypeOf<Record<string, unknown>>()
        expectTypeOf<CollectBlob<typeof selected>>().toEqualTypeOf<BlobStoreError>()
        const selectedLazy = scan.select(["title", "body"]).offloaded("lazy")
        expectTypeOf<Collected<typeof selectedLazy>>().toEqualTypeOf<Record<string, unknown>>()
        expectTypeOf<CollectBlob<typeof selectedLazy>>().toBeNever()

        // A member that offloads nothing: unchanged.
        const plain = db.entities.Plain.scan()
        expectTypeOf<Collected<typeof plain>>().toEqualTypeOf<Doc>()
        expectTypeOf<Collected<ReturnType<typeof plain.offloaded<"lazy">>>>().toEqualTypeOf<Doc>()
        expectTypeOf<CollectBlob<typeof plain>>().toBeNever()

        // Lifecycle queries are views too.
        const versions = db.entities.Docs.versions(key).offloaded({ overflow: "lazy" })
        expectTypeOf<Collected<typeof versions>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
        expectTypeOf<CollectBlob<typeof versions>>().toBeNever()
      }),
    )
    expect(true).toBe(true)
  })

  it("types collection queries by their members' offloaded fields and modes", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Docs, Plain }, tables: { MainTable } })
        const shelf = db.collections.shelf!({ title: "t" })
        expectTypeOf<CollectBlob<typeof shelf>>().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<CollectBlob<ReturnType<typeof shelf.offloaded<"lazy">>>>().toBeNever()
        const eager = shelf.offloaded("lazy").offloaded({ binary: "eager" })
        expectTypeOf<CollectBlob<typeof eager>>().toEqualTypeOf<BlobStoreError>()
        // A client whose members offload nothing: today's errors.
        const plain = yield* DynamoClient.make({ entities: { Plain }, tables: { MainTable } })
        expectTypeOf<
          CollectBlob<ReturnType<NonNullable<typeof plain.collections.shelf>>>
        >().toBeNever()
      }),
    )
    expect(true).toBe(true)
  })

  it("types explicit Collection.make queries per member, grouped or selected", () => {
    typeOnly(() => {
      const C = Collection.make("shelf", { ShelfDocs, ShelfPlain })
      // A member selector is a single-entity query: re-typed per mode.
      const member = C.ShelfDocs({ title: "t" })
      expectTypeOf<Item<typeof member>["body"]>().toEqualTypeOf<Body>()
      expectTypeOf<Item<typeof member>["scan"]>().toEqualTypeOf<BlobHandle | undefined>()
      expectTypeOf<QueryBlob<typeof member>>().toEqualTypeOf<BlobStoreError>()
      const lazyMember = Query.offloaded(member, "lazy")
      expectTypeOf<Item<typeof lazyMember>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
      expectTypeOf<QueryBlob<typeof lazyMember>>().toBeNever()
      const eagerMember = member.pipe(Query.offloaded({ binary: "eager" }))
      expectTypeOf<Item<typeof eagerMember>["scan"]>().toEqualTypeOf<Uint8Array | undefined>()
      expectTypeOf<QueryBlob<typeof eagerMember>>().toEqualTypeOf<BlobStoreError>()
      // A member that offloads nothing: unchanged.
      const plainMember = C.ShelfPlain({ title: "t" })
      const plainLazy = Query.offloaded(plainMember, "lazy")
      expectTypeOf<Item<typeof plainLazy>>().toEqualTypeOf<Item<typeof plainMember>>()
      expectTypeOf<Item<typeof plainLazy>["body"]>().toEqualTypeOf<Body>()
      expectTypeOf<QueryBlob<typeof plainLazy>>().toBeNever()

      // The grouped query: each item tagged with its member, re-typed per member.
      type Of<T, K extends string> =
        Extract<Item<T>, { readonly _entityKey: K }> extends { readonly _decoded: infer D }
          ? D
          : never
      const grouped = C.query({ title: "t" })
      expectTypeOf<Item<typeof grouped>["_entityKey"]>().toEqualTypeOf<"ShelfDocs" | "ShelfPlain">()
      expectTypeOf<Of<typeof grouped, "ShelfDocs">["body"]>().toEqualTypeOf<Body>()
      expectTypeOf<Of<typeof grouped, "ShelfDocs">["scan"]>().toEqualTypeOf<
        BlobHandle | undefined
      >()
      expectTypeOf<Of<typeof grouped, "ShelfPlain">["scan"]>().toEqualTypeOf<
        Uint8Array | undefined
      >()
      expectTypeOf<QueryBlob<typeof grouped>>().toEqualTypeOf<BlobStoreError>()
      const lazy = Query.offloaded(grouped, "lazy")
      expectTypeOf<Of<typeof lazy, "ShelfDocs">["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
      expectTypeOf<Of<typeof lazy, "ShelfPlain">["body"]>().toEqualTypeOf<Body>()
      expectTypeOf<QueryBlob<typeof lazy>>().toBeNever()
      const eager = lazy.pipe(Query.offloaded({ binary: "eager" }))
      expectTypeOf<Of<typeof eager, "ShelfDocs">["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
      expectTypeOf<Of<typeof eager, "ShelfDocs">["scan"]>().toEqualTypeOf<Uint8Array | undefined>()
      expectTypeOf<QueryBlob<typeof eager>>().toEqualTypeOf<BlobStoreError>()
      // A projection's rows stay raw records.
      const titles = grouped.pipe(Query.select(["title"]), Query.offloaded("lazy"))
      expectTypeOf<Item<typeof titles>>().toEqualTypeOf<Record<string, unknown>>()

      // A collection whose members offload nothing: every type unchanged.
      const P = Collection.make("shelf", { ShelfPlain })
      const plainGrouped = P.query({ title: "t" })
      expectTypeOf<Of<typeof plainGrouped, "ShelfPlain">>().toEqualTypeOf<
        Entity.Record<typeof ShelfPlain>
      >()
      const plainGroupedLazy = Query.offloaded(plainGrouped, "lazy")
      expectTypeOf<Item<typeof plainGroupedLazy>>().toEqualTypeOf<Item<typeof plainGrouped>>()
      expectTypeOf<QueryBlob<typeof plainGroupedLazy>>().toBeNever()
    })
    expect(true).toBe(true)
  })

  it("re-types CRUD results, before or after returnValues", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Docs, Plain }, tables: { MainTable } })
        const put = db.entities.Docs.put(doc)
        expectTypeOf<SuccessOf<typeof put>["scan"]>().toEqualTypeOf<BlobHandle | undefined>()
        const putLazy = put.condition({ title: "t" }).offloaded("lazy")
        expectTypeOf<SuccessOf<typeof putLazy>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
        // A write keeps BlobStoreError whatever its result's modes.
        expectTypeOf<Blob<typeof putLazy>>().toEqualTypeOf<BlobStoreError>()

        const after = db.entities.Docs.update(key)
          .set({ title: "t2" })
          .returnValues("allNew")
          .offloaded({ overflow: "lazy" })
        const before = db.entities.Docs.update(key)
          .set({ title: "t2" })
          .offloaded({ overflow: "lazy" })
          .returnValues("allNew")
        expectTypeOf<SuccessOf<typeof after>>().toEqualTypeOf<SuccessOf<typeof before>>()
        expectTypeOf<SuccessOf<typeof after>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()

        const deleted = db.entities.Docs.delete(key).returnValues("allOld").offloaded("eager")
        expectTypeOf<NonNullable<SuccessOf<typeof deleted>>["scan"]>().toEqualTypeOf<
          Uint8Array | undefined
        >()
        expectTypeOf<SuccessOf<ReturnType<typeof db.entities.Docs.delete>>>().toEqualTypeOf<void>()
        // A delete that returns nothing still returns nothing.
        const silent = db.entities.Docs.delete(key).offloaded("lazy")
        expectTypeOf<SuccessOf<typeof silent>>().toEqualTypeOf<void>()
        const unboundSilent = Docs.delete(key).pipe(Entity.offloaded("lazy"))
        expectTypeOf<SuccessOf<typeof unboundSilent>>().toEqualTypeOf<void>()
        const unboundOld = Docs.delete(key).pipe(
          Entity.returnValues("allOld"),
          Entity.offloaded("lazy"),
        )
        expectTypeOf<NonNullable<SuccessOf<typeof unboundOld>>["body"]>().toEqualTypeOf<
          OffloadedValue<Body>
        >()

        const plainPut = db.entities.Plain.put(doc).offloaded("lazy")
        expectTypeOf<SuccessOf<typeof plainPut>>().toEqualTypeOf<Doc>()
      }),
    )
    expect(true).toBe(true)
  })

  it("types Entity.offloaded and Query.offloaded, data-first and data-last", () => {
    typeOnly(() => {
      const lazyLast = Docs.get(key).pipe(Entity.offloaded("lazy"))
      const lazyFirst = Entity.offloaded(Docs.get(key), "lazy")
      expectTypeOf<SuccessOf<typeof lazyLast>>().toEqualTypeOf<SuccessOf<typeof lazyFirst>>()
      expectTypeOf<SuccessOf<typeof lazyLast>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
      expectTypeOf<Blob<typeof lazyLast>>().toBeNever()
      const record = Entity.asRecord(Docs.get(key).pipe(Entity.offloaded({ binary: "eager" })))
      expectTypeOf<SuccessOf<typeof record>["scan"]>().toEqualTypeOf<Uint8Array | undefined>()

      const query = Docs.scan()
      expectTypeOf<Item<typeof query>["scan"]>().toEqualTypeOf<BlobHandle | undefined>()
      expectTypeOf<QueryBlob<typeof query>>().toEqualTypeOf<BlobStoreError>()
      const last = query.pipe(Query.offloaded("lazy"))
      const first = Query.offloaded(query, "lazy")
      expectTypeOf<Item<typeof last>>().toEqualTypeOf<Item<typeof first>>()
      expectTypeOf<Item<typeof last>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
      expectTypeOf<QueryBlob<typeof last>>().toBeNever()
      const collected = Query.collect(last)
      expectTypeOf<Blob<typeof collected>>().toBeNever()

      // A member that offloads nothing: every type unchanged.
      const plain = Plain.scan().pipe(Query.offloaded("eager"))
      expectTypeOf<Item<typeof plain>>().toEqualTypeOf<Doc>()
      expectTypeOf<QueryBlob<typeof plain>>().toBeNever()
      const plainGet = Plain.get(key).pipe(Entity.offloaded("eager"))
      expectTypeOf<SuccessOf<typeof plainGet>>().toEqualTypeOf<Doc>()
      expectTypeOf<Blob<typeof plainGet>>().toBeNever()
    })
    expect(true).toBe(true)
  })

  it("unions Batch.get and transactGet errors over the gets they read", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Docs, Plain }, tables: { MainTable } })
        const mixed = Batch.get([db.entities.Docs.get(key), Plain.get(key)])
        expectTypeOf<Blob<typeof mixed>>().toEqualTypeOf<BlobStoreError>()
        const lazy = Batch.get([db.entities.Docs.get(key).offloaded("lazy"), Plain.get(key)])
        expectTypeOf<Blob<typeof lazy>>().toBeNever()
        const plainOnly = Batch.get([Plain.get(key), db.entities.Plain.get(key)])
        expectTypeOf<Blob<typeof plainOnly>>().toBeNever()
        const transact = Transaction.transactGet([Docs.get(key)])
        expectTypeOf<Blob<typeof transact>>().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<NonNullable<SuccessOf<typeof transact>[0]>["scan"]>().toEqualTypeOf<
          BlobHandle | undefined
        >()
      }),
    )
    expect(true).toBe(true)
  })

  it("types decodeMarshalledItem and Entity.Read by the decode's modes", () => {
    typeOnly(() => {
      const image = {}
      const lazy = Entity.decodeMarshalledItem(Docs, image)
      expectTypeOf<SuccessOf<typeof lazy>["body"]>().toEqualTypeOf<OffloadedValue<Body>>()
      expectTypeOf<SuccessOf<typeof lazy>["scan"]>().toEqualTypeOf<BlobHandle | undefined>()
      expectTypeOf<Blob<typeof lazy>>().toBeNever()
      const eager = Entity.decodeMarshalledItem(PureDocs, image, { offloaded: "eager" })
      expectTypeOf<SuccessOf<typeof eager>["body"]>().toEqualTypeOf<Body>()
      expectTypeOf<Blob<typeof eager>>().toEqualTypeOf<BlobStoreError>()
      // A member that offloads nothing: `unknown`, as before.
      const plain = Entity.decodeMarshalledItem(Plain, image)
      expectTypeOf<SuccessOf<typeof plain>>().toBeUnknown()
      expectTypeOf<Blob<typeof plain>>().toBeNever()

      expectTypeOf<Entity.Read<typeof Docs>["scan"]>().toEqualTypeOf<BlobHandle | undefined>()
      expectTypeOf<Entity.Read<typeof Docs>["body"]>().toEqualTypeOf<Body>()
      expectTypeOf<Entity.Read<typeof Plain>>().toEqualTypeOf<Entity.Record<typeof Plain>>()
    })
    expect(true).toBe(true)
  })
})

describe("binary write inputs (#179, design §3.8, §9.4)", () => {
  const bytes = new Uint8Array([1, 2, 3])
  const stream = Stream.make(bytes)

  it("types a binary field's input as BinaryInput on put, create, upsert and update", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        expectTypeOf<NonNullable<Entity.Input<typeof Docs>["scan"]>>().toEqualTypeOf<
          Uint8Array | Stream.Stream<Uint8Array, unknown, never> | BlobHandle | BlobSource
        >()
        expectTypeOf<Entity.Input<typeof Docs>["title"]>().toEqualTypeOf<string>()
        // Optionality is kept.
        expectTypeOf<{}>().toMatchTypeOf<Pick<Entity.Update<typeof Docs>, "scan">>()
        expectTypeOf<NonNullable<Entity.Update<typeof Docs>["scan"]>>().toEqualTypeOf<BinaryInput>()
        expectTypeOf<
          NonNullable<Entity.Create<typeof Scans>["scan"]>
        >().toEqualTypeOf<BinaryInput>()
        Docs.put({ ...doc, scan: stream })
        Docs.put({ ...doc, scan: Offload.source(stream, { contentLength: 3 }) })
        Docs.create({ ...doc, scan: Offload.source(bytes, { contentType: "image/png" }) })
        Docs.update(key).pipe(Docs.set({ scan: stream }))
        const db = yield* DynamoClient.make({ entities: { Docs, Readings }, tables: { MainTable } })
        const read = yield* db.entities.Docs.get(key)
        const handle: BlobHandle | undefined = read.scan
        if (handle !== undefined) yield* db.entities.Docs.put({ ...doc, scan: handle })
        yield* db.entities.Docs.upsert({ ...doc, scan: stream })
        yield* db.entities.Docs.update(key).set({ scan: Offload.source(stream) })
        yield* db.entities.Docs.patch(key).set({ scan: bytes })
        yield* db.entities.Readings.append({ sensorId: "s", at: 1, raw: stream })
        // @ts-expect-error a stream of strings is not a binary input
        Docs.put({ ...doc, scan: Stream.make("text") })
        // @ts-expect-error an overflow field takes its domain value only
        Docs.put({ ...doc, body: stream })
      }),
    )
    expect(true).toBe(true)
  })

  it("leaves the inputs of a member without binary fields as they were", () => {
    expectTypeOf<Entity.Input<typeof Plain>["scan"]>().toEqualTypeOf<Uint8Array | undefined>()
    expectTypeOf<Entity.Update<typeof Plain>["scan"]>().toEqualTypeOf<Uint8Array | undefined>()
    type Shape = { readonly a: string; readonly b?: Uint8Array }
    expectTypeOf<WithBinaryInput<Shape, NoOffload>>().toEqualTypeOf<Shape>()
    expectTypeOf<WithBinaryInput<Shape, any>>().toEqualTypeOf<Shape>()
    typeOnly(() => {
      // @ts-expect-error a member that does not offload takes bytes only
      Plain.put({ ...doc, scan: stream })
    })
    expect(true).toBe(true)
  })
})
